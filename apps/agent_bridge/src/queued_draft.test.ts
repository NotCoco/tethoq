import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, CURRENT_PROTOCOL_VERSION, type JsonObject } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { SendMessageRequest, SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { BridgeRequestRouter } from "./request_router.js";

class QueueProvider extends FakeProviderAdapter {
  readonly sends: SendMessageRequest[] = [];
  constructor() { super({ hostId: "queued-draft", providerId: "opencode", sessionCount: 1 }); }
  override hasActiveTurn() { return true; }
  override async sendMessage(_id: string, input: SendMessageRequest): Promise<SendMessageResult> {
    this.sends.push(input);
    return { accepted: true, details: [] };
  }
}

const makeBridge = (provider: QueueProvider) => new AgentBridge({ version: 1, hostId: "queued-draft", displayName: "Queued draft check", identity: createHostIdentity(), enabledProviders: [provider.providerId] }, [provider]);

test("queued Edit recovers full attachments in bounded chunks before removing exactly one row", async t => {
  const provider = new QueueProvider(), bridge = makeBridge(provider);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const files = [
    { name: "image.png", mimeType: "image/png", bytes: Buffer.alloc(800_001, 71) },
    { name: "voice.mp3", mimeType: "audio/mpeg", bytes: Buffer.from([1, 2, 3, 4]) },
    { name: "notes.md", mimeType: "text/markdown", bytes: Buffer.from("original notes") },
  ];
  const attachmentIds = files.map(({ name, mimeType, bytes }) => {
    const upload = bridge.beginAttachmentUpload({ name, mimeType, byteLength: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += upload.chunkBytes) {
      bridge.appendAttachmentChunk(upload.uploadId, offset, bytes.subarray(offset, offset + upload.chunkBytes).toString("base64"));
    }
    return bridge.completeAttachmentUpload(upload.uploadId).attachmentId;
  });
  const queued = await bridge.enqueueMessage(session.id, { requestId: "original", content: "Edit this\nSecond line", attachmentIds,
    developerInstructions: "Private guidance", metadata: { tethoqGoalObjective: "Edit this\nSecond line" } });
  const sibling = await bridge.enqueueMessage(session.id, { requestId: "sibling", content: "Leave queued" });
  const router = new BridgeRequestRouter(bridge);
  const rpc = (type: string, requestId: string, payload: JsonObject) => router.handle({ protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: requestId, requestId, hostId: "queued-draft", sentAt: new Date().toISOString(), kind: "request", type, payload });
  const read = await rpc("message_queue.draft", "read", { messageId: queued.id });
  assert.equal(read.ok, true);
  const draft = read.payload;
  assert.equal(draft.content, queued.content);
  assert.equal(draft.goal, true);
  assert.ok(JSON.stringify(draft).length < 1500, "metadata must not contain full attachment bytes");
  assert.ok(!JSON.stringify(draft).includes("Private guidance"));
  const version = draft.version as string;
  assert.equal((await bridge.readQueuedDraft(queued.id)).version, version);
  for (const [index, file] of files.entries()) {
    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const part = bridge.queuedDraftAttachment(queued.id, version, index, offset);
      assert.ok((part.dataBase64 as string).length <= 480 * 1024);
      parts.push(part.dataBase64 as string);
      offset = part.nextOffset as number | null;
    }
    assert.deepEqual(Buffer.from(parts.join(""), "base64"), file.bytes);
  }
  const chunkRequest = { messageId: queued.id, version, index: 0, offset: 0 };
  assert.equal((await rpc("message_queue.draft_attachment", "read-chunk", chunkRequest)).ok, true);
  const cancelled = await rpc("message_queue.cancel", "cancel", { messageId: queued.id, draftVersion: version });
  assert.equal(cancelled.payload.cancelled, true);
  assert.equal((await rpc("message_queue.cancel", "cancel", { messageId: queued.id, draftVersion: version })).payload.cancelled, true, "cancellation acknowledgements remain idempotent");
  assert.equal((await rpc("message_queue.draft_attachment", "read-chunk", chunkRequest)).ok, false, "attachment bytes must not be retained in the request ledger after dequeue");
  assert.deepEqual(bridge.queuedMessages(session.id).map(row => row.id), [sibling.id]);
  assert.throws(() => bridge.queuedDraftAttachment(queued.id, version, 0, 0), /changed or started sending/);
  assert.equal(provider.sends.length, 0, "Edit must not send a turn");
});

test("a stale Edit cannot remove a queued instruction changed by another client", async t => {
  const provider = new QueueProvider(), bridge = makeBridge(provider);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const queued = await bridge.enqueueMessage(session.id, { requestId: "original", content: "Before edit" });
  const draft = await bridge.readQueuedDraft(queued.id);
  await bridge.editQueuedMessage(queued.id, "Changed elsewhere");
  await assert.rejects(bridge.cancelQueuedMessage(queued.id, draft.version as string), /changed or started sending/);
  assert.equal(bridge.queuedMessages(session.id)[0]?.content, "Changed elsewhere");
  assert.equal(provider.sends.length, 0);
});
