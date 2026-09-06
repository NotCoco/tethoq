import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocketConnection } from "../../../packages/transport_ws/src/index.js";
import {
  RELAY_ATTACH_SKEW_MS,
  parseRelayDeviceAttachProof,
  parseRelayHostAttachProof,
  verifyRelayDeviceAttach,
  verifyRelayHostAttach,
  type RelayDeviceAttachProof,
  type RelayHostAttachProof,
} from "../../../packages/protocol/src/index.js";

interface RelayAttach {
  readonly type: "relay.attach";
  readonly role: "host" | "device";
  readonly hostId: string;
  readonly token: string;
  readonly deviceId?: string;
  /** Host only. Devices the host has revoked and will not serve. */
  readonly revokedDeviceIds?: readonly string[];
  /** Host only. Proves possession of the host identity, not just the room token. */
  readonly proof?: RelayHostAttachProof;
  /** Device only. Proves the device is the one its host-signed credential names. */
  readonly deviceProof?: RelayDeviceAttachProof;
}

interface RelayForward {
  readonly type: "relay.forward";
  readonly deviceId: string;
  readonly payload: string;
}

/** Host instruction to drop a device the user just revoked. */
interface RelayRevoke {
  readonly type: "relay.revoke";
  readonly deviceId: string;
}

interface RelayRoom {
  readonly hostId: string;
  readonly tokenHash: Buffer;
  /**
   * Pinned on the first signed attachment. Every later host attachment must
   * present the same key, so holding the shared room token is never enough to
   * take a room over.
   */
  readonly hostPublicKeyPem: string;
  host: WebSocketConnection;
  readonly devices: Map<string, WebSocketConnection>;
  /**
   * Revoked devices are refused even though they still hold the shared room
   * token. The host stays the authority and re-sends this set every time it
   * attaches, so the relay never has to remember anything durably.
   */
  revokedDeviceIds: Set<string>;
}

/** Bounds the in-memory blocklist a single host can push into the relay. */
const maxRevokedDeviceIds = 500;

/**
 * Announced to the host on attach. A relay that predates a capability rejects
 * its message and closes the tunnel, so the host must not send one until the
 * relay it actually reached has said it understands it.
 */
export const RELAY_HOST_CAPABILITIES = ["relay.revoke"] as const;

/** Ceiling on remembered attachment IDs, so replay memory cannot be grown. */
const maxRememberedAttachIds = 10_000;

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
  /** Total sockets the process will hold, attached or not. */
  readonly maxConnections?: number;
  /** Sockets one client address may hold, so one peer cannot exhaust the pool. */
  readonly maxConnectionsPerAddress?: number;
  /** Rooms the process will hold, bounding memory against unattached hosts. */
  readonly maxRooms?: number;
  /** Devices one room will serve. */
  readonly maxDevicesPerRoom?: number;
  /**
   * Only disable while migrating hosts that predate signed attachment. An
   * unsigned host attachment lets any holder of the shared room token claim the
   * host role, so this must be true in any deployment reachable from a network.
   */
  readonly requireSignedHostAttach?: boolean;
  /**
   * Only disable while migrating devices that predate signed attachment. An
   * unsigned device attachment lets any holder of the shared room token claim
   * another device's ID and take over its tunnel.
   */
  readonly requireSignedDeviceAttach?: boolean;
  /** Ceiling on the first, still-unauthenticated message from a peer. */
  readonly maxAttachBytes?: number;
  /** New connections one address may open per minute, bounding churn floods. */
  readonly maxConnectionsPerAddressPerMinute?: number;
  /**
   * Addresses whose `x-forwarded-for` header is believed. The relay listens on
   * loopback behind its own reverse proxy, so without this every client shares
   * one apparent address and per-address limits do nothing.
   */
  readonly trustedProxyAddresses?: readonly string[];
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
  if (value.hostId.length > 200 || value.token.length > 512) throw new Error("Invalid relay attachment message");
  const proof = value.role === "host" ? parseRelayHostAttachProof(value.proof) : null;
  const deviceProof = value.role === "device" ? parseRelayDeviceAttachProof(value.proof) : null;
  return {
    type: "relay.attach",
    role: value.role,
    hostId: value.hostId,
    token: value.token,
    ...(typeof value.deviceId === "string" ? { deviceId: value.deviceId.slice(0, 200) } : {}),
    ...(value.role === "host" ? { revokedDeviceIds: parseRevokedDeviceIds(value.revokedDeviceIds) } : {}),
    ...(proof === null ? {} : { proof }),
    ...(deviceProof === null ? {} : { deviceProof }),
  };
}

/**
 * One message for every rejected attachment. Distinct reasons would let an
 * unauthenticated peer probe which host IDs and tokens exist.
 */
const attachRefused = () => new Error("Relay attachment refused");

function isLoopbackAddress(value: string): boolean {
  const normalized = value.replace(/^::ffff:/u, "");
  return normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.");
}

/**
 * The client address used for per-address limits. Behind the relay's own proxy
 * every socket appears to come from loopback, so the forwarded header is read
 * only when the immediate peer is a trusted proxy. Its right-most entry is the
 * address that proxy actually observed; entries further left are attacker
 * controlled and are ignored.
 */
export function clientAddress(
  remoteAddress: string | undefined,
  forwardedFor: string | undefined,
  trustedProxyAddresses: ReadonlySet<string>,
): string {
  const peer = remoteAddress ?? "unknown";
  const trusted = trustedProxyAddresses.has(peer)
    || (trustedProxyAddresses.has("loopback") && isLoopbackAddress(peer));
  if (!trusted || forwardedFor === undefined) return peer;
  const hops = forwardedFor.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0 && entry.length <= 64);
  return hops.at(-1) ?? peer;
}

function parseRevokedDeviceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 200)
    .slice(0, maxRevokedDeviceIds);
}

function parseRevoke(text: string): RelayRevoke | null {
  const value = parseJson(text);
  if (value.type !== "relay.revoke") return null;
  if (typeof value.deviceId !== "string" || value.deviceId.length === 0) throw new Error("Invalid host revocation message");
  return { type: "relay.revoke", deviceId: value.deviceId };
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
  /** Per-address budget, so opening more sockets does not multiply the allowance. */
  readonly #addressRates = new Map<string, RateState>();
  readonly #connectionsByAddress = new Map<string, number>();
  readonly #addresses = new WeakMap<WebSocketConnection, string>();
  /** Recently used attachment IDs, so a captured host attachment cannot be replayed. */
  readonly #usedAttachIds = new Map<string, number>();
  readonly #trustedProxyAddresses: ReadonlySet<string>;
  /** New connections per address per minute, separate from concurrent holds. */
  readonly #connectionRates = new Map<string, RateState>();
  readonly #options: Required<Omit<RelayServerOptions, "host" | "trustedProxyAddresses">> & Pick<RelayServerOptions, "host">;
  #connectionCount = 0;
  #heartbeat: NodeJS.Timeout | null = null;

  public constructor(options: RelayServerOptions) {
    this.#trustedProxyAddresses = new Set(options.trustedProxyAddresses ?? ["loopback"]);
    this.#options = {
      ...options,
      path: options.path ?? "/relay",
      attachTimeoutMs: options.attachTimeoutMs ?? 10_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 45_000,
      maxPayloadBytes: options.maxPayloadBytes ?? 2 * 1024 * 1024,
      maxMessagesPerMinute: options.maxMessagesPerMinute ?? 1_200,
      maxBytesPerMinute: options.maxBytesPerMinute ?? 32 * 1024 * 1024,
      maxConnections: options.maxConnections ?? 4_000,
      maxConnectionsPerAddress: options.maxConnectionsPerAddress ?? 32,
      maxRooms: options.maxRooms ?? 2_000,
      maxDevicesPerRoom: options.maxDevicesPerRoom ?? 16,
      requireSignedHostAttach: options.requireSignedHostAttach ?? true,
      requireSignedDeviceAttach: options.requireSignedDeviceAttach ?? true,
      maxAttachBytes: options.maxAttachBytes ?? 16 * 1024,
      maxConnectionsPerAddressPerMinute: options.maxConnectionsPerAddressPerMinute ?? 120,
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

  private accept(connection: WebSocketConnection, request: IncomingMessage): void {
    const address = clientAddress(
      request.socket.remoteAddress,
      typeof request.headers["x-forwarded-for"] === "string" ? request.headers["x-forwarded-for"] : undefined,
      this.#trustedProxyAddresses,
    );
    const held = this.#connectionsByAddress.get(address) ?? 0;
    // Refuse before any work: an unattached socket still costs memory and a
    // parser, which is exactly what a flood is trying to spend.
    if (this.#connectionCount >= this.#options.maxConnections) {
      connection.close(1013, "Relay is at capacity");
      return;
    }
    if (held >= this.#options.maxConnectionsPerAddress) {
      connection.close(1013, "Too many connections from this address");
      return;
    }
    // Concurrency alone does not stop a peer opening and closing sockets as
    // fast as it can, so the arrival rate is bounded separately.
    if (!this.admitConnectionRate(address)) {
      connection.close(1013, "Too many connections from this address");
      return;
    }
    // Only native clients speak this protocol. A browser page carries an origin
    // and could be pointed here by any web site the user visits.
    if (typeof request.headers.origin === "string" && request.headers.origin.length > 0) {
      connection.close(1008, "Relay does not accept browser origins");
      return;
    }
    this.#connectionCount += 1;
    this.#connectionsByAddress.set(address, held + 1);
    this.#addresses.set(connection, address);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#connectionCount -= 1;
      const remaining = (this.#connectionsByAddress.get(address) ?? 1) - 1;
      if (remaining <= 0) this.#connectionsByAddress.delete(address);
      else this.#connectionsByAddress.set(address, remaining);
    };

    let attached = false;
    const timer = setTimeout(() => {
      if (!attached) connection.close(1008, "Relay attachment timeout");
    }, this.#options.attachTimeoutMs);
    timer.unref();

    const removeMessage = connection.onMessage((text) => {
      this.charge(connection, text);
      if (attached) return;
      // The attachment is the only message accepted from an unauthenticated
      // peer, so it is held to a much smaller ceiling than routed payloads.
      if (Buffer.byteLength(text, "utf8") > this.#options.maxAttachBytes) throw attachRefused();
      const attach = parseAttach(text);
      attached = true;
      clearTimeout(timer);
      removeMessage();
      if (attach.role === "host") this.attachHost(connection, attach);
      else this.attachDevice(connection, attach);
    });
    connection.onClose(() => {
      clearTimeout(timer);
      release();
    });
    connection.onError(() => connection.close(1011, "Relay connection error"));
  }

  /**
   * Confirms the attaching peer holds the host's private key. The room token is
   * shared with every paired device, so without this a phone could attach as the
   * host, evict the computer, and sit in the middle of the room.
   */
  private verifyHostAttach(attach: RelayAttach, existing: RelayRoom | undefined): string {
    if (attach.proof === undefined) {
      if (this.#options.requireSignedHostAttach) throw attachRefused();
      if (existing !== undefined) return existing.hostPublicKeyPem;
      return "";
    }
    const now = Date.now();
    this.pruneAttachIds(now);
    if (this.#usedAttachIds.has(attach.proof.attachId)) throw attachRefused();
    try {
      verifyRelayHostAttach({ proof: attach.proof, hostId: attach.hostId, token: attach.token, now });
    } catch {
      throw attachRefused();
    }
    if (existing !== undefined && existing.hostPublicKeyPem !== "" && existing.hostPublicKeyPem !== attach.proof.hostPublicKeyPem) {
      throw attachRefused();
    }
    this.rememberAttachId(attach.proof.attachId, now);
    return attach.proof.hostPublicKeyPem;
  }

  /**
   * Returns the device ID the host actually issued a credential for, rather
   * than the one the client claimed. Without this any device holding the shared
   * room token could take a sibling's ID, evict it, and receive its traffic.
   */
  private verifyDeviceAttach(attach: RelayAttach, room: RelayRoom): string {
    if (attach.deviceProof === undefined) {
      if (this.#options.requireSignedDeviceAttach) throw attachRefused();
      if (attach.deviceId === undefined) throw attachRefused();
      return attach.deviceId;
    }
    if (room.hostPublicKeyPem === "") throw attachRefused();
    const now = Date.now();
    this.pruneAttachIds(now);
    if (this.#usedAttachIds.has(attach.deviceProof.attachId)) throw attachRefused();
    let verified;
    try {
      verified = verifyRelayDeviceAttach({
        proof: attach.deviceProof,
        hostId: room.hostId,
        hostPublicKeyPem: room.hostPublicKeyPem,
        token: attach.token,
        now,
      });
    } catch {
      throw attachRefused();
    }
    if (attach.deviceId !== undefined && attach.deviceId !== verified.deviceId) throw attachRefused();
    this.rememberAttachId(attach.deviceProof.attachId, now);
    return verified.deviceId;
  }

  private rememberAttachId(attachId: string, now: number): void {
    // Bounded so a flood of valid-looking attachments cannot grow this map.
    if (this.#usedAttachIds.size >= maxRememberedAttachIds) {
      const oldest = this.#usedAttachIds.keys().next();
      if (!oldest.done) this.#usedAttachIds.delete(oldest.value);
    }
    this.#usedAttachIds.set(attachId, now + RELAY_ATTACH_SKEW_MS * 2);
  }

  private pruneAttachIds(now: number): void {
    for (const [id, expiresAt] of this.#usedAttachIds) if (expiresAt <= now) this.#usedAttachIds.delete(id);
  }

  private attachHost(connection: WebSocketConnection, attach: RelayAttach): void {
    const existing = this.#rooms.get(attach.hostId);
    if (existing !== undefined && !equalToken(attach.token, existing.tokenHash)) throw new Error("Relay token does not match existing host room");
    const hostPublicKeyPem = this.verifyHostAttach(attach, existing);
    if (existing === undefined && this.#rooms.size >= this.#options.maxRooms) throw new Error("Relay is at room capacity");
    if (existing !== undefined) {
      const previousHost = existing.host;
      existing.host = connection;
      // WebSocket close callbacks may run synchronously. Publish the replacement
      // first so closing the superseded tunnel cannot announce a false outage to
      // every still-connected device.
      previousHost.close(1012, "Host tunnel replaced");
      // The host is the authority, so its latest list replaces whatever this
      // process happened to be holding.
      existing.revokedDeviceIds = new Set(attach.revokedDeviceIds ?? []);
      this.dropRevokedDevices(existing);
      connection.sendJson({ type: "relay.attached", role: "host", hostId: attach.hostId, devices: existing.devices.size, supports: RELAY_HOST_CAPABILITIES });
      this.bindHost(existing, connection);
      return;
    }
    const room: RelayRoom = {
      hostId: attach.hostId,
      tokenHash: digest(attach.token),
      hostPublicKeyPem,
      host: connection,
      devices: new Map(),
      revokedDeviceIds: new Set(attach.revokedDeviceIds ?? []),
    };
    this.#rooms.set(attach.hostId, room);
    connection.sendJson({ type: "relay.attached", role: "host", hostId: attach.hostId, devices: 0, supports: RELAY_HOST_CAPABILITIES });
    this.bindHost(room, connection);
  }

  /** Closes any live tunnel whose device the host has revoked. */
  private dropRevokedDevices(room: RelayRoom): void {
    for (const deviceId of room.revokedDeviceIds) {
      const device = room.devices.get(deviceId);
      if (device === undefined) continue;
      room.devices.delete(deviceId);
      if (!device.isClosed) device.close(1008, "Device access revoked");
    }
  }

  private bindHost(room: RelayRoom, connection: WebSocketConnection): void {
    connection.onMessage((text) => {
      this.charge(connection, text);
      const revoke = parseRevoke(text);
      if (revoke !== null) {
        if (room.revokedDeviceIds.size < maxRevokedDeviceIds) room.revokedDeviceIds.add(revoke.deviceId);
        this.dropRevokedDevices(room);
        return;
      }
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
    if (room === undefined || room.host.isClosed) throw attachRefused();
    if (!equalToken(attach.token, room.tokenHash)) throw attachRefused();
    const deviceId = this.verifyDeviceAttach(attach, room);
    // Holding the shared room token is no longer enough once the host has
    // revoked this device.
    if (room.revokedDeviceIds.has(deviceId)) throw attachRefused();
    if (!room.devices.has(deviceId) && room.devices.size >= this.#options.maxDevicesPerRoom) throw new Error("Relay room is at device capacity");
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

  private admitConnectionRate(address: string): boolean {
    const now = Date.now();
    let state = this.#connectionRates.get(address);
    if (state === undefined || now - state.startedAt >= 60_000) {
      state = { startedAt: now, messages: 0, bytes: 0 };
      this.#connectionRates.set(address, state);
    }
    state.messages += 1;
    return state.messages <= this.#options.maxConnectionsPerAddressPerMinute;
  }

  private charge(connection: WebSocketConnection, text: string): void {
    const now = Date.now();
    const bytes = Buffer.byteLength(text, "utf8");
    const address = this.#addresses.get(connection);
    // Charged twice on purpose: per connection, and per address so opening more
    // sockets buys no extra allowance.
    const budgets: RateState[] = [];
    let state = this.#rates.get(connection);
    if (state === undefined || now - state.startedAt >= 60_000) {
      state = { startedAt: now, messages: 0, bytes: 0 };
      this.#rates.set(connection, state);
    }
    budgets.push(state);
    if (address !== undefined) {
      let shared = this.#addressRates.get(address);
      if (shared === undefined || now - shared.startedAt >= 60_000) {
        shared = { startedAt: now, messages: 0, bytes: 0 };
        this.#addressRates.set(address, shared);
      }
      budgets.push(shared);
    }
    const addressAllowance = this.#options.maxConnectionsPerAddress;
    for (const [index, budget] of budgets.entries()) {
      budget.messages += 1;
      budget.bytes += bytes;
      const scale = index === 0 ? 1 : addressAllowance;
      if (budget.messages > this.#options.maxMessagesPerMinute * scale || budget.bytes > this.#options.maxBytesPerMinute * scale) {
        connection.close(1008, "Relay rate limit exceeded");
        throw new Error("Relay rate limit exceeded");
      }
    }
  }

  private heartbeat(): void {
    const now = Date.now();
    this.pruneAttachIds(now);
    for (const [address, state] of this.#addressRates) if (now - state.startedAt >= 120_000) this.#addressRates.delete(address);
    for (const [address, state] of this.#connectionRates) if (now - state.startedAt >= 120_000) this.#connectionRates.delete(address);
    const cutoff = now - this.#options.heartbeatTimeoutMs;
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
