import assert from "node:assert/strict";
import test from "node:test";
import {
  PairingManager,
  createDeviceIdentity,
  createHostIdentity,
  signRelayDeviceAttach,
  type DeviceIdentity,
  type SignedCredential,
} from "../../../packages/protocol/src/index.js";
import { RelayServer } from "../../../services/relay/src/index.js";
import { WebSocketServer, type WebSocketConnection } from "../../../packages/transport_ws/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { BridgeRelayClient, BridgeSocketServer } from "./transport.js";

const RELAY_TOKEN = "device-revocation-relay-token".padEnd(43, "x");

function hostConfig(hostId: string): BridgeConfig {
  return { version: 1, hostId, displayName: hostId, identity: createHostIdentity(), enabledProviders: [] };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function attachDevice(url: string, hostId: string, deviceId: string, paired?: { readonly identity: DeviceIdentity; readonly credential: SignedCredential }) {
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  let closeCode: number | null = null;
  socket.addEventListener("message", (event) => {
    try { messages.push(JSON.parse(String(event.data)) as unknown); } catch { messages.push(String(event.data)); }
  });
  socket.addEventListener("close", (event) => { closeCode = event.code; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to the relay")), 2_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Relay connection failed")); }, { once: true });
  });
  socket.send(JSON.stringify({
    type: "relay.attach",
    role: "device",
    hostId,
    token: RELAY_TOKEN,
    deviceId,
    // The relay authenticates the device itself, so a revocation test has to
    // attach the way a real phone does.
    ...(paired === undefined ? {} : {
      proof: signRelayDeviceAttach({
        hostId,
        deviceId,
        token: RELAY_TOKEN,
        credential: paired.credential,
        devicePrivateKeyPem: paired.identity.privateKeyPem,
      }),
    }),
  }));
  return { socket, messages, closed: () => closeCode !== null, closeCode: () => closeCode };
}

test("revoking a device drops its live relay tunnel and refuses it back", async (context) => {
  const config = hostConfig("host_revocation_relay");
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const relay = new RelayServer({ host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await relay.listen();
  const address = relay.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/relay`;
  const relayClient = new BridgeRelayClient(bridge, { url, token: RELAY_TOKEN, reconnect: false });
  context.after(async () => {
    await relayClient.dispose();
    await relay.close();
    await bridge.dispose();
  });
  await relayClient.start();
  await waitFor(() => relay.roomCount() === 1, "the host room");

  const device = createDeviceIdentity("device_revocation_relay");
  const pairing = bridge.startPairing();
  const credential = bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });

  const paired = { identity: device, credential };
  const phone = await attachDevice(url, config.hostId, device.deviceId, paired);
  await waitFor(() => relay.deviceCount(config.hostId) === 1, "the device tunnel");
  assert.deepEqual(bridge.revokedDeviceIds(), []);

  const credentialId = bridge.pairedDevices()[0]!.credentialId;
  assert.equal(bridge.revokeDevice(credentialId), true);

  // Revoking must actually disconnect, not merely refuse each later action.
  await waitFor(() => phone.closed(), "the revoked tunnel to close");
  assert.equal(phone.closeCode(), 1008);
  await waitFor(() => relay.deviceCount(config.hostId) === 0, "the relay to forget the device");
  assert.deepEqual(bridge.revokedDeviceIds(), [device.deviceId]);

  // And holding the shared room token is no longer enough to get back in.
  const retry = await attachDevice(url, config.hostId, device.deviceId, paired);
  await waitFor(() => retry.closed(), "the reconnect attempt to be refused");
  assert.equal(relay.deviceCount(config.hostId), 0);
});

test("a relay that restarts still refuses a revoked device once the host reattaches", async (context) => {
  const config = hostConfig("host_revocation_restart");
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const device = createDeviceIdentity("device_revocation_restart");
  const pairing = bridge.startPairing();
  bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  assert.equal(bridge.revokeDevice(bridge.pairedDevices()[0]!.credentialId), true);

  // A fresh relay process holds no memory of the revocation; the host restores it.
  const relay = new RelayServer({ host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await relay.listen();
  const address = relay.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/relay`;
  const relayClient = new BridgeRelayClient(bridge, { url, token: RELAY_TOKEN, reconnect: false });
  context.after(async () => {
    await relayClient.dispose();
    await relay.close();
    await bridge.dispose();
  });
  await relayClient.start();
  await waitFor(() => relay.roomCount() === 1, "the host room");

  const phone = await attachDevice(url, config.hostId, device.deviceId);
  await waitFor(() => phone.closed(), "the revoked device to be refused");
  assert.equal(relay.deviceCount(config.hostId), 0);
});

test("revoking one device leaves another connected", async (context) => {
  const config = hostConfig("host_revocation_isolated");
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const relay = new RelayServer({ host: "127.0.0.1", port: 0, heartbeatIntervalMs: 60_000 });
  await relay.listen();
  const address = relay.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `ws://127.0.0.1:${address.port}/relay`;
  const relayClient = new BridgeRelayClient(bridge, { url, token: RELAY_TOKEN, reconnect: false });
  context.after(async () => {
    await relayClient.dispose();
    await relay.close();
    await bridge.dispose();
  });
  await relayClient.start();
  await waitFor(() => relay.roomCount() === 1, "the host room");

  const kept = createDeviceIdentity("device_kept");
  const removed = createDeviceIdentity("device_removed");
  const pairedById = new Map<string, { identity: DeviceIdentity; credential: SignedCredential }>();
  for (const device of [kept, removed]) {
    const pairing = bridge.startPairing();
    pairedById.set(device.deviceId, {
      identity: device,
      credential: bridge.confirmPairing({
        pairingId: pairing.pairingId,
        secret: pairing.secret,
        shortCode: pairing.shortCode,
        deviceId: device.deviceId,
        devicePublicKeyPem: device.publicKeyPem,
      }),
    });
  }
  const keptPhone = await attachDevice(url, config.hostId, kept.deviceId, pairedById.get(kept.deviceId));
  const removedPhone = await attachDevice(url, config.hostId, removed.deviceId, pairedById.get(removed.deviceId));
  await waitFor(() => relay.deviceCount(config.hostId) === 2, "both tunnels");

  const removedCredential = bridge.pairedDevices().find((entry) => entry.deviceId === removed.deviceId)!;
  assert.equal(bridge.revokeDevice(removedCredential.credentialId), true);
  await waitFor(() => removedPhone.closed(), "the revoked tunnel to close");
  assert.equal(keptPhone.closed(), false, "the other phone must stay connected");
  await waitFor(() => relay.deviceCount(config.hostId) === 1, "one remaining tunnel");
});

test("an older relay that cannot revoke keeps its host tunnel", async (context) => {
  const config = hostConfig("host_revocation_legacy_relay");
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  // Stands in for the relay already deployed: it greets without announcing the
  // capability and treats any unknown host message as a protocol error.
  const legacy = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/relay" });
  let hostSocket: WebSocketConnection | null = null;
  let closed = false;
  let unknownMessages = 0;
  legacy.onConnection((connection) => {
    hostSocket = connection;
    connection.onMessage((text) => {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (value.type === "relay.attach") {
        connection.sendJson({ type: "relay.attached", role: "host", hostId: config.hostId, devices: 0 });
        return;
      }
      if (value.type !== "relay.forward") {
        unknownMessages += 1;
        throw new Error("Invalid host forwarding message");
      }
    });
    connection.onClose(() => { closed = true; });
  });
  await legacy.listen();
  const address = legacy.address();
  assert.ok(address !== null && typeof address === "object");
  const relayClient = new BridgeRelayClient(bridge, { url: `ws://127.0.0.1:${address.port}/relay`, token: RELAY_TOKEN, reconnect: false });
  context.after(async () => {
    await relayClient.dispose();
    await legacy.close();
    await bridge.dispose();
  });
  await relayClient.start();
  await waitFor(() => hostSocket !== null, "the legacy relay attachment");
  await new Promise((resolve) => setTimeout(resolve, 80));

  const device = createDeviceIdentity("device_legacy_relay");
  const pairing = bridge.startPairing();
  bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  assert.equal(bridge.revokeDevice(bridge.pairedDevices()[0]!.credentialId), true);
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(unknownMessages, 0, "an older relay must never be sent a message it would reject");
  assert.equal(closed, false, "revoking must not tear down the tunnel to an older relay");
});

test("a device that pairs again is no longer treated as revoked", () => {
  const identity = createHostIdentity();
  const manager = new PairingManager("host_repair", identity);
  const device = createDeviceIdentity("device_repair");
  const pair = () => {
    const pairing = manager.startPairing();
    return manager.confirmPairing({
      pairingId: pairing.pairingId,
      secret: pairing.secret,
      shortCode: pairing.shortCode,
      deviceId: device.deviceId,
      devicePublicKeyPem: device.publicKeyPem,
    });
  };
  pair();
  manager.revoke(manager.listDevices()[0]!.credentialId);
  assert.deepEqual(manager.revokedDeviceIds(), [device.deviceId]);

  // Pairing the same phone again must not leave it blocked by its own history.
  pair();
  assert.deepEqual(manager.revokedDeviceIds(), []);
});

test("a revoked device is dropped from a direct connection too", async (context) => {
  const config = hostConfig("host_revocation_direct");
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  const server = new BridgeSocketServer(bridge, { host: "127.0.0.1", port: 0 });
  await server.listen();
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  context.after(async () => {
    await server.close();
    await bridge.dispose();
  });

  const device = createDeviceIdentity("device_revocation_direct");
  const pairing = bridge.startPairing();
  bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`);
  let closeCode: number | null = null;
  socket.addEventListener("close", (event) => { closeCode = event.code; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out connecting to the bridge")), 2_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Bridge connection failed")); }, { once: true });
  });
  socket.send(JSON.stringify({ kind: "hello", role: "device", deviceId: device.deviceId }));
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(bridge.revokeDevice(bridge.pairedDevices()[0]!.credentialId), true);
  await waitFor(() => closeCode !== null, "the direct connection to close");
  assert.equal(closeCode, 1008);
});
