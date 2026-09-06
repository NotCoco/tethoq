import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const outputDirectory = join(tmpdir(), `tethoq-mobile-connection-${process.pid}-${Date.now()}`);
await mkdir(outputDirectory, { recursive: true });
const outfile = join(outputDirectory, "mobile-connection.cjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/main/mobile_connection.ts", import.meta.url))],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
});
const { MobileConnectionManager } = await import(`file:///${outfile.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("desktop-owned phone pairing exposes only an opaque QR and safe device summaries", async () => {
  const secret = "test-pairing";
  const devices = [];
  let pairingListener = () => {};
  let capturedQrText = "";
  let tunnelOrigin = "";
  let tunnelDisposed = 0;
  let serverClosed = 0;
  let revoked = "";
  let connectedDeviceIds = [];
  let connectedDevicesListener = () => {};
  const bridge = {
    startPairing: () => ({
      version: 1,
      hostId: "host_test",
      hostPublicKeyPem: "PUBLIC KEY MATERIAL",
      pairingId: "pair_test",
      secret,
      shortCode: "123456",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
    pairedDevices: () => devices,
    revokeDevice: (id) => {
      revoked = id;
      const index = devices.findIndex((device) => device.credentialId === id);
      if (index < 0) return false;
      devices.splice(index, 1);
      return true;
    },
    onDeviceRevoked: () => () => {},
  };
  const runtime = {
    bridge,
    start: async () => {},
    onPairingConfirmed: (listener) => { pairingListener = listener; return () => { pairingListener = () => {}; }; },
  };
  const manager = new MobileConnectionManager({
    runtime,
    cloudflaredCommand: "C:\\Tethoq\\cloudflared.exe",
    createSocketServer: (_bridge) => ({
      listen: async () => {},
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43127 }),
      close: async () => { serverClosed += 1; },
      connectedDeviceIds: () => connectedDeviceIds,
      onConnectedDevicesChanged: (listener) => { connectedDevicesListener = listener; return () => { connectedDevicesListener = () => {}; }; },
    }),
    startTunnel: async (origin) => {
      tunnelOrigin = origin;
      return { publicWebSocketBaseUrl: "wss://phone.test", dispose: async () => { tunnelDisposed += 1; } };
    },
    renderQr: async (text) => { capturedQrText = text; return "data:image/svg+xml;base64,b3BhcXVl"; },
  });

  const ready = await manager.startPairing();
  assert.equal(ready.state, "ready");
  assert.equal(tunnelOrigin, "http://127.0.0.1:43127");
  assert.equal(ready.qrDataUrl, "data:image/svg+xml;base64,b3BhcXVl");
  assert.equal(JSON.stringify(ready).includes(secret), false);
  assert.equal(JSON.stringify(ready).includes("PUBLIC KEY MATERIAL"), false);
  const qrDocument = JSON.parse(capturedQrText);
  assert.equal(qrDocument.directUrl, "wss://phone.test/bridge");
  assert.equal(qrDocument.payload.secret, secret);

  devices.push({
    version: 1,
    credentialId: "cred_phone_1",
    hostId: "host_test",
    deviceId: "raw-device-id",
    devicePublicKeyPem: "RAW PHONE KEY",
    issuedAt: "2026-08-28T12:00:00.000Z",
  });
  pairingListener();
  const paired = manager.state();
  assert.deepEqual(paired, {
    state: "paired",
    devices: [{ id: "cred_phone_1", pairedAt: "2026-08-28T12:00:00.000Z", connected: false }],
  });
  assert.equal(JSON.stringify(paired).includes("raw-device-id"), false);
  assert.equal(JSON.stringify(paired).includes("RAW PHONE KEY"), false);

  connectedDeviceIds = ["raw-device-id"];
  connectedDevicesListener();
  assert.deepEqual(manager.state().devices, [{ id: "cred_phone_1", pairedAt: "2026-08-28T12:00:00.000Z", connected: true }]);

  connectedDeviceIds = [];
  connectedDevicesListener();
  assert.deepEqual(manager.state().devices, [{ id: "cred_phone_1", pairedAt: "2026-08-28T12:00:00.000Z", connected: false }]);
  assert.equal(devices.length, 1, "losing live presence must not revoke a saved phone");

  const removed = await manager.revoke("cred_phone_1");
  assert.equal(revoked, "cred_phone_1");
  assert.deepEqual(removed, { state: "idle", devices: [] });
  assert.equal(tunnelDisposed, 1);
  assert.equal(serverClosed, 1);
  await manager.dispose();
});

test("phone-initiated unpair immediately clears the open desktop pairing state", async () => {
  const devices = [{
    version: 1,
    credentialId: "cred_phone_external",
    hostId: "host_external",
    deviceId: "device_external",
    devicePublicKeyPem: "PHONE KEY",
    issuedAt: "2026-09-02T03:00:00.000Z",
  }];
  let pairingListener = () => {};
  let revocationListener = () => {};
  let runtimeReady = false;
  let tunnelDisposed = 0;
  let serverClosed = 0;
  const emitted = [];
  const bridge = {
    startPairing: () => ({
      version: 1,
      hostId: "host_external",
      hostPublicKeyPem: "PUBLIC KEY",
      pairingId: "pair_external",
      secret: "pairing-secret",
      shortCode: "123456",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }),
    pairedDevices: () => devices,
    revokeDevice: () => false,
    onDeviceRevoked: (listener) => { revocationListener = listener; return () => { revocationListener = () => {}; }; },
  };
  const runtime = {
    get bridge() {
      if (!runtimeReady) throw new Error("runtime bridge requested before start");
      return bridge;
    },
    start: async () => { runtimeReady = true; },
    onPairingConfirmed: (listener) => { pairingListener = listener; return () => { pairingListener = () => {}; }; },
  };
  const manager = new MobileConnectionManager({
    runtime,
    onState: (state) => { emitted.push(state); },
    createSocketServer: () => ({
      listen: async () => {},
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43127 }),
      close: async () => { serverClosed += 1; },
      connectedDeviceIds: () => [],
      onConnectedDevicesChanged: () => () => {},
    }),
    startTunnel: async () => ({
      publicWebSocketBaseUrl: "wss://phone.test",
      dispose: async () => { tunnelDisposed += 1; },
    }),
    renderQr: async () => "data:image/svg+xml;base64,b3BhcXVl",
  });

  assert.equal(runtimeReady, false, "constructing the manager must not touch the lazy bridge");
  await manager.startPairing();
  assert.equal(runtimeReady, true);
  pairingListener();
  assert.equal(manager.state().state, "paired");

  devices.splice(0, 1);
  revocationListener("device_external");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(manager.state(), { state: "idle", devices: [] });
  assert.deepEqual(emitted.at(-1), { state: "idle", devices: [] });
  assert.equal(tunnelDisposed, 1);
  assert.equal(serverClosed, 1);
  await manager.dispose();
});

test("closing Tethoq cancels phone tunnel startup without waiting for readiness timeout", async () => {
  let observedSignal;
  let serverClosed = 0;
  const runtime = {
    bridge: { pairedDevices: () => [], onDeviceRevoked: () => () => {} },
    start: async () => {},
    onPairingConfirmed: () => () => {},
  };
  const manager = new MobileConnectionManager({
    runtime,
    createSocketServer: () => ({
      listen: async () => {},
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43127 }),
      close: async () => { serverClosed += 1; },
      connectedDeviceIds: () => [],
      onConnectedDevicesChanged: () => () => {},
    }),
    startTunnel: async (_origin, _command, options) => {
      observedSignal = options?.signal;
      return await new Promise((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal.reason), { once: true });
      });
    },
  });

  const starting = manager.startPairing();
  while (observedSignal === undefined) await new Promise((resolve) => setImmediate(resolve));
  await manager.dispose();
  assert.equal(observedSignal.aborted, true);
  assert.equal(serverClosed, 1);
  assert.deepEqual(await starting, { state: "idle", devices: [] });
});

test("the task rail opens an integrated phone surface with a branching-wire mark", async () => {
  const [navigation, dialog, icons, main] = await Promise.all([
    readFile(new URL("../src/renderer/src/NavigationPanels.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/src/MobileConnectionDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/renderer/src/icons.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/main/index.ts", import.meta.url), "utf8"),
  ]);
  assert.match(navigation, /className="sidebar-mobile-connection"[^>]*aria-label="Connect your phone"/u);
  assert.match(navigation, /<BridgeIcon\s*\/>/u);
  assert.match(dialog, /<Modal title="Connect your phone" eyebrow="Tethoq Bridge"/u);
  assert.match(dialog, /One-time Tethoq phone pairing code/u);
  assert.match(dialog, />Saved phones</u);
  assert.match(dialog, /device\.connected \? "Connected" : "Not connected"/u);
  assert.doesNotMatch(dialog, />Paired phone(?:\s|<)/u);
  assert.doesNotMatch(dialog, /openExternal|window\.open/u);
  assert.match(icons, /export const BridgeIcon[\s\S]*M3 12h5/u);
  assert.match(main, /bridge-companion", "resources", "bridge", "runtime", "cloudflared\.exe"/u);
});
