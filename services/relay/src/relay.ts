import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocketConnection } from "../../../packages/transport_ws/src/index.js";

interface RelayAttach {
  readonly type: "relay.attach";
  readonly role: "host" | "device";
  readonly hostId: string;
  readonly token: string;
  readonly deviceId?: string;
}

interface RelayForward {
  readonly type: "relay.forward";
  readonly deviceId: string;
  readonly payload: string;
}

interface RelayRoom {
  readonly hostId: string;
  readonly tokenHash: Buffer;
  host: WebSocketConnection;
  readonly devices: Map<string, WebSocketConnection>;
}

interface RateState {
  startedAt: number;
  messages: number;
  bytes: number;
}

export interface RelayServerOptions {
  readonly host?: string;
  readonly port: number;
  readonly path?: string;
  readonly attachTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly maxMessagesPerMinute?: number;
  readonly maxBytesPerMinute?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) throw new Error("Relay message must be an object");
  return value;
}

function parseAttach(text: string): RelayAttach {
  const value = parseJson(text);
  if (value.type !== "relay.attach" || (value.role !== "host" && value.role !== "device") || typeof value.hostId !== "string" || value.hostId.length === 0 || typeof value.token !== "string" || value.token.length < 32) {
    throw new Error("Invalid relay attachment message");
  }
  if (value.role === "device" && (typeof value.deviceId !== "string" || value.deviceId.length === 0)) throw new Error("Device attachment requires deviceId");
  return {
    type: "relay.attach",
    role: value.role,
    hostId: value.hostId,
    token: value.token,
    ...(typeof value.deviceId === "string" ? { deviceId: value.deviceId } : {}),
  };
}

function parseForward(text: string, maxPayloadBytes: number): RelayForward {
  const value = parseJson(text);
  if (value.type !== "relay.forward" || typeof value.deviceId !== "string" || value.deviceId.length === 0 || typeof value.payload !== "string") throw new Error("Invalid host forwarding message");
  if (Buffer.byteLength(value.payload, "utf8") > maxPayloadBytes) throw new Error("Relay payload exceeds configured limit");
  return { type: "relay.forward", deviceId: value.deviceId, payload: value.payload };
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function equalToken(token: string, expected: Buffer): boolean {
  const actual = digest(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class RelayServer {
  readonly #server: WebSocketServer;
  readonly #rooms = new Map<string, RelayRoom>();
  readonly #rates = new WeakMap<WebSocketConnection, RateState>();
  readonly #options: Required<Omit<RelayServerOptions, "host">> & Pick<RelayServerOptions, "host">;
  #heartbeat: NodeJS.Timeout | null = null;

  public constructor(options: RelayServerOptions) {
    this.#options = {
      ...options,
      path: options.path ?? "/relay",
      attachTimeoutMs: options.attachTimeoutMs ?? 10_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 45_000,
      maxPayloadBytes: options.maxPayloadBytes ?? 2 * 1024 * 1024,
      maxMessagesPerMinute: options.maxMessagesPerMinute ?? 1_200,
      maxBytesPerMinute: options.maxBytesPerMinute ?? 32 * 1024 * 1024,
    };
    this.#server = new WebSocketServer({
      ...(options.host !== undefined ? { host: options.host } : {}),
      port: options.port,
      path: this.#options.path,
      maxMessageBytes: this.#options.maxPayloadBytes + 1024,
      onHttpRequest: (request, response) => {
        if (request.url === "/healthz") {
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          response.end(JSON.stringify({ ok: true, rooms: this.#rooms.size }) + "\n");
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"error":"not_found"}\n');
      },
    });
    this.#server.onConnection((connection, request) => this.accept(connection, request));
  }

  public async listen(): Promise<void> {
    await this.#server.listen();
    this.#heartbeat = setInterval(() => this.heartbeat(), this.#options.heartbeatIntervalMs);
    this.#heartbeat.unref();
  }

  public address(): ReturnType<WebSocketServer["address"]> {
    return this.#server.address();
  }

  public roomCount(): number {
    return this.#rooms.size;
  }

  public deviceCount(hostId?: string): number {
    if (hostId !== undefined) return this.#rooms.get(hostId)?.devices.size ?? 0;
    return [...this.#rooms.values()].reduce((sum, room) => sum + room.devices.size, 0);
  }

  public async close(): Promise<void> {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    await this.#server.close();
    this.#rooms.clear();
  }

  private accept(connection: WebSocketConnection, _request: IncomingMessage): void {
    let attached = false;
    const timer = setTimeout(() => {
      if (!attached) connection.close(1008, "Relay attachment timeout");
    }, this.#options.attachTimeoutMs);
    timer.unref();

    const removeMessage = connection.onMessage((text) => {
      this.charge(connection, text);
      if (attached) return;
      const attach = parseAttach(text);
      attached = true;
      clearTimeout(timer);
      removeMessage();
      if (attach.role === "host") this.attachHost(connection, attach);
      else this.attachDevice(connection, attach);
    });
    connection.onClose(() => clearTimeout(timer));
    connection.onError(() => connection.close(1011, "Relay connection error"));
  }

  private attachHost(connection: WebSocketConnection, attach: RelayAttach): void {
    const existing = this.#rooms.get(attach.hostId);
    if (existing !== undefined && !equalToken(attach.token, existing.tokenHash)) throw new Error("Relay token does not match existing host room");
    if (existing !== undefined) {
      existing.host.close(1012, "Host tunnel replaced");
      existing.host = connection;
      connection.sendJson({ type: "relay.attached", role: "host", hostId: attach.hostId, devices: existing.devices.size });
      this.bindHost(existing, connection);
      return;
    }
    const room: RelayRoom = { hostId: attach.hostId, tokenHash: digest(attach.token), host: connection, devices: new Map() };
    this.#rooms.set(attach.hostId, room);
    connection.sendJson({ type: "relay.attached", role: "host", hostId: attach.hostId, devices: 0 });
    this.bindHost(room, connection);
  }

  private bindHost(room: RelayRoom, connection: WebSocketConnection): void {
    connection.onMessage((text) => {
      this.charge(connection, text);
      const forward = parseForward(text, this.#options.maxPayloadBytes);
      const device = room.devices.get(forward.deviceId);
      if (device === undefined || device.isClosed) return;
      device.sendText(forward.payload);
    });
    connection.onClose(() => {
      if (room.host === connection) {
        for (const device of room.devices.values()) device.sendJson({ type: "relay.host_offline", hostId: room.hostId });
      }
    });
  }

  private attachDevice(connection: WebSocketConnection, attach: RelayAttach): void {
    const room = this.#rooms.get(attach.hostId);
    if (room === undefined || room.host.isClosed) throw new Error("Host is not connected to the relay");
    if (!equalToken(attach.token, room.tokenHash)) throw new Error("Relay token is invalid");
    const deviceId = attach.deviceId;
    if (deviceId === undefined) throw new Error("Device ID is missing");
    room.devices.get(deviceId)?.close(1012, "Device tunnel replaced");
    room.devices.set(deviceId, connection);
    connection.sendJson({ type: "relay.attached", role: "device", hostId: attach.hostId, deviceId });
    connection.onMessage((payload) => {
      this.charge(connection, payload);
      if (Buffer.byteLength(payload, "utf8") > this.#options.maxPayloadBytes) throw new Error("Relay payload exceeds configured limit");
      if (room.host.isClosed) throw new Error("Host is offline");
      room.host.sendJson({ type: "relay.forward", deviceId, payload });
    });
    connection.onClose(() => {
      if (room.devices.get(deviceId) === connection) room.devices.delete(deviceId);
      if (room.host.isClosed && room.devices.size === 0) this.#rooms.delete(room.hostId);
    });
  }

  private charge(connection: WebSocketConnection, text: string): void {
    const now = Date.now();
    const bytes = Buffer.byteLength(text, "utf8");
    let state = this.#rates.get(connection);
    if (state === undefined || now - state.startedAt >= 60_000) {
      state = { startedAt: now, messages: 0, bytes: 0 };
      this.#rates.set(connection, state);
    }
    state.messages += 1;
    state.bytes += bytes;
    if (state.messages > this.#options.maxMessagesPerMinute || state.bytes > this.#options.maxBytesPerMinute) {
      connection.close(1008, "Relay rate limit exceeded");
      throw new Error("Relay rate limit exceeded");
    }
  }

  private heartbeat(): void {
    const cutoff = Date.now() - this.#options.heartbeatTimeoutMs;
    for (const room of this.#rooms.values()) {
      if (!room.host.isClosed) {
        if (room.host.lastPongAt < cutoff) room.host.close(1001, "Heartbeat timeout");
        else room.host.ping();
      }
      for (const [deviceId, device] of room.devices) {
        if (device.isClosed) room.devices.delete(deviceId);
        else if (device.lastPongAt < cutoff) device.close(1001, "Heartbeat timeout");
        else device.ping();
      }
      if (room.host.isClosed && room.devices.size === 0) this.#rooms.delete(room.hostId);
    }
  }
}
