import assert from "node:assert/strict";
import test from "node:test";
import {
  PairingManager,
  createDeviceIdentity,
  createHostIdentity,
  signRelayDeviceAttach,
  signRelayHostAttach,
  type DeviceIdentity,
  type HostIdentity,
  type SignedCredential,
} from "../../../packages/protocol/src/index.js";
import { RelayServer, clientAddress, type RelayServerOptions } from "./relay.js";

const TOKEN = "relay-hardening-token".padEnd(43, "x");

interface Peer {
  readonly socket: WebSocket;
  readonly messages: unknown[];
  closeCode(): number | null;
  closed(): boolean;
  send(value: unknown): void;
}

async function connect(url: string): Promise<Peer> {
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  let code: number | null = null;
  socket.addEventListener("message", (event) => {
    try { messages.push(JSON.parse(String(event.data)) as unknown); } catch { messages.push(String(event.data)); }
  });
  socket.addEventListener("close", (event) => { code = event.code; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to the relay")), 2_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Relay connection failed")); }, { once: true });
  });
  return {
    socket,
    messages,
    closeCode: () => code,
    closed: () => code !== null,
    send: (value: unknown) => socket.send(JSON.stringify(value)),
  };
}

function hostAttach(identity: HostIdentity, hostId: string, token = TOKEN) {
  return {
    type: "relay.attach",
    role: "host",
    hostId,
    token,
    proof: signRelayHostAttach({
      hostId,
      token,
      hostPublicKeyPem: identity.publicKeyPem,
      hostPrivateKeyPem: identity.privateKeyPem,
    }),
  };
}

async function startRelay(context: { after: (fn: () => Promise<void> | void) => void }, options: Partial<RelayServerOptions> = {}) {
  const relay = new RelayServer({ host: "127.0.0.1", heartbeatIntervalMs: 60_000, ...options, port: 0 });
  await relay.listen();
  const address = relay.address();
  assert.ok(address !== null && typeof address === "object");
  context.after(async () => { await relay.close(); });
  return { relay, url: `ws://127.0.0.1:${address.port}/relay` };
}

async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("a paired device holding the room token cannot claim the host role", async (context) => {
  const identity = createHostIdentity();
  const { relay, url } = await startRelay(context);
  const host = await connect(url);
  host.send(hostAttach(identity, "host_takeover"));
  await settle();
  assert.equal(relay.roomCount(), 1);

  // The attacker is a legitimately paired device: it has the shared room token
  // and the host's public key, but not the host's private key.
  const attacker = await connect(url);
  attacker.send({ type: "relay.attach", role: "host", hostId: "host_takeover", token: TOKEN });
  await settle();
  assert.equal(attacker.closed(), true, "an unsigned host attachment must be refused");
  assert.equal(host.closed(), false, "the real computer must keep its tunnel");
  assert.equal(relay.roomCount(), 1);
});

test("a forged or foreign host key cannot take over an existing room", async (context) => {
  const identity = createHostIdentity();
  const { relay, url } = await startRelay(context);
  const host = await connect(url);
  host.send(hostAttach(identity, "host_pinned"));
  await settle();

  const impostor = await connect(url);
  impostor.send(hostAttach(createHostIdentity(), "host_pinned"));
  await settle();
  assert.equal(impostor.closed(), true, "a different key must not match the pinned room");
  assert.equal(host.closed(), false);
  assert.equal(relay.roomCount(), 1);
});

test("a captured host attachment cannot be replayed", async (context) => {
  const identity = createHostIdentity();
  const { url } = await startRelay(context);
  const attach = hostAttach(identity, "host_replay");
  const host = await connect(url);
  host.send(attach);
  await settle();
  assert.equal(host.closed(), false);

  const replay = await connect(url);
  replay.send(attach);
  await settle();
  assert.equal(replay.closed(), true, "a reused attachment ID must be refused");
});

test("a stale host attachment is refused", async (context) => {
  const identity = createHostIdentity();
  const { url } = await startRelay(context);
  const hostId = "host_stale";
  const peer = await connect(url);
  peer.send({
    type: "relay.attach",
    role: "host",
    hostId,
    token: TOKEN,
    proof: signRelayHostAttach({
      hostId,
      token: TOKEN,
      hostPublicKeyPem: identity.publicKeyPem,
      hostPrivateKeyPem: identity.privateKeyPem,
      issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }),
  });
  await settle();
  assert.equal(peer.closed(), true, "an attachment signed long ago must be refused");
});

test("an attachment signed for one room cannot be moved to another token", async (context) => {
  const identity = createHostIdentity();
  const { url } = await startRelay(context);
  const hostId = "host_token_bound";
  const peer = await connect(url);
  // Signed against the real token, presented alongside the attacker's own.
  peer.send({
    type: "relay.attach",
    role: "host",
    hostId,
    token: "attacker-supplied-token".padEnd(43, "y"),
    proof: signRelayHostAttach({
      hostId,
      token: TOKEN,
      hostPublicKeyPem: identity.publicKeyPem,
      hostPrivateKeyPem: identity.privateKeyPem,
    }),
  });
  await settle();
  assert.equal(peer.closed(), true, "the signature must be bound to the room token");
});

test("one address cannot exhaust the connection pool", async (context) => {
  const { url } = await startRelay(context, { maxConnectionsPerAddress: 3 });
  const peers: Peer[] = [];
  for (let index = 0; index < 3; index += 1) peers.push(await connect(url));
  await settle(80);
  for (const peer of peers) assert.equal(peer.closed(), false);

  const refused = await connect(url);
  await settle(80);
  assert.equal(refused.closed(), true, "the limit must refuse the extra socket");
  assert.equal(refused.closeCode(), 1013);

  // Closing one frees a slot again, so a limit never becomes permanent.
  peers[0]!.socket.close();
  await settle(120);
  const readmitted = await connect(url);
  await settle(80);
  assert.equal(readmitted.closed(), false, "a released slot must be reusable");
});

test("rooms and devices are bounded", async (context) => {
  const roomA = pairedRoom("host_a");
  const { relay, url } = await startRelay(context, { maxRooms: 2, maxDevicesPerRoom: 2, maxConnectionsPerAddress: 64 });
  for (const room of [roomA, pairedRoom("host_b")]) {
    const peer = await connect(url);
    peer.send(hostAttach(room.identity, room.hostId));
    await settle(60);
  }
  assert.equal(relay.roomCount(), 2);

  const overflowRoom = await connect(url);
  overflowRoom.send(hostAttach(createHostIdentity(), "host_c"));
  await settle(80);
  assert.equal(overflowRoom.closed(), true, "a third room must be refused");
  assert.equal(relay.roomCount(), 2);

  for (const deviceId of ["device_1", "device_2"]) {
    const peer = await connect(url);
    peer.send(deviceAttach(roomA.hostId, deviceId, roomA.pair(deviceId)));
    await settle(60);
  }
  assert.equal(relay.deviceCount("host_a"), 2);
  const overflowDevice = await connect(url);
  overflowDevice.send(deviceAttach(roomA.hostId, "device_3", roomA.pair("device_3")));
  await settle(80);
  assert.equal(overflowDevice.closed(), true, "a third device must be refused");
  assert.equal(relay.deviceCount("host_a"), 2);
});

test("the real host can reattach with a fresh signature", async (context) => {
  const identity = createHostIdentity();
  const { relay, url } = await startRelay(context);
  const first = await connect(url);
  first.send(hostAttach(identity, "host_reattach"));
  await settle();
  const device = await connect(url);
  const pairing = new PairingManager("host_reattach", identity);
  const deviceIdentity = createDeviceIdentity("reattach_device");
  const challenge = pairing.startPairing();
  const credential = pairing.confirmPairing({
    pairingId: challenge.pairingId,
    secret: challenge.secret,
    shortCode: challenge.shortCode,
    deviceId: deviceIdentity.deviceId,
    devicePublicKeyPem: deviceIdentity.publicKeyPem,
  });
  device.send(deviceAttach("host_reattach", deviceIdentity.deviceId, { identity: deviceIdentity, credential }));
  await settle();
  device.messages.length = 0;
  const second = await connect(url);
  second.send(hostAttach(identity, "host_reattach"));
  await settle();
  assert.equal(second.closed(), false, "the owner must be able to replace its own tunnel");
  assert.equal(device.closed(), false, "devices must stay connected across host replacement");
  assert.equal(
    device.messages.some((message) => (message as { type?: unknown }).type === "relay.host_offline"),
    false,
    "replacing a live host must not announce a false outage",
  );
  assert.equal(relay.roomCount(), 1);
});

/** A host with two genuinely paired devices, as the product would produce. */
function pairedRoom(hostId: string) {
  const identity = createHostIdentity();
  const manager = new PairingManager(hostId, identity);
  const pair = (deviceId: string): { identity: DeviceIdentity; credential: SignedCredential } => {
    const device = createDeviceIdentity(deviceId);
    const pairing = manager.startPairing();
    const credential = manager.confirmPairing({
      pairingId: pairing.pairingId,
      secret: pairing.secret,
      shortCode: pairing.shortCode,
      deviceId,
      devicePublicKeyPem: device.publicKeyPem,
    });
    return { identity: device, credential };
  };
  return { hostId, identity, pair };
}

function deviceAttach(hostId: string, deviceId: string, device: { identity: DeviceIdentity; credential: SignedCredential }, token = TOKEN) {
  return {
    type: "relay.attach",
    role: "device",
    hostId,
    token,
    deviceId,
    proof: signRelayDeviceAttach({
      hostId,
      deviceId: device.identity.deviceId,
      token,
      credential: device.credential,
      devicePrivateKeyPem: device.identity.privateKeyPem,
    }),
  };
}

test("one paired device cannot take over another device's tunnel", async (context) => {
  const room = pairedRoom("host_device_identity");
  const { relay, url } = await startRelay(context, { maxConnectionsPerAddress: 64 });
  const host = await connect(url);
  host.send(hostAttach(room.identity, room.hostId));
  await settle();

  const victim = room.pair("device_victim");
  const attacker = room.pair("device_attacker");

  const victimPeer = await connect(url);
  victimPeer.send(deviceAttach(room.hostId, "device_victim", victim));
  await settle();
  assert.equal(relay.deviceCount(room.hostId), 1);
  assert.equal(victimPeer.closed(), false);

  // The attacker is genuinely paired: it holds the room token and its own valid
  // credential, and it claims the victim's device ID.
  const impersonation = await connect(url);
  impersonation.send({
    ...deviceAttach(room.hostId, "device_victim", attacker),
    deviceId: "device_victim",
  });
  await settle();
  assert.equal(impersonation.closed(), true, "a claimed device ID must match the credential");
  assert.equal(victimPeer.closed(), false, "the real device must keep its tunnel");
  assert.equal(relay.deviceCount(room.hostId), 1);

  // Attaching honestly under its own identity still works.
  const honest = await connect(url);
  honest.send(deviceAttach(room.hostId, "device_attacker", attacker));
  await settle();
  assert.equal(honest.closed(), false);
  assert.equal(relay.deviceCount(room.hostId), 2);
});

test("a device credential from another computer is refused", async (context) => {
  const room = pairedRoom("host_foreign_credential");
  const foreign = pairedRoom("host_foreign_credential");
  const { relay, url } = await startRelay(context, { maxConnectionsPerAddress: 64 });
  const host = await connect(url);
  host.send(hostAttach(room.identity, room.hostId));
  await settle();

  // Signed by a different computer, so it does not verify against the pinned key.
  const outsider = foreign.pair("device_outsider");
  const peer = await connect(url);
  peer.send(deviceAttach(room.hostId, "device_outsider", outsider));
  await settle();
  assert.equal(peer.closed(), true);
  assert.equal(relay.deviceCount(room.hostId), 0);
});

test("an unsigned device attachment is refused and a replayed one cannot be reused", async (context) => {
  const room = pairedRoom("host_device_replay");
  const { relay, url } = await startRelay(context, { maxConnectionsPerAddress: 64 });
  const host = await connect(url);
  host.send(hostAttach(room.identity, room.hostId));
  await settle();
  const device = room.pair("device_replay");

  const unsigned = await connect(url);
  unsigned.send({ type: "relay.attach", role: "device", hostId: room.hostId, token: TOKEN, deviceId: "device_replay" });
  await settle();
  assert.equal(unsigned.closed(), true, "a token alone must not attach a device");
  assert.equal(relay.deviceCount(room.hostId), 0);

  const attach = deviceAttach(room.hostId, "device_replay", device);
  const first = await connect(url);
  first.send(attach);
  await settle();
  assert.equal(first.closed(), false);

  const replay = await connect(url);
  replay.send(attach);
  await settle();
  assert.equal(replay.closed(), true, "a captured device attachment must not be reusable");
});

test("every refusal reads the same, so tokens and rooms cannot be probed", async (context) => {
  const room = pairedRoom("host_uniform_errors");
  const { url } = await startRelay(context, { maxConnectionsPerAddress: 64 });
  const host = await connect(url);
  host.send(hostAttach(room.identity, room.hostId));
  await settle();

  const reasons: string[] = [];
  for (const attach of [
    { type: "relay.attach", role: "device", hostId: "host_does_not_exist", token: TOKEN, deviceId: "d" },
    { type: "relay.attach", role: "device", hostId: room.hostId, token: "wrong-token".padEnd(43, "z"), deviceId: "d" },
    { type: "relay.attach", role: "device", hostId: room.hostId, token: TOKEN, deviceId: "d" },
  ]) {
    const peer = await connect(url);
    const reason = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("(none)"), 1_500);
      peer.socket.addEventListener("close", (event) => { clearTimeout(timer); resolve(event.reason); }, { once: true });
      peer.send(attach);
    });
    reasons.push(reason);
  }
  assert.equal(new Set(reasons).size, 1, `refusals must not distinguish causes: ${reasons.join(" | ")}`);
});

test("an oversized unauthenticated attachment is refused before it is trusted", async (context) => {
  const { url } = await startRelay(context, { maxAttachBytes: 512 });
  const peer = await connect(url);
  peer.send({ type: "relay.attach", role: "device", hostId: "host_big", token: TOKEN, deviceId: "d", padding: "p".repeat(4_000) });
  await settle();
  assert.equal(peer.closed(), true);
});

test("connection churn from one address is bounded", async (context) => {
  const { url } = await startRelay(context, { maxConnectionsPerAddressPerMinute: 3, maxConnectionsPerAddress: 64 });
  for (let index = 0; index < 3; index += 1) {
    const peer = await connect(url);
    peer.socket.close();
    await settle(40);
  }
  const refused = await connect(url);
  await settle(80);
  assert.equal(refused.closed(), true, "repeated reconnects must be rate limited, not just concurrent holds");
});

test("forwarded client addresses are only believed from a trusted proxy", () => {
  const trusted = new Set(["loopback"]);
  // Behind the relay's own proxy: the right-most hop is what the proxy observed.
  assert.equal(clientAddress("127.0.0.1", "9.9.9.9, 203.0.113.7", trusted), "203.0.113.7");
  assert.equal(clientAddress("::1", "203.0.113.7", trusted), "203.0.113.7");
  // Directly exposed: a client-supplied header must never move the limit.
  assert.equal(clientAddress("198.51.100.4", "203.0.113.7", trusted), "198.51.100.4");
  assert.equal(clientAddress("127.0.0.1", undefined, trusted), "127.0.0.1");
  assert.equal(clientAddress(undefined, "203.0.113.7", new Set()), "unknown");
});
