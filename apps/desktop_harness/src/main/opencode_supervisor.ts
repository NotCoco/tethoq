import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { buildSpawnCommand, resolveCommand } from "../../../../packages/provider_contract/src/index.js";
import type { OpenCodeProcessStatus } from "../shared/desktop_api.js";

const START_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 1_500;
const DEFAULT_URL = "http://127.0.0.1:4096/";

export interface OpenCodeSupervisorOptions {
  readonly url?: string;
  readonly command?: string;
  readonly spawnProcess?: typeof spawn;
  readonly fetchHealth?: typeof fetch;
  readonly environment?: NodeJS.ProcessEnv;
  readonly username?: string;
  readonly password?: string;
  /** Remembers the managed process so a force-killed desktop can reclaim it. */
  readonly statePath?: string;
}

export class OpenCodeSupervisor {
  readonly #url: URL;
  readonly #command: string;
  readonly #spawnProcess: typeof spawn;
  readonly #fetchHealth: typeof fetch;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #authorization: string | undefined;
  readonly #statePath: string | undefined;
  #child: ChildProcess | undefined;
  #status: OpenCodeProcessStatus;
  #startPromise: Promise<OpenCodeProcessStatus> | undefined;
  #stopping = false;

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
      if (this.#child === undefined) this.#status = { state: "external", url: this.#url.toString(), managed: false };
      return this.#status;
    }
    if (this.#child === undefined) this.#status = { state: "stopped", url: this.#url.toString(), managed: false };
    return this.#status;
  }

  public async ensureRunning(): Promise<OpenCodeProcessStatus> {
    // One probe, then branch on what it said. A second call here would double the
    // health traffic and re-enter a check that may still be in flight.
    const health = await this.health();
    if (health === 200) {
      if (this.#child === undefined) this.#status = { state: "external", url: this.#url.toString(), managed: false };
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
    return await this.ensureRunning();
  }

  public async dispose(): Promise<void> {
    // A quit can arrive while the managed server is still in its health-check
    // loop. Wait for that attempt to settle before stopping the process so a
    // late successful start cannot outlive the desktop runtime.
    await this.#startPromise?.catch(() => undefined);
    await this.stopManaged();
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
        const pid = typeof parsed === "object" && parsed !== null ? (parsed as { pid?: unknown }).pid : undefined;
        return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
      },
      () => undefined,
    );
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
      const resolved = resolveCommand(this.#command);
      const args = ["serve", "--hostname", "127.0.0.1", "--port", String(this.#url.port || 80)];
      const launch = buildSpawnCommand(resolved, args);
      let child: ChildProcess;
      try {
        child = this.#spawnProcess(launch.command, [...launch.args], {
        ...(launch.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        env: this.#environment,
        });
      } catch (error) {
        throw new Error(`OpenCode could not be started: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.#child = child;
      await this.recordManagedProcess(child.pid);
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_096); });
      child.once("error", (error) => this.markExited(child, `OpenCode could not be started: ${error.message}`));
      child.once("exit", (code) => this.markExited(child, `OpenCode stopped with code ${code ?? "unknown"}.`));
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
      this.#status = { state: "failed", url: this.#url.toString(), managed: false, message: error instanceof Error ? error.message : String(error) };
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
      return response.ok ? 200 : response.status;
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
  return url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && url.port === "4096"
    && url.username === ""
    && url.password === ""
    && url.pathname === "/"
    && url.search === ""
    && url.hash === "";
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
