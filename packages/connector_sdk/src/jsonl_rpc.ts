import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  ConnectorProtocolError,
  ConnectorRemoteError,
  ConnectorTimeoutError,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
} from "./errors.js";
import {
  MAX_JSONL_BYTES,
  isJsonRpcMessage,
  isRecord,
  parseJsonLine,
  type JsonRpcMessage,
} from "./validation.js";

export type RpcId = string | number;

export interface JsonLineTransport {
  send(message: JsonRpcMessage): Promise<void>;
  onMessage(listener: (message: JsonRpcMessage) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface JsonLineStreamTransportOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly closeOutput?: boolean;
}

/** A language-neutral UTF-8 transport: one JSON-RPC 2.0 object per line. */
export class JsonLineStreamTransport implements JsonLineTransport {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #closeOutput: boolean;
  readonly #messageListeners = new Set<(message: JsonRpcMessage) => void>();
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #closeListeners = new Set<() => void>();
  #pending = Buffer.alloc(0);
  #closed = false;

  public constructor(options: JsonLineStreamTransportOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#closeOutput = options.closeOutput ?? false;
    this.#input.on("data", this.onData);
    this.#input.on("error", this.onStreamError);
    this.#input.on("end", this.onInputClose);
    this.#input.on("close", this.onInputClose);
    this.#output.on("error", this.onStreamError);
  }

  public onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  public onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  public onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed) throw new Error("JSONL transport is closed");
    const line = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (line.byteLength - 1 > MAX_JSONL_BYTES) throw new Error(`JSONL message exceeds ${MAX_JSONL_BYTES} bytes`);
    await new Promise<void>((resolve, reject) => {
      this.#output.write(line, (error) => error === null || error === undefined ? resolve() : reject(error));
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#input.off("data", this.onData);
    this.#input.off("error", this.onStreamError);
    this.#input.off("end", this.onInputClose);
    this.#input.off("close", this.onInputClose);
    this.#output.off("error", this.onStreamError);
    this.#messageListeners.clear();
    this.#errorListeners.clear();
    this.#closeListeners.clear();
    if (this.#closeOutput && !this.#output.destroyed) {
      await new Promise<void>((resolve) => this.#output.end(resolve));
    }
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.#closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    this.#pending = Buffer.concat([this.#pending, bytes]);
    let newline = this.#pending.indexOf(0x0a);
    while (newline >= 0) {
      let line = this.#pending.subarray(0, newline);
      this.#pending = this.#pending.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      this.consumeLine(line);
      newline = this.#pending.indexOf(0x0a);
    }
    if (this.#pending.byteLength > MAX_JSONL_BYTES) {
      this.#pending = Buffer.alloc(0);
      this.emitError(new Error(`JSONL message exceeds ${MAX_JSONL_BYTES} bytes`));
    }
  };

  private readonly onStreamError = (error: Error): void => this.emitError(error);

  private readonly onInputClose = (): void => {
    if (this.#closed) return;
    for (const listener of [...this.#closeListeners]) listener();
  };

  private consumeLine(line: Buffer): void {
    try {
      const parsed = parseJsonLine(line);
      if (!isJsonRpcMessage(parsed)) throw new Error("Invalid JSON-RPC 2.0 message");
      for (const listener of this.#messageListeners) listener(parsed);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.#errorListeners) listener(error);
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbort?: () => void;
}

export type RpcRequestHandler = (method: string, params: unknown, id: RpcId) => unknown | Promise<unknown>;
export type RpcNotificationHandler = (method: string, params: unknown) => void | Promise<void>;

export interface JsonRpcPeerOptions {
  readonly idPrefix?: string;
  readonly timeoutMs?: number;
  readonly maxPendingRequests?: number;
  readonly onProtocolError?: (error: Error) => void;
  readonly closedError?: () => Error;
}

export class JsonRpcPeer {
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #removeMessage: () => void;
  readonly #removeError: () => void;
  readonly #removeClose: () => void;
  #requestHandler: RpcRequestHandler | undefined;
  #notificationHandler: RpcNotificationHandler | undefined;
  #counter = 0;
  #closed = false;

  public constructor(private readonly transport: JsonLineTransport, private readonly options: JsonRpcPeerOptions = {}) {
    this.#removeMessage = transport.onMessage((message) => void this.handleMessage(message));
    this.#removeError = transport.onError((error) => options.onProtocolError?.(error));
    this.#removeClose = transport.onClose(() => this.fail(options.closedError?.() ?? new Error("JSON-RPC transport closed")));
  }

  public onRequest(handler: RpcRequestHandler): void {
    this.#requestHandler = handler;
  }

  public onNotification(handler: RpcNotificationHandler): void {
    this.#notificationHandler = handler;
  }

  public async request<T>(method: string, params: unknown = {}, options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<T> {
    if (this.#closed) throw new Error("JSON-RPC peer is closed");
    if (this.#pending.size >= (this.options.maxPendingRequests ?? 256)) throw new Error("Too many pending connector requests");
    if (options.signal?.aborted === true) throw options.signal.reason ?? new Error("Connector request aborted");
    const id = `${this.options.idPrefix ?? "rpc"}_${++this.#counter}_${randomUUID()}`;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ConnectorTimeoutError(method, timeoutMs));
      }, timeoutMs);
      let removeAbort: (() => void) | undefined;
      if (options.signal !== undefined) {
        const abort = (): void => {
          const pending = this.#pending.get(id);
          if (pending === undefined) return;
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          reject(options.signal?.reason ?? new Error("Connector request aborted"));
        };
        options.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", abort);
      }
      this.#pending.set(id, { method, resolve, reject, timer, ...(removeAbort !== undefined ? { removeAbort } : {}) });
    });
    try {
      await this.transport.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.rejectPending(id, error);
      throw error;
    }
    return await promise as T;
  }

  public async notify(method: string, params: unknown = {}): Promise<void> {
    if (this.#closed) throw new Error("JSON-RPC peer is closed");
    await this.transport.send({ jsonrpc: "2.0", method, params });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeMessage();
    this.#removeError();
    this.#removeClose();
    for (const id of this.#pending.keys()) this.rejectPending(id, new Error("JSON-RPC peer closed"));
    await this.transport.close();
  }

  /** Reject every pending request immediately when the child process exits. */
  public fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeMessage();
    this.#removeError();
    this.#removeClose();
    for (const id of this.#pending.keys()) this.rejectPending(id, error);
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if ("method" in message) {
      if ("id" in message) await this.handleRequest(message.id, message.method, message.params);
      else {
        try {
          await this.#notificationHandler?.(message.method, message.params);
        } catch (error) {
          this.options.onProtocolError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return;
    }
    if (message.id === null) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    this.#pending.delete(message.id);
    if ("error" in message) pending.reject(new ConnectorRemoteError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }

  private async handleRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    if (this.#requestHandler === undefined) {
      await this.sendError(id, new ConnectorProtocolError(RPC_METHOD_NOT_FOUND, `Method not handled: ${method}`));
      return;
    }
    try {
      const result = await this.#requestHandler(method, params, id);
      await this.transport.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      await this.sendError(id, error);
    }
  }

  private async sendError(id: RpcId, error: unknown): Promise<void> {
    const protocol = error instanceof ConnectorProtocolError
      ? error
      : new ConnectorProtocolError(RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    await this.transport.send({
      jsonrpc: "2.0",
      id,
      error: {
        code: protocol.code,
        message: protocol.message,
        ...(protocol.data !== undefined ? { data: protocol.data } : {}),
      },
    });
  }

  private rejectPending(id: RpcId, error: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    this.#pending.delete(id);
    pending.reject(error);
  }
}

export function assertRpcParams(value: unknown, method: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConnectorProtocolError(RPC_INVALID_REQUEST, `${method} params must be an object`);
  return value;
}
