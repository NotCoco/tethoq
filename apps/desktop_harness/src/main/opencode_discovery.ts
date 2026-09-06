import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isOpenCodePortInUseStatus, OpenCodeSupervisor, type OpenCodeSupervisorOptions } from "./opencode_supervisor.js";
import type { OpenCodeProcessStatus } from "../shared/desktop_api.js";

export const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096/";
export const FALLBACK_OPENCODE_URL = "http://127.0.0.1:4097/";
// One initial fallback plus one retry when that candidate loses the bind race.
export const MAX_OPENCODE_FALLBACK_SWITCHES = 2;

const LOG_DIRECTORY_PATTERN = /^\d{8}T\d{6}$/u;
const SERVER_READY_PATTERN = /server ready \{ url: 'http:\/\/127\.0\.0\.1:(\d+)' \}/gu;

/**
 * Discovers the OpenCode server the user already runs. The OpenCode AI Desktop
 * app records its sidecar server URL in its newest main.log; the Tethoq desktop
 * adopts that server so it subscribes to the same process that runs the user's
 * sessions. Live events - streaming output and reasoning included - only flow
 * from the server that owns a session, never from a second server that merely
 * reads the shared database.
 *
 * Returns undefined when no supported launcher leaves a server URL behind.
 */
export async function discoverOpenCodeServerUrl(logsRoot?: string): Promise<string | undefined> {
  const root = logsRoot ?? (typeof process.env.APPDATA === "string"
    ? join(process.env.APPDATA, "ai.opencode.desktop", "logs")
    : undefined);
  if (root === undefined) return undefined;
  let entries: string[] = [];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && LOG_DIRECTORY_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return undefined;
  }
  for (const directory of entries) {
    try {
      const log = await readFile(join(root, directory, "main.log"), "utf8");
      const matches = [...log.matchAll(SERVER_READY_PATTERN)];
      if (matches.length === 0) continue;
      return `http://127.0.0.1:${matches.at(-1)![1]}/`;
    } catch {
      // A newer launch directory may be mid-write or missing its log; keep
      // looking at the next oldest one.
    }
  }
  return undefined;
}

/** True when an OpenCode server answers the health check at the URL. */
export async function isOpenCodeServerHealthy(url: string, options: OpenCodeSupervisorOptions = {}): Promise<boolean> {
  // Discovery must use the same credentials as the supervisor that will adopt
  // the endpoint. Otherwise a healthy authenticated sidecar looks dead here,
  // even though the provider can connect to it immediately afterwards.
  const probe = new OpenCodeSupervisor({ ...options, url });
  const status = await probe.probe();
  return status.state === "external" || status.state === "managed";
}

/**
 * A replacement desktop must stay on the managed runner whose ownership record
 * it just restored. A newly started managed child may still yield to the user's
 * own OpenCode sidecar through the existing active-session handoff path.
 */
export function shouldDiscoverOpenCodeServer(options: {
  readonly envUrl: string | undefined;
  readonly status: OpenCodeProcessStatus;
  readonly hasManagedChild: boolean;
}): boolean {
  return options.envUrl === undefined
    && !(options.status.state === "managed" && !options.hasManagedChild);
}

export interface OpenCodeEndpointDecisionOptions {
  readonly envUrl: string | undefined;
  readonly discoveredUrl: string | undefined;
  readonly discoveredHealthy: boolean;
  readonly currentUrl: string;
  readonly adopted: boolean;
  readonly currentExternal: boolean;
  readonly defaultUrl: string;
}

export interface OpenCodeEndpointDecision {
  readonly url: string;
  readonly adopted: boolean;
}

export interface FailedOpenCodeFallbackOptions {
  readonly envUrl: string | undefined;
  readonly adopted: boolean;
  readonly status: OpenCodeProcessStatus;
}

export interface OpenCodeFallbackCycleOptions {
  readonly envUrl: string | undefined;
  readonly adopted: boolean;
  readonly ensureRunning: () => Promise<OpenCodeProcessStatus>;
  readonly switchEndpoint: (url: string, failedStatus: OpenCodeProcessStatus) => Promise<void>;
}

export interface OpenCodeFallbackCycleResult {
  readonly status: OpenCodeProcessStatus;
  readonly adopted: boolean;
}

/**
 * Chooses a managed endpoint only after the current endpoint has failed its own
 * authenticated confirmation. Port 4097 is reserved for the one case where an
 * inaccessible external sidecar already occupies the ordinary managed port.
 */
export function resolveFailedOpenCodeFallback(options: FailedOpenCodeFallbackOptions): OpenCodeEndpointDecision | undefined {
  if (options.envUrl !== undefined || options.status.state === "managed" || options.status.state === "external") return undefined;
  // A fallback selected moments ago can be claimed before OpenCode binds it.
  // Stay in the fallback range so a retry never oscillates back to 4096.
  if (isOpenCodePortInUseStatus(options.status)) {
    return { url: FALLBACK_OPENCODE_URL, adopted: false };
  }
  if (options.adopted) {
    return {
      url: options.status.url === DEFAULT_OPENCODE_URL ? FALLBACK_OPENCODE_URL : DEFAULT_OPENCODE_URL,
      adopted: false,
    };
  }
  if (options.status.url === DEFAULT_OPENCODE_URL && options.status.reason === "credentials_required") {
    return { url: FALLBACK_OPENCODE_URL, adopted: false };
  }
  return undefined;
}

/**
 * Runs one supervisor confirmation and, when necessary, switches endpoint and
 * confirms the replacement in the same cycle. Keeping this orchestration here
 * makes the runtime behavior functionally testable without starting providers.
 */
export async function ensureOpenCodeFallbackCycle(options: OpenCodeFallbackCycleOptions): Promise<OpenCodeFallbackCycleResult> {
  let status = await options.ensureRunning();
  let adopted = options.adopted;
  for (let switchCount = 0; switchCount < MAX_OPENCODE_FALLBACK_SWITCHES; switchCount += 1) {
    const fallback = resolveFailedOpenCodeFallback({
      envUrl: options.envUrl,
      adopted,
      status,
    });
    if (fallback === undefined) break;
    await options.switchEndpoint(fallback.url, status);
    adopted = fallback.adopted;
    status = await options.ensureRunning();
  }
  return {
    status,
    adopted: status.state === "managed" ? false : adopted,
  };
}

/**
 * Decides which OpenCode server the desktop should point at.
 *
 * - An explicit TETHOQ_OPENCODE_URL always wins and never changes.
 * - A healthy discovered server (the user's own opencode) is adopted whenever
 *   it appears or moves to a new port.
 * - When an adopted server dies, the desktop falls back to its own managed
 *   server; the next healthy discovery on a later tick takes over again.
 */
export function resolveOpenCodeEndpoint(options: OpenCodeEndpointDecisionOptions): OpenCodeEndpointDecision | undefined {
  if (options.envUrl !== undefined) return undefined;
  if (options.discoveredUrl !== undefined && options.discoveredHealthy) {
    if (options.discoveredUrl !== options.currentUrl) return { url: options.discoveredUrl, adopted: true };
    return undefined;
  }
  // A single failed discovery probe must not throw away an adopted endpoint
  // that the supervisor still knows is healthy. ensureRunning probes it again;
  // only a later tick with a non-external status falls back to 4096.
  if (options.adopted && options.currentExternal) return undefined;
  if (options.adopted) return { url: options.defaultUrl, adopted: false };
  return undefined;
}
