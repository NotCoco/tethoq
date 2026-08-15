import { spawn, type ChildProcess } from "node:child_process";
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
}

export class OpenCodeSupervisor {
  readonly #url: URL;
  readonly #command: string;
  readonly #spawnProcess: typeof spawn;
  readonly #fetchHealth: typeof fetch;
  readonly #environment: NodeJS.ProcessEnv;
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
    this.#status = { state: "stopped", url: this.#url.toString(), managed: false };
  }

  public status(): OpenCodeProcessStatus {
    return this.#status;
  }

  public async ensureRunning(): Promise<OpenCodeProcessStatus> {
    if (await this.isHealthy()) {
      if (this.#child === undefined) this.#status = { state: "external", url: this.#url.toString(), managed: false };
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

  private async startManaged(): Promise<OpenCodeProcessStatus> {
    this.#status = { state: "starting", url: this.#url.toString(), managed: true };
    try {
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
    try {
      const response = await this.#fetchHealth(new URL("/global/health", this.#url), {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
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
