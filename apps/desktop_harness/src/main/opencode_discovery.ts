import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OpenCodeSupervisor } from "./opencode_supervisor.js";

export const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096/";

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
export async function isOpenCodeServerHealthy(url: string): Promise<boolean> {
  const probe = new OpenCodeSupervisor({ url });
  return (await probe.probe()).state === "external";
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
