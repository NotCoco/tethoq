import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createManualClock } = require("../scripts/fake-model/deterministic-clock.cjs");
const { createFakeModelHost } = require("../scripts/fake-model/fake-model-host.cjs");
const { FEATURE_CONTRACT, evaluateFeatureCoverage } = require("../scripts/fake-model/coverage-contract.cjs");

const appRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const scriptsRoot = join(appRoot, "scripts");
const srcRoot = join(appRoot, "src");

function collectHost() {
  const clock = createManualClock("2026-08-21T12:00:00.000Z");
  const batches = [];
  const host = createFakeModelHost({ clock, onBatch: (batch) => batches.push(batch) });
  return { clock, host, batches };
}

function events(hostState) {
  return hostState.batches.flatMap((batch) => batch.events);
}

function completeUpload(host, { name, mimeType, bytes, durationSeconds }) {
  const begin = host.handleRequest("attachment.upload.begin", {
    name,
    mimeType,
    byteLength: bytes.length,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  });
  assert.equal(begin.ok, true);
  const chunk = host.handleRequest("attachment.upload.chunk", {
    uploadId: begin.payload.uploadId,
    offset: 0,
    dataBase64: bytes.toString("base64"),
  });
  assert.equal(chunk.ok, true);
  const complete = host.handleRequest("attachment.upload.complete", { uploadId: begin.payload.uploadId });
  assert.equal(complete.ok, true);
  return complete.payload.attachmentId;
}

test("fake model: the master scenario is fully deterministic", () => {
  const first = collectHost();
  const second = collectHost();
  const content = "run the fake model stream";
  first.host.handleRequest("session.send_message", { sessionId: "fake-main", content });
  second.host.handleRequest("session.send_message", { sessionId: "fake-main", content });
  first.clock.advance(10_000);
  second.clock.advance(10_000);
  const snapshot = (hostState) => ({
    events: events(hostState).map((event) => ({ type: event.type, payload: event.payload, sessionId: event.sessionId })),
    history: hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages,
  });
  assert.deepEqual(snapshot(first), snapshot(second), "two identical plays produced different events or history");
});

test("fake model: history uses a real reverse cursor instead of claiming older pages are exhausted", () => {
  const hostState = collectHost();
  const recent = hostState.host.handleRequest("session.open", { sessionId: "fake-main", limit: 40 }).payload;
  assert.equal(recent.messages.length, 40);
  assert.equal(recent.nextCursor, "3", "the 43-message fixture must expose its older boundary");
  const older = hostState.host.handleRequest("session.open", { sessionId: "fake-main", cursor: recent.nextCursor, limit: 40 }).payload;
  assert.equal(older.messages.length, 3);
  assert.equal(older.messages[0].providerMessageId, "fake-fixture-0");
  assert.equal(older.nextCursor, null);
});

test("fake model: master scenario covers streamed reasoning, tools, commands, final answer, completion", () => {
  const hostState = collectHost();
  hostState.host.handleRequest("session.send_message", { sessionId: "fake-main", content: "run the fake model stream" });
  hostState.clock.advance(10_000);
  const types = events(hostState).map((event) => event.type);
  assert.ok(types.includes("message.started"), "user echo is missing");
  assert.ok(types.filter((type) => type === "message.delta").length >= 8, "streamed deltas are missing");
  assert.ok(types.includes("tool.started") && types.includes("tool.completed"), "tool events are missing");
  assert.ok(types.includes("command.started") && types.includes("command.output") && types.includes("command.completed"), "command events are missing");
  assert.ok(types.includes("message.completed"), "message completion is missing");
  assert.ok(types.includes("agent.completed"), "agent completion is missing");
  const reasoningDeltas = events(hostState).filter((event) => event.type === "message.delta" && event.payload.partType === "reasoning");
  assert.ok(reasoningDeltas.length >= 4, "reasoning deltas are missing");
  const answerDeltas = events(hostState).filter((event) => event.type === "message.delta" && event.payload.phase === "final_answer");
  assert.ok(answerDeltas.length >= 5, "final answer deltas are missing");
});

test("fake model: terminal history race releases one final answer after completion", () => {
  const hostState = collectHost();
  const sent = hostState.host.handleRequest("session.send_message", {
    sessionId: "fake-main",
    content: "restart mid-turn terminal history race",
  });
  assert.equal(sent.ok, true);

  hostState.clock.advance(500);
  const beforeReleaseState = hostState.host.stateForTests();
  assert.equal(beforeReleaseState.playing, null, "terminal provider state kept the fake turn active");
  assert.equal(beforeReleaseState.deferredTerminal.scenarioId, "fake-scenario-terminal-history");
  assert.equal(beforeReleaseState.sessions.find((session) => session.id === "fake-main").state, "completed");
  assert.equal(beforeReleaseState.executionRecords.at(-1).status, "completed");
  const beforeRelease = beforeReleaseState.messagesBySession.get("fake-main").filter((message) => message.nativeMetadata.fakeExecution?.runId === sent.payload.runId);
  assert.equal(beforeRelease.some((message) => message.nativeMetadata.phase === "final_answer"), false, "final answer became visible before persisted-history release");
  assert.equal(beforeRelease.find((message) => message.role === "assistant")?.status, "streaming");
  assert.ok(events(hostState).some((event) => event.type === "agent.completed"), "terminal event is missing");
  assert.equal(events(hostState).some((event) => event.type === "message.completed" && event.payload.phase === "final_answer"), false, "final answer arrived through a live event");

  const released = hostState.host.releaseDeferredFinalHistoryForTests();
  assert.equal(released.released, true);
  assert.equal(released.canonicalMessageCount, 3);
  const canonical = hostState.host.stateForTests().messagesBySession.get("fake-main").filter((message) => message.nativeMetadata.fakeExecution?.runId === sent.payload.runId);
  assert.equal(canonical.filter((message) => message.nativeMetadata.phase === "final_answer").length, 1);
  assert.equal(canonical.find((message) => message.nativeMetadata.phase === "final_answer").parts[0].text, "The final reply arrived through persisted history after the terminal event.");
  assert.equal(canonical.filter((message) => message.role === "user").length, 1);

  const reordered = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages.filter((message) => message.nativeMetadata.fakeExecution?.runId === sent.payload.runId);
  const duplicated = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages.filter((message) => message.nativeMetadata.fakeExecution?.runId === sent.payload.runId);
  assert.notDeepEqual(reordered.map((message) => message.providerMessageId), canonical.map((message) => message.providerMessageId), "history replay was not reordered");
  assert.equal(duplicated.filter((message) => message.nativeMetadata.phase === "final_answer").length, 2, "duplicate history replay did not exercise answer reconciliation");
  assert.equal(hostState.host.stateForTests().messagesBySession.get("fake-main").filter((message) => message.nativeMetadata.fakeExecution?.runId === sent.payload.runId && message.nativeMetadata.phase === "final_answer").length, 1, "duplicate replay mutated canonical history");
});

test("fake model: settled history keeps the live stream identities", () => {
  const hostState = collectHost();
  hostState.host.handleRequest("session.send_message", { sessionId: "fake-main", content: "run the fake model stream" });
  hostState.clock.advance(10_000);
  const messages = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages;
  const ids = new Set(messages.map((message) => message.providerMessageId));
  const userEcho = events(hostState).find((event) => typeof event.payload?.messageId === "string" && event.payload.messageId.endsWith("-fake-stream-user"));
  assert.ok(userEcho, "the stream did not publish its user identity");
  const runPrefix = userEcho.payload.messageId.slice(0, -"-fake-stream-user".length);
  for (const part of ["user", "reasoning", "tool", "command", "answer"]) {
    const id = `${runPrefix}-fake-stream-${part}`;
    assert.ok(ids.has(id), `history lost the live identity ${id}`);
  }
  const state = hostState.host.stateForTests();
  assert.equal(state.sessions.find((session) => session.id === "fake-main").state, "idle");
  const userMessages = messages.filter((message) => message.providerMessageId === `${runPrefix}-fake-stream-user`);
  assert.equal(userMessages.length, 1, "user message duplicated in history");
});

test("fake model: error scenario fails deterministically and records the failure", () => {
  const hostState = collectHost();
  hostState.host.handleRequest("session.send_message", { sessionId: "fake-main", content: "run the error scenario" });
  hostState.clock.advance(10_000);
  const types = events(hostState).map((event) => event.type);
  assert.ok(types.includes("agent.error"), "agent.error is missing");
  const error = events(hostState).find((event) => event.type === "agent.error");
  assert.match(error.payload.message, /Deterministic failure/u);
  assert.equal(hostState.host.stateForTests().sessions.find((session) => session.id === "fake-main").state, "failed");
});

test("fake model: approval gates the stream until the decision lands", () => {
  const hostState = collectHost();
  hostState.host.handleRequest("session.send_message", { sessionId: "fake-main", content: "run the approval scenario" });
  hostState.clock.advance(5_000);
  let types = events(hostState).map((event) => event.type);
  assert.ok(types.includes("approval.requested"), "approval.requested is missing");
  assert.ok(!types.includes("agent.completed"), "the turn completed before the approval decision");
  const listed = hostState.host.handleRequest("approval.list", {}).payload.approvals;
  assert.equal(listed.length, 1, "the pending approval is not listed");
  const response = hostState.host.handleRequest("approval.respond", { requestId: "fake-approval-request", choiceId: "approve" });
  assert.equal(response.ok, true);
  hostState.clock.advance(5_000);
  types = events(hostState).map((event) => event.type);
  assert.ok(types.includes("approval.resolved"), "approval.resolved is missing");
  assert.ok(types.includes("message.completed") && types.includes("agent.completed"), "the stream did not resume after approval");
  assert.equal(hostState.host.handleRequest("approval.list", {}).payload.approvals.length, 0, "the approval stayed pending");
  const messages = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages;
  assert.ok(messages.some((message) => message.providerMessageId === "fake-approval-answer"), "approval answer is missing from history");
});

test("fake model: queue enqueue, steer delivery, and queue drain are deterministic", () => {
  const hostState = collectHost();
  hostState.host.handleRequest("session.send_message", { sessionId: "fake-main", content: "run the queue scenario" });
  hostState.clock.advance(2_000);
  const enqueued = hostState.host.handleRequest("message_queue.enqueue", { sessionId: "fake-main", content: "Queued follow-up instruction" }).payload.message;
  assert.equal(enqueued.state, "queued");
  assert.equal(hostState.host.handleRequest("message_queue.list", { sessionId: "fake-main" }).payload.messages.length, 1);
  hostState.clock.advance(100);
  const delivered = hostState.host.handleRequest("message_queue.deliver", { messageId: enqueued.id, mode: "steer" });
  assert.equal(delivered.ok, true);
  assert.equal(hostState.host.handleRequest("message_queue.list", { sessionId: "fake-main" }).payload.messages.length, 0, "the queue did not drain");
  hostState.clock.advance(3_000);
  const types = events(hostState).map((event) => event.type);
  assert.ok(types.includes("message.queued"), "message.queued is missing");
  assert.ok(types.filter((type) => type === "message.queue_removed").length >= 1, "message.queue_removed is missing");
  assert.ok(events(hostState).some((event) => event.payload.messageId?.endsWith("-fake-steer-user")), "steered user echo is missing");
  hostState.clock.advance(30_000);
  assert.equal(hostState.host.stateForTests().sessions.find((session) => session.id === "fake-main").state, "idle");
});

test("fake model: queue management preserves item identity, sibling order, and failed delivery", () => {
  const hostState = collectHost();
  const queued = ["Queue sibling A", "Queue sibling B", "Queue sibling C"].map((content) =>
    hostState.host.handleRequest("message_queue.enqueue", { sessionId: "fake-main", content }).payload.message);

  const edited = hostState.host.handleRequest("message_queue.edit", { messageId: queued[1].id, content: "Queue sibling B edited" });
  assert.equal(edited.ok, true);
  assert.deepEqual(hostState.host.stateForTests().queue.map((message) => [message.id, message.content]), [
    [queued[0].id, "Queue sibling A"],
    [queued[1].id, "Queue sibling B edited"],
    [queued[2].id, "Queue sibling C"],
  ]);
  assert.ok(events(hostState).some((event) => event.type === "message.queue_updated" && event.payload.message?.id === queued[1].id));

  hostState.host.failNextRequestForTests("message_queue.deliver", "Injected delivery failure.");
  const failed = hostState.host.handleRequest("message_queue.deliver", { messageId: queued[1].id, mode: "steer" });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /Injected delivery failure/u);
  assert.deepEqual(hostState.host.stateForTests().queue.map((message) => message.id), queued.map((message) => message.id));

  const removed = hostState.host.handleRequest("message_queue.cancel", { messageId: queued[1].id });
  assert.equal(removed.payload.cancelled, true);
  assert.deepEqual(hostState.host.stateForTests().queue.map((message) => message.id), [queued[0].id, queued[2].id]);
});

test("fake model: moving one queued item starts a task with its own content and selection", () => {
  const hostState = collectHost();
  const queued = ["Move sibling A", "Move this exact middle instruction", "Move sibling C"].map((content) =>
    hostState.host.handleRequest("message_queue.enqueue", { sessionId: "fake-main", content }).payload.message);
  const moved = hostState.host.handleRequest("message_queue.move_to_new_task", {
    messageId: queued[1].id,
    providerId: "fake",
    modelId: "fake/deterministic-v1",
    reasoningEffort: "high",
  });

  assert.equal(moved.ok, true);
  assert.equal(moved.payload.session.title, "Move this exact middle instruction");
  assert.equal(moved.payload.session.preview, "Move this exact middle instruction");
  assert.equal(moved.payload.session.providerId, "fake");
  assert.equal(moved.payload.session.modelId, "fake/deterministic-v1");
  assert.equal(moved.payload.session.reasoningEffort, "high");
  assert.deepEqual(hostState.host.stateForTests().queue.map((message) => message.id), [queued[0].id, queued[2].id]);
  hostState.clock.advance(20_000);
  const history = hostState.host.handleRequest("session.open", { sessionId: moved.payload.session.id }).payload.messages;
  assert.ok(history.some((message) => message.role === "user" && message.parts.some((part) => part.text === "Move this exact middle instruction")));
});

test("fake model: queued side chat consumes only its item, lists, and can be reopened", () => {
  const hostState = collectHost();
  const queued = ["Side sibling A", "Open this exact middle instruction in side chat", "Side sibling C"].map((content) =>
    hostState.host.handleRequest("message_queue.enqueue", { sessionId: "fake-main", content }).payload.message);

  hostState.host.failNextRequestForTests("side_chat.create", "Injected side-chat failure.");
  const failed = hostState.host.handleRequest("side_chat.create", { parentSessionId: "fake-main", queuedMessageId: queued[1].id });
  assert.equal(failed.ok, false);
  assert.deepEqual(hostState.host.stateForTests().queue.map((message) => message.id), queued.map((message) => message.id));

  const created = hostState.host.handleRequest("side_chat.create", { parentSessionId: "fake-main", queuedMessageId: queued[1].id });
  assert.equal(created.ok, true);
  assert.equal(created.payload.session.preview, "Open this exact middle instruction in side chat");
  assert.deepEqual(hostState.host.stateForTests().queue.map((message) => message.id), [queued[0].id, queued[2].id]);
  assert.deepEqual(hostState.host.handleRequest("side_chat.list", { parentSessionId: "fake-main" }).payload.sessions.map((session) => session.id), [created.payload.session.id]);
  assert.deepEqual(hostState.host.handleRequest("session.side_chats", { sessionId: "fake-main", parentSessionId: "fake-main" }).payload.sessions.map((session) => session.id), [created.payload.session.id]);
  hostState.clock.advance(20_000);
  const history = hostState.host.handleRequest("session.open", { sessionId: created.payload.session.id }).payload.messages;
  assert.ok(history.some((message) => message.role === "user" && message.parts.some((part) => part.text === "Open this exact middle instruction in side chat")));
});

test("fake model: the long history fixture is scrollable material and attachments render through real parts", () => {
  const hostState = collectHost();
  const main = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages;
  assert.ok(main.length >= 40, `expected a long fixture history, got ${main.length}`);
  const liveStart = Date.parse(hostState.clock.nowIso());
  assert.ok(main.every((message) => Date.parse(message.createdAt) < liveStart), "fixture history must be entirely earlier than the live turn");
  const side = hostState.host.handleRequest("session.open", { sessionId: "fake-side" }).payload.messages;
  const parts = side.flatMap((message) => message.parts);
  assert.ok(parts.some((part) => part.type === "image" && typeof part.uri === "string"), "image attachment part is missing");
  assert.ok(parts.some((part) => part.type === "audio" && typeof part.uri === "string"), "audio attachment part is missing");
  assert.ok(parts.some((part) => part.type === "file"), "file attachment part is missing");
  assert.ok(parts.some((part) => part.type === "file_change"), "file-change part is missing");
});

test("fake model: audio-only upload reaches one real turn with retained MP3 bytes", () => {
  const hostState = collectHost();
  const bytes = Buffer.alloc(96 * 1024, 7);
  const started = hostState.host.handleRequest("attachment.upload.begin", { name: "recording.mp3", mimeType: "audio/mpeg", byteLength: bytes.length }).payload;
  let offset = 0;
  for (const chunk of [bytes.subarray(0, 32 * 1024), bytes.subarray(32 * 1024, 64 * 1024), bytes.subarray(64 * 1024)]) {
    const response = hostState.host.handleRequest("attachment.upload.chunk", { uploadId: started.uploadId, offset, dataBase64: chunk.toString("base64") });
    assert.equal(response.ok, true);
    offset += chunk.length;
  }
  const completed = hostState.host.handleRequest("attachment.upload.complete", { uploadId: started.uploadId }).payload;
  const sent = hostState.host.handleRequest("session.send_message", { sessionId: "fake-provider-parented", content: "", attachmentIds: [completed.attachmentId] });
  assert.equal(sent.ok, true);
  hostState.clock.advance(2_000);

  const upload = hostState.host.stateForTests().completedUploads.get(completed.attachmentId);
  assert.equal(upload.mimeType, "audio/mpeg");
  assert.equal(Buffer.from(upload.dataBase64, "base64").equals(bytes), true);
  const history = hostState.host.handleRequest("session.open", { sessionId: "fake-provider-parented" }).payload.messages;
  assert.equal(history.filter((message) => message.role === "user").length, 1);
  assert.equal(history.find((message) => message.role === "user")?.parts[0]?.type, "audio");
  assert.match(history.find((message) => message.nativeMetadata?.phase === "final_answer")?.parts[0]?.text ?? "", /Fresh fake audio response run-/u);
});

test("fake model: mixed outgoing content keeps text and MIME-specific attachment order", () => {
  const hostState = collectHost();
  const imageId = completeUpload(hostState.host, { name: "layout.png", mimeType: "image/png", bytes: Buffer.from("png-bytes") });
  const audioId = completeUpload(hostState.host, { name: "note.mp3", mimeType: "audio/mpeg", bytes: Buffer.from("mp3-bytes"), durationSeconds: 1.25 });
  const fileId = completeUpload(hostState.host, { name: "notes.md", mimeType: "text/markdown", bytes: Buffer.from("# notes") });

  const sent = hostState.host.handleRequest("session.send_message", {
    sessionId: "fake-provider-parented",
    content: "Review these in order.",
    attachmentIds: [imageId, audioId, fileId],
  });
  assert.equal(sent.ok, true);
  hostState.clock.advance(2_000);

  const user = hostState.host.handleRequest("session.open", { sessionId: "fake-provider-parented" }).payload.messages.find((message) => message.role === "user");
  assert.deepEqual(user.parts.map((part) => part.type), ["text", "image", "audio", "file"]);
  assert.equal(user.parts[0].text, "Review these in order.");
  assert.equal(user.parts[1].name, "layout.png");
  assert.match(user.parts[1].uri, /^data:image\/png;base64,/u);
  assert.equal(user.parts[2].name, "note.mp3");
  assert.equal(user.parts[2].durationSeconds, 1.25);
  assert.match(user.parts[2].uri, /^data:audio\/mpeg;base64,/u);
  assert.deepEqual(user.parts[3], { type: "file", name: "notes.md", mimeType: "text/markdown" });
});

test("fake model: selected model and reasoning are recorded in execution and history metadata", () => {
  const hostState = collectHost();
  const sent = hostState.host.handleRequest("session.send_message", {
    sessionId: "fake-main",
    content: "run the fake model stream",
    modelId: "direct/vision-audio",
    reasoningEffort: "high",
  });
  assert.equal(sent.ok, true);
  const running = hostState.host.stateForTests();
  assert.deepEqual(running.executionRecords.at(-1), {
    sessionId: "fake-main",
    runId: sent.payload.runId,
    scenarioId: "fake-scenario-stream",
    providerId: "fake",
    modelId: "direct/vision-audio",
    reasoningEffort: "high",
    startedAt: "2026-08-21T12:00:00.000Z",
    status: "working",
  });
  assert.equal(running.sessions.find((session) => session.id === "fake-main").nativeMetadata.fakeExecution.modelId, "direct/vision-audio");
  const inFlight = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages.at(-1);
  assert.equal(inFlight.nativeMetadata.fakeExecution.reasoningEffort, "high");

  hostState.clock.advance(10_000);
  const settled = hostState.host.stateForTests();
  assert.equal(settled.executionRecords.at(-1).status, "completed");
  const answer = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages.find((message) => message.nativeMetadata.fakeExecution?.runId === sent.payload.runId && message.nativeMetadata.phase === "final_answer");
  assert.equal(answer.nativeMetadata.fakeExecution.modelId, "direct/vision-audio");
  assert.equal(answer.nativeMetadata.fakeExecution.reasoningEffort, "high");
});

test("fake model: queued mixed attachments keep bounded previews through edit, delivery, and move", () => {
  const hostState = collectHost();
  const imageId = completeUpload(hostState.host, { name: "queued.png", mimeType: "image/png", bytes: Buffer.from("queued-image") });
  const audioId = completeUpload(hostState.host, { name: "queued.mp3", mimeType: "audio/mpeg", bytes: Buffer.from("queued-audio"), durationSeconds: 2 });
  const fileId = completeUpload(hostState.host, { name: "queued.md", mimeType: "text/markdown", bytes: Buffer.from("queued-file") });
  const queued = hostState.host.handleRequest("message_queue.enqueue", {
    sessionId: "fake-provider-parented",
    content: "Queued mixed instruction",
    attachmentIds: [imageId, audioId, fileId],
    modelId: "direct/vision-audio",
    reasoningEffort: "high",
  }).payload.message;
  assert.deepEqual(queued.attachments.map((attachment) => attachment.name), ["queued.png", "queued.mp3", "queued.md"]);
  assert.ok(queued.attachments[0].dataUrl.startsWith("data:image/png;base64,"));
  assert.ok(queued.attachments[1].dataUrl.startsWith("data:audio/mpeg;base64,"));
  assert.equal(queued.attachments[1].durationSeconds, 2);
  assert.equal("dataUrl" in queued.attachments[2], false);

  const edited = hostState.host.handleRequest("message_queue.edit", { messageId: queued.id, content: "Edited queued mixed instruction" });
  assert.equal(edited.ok, true);
  assert.deepEqual(edited.payload.message.attachments, queued.attachments);
  assert.deepEqual(hostState.host.handleRequest("message_queue.list", {}).payload.messages[0].attachments, queued.attachments);
  assert.equal(hostState.host.stateForTests().queueAttachmentIds.get(queued.id).length, 3);

  const delivered = hostState.host.handleRequest("message_queue.deliver", { messageId: queued.id, mode: "send" });
  assert.equal(delivered.ok, true);
  assert.equal(hostState.host.stateForTests().queueAttachmentIds.has(queued.id), false);
  hostState.clock.advance(2_000);
  const deliveredUser = hostState.host.handleRequest("session.open", { sessionId: "fake-provider-parented" }).payload.messages.find((message) => message.role === "user" && message.parts.some((part) => part.name === "queued.png"));
  assert.deepEqual(deliveredUser.parts.map((part) => part.type), ["text", "image", "audio", "file"]);

  const movedQueue = hostState.host.handleRequest("message_queue.enqueue", { sessionId: "fake-provider-parented", content: "Move queued mixed instruction", attachmentIds: [imageId, audioId, fileId], modelId: "direct/vision-audio", reasoningEffort: "high" }).payload.message;
  const moved = hostState.host.handleRequest("message_queue.move_to_new_task", { messageId: movedQueue.id, providerId: "direct", modelId: "direct/vision-audio", reasoningEffort: "high" });
  assert.equal(moved.ok, true);
  assert.equal(hostState.host.stateForTests().queueAttachmentIds.has(movedQueue.id), false);
  hostState.clock.advance(2_000);
  const movedUser = hostState.host.handleRequest("session.open", { sessionId: moved.payload.session.id }).payload.messages.find((message) => message.role === "user");
  assert.deepEqual(movedUser.parts.map((part) => part.type), ["text", "image", "audio", "file"]);
  assert.equal(moved.payload.session.modelId, "direct/vision-audio");
  assert.equal(moved.payload.session.reasoningEffort, "high");
});

test("fake model: interrupt retains only emitted partial rows and never inserts the final answer", () => {
  const hostState = collectHost();
  const sent = hostState.host.handleRequest("session.send_message", { sessionId: "fake-main", content: "run the fake model stream" });
  assert.equal(sent.ok, true);
  hostState.clock.advance(1_000);
  assert.equal(hostState.host.handleRequest("session.interrupt", { sessionId: "fake-main" }).ok, true);

  const runPrefix = sent.payload.runId;
  const messages = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages.filter((message) => message.nativeMetadata.fakeExecution?.runId === runPrefix);
  assert.deepEqual(messages.map((message) => message.providerMessageId), [
    `${runPrefix}-fake-stream-user`,
    `${runPrefix}-fake-stream-reasoning`,
    `${runPrefix}-fake-stream-tool`,
    `${runPrefix}-fake-stream-command`,
  ]);
  assert.equal(messages.some((message) => message.providerMessageId === `${runPrefix}-fake-stream-answer`), false);
  assert.ok(messages.every((message) => message.status !== "streaming"));
  assert.equal(messages.find((message) => message.providerMessageId.endsWith("-command")).parts[0].output, undefined);
  assert.equal(hostState.host.stateForTests().executionRecords.at(-1).status, "interrupted");
});

test("fake model: provider onboarding and reconnect failures are explicit and recoverable", () => {
  const hostState = collectHost();
  hostState.host.setProviderStatusForTests("direct", {
    state: "offline",
    detected: true,
    authenticated: false,
    lastError: "The deterministic API key is invalid.",
  });

  let provider = hostState.host.handleRequest("provider.list", {}).payload.providers.find((candidate) => candidate.providerId === "direct");
  assert.equal(provider.state, "offline");
  assert.equal(provider.detected, true);
  assert.equal(provider.authenticated, false);
  assert.equal(provider.lastError, "The deterministic API key is invalid.");

  hostState.host.failNextRequestForTests("provider.reconnect", "Deterministic provider rate limit.", {
    retryable: true,
    details: { retryAfterMs: 1_500 },
  });
  const failed = hostState.host.handleRequest("provider.reconnect", { providerId: "direct" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.retryable, true);
  assert.deepEqual(failed.error.details, { retryAfterMs: 1_500 });

  const recovered = hostState.host.handleRequest("provider.reconnect", { providerId: "direct" });
  assert.equal(recovered.ok, true);
  provider = hostState.host.handleRequest("provider.list", {}).payload.providers.find((candidate) => candidate.providerId === "direct");
  assert.equal(provider.state, "online");
  assert.equal(provider.authenticated, true);
  assert.equal("lastError" in provider, false);
});

test("fake model: exported local state survives a host restart without losing queued attachments", () => {
  const first = collectHost();
  const attachmentId = completeUpload(first.host, {
    name: "restart-note.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("restart fixture"),
  });
  const created = first.host.handleRequest("session.create", {
    firstInstruction: "Persistent local fake task",
    modelId: "fake/deterministic-v1",
    reasoningEffort: "High",
  }).payload.session;
  const queued = first.host.handleRequest("message_queue.enqueue", {
    sessionId: created.id,
    content: "Persistent queued instruction",
    attachmentIds: [attachmentId],
    modelId: "fake/deterministic-v1",
    reasoningEffort: "High",
  }).payload.message;
  const persistedState = first.host.exportStateForTests();
  first.host.dispose();

  const clock = createManualClock("2026-08-21T12:05:00.000Z");
  const restarted = createFakeModelHost({ clock, persistedState });
  assert.equal(restarted.handleRequest("sessions.list", {}).payload.sessions.some((session) => session.id === created.id), true);
  const restoredQueue = restarted.handleRequest("message_queue.list", { sessionId: created.id }).payload.messages;
  assert.equal(restoredQueue.length, 1);
  assert.equal(restoredQueue[0].id, queued.id);
  assert.deepEqual(restoredQueue[0].attachments, [{ name: "restart-note.md", mimeType: "text/markdown", byteLength: 15 }]);

  const delivered = restarted.handleRequest("message_queue.deliver", { messageId: queued.id, mode: "send" });
  assert.equal(delivered.ok, true);
  clock.advance(2_000);
  const user = restarted.handleRequest("session.open", { sessionId: created.id }).payload.messages.find((message) => message.role === "user" && message.parts.some((part) => part.name === "restart-note.md"));
  assert.deepEqual(user.parts.map((part) => part.type), ["text", "file"]);
  assert.equal(user.parts[1].name, "restart-note.md");
  restarted.dispose();
});

test("fake model: EARS returns deterministic text instead of an upload handshake", () => {
  const hostState = collectHost();
  const bytes = Buffer.from("fake audio bytes");
  const started = hostState.host.handleRequest("attachment.upload.begin", { name: "ears-note.mp3", mimeType: "audio/mpeg", byteLength: bytes.length }).payload;
  hostState.host.handleRequest("attachment.upload.chunk", { uploadId: started.uploadId, offset: 0, dataBase64: bytes.toString("base64") });
  const completed = hostState.host.handleRequest("attachment.upload.complete", { uploadId: started.uploadId }).payload;

  const processed = hostState.host.handleRequest("ears.process", {
    providerId: "direct",
    modelId: "direct/vision-audio",
    mode: "cleaned",
    attachmentIds: [completed.attachmentId],
    requestId: "fake-ears-request",
  });

  assert.equal(processed.ok, true);
  assert.deepEqual(processed.payload, { texts: ["Deterministic EARS transcript 1: ears-note.mp3."] });
  assert.equal("uploadId" in processed.payload, false, "EARS accidentally returned an attachment-upload response");
  assert.deepEqual(hostState.host.handleRequest("ears.cancel", { requestId: "missing" }).payload, { cancelled: false });
});

test("fake model: Eyes, EARS, and Mesh reject impossible routes and keep task-local configuration", () => {
  const hostState = collectHost();
  assert.equal(hostState.host.handleRequest("session.vision.configure", {
    sessionId: "fake-main",
    selection: { providerId: "direct", modelId: "direct/text-only", reasoningEffort: "low" },
  }).ok, false, "Eyes accepted a text-only route");
  assert.equal(hostState.host.handleRequest("session.vision.configure", {
    sessionId: "fake-main",
    selection: { providerId: "direct", modelId: "direct/vision-audio", reasoningEffort: "impossible" },
  }).ok, false, "Eyes accepted an unsupported effort");
  assert.equal(hostState.host.handleRequest("session.vision.configure", {
    sessionId: "fake-main",
    selection: { providerId: "codex", modelId: "gpt-5.6-sol", reasoningEffort: "xhigh" },
  }).ok, true);
  assert.equal(hostState.host.handleRequest("session.vision.get", { sessionId: "fake-main" }).payload.vision.configured.modelId, "gpt-5.6-sol");
  assert.equal(hostState.host.handleRequest("session.vision.get", { sessionId: "fake-side" }).payload.vision.configured, null, "Eyes configuration leaked between tasks");

  assert.equal(hostState.host.handleRequest("delegation.start", {
    parentSessionId: "fake-main",
    prompt: "invalid parent target",
    targets: [{ providerId: "fake", modelId: "fake/deterministic-v1", reasoningEffort: "Low" }],
  }).ok, false, "Mesh accepted the parent harness as its own child");
  assert.equal(hostState.host.handleRequest("delegation.start", {
    parentSessionId: "fake-main",
    prompt: "duplicate providers",
    targets: [
      { providerId: "opencode", modelId: "deepseek/deepseek-v4-flash", reasoningEffort: "max" },
      { providerId: "opencode", modelId: "deepseek/deepseek-v4-pro", reasoningEffort: "max" },
    ],
  }).ok, false, "Mesh accepted duplicate provider targets");
  assert.equal(hostState.host.handleRequest("delegation.start", {
    parentSessionId: "fake-main",
    prompt: "mixed valid routes",
    targets: [
      { providerId: "direct", modelId: "direct/vision-audio", reasoningEffort: "high" },
      { providerId: "codex", modelId: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    ],
  }).ok, true, "Mesh rejected valid mixed providers and efforts");

  assert.equal(hostState.host.handleRequest("ears.process", {
    providerId: "direct", modelId: "direct/text-only", reasoningEffort: "low", attachmentIds: ["missing"],
  }).ok, false, "EARS accepted a text-only route");
  assert.equal(hostState.host.handleRequest("ears.process", {
    providerId: "grok", modelId: "grok/advertised-audio", reasoningEffort: "low", attachmentIds: ["missing"],
  }).ok, false, "EARS accepted the advertised-but-untransportable Grok route");
  const bytes = Buffer.from("not an mp3");
  const started = hostState.host.handleRequest("attachment.upload.begin", { name: "clip.webm", mimeType: "audio/webm", byteLength: bytes.length }).payload;
  hostState.host.handleRequest("attachment.upload.chunk", { uploadId: started.uploadId, offset: 0, dataBase64: bytes.toString("base64") });
  const completed = hostState.host.handleRequest("attachment.upload.complete", { uploadId: started.uploadId }).payload;
  assert.equal(hostState.host.handleRequest("ears.process", {
    providerId: "direct", modelId: "direct/vision-audio", reasoningEffort: "high", attachmentIds: [completed.attachmentId],
  }).ok, false, "EARS accepted a non-MP3 recording");
});

test("fake model: annotation transport is retained as one provider user turn", () => {
  const hostState = collectHost();
  const wire = `# Response annotations:\nEach item contains text selected from an earlier model response and a user comment.\n<response-annotations>\n[{"text":"Selected fixture answer","annotation":"Explain this plainly."}]\n</response-annotations>\n\n## My request:\n`;
  const sent = hostState.host.handleRequest("session.send_message", { sessionId: "fake-main", content: wire });
  assert.equal(sent.ok, true);
  assert.equal(hostState.host.stateForTests().requests.at(-1)?.payload.content, wire);
  hostState.clock.advance(10_000);
  const userMessages = hostState.host.handleRequest("session.open", { sessionId: "fake-main" }).payload.messages.filter((message) => message.role === "user" && message.parts.some((part) => part.text === wire));
  assert.equal(userMessages.length, 1, "the annotation envelope created duplicate provider user rows");
  assert.equal(userMessages[0].parts[0].text, wire, "the fake provider did not retain the hidden annotation envelope for bridge parsing");
});

test("fake model: context compaction thresholds persist per task and change the displayed percentage", () => {
  const hostState = collectHost();
  const initial = hostState.host.handleRequest("session.context.get", { sessionId: "fake-main" }).payload.context;
  assert.equal(initial.compactionThresholdTokens, 96_000);
  assert.equal(initial.usedPercent, 4_200 / 96_000 * 100);

  const applied = hostState.host.handleRequest("session.context.set_threshold", { sessionId: "fake-main", thresholdTokens: 40_000 }).payload.context;
  assert.equal(applied.compactionThresholdTokens, 40_000);
  assert.equal(applied.usedPercent, 10.5);
  assert.equal(hostState.host.handleRequest("session.context.get", { sessionId: "fake-main" }).payload.context.compactionThresholdTokens, 40_000);
  assert.equal(hostState.host.handleRequest("session.context.get", { sessionId: "fake-side" }).payload.context.compactionThresholdTokens, 96_000, "one task's threshold leaked into another task");
});

test("fake model: response and test snapshots do not leak nested mutable state", () => {
  const hostState = collectHost();
  const response = hostState.host.handleRequest("session.open", { sessionId: "fake-side" });
  response.payload.messages[0].parts[0].text = "mutated response";
  assert.equal(hostState.host.handleRequest("session.open", { sessionId: "fake-side" }).payload.messages[0].parts[0].text, "Review the attached fixture evidence.");

  const snapshot = hostState.host.stateForTests();
  snapshot.messagesBySession.get("fake-side")[0].parts[0].text = "mutated test snapshot";
  assert.equal(hostState.host.handleRequest("session.open", { sessionId: "fake-side" }).payload.messages[0].parts[0].text, "Review the attached fixture evidence.");
});

test("fake model: the fake host answers every desktop request without throwing", () => {
  const hostState = collectHost();
  const requests = [
    ["provider.list", {}],
    ["models.list", { providerId: "fake" }],
    ["sessions.refresh", {}],
    ["sessions.list", {}],
    ["session.open", { sessionId: "fake-side" }],
    ["session.watch", { sessionId: "fake-main" }],
    ["session.unwatch", { sessionId: "fake-main" }],
    ["session.context.get", { sessionId: "fake-main" }],
    ["session.children", { sessionId: "fake-main" }],
    ["side_chat.list", {}],
    ["user_input.list", {}],
    ["vision.targets", {}],
    ["session.vision.get", { sessionId: "fake-main" }],
    ["wallet.get", { providerId: "fake" }],
    ["dictation.source.list", {}],
    ["delegation.list", {}],
    ["sync.since", { sequence: 0 }],
  ];
  for (const [type, payload] of requests) {
    const response = hostState.host.handleRequest(type, payload);
    assert.equal(response.ok, true, `${type} failed: ${response.error?.message}`);
  }
  const bootstrap = hostState.host.bootstrap();
  assert.equal(bootstrap.host.connectionState, "online");
  assert.equal(bootstrap.providers[0].providerId, "fake");
});

async function walkSourceFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "out" || entry.name === "node_modules") continue;
      files.push(...await walkSourceFiles(path));
    } else if (/\.(ts|tsx|mts|cts)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

test("fake model isolation: production sources never import the test fixture", async () => {
  const files = await walkSourceFiles(srcRoot);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /fake-model|fake_model/u, `${file} references the fake model test fixture`);
  }
  const preload = await readFile(join(scriptsRoot, "fake-model", "preload.cjs"), "utf8");
  assert.match(preload, /require\('electron'\)/u, "the test preload must only require electron");
});

test("fake model isolation: electron-builder ships only out/**/* and package.json", async () => {
  const config = await readFile(join(appRoot, "electron-builder.yml"), "utf8");
  const filesBlock = config.match(/^files:\s*\n((?:\s+-\s+[^\n]+\n?)+)/mu);
  assert.ok(filesBlock, "electron-builder.yml has no files block");
  const entries = filesBlock[1].split("\n").map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
  assert.deepEqual(entries, ["out/**/*", "package.json"], `unexpected packaged files: ${JSON.stringify(entries)}`);
  assert.doesNotMatch(config, /scripts\/fake-model/u, "electron-builder references the test fixture");
});

test("fake model isolation: the test preload channels mirror the production IPC_CHANNELS", async () => {
  const apiSource = await readFile(join(srcRoot, "shared", "desktop_api.ts"), "utf8");
  const preloadSource = await readFile(join(scriptsRoot, "fake-model", "preload.cjs"), "utf8");
  const block = apiSource.match(/export const IPC_CHANNELS = Object\.freeze\(\{([\s\S]*?)\n\} as const\);/u);
  assert.ok(block, "IPC_CHANNELS block not found");
  const channelNames = [...block[1].matchAll(/^\s{2}(\w+):\s*"([^"]+)"/gmu)].map((match) => match[2])
    .filter((channel) => channel !== "tethoq:smoke-quit");
  assert.ok(channelNames.length >= 30, `expected the full IPC_CHANNELS set, found ${channelNames.length}`);
  for (const channel of channelNames) {
    assert.ok(preloadSource.includes(`'${channel}'`), `test preload is missing the production channel ${channel}`);
  }
});

test("fake model QA entrypoints preserve a nonzero failure status", async () => {
  const driver = await readFile(join(scriptsRoot, "fake-model-qa.cjs"), "utf8");
  const scrollShim = await readFile(join(scriptsRoot, "scroll-stability-qa.cjs"), "utf8");
  assert.match(driver, /FAKE_MODEL_QA_FORCE_FAILURE/u, "the process-status self-test seam is missing");
  assert.match(driver, /app\.exit\(exitCode\)/u, "the fake-model driver does not exit with its recorded status");
  assert.match(scrollShim, /app\.exit\(exitCode\)/u, "the scroll shim does not exit with its recorded status");
  assert.doesNotMatch(driver, /app\.quit\(\)/u, "graceful quit can win before a failure status is applied");
  assert.doesNotMatch(scrollShim, /app\.quit\(\)/u, "graceful quit can win before a failure status is applied");
  assert.match(driver, /onlyScenario !== null && scenarios\.length === 0/u, "unknown focused scenarios must fail instead of silently passing");
});

test("fake model coverage contract reports every missing user-visible feature id", () => {
  assert.ok(FEATURE_CONTRACT.length >= 45, `coverage inventory is unexpectedly small: ${FEATURE_CONTRACT.length}`);
  assert.equal(new Set(FEATURE_CONTRACT.map((feature) => feature.id)).size, FEATURE_CONTRACT.length, "coverage feature ids must be unique");
  const scenarios = [...new Set(FEATURE_CONTRACT.map((feature) => feature.scenario))];
  const evidenceFor = (scenario) => Object.fromEntries(FEATURE_CONTRACT
    .filter((feature) => feature.scenario === scenario)
    .map((feature) => [feature.id, { passed: true, observed: { scenario } }]));
  const complete = evaluateFeatureCoverage(Object.fromEntries(scenarios.map((scenario) => [scenario, { passed: true, featureEvidence: evidenceFor(scenario) }])), []);
  assert.equal(complete.missingFeatureIds.length, 0);
  assert.equal(complete.coveredFeatureIds.length, FEATURE_CONTRACT.length);

  const nonThrowingOnly = evaluateFeatureCoverage(Object.fromEntries(scenarios.map((scenario) => [scenario, { passed: true }])), []);
  assert.deepEqual(nonThrowingOnly.coveredFeatureIds, [], "a merely non-throwing scenario must not claim feature coverage");
  assert.equal(nonThrowingOnly.missingFeatureIds.length, FEATURE_CONTRACT.length);

  const failedScenario = evaluateFeatureCoverage(Object.fromEntries(scenarios.map((scenario, index) => [scenario, { passed: index !== 0, featureEvidence: evidenceFor(scenario) }])), []);
  assert.deepEqual(failedScenario.missingFeatureIds, FEATURE_CONTRACT.filter((feature) => feature.scenario === scenarios[0]).map((feature) => feature.id));

  const omittedScenario = scenarios[0];
  const incomplete = evaluateFeatureCoverage(Object.fromEntries(scenarios.slice(1).map((scenario) => [scenario, { passed: true, featureEvidence: evidenceFor(scenario) }])), []);
  assert.deepEqual(incomplete.missingFeatureIds, FEATURE_CONTRACT.filter((feature) => feature.scenario === omittedScenario).map((feature) => feature.id));
  assert.ok(incomplete.missingFeatureIds.length > 0, "omitting a required journey did not fail feature coverage");
});
