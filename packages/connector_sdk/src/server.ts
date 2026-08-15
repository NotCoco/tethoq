import type { Readable, Writable } from "node:stream";
import {
  ConnectorProtocolError,
  RPC_ALREADY_INITIALIZED,
  RPC_CAPABILITY_NOT_DECLARED,
  RPC_METHOD_NOT_FOUND,
  RPC_NOT_INITIALIZED,
  RPC_PROTOCOL_MISMATCH,
} from "./errors.js";
import { JsonLineStreamTransport, JsonRpcPeer, assertRpcParams } from "./jsonl_rpc.js";
import { parseConnectorManifest } from "./manifest.js";
import {
  CONNECTOR_PROTOCOL_VERSION,
  type ConnectorCapability,
  type ConnectorCreateSessionParams,
  type ConnectorEditMessageParams,
  type ConnectorHandlerContext,
  type ConnectorHandlers,
  type ConnectorInitializeParams,
  type ConnectorInitializeResult,
  type ConnectorListSessionsParams,
  type ConnectorListQueuedMessagesParams,
  type ConnectorLogNotification,
  type ConnectorManifestV1,
  type ConnectorQueueCancelParams,
  type ConnectorQueueEnqueueParams,
  type ConnectorSendMessageParams,
  type ConnectorSessionIdParams,
  type ConnectorSubscribeParams,
  type ConnectorUnsubscribeParams,
  type ConnectorApprovalResponseParams,
  type ConnectorUserInputResponseParams,
  type ConnectorAuthStartParams,
  type ConnectorEvent,
  type ConnectorHostToolParams,
  type JsonObject,
  type JsonValue,
} from "./types.js";

export interface ConnectorServerOptions {
  readonly manifest: ConnectorManifestV1;
  readonly handlers: ConnectorHandlers;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly onProtocolError?: (error: Error) => void;
}

const capabilityByMethod: Readonly<Partial<Record<string, ConnectorCapability>>> = Object.freeze({
  "provider.auth.start": "authentication",
  "provider.models.list": "modelEnumeration",
  "session.list": "listSessions",
  "session.get": "listSessions",
  "session.messages.list": "sessionHistory",
  "session.create": "createSession",
  "session.resume": "resumeSession",
  "session.message.send": "sendMessage",
  "session.message.steer": "steering",
  "session.message.edit": "messageEditing",
  "session.interrupt": "interrupt",
  "session.queue.list": "messageQueue",
  "session.queue.enqueue": "messageQueue",
  "session.queue.cancel": "messageQueue",
  "approval.respond": "approvals",
  "userInput.respond": "userInput",
});

export class ConnectorServer {
  readonly #manifest: ConnectorManifestV1;
  readonly #handlers: ConnectorHandlers;
  readonly #peer: JsonRpcPeer;
  readonly #lifetime = new AbortController();
  #initializeParams: ConnectorInitializeParams | undefined;
  #closed = false;

  public constructor(options: ConnectorServerOptions) {
    this.#manifest = parseConnectorManifest(options.manifest);
    this.#handlers = options.handlers;
    const transport = new JsonLineStreamTransport({
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    this.#peer = new JsonRpcPeer(transport, {
      idPrefix: `connector_${this.#manifest.id}`,
      onProtocolError: options.onProtocolError ?? ((error) => process.stderr.write(`[connector protocol] ${error.message}\n`)),
    });
    this.#peer.onRequest((method, params) => this.handleRequest(method, params));
  }

  public get initialized(): boolean {
    return this.#initializeParams !== undefined;
  }

  public get manifest(): ConnectorManifestV1 {
    return this.#manifest;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort(new Error("Connector server closed"));
    await this.#peer.close();
  }

  private async handleRequest(method: string, rawParams: unknown): Promise<unknown> {
    const params = assertRpcParams(rawParams ?? {}, method);
    if (method === "connector.initialize") return await this.initialize(params as unknown as ConnectorInitializeParams);
    if (method === "connector.ping") return { ok: true, now: new Date().toISOString() };
    if (this.#initializeParams === undefined) throw new ConnectorProtocolError(RPC_NOT_INITIALIZED, "Call connector.initialize first");
    if (method === "connector.shutdown") {
      await this.#handlers.shutdown?.({}, this.context());
      queueMicrotask(() => void this.close());
      return {};
    }
    const capability = capabilityByMethod[method];
    if (capability !== undefined && !this.#manifest.capabilities[capability]) {
      throw new ConnectorProtocolError(RPC_CAPABILITY_NOT_DECLARED, `${method} requires the declared ${capability} capability`);
    }

    switch (method) {
      case "provider.detect": return await this.requireHandler("detect")({}, this.context());
      case "provider.auth.status": return await this.requireHandler("getAuthStatus")({}, this.context());
      case "provider.auth.start": return await this.requireHandler("authenticate")(params as unknown as ConnectorAuthStartParams, this.context());
      case "provider.capabilities": return await this.#handlers.getCapabilities?.({}, this.context()) ?? this.#manifest.capabilities;
      case "provider.models.list": return await this.#handlers.listModels?.({}, this.context()) ?? this.#manifest.models ?? [];
      case "session.list": return await this.requireHandler("listSessions")(params as unknown as ConnectorListSessionsParams, this.context());
      case "session.get": return await this.requireHandler("getSession")(sessionParams(params), this.context());
      case "session.messages.list": return await this.requireHandler("listMessages")(sessionParams(params), this.context());
      case "session.create": return await this.requireHandler("createSession")(params as unknown as ConnectorCreateSessionParams, this.context());
      case "session.resume": return await this.requireHandler("resumeSession")(sessionParams(params), this.context());
      case "session.message.send": return await this.requireHandler("sendMessage")(params as unknown as ConnectorSendMessageParams, this.context());
      case "session.message.steer": return await this.requireHandler("steerMessage")(params as unknown as ConnectorSendMessageParams, this.context());
      case "session.message.edit": return await this.requireHandler("editMessage")(params as unknown as ConnectorEditMessageParams, this.context());
      case "session.interrupt": return await this.requireHandler("interrupt")(sessionParams(params), this.context());
      case "session.queue.list": return await this.requireHandler("listQueuedMessages")(optionalSessionParams(params), this.context());
      case "session.queue.enqueue": return await this.requireHandler("enqueueMessage")(params as unknown as ConnectorQueueEnqueueParams, this.context());
      case "session.queue.cancel": return await this.requireHandler("cancelQueuedMessage")(params as unknown as ConnectorQueueCancelParams, this.context());
      case "approval.respond": return await this.requireHandler("respondToApproval")(params as unknown as ConnectorApprovalResponseParams, this.context());
      case "userInput.respond": return await this.requireHandler("respondToUserInput")(params as unknown as ConnectorUserInputResponseParams, this.context());
      case "events.subscribe": return await this.requireHandler("subscribe")(params as unknown as ConnectorSubscribeParams, this.context());
      case "events.unsubscribe": return await this.requireHandler("unsubscribe")(params as unknown as ConnectorUnsubscribeParams, this.context());
      default: throw new ConnectorProtocolError(RPC_METHOD_NOT_FOUND, `Unknown connector method ${method}`);
    }
  }

  private async initialize(params: ConnectorInitializeParams): Promise<ConnectorInitializeResult> {
    if (this.#initializeParams !== undefined) throw new ConnectorProtocolError(RPC_ALREADY_INITIALIZED, "Connector is already initialized");
    if (params.protocolVersion !== CONNECTOR_PROTOCOL_VERSION) {
      throw new ConnectorProtocolError(RPC_PROTOCOL_MISMATCH, `Connector protocol ${String(params.protocolVersion)} is unsupported`);
    }
    if (typeof params.host?.id !== "string" || !Array.isArray(params.workspaceRoots) || !params.workspaceRoots.every((root) => typeof root === "string")) {
      throw new ConnectorProtocolError(RPC_PROTOCOL_MISMATCH, "Invalid connector initialization parameters");
    }
    this.#initializeParams = params;
    try {
      await this.#handlers.initialize?.(params, this.context());
    } catch (error) {
      this.#initializeParams = undefined;
      throw error;
    }
    return {
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      connector: { id: this.#manifest.id, name: this.#manifest.name, version: this.#manifest.version },
      capabilities: this.#manifest.capabilities,
      ...(this.#manifest.models !== undefined ? { models: this.#manifest.models } : {}),
    };
  }

  private context(): ConnectorHandlerContext {
    const initialized = this.#initializeParams;
    if (initialized === undefined) throw new ConnectorProtocolError(RPC_NOT_INITIALIZED, "Connector is not initialized");
    return {
      manifest: this.#manifest,
      host: initialized.host,
      workspaceRoots: initialized.workspaceRoots,
      signal: this.#lifetime.signal,
      emitEvent: async (subscriptionId: string, event: ConnectorEvent) => {
        await this.#peer.notify("events.emit", { subscriptionId, event });
      },
      executeHostTool: async (params: ConnectorHostToolParams): Promise<JsonValue> => await this.#peer.request<JsonValue>("host.tool.execute", params),
      log: async (level: ConnectorLogNotification["level"], message: string, metadata?: JsonObject) => {
        await this.#peer.notify("host.log", { level, message, ...(metadata !== undefined ? { metadata } : {}) });
      },
    };
  }

  private requireHandler<K extends keyof ConnectorHandlers>(name: K): NonNullable<ConnectorHandlers[K]> {
    const handler = this.#handlers[name];
    if (handler === undefined) throw new ConnectorProtocolError(RPC_METHOD_NOT_FOUND, `Connector handler ${name} is not implemented`);
    return handler as NonNullable<ConnectorHandlers[K]>;
  }
}

export function serveConnector(options: ConnectorServerOptions): ConnectorServer {
  return new ConnectorServer(options);
}

function sessionParams(params: Record<string, unknown>): ConnectorSessionIdParams {
  if (typeof params.sessionId !== "string" || params.sessionId.length === 0) throw new ConnectorProtocolError(-32602, "sessionId is required");
  return { sessionId: params.sessionId };
}

function optionalSessionParams(params: Record<string, unknown>): ConnectorListQueuedMessagesParams {
  if (params.sessionId === undefined) return {};
  if (typeof params.sessionId !== "string" || params.sessionId.length === 0) throw new ConnectorProtocolError(-32602, "sessionId must be a non-empty string when provided");
  return { sessionId: params.sessionId };
}
