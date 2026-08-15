import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { buildSpawnCommand } from "./process.js";
import { JsonLineStreamTransport, JsonRpcPeer } from "./jsonl_rpc.js";
import { parseConnectorManifest } from "./manifest.js";
import {
  CONNECTOR_PROTOCOL_VERSION,
  type ConnectorEventNotification,
  type ConnectorHostDescriptor,
  type ConnectorHostToolParams,
  type ConnectorInitializeResult,
  type ConnectorLogNotification,
  type ConnectorManifestV1,
  type ConnectorRpcMethod,
  type ConnectorRpcRequestMap,
  type JsonValue,
} from "./types.js";
import { isRecord } from "./validation.js";

export interface ConnectorProcessClientOptions {
  readonly manifest: ConnectorManifestV1;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** The host supplies an explicit, already filtered environment. No parent environment is inherited implicitly. */
  readonly env?: Readonly<Record<string, string>>;
  readonly host: ConnectorHostDescriptor;
  readonly workspaceRoots?: readonly string[];
  readonly timeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxStderrLines?: number;
  readonly onEvent?: (notification: ConnectorEventNotification) => void | Promise<void>;
  readonly onLog?: (notification: ConnectorLogNotification) => void | Promise<void>;
  readonly onStderr?: (line: string) => void;
  readonly onProtocolError?: (error: Error) => void;
  readonly executeHostTool?: (params: ConnectorHostToolParams) => JsonValue | Promise<JsonValue>;
}

export class ConnectorProcessClient {
  readonly #manifest: ConnectorManifestV1;
  readonly #options: ConnectorProcessClientOptions;
  readonly #stderr: string[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  #peer: JsonRpcPeer | undefined;
  #initializeResult: ConnectorInitializeResult | undefined;
  #startPromise: Promise<ConnectorInitializeResult> | undefined;
  #closed = false;
  #exit: ConnectorExitState | undefined;
  #terminalError: Error | undefined;

  public constructor(options: ConnectorProcessClientOptions) {
    this.#manifest = parseConnectorManifest(options.manifest);
    this.#options = options;
  }

  public get initialized(): boolean {
    return this.#initializeResult !== undefined;
  }

  public get initializeResult(): ConnectorInitializeResult | undefined {
    return this.#initializeResult;
  }

  public get stderr(): readonly string[] {
    return [...this.#stderr];
  }

  public get pid(): number | undefined {
    return this.#child?.pid;
  }

  public get exitState(): ConnectorExitState | undefined {
    return this.#exit;
  }

  public async start(): Promise<ConnectorInitializeResult> {
    if (this.#closed) throw new Error("Connector client is closed");
    this.assertRunning();
    return this.#startPromise ??= this.startOnce().catch(async (error: unknown) => {
      await this.kill();
      throw error;
    });
  }

  public async request<M extends ConnectorRpcMethod>(
    method: M,
    params: ConnectorRpcRequestMap[M]["params"],
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ConnectorRpcRequestMap[M]["result"]> {
    this.assertRunning();
    if (method !== "connector.initialize") await this.start();
    this.assertRunning();
    const peer = this.#peer;
    if (peer === undefined) throw new Error("Connector process is unavailable");
    return await peer.request<ConnectorRpcRequestMap[M]["result"]>(method, params, options);
  }

  public async notify(method: string, params: unknown = {}): Promise<void> {
    this.assertRunning();
    await this.start();
    this.assertRunning();
    if (this.#peer === undefined) throw new Error("Connector process is unavailable");
    await this.#peer.notify(method, params);
  }

  public async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#peer !== undefined && this.#initializeResult !== undefined && this.#child?.exitCode === null) {
      try {
        await this.#peer.request("connector.shutdown", {}, { timeoutMs: this.#options.shutdownTimeoutMs ?? 2_000 });
      } catch {
        // The child may close stdout immediately after replying. Process exit below remains authoritative.
      }
    }
    await this.waitForExit(this.#options.shutdownTimeoutMs ?? 2_000);
    await this.closePeer();
    await this.terminate("SIGTERM");
    await this.waitForExit(1_000);
    await this.terminate("SIGKILL");
    await this.waitForExit(1_000);
  }

  public async kill(): Promise<void> {
    this.#closed = true;
    await this.closePeer();
    await this.terminate("SIGTERM");
    await this.waitForExit(500);
    await this.terminate("SIGKILL");
    await this.waitForExit(1_000);
  }

  private async startOnce(): Promise<ConnectorInitializeResult> {
    const runtime = this.#manifest.runtime;
    const launch = buildSpawnCommand(this.#options.command ?? runtime.command, this.#options.args ?? runtime.args ?? []);
    const child = spawn(launch.command, [...launch.args], {
      cwd: this.#options.cwd ?? runtime.cwd,
      env: { ...(this.#options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    this.#child = child;
    child.once("error", (error) => {
      this.#exit = { code: null, signal: null, occurredAt: new Date().toISOString(), stderr: [...this.#stderr], error: error.message };
      this.#terminalError = this.exitedError();
      this.#peer?.fail(this.#terminalError);
      this.#options.onProtocolError?.(error);
    });
    child.once("exit", (code, signal) => {
      this.#exit = { code, signal, occurredAt: new Date().toISOString(), stderr: [...this.#stderr] };
      this.#terminalError = this.exitedError();
      this.#peer?.fail(this.#terminalError);
    });
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      this.#stderr.push(line);
      while (this.#stderr.length > (this.#options.maxStderrLines ?? 200)) this.#stderr.shift();
      this.#options.onStderr?.(line);
    });
    const transport = new JsonLineStreamTransport({ input: child.stdout, output: child.stdin });
    const peer = new JsonRpcPeer(transport, {
      idPrefix: `host_${this.#manifest.id}`,
      timeoutMs: this.#options.timeoutMs ?? 30_000,
      ...(this.#options.onProtocolError !== undefined ? { onProtocolError: this.#options.onProtocolError } : {}),
      closedError: () => this.#terminalError ??= this.exitedError(),
    });
    this.#peer = peer;
    peer.onNotification(async (method, params) => {
      if (method === "events.emit") {
        const value = eventNotification(params);
        await this.#options.onEvent?.(value);
        return;
      }
      if (method === "host.log") {
        const value = logNotification(params);
        await this.#options.onLog?.(value);
      }
    });
    peer.onRequest(async (method, params) => {
      if (method !== "host.tool.execute" || this.#options.executeHostTool === undefined) throw new Error(`Host method not available: ${method}`);
      return await this.#options.executeHostTool(params as ConnectorHostToolParams);
    });
    const result = await peer.request<ConnectorInitializeResult>("connector.initialize", {
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      host: this.#options.host,
      workspaceRoots: this.#options.workspaceRoots ?? [],
    }, { timeoutMs: this.#options.initializeTimeoutMs ?? 10_000 });
    if (
      result.protocolVersion !== CONNECTOR_PROTOCOL_VERSION
      || result.connector.id !== this.#manifest.id
      || result.connector.name !== this.#manifest.name
      || result.connector.version !== this.#manifest.version
      || !sameCapabilities(result.capabilities, this.#manifest.capabilities)
    ) {
      throw new Error("Connector initialization response does not match its manifest");
    }
    this.#initializeResult = result;
    return result;
  }

  private async terminate(signal: NodeJS.Signals): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === "win32" && child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
          shell: false,
        });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
      });
      return;
    }
    child.kill(signal);
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private async closePeer(): Promise<void> {
    const peer = this.#peer;
    this.#peer = undefined;
    if (peer !== undefined) await peer.close().catch(() => undefined);
  }

  private assertRunning(): void {
    if (this.#terminalError !== undefined) throw this.#terminalError;
    if (this.#exit !== undefined) throw this.exitedError();
  }

  private exitedError(): Error {
    const state = this.#exit;
    const child = this.#child;
    const status = state?.error !== undefined
      ? `with an error: ${state.error}`
      : (state?.signal ?? child?.signalCode) !== null && (state?.signal ?? child?.signalCode) !== undefined
        ? `from ${String(state?.signal ?? child?.signalCode)}`
        : (state?.code ?? child?.exitCode) !== null && (state?.code ?? child?.exitCode) !== undefined
          ? `with code ${String(state?.code ?? child?.exitCode)}`
          : "or closed its protocol stream";
    const diagnostic = state?.stderr.at(-1) ?? this.#stderr.at(-1);
    return new Error(`Connector ${this.#manifest.id} exited ${status}${diagnostic === undefined ? "" : `: ${diagnostic}`}`);
  }
}

export interface ConnectorExitState {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly occurredAt: string;
  readonly stderr: readonly string[];
  readonly error?: string;
}

function eventNotification(value: unknown): ConnectorEventNotification {
  if (!isRecord(value) || typeof value.subscriptionId !== "string" || !isRecord(value.event) || typeof value.event.id !== "string") {
    throw new Error("Connector emitted an invalid event notification");
  }
  return value as unknown as ConnectorEventNotification;
}

function logNotification(value: unknown): ConnectorLogNotification {
  if (!isRecord(value) || !["debug", "info", "warn", "error"].includes(String(value.level)) || typeof value.message !== "string") {
    throw new Error("Connector emitted an invalid log notification");
  }
  return value as unknown as ConnectorLogNotification;
}

function sameCapabilities(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
