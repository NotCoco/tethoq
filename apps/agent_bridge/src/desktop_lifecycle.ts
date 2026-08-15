import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { DesktopLifecycleController, DesktopProcessState } from "./request_router.js";
import { DesktopLifecycleError } from "./request_router.js";

export const DEFAULT_DESKTOP_READY_TIMEOUT_MS = 15_000;
export const DEFAULT_DESKTOP_PROBE_TIMEOUT_MS = 350;
const READY_PATH_PREFIX = "/tethoq-desktop-ready/";
const LOOPBACK = "127.0.0.1";

export interface DesktopReadinessDescriptor {
  readonly version: 1;
  readonly port: number;
  readonly token: string;
}

export interface InstalledDesktopLifecycleOptions {
  readonly executablePath: string;
  readonly resolveReadiness: () => Promise<DesktopReadinessDescriptor | undefined>;
  readonly launch?: (executablePath: string) => ChildProcess;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly probe?: (readiness: DesktopReadinessDescriptor, timeoutMs: number) => Promise<boolean>;
  readonly readyTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly retryDelayMs?: number;
}

/**
 * Fixed-path, loopback-only controller for the separately installed Desktop UI.
 * No request payload can influence the executable, arguments, port, or cwd.
 */
export class InstalledDesktopLifecycle implements DesktopLifecycleController {
  readonly #executablePath: string;
  readonly #resolveReadiness: () => Promise<DesktopReadinessDescriptor | undefined>;
  readonly #launch: (executablePath: string) => ChildProcess;
  readonly #pathExists: (path: string) => Promise<boolean>;
  readonly #probe: (readiness: DesktopReadinessDescriptor, timeoutMs: number) => Promise<boolean>;
  readonly #readyTimeoutMs: number;
  readonly #probeTimeoutMs: number;
  readonly #retryDelayMs: number;
  #wakePromise: Promise<{ readonly state: "running" | "starting"; readonly launched: boolean }> | undefined;

  public constructor(options: InstalledDesktopLifecycleOptions) {
    if (!isAbsolute(options.executablePath) || options.executablePath.includes("\0")) {
      throw new Error("Desktop executable path must be an absolute trusted path");
    }
    this.#executablePath = normalize(resolve(options.executablePath));
    this.#resolveReadiness = options.resolveReadiness;
    this.#launch = options.launch ?? launchDesktop;
    this.#pathExists = options.pathExists ?? existingFile;
    this.#probe = options.probe ?? probeDesktopReady;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_DESKTOP_READY_TIMEOUT_MS;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_DESKTOP_PROBE_TIMEOUT_MS;
    this.#retryDelayMs = options.retryDelayMs ?? 200;
  }

  public async status(): Promise<{ readonly state: DesktopProcessState }> {
    if (this.#wakePromise !== undefined) return { state: "starting" };
    return { state: await this.isReady() ? "running" : "stopped" };
  }

  public async wake(): Promise<{ readonly state: "running" | "starting"; readonly launched: boolean }> {
    if (await this.isReady()) {
      // Electron's single-instance handoff opens/focuses the existing window.
      try {
        this.#launch(this.#executablePath).once("error", () => undefined);
      } catch (error) {
        throw wakeFailed(error);
      }
      return { state: "running", launched: false };
    }
    if (this.#wakePromise !== undefined) return await this.#wakePromise;
    this.#wakePromise = this.#wakeOnce().finally(() => { this.#wakePromise = undefined; });
    return await this.#wakePromise;
  }

  async #wakeOnce(): Promise<{ readonly state: "running"; readonly launched: true }> {
    if (!await this.#pathExists(this.#executablePath)) {
      throw new DesktopLifecycleError(
        "DESKTOP_NOT_INSTALLED",
        "Tethoq Desktop is not installed on this computer.",
        false,
      );
    }
    let child: ChildProcess;
    try {
      child = this.#launch(this.#executablePath);
    } catch (error) {
      throw wakeFailed(error);
    }
    const deadline = Date.now() + this.#readyTimeoutMs;
    let earlyExit: Error | undefined;
    const onError = (error: Error) => { earlyExit = error; };
    const onExit = (code: number | null) => { earlyExit = new Error(`Desktop exited before readiness (code ${code ?? "unknown"})`); };
    child.once("error", onError);
    child.once("exit", onExit);
    try {
      while (Date.now() < deadline) {
        if (earlyExit !== undefined) throw earlyExit;
        if (await this.isReady()) return { state: "running", launched: true };
        await new Promise((resolveDelay) => setTimeout(resolveDelay, this.#retryDelayMs));
      }
      throw new Error("Desktop did not become ready in time");
    } catch (error) {
      throw wakeFailed(error);
    } finally {
      child.off("error", onError);
      child.off("exit", onExit);
    }
  }

  private async isReady(): Promise<boolean> {
    const readiness = await this.#resolveReadiness();
    return readiness !== undefined && await this.#probe(readiness, this.#probeTimeoutMs);
  }
}

export function configuredDesktopLifecycle(
  environment: NodeJS.ProcessEnv = process.env,
  runtimeExecutablePath = process.execPath,
): InstalledDesktopLifecycle | undefined {
  const executablePath = trustedDesktopExecutablePath(environment, runtimeExecutablePath);
  const readinessFile = trustedDesktopReadinessPath(environment);
  if (executablePath === undefined || readinessFile === undefined) return undefined;
  const fixedReadinessFile = normalize(resolve(readinessFile));
  return new InstalledDesktopLifecycle({
    executablePath,
    resolveReadiness: async () => await readDesktopReadiness(fixedReadinessFile),
  });
}

/**
 * Resolves only process-owned paths: an explicit local launch override, the
 * embedded Desktop/Bridge install layout, or Electron Builder's per-user
 * default install directory. Remote requests cannot influence any candidate.
 */
export function trustedDesktopExecutablePath(
  environment: NodeJS.ProcessEnv,
  runtimeExecutablePath: string,
): string | undefined {
  const override = environment.TETHOQ_DESKTOP_EXECUTABLE;
  if (override !== undefined) return isAbsolute(override) && !override.includes("\0") ? normalize(resolve(override)) : undefined;

  if (isAbsolute(runtimeExecutablePath)) {
    const runtimeDirectory = dirname(runtimeExecutablePath);
    const bridgeDirectory = dirname(runtimeDirectory);
    const resourcesDirectory = dirname(bridgeDirectory);
    const companionDirectory = dirname(resourcesDirectory);
    if (
      basename(runtimeDirectory).toLowerCase() === "runtime"
      && basename(bridgeDirectory).toLowerCase() === "bridge"
      && basename(resourcesDirectory).toLowerCase() === "resources"
      && basename(companionDirectory).toLowerCase() === "bridge-companion"
      && basename(dirname(companionDirectory)).toLowerCase() === "resources"
    ) {
      return normalize(resolve(companionDirectory, "..", "..", "Tethoq.exe"));
    }
  }

  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || !isAbsolute(localAppData) || localAppData.includes("\0")) return undefined;
  return normalize(join(resolve(localAppData), "Programs", "Tethoq", "Tethoq.exe"));
}

export function trustedDesktopReadinessPath(environment: NodeJS.ProcessEnv): string | undefined {
  const override = environment.TETHOQ_DESKTOP_READINESS_FILE;
  if (override !== undefined) return isAbsolute(override) && !override.includes("\0") ? normalize(resolve(override)) : undefined;
  const appData = environment.APPDATA;
  if (appData === undefined || !isAbsolute(appData) || appData.includes("\0")) return undefined;
  return normalize(join(resolve(appData), "Tethoq", "desktop-readiness.json"));
}

export async function readDesktopReadiness(path: string): Promise<DesktopReadinessDescriptor | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535 || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(value.token)) return undefined;
    return { version: 1, port: value.port as number, token: value.token };
  } catch {
    return undefined;
  }
}

export async function probeDesktopReady(readiness: DesktopReadinessDescriptor, timeoutMs = DEFAULT_DESKTOP_PROBE_TIMEOUT_MS): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    let settled = false;
    let response = "";
    const socket: Socket = createConnection({ host: LOOPBACK, port: readiness.port });
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(ready);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`GET ${READY_PATH_PREFIX}${readiness.token} HTTP/1.1\r\nHost: ${LOOPBACK}:${readiness.port}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (chunk: string) => {
      response = (response + chunk).slice(0, 4096);
      if (response.includes("\r\n\r\n")) finish(/^HTTP\/1\.[01] 204\b/u.test(response));
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(/^HTTP\/1\.[01] 204\b/u.test(response)));
  });
}

function launchDesktop(executablePath: string): ChildProcess {
  const child = spawn(executablePath, [], {
    cwd: dirname(executablePath),
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function existingFile(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function wakeFailed(error: unknown): DesktopLifecycleError {
  return new DesktopLifecycleError(
    "DESKTOP_WAKE_FAILED",
    `Tethoq Desktop could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );
}
