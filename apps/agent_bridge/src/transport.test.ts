import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  CURRENT_PROTOCOL_VERSION,
  SecureChannel,
  acceptSecureHandshake,
  createDeviceIdentity,
  createHostIdentity,
  parseSecureFrame,
  parseSecureHandshakeOffer,
  signDeviceAction,
  signRelayDeviceAttach,
  type JsonObject,
  type RequestEnvelope,
  type SignedCredential,
} from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { RelayServer } from "../../../services/relay/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { BridgeMessageSession, BridgeRelayClient, BridgeSocketServer } from "./transport.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class MessageInbox {
  readonly #values: unknown[] = [];
  readonly #waiters: Array<{ readonly predicate: (value: unknown) => boolean; readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: NodeJS.Timeout }> = [];

  public constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const text = String(event.data);
      let value: unknown;
      try { value = JSON.parse(text) as unknown; } catch { value = text; }
      const index = this.#waiters.findIndex((waiter) => waiter.predicate(value));
      if (index >= 0) {
        const waiter = this.#waiters.splice(index, 1)[0];
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        }
      } else {
        this.#values.push(value);
      }
    });
  }

  public async nextWhere(predicate: (value: unknown) => boolean, timeoutMs = 2_000): Promise<unknown> {
    const index = this.#values.findIndex(predicate);
    if (index >= 0) return this.#values.splice(index, 1)[0];
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
        reject(new Error("Timed out waiting for bridge WebSocket message"));
      }, timeoutMs);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }
}

function isEventBatch(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.kind === "event" && value.type === "event.batch";
}

function hasEventType(value: unknown, type: string): boolean {
  return isEventBatch(value)
    && isRecord(value.payload)
    && Array.isArray(value.payload.events)
    && value.payload.events.some((event: unknown) => isRecord(event) && event.type === type);
}

async function expectNoEventBatch(inbox: MessageInbox, timeoutMs: number): Promise<void> {
  await assert.rejects(inbox.nextWhere(isEventBatch, timeoutMs), /Timed out waiting for bridge WebSocket message/u);
}

function request(hostId: string, type: string, requestId: string, payload: JsonObject): RequestEnvelope {
  return {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: randomUUID(),
    hostId,
    sentAt: new Date().toISOString(),
    kind: "request",
    type,
    requestId,
    payload,
  };
}

async function connect(url: string): Promise<{ readonly socket: WebSocket; readonly inbox: MessageInbox }> {
  const socket = new WebSocket(url);
  const inbox = new MessageInbox(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to bridge")), 2_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Bridge connection failed")); }, { once: true });
  });
  return { socket, inbox };
}

async function connectSecure(
  url: string,
  config: Pick<BridgeConfig, "hostId" | "identity">,
  device: ReturnType<typeof createDeviceIdentity>,
  credential: SignedCredential,
): Promise<{ readonly socket: WebSocket; readonly inbox: MessageInbox }> {
  const connection = await connect(url);
  const hello = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "hello");
  assert.ok(isRecord(hello));
  const offer = parseSecureHandshakeOffer(hello.encryption);
  assert.ok(offer !== null);
  const handshake = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  const phone = new SecureChannel(handshake.keys, "device");
  connection.socket.send(JSON.stringify(handshake.accept));
  const confirmationWire = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "secure");
  const confirmationFrame = parseSecureFrame(confirmationWire);
  assert.ok(confirmationFrame !== null);
  const confirmation = JSON.parse(phone.open(confirmationFrame)) as unknown;
  assert.ok(isRecord(confirmation) && confirmation.kind === "secure_established");
  return connection;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("relay client retries when the relay is unavailable during initial startup", async (context) => {
  const probe = new BridgeSocketServer(new AgentBridge({
    version: 1,
    hostId: "host_relay_port_probe",
    displayName: "Relay port probe",
    identity: createHostIdentity(),
    enabledProviders: [],
  }, []), { host: "127.0.0.1", port: 0 });
  await probe.listen();
  const probeAddress = probe.address();
  assert.ok(probeAddress !== null && typeof probeAddress === "object");
  const port = probeAddress.port;
  await probe.close();

  const config: BridgeConfig = {
    version: 1,
    hostId: "host_initial_relay_retry",
    displayName: "Initial relay retry host",
    identity: createHostIdentity(),
    enabledProviders: [],
  };
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const relayClient = new BridgeRelayClient(bridge, {
    url: `ws://127.0.0.1:${port}/relay`,
    token: "initial-relay-retry-token".padEnd(43, "x"),
  });
  const relay = new RelayServer({ host: "127.0.0.1", port, heartbeatIntervalMs: 60_000 });
  context.after(async () => {
    await relayClient.dispose();
    await relay.close();
    await bridge.dispose();
  });

  await assert.rejects(relayClient.start(), /Unable to connect to relay/u);
  await relay.listen();
  await waitFor(() => bridge.host().relayConnected, "the initial relay retry to attach");
  assert.equal(relay.roomCount(), 1);
});

test("direct bridge transport gates event replay until a signed request is verified", async (context) => {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_transport_test",
    displayName: "Transport test host",
    identity: createHostIdentity(),
    enabledProviders: ["fake"],
  };
  const bridge = new AgentBridge(config, [new FakeProviderAdapter({ hostId: config.hostId, sessionCount: 3 })]);
  await bridge.start();
  const pairing = bridge.startPairing();
  const server = new BridgeSocketServer(bridge, {
    host: "127.0.0.1",
    port: 0,
    heartbeatIntervalMs: 60_000,
  });
  await server.listen();
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const connection = await connect(`ws://127.0.0.1:${address.port}/bridge`);
  context.after(async () => {
    connection.socket.close();
    await server.close();
    await bridge.dispose();
  });

  const hello = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "hello");
  assert.ok(isRecord(hello));
  assert.equal(hello.hostId, config.hostId);
  await expectNoEventBatch(connection.inbox, 100);

  const device = createDeviceIdentity("device_transport_test");
  const pairRequest = request(config.hostId, "pairing.confirm", "request_pair", {
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  connection.socket.send(JSON.stringify(pairRequest));
  const pairResponse = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "response" && value.requestId === "request_pair");
  assert.ok(isRecord(pairResponse) && pairResponse.ok === true && isRecord(pairResponse.payload));
  const credential: SignedCredential = {
    payload: String(pairResponse.payload.payload),
    signature: String(pairResponse.payload.signature),
  };

  await expectNoEventBatch(connection.inbox, 350);

  const rejectedRequest = request(config.hostId, "host.get", "request_rejected", {});
  const rejectedAction = signDeviceAction({
    credential,
    action: JSON.parse(JSON.stringify(rejectedRequest)) as JsonObject,
    devicePrivateKeyPem: device.privateKeyPem,
    actionId: "action_rejected",
  });
  const invalidSignature = `${rejectedAction.signature.startsWith("A") ? "B" : "A"}${rejectedAction.signature.slice(1)}`;
  connection.socket.send(JSON.stringify({ kind: "signed_action", signed: { ...rejectedAction, signature: invalidSignature } }));
  const signatureError = await connection.inbox.nextWhere((value) => isRecord(value) && value.type === "transport.error");
  assert.ok(isRecord(signatureError));
  assert.match(String(signatureError.message), /signature/u);
  await expectNoEventBatch(connection.inbox, 350);

  const hostRequest = request(config.hostId, "host.get", "request_host", {});
  const signed = signDeviceAction({
    credential,
    action: JSON.parse(JSON.stringify(hostRequest)) as JsonObject,
    devicePrivateKeyPem: device.privateKeyPem,
    actionId: "action_transport_test",
  });
  const wireMessage = JSON.stringify({ kind: "signed_action", signed });
  connection.socket.send(wireMessage);
  const hostResponse = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "response" && value.requestId === "request_host");
  assert.ok(isRecord(hostResponse) && hostResponse.ok === true && isRecord(hostResponse.payload) && isRecord(hostResponse.payload.host));
  assert.equal(hostResponse.payload.host.id, config.hostId);
  const replayedEvents = await connection.inbox.nextWhere(isEventBatch);
  assert.ok(isEventBatch(replayedEvents));

  bridge.setRelayConnected(true);
  const liveEvents = await connection.inbox.nextWhere((value) => hasEventType(value, "host.connected"));
  assert.ok(hasEventType(liveEvents, "host.connected"));

  connection.socket.send(wireMessage);
  const replayError = await connection.inbox.nextWhere((value) => isRecord(value) && value.type === "transport.error");
  assert.ok(isRecord(replayError));
  assert.match(String(replayError.message), /already been used/u);

  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json() as unknown;
  assert.ok(isRecord(healthPayload));
  assert.deepEqual(healthPayload, { ok: true });
});

test("direct bridge presence tracks authenticated devices without overlap flapping", async (context) => {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_direct_presence",
    displayName: "Direct presence host",
    identity: createHostIdentity(),
    enabledProviders: [],
  };
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const device = createDeviceIdentity("device_direct_presence");
  const pairing = bridge.startPairing();
  const credential = bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  const credentialId = bridge.pairedDevices()[0]!.credentialId;
  const server = new BridgeSocketServer(bridge, { host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await server.listen();
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  const presenceSnapshots: string[][] = [];
  const stopWatchingPresence = server.onConnectedDevicesChanged(() => {
    presenceSnapshots.push([...server.connectedDeviceIds()]);
  });
  const sockets: WebSocket[] = [];
  context.after(async () => {
    stopWatchingPresence();
    for (const socket of sockets) socket.close();
    await server.close();
    await bridge.dispose();
  });

  assert.equal(bridge.pairedDevices().length, 1);
  assert.deepEqual(server.connectedDeviceIds(), []);

  const unauthenticated = await connect(url);
  sockets.push(unauthenticated.socket);
  await unauthenticated.inbox.nextWhere((value) => isRecord(value) && value.kind === "hello");
  unauthenticated.socket.send(JSON.stringify({ kind: "hello", role: "device", deviceId: device.deviceId }));
  unauthenticated.socket.send(JSON.stringify(request(config.hostId, "host.get", "request_unauthenticated_presence", {})));
  await unauthenticated.inbox.nextWhere((value) => isRecord(value) && value.type === "transport.error");
  assert.deepEqual(server.connectedDeviceIds(), []);
  assert.deepEqual(presenceSnapshots, []);
  unauthenticated.socket.close();

  const first = await connectSecure(url, config, device, credential);
  sockets.push(first.socket);
  assert.deepEqual(server.connectedDeviceIds(), [device.deviceId]);
  assert.deepEqual(presenceSnapshots, [[device.deviceId]]);

  const second = await connectSecure(url, config, device, credential);
  sockets.push(second.socket);
  assert.deepEqual(server.connectedDeviceIds(), [device.deviceId]);
  assert.deepEqual(presenceSnapshots, [[device.deviceId]], "a second socket for one phone must not change presence");

  first.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(server.connectedDeviceIds(), [device.deviceId]);
  assert.deepEqual(presenceSnapshots, [[device.deviceId]], "closing one overlapping socket must keep the phone online");

  second.socket.close();
  await waitFor(() => server.connectedDeviceIds().length === 0, "the final direct socket to disconnect");
  assert.deepEqual(presenceSnapshots, [[device.deviceId], []]);

  const replacement = await connectSecure(url, config, device, credential);
  sockets.push(replacement.socket);
  assert.deepEqual(server.connectedDeviceIds(), [device.deviceId]);
  const replacementClosed = new Promise<number>((resolve) => {
    replacement.socket.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
  assert.equal(bridge.revokeDevice(credentialId), true);
  await waitFor(() => server.connectedDeviceIds().length === 0, "revocation to clear direct presence");
  assert.equal(await replacementClosed, 1008);
  assert.deepEqual(presenceSnapshots, [[device.deviceId], [], [device.deviceId], []]);
});

test("direct post-handshake errors stay encrypted and correlate the decoded request", async (context) => {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_secure_error",
    displayName: "Secure error host",
    identity: createHostIdentity(),
    enabledProviders: [],
  };
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const device = createDeviceIdentity("device_secure_error");
  const pairing = bridge.startPairing();
  const credential = bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  const server = new BridgeSocketServer(bridge, { host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await server.listen();
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const connection = await connect(`ws://127.0.0.1:${address.port}/bridge`);
  context.after(async () => {
    connection.socket.close();
    await server.close();
    await bridge.dispose();
  });

  const hello = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "hello");
  assert.ok(isRecord(hello));
  const offer = parseSecureHandshakeOffer(hello.encryption);
  assert.ok(offer !== null);
  const handshake = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  const phone = new SecureChannel(handshake.keys, "device");
  connection.socket.send(JSON.stringify(handshake.accept));
  const confirmationWire = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "secure");
  const confirmationFrame = parseSecureFrame(confirmationWire);
  assert.ok(confirmationFrame !== null);
  const confirmation = JSON.parse(phone.open(confirmationFrame)) as unknown;
  assert.ok(isRecord(confirmation) && confirmation.kind === "secure_established");

  const rejectedRequest = request(config.hostId, "host.get", "request_secure_rejected", {});
  const signed = signDeviceAction({
    credential,
    action: JSON.parse(JSON.stringify(rejectedRequest)) as JsonObject,
    devicePrivateKeyPem: device.privateKeyPem,
  });
  const invalidSignature = `${signed.signature.startsWith("A") ? "B" : "A"}${signed.signature.slice(1)}`;
  const rejectedFrame = phone.seal(JSON.stringify({
    kind: "signed_action",
    signed: { ...signed, signature: invalidSignature },
  }));
  connection.socket.send(JSON.stringify(rejectedFrame));

  const errorWire = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "secure");
  assert.equal(JSON.stringify(errorWire).includes("request_secure_rejected"), false);
  assert.equal(JSON.stringify(errorWire).includes("transport.error"), false);
  const errorFrame = parseSecureFrame(errorWire);
  assert.ok(errorFrame !== null);
  const transportError = JSON.parse(phone.open(errorFrame)) as unknown;
  assert.ok(isRecord(transportError));
  assert.equal(transportError.type, "transport.error");
  assert.equal(transportError.requestId, rejectedRequest.requestId);
  assert.match(String(transportError.message), /signature/u);

  connection.socket.send(JSON.stringify(phone.seal("not json")));
  const uncorrelatedWire = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "secure");
  const uncorrelatedFrame = parseSecureFrame(uncorrelatedWire);
  assert.ok(uncorrelatedFrame !== null);
  const uncorrelatedError = JSON.parse(phone.open(uncorrelatedFrame)) as unknown;
  assert.ok(isRecord(uncorrelatedError));
  assert.equal(uncorrelatedError.type, "transport.error");
  assert.equal("requestId" in uncorrelatedError, false);
});

test("direct self-revoke is acknowledged before the phone connection closes", async (context) => {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_secure_self_revoke",
    displayName: "Secure self-revoke host",
    identity: createHostIdentity(),
    enabledProviders: [],
  };
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const device = createDeviceIdentity("device_secure_self_revoke");
  const pairing = bridge.startPairing();
  const credential = bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  const credentialId = bridge.pairedDevices()[0]!.credentialId;
  const server = new BridgeSocketServer(bridge, { host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await server.listen();
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const connection = await connect(`ws://127.0.0.1:${address.port}/bridge`);
  context.after(async () => {
    connection.socket.close();
    await server.close();
    await bridge.dispose();
  });

  const hello = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "hello");
  assert.ok(isRecord(hello));
  const offer = parseSecureHandshakeOffer(hello.encryption);
  assert.ok(offer !== null);
  const handshake = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  const phone = new SecureChannel(handshake.keys, "device");
  connection.socket.send(JSON.stringify(handshake.accept));
  const confirmationWire = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "secure");
  const confirmationFrame = parseSecureFrame(confirmationWire);
  assert.ok(confirmationFrame !== null);
  const confirmation = JSON.parse(phone.open(confirmationFrame)) as unknown;
  assert.ok(isRecord(confirmation) && confirmation.kind === "secure_established");

  const closed = new Promise<number>((resolve) => {
    connection.socket.addEventListener("close", (event) => resolve(event.code), { once: true });
  });
  const revokeRequest = request(config.hostId, "device.revoke", "request_secure_self_revoke", { credentialId });
  const signed = signDeviceAction({
    credential,
    action: JSON.parse(JSON.stringify(revokeRequest)) as JsonObject,
    devicePrivateKeyPem: device.privateKeyPem,
  });
  connection.socket.send(JSON.stringify(phone.seal(JSON.stringify({ kind: "signed_action", signed }))));

  const responseWire = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "secure");
  const responseFrame = parseSecureFrame(responseWire);
  assert.ok(responseFrame !== null, "the phone must receive its encrypted acknowledgement");
  const response = JSON.parse(phone.open(responseFrame)) as unknown;
  assert.ok(isRecord(response));
  assert.equal(response.requestId, revokeRequest.requestId);
  assert.equal(response.ok, true);
  assert.deepEqual(response.payload, { revoked: true });
  assert.deepEqual(bridge.pairedDevices(), []);
  assert.equal(await closed, 1008);
});

test("relay post-handshake errors stay encrypted and correlated", async (context) => {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_relay_secure_error",
    displayName: "Relay secure error host",
    identity: createHostIdentity(),
    enabledProviders: [],
  };
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const device = createDeviceIdentity("device_relay_secure_error");
  const pairing = bridge.startPairing();
  const credential = bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  const relay = new RelayServer({ host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await relay.listen();
  const relayAddress = relay.address();
  assert.ok(relayAddress !== null && typeof relayAddress === "object");
  const relayUrl = `ws://127.0.0.1:${relayAddress.port}/relay`;
  const relayToken = "relay-secure-error-token".padEnd(43, "x");
  const relayClient = new BridgeRelayClient(bridge, { url: relayUrl, token: relayToken, reconnect: false });
  await relayClient.start();
  await waitFor(() => bridge.host().relayConnected, "the secure relay host to attach");
  const connection = await connect(relayUrl);
  context.after(async () => {
    connection.socket.close();
    await relayClient.dispose();
    await relay.close();
    await bridge.dispose();
  });

  connection.socket.send(JSON.stringify({
    type: "relay.attach",
    role: "device",
    hostId: config.hostId,
    token: relayToken,
    deviceId: device.deviceId,
    proof: signRelayDeviceAttach({
      hostId: config.hostId,
      deviceId: device.deviceId,
      token: relayToken,
      credential,
      devicePrivateKeyPem: device.privateKeyPem,
    }),
  }));
  await connection.inbox.nextWhere((value) => isRecord(value) && value.type === "relay.attached");
  connection.socket.send(JSON.stringify({ kind: "hello", role: "device", deviceId: device.deviceId }));
  const hello = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "hello");
  assert.ok(isRecord(hello));
  const offer = parseSecureHandshakeOffer(hello.encryption);
  assert.ok(offer !== null);
  const handshake = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  const phone = new SecureChannel(handshake.keys, "device");
  connection.socket.send(JSON.stringify(handshake.accept));
  const confirmationWire = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "secure");
  const confirmationFrame = parseSecureFrame(confirmationWire);
  assert.ok(confirmationFrame !== null);
  const confirmation = JSON.parse(phone.open(confirmationFrame)) as unknown;
  assert.ok(isRecord(confirmation) && confirmation.kind === "secure_established");

  const rejectedRequest = request(config.hostId, "host.get", "request_relay_secure_rejected", {});
  const signed = signDeviceAction({
    credential,
    action: JSON.parse(JSON.stringify(rejectedRequest)) as JsonObject,
    devicePrivateKeyPem: device.privateKeyPem,
  });
  const invalidSignature = `${signed.signature.startsWith("A") ? "B" : "A"}${signed.signature.slice(1)}`;
  connection.socket.send(JSON.stringify(phone.seal(JSON.stringify({
    kind: "signed_action",
    signed: { ...signed, signature: invalidSignature },
  }))));

  const errorWire = await connection.inbox.nextWhere((value) => isRecord(value) && value.kind === "secure");
  assert.equal(JSON.stringify(errorWire).includes("request_relay_secure_rejected"), false);
  assert.equal(JSON.stringify(errorWire).includes("transport.error"), false);
  const errorFrame = parseSecureFrame(errorWire);
  assert.ok(errorFrame !== null);
  const transportError = JSON.parse(phone.open(errorFrame)) as unknown;
  assert.ok(isRecord(transportError));
  assert.equal(transportError.type, "transport.error");
  assert.equal(transportError.requestId, rejectedRequest.requestId);
  assert.match(String(transportError.message), /signature/u);
});

test("unsigned local mode unlocks event replay after an authorized request", async () => {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_unsigned_transport_test",
    displayName: "Unsigned transport test host",
    identity: createHostIdentity(),
    enabledProviders: ["fake"],
  };
  const bridge = new AgentBridge(config, [new FakeProviderAdapter({ hostId: config.hostId, sessionCount: 1 })]);
  await bridge.start();
  assert.throws(
    () => new BridgeSocketServer(bridge, { host: "0.0.0.0", port: 0, allowUnsignedRequests: true }),
    /loopback/u,
  );
  const messages: unknown[] = [];
  const session = new BridgeMessageSession(bridge, (text) => messages.push(JSON.parse(text) as unknown), {
    allowUnsignedRequests: true,
    eventPollIntervalMs: 10,
  });

  try {
    session.start();
    assert.equal(messages.length, 1);
    assert.ok(isRecord(messages[0]) && messages[0].kind === "hello");

    await session.handle(JSON.stringify(request(config.hostId, "host.get", "request_unsigned_host", {})));
    assert.ok(messages.some((value) => isRecord(value) && value.kind === "response" && value.requestId === "request_unsigned_host"));
    assert.ok(messages.some(isEventBatch));
  } finally {
    session.close();
    await bridge.dispose();
  }
});

test("busy event replay is split into WebSocket-safe batches", async () => {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_bounded_replay_test",
    displayName: "Bounded replay host",
    identity: createHostIdentity(),
    enabledProviders: ["fake"],
  };
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const messages: unknown[] = [];
  const session = new BridgeMessageSession(
    bridge,
    (text) => {
      assert.ok(Buffer.byteLength(text, "utf8") < 2 * 1024 * 1024);
      messages.push(JSON.parse(text) as unknown);
    },
    { allowUnsignedRequests: true, eventPollIntervalMs: 60_000 },
  );

  try {
    for (let index = 0; index < 450; index += 1) {
      bridge.setRelayConnected(index % 2 === 0);
    }
    session.start();
    await session.handle(JSON.stringify(request(config.hostId, "host.get", "request_bounded_replay", {})));
    const batches = messages.filter(isEventBatch);
    assert.ok(batches.length >= 1);
    assert.ok(
      batches.every((value) =>
        isRecord(value.payload) && Array.isArray(value.payload.events) && value.payload.events.length <= 200),
    );
  } finally {
    session.close();
    await bridge.dispose();
  }
});

test("replay rollover is explicit in live batches and bounded sync responses", async () => {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_replay_gap_test",
    displayName: "Replay gap host",
    identity: createHostIdentity(),
    enabledProviders: [],
  };
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  for (let index = 0; index < 5_100; index += 1) {
    bridge.setRelayConnected(index % 2 === 0);
  }

  const liveMessages: unknown[] = [];
  const liveSession = new BridgeMessageSession(
    bridge,
    (text) => liveMessages.push(JSON.parse(text) as unknown),
    { allowUnsignedRequests: true, eventPollIntervalMs: 60_000 },
  );
  const syncMessages: unknown[] = [];
  const syncSession = new BridgeMessageSession(
    bridge,
    (text) => {
      assert.ok(Buffer.byteLength(text, "utf8") < 2 * 1024 * 1024);
      syncMessages.push(JSON.parse(text) as unknown);
    },
    { allowUnsignedRequests: true, eventPollIntervalMs: 60_000 },
  );

  try {
    liveSession.start();
    await liveSession.handle(JSON.stringify(request(config.hostId, "host.get", "request_gap_live", {})));
    const liveBatch = liveMessages.find(isEventBatch);
    assert.ok(isEventBatch(liveBatch) && isRecord(liveBatch.payload));
    assert.equal(liveBatch.payload.requestedSequence, 0);
    assert.equal(liveBatch.payload.oldestAvailableSequence, 102);
    assert.equal(liveBatch.payload.latestSequence, 5_101);
    assert.equal(liveBatch.payload.replayGap, true);
    assert.ok(Array.isArray(liveBatch.payload.events) && liveBatch.payload.events.length <= 200);
    assert.equal(isRecord(liveBatch.payload.events[0]) ? liveBatch.payload.events[0].sequence : undefined, 102);

    syncSession.start();
    await syncSession.handle(JSON.stringify(request(config.hostId, "sync.since", "request_gap_sync", { sequence: 0 })));
    const syncResponse = syncMessages.find((value) =>
      isRecord(value) && value.kind === "response" && value.requestId === "request_gap_sync");
    assert.ok(isRecord(syncResponse) && syncResponse.ok === true && isRecord(syncResponse.payload));
    assert.equal(syncResponse.payload.requestedSequence, 0);
    assert.equal(syncResponse.payload.oldestAvailableSequence, 102);
    assert.equal(syncResponse.payload.latestSequence, 5_101);
    assert.equal(syncResponse.payload.replayGap, true);
    assert.ok(Array.isArray(syncResponse.payload.events) && syncResponse.payload.events.length <= 200);
    assert.equal(syncResponse.payload.throughSequence, 301);
  } finally {
    liveSession.close();
    syncSession.close();
    await bridge.dispose();
  }
});
