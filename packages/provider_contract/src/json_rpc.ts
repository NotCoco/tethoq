import { randomUUID } from "node:crypto";

export type RpcId = string | number;

export interface JsonRpcTransport {
  send(message: unknown): Promise<void>;
  onMessage(listener: (message: unknown) => void): () => void;
  close(): Promise<void>;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class JsonRpcRemoteError extends Error {
  public constructor(public readonly rpcError: JsonRpcErrorObject) {
    super(rpcError.message);
    this.name = "JsonRpcRemoteError";
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type IncomingRequestHandler = (method: string, params: unknown, id: RpcId) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void | Promise<void>;

export interface JsonRpcPeerOptions {
  readonly includeJsonRpc?: boolean;
  readonly timeoutMs?: number;
  readonly idPrefix?: string;
  readonly onError?: (error: Error) => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class JsonRpcPeer {
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #unsubscribe: () => void;
  #requestCounter = 0;
  #incomingRequestHandler: IncomingRequestHandler | null = null;
  #notificationHandler: NotificationHandler | null = null;
  #lastAsyncError: Error | null = null;
  #closed = false;

  public constructor(
    private readonly transport: JsonRpcTransport,
    private readonly options: JsonRpcPeerOptions = {},
  ) {
    this.#unsubscribe = transport.onMessage((message) => {
      void this.handleMessage(message).catch((error: unknown) => this.reportAsyncError(error));
    });
  }

  public get lastAsyncError(): Error | null {
    return this.#lastAsyncError;
  }

  public onRequest(handler: IncomingRequestHandler): void {
    this.#incomingRequestHandler = handler;
  }

  public onNotification(handler: NotificationHandler): void {
    this.#notificationHandler = handler;
  }

  public async request<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.#closed) throw new Error("JSON-RPC peer is closed");
    const id = `${this.options.idPrefix ?? "rpc"}_${++this.#requestCounter}_${randomUUID()}`;
    const message = this.decorate({ id, method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, this.options.timeoutMs ?? 30_000);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.transport.send(message);
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) clearTimeout(pending.timer);
      this.#pending.delete(id);
      throw error;
    }
    return await promise as T;
  }

  public async notify(method: string, params: unknown = {}): Promise<void> {
    if (this.#closed) throw new Error("JSON-RPC peer is closed");
    await this.transport.send(this.decorate({ method, params }));
  }

  public async respond(id: RpcId, result: unknown): Promise<void> {
    await this.transport.send(this.decorate({ id, result }));
  }

  public async respondError(id: RpcId, error: JsonRpcErrorObject): Promise<void> {
    await this.transport.send(this.decorate({ id, error }));
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("JSON-RPC peer closed"));
    }
    this.#pending.clear();
    await this.transport.close();
  }

  private decorate<T extends object>(message: T): T & { readonly jsonrpc?: "2.0" } {
    return this.options.includeJsonRpc === false ? message : { jsonrpc: "2.0", ...message };
  }

  private reportAsyncError(error: unknown): void {
    const reported = asError(error);
    this.#lastAsyncError = reported;
    if (this.options.onError === undefined) return;
    try {
      void Promise.resolve(this.options.onError(reported)).catch((sinkError: unknown) => {
        this.#lastAsyncError = asError(sinkError);
      });
    } catch (sinkError) {
      this.#lastAsyncError = asError(sinkError);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) return;
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined && ("result" in message || "error" in message) && typeof message.method !== "string") {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (isRecord(message.error) && typeof message.error.code === "number" && typeof message.error.message === "string") {
        pending.reject(new JsonRpcRemoteError({ code: message.error.code, message: message.error.message, ...(message.error.data !== undefined ? { data: message.error.data } : {}) }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    if (id !== undefined) {
      if (this.#incomingRequestHandler === null) {
        await this.respondError(id, { code: -32601, message: `Method not handled: ${message.method}` });
        return;
      }
      try {
        await this.respond(id, await this.#incomingRequestHandler(message.method, message.params, id));
      } catch (error) {
        await this.respondError(id, { code: -32000, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    await this.#notificationHandler?.(message.method, message.params);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
