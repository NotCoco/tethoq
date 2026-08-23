import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  CURRENT_PROTOCOL_VERSION,
  DeviceActionVerifier,
  EventDeduper,
  EventReplayBuffer,
  ExponentialBackoff,
  PairingManager,
  ProtocolValidationError,
  createDeviceIdentity,
  createHostIdentity,
  makeGlobalSessionId,
  parseEnvelope,
  parseGlobalSessionId,
  signDeviceAction,
  validateApprovalResponse,
  validateUserInputResponse,
} from "./index.js";

test("global session IDs preserve arbitrary provider-native components", () => {
  const id = makeGlobalSessionId("host/one", "provider two", "native/会話?id=7");
  assert.deepEqual(parseGlobalSessionId(id), {
    hostId: "host/one",
    providerId: "provider two",
    providerSessionId: "native/会話?id=7",
  });
  assert.throws(() => parseGlobalSessionId("only/two"), /exactly three/);
});



test("published protocol v1 JSON Schema is valid JSON and tracks the runtime version", async () => {
  const text = await readFile(join(process.cwd(), "packages", "protocol", "schema", "protocol-v1.schema.json"), "utf8");
  const schema = JSON.parse(text) as { readonly title?: unknown; readonly $defs?: Record<string, unknown> };
  assert.equal(schema.title, "Tethoq wire protocol v1");
  assert.ok(schema.$defs?.requestEnvelope);
  assert.ok(schema.$defs?.signedActionMessage);
  assert.equal(CURRENT_PROTOCOL_VERSION, 1);
});

test("runtime envelope validation rejects unknown protocol versions and non-JSON payloads", () => {
  const parsed = parseEnvelope({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: "m1",
    hostId: "host",
    sentAt: "2026-08-07T12:00:00.000Z",
    kind: "request",
    type: "sessions.refresh",
    requestId: "r1",
    payload: {},
  });
  assert.equal(parsed.kind, "request");
  assert.throws(() => parseEnvelope({ ...parsed, protocolVersion: 99 }), ProtocolValidationError);
  assert.throws(() => parseEnvelope("not-json"), ProtocolValidationError);
});

test("approval and user-input response validators require timestamps and exact shapes", () => {
  assert.deepEqual(validateApprovalResponse({ requestId: "a", choiceId: "approve", respondedAt: "2026-08-07T12:00:00Z" }), {
    requestId: "a",
    choiceId: "approve",
    respondedAt: "2026-08-07T12:00:00Z",
  });
  assert.deepEqual(validateUserInputResponse({ requestId: "i", answers: { choice: "A" }, respondedAt: "2026-08-07T12:00:00Z" }), {
    requestId: "i",
    answers: { choice: "A" },
    respondedAt: "2026-08-07T12:00:00Z",
  });
  assert.throws(() => validateApprovalResponse({ requestId: "a", choiceId: "approve", respondedAt: "today" }), /ISO-8601/);
  assert.throws(() => validateUserInputResponse({ requestId: "i", answers: [], respondedAt: "2026-08-07T12:00:00Z" }), /JSON object/);
});

test("event deduplication and replay sequencing survive out-of-order input", () => {
  const deduper = new EventDeduper(2);
  assert.equal(deduper.accept("e2"), true);
  assert.equal(deduper.accept("e1"), true);
  assert.equal(deduper.accept("e1"), false);
  assert.equal(deduper.accept("e3"), true);
  assert.equal(deduper.accept("e2"), true, "oldest event was evicted from bounded dedupe state");

  const replay = new EventReplayBuffer("host", 2);
  let notified = 0;
  const stop = replay.subscribe(() => { notified += 1; });
  replay.append({ eventId: "one", type: "message.started" });
  assert.equal(notified, 1);
  stop();
  replay.append({ eventId: "two", type: "message.delta" });
  replay.append({ eventId: "three", type: "message.completed" });
  assert.deepEqual(replay.since(0).map((event) => event.eventId), ["two", "three"]);
  assert.equal(replay.latestSequence(), 3);
  assert.deepEqual(replay.replaySince(0), {
    events: replay.since(0),
    requestedSequence: 0,
    oldestAvailableSequence: 2,
    latestSequence: 3,
    replayGap: true,
  });
  assert.equal(replay.replaySince(1).replayGap, false, "requesting immediately before the oldest event is continuous");
  assert.equal(replay.replaySince(4).replayGap, true, "a cursor from a previous bridge lifetime requires recovery");
});

test("event replay lookup preserves cursor boundaries after buffer rollover", () => {
  const replay = new EventReplayBuffer("host", 4);
  for (let index = 1; index <= 6; index += 1) {
    replay.append({ eventId: `event-${index}`, type: "message.delta" });
  }

  assert.deepEqual(replay.since(0).map((event) => event.sequence), [3, 4, 5, 6]);
  assert.deepEqual(replay.since(2).map((event) => event.sequence), [3, 4, 5, 6]);
  assert.deepEqual(replay.since(3).map((event) => event.sequence), [4, 5, 6]);
  assert.deepEqual(replay.since(5).map((event) => event.sequence), [6]);
  assert.deepEqual(replay.since(6), []);
  assert.deepEqual(replay.since(99), []);
});

test("exponential reconnect backoff is bounded and resettable", () => {
  const backoff = new ExponentialBackoff({ initialMs: 100, maximumMs: 500, multiplier: 2, jitterRatio: 0 });
  assert.deepEqual([backoff.next(), backoff.next(), backoff.next(), backoff.next()], [100, 200, 400, 500]);
  backoff.reset();
  assert.equal(backoff.next(), 100);
});

test("pairing issues host-signed credentials and verifies expiring device actions", () => {
  const host = createHostIdentity();
  const device = createDeviceIdentity("device-a");
  const manager = new PairingManager("host-a", host, 60_000);
  const payload = manager.startPairing({ now: 1_000, relayUrl: "wss://relay.example/relay", relayToken: "x".repeat(43) });
  assert.throws(() => manager.confirmPairing({
    pairingId: payload.pairingId,
    secret: payload.secret,
    shortCode: "000000" === payload.shortCode ? "000001" : "000000",
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
    now: 1_500,
  }), /verification code is invalid/);
  const credential = manager.confirmPairing({
    pairingId: payload.pairingId,
    secret: payload.secret,
    shortCode: payload.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
    now: 2_000,
  });
  const retry = manager.confirmPairing({
    pairingId: payload.pairingId,
    secret: payload.secret,
    shortCode: payload.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
    now: 2_500,
  });
  assert.deepEqual(retry, credential, "lost pairing responses can be retried idempotently by the same device identity");
  assert.equal(payload.relayToken, "x".repeat(43));

  const verifier = new DeviceActionVerifier(manager);
  const action = signDeviceAction({
    credential,
    action: { type: "approval.respond", requestId: "approval-a" },
    devicePrivateKeyPem: device.privateKeyPem,
    issuedAt: new Date(3_000).toISOString(),
    expiresAt: new Date(10_000).toISOString(),
    actionId: "action-a",
  });
  assert.deepEqual(verifier.verify(action, 4_000).action, { type: "approval.respond", requestId: "approval-a" });
  assert.throws(() => verifier.verify(action, 4_001), /already been used/);
});

test("revocation and persisted pairing state remain authoritative after restart", () => {
  const host = createHostIdentity();
  const device = createDeviceIdentity("device-b");
  const manager = new PairingManager("host-b", host, 60_000);
  const payload = manager.startPairing({ now: 1_000 });
  const credential = manager.confirmPairing({ pairingId: payload.pairingId, secret: payload.secret, shortCode: payload.shortCode, deviceId: device.deviceId, devicePublicKeyPem: device.publicKeyPem, now: 2_000 });
  const state = manager.exportState();
  const restored = new PairingManager("host-b", host, 60_000, state);
  assert.equal(restored.verifyCredential(credential).deviceId, "device-b");
  assert.equal(restored.revoke(state.devices[0]!.credentialId), true);
  assert.throws(() => restored.verifyCredential(credential), /revoked/);
});
