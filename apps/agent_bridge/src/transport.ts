import { randomUUID } from "node:crypto";
import {
  CURRENT_PROTOCOL_VERSION,
  ExponentialBackoff,
  RequestLedger,
  parseEnvelope,
  type EventEnvelope,
  type AgentEvent,
  type HelloEnvelope,
  type JsonObject,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SignedDeviceAction,
} from "../../../packages/protocol/src/index.js";
import { WebSocketServer, type WebSocketConnection } from "../../../packages/transport_ws/src/index.js";
import { AgentBridge } from "./bridge.js";
import { BridgeRequestRouter, type DesktopLifecycleController } from "./request_router.js";

interface SignedActionMessage {
  readonly kind: "signed_action";
  readonly signed: SignedDeviceAction<JsonObject>;
}

export interface BridgeMessageSessionOptions {
  readonly allowUnsignedRequests?: boolean;
  readonly eventPollIntervalMs?: number;
  readonly desktopLifecycle?: DesktopLifecycleController;
}

type Sender = (text: string) => void;
const maxEventBatchBytes = 1024 * 1024;
const maxEventsPerBatch = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function parseSignedMessage(value: unknown): SignedActionMessage | null {
  if (!isRecord(value) || value.kind !== "signed_action" || !isRecord(value.signed)) return null;
  const signed = value.signed;
  if (!isRecord(signed.credential) || typeof signed.credential.payload !== "string" || typeof signed.credential.signature !== "string" || typeof signed.actionId !== "string" || typeof signed.issuedAt !== "string" || typeof signed.expiresAt !== "string" || !isRecord(signed.action) || typeof signed.signature !== "string") {
    throw new Error("Signed device action is malformed");
  }
  return { kind: "signed_action", signed: signed as unknown as SignedDeviceAction<JsonObject> };
}

function jsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export class BridgeMessageSession {
  readonly #router: BridgeRequestRouter;
  readonly #responses = new RequestLedger<ResponseEnvelope>();
  readonly #inflight = new Map<string, Promise<ResponseEnvelope>>();
  readonly #allowUnsignedRequests: boolean;
  readonly #eventPollIntervalMs: number;
  #latestSequence = 0;
  #eventTimer: NodeJS.Timeout | null = null;
  #started = false;
  #eventReplayEnabled = false;
  #closed = false;

  public constructor(
    private readonly bridge: AgentBridge,
    private readonly send: Sender,
    options: BridgeMessageSessionOptions = {},
  ) {
    this.#router = new BridgeRequestRouter(bridge, options.desktopLifecycle);
    this.#allowUnsignedRequests = options.allowUnsignedRequests ?? false;
    this.#eventPollIntervalMs = options.eventPollIntervalMs ?? 250;
  }

  public start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    const hello: HelloEnvelope = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      messageId: randomUUID(),
      hostId: this.bridge.config.hostId,
      sentAt: new Date().toISOString(),
      kind: "hello",
      type: "protocol.hello",
      supportedVersions: [CURRENT_PROTOCOL_VERSION],
      role: "host",
    };
    this.send(JSON.stringify(hello));
  }

  public async handle(text: string): Promise<void> {
    if (this.#closed) throw new Error("Bridge message session is closed");
    const raw = parseJson(text);
    const signed = parseSignedMessage(raw);
    let envelope;
    let authenticated = false;
    if (signed !== null) {
      const action = this.bridge.verifyDeviceAction(signed.signed);
      envelope = parseEnvelope(action);
      authenticated = true;
    } else {
      envelope = parseEnvelope(raw);
    }
    if (envelope.kind !== "request") throw new Error("Bridge accepts request envelopes from devices");
    if (envelope.hostId !== this.bridge.config.hostId) throw new Error("Request is addressed to another host");
    const eventReplayAuthorized = this.authorize(envelope, authenticated);
    if (eventReplayAuthorized) this.enableEventReplay();
    const cached = this.#responses.get(envelope.requestId);
    if (cached !== undefined) {
      this.adoptSyncCursor(envelope, cached);
      this.sendResponse(cached);
      return;
    }
    let operation = this.#inflight.get(envelope.requestId);
    if (operation === undefined) {
      if (this.#inflight.size >= 32) throw new Error("Too many bridge requests are already in progress");
      operation = this.#router.handle(envelope);
      this.#inflight.set(envelope.requestId, operation);
    }
    let response: ResponseEnvelope;
    try {
      response = await operation;
    } finally {
      if (this.#inflight.get(envelope.requestId) === operation) this.#inflight.delete(envelope.requestId);
    }
    this.#responses.set(envelope.requestId, response);
    this.adoptSyncCursor(envelope, response);
    this.sendResponse(response);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#eventTimer !== null) clearInterval(this.#eventTimer);
    this.#eventTimer = null;
  }

  private authorize(request: RequestEnvelope, authenticated: boolean): boolean {
    if (authenticated) return true;
    if (request.type === "pairing.confirm") return false;
    if (this.#allowUnsignedRequests) return true;
    throw new Error("A paired-device signature is required for this request");
  }

  private sendResponse(response: ResponseEnvelope): void {
    this.send(JSON.stringify(response));
    this.pushEvents();
  }

  private adoptSyncCursor(request: RequestEnvelope, response: ResponseEnvelope): void {
    if (request.type !== "sync.since" || !response.ok) return;
    const throughSequence = response.payload.throughSequence;
    if (typeof throughSequence === "number" && Number.isInteger(throughSequence) && throughSequence >= 0) {
      this.#latestSequence = throughSequence;
    }
  }

  private enableEventReplay(): void {
    if (this.#closed || this.#eventReplayEnabled) return;
    this.#eventReplayEnabled = true;
    this.#eventTimer = setInterval(() => this.pushEvents(), this.#eventPollIntervalMs);
    this.#eventTimer.unref();
  }

  private pushEvents(): void {
    if (this.#closed || !this.#eventReplayEnabled) return;
    const replay = this.bridge.eventReplaySince(this.#latestSequence);
    if (replay.events.length === 0 && !replay.replayGap) return;
    const bounded = boundedEventBatch(
      replay.events,
      Math.min(replay.requestedSequence, replay.latestSequence),
    );
    const batch = bounded.events;
    if (batch.length === 0 && bounded.omittedEventCount === 0) {
      this.#latestSequence = bounded.throughSequence;
      return;
    }
    const sequence = bounded.throughSequence;
    const envelope: EventEnvelope = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      messageId: randomUUID(),
      hostId: this.bridge.config.hostId,
      sentAt: new Date().toISOString(),
      kind: "event",
      type: "event.batch",
      sequence,
      payload: jsonObject({
        events: batch,
        requestedSequence: replay.requestedSequence,
        oldestAvailableSequence: replay.oldestAvailableSequence,
        latestSequence: replay.latestSequence,
        throughSequence: sequence,
        replayGap: replay.replayGap || bounded.omittedEventCount > 0,
        omittedEventCount: bounded.omittedEventCount,
      }),
    };
    this.send(JSON.stringify(envelope));
    this.#latestSequence = sequence;
  }
}

function boundedEventBatch(
  events: readonly AgentEvent[],
  startingSequence = 0,
): { readonly events: readonly AgentEvent[]; readonly throughSequence: number; readonly omittedEventCount: number } {
  const batch: AgentEvent[] = [];
  let bytes = 0;
  let throughSequence = startingSequence;
  let omittedEventCount = 0;
  let inspectedEventCount = 0;
  for (const event of events) {
    if (inspectedEventCount >= maxEventsPerBatch) break;
    inspectedEventCount += 1;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    if (batch.length > 0 && bytes + eventBytes > maxEventBatchBytes) break;
    // A single oversized native event is omitted rather than wedging every
    // future replay for this device. Normalized events should remain small.
    if (eventBytes > maxEventBatchBytes) {
      throughSequence = event.sequence;
      omittedEventCount += 1;
      continue;
    }
    batch.push(event);
    bytes += eventBytes;
    throughSequence = event.sequence;
  }
  return { events: batch, throughSequence, omittedEventCount };
}

export interface BridgeSocketServerOptions {
  readonly host?: string;
  readonly port: number;
  readonly path?: string;
  readonly allowUnsignedRequests?: boolean;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly desktopLifecycle?: DesktopLifecycleController;
}

export class BridgeSocketServer {
  readonly #server: WebSocketServer;
  readonly #connections = new Set<WebSocketConnection>();
  readonly #sessions = new Map<WebSocketConnection, BridgeMessageSession>();
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  #heartbeat: NodeJS.Timeout | null = null;

  public constructor(private readonly bridge: AgentBridge, private readonly options: BridgeSocketServerOptions) {
    if (options.allowUnsignedRequests === true && !isLoopbackHost(options.host)) {
      throw new Error("Unsigned bridge mode may only bind to a loopback address");
    }
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
    this.#server = new WebSocketServer({
      ...(options.host !== undefined ? { host: options.host } : {}),
      port: options.port,
      path: options.path ?? "/bridge",
      onHttpRequest: (request, response) => {
        if (request.url === "/healthz") {
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end('{"ok":true}\n');
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}\n');
      },
    });
    this.#server.onConnection((connection) => this.accept(connection));
  }

  public async listen(): Promise<void> {
    await this.#server.listen();
    this.#heartbeat = setInterval(() => this.heartbeat(), this.#heartbeatIntervalMs);
    this.#heartbeat.unref();
  }

  public address(): ReturnType<WebSocketServer["address"]> {
    return this.#server.address();
  }

  public async close(): Promise<void> {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
    await this.#server.close();
    this.#connections.clear();
  }

  private accept(connection: WebSocketConnection): void {
    const session = new BridgeMessageSession(this.bridge, (text) => connection.sendText(text), {
      allowUnsignedRequests: this.options.allowUnsignedRequests ?? false,
      ...(this.options.desktopLifecycle !== undefined ? { desktopLifecycle: this.options.desktopLifecycle } : {}),
    });
    this.#connections.add(connection);
    this.#sessions.set(connection, session);
    connection.onMessage((text) => session.handle(text));
    connection.onError((error) => {
      connection.sendJson({ type: "transport.error", message: error.message });
    });
    connection.onClose(() => {
      session.close();
      this.#sessions.delete(connection);
      this.#connections.delete(connection);
    });
    session.start();
  }

  private heartbeat(): void {
    const cutoff = Date.now() - this.#heartbeatTimeoutMs;
    for (const connection of this.#connections) {
      if (connection.lastPongAt < cutoff) connection.close(1001, "Heartbeat timeout");
      else connection.ping();
    }
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const parts = normalized.split(".");
  return parts.length === 4 && parts[0] === "127";
}

interface RelayForwardMessage {
  readonly type: "relay.forward";
  readonly deviceId: string;
  readonly payload: string;
}

function relayForward(value: unknown): RelayForwardMessage | null {
  if (!isRecord(value) || value.type !== "relay.forward" || typeof value.deviceId !== "string" || typeof value.payload !== "string") return null;
  return { type: "relay.forward", deviceId: value.deviceId, payload: value.payload };
}

export interface BridgeRelayClientOptions {
  readonly url: string;
  readonly token: string;
  readonly reconnect?: boolean;
  readonly desktopLifecycle?: DesktopLifecycleController;
}

export class BridgeRelayClient {
  readonly #backoff = new ExponentialBackoff();
  readonly #sessions = new Map<string, BridgeMessageSession>();
  #socket: WebSocket | null = null;
  #disposed = false;
  #reconnectTimer: NodeJS.Timeout | null = null;

  public constructor(private readonly bridge: AgentBridge, private readonly options: BridgeRelayClientOptions) {
    if (options.token.length < 32) throw new Error("Relay token must contain at least 32 characters");
  }

  public async start(): Promise<void> {
    this.#disposed = false;
    await this.connect();
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
    this.#socket?.close(1000, "Bridge shutdown");
    this.#socket = null;
    this.bridge.setRelayConnected(false);
  }

  private async connect(): Promise<void> {
    if (this.#disposed) return;
    const socket = new WebSocket(this.options.url);
    this.#socket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
        const onOpen = () => {
          socket.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          socket.removeEventListener("open", onOpen);
          reject(new Error("Unable to connect to relay"));
        };
        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
      });
    } catch (error) {
      this.disconnected(socket);
      throw error;
    }
    if (this.#disposed || this.#socket !== socket) {
      socket.close(1000, "Bridge shutdown");
      return;
    }
    socket.send(JSON.stringify({ type: "relay.attach", role: "host", hostId: this.bridge.config.hostId, token: this.options.token }));
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.disconnected(socket));
    socket.addEventListener("error", () => this.disconnected(socket));
  }

  private receive(text: string): void {
    let value: unknown;
    try {
      value = parseJson(text);
    } catch {
      return;
    }
    if (isRecord(value) && value.type === "relay.attached" && value.role === "host") {
      this.#backoff.reset();
      this.bridge.setRelayConnected(true);
      return;
    }
    const forward = relayForward(value);
    if (forward === null) return;
    let session = this.#sessions.get(forward.deviceId);
    if (session === undefined) {
      session = new BridgeMessageSession(this.bridge, (payload) => this.sendToDevice(forward.deviceId, payload), {
        ...(this.options.desktopLifecycle !== undefined ? { desktopLifecycle: this.options.desktopLifecycle } : {}),
      });
      this.#sessions.set(forward.deviceId, session);
      session.start();
    }
    void session.handle(forward.payload).catch((error: unknown) => {
      this.sendToDevice(forward.deviceId, JSON.stringify({ type: "transport.error", message: error instanceof Error ? error.message : String(error) }));
    });
  }

  private sendToDevice(deviceId: string, payload: string): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify({ type: "relay.forward", deviceId, payload }));
  }

  private disconnected(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.bridge.setRelayConnected(false);
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
    if (this.#disposed || this.options.reconnect === false || this.#reconnectTimer !== null) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, this.#backoff.next());
    this.#reconnectTimer.unref();
  }
}
