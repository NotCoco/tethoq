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
  type JsonObject,
  type RequestEnvelope,
  type SecureTransportKeys,
  type SignedCredential,
} from "../../../packages/protocol/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { BridgeMessageSession } from "./transport.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drives one host session and plays the paired phone on the other end. */
async function pairedSession(context: { after: (fn: () => Promise<void> | void) => void }) {
  const config: BridgeConfig = {
    version: 1,
    hostId: "host_secure_transport",
    displayName: "Secure transport host",
    identity: createHostIdentity(),
    enabledProviders: [],
  };
  const bridge = new AgentBridge(config, []);
  await bridge.start();
  context.after(async () => { await bridge.dispose(); });

  const device = createDeviceIdentity("device_secure_transport");
  const pairing = bridge.startPairing();
  const credential: SignedCredential = bridge.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });

  const sent: unknown[] = [];
  const session = new BridgeMessageSession(bridge, (text) => { sent.push(JSON.parse(text) as unknown); }, { eventPollIntervalMs: 60_000 });
  context.after(() => session.close());
  session.start();

  const hello = sent.shift();
  assert.ok(isRecord(hello) && hello.kind === "hello", "the host must greet first");
  return { bridge, config, device, credential, session, sent, hello };
}

function deviceRequest(hostId: string, type: string, payload: JsonObject = {}): RequestEnvelope {
  return {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: randomUUID(),
    hostId,
    sentAt: new Date().toISOString(),
    kind: "request",
    type,
    requestId: randomUUID(),
    payload,
  };
}

test("a paired device agrees a key and every later message is ciphertext", async (context) => {
  const { config, device, credential, session, sent, hello } = await pairedSession(context);

  const offer = parseSecureHandshakeOffer((hello as Record<string, unknown>).encryption);
  assert.ok(offer !== null, "the host greeting must offer encryption");

  const { accept, keys } = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  await session.handle(JSON.stringify(accept));
  assert.equal(session.encrypted, true);

  const phone = new SecureChannel(keys, "device");
  const confirmation = parseSecureFrame(sent.shift());
  assert.ok(confirmation !== null, "the host must confirm through the new channel");
  const established = JSON.parse(phone.open(confirmation)) as Record<string, unknown>;
  assert.equal(established.kind, "secure_established");
  assert.equal(established.deviceId, device.deviceId);
  assert.equal(established.fingerprint, phone.fingerprint());

  const envelope = deviceRequest(config.hostId, "host.get");
  const signed = await Promise.resolve(signDeviceAction({
    credential,
    action: envelope as unknown as JsonObject,
    devicePrivateKeyPem: device.privateKeyPem,
  }));
  await session.handle(JSON.stringify(phone.seal(JSON.stringify({ kind: "signed_action", signed }))));

  const responseFrame = parseSecureFrame(sent.shift());
  assert.ok(responseFrame !== null, "the response must be encrypted");
  const response = JSON.parse(phone.open(responseFrame)) as Record<string, unknown>;
  assert.equal(response.kind, "response");
  assert.equal(response.ok, true);
  assert.equal(response.requestId, envelope.requestId);

  // Nothing readable ever reached the wire after the greeting.
  for (const value of sent) assert.ok(isRecord(value) && value.kind === "secure", "every later message must stay sealed");
});

test("host identity and task text never appear in clear text on the wire", async (context) => {
  const { config, device, credential, session, sent, hello } = await pairedSession(context);
  const offer = parseSecureHandshakeOffer((hello as Record<string, unknown>).encryption);
  assert.ok(offer !== null);
  const { accept, keys } = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  await session.handle(JSON.stringify(accept));
  const phone = new SecureChannel(keys, "device");
  sent.length = 0;

  const secretText = "migrate Acme payroll off the old gateway";
  const envelope = deviceRequest(config.hostId, "sessions.list", { query: secretText });
  const signed = signDeviceAction({ credential, action: envelope as unknown as JsonObject, devicePrivateKeyPem: device.privateKeyPem });
  await session.handle(JSON.stringify(phone.seal(JSON.stringify({ kind: "signed_action", signed }))));

  const wire = sent.map((value) => JSON.stringify(value)).join("\n");
  assert.equal(wire.includes(secretText), false, "the relay must never see task text");
  assert.equal(wire.includes(device.deviceId), false, "the relay must never see the device identity");
});

test("plain messages are refused once the connection is encrypted", async (context) => {
  const { config, device, credential, session, hello } = await pairedSession(context);
  const offer = parseSecureHandshakeOffer((hello as Record<string, unknown>).encryption);
  assert.ok(offer !== null);
  const { accept } = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  await session.handle(JSON.stringify(accept));

  const envelope = deviceRequest(config.hostId, "host.get");
  const signed = signDeviceAction({ credential, action: envelope as unknown as JsonObject, devicePrivateKeyPem: device.privateKeyPem });
  await assert.rejects(
    session.handle(JSON.stringify({ kind: "signed_action", signed })),
    /encrypted and no longer accepts plain messages/u,
  );
});

test("a revoked device cannot agree a key even with a valid signature", async (context) => {
  const { bridge, config, device, credential, session, hello } = await pairedSession(context);
  const devices = bridge.pairedDevices();
  assert.equal(devices.length, 1);
  assert.equal(bridge.revokeDevice(devices[0]!.credentialId), true);

  const offer = parseSecureHandshakeOffer((hello as Record<string, unknown>).encryption);
  assert.ok(offer !== null);
  const { accept } = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  await assert.rejects(session.handle(JSON.stringify(accept)), /revoked/u);
  assert.equal(session.encrypted, false);
});

test("a phone receives its self-revoke acknowledgement before disconnection", async (context) => {
  const { bridge, config, device, credential, session, sent, hello } = await pairedSession(context);
  const offer = parseSecureHandshakeOffer((hello as Record<string, unknown>).encryption);
  assert.ok(offer !== null);
  const { accept, keys } = acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  });
  await session.handle(JSON.stringify(accept));
  const phone = new SecureChannel(keys, "device");
  sent.length = 0;

  let disconnectNotified = false;
  const stopListening = bridge.onDeviceRevoked(() => { disconnectNotified = true; });
  context.after(stopListening);
  const credentialId = bridge.pairedDevices()[0]!.credentialId;
  const envelope = deviceRequest(config.hostId, "device.revoke", { credentialId });
  const signed = signDeviceAction({
    credential,
    action: envelope as unknown as JsonObject,
    devicePrivateKeyPem: device.privateKeyPem,
  });

  await session.handle(JSON.stringify(phone.seal(JSON.stringify({ kind: "signed_action", signed }))));

  assert.equal(disconnectNotified, false, "the response continuation must run before the disconnect notification");
  assert.deepEqual(bridge.pairedDevices(), []);
  const responseFrame = parseSecureFrame(sent.shift());
  assert.ok(responseFrame !== null, "self-revoke must return an encrypted response");
  const response = JSON.parse(phone.open(responseFrame)) as Record<string, unknown>;
  assert.equal(response.requestId, envelope.requestId);
  assert.equal(response.ok, true);
  assert.deepEqual(response.payload, { revoked: true });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disconnectNotified, true);
});

test("ciphertext before a handshake is refused", async (context) => {
  const { session } = await pairedSession(context);
  const stranger = new SecureChannel({ hostToDevice: Buffer.alloc(32, 1), deviceToHost: Buffer.alloc(32, 2) } as SecureTransportKeys, "device");
  await assert.rejects(
    session.handle(JSON.stringify(stranger.seal("{}"))),
    /before this connection agreed a key/u,
  );
});

test("a second handshake on one connection is refused", async (context) => {
  const { config, device, credential, session, hello } = await pairedSession(context);
  const offer = parseSecureHandshakeOffer((hello as Record<string, unknown>).encryption);
  assert.ok(offer !== null);
  const handshake = () => acceptSecureHandshake({
    offer,
    hostId: config.hostId,
    hostPublicKeyPem: config.identity.publicKeyPem,
    deviceId: device.deviceId,
    devicePrivateKeyPem: device.privateKeyPem,
    credential,
  }).accept;
  await session.handle(JSON.stringify(handshake()));
  await assert.rejects(session.handle(JSON.stringify(handshake())), /already agreed a key/u);
});

test("a device that never handshakes still works, so existing installs keep running", async (context) => {
  const { config, device, credential, session, sent } = await pairedSession(context);
  // A device announcement is accepted and ignored; it exists so the relay path
  // creates the host session and delivers the offer before any real request.
  await session.handle(JSON.stringify({ kind: "hello", role: "device", deviceId: device.deviceId }));
  assert.equal(sent.length, 0);

  const envelope = deviceRequest(config.hostId, "host.get");
  const signed = signDeviceAction({ credential, action: envelope as unknown as JsonObject, devicePrivateKeyPem: device.privateKeyPem });
  await session.handle(JSON.stringify({ kind: "signed_action", signed }));
  const response = sent.shift();
  assert.ok(isRecord(response) && response.kind === "response" && response.ok === true);
  assert.equal(session.encrypted, false);
});
