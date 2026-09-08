import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeGlobalSessionId } from "../../../packages/protocol/src/index.js";
import {
  QueueDeliveryStore,
  queueDeliveryContentHash,
  queueDeliveryPayloadHash,
  validateQueueDeliveryState,
  type QueueDeliveryRecord,
} from "./queue_delivery_store.js";

function delivery(overrides: Partial<QueueDeliveryRecord> = {}): QueueDeliveryRecord {
  const base = {
    source: "queue" as const,
    deliveryId: "queue_delivery_record_1",
    requestId: "queue_delivery_request_1",
    messageId: "queued_1",
    sessionId: makeGlobalSessionId("host-queue-store", "codex", "thread-1"),
    providerId: "codex",
    providerSessionId: "thread-1",
    providerOwned: false,
    mode: "steer" as const,
    content: "Do this once",
    queuedCreatedAt: "2026-09-03T10:00:00.000Z",
    attachments: [{ name: "proof.png", mimeType: "image/png", byteLength: 3 }],
    state: "unknown" as const,
    createdAt: "2026-09-03T10:01:00.000Z",
    updatedAt: "2026-09-03T10:01:01.000Z",
    error: "Provider acknowledgement was lost",
  };
  const candidate = { ...base, ...overrides };
  return {
    ...candidate,
    contentHash: queueDeliveryContentHash(candidate.content),
    payloadHash: queueDeliveryPayloadHash(candidate),
  };
}

test("queue delivery store round-trips durable ambiguity evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-queue-delivery-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "queue-deliveries.json");
  const first = new QueueDeliveryStore(path, "host-queue-store");
  const record = delivery();

  await first.scheduleWrite([record]);
  await first.flush();

  const second = new QueueDeliveryStore(path, "host-queue-store");
  assert.deepEqual(await second.read(), { version: 1, deliveries: [record] });
});

test("queue delivery validation rejects altered content and cross-host records", () => {
  const record = delivery();
  assert.throws(() => validateQueueDeliveryState({
    version: 1,
    deliveries: [{ ...record, content: "Changed after hashing" }],
  }, "host-queue-store"), /hash is invalid/u);
  assert.throws(() => validateQueueDeliveryState({ version: 1, deliveries: [record] }, "another-host"), /session identity is invalid/u);
});

test("queue delivery validation permits attachment-only submissions", () => {
  const record = delivery({ content: "", attachments: [{ name: "voice.mp3", mimeType: "audio/mpeg", byteLength: 42 }] });
  assert.deepEqual(validateQueueDeliveryState({ version: 1, deliveries: [record] }, "host-queue-store").deliveries, [record]);
});

test("queue delivery stores preserve goal ownership without changing legacy payload hashes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-goal-delivery-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "queue-deliveries.json");
  const legacy = delivery();
  const owned = { ...legacy, goalActivationId: "persisted-goal-activation" };
  assert.equal(queueDeliveryPayloadHash(owned), legacy.payloadHash);
  const store = new QueueDeliveryStore(path, "host-queue-store");
  await store.scheduleWrite([owned]);
  await store.flush();
  assert.deepEqual((await new QueueDeliveryStore(path, "host-queue-store").read()).deliveries, [owned]);
  for (const goalActivationId of ["", "x".repeat(257), 1]) {
    assert.throws(() => validateQueueDeliveryState({ version: 1, deliveries: [{ ...legacy, goalActivationId }] }), /goal activation ID is invalid/);
  }
});
