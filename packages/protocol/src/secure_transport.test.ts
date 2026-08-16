import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptSecureHandshake,
  completeSecureHandshake,
  createDeviceIdentity,
  createEphemeralKeyPair,
  createHostIdentity,
  createSecureHandshakeOffer,
  deriveSecureTransportKeys,
  handshakeBind,
  importX25519PublicKey,
  openSecureFrame,
  parseSecureFrame,
  parseSecureHandshakeAccept,
  PairingManager,
  rawX25519PublicKey,
  sealSecureFrame,
  SecureChannel,
  secureSharedSecret,
  signCredential,
  type SecureHandshakeAccept,
} from "./index.js";

const HOST_ID = "desktop_secure_test";

function pairedFixture() {
  const hostIdentity = createHostIdentity();
  const device = createDeviceIdentity("device_secure_test");
  const manager = new PairingManager(HOST_ID, hostIdentity);
  const pairing = manager.startPairing();
  const credential = manager.confirmPairing({
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  });
  return { hostIdentity, device, manager, credential };
}

function handshake(fixture = pairedFixture()) {
  const { offer, keyPair } = createSecureHandshakeOffer({ hostId: HOST_ID, hostPrivateKeyPem: fixture.hostIdentity.privateKeyPem });
  const { accept, keys: deviceKeys } = acceptSecureHandshake({
    offer,
    hostId: HOST_ID,
    hostPublicKeyPem: fixture.hostIdentity.publicKeyPem,
    deviceId: fixture.device.deviceId,
    devicePrivateKeyPem: fixture.device.privateKeyPem,
    credential: fixture.credential,
  });
  const host = completeSecureHandshake({ accept, hostId: HOST_ID, hostPublicKeyPem: fixture.hostIdentity.publicKeyPem, keyPair });
  return { fixture, offer, keyPair, accept, deviceKeys, hostResult: host };
}

test("both ends of a handshake derive the same keys and can talk", () => {
  const { deviceKeys, hostResult, fixture } = handshake();
  assert.deepEqual(hostResult.keys.hostToDevice, deviceKeys.hostToDevice);
  assert.deepEqual(hostResult.keys.deviceToHost, deviceKeys.deviceToHost);
  assert.equal(hostResult.deviceId, fixture.device.deviceId);

  const hostChannel = new SecureChannel(hostResult.keys, "host");
  const deviceChannel = new SecureChannel(deviceKeys, "device");
  assert.equal(hostChannel.fingerprint(), deviceChannel.fingerprint());
  assert.equal(hostChannel.matches(deviceChannel), true);

  const request = JSON.stringify({ kind: "request", type: "sessions.list", payload: { query: "payroll bug" } });
  assert.equal(hostChannel.open(deviceChannel.seal(request)), request);
  const response = JSON.stringify({ kind: "response", ok: true, payload: { sessions: [] } });
  assert.equal(deviceChannel.open(hostChannel.seal(response)), response);
});

test("each direction uses its own key so a reflected frame cannot decrypt", () => {
  const { deviceKeys, hostResult } = handshake();
  assert.notDeepEqual(hostResult.keys.hostToDevice, hostResult.keys.deviceToHost);
  const deviceChannel = new SecureChannel(deviceKeys, "device");
  const frame = deviceChannel.seal("from the phone");
  // Reflecting the device's own frame back at it must fail: wrong key and wrong direction label.
  assert.throws(() => new SecureChannel(deviceKeys, "device").open(frame), /unable to authenticate|unsupported state/i);
});

test("a relay that swaps in its own ephemeral key is rejected by both sides", () => {
  const fixture = pairedFixture();
  const { offer } = createSecureHandshakeOffer({ hostId: HOST_ID, hostPrivateKeyPem: fixture.hostIdentity.privateKeyPem });
  const attacker = createEphemeralKeyPair();

  // The relay replaces the computer's key but cannot produce the host signature over it.
  const forgedOffer = { ...offer, ephemeralPublicKey: Buffer.from(rawX25519PublicKey(attacker.publicKey)).toString("base64url") };
  assert.throws(() => acceptSecureHandshake({
    offer: forgedOffer,
    hostId: HOST_ID,
    hostPublicKeyPem: fixture.hostIdentity.publicKeyPem,
    deviceId: fixture.device.deviceId,
    devicePrivateKeyPem: fixture.device.privateKeyPem,
    credential: fixture.credential,
  }), /was not signed by the paired host/);

  // The relay replaces the phone's key; the device signature no longer covers it.
  const { offer: realOffer, keyPair } = createSecureHandshakeOffer({ hostId: HOST_ID, hostPrivateKeyPem: fixture.hostIdentity.privateKeyPem });
  const { accept } = acceptSecureHandshake({
    offer: realOffer,
    hostId: HOST_ID,
    hostPublicKeyPem: fixture.hostIdentity.publicKeyPem,
    deviceId: fixture.device.deviceId,
    devicePrivateKeyPem: fixture.device.privateKeyPem,
    credential: fixture.credential,
  });
  const forgedAccept: SecureHandshakeAccept = { ...accept, ephemeralPublicKey: Buffer.from(rawX25519PublicKey(attacker.publicKey)).toString("base64url") };
  assert.throws(() => completeSecureHandshake({ accept: forgedAccept, hostId: HOST_ID, hostPublicKeyPem: fixture.hostIdentity.publicKeyPem, keyPair }), /signature is invalid/);
});

test("a device signature bound to a different host session does not transfer", () => {
  const fixture = pairedFixture();
  const first = createSecureHandshakeOffer({ hostId: HOST_ID, hostPrivateKeyPem: fixture.hostIdentity.privateKeyPem });
  const second = createSecureHandshakeOffer({ hostId: HOST_ID, hostPrivateKeyPem: fixture.hostIdentity.privateKeyPem });
  const { accept } = acceptSecureHandshake({
    offer: first.offer,
    hostId: HOST_ID,
    hostPublicKeyPem: fixture.hostIdentity.publicKeyPem,
    deviceId: fixture.device.deviceId,
    devicePrivateKeyPem: fixture.device.privateKeyPem,
    credential: fixture.credential,
  });
  // Replaying that accept into a second, fresh host connection must not authenticate.
  assert.throws(() => completeSecureHandshake({
    accept,
    hostId: HOST_ID,
    hostPublicKeyPem: fixture.hostIdentity.publicKeyPem,
    keyPair: second.keyPair,
  }), /signature is invalid/);
});

test("an unpaired device cannot complete a handshake", () => {
  const fixture = pairedFixture();
  const stranger = createDeviceIdentity("device_stranger");
  const otherHost = createHostIdentity();
  const { offer, keyPair } = createSecureHandshakeOffer({ hostId: HOST_ID, hostPrivateKeyPem: fixture.hostIdentity.privateKeyPem });
  // A credential this host never issued: signed by someone else's identity.
  const forged = signCredential({
    version: 1,
    credentialId: "cred_forged",
    hostId: HOST_ID,
    deviceId: stranger.deviceId,
    devicePublicKeyPem: stranger.publicKeyPem,
    issuedAt: new Date().toISOString(),
  }, otherHost.privateKeyPem);
  const { accept } = acceptSecureHandshake({
    offer,
    hostId: HOST_ID,
    hostPublicKeyPem: fixture.hostIdentity.publicKeyPem,
    deviceId: stranger.deviceId,
    devicePrivateKeyPem: stranger.privateKeyPem,
    credential: forged,
  });
  assert.throws(() => completeSecureHandshake({ accept, hostId: HOST_ID, hostPublicKeyPem: fixture.hostIdentity.publicKeyPem, keyPair }), /signature is invalid/);
});

test("a credential cannot be paired with a different device identity", () => {
  const fixture = pairedFixture();
  const stranger = createDeviceIdentity("device_stranger");
  const { offer, keyPair } = createSecureHandshakeOffer({ hostId: HOST_ID, hostPrivateKeyPem: fixture.hostIdentity.privateKeyPem });
  const { accept } = acceptSecureHandshake({
    offer,
    hostId: HOST_ID,
    hostPublicKeyPem: fixture.hostIdentity.publicKeyPem,
    // A real credential for the paired device, but signed by a key the attacker owns.
    deviceId: fixture.device.deviceId,
    devicePrivateKeyPem: stranger.privateKeyPem,
    credential: fixture.credential,
  });
  assert.throws(() => completeSecureHandshake({ accept, hostId: HOST_ID, hostPublicKeyPem: fixture.hostIdentity.publicKeyPem, keyPair }), /signature is invalid/);
});

test("a tampered frame fails authentication instead of decrypting", () => {
  const { deviceKeys, hostResult } = handshake();
  const deviceChannel = new SecureChannel(deviceKeys, "device");
  const hostChannel = new SecureChannel(hostResult.keys, "host");
  const frame = deviceChannel.seal("open the payroll repo");
  const sealed = Buffer.from(frame.ciphertext, "base64url");
  sealed.writeUInt8(sealed.readUInt8(0) ^ 0x01, 0);
  assert.throws(() => hostChannel.open({ ...frame, ciphertext: sealed.toString("base64url") }), /unable to authenticate/i);
  // Moving a valid frame to a different counter also fails: the counter is authenticated.
  assert.throws(() => hostChannel.open({ ...frame, counter: frame.counter + 5 }), /unable to authenticate/i);
});

test("replayed and reordered frames are refused", () => {
  const { deviceKeys, hostResult } = handshake();
  const deviceChannel = new SecureChannel(deviceKeys, "device");
  const hostChannel = new SecureChannel(hostResult.keys, "host");
  const first = deviceChannel.seal("one");
  const second = deviceChannel.seal("two");
  assert.equal(hostChannel.open(first), "one");
  assert.equal(hostChannel.open(second), "two");
  assert.throws(() => hostChannel.open(first), /replayed or reordered/);
  assert.throws(() => hostChannel.open(second), /replayed or reordered/);
});

test("counters advance so no key and nonce pair is ever reused", () => {
  const { deviceKeys } = handshake();
  const channel = new SecureChannel(deviceKeys, "device");
  const counters = [channel.seal("a").counter, channel.seal("b").counter, channel.seal("c").counter];
  assert.deepEqual(counters, [0, 1, 2]);
  const ciphertexts = new Set(counters.map((counter) => sealSecureFrame(deviceKeys.deviceToHost, "device-to-host", counter, "same text").ciphertext));
  assert.equal(ciphertexts.size, 3, "identical plaintext must not produce identical ciphertext");
});

test("two independent handshakes never share keys", () => {
  const fixture = pairedFixture();
  const first = handshake(fixture);
  const second = handshake(fixture);
  assert.notDeepEqual(first.hostResult.keys.hostToDevice, second.hostResult.keys.hostToDevice);
  assert.notEqual(new SecureChannel(first.hostResult.keys, "host").fingerprint(), new SecureChannel(second.hostResult.keys, "host").fingerprint());
});

test("raw X25519 keys survive the wire round trip and agree", () => {
  const left = createEphemeralKeyPair();
  const right = createEphemeralKeyPair();
  const raw = rawX25519PublicKey(right.publicKey);
  assert.equal(raw.length, 32);
  const shared = secureSharedSecret(left.privateKey, importX25519PublicKey(raw));
  assert.deepEqual(shared, secureSharedSecret(right.privateKey, importX25519PublicKey(rawX25519PublicKey(left.publicKey))));
  assert.throws(() => importX25519PublicKey(raw.subarray(0, 31)), /must be 32 bytes/);
});

test("key derivation is deterministic and separates every session input", () => {
  const base = {
    sharedSecret: Buffer.alloc(32, 7),
    hostId: HOST_ID,
    deviceId: "device_a",
    hostEphemeralPublicKey: "aaaa",
    deviceEphemeralPublicKey: "bbbb",
  };
  assert.deepEqual(deriveSecureTransportKeys(base), deriveSecureTransportKeys(base));
  for (const change of [
    { hostId: "other_host" },
    { deviceId: "device_b" },
    { hostEphemeralPublicKey: "cccc" },
    { deviceEphemeralPublicKey: "dddd" },
  ]) {
    assert.notDeepEqual(deriveSecureTransportKeys({ ...base, ...change }).hostToDevice, deriveSecureTransportKeys(base).hostToDevice);
  }
  assert.throws(() => deriveSecureTransportKeys({ ...base, sharedSecret: Buffer.alloc(16) }), /must be 32 bytes/);
});

test("frame and handshake parsing rejects malformed input", () => {
  assert.equal(parseSecureFrame({ kind: "request" }), null);
  assert.throws(() => parseSecureFrame({ kind: "secure", counter: -1, ciphertext: "aa" }), /counter is invalid/);
  assert.throws(() => parseSecureFrame({ kind: "secure", counter: 1.5, ciphertext: "aa" }), /counter is invalid/);
  assert.throws(() => parseSecureFrame({ kind: "secure", counter: 0, ciphertext: "" }), /ciphertext is invalid/);
  assert.equal(parseSecureHandshakeAccept({ kind: "request" }), null);
  assert.throws(() => parseSecureHandshakeAccept({ kind: "secure_handshake", scheme: "rot13" }), /scheme is not supported/);
  assert.throws(() => openSecureFrame(Buffer.alloc(32), "device-to-host", { kind: "secure", counter: 0, ciphertext: "AA" }), /too short to authenticate/);
});

test("the signed bind covers every value that identifies a session", () => {
  const bind = handshakeBind({ role: "device", hostId: HOST_ID, deviceId: "device_a", hostEphemeralPublicKey: "aaaa", deviceEphemeralPublicKey: "bbbb" });
  const text = bind.toString("utf8");
  for (const value of ["tethoq-secure-transport-handshake", HOST_ID, "device_a", "aaaa", "bbbb", "device"]) {
    assert.ok(text.includes(value), `the handshake bind must cover ${value}`);
  }
  assert.notDeepEqual(bind, handshakeBind({ role: "host", hostId: HOST_ID, deviceId: "device_a", hostEphemeralPublicKey: "aaaa", deviceEphemeralPublicKey: "bbbb" }));
});
