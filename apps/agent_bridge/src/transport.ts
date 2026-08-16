import { randomUUID } from "node:crypto";
import {
  CURRENT_PROTOCOL_VERSION,
  ExponentialBackoff,
  RequestLedger,
  SecureChannel,
  completeSecureHandshake,
  createSecureHandshakeOffer,
  parseEnvelope,
  parseSecureFrame,
  parseSecureHandshakeAccept,
  signRelayHostAttach,
  type EphemeralKeyPair,
  type EventEnvelope,
  type AgentEvent,
  type HelloEnvelope,
  type JsonObject,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SecureHandshakeOffer,
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
  #handshakeKeyPair: EphemeralKeyPair | null = null;
  #secure: SecureChannel | null = null;
  #deviceId: string | null = null;

  public constructor(
    private readonly bridge: AgentBridge,
    private readonly send: Sender,
    options: BridgeMessageSessionOptions = {},
  ) {
    this.#router = new BridgeRequestRouter(bridge, options.desktopLifecycle);
    this.#allowUnsignedRequests = options.allowUnsignedRequests ?? false;
    this.#eventPollIntervalMs = options.eventPollIntervalMs ?? 250;
  }

  /** True once a paired device has agreed a key for this connection. */
  public get encrypted(): boolean {
    return this.#secure !== null;
  }

  /** The paired device on the other end, once it has identified itself. */
  public get deviceId(): string | null {
    return this.#deviceId;
  }

  public start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    const { offer, keyPair } = createSecureHandshakeOffer({
      hostId: this.bridge.config.hostId,
      hostPrivateKeyPem: this.bridge.config.identity.privateKeyPem,
    });
    this.#handshakeKeyPair = keyPair;
    const hello: HelloEnvelope & { readonly encryption: SecureHandshakeOffer } = {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      messageId: randomUUID(),
      hostId: this.bridge.config.hostId,
      sentAt: new Date().toISOString(),
      kind: "hello",
      type: "protocol.hello",
      supportedVersions: [CURRENT_PROTOCOL_VERSION],
      role: "host",
      encryption: offer,
    };
    // The offer travels in clear text; it carries only a signed public key, and
    // the device authenticates it against the host key it stored at pairing.
    this.send(JSON.stringify(hello));
  }

  public async handle(text: string): Promise<void> {
    if (this.#closed) throw new Error("Bridge message session is closed");
    const outer = parseJson(text);

    const accept = parseSecureHandshakeAccept(outer);
    if (accept !== null) {
      this.establishSecureChannel(accept);
      return;
    }

    const frame = parseSecureFrame(outer);
    if (frame !== null) {
      const channel = this.#secure;
      if (channel === null) throw new Error("An encrypted frame arrived before this connection agreed a key");
      await this.handleDecoded(parseJson(channel.open(frame)));
      return;
    }

    // A device announces itself so the relay path creates this session and the
    // host offer reaches the phone before any real request is sent.
    if (isRecord(outer) && outer.kind === "hello" && outer.role === "device") {
      if (typeof outer.deviceId === "string" && outer.deviceId) this.#deviceId ??= outer.deviceId;
      return;
    }

    if (this.#secure !== null) throw new Error("This connection is encrypted and no longer accepts plain messages");
    await this.handleDecoded(outer);
  }

  private establishSecureChannel(accept: NonNullable<ReturnType<typeof parseSecureHandshakeAccept>>): void {
    if (this.#secure !== null) throw new Error("This connection has already agreed a key");
    const keyPair = this.#handshakeKeyPair;
    if (keyPair === null) throw new Error("This connection did not offer encryption");
    // Signature verification alone would accept a credential this host revoked,
    // so the pairing manager checks registration and revocation first.
    this.bridge.verifyDeviceCredential(accept.credential);
    const { keys, deviceId } = completeSecureHandshake({
      accept,
      hostId: this.bridge.config.hostId,
      hostPublicKeyPem: this.bridge.config.identity.publicKeyPem,
      keyPair,
    });
    const channel = new SecureChannel(keys, "host");
    this.#secure = channel;
    this.#deviceId = deviceId;
    this.#handshakeKeyPair = null;
    // Sent through the new channel: the device can only read it if it derived
    // the same key, which confirms the agreement in both directions.
    this.emit(JSON.stringify({ kind: "secure_established", deviceId, fingerprint: channel.fingerprint() }));
  }

  private emit(text: string): void {
    const channel = this.#secure;
    this.send(channel === null ? text : JSON.stringify(channel.seal(text)));
  }

  private async handleDecoded(raw: unknown): Promise<void> {
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
    this.emit(JSON.stringify(response));
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
    this.emit(JSON.stringify(envelope));
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
  readonly #stopWatchingRevocations: () => void;
  #heartbeat: NodeJS.Timeout | null = null;

  public constructor(private readonly bridge: AgentBridge, private readonly options: BridgeSocketServerOptions) {
    if (options.allowUnsignedRequests === true && !isLoopbackHost(options.host)) {
      throw new Error("Unsigned bridge mode may only bind to a loopback address");
    }
    this.#stopWatchingRevocations = bridge.onDeviceRevoked((deviceId) => this.disconnectDevice(deviceId));
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
    this.#stopWatchingRevocations();
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
    await this.#server.close();
    this.#connections.clear();
  }

  /** Revoking a device ends its live connection instead of only refusing it. */
  private disconnectDevice(deviceId: string): void {
    for (const [connection, session] of this.#sessions) {
      if (session.deviceId !== deviceId) continue;
      session.close();
      this.#sessions.delete(connection);
      this.#connections.delete(connection);
      connection.close(1008, "Device access revoked");
    }
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
  readonly #stopWatchingRevocations: () => void;
  #socket: WebSocket | null = null;
  #disposed = false;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #relaySupportsRevoke = false;

  public constructor(private readonly bridge: AgentBridge, private readonly options: BridgeRelayClientOptions) {
    if (options.token.length < 32) throw new Error("Relay token must contain at least 32 characters");
    this.#stopWatchingRevocations = bridge.onDeviceRevoked((deviceId) => this.disconnectDevice(deviceId));
  }

  public async start(): Promise<void> {
    this.#disposed = false;
    await this.connect();
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    this.#stopWatchingRevocations();
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
    this.#socket?.close(1000, "Bridge shutdown");
    this.#socket = null;
    this.bridge.setRelayConnected(false);
  }

  /**
   * The room token is shared, so the relay cannot tell a revoked device apart
   * on its own. The host names it explicitly and the relay drops the tunnel.
   *
   * An older relay would treat an unknown message as a protocol error and close
   * the tunnel, so this is only sent to a relay that announced the capability.
   * Against such a relay the local session still closes and the device is still
   * refused every action; only its idle tunnel survives until the relay updates.
   */
  private disconnectDevice(deviceId: string): void {
    this.#sessions.get(deviceId)?.close();
    this.#sessions.delete(deviceId);
    if (this.#relaySupportsRevoke && this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "relay.revoke", deviceId }));
    }
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
    // Signed because the room token is shared with every paired device; without
    // proof of the host key any of them could claim the host role. The relay
    // keeps nothing durably, so the revocation list is re-supplied every time.
    socket.send(JSON.stringify({
      type: "relay.attach",
      role: "host",
      hostId: this.bridge.config.hostId,
      token: this.options.token,
      revokedDeviceIds: this.bridge.revokedDeviceIds(),
      proof: signRelayHostAttach({
        hostId: this.bridge.config.hostId,
        token: this.options.token,
        hostPublicKeyPem: this.bridge.config.identity.publicKeyPem,
        hostPrivateKeyPem: this.bridge.config.identity.privateKeyPem,
      }),
    }));
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
      this.#relaySupportsRevoke = Array.isArray(value.supports) && value.supports.includes("relay.revoke");
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
    this.#relaySupportsRevoke = false;
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
