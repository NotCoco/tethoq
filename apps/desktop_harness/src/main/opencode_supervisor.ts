import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { buildSpawnCommand, resolveCommand } from "../../../../packages/provider_contract/src/index.js";
import type { OpenCodeProcessStatus } from "../shared/desktop_api.js";

const START_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 1_500;
const RUNNING_HEALTH_FAILURE_GRACE_CHECKS = 2;
const DEFAULT_URL = "http://127.0.0.1:4096/";
const FALLBACK_PORT_START = 4_097;
const FALLBACK_PORT_END = 4_196;

export interface AvailableOpenCodeEndpointOptions {
  readonly startPort?: number;
  readonly endPort?: number;
  readonly excludedPorts?: Iterable<number>;
  readonly canBindPort?: (port: number) => Promise<boolean>;
}

export interface OpenCodeSupervisorOptions {
  readonly url?: string;
  readonly command?: string;
  readonly spawnProcess?: typeof spawn;
  readonly fetchHealth?: typeof fetch;
  readonly environment?: NodeJS.ProcessEnv;
  readonly username?: string;
  readonly password?: string;
  readonly canBindPort?: (port: number) => Promise<boolean>;
  /** Remembers the managed process so a force-killed desktop can reclaim it. */
  readonly statePath?: string;
}

class OpenCodePortInUseError extends Error {
  public readonly code = "EADDRINUSE";
}

export class OpenCodeSupervisor {
  readonly #url: URL;
  readonly #command: string;
  readonly #spawnProcess: typeof spawn;
  readonly #fetchHealth: typeof fetch;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #authorization: string | undefined;
  readonly #canBindPort: (port: number) => Promise<boolean>;
  readonly #statePath: string | undefined;
  #child: ChildProcess | undefined;
  #status: OpenCodeProcessStatus;
  #startPromise: Promise<OpenCodeProcessStatus> | undefined;
  #stopping = false;
  #consecutiveRunningHealthFailures = 0;

  public constructor(options: OpenCodeSupervisorOptions = {}) {
    this.#url = new URL(options.url ?? DEFAULT_URL);
    this.#command = options.command ?? "opencode";
    this.#spawnProcess = options.spawnProcess ?? spawn;
    this.#fetchHealth = options.fetchHealth ?? fetch;
    this.#environment = options.environment ?? process.env;
    // OpenCode servers can require Basic authentication (OPENCODE_SERVER_* is
    // the documented server auth pair). The health check must authenticate or
    // a healthy server reports 401 and the supervisor thinks it is down.
    const username = options.username ?? this.#environment.TETHOQ_OPENCODE_USERNAME ?? this.#environment.OPENCODE_SERVER_USERNAME;
    const password = options.password ?? this.#environment.TETHOQ_OPENCODE_PASSWORD ?? this.#environment.OPENCODE_SERVER_PASSWORD;
    this.#authorization = password !== undefined && password !== ""
      ? `Basic ${Buffer.from(`${username ?? "opencode"}:${password}`).toString("base64")}`
      : undefined;
    this.#canBindPort = options.canBindPort ?? canBindLoopbackPort;
    this.#statePath = options.statePath;
    this.#status = { state: "stopped", url: this.#url.toString(), managed: false };
  }

  public status(): OpenCodeProcessStatus {
    return this.#status;
  }

  /** True while this supervisor owns a started server process. */
  public get hasManagedChild(): boolean {
    return this.#child !== undefined;
  }

  public get isStopping(): boolean {
    return this.#stopping;
  }

  /** Detects an existing server without starting a background process. */
  public async probe(): Promise<OpenCodeProcessStatus> {
    if (await this.isHealthy()) {
      return await this.recognizeHealthyProcess();
    }
    if (this.#child === undefined) this.#status = { state: "stopped", url: this.#url.toString(), managed: false };
    return this.#status;
  }

  public async ensureRunning(): Promise<OpenCodeProcessStatus> {
    return await this.ensureRunningAfterHealthCheck(false);
  }

  private async ensureRunningAfterHealthCheck(bypassRunningHealthGrace: boolean): Promise<OpenCodeProcessStatus> {
    // One probe, then branch on what it said. A second call here would double the
    // health traffic and re-enter a check that may still be in flight.
    const health = await this.health();
    if (health === 200) {
      return await this.recognizeHealthyProcess();
    }
    // A busy but healthy OpenCode server can occasionally miss this short probe.
    // Keep a previously confirmed endpoint through two consecutive misses so a
    // transient pause cannot make Tethoq abandon live work for another port.
    const wasRunning = this.#status.state === "managed" || this.#status.state === "external"
      || this.#status.reason === "unresponsive";
    if (!bypassRunningHealthGrace
      && wasRunning
      && this.#consecutiveRunningHealthFailures < RUNNING_HEALTH_FAILURE_GRACE_CHECKS) {
      this.#consecutiveRunningHealthFailures += 1;
      return this.#status;
    }
    this.#consecutiveRunningHealthFailures = 0;
    // A listening runner may be busy parsing a large history or attachment.
    // Missing HTTP health responses is not evidence that its process exited:
    // startManaged reclaims the recorded PID and would destroy the live turn.
    if (!bypassRunningHealthGrace && wasRunning && health !== 401 && health !== 403
      && this.#url.protocol === "http:" && this.#url.hostname === "127.0.0.1"
      && !await this.#canBindPort(Number(this.#url.port || 80))) {
      this.#status = {
        ...this.#status,
        state: "unavailable",
        reason: "unresponsive",
        message: "OpenCode is not responding. Waiting for its existing server to recover.",
      };
      return this.#status;
    }
    // A server we started ourselves and then lost is reclaimable no matter how it
    // answers now — including the 401 a degraded one starts returning.
    const reclaimable = this.#child === undefined && await this.recordedProcessId() !== undefined;
    // Otherwise something foreign holds the endpoint and refuses us. Spawning a
    // second server would only fail to bind and then time out, so say what is
    // actually wrong instead.
    if (this.#child === undefined && !reclaimable && (health === 401 || health === 403)) {
      this.#status = {
        state: "unavailable",
        url: this.#url.toString(),
        managed: false,
        reason: "credentials_required",
        message: `An OpenCode server at ${this.#url.toString()} requires credentials. Set TETHOQ_OPENCODE_USERNAME and TETHOQ_OPENCODE_PASSWORD to the server's own values, or stop it so Tethoq can manage its own.`,
      };
      return this.#status;
    }
    if (!isSupervisableEndpoint(this.#url)) {
      this.#status = { state: "unavailable", url: this.#url.toString(), managed: false, message: "Only the local OpenCode endpoint can be started by Tethoq." };
      return this.#status;
    }
    return this.#startPromise ??= this.startManaged().finally(() => { this.#startPromise = undefined; });
  }

  public async restart(): Promise<OpenCodeProcessStatus> {
    if (this.#child !== undefined) await this.stopManaged();
    else if (await this.isHealthy()) {
      this.#status = { state: "external", url: this.#url.toString(), managed: false, message: "OpenCode is managed outside Tethoq and was left running." };
      return this.#status;
    }
    return await this.ensureRunningAfterHealthCheck(true);
  }

  public async dispose(): Promise<void> {
    // A quit can arrive while the managed server is still in its health-check
    // loop. Wait for that attempt to settle before stopping the process so a
    // late successful start cannot outlive the desktop runtime.
    await this.#startPromise?.catch(() => undefined);
    await this.stopManaged();
  }

  /**
   * Releases this desktop generation without terminating its managed server.
   * The state record and loopback endpoint let the next Tethoq generation
   * adopt the same OpenCode runner, while detached handles keep Electron's
   * shutdown from waiting on that still-useful process.
   */
  public async release(): Promise<void> {
    await this.#startPromise?.catch(() => undefined);
    const child = this.#child;
    if (child === undefined) return;
    this.#child = undefined;
    child.unref();
    (child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();
  }

  /**
   * A force-killed desktop (crash, Task Manager, a dev relaunch) never reaches
   * before-quit, so its `opencode serve` child is orphaned and keeps the port.
   * Such a server later stops answering and every OpenCode session disappears,
   * with no way back except stopping it by hand. Only a PID this supervisor
   * itself recorded is ever reclaimed.
   */
  private async recordedProcessId(): Promise<number | undefined> {
    if (this.#statePath === undefined) return undefined;
    return await readFile(this.#statePath, "utf8").then(
      (value) => {
        const parsed: unknown = JSON.parse(value);
        const record = typeof parsed === "object" && parsed !== null
          ? parsed as { pid?: unknown; url?: unknown }
          : {};
        if (typeof record.url === "string") {
          try {
            if (new URL(record.url).toString() !== this.#url.toString()) return undefined;
          } catch {
            return undefined;
          }
        }
        // Legacy records predate alternate managed ports and are safe only for
        // the original fixed endpoint.
        if (record.url === undefined && this.#url.toString() !== DEFAULT_URL) return undefined;
        const pid = record.pid;
        return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
      },
      () => undefined,
    );
  }

  /** Restores ownership after an Electron generation released its child handle. */
  private async recognizeHealthyProcess(): Promise<OpenCodeProcessStatus> {
    if (this.#child !== undefined) {
      this.#status = {
        state: "managed", url: this.#url.toString(), managed: true,
        ...(this.#child.pid !== undefined ? { pid: this.#child.pid } : {}),
      };
      return this.#status;
    }
    const recordedPid = await this.recordedProcessId();
    this.#status = recordedPid === undefined
      ? { state: "external", url: this.#url.toString(), managed: false }
      : { state: "managed", url: this.#url.toString(), managed: true, pid: recordedPid };
    return this.#status;
  }

  private async reclaimOrphanedProcess(): Promise<void> {
    if (this.#statePath === undefined) return;
    const recorded = await this.recordedProcessId();
    await rm(this.#statePath, { force: true }).catch(() => undefined);
    if (recorded === undefined) return;
    await new Promise<void>((resolve) => {
      const killer = process.platform === "win32"
        ? spawn("taskkill.exe", ["/pid", String(recorded), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false })
        : spawn("kill", ["-TERM", String(recorded)], { stdio: "ignore", shell: false });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    // Give the operating system a moment to release the listening socket.
    await delay(300);
  }

  private async recordManagedProcess(pid: number | undefined): Promise<void> {
    if (this.#statePath === undefined || pid === undefined) return;
    await writeFile(this.#statePath, JSON.stringify({ pid, url: this.#url.toString() }), "utf8").catch(() => undefined);
  }

  private async forgetManagedProcess(): Promise<void> {
    if (this.#statePath === undefined) return;
    await rm(this.#statePath, { force: true }).catch(() => undefined);
  }

  private async startManaged(): Promise<OpenCodeProcessStatus> {
    this.#status = { state: "starting", url: this.#url.toString(), managed: true };
    try {
      await this.reclaimOrphanedProcess();
      if (!await this.#canBindPort(Number(this.#url.port))) {
        throw new OpenCodePortInUseError(`OpenCode could not start because ${this.#url.toString()} is already in use.`);
      }
      const resolved = resolveCommand(this.#command);
      const args = ["serve", "--hostname", "127.0.0.1", "--port", String(this.#url.port || 80)];
      const launch = buildSpawnCommand(resolved, args);
      let child: ChildProcess;
      try {
        child = this.#spawnProcess(launch.command, [...launch.args], {
          ...(launch.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
          // On Windows, `detached` explicitly allocates the child its own
          // console. Windows Terminal can surface that console despite
          // `windowsHide`, which makes the managed server flash in the user's
          // workspace. Windows child processes already outlive their parent;
          // release() unrefs the handles when handing the server to a replacement
          // Tethoq generation. POSIX still needs a detached process group.
          detached: process.platform !== "win32",
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "ignore", "pipe"],
          env: this.#environment,
        });
      } catch (error) {
        throw new Error(`OpenCode could not be started: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.#child = child;
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_096); });
      child.once("error", (error) => this.markExited(child, `OpenCode could not be started: ${error.message}`));
      // `close` follows stdio shutdown, so bind diagnostics have reached the
      // stderr buffer before the startup loop classifies the failure.
      child.once("close", (code) => this.markExited(child, stderr.trim() || `OpenCode stopped with code ${code ?? "unknown"}.`));
      // Install exit/error listeners before this write yields: a bind failure
      // can terminate the child almost immediately after spawn.
      await this.recordManagedProcess(child.pid);
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (this.#child !== child) throw new Error(stderr.trim() || "OpenCode stopped before it became ready.");
        if (await this.isHealthy()) {
          this.#status = { state: "managed", url: this.#url.toString(), managed: true, ...(child.pid !== undefined ? { pid: child.pid } : {}) };
          return this.#status;
        }
        await delay(200);
      }
      throw new Error(stderr.trim() || "OpenCode did not become ready in time.");
    } catch (error) {
      await this.stopManaged();
      // A child can exit before stopManaged observes it. Always clear its
      // record so a later retry never mistakes an exited/recycled PID for one
      // of our still-running servers.
      await this.forgetManagedProcess();
      const message = error instanceof Error ? error.message : String(error);
      this.#status = isPortInUseError(error)
        ? {
            state: "failed",
            url: this.#url.toString(),
            managed: false,
            reason: "port_in_use",
            message: `OpenCode could not start because ${this.#url.toString()} is already in use.`,
          }
        : { state: "failed", url: this.#url.toString(), managed: false, message };
      return this.#status;
    }
  }

  private async isHealthy(): Promise<boolean> {
    return await this.health() === 200;
  }

  /** HTTP status of the health endpoint, or undefined when nothing answered. */
  private async health(): Promise<number | undefined> {
    try {
      const headers: Record<string, string> = { "cache-control": "no-store" };
      if (this.#authorization !== undefined) headers.authorization = this.#authorization;
      const response = await this.#fetchHealth(new URL("/global/health", this.#url), {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (response.ok) {
        this.#consecutiveRunningHealthFailures = 0;
        return 200;
      }
      return response.status;
    } catch {
      return undefined;
    }
  }

  private markExited(child: ChildProcess, message: string): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    if (!this.#stopping) this.#status = { state: "failed", url: this.#url.toString(), managed: false, message };
  }

  private async stopManaged(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    this.#child = undefined;
    try {
      await stopProcessTree(child);
      await this.forgetManagedProcess();
    } finally {
      this.#stopping = false;
      this.#status = { state: "stopped", url: this.#url.toString(), managed: false };
    }
  }
}

export function isSupervisableEndpoint(url: URL): boolean {
  const port = Number(url.port);
  return url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && (port === 4_096 || (port >= FALLBACK_PORT_START && port <= FALLBACK_PORT_END))
    && url.username === ""
    && url.password === ""
    && url.pathname === "/"
    && url.search === ""
    && url.hash === "";
}

/**
 * Finds a free loopback port in the small range reserved for Tethoq-managed
 * OpenCode fallbacks. The socket is released before OpenCode starts, so there
 * is an unavoidable probe-to-spawn race; ensureRunning still fails closed if
 * another process takes the selected port in that interval.
 */
export async function findAvailableOpenCodeServerUrl(options: AvailableOpenCodeEndpointOptions = {}): Promise<string> {
  const startPort = options.startPort ?? FALLBACK_PORT_START;
  const endPort = options.endPort ?? FALLBACK_PORT_END;
  if (!Number.isInteger(startPort) || !Number.isInteger(endPort)
    || startPort < FALLBACK_PORT_START || endPort > FALLBACK_PORT_END || startPort > endPort) {
    throw new Error(`OpenCode fallback port range must stay within ${FALLBACK_PORT_START}-${FALLBACK_PORT_END}.`);
  }
  const excludedPorts = new Set(options.excludedPorts ?? []);
  const canBindPort = options.canBindPort ?? canBindLoopbackPort;
  for (let port = startPort; port <= endPort; port += 1) {
    if (excludedPorts.has(port)) continue;
    if (await canBindPort(port)) return `http://127.0.0.1:${port}/`;
  }
  throw new Error(`No available OpenCode fallback port was found in ${startPort}-${endPort}.`);
}

/**
 * Turns the fallback sentinel into a currently available owned endpoint. Other
 * endpoint decisions are already concrete and pass through unchanged.
 */
export async function resolveAvailableOpenCodeServerUrl(
  requestedUrl: string,
  options: AvailableOpenCodeEndpointOptions = {},
): Promise<string> {
  const normalized = new URL(requestedUrl).toString();
  return normalized === `http://127.0.0.1:${FALLBACK_PORT_START}/`
    ? await findAvailableOpenCodeServerUrl(options)
    : normalized;
}

/** Reads the stable supervision reason without parsing user-facing error text. */
export function isOpenCodePortInUseStatus(status: OpenCodeProcessStatus): boolean {
  return status.reason === "port_in_use";
}

function isPortInUseError(error: unknown): boolean {
  if (error instanceof OpenCodePortInUseError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  if (candidate.code === "EADDRINUSE") return true;
  return typeof candidate.message === "string"
    && /\bEADDRINUSE\b|address (?:is )?already in use|only one usage of each socket address/iu.test(candidate.message);
}

async function canBindLoopbackPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(available);
    };
    server.unref();
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => finish(error === undefined));
    });
  });
}

async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  child.kill("SIGTERM");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
