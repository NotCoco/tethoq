import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-composer-${process.pid}-${Date.now()}`);
const helperBundle = join(outputDirectory, "helpers.mjs");
const timelineBundle = join(outputDirectory, "timeline.mjs");
const composerUiBundle = join(outputDirectory, "composer-ui.mjs");
const modelHydrationBundle = join(outputDirectory, "model-hydration.mjs");
const inlineWorkerStubPlugin = {
  name: "inline-worker-stub",
  setup(buildContext) {
    buildContext.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, namespace: "inline-worker-stub" }));
    buildContext.onLoad({ filter: /.*/, namespace: "inline-worker-stub" }, () => ({
      contents: "export default class InlineWorkerStub { constructor() { throw new Error('Workers are not started by unit tests'); } }",
      loader: "js",
    }));
  },
};
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "composer_helpers.ts")],
  outfile: helperBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  plugins: [inlineWorkerStubPlugin],
});
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "ChatTimeline.tsx")],
  outfile: timelineBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  plugins: [inlineWorkerStubPlugin],
});
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "Composer.tsx")],
  outfile: composerUiBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  loader: { ".css": "empty" },
  plugins: [inlineWorkerStubPlugin],
});
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "model_hydration.ts")],
  outfile: modelHydrationBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
// The composer reaches the bridge module now, and that module reads `window` as it
// loads. Nothing here renders, so a bare stand-in is enough to import it.
globalThis.window ??= { location: { hash: "" }, addEventListener() {}, removeEventListener() {} };
globalThis.location ??= globalThis.window.location;
const helpers = await import(`file:///${helperBundle.replaceAll("\\", "/")}`);
const timelineHelpers = await import(`file:///${timelineBundle.replaceAll("\\", "/")}`);
const composerUi = await import(`file:///${composerUiBundle.replaceAll("\\", "/")}`);
const modelHydration = await import(`file:///${modelHydrationBundle.replaceAll("\\", "/")}`);

test("assistant memory citations stay out of replies and copied answers", () => {
  const answer = "The preview belongs to the footage.\n\nThe main sequence is visible.";
  const entries = "<citation_entries>\nMEMORY.md:10-12|note=[Verified `preview` context]\n</citation_entries>\n<rollout_ids>\n00000000-0000-4000-8000-000000000001\n</rollout_ids>";
  const citation = `<oai-mem-citation>\n${entries}\n</oai-mem-citation>`;
  const row = (id, kind, body) => ({ id, kind, body, phase: "final_answer", state: "completed", timestamp: "2026-09-06T12:00:00Z" });
  for (const suffix of [citation, entries, `<oai-mem-citation>\n${entries}`, "<citation_entries>\nMEMORY.md:10-12"]) {
    const message = row("answer", "assistant", `${answer}\n\n${suffix}`);
    assert.equal(timelineHelpers.visibleAssistantText(message.body), answer);
    assert.equal(timelineHelpers.finalAnswerCopyText([row("user", "user", "Inspect this preview."), message], 1), answer);
    assert.equal(timelineHelpers.hasVisibleTimelineContent(row("metadata", "assistant", suffix)), false);
  }
  assert.equal(timelineHelpers.visibleAssistantText(`${citation}\n\n${answer}`), `\n\n${answer}`);
  assert.equal(timelineHelpers.hasVisibleTimelineContent(row("user", "user", `Explain this markup:\n${citation}`)), true);
});

test("assistant memory citation filtering preserves Markdown code examples", () => {
  for (const fence of ["```", "~~~", "````"]) {
    const example = `Markup example:\n\n${fence}xml\n<oai-mem-citation>\n<citation_entries>example</citation_entries>\n</oai-mem-citation>\n${fence}\n\nOrdinary text.`;
    assert.equal(timelineHelpers.visibleAssistantText(example), example);
  }
  const inline = "Use `<citation_entries>` and `</citation_entries>` in the example.";
  assert.equal(timelineHelpers.visibleAssistantText(inline), inline);
});

test("Continue belongs only to the latest unresolved interruption", () => {
  const issue = { id: "old-issue", kind: "error", body: "Task interrupted", state: "failed", timestamp: "2026-09-06T00:00:00Z" };
  const next = (kind, body = "New work") => ({ id: "next", kind, body, state: "completed", timestamp: "2026-09-06T00:01:00Z" });
  assert.equal(timelineHelpers.recoverableTimelineNoticeId([issue]), issue.id);
  assert.equal(timelineHelpers.recoverableTimelineNoticeId([issue, next("user", "")]), issue.id, "a hidden control echo is not output");
  for (const kind of ["user", "reasoning", "assistant", "tool", "command"]) {
    assert.equal(timelineHelpers.recoverableTimelineNoticeId([issue, next(kind)]), undefined, `${kind} progressed beyond the interruption`);
  }
  assert.equal(timelineHelpers.recoverableTimelineNoticeId([issue, next("reasoning"), { ...issue, id: "new-issue" }]), "new-issue");
  assert.equal(timelineHelpers.recoverableTimelineNoticeId([{ ...issue, kind: "tool", notice: "eyes_failure" }]), issue.id);
});
test.after(async () => { await rm(outputDirectory, { recursive: true, force: true }); });

test("a quiet interruption closes transcript recovery and the next turn still starts normally", () => {
  const user = { id: "user", kind: "user", body: "Work", state: "completed" };
  const working = { id: "thought", kind: "reasoning", body: "Inspecting the task", state: "running" };
  const before = [user, working];
  const boundary = helpers.captureSessionWorkingBoundary(before);
  const stopped = [...before, { id: "stop", turnId: "turn-1", kind: "assistant", notice: "interruption", body: "Task interrupted", state: "completed" }];
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "idle" }, stopped, boundary), false);
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "idle" }, stopped, boundary), false);
  assert.equal(helpers.presentedSessionState({ state: "idle" }, stopped, boundary), "idle");
  const resumedBoundary = helpers.captureSessionWorkingBoundary(stopped);
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "working" }, stopped, resumedBoundary), true);
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "working" }, stopped, resumedBoundary), true);
});

test("EYES keeps idle parent activity live only until its own completion or a newer boundary", () => {
  const row = (id, kind, extra = {}) => ({ id, kind, body: id, state: "completed", timestamp: "2026-09-05T12:00:00.000Z", ...extra });
  const eyes = row("eyes", "tool", { notice: "eyes_inspection", state: "running" });
  const history = [row("question", "user"), row("thought", "reasoning"), eyes];
  const active = (timeline, state = "idle") => helpers.sessionPresentsLiveTurn({ state }, timeline);
  assert.equal(active(history), true);
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "idle" }, history), true);
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "idle" }, history), true);
  assert.equal(timelineHelpers.withCurrentActivity(history, active(history)).at(-1).state, "running");
  assert.equal(active([row("prior-interruption", "error"), eyes]), true, "a new Eyes call can precede the next user echo");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "idle" }, [row("prior-interruption", "error"), eyes]), true);
  assert.equal(active(history.map(item => ({ ...item, state: "completed" }))), false, "completion and explicit Stop settle Eyes");
  assert.equal(active(history.map(item => item === eyes ? { ...eyes, notice: undefined } : item)), false, "ordinary stale tools remain settled");
  for (const terminal of [
    row("next-question", "user"), row("interrupted", "error"),
    row("final", "assistant", { phase: "final_answer" }),
    row("compaction", "assistant", { title: "System", body: "Session compacted" }),
    row("eyes-failed", "tool", { notice: "eyes_failure" }),
  ]) assert.equal(active([...history, terminal]), false, terminal.id);
  for (const state of ["completed", "failed", "offline", "disconnected"]) assert.equal(active(history, state), false, state);
  assert.equal(active([...history, row("new-thought", "reasoning", { body: "The screenshot says Session compacted." })]), true, "quoted image content is not a compaction boundary");
});

test("newer model hydration wins and failed or removed catalogues preserve the last good choices", () => {
  const generations = new Map();
  const older = modelHydration.beginModelHydration(generations, ["grok"]);
  const newer = modelHydration.beginModelHydration(generations, ["grok"]);
  const available = new Set(["grok"]);
  const original = { grok: [{ id: "grok-stale", name: "Stale", efforts: [] }] };
  const fresh = { grok: [{ id: "grok-4.6", name: "Grok 4.6", efforts: [] }] };
  const afterFresh = modelHydration.mergeLatestModelCatalogues(original, available, fresh, newer, generations);
  assert.equal(afterFresh.grok[0].id, "grok-4.6");
  const afterLateOlder = modelHydration.mergeLatestModelCatalogues(afterFresh, available, original, older, generations);
  assert.strictEqual(afterLateOlder, afterFresh, "a late older request replaced the current catalogue");

  const failed = modelHydration.beginModelHydration(generations, ["grok"]);
  assert.strictEqual(modelHydration.mergeLatestModelCatalogues(afterFresh, available, {}, failed, generations), afterFresh, "a failed probe erased the last successful catalogue");
  const removed = modelHydration.beginModelHydration(generations, ["grok"]);
  assert.strictEqual(modelHydration.mergeLatestModelCatalogues(afterFresh, new Set(), fresh, removed, generations), afterFresh, "a removed provider was restored by an in-flight request");
  const empty = modelHydration.beginModelHydration(generations, ["grok"]);
  const afterEmpty = modelHydration.mergeLatestModelCatalogues(afterFresh, available, { grok: [] }, empty, generations);
  assert.deepEqual(afterEmpty.grok, [], "a successful empty catalogue was mistaken for a failed probe");
});

test("attachment upload is chunked and returns completed ids without invoking a provider", async () => {
  const calls = [];
  const request = async (type, payload) => {
    calls.push({ type, payload });
    if (type === "attachment.upload.begin") return { uploadId: "upload-1", chunkBytes: 32 * 1024 };
    if (type === "attachment.upload.complete") return { attachmentId: "attachment-1" };
    return {};
  };
  const dataBase64 = Buffer.alloc(70 * 1024, 7).toString("base64");
  const started = [];
  const ids = await helpers.uploadAttachments([{ name: "image.png", mimeType: "image/png", byteLength: 70 * 1024, dataBase64 }], request, (id) => started.push(id));

  assert.deepEqual(ids, ["attachment-1"]);
  assert.deepEqual(started, ["upload-1"]);
  assert.deepEqual(calls.map((call) => call.type), ["attachment.upload.begin", "attachment.upload.chunk", "attachment.upload.chunk", "attachment.upload.chunk", "attachment.upload.complete"]);
  const chunks = calls.filter((call) => call.type === "attachment.upload.chunk");
  assert.deepEqual(chunks.map((call) => call.payload.offset), [0, 32 * 1024 - 2, 2 * (32 * 1024 - 2)]);
  assert.deepEqual(Buffer.concat(chunks.map((call) => Buffer.from(call.payload.dataBase64, "base64"))), Buffer.alloc(70 * 1024, 7));
  assert.equal(calls.some((call) => call.type.startsWith("session.")), false);
});

test("attachment base64 chunking is byte-exact across worker boundaries", () => {
  for (const size of [0, 1, 2, 3, 48 * 1024 - 1, 48 * 1024, 48 * 1024 + 1, 1024 * 1024 + 17]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) % 256);
    assert.equal(helpers.encodeAttachmentBytesToBase64(bytes), Buffer.from(bytes).toString("base64"), `size ${size}`);
  }
});

test("an attachment worker startup failure never falls back to UI-thread encoding", async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class WorkerStandIn {};
  try {
    await assert.rejects(
      helpers.blobToUploadable(new Blob([new Uint8Array(1024)], { type: "image/png" }), "worker-failure.png"),
      /Workers are not started by unit tests/,
    );
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});

test("an idle externally-owned Codex task resumes directly without requiring Desktop to be open", async () => {
  const session = { state: "idle", externalWriter: true };
  assert.equal(helpers.sessionHoldsFollowUpQueue(session), false, "writer ownership alone must not show Stop or a working spinner");
  const requestType = helpers.composerMessageRequestType({
    liveGuidance: false,
    hasAttachments: false,
    blockedByAttention: helpers.sessionHoldsFollowUpQueue(session),
    queueingEnabled: true,
    externalWriter: session.externalWriter,
  });
  const calls = [];
  const request = async (type) => { calls.push(type); return {}; };
  await request(requestType);

  assert.deepEqual(calls, ["session.send_message"]);
  assert.equal(helpers.composerMessageRequestType({
    liveGuidance: true,
    hasAttachments: false,
    blockedByAttention: true,
    queueingEnabled: false,
    externalWriter: true,
  }), "message_queue.enqueue", "an actively owned task still uses the synchronized queue");
});

test("an idle externally-owned Codex attachment uses the provider's direct fallback path", () => {
  assert.equal(helpers.composerMessageRequestType({
    liveGuidance: false,
    hasAttachments: true,
    blockedByAttention: false,
    queueingEnabled: true,
    externalWriter: true,
  }), "session.send_message");
});

test("an idle attachment is a direct send, not a hidden queue entry", () => {
  assert.equal(helpers.composerMessageRequestType({
    liveGuidance: false,
    hasAttachments: true,
    blockedByAttention: false,
    queueingEnabled: true,
    externalWriter: false,
  }), "session.send_message");
  assert.equal(helpers.composerMessageRequestType({
    liveGuidance: false,
    hasAttachments: true,
    blockedByAttention: true,
    queueingEnabled: true,
    externalWriter: false,
  }), "message_queue.enqueue");
});

test("an idle external transport queue record stays hidden even when its event wins the response race", () => {
  const token = "transport-local-1";
  let suppressions = [{ token, content: "respond with ok" }];
  const eventBeforeResponse = [{ id: "queue-1", content: "respond with ok", state: "queued" }];

  assert.deepEqual(helpers.visibleTransportQueueMessages(eventBeforeResponse, suppressions), [], "the queue event cannot flash the transport record");
  suppressions = helpers.acknowledgeTransportQueueSuppression(suppressions, token, "queue-1");
  assert.deepEqual(helpers.visibleTransportQueueMessages(eventBeforeResponse, suppressions), [], "the enqueue acknowledgement remains hidden by id");
  assert.deepEqual(helpers.visibleTransportQueueMessages([], suppressions), [], "a stale empty list does not invalidate the authoritative suppression");
  assert.deepEqual(helpers.visibleTransportQueueMessages(eventBeforeResponse, suppressions), [], "a later queue event remains hidden after that stale read");

  const realFollowUp = [{ id: "queue-2", content: "do this after the active turn", state: "queued" }];
  assert.deepEqual(helpers.visibleTransportQueueMessages(realFollowUp, []), realFollowUp, "a genuine pending follow-up remains visible");
});

test("a genuine queued follow-up stays out of the transcript until it is delivered", () => {
  assert.equal(helpers.composerSubmissionAppearsInTranscript("message_queue.enqueue", false), false);
  assert.equal(helpers.composerSubmissionAppearsInTranscript("session.send_message", false), true);
  assert.equal(helpers.composerSubmissionAppearsInTranscript("session.steer_message", false), true);
  assert.equal(
    helpers.composerSubmissionAppearsInTranscript("message_queue.enqueue", true),
    true,
    "an idle external-writer queue remains a hidden transport for an accepted send",
  );
});

test("an optimistic user row starts live presentation before provider output arrives", () => {
  const timeline = [
    { id: "previous-user", kind: "user", state: "completed" },
    { id: "previous-final", messageId: "previous-final", kind: "assistant", phase: "final_answer", state: "completed" },
    { id: "local-immediate", presentationId: "local-immediate", kind: "user", state: "completed" },
  ];
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "working" }, timeline), true, "the reasoning shimmer starts from the immediate send boundary");
  assert.equal(helpers.presentedSessionState({ state: "working" }, timeline), "working");
});

test("a failed composition is restored before work typed while it was sending", () => {
  const submittedImage = { name: "submitted.png", path: "submitted.png", mimeType: "image/png", byteLength: 1, dataBase64: "AA==" };
  const newerImage = { name: "newer.png", path: "newer.png", mimeType: "image/png", byteLength: 1, dataBase64: "AQ==" };
  const submittedWorkflow = { id: "workflow-submitted", name: "Submitted", summary: { eventCount: 1, screenshotCount: 0, apps: [] } };
  const newerWorkflow = { id: "workflow-newer", name: "Newer", summary: { eventCount: 2, screenshotCount: 1, apps: [] } };
  const submittedAnnotation = { id: "annotation-submitted", text: "answer", annotation: "submitted note" };
  const newerAnnotation = { id: "annotation-newer", text: "answer", annotation: "newer note" };

  const restored = composerUi.mergeFailedComposerDraft({
    content: "failed prompt",
    attachments: [submittedImage],
    workflowAttachments: [submittedWorkflow],
    annotations: [submittedAnnotation],
  }, {
    content: "new draft",
    // A repeated item is retained once, using the submitted snapshot first.
    attachments: [{ ...submittedImage }, newerImage],
    workflowAttachments: [{ ...submittedWorkflow }, newerWorkflow],
    annotations: [{ ...submittedAnnotation }, newerAnnotation],
  });

  assert.equal(restored.content, "failed prompt\n\nnew draft");
  assert.deepEqual(restored.attachments.map((item) => item.path), ["submitted.png", "newer.png"]);
  assert.strictEqual(restored.attachments[0], submittedImage);
  assert.deepEqual(restored.workflowAttachments.map((item) => item.id), ["workflow-submitted", "workflow-newer"]);
  assert.deepEqual(restored.annotations.map((item) => item.id), ["annotation-submitted", "annotation-newer"]);

  const submittedOnly = composerUi.mergeFailedComposerDraft({
    content: "failed prompt",
    attachments: [submittedImage],
    workflowAttachments: [],
    annotations: [],
  }, { content: "", attachments: [], workflowAttachments: [], annotations: [] });
  assert.equal(submittedOnly.content, "failed prompt");
  assert.deepEqual(submittedOnly.attachments, [submittedImage]);
});

test("a failed side-chat send restores its snapshot without overwriting newer work", () => {
  const submittedImage = { name: "submitted.png", path: "submitted.png", mimeType: "image/png", byteLength: 1, dataBase64: "AA==" };
  const newerImage = { name: "newer.png", path: "newer.png", mimeType: "image/png", byteLength: 1, dataBase64: "AQ==" };
  const restored = composerUi.mergeFailedSideChatDraft({
    content: "failed side-chat prompt",
    attachments: [submittedImage],
  }, {
    content: "new side-chat draft",
    attachments: [{ ...submittedImage }, newerImage],
  });

  assert.equal(restored.content, "failed side-chat prompt\n\nnew side-chat draft");
  assert.deepEqual(restored.attachments.map((item) => item.path), ["submitted.png", "newer.png"]);
  assert.strictEqual(restored.attachments[0], submittedImage);
  assert.deepEqual(composerUi.mergeFailedSideChatDraft({
    content: "failed side-chat prompt",
    attachments: [submittedImage],
  }, { content: "", attachments: [] }), {
    content: "failed side-chat prompt",
    attachments: [submittedImage],
  });
});

test("a persisted Codex final answer is immediate terminal evidence", () => {
  assert.equal(helpers.isPersistedCodexFinalAnswer({ type: "message.completed", payload: { source: "codex-local-rollout", role: "assistant", phase: "final_answer", text: "ok" } }), true);
  assert.equal(helpers.isPersistedCodexFinalAnswer({ type: "message.delta", payload: { source: "codex-local-rollout", role: "assistant", phase: "final_answer", text: "ok" } }), false);
  assert.equal(helpers.isPersistedCodexFinalAnswer({ type: "message.completed", payload: { source: "codex-local-rollout", role: "assistant", phase: "commentary", text: "working" } }), false);
});

test("dictation helpers prefer ready persisted source and insert editable text", () => {
  const sources = [
    { id: "openai-stt", label: "OpenAI", status: "needs_credential", setupEnvironmentVariable: "OPENAI", capabilities: { batch: true, maxAudioBytes: 10 } },
    { id: "xai-stt", label: "xAI", status: "ready", setupEnvironmentVariable: "XAI", capabilities: { batch: true, maxAudioBytes: 10 } },
  ];
  assert.equal(helpers.chooseTranscriptionSource(sources, "openai-stt").id, "xai-stt");
  assert.equal(helpers.appendTranscript("Existing", " spoken words "), "Existing spoken words");
  assert.equal(helpers.appendTranscript("", " spoken words "), "spoken words");
});

test("OpenCode catalogue routes use reported upstream providers for grouping and search", () => {
  const deepSeek = { id: "opencode-go/deepseek-v4", name: "DeepSeek V4", sourceProviderId: "opencode-go", sourceProviderName: "OpenCode Go" };
  const synthetic = { id: "synthetic/deepseek-v4", name: "DeepSeek V4", sourceProviderId: "synthetic", sourceProviderName: "Synthetic" };
  const first = helpers.modelCatalogRoute("opencode", "OpenCode", deepSeek);
  const second = helpers.modelCatalogRoute("opencode", "OpenCode", synthetic);

  assert.notEqual(first.key, second.key, "duplicate display names from different upstreams must form different groups");
  assert.deepEqual(first, { key: "opencode:opencode-go", label: "OpenCode Go", carriedBy: "OpenCode" });
  assert.equal(helpers.modelMatchesCatalogQuery("synthetic", "opencode", "OpenCode", synthetic), true);
  assert.equal(helpers.modelMatchesCatalogQuery("opencode-go", "opencode", "OpenCode", deepSeek), true);
  assert.equal(helpers.modelMatchesCatalogQuery("synthetic", "opencode", "OpenCode", deepSeek), false);
});

test("model catalogue route fallback leaves non-OpenCode providers unchanged", () => {
  assert.deepEqual(helpers.modelCatalogRoute("opencode", "OpenCode", { id: "model", name: "Model" }), {
    key: "opencode:opencode",
    label: "OpenCode",
  });
  assert.deepEqual(helpers.modelCatalogRoute("codex", "Codex", {
    id: "gpt",
    name: "GPT",
    sourceProviderId: "ignored-route",
    sourceProviderName: "Ignored Route",
  }), { key: "codex", label: "Codex" });
});

test("dictation microphone preference falls back to default and creates exact-device constraints", () => {
  const devices = [
    { kind: "audiooutput", deviceId: "speaker" },
    { kind: "audioinput", deviceId: "desk-mic" },
  ];
  assert.equal(helpers.resolvedDictationDeviceId(devices, "desk-mic"), "desk-mic");
  assert.equal(helpers.resolvedDictationDeviceId(devices, "missing-mic"), "");
  assert.equal(helpers.resolvedDictationDeviceId(devices, ""), "");
  assert.deepEqual(helpers.dictationAudioConstraints("desk-mic"), {
    deviceId: { exact: "desk-mic" },
    echoCancellation: true,
    noiseSuppression: true,
  });
  assert.deepEqual(helpers.dictationAudioConstraints(), {
    echoCancellation: true,
    noiseSuppression: true,
  });
});

test("only explicit sub-agent chats offer a direct return to their parent task", () => {
  assert.equal(helpers.parentSessionIdForBack({ relationshipKind: "subagent", parentSessionId: "parent-task" }), "parent-task");
  assert.equal(helpers.parentSessionIdForBack({ relationshipKind: "subagent", parentSessionId: "  " }), undefined);
  assert.equal(helpers.parentSessionIdForBack({ relationshipKind: "side_chat", parentSessionId: "parent-task" }), undefined);
  assert.equal(helpers.parentSessionIdForBack({ parentSessionId: "provider-owned-parent" }), undefined);
});

test("direct-audio MP3 trusts explicit model modalities and does not special-case GPT-5.6 Sol", () => {
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "google::gemini-3.6-flash", name: "Gemini 3.6 Flash", inputModalities: ["text", "image", "audio"] }), true);
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }), false);
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "openai::gpt-5.6-sol", name: "GPT-5.6 Sol", inputModalities: ["text", "image"] }), false);
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol via Vercel" }), false);
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "gpt-5.6-terra", name: "GPT-5.6 Terra" }), false);
  assert.equal(helpers.providerAcceptsDirectAudio("codex"), true);
  assert.equal(helpers.providerAcceptsDirectAudio("direct"), true);
  assert.equal(helpers.providerAcceptsDirectAudio("opencode"), true);
  assert.equal(helpers.providerAcceptsDirectAudio("grok"), false);
  assert.equal(helpers.isDictationAudioAttachment({ mimeType: "audio/mpeg", origin: "dictation" }), true);
  assert.equal(helpers.isDictationAudioAttachment({ mimeType: "audio/mpeg", origin: "file-picker" }), false);
  assert.equal(helpers.isDictationAudioAttachment({ mimeType: "audio/mpeg", origin: "dictation", kind: "file" }), false);
  assert.equal(helpers.classifyDroppedFile({ type: "image/png", name: "shot.png" }), "image");
  assert.equal(helpers.classifyDroppedFile({ type: "application/pdf", name: "notes.pdf" }), "file");
  assert.deepEqual(helpers.filterAttachmentsForDestination([
    { mimeType: "audio/mpeg", origin: "dictation" },
    { mimeType: "audio/mpeg", origin: "drag-drop" },
    { mimeType: "image/png", origin: "file-picker" },
  ], false, true).map((item) => item.origin), ["dictation", "file-picker"]);
  assert.equal(helpers.filterAttachmentsForDestination([
    { mimeType: "audio/mpeg", origin: "dictation" },
  ], false, false).length, 0);
});

test("sending needs a detected provider, not a live subscription state", () => {
  const detected = { state: "offline", detected: true, capabilities: ["Send Message", "Create Session", "Session History"] };
  assert.equal(helpers.canSendToProvider(detected, { draft: false, canCreateDraft: false }), true);
  assert.equal(helpers.canSendToProvider({ ...detected, state: "online" }, { draft: false, canCreateDraft: false }), true);
  assert.equal(helpers.canSendToProvider({ ...detected, state: "online", detected: false }, { draft: false, canCreateDraft: false }), false);
  assert.equal(helpers.canSendToProvider({ ...detected, capabilities: ["List Sessions"] }, { draft: false, canCreateDraft: false }), false);
  assert.equal(helpers.canSendToProvider(undefined, { draft: false, canCreateDraft: false }), false);
});

test("a draft needs a provider that can create sessions before it can send", () => {
  const full = { state: "offline", detected: true, capabilities: ["Send Message", "Create Session"] };
  assert.equal(helpers.canSendToProvider(full, { draft: true, canCreateDraft: true }), true);
  assert.equal(helpers.canSendToProvider(full, { draft: true, canCreateDraft: false }), false);
  assert.equal(helpers.canSendToProvider({ ...full, capabilities: ["Send Message"] }, { draft: true, canCreateDraft: true }), false);
  assert.equal(helpers.canSendToProvider(full, { draft: false, canCreateDraft: false }), true);
});

test("a quiet live feed is due for the calm selected-task catch-up", () => {
  const now = 100_000;
  assert.equal(helpers.quietCatchUpDue(null, now), true, "never receiving a delta must trigger the catch-up");
  assert.equal(helpers.quietCatchUpDue(now - 9_999, now), false, "recent live output keeps the poll out of the way");
  assert.equal(helpers.quietCatchUpDue(now - 10_000, now), true);
  assert.equal(helpers.quietCatchUpDue(now - 90_000, now), true);
  assert.equal(helpers.quietCatchUpIntervalMs > 0 && Number.isInteger(helpers.quietCatchUpIntervalMs), true);
});

test("quietness is per session, so another task's stream never hides this one's catch-up", () => {
  const now = 100_000;
  const perSession = new Map([["busy-task", now - 500], ["quiet-task", now - 90_000]]);
  // The selected task's own delta is the truth, whatever other tasks are doing.
  assert.equal(helpers.selectedSessionLastDeltaAt(perSession, "busy-task", now - 500), now - 500);
  assert.equal(helpers.selectedSessionLastDeltaAt(perSession, "quiet-task", now - 500), now - 90_000);
  // A session that never streamed counts as quiet even while the global feed is busy.
  assert.equal(helpers.selectedSessionLastDeltaAt(perSession, "split-session", now - 500), 0);
  assert.equal(helpers.quietCatchUpDue(helpers.selectedSessionLastDeltaAt(perSession, "split-session", now - 500), now), true);
  assert.equal(helpers.quietCatchUpDue(helpers.selectedSessionLastDeltaAt(perSession, "busy-task", now - 500), now), false);
  // No selection falls back to the global feed signal.
  assert.equal(helpers.selectedSessionLastDeltaAt(perSession, null, now - 500), now - 500);
});

test("terminal task state applies immediately while a superseded signal is ignored", async () => {
  assert.equal(helpers.shouldApplySessionState("idle", false), false);
  assert.equal(helpers.shouldApplySessionState("completed", false), false);
  assert.equal(helpers.shouldApplySessionState("unknown", false), false);
  assert.equal(helpers.shouldApplySessionState("idle", true), true);
  assert.equal(helpers.shouldApplySessionState("completed", true), true);
  for (const state of ["working", "needs_approval", "needs_input", "failed", "offline", "disconnected"]) {
    assert.equal(helpers.shouldApplySessionState(state, false), true, `${state} must apply immediately`);
  }

  assert.equal(helpers.terminalStateEventAction("idle", false, false), "apply");
  assert.equal(helpers.terminalStateEventAction("completed", false, false), "apply");
  assert.equal(helpers.terminalStateEventAction("idle", true, false), "apply");
  assert.equal(helpers.terminalStateEventAction("completed", false, true), "ignore");
  assert.equal(helpers.terminalStateEventAction("completed", false, true, true), "apply");
});

test("slash commands open from a bare slash, filter without prefilling, and insert only on selection", () => {
  assert.deepEqual(helpers.slashCommandSuggestions("/").map((item) => item.command), ["/simplify", "/mesh", "/goal", "/permission", "/ears", "/eyes", "/schedule"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/sim").map((item) => item.command), ["/simplify"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/me").map((item) => item.command), ["/mesh"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/perm").map((item) => item.command), ["/permission"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/g").map((item) => item.command), ["/goal"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/ea").map((item) => item.command), ["/ears"]);
  // The two settings commands share a first letter, so /e has to offer both.
  assert.deepEqual(helpers.slashCommandSuggestions("/e").map((item) => item.command), ["/ears", "/eyes"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/ey").map((item) => item.command), ["/eyes"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/sc").map((item) => item.command), ["/schedule"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/missing"), []);
  assert.deepEqual(helpers.slashCommandSuggestions("Explain /sim").map((item) => item.command), ["/simplify"]);
  assert.equal(helpers.slashCommandSuggestions("Explain tool/sim"), null);
  assert.equal(helpers.slashCommandSuggestions("https://example.test/sim"), null);
  assert.equal(helpers.insertedSlashCommand(helpers.composerSlashCommands[0]), "/simplify ");
  assert.equal(helpers.insertedSlashCommand(helpers.composerSlashCommands[1]), "/mesh ");
  assert.equal(helpers.insertedSlashCommand(helpers.composerSlashCommands[1], "Please /me"), "Please /mesh ");
  assert.equal(helpers.insertedSlashCommand(helpers.composerSlashCommands[1], "Please /me keep this", 10), "Please /mesh  keep this");
  assert.equal(helpers.insertedSlashCommand(helpers.composerSlashCommands[1], "\uE000/ suffix", 2), "\uE000/mesh  suffix");
});

test("draft scheduling validates real local times and preserves text added while persistence is pending", () => {
  const now = new Date(2026, 7, 29, 12, 0, 30, 0);
  assert.equal(composerUi.defaultDraftScheduleLocalValue(now), "2026-08-29T12:06");
  assert.equal(composerUi.parseDraftScheduleLocalValue("2026-02-30T12:00"), null, "a normalized impossible date was accepted");
  assert.match(composerUi.validateDraftScheduleLocalValue("not-a-date", now).error, /valid local date/u);
  assert.match(composerUi.validateDraftScheduleLocalValue("2026-08-29T12:00", now).error, /future/u);
  assert.match(composerUi.validateDraftScheduleLocalValue("2026-08-29T12:01", now).error, /at least one minute/u);
  const valid = composerUi.validateDraftScheduleLocalValue("2026-08-29T12:05", now);
  assert.equal(valid.error, null);
  assert.equal(valid.date.toISOString(), new Date(2026, 7, 29, 12, 5, 0, 0).toISOString());
  assert.equal(composerUi.draftScheduleLocalValueForOpen("2026-08-29T12:05", now), "2026-08-29T12:05");
  assert.equal(
    composerUi.draftScheduleLocalValueForOpen("2026-08-29T12:05", new Date(2026, 7, 29, 12, 6, 0, 0)),
    "2026-08-29T12:11",
    "reopening an aged scheduling panel retained its stale past default",
  );
  assert.deepEqual(composerUi.draftSchedulePresentation("  First line\nSecond line  "), {
    title: "First line",
    preview: "First line\nSecond line",
  });
  assert.equal(composerUi.clearScheduledDraftContent("Schedule this", "Schedule this"), "");
  assert.equal(composerUi.clearScheduledDraftContent("Schedule this\nNew typing", "Schedule this"), "New typing");
  assert.equal(composerUi.clearScheduledDraftContent("A replacement draft", "Schedule this"), "A replacement draft");
});

test("mesh command tokens work anywhere in a draft without consuming surrounding text", () => {
  assert.equal(helpers.hasSlashCommandToken("Please /mesh review this", "/mesh"), true);
  assert.equal(helpers.hasSlashCommandToken("/mesh review this", "/mesh"), true);
  assert.equal(helpers.hasSlashCommandToken("Please tool/mesh review this", "/mesh"), false);
  assert.equal(helpers.hasSlashCommandToken("https://example.test/mesh", "/mesh"), false);
  assert.equal(helpers.removeSlashCommandToken("Please /mesh review this", "/mesh"), "Please review this");
  assert.equal(helpers.removeSlashCommandToken("/mesh review this", "/mesh"), "review this");
  assert.equal(helpers.removeSlashCommandToken("Please review this /mesh", "/mesh"), "Please review this");
  assert.equal(helpers.removeSlashCommandToken("Please tool/mesh review this", "/mesh"), "Please tool/mesh review this");
});

test("mesh quick selection prefers accepted parent recency, then real provider use, and reconciles stale choices", () => {
  const models = {
    opencode: [
      { id: "model-default", name: "Default Model", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
      { id: "model-recent", name: "Recent Model", efforts: ["high", "max"], defaultEffort: "high" },
    ],
  };
  const sessions = [
    { id: "draft", providerId: "opencode", model: "model-default", effort: "low", draft: true, updatedAt: "2026-08-29T13:00:00.000Z" },
    { id: "internal", providerId: "opencode", model: "model-default", effort: "low", sessionKind: "internal", updatedAt: "2026-08-29T12:00:00.000Z" },
    { id: "accepted", providerId: "opencode", model: "Recent Model", effort: "max", updatedAt: "2026-08-29T11:00:00.000Z" },
  ];
  const snapshot = { providers: [], models, sessions };

  assert.deepEqual(composerUi.resolveMeshTargetSelection(snapshot, "opencode", undefined), {
    providerId: "opencode", modelId: "model-recent", reasoningEffort: "max",
  });
  assert.deepEqual(composerUi.resolveMeshTargetSelection(snapshot, "opencode", {
    providerId: "opencode", modelId: "model-default", reasoningEffort: "high",
  }), { providerId: "opencode", modelId: "model-default", reasoningEffort: "high" });
  assert.deepEqual(composerUi.resolveMeshTargetSelection(snapshot, "opencode", {
    providerId: "opencode", modelId: "removed-model", reasoningEffort: "ultra",
  }), { providerId: "opencode", modelId: "model-recent", reasoningEffort: "max" });
  assert.deepEqual(composerUi.resolveMeshTargetSelection({ ...snapshot, sessions: [] }, "opencode", undefined, {
    opencode: { modelId: "model-default", reasoningEffort: "high" },
  }), { providerId: "opencode", modelId: "model-default", reasoningEffort: "high" });
});

test("EARS offers only ready audio routes and remains explicit for audio-capable destinations", async () => {
  const audio = { id: "audio", name: "Audio", efforts: ["low"], inputModalities: ["text", "audio"] };
  const snapshot = {
    providers: [
      { id: "direct", state: "online", detected: true, authenticated: true },
      { id: "codex", state: "offline", detected: true, authenticated: true },
      { id: "opencode", state: "online", detected: true, authenticated: true },
    ],
    models: {
      direct: [audio],
      codex: [audio],
      opencode: [{ ...audio, id: "locked-audio", walletKind: "user_api", apiKeyConfigured: true, apiKeyVerified: false }],
    },
  };
  assert.deepEqual(composerUi.earsRoutesFromSnapshot(snapshot).map((route) => `${route.providerId}:${route.modelId}`), ["direct:audio"]);
});

test("simplify command produces clean one-response metadata and bounded persisted settings", () => {
  assert.deepEqual(composerUi.simplifySubmission("/simplify", { maxWords: 200, guidance: "Keep the example." }), {
    content: "Simplify the previous answer.",
    simplify: { maxWords: 200, guidance: "Keep the example.", target: "previous" },
  });
  assert.deepEqual(composerUi.simplifySubmission("Please /simplify explain this", { maxWords: 100 }), {
    content: "Please explain this",
    simplify: { maxWords: 100, target: "upcoming" },
  });
  assert.deepEqual(composerUi.simplifySubmission("Normal request", { maxWords: 100 }), { content: "Normal request" });
  assert.deepEqual(composerUi.storedSimplifySettings({ getItem: () => JSON.stringify({ maxWords: 99999 }) }), { maxWords: 2000 });
});

test("composer preserves the session model by stable id across refresh and creation", () => {
  const models = [
    { id: "openai::gpt-first", name: "GPT First" },
    { id: "custom::gpt-selected", name: "GPT Selected" },
  ];
  assert.equal(helpers.resolveComposerModelId(models, "custom::gpt-selected"), "custom::gpt-selected");
  assert.equal(helpers.resolveComposerModelId(models, "GPT Selected"), "custom::gpt-selected");
  assert.equal(helpers.resolveComposerModelId(models, "opencode-go/glm-5.3-flash"), "opencode-go/glm-5.3-flash");
  assert.equal(helpers.resolveComposerModelId(models, "CLI default"), "default");
});

test("existing tasks keep concrete provider-reported model truth through partial catalogue loading", () => {
  const partial = [{ id: "opencode-go/deepseek-v4-pro", name: "DeepSeek V4 Pro", isDefault: true, efforts: ["high"] }];
  assert.deepEqual(helpers.resolveReportedSessionSelection(
    partial,
    { modelId: "opencode-go/glm-5.3-flash", reasoningEffort: "max" },
    { modelId: "opencode-go/deepseek-v4-pro", reasoningEffort: "high" },
  ), { modelId: "opencode-go/glm-5.3-flash", reasoningEffort: "max" });

  const hydrated = [...partial, { id: "opencode-go/glm-5.3-flash", name: "GLM 5.3 Flash", efforts: ["low", "high", "max"] }];
  assert.deepEqual(helpers.resolveReportedSessionSelection(
    hydrated,
    { modelId: "GLM 5.3 Flash", reasoningEffort: "MAX" },
    { modelId: "opencode-go/deepseek-v4-pro", reasoningEffort: "high" },
  ), { modelId: "opencode-go/glm-5.3-flash", reasoningEffort: "max" });

  assert.deepEqual(helpers.resolveReportedSessionSelection(
    partial,
    { modelId: "CLI default", reasoningEffort: "Default" },
    { modelId: "opencode-go/deepseek-v4-pro", reasoningEffort: "high" },
  ), { modelId: "opencode-go/deepseek-v4-pro" });
});

test("native-default and missing session reasoning never become the first model variant", () => {
  const modelId = "opencode-go/muse-spark-1.3-contributor";
  const models = [{ id: modelId, name: "Muse Spark 1.3 Contributor", efforts: ["minimal", "low", "medium", "high", "xhigh"], defaultEffort: "minimal" }];
  for (const reasoningEffort of [undefined, "default", "Default", ""]) {
    assert.deepEqual(helpers.resolveReportedSessionSelection(models, { modelId, reasoningEffort }), { modelId });
  }
  assert.deepEqual(helpers.resolveReportedSessionSelection(models, { modelId, reasoningEffort: "xhigh" }), { modelId, reasoningEffort: "xhigh" });
});

test("composer presents compact model and reasoning labels without changing provider values", () => {
  assert.equal(composerUi.compactComposerModelLabel("GPT-5.6-Sol", "codex"), "5.6 Sol");
  assert.equal(composerUi.compactComposerModelLabel("GPT-5.6-Sol", "direct"), "GPT-5.6-Sol");
  assert.equal(composerUi.reasoningLabel("low"), "Low");
  assert.equal(composerUi.reasoningLabel("low", { providerId: "grok", modelId: "grok-4.6" }), "Low");
  assert.equal(composerUi.reasoningLabel("low", { providerId: "codex", modelId: "gpt-5.6-sol" }), "Light");
  assert.equal(composerUi.reasoningLabel("Low", { providerId: "codex" }), "Light");
  assert.equal(composerUi.reasoningLabel("default"), "");
  assert.equal(composerUi.reasoningLabel("High"), "High");
  assert.equal(composerUi.reasoningLabel("xhigh"), "Extra high");
});

test("composer resolves a concrete session or configured reasoning choice without an Auto fallback", () => {
  const models = [
    { id: "gpt-fast", name: "GPT Fast", isDefault: true, efforts: ["low", "medium"], defaultEffort: "medium" },
    { id: "gpt-careful", name: "GPT Careful", efforts: ["high", "max"], defaultEffort: "high" },
  ];
  assert.deepEqual(helpers.resolveConcreteModelSelection(models, { modelId: "gpt-fast", reasoningEffort: "high" }, { modelId: "gpt-careful", reasoningEffort: "max" }), { modelId: "gpt-fast", reasoningEffort: "medium" });
  assert.deepEqual(helpers.resolveConcreteModelSelection(models, { modelId: "CLI default", reasoningEffort: "Auto" }, { modelId: "gpt-careful", reasoningEffort: "max" }), { modelId: "gpt-careful", reasoningEffort: "max" });
  assert.deepEqual(helpers.resolveConcreteModelSelection(models), { modelId: "gpt-fast", reasoningEffort: "medium" });
  assert.deepEqual(helpers.resolveConcreteModelSelection([{ id: "plain", name: "Plain", isDefault: true, efforts: [] }]), { modelId: "plain" });
  assert.deepEqual(helpers.resolveConcreteModelSelection(
    [{ id: "grok-4.6", name: "Grok 4.6", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" }],
    { modelId: "grok-4.6", reasoningEffort: "extra high" },
    { modelId: "grok-4.6", reasoningEffort: "high" },
  ), { modelId: "grok-4.6", reasoningEffort: "xhigh" });
});

test("terminal task state and a completed final answer clear stale interruptibility", () => {
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }), true);
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "idle" }), false);
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "idle" }, [
    { kind: "user", state: "completed" },
    { kind: "reasoning", state: "running" },
  ]), false, "a stale timeline row cannot make an idle task stoppable");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, [
    { kind: "user", state: "completed" },
    { kind: "reasoning", state: "completed" },
    { kind: "assistant", phase: "final_answer", state: "completed" },
  ]), false, "a completed final answer ends the turn even if provider state lags");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "unknown" }, [
    { kind: "reasoning", state: "running" },
  ]), true, "live evidence may fill an unknown state but never override a terminal one");
});

test("newer running or completed work outranks only an earlier interim final", () => {
  const interimFinalThenRunning = [
    { kind: "user", state: "completed" },
    { kind: "assistant", phase: "final_answer", state: "completed" },
    { kind: "tool", state: "running" },
  ];
  assert.equal(helpers.latestTurnHasCompletedFinal(interimFinalThenRunning), false, "a final is not terminal when the same turn produces newer live output");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, interimFinalThenRunning), true, "a follow-up remains queued behind the newer live work");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "working" }, interimFinalThenRunning), true, "history keeps following the newer live work");
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "working" }, interimFinalThenRunning), true, "the delegated task remains visibly live");

  for (const kind of ["reasoning", "tool", "command", "subagent", "assistant"]) {
    const interimFinalThenCompletedWork = [
      { kind: "user", state: "completed" },
      { kind: "assistant", phase: "final_answer", state: "completed" },
      { kind, state: "completed" },
    ];
    assert.equal(helpers.latestTurnHasCompletedFinal(interimFinalThenCompletedWork), false, `completed ${kind} is newer continuation evidence`);
    assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, interimFinalThenCompletedWork), true, `completed ${kind} cannot release the follow-up queue`);
    assert.equal(helpers.sessionPresentsLiveTurn({ state: "working" }, interimFinalThenCompletedWork), true, `completed ${kind} keeps the delegated task visibly live`);
  }

  const runningThenFinal = [
    { kind: "user", state: "completed" },
    { kind: "tool", state: "running" },
    { kind: "assistant", phase: "final_answer", state: "completed" },
  ];
  assert.equal(helpers.latestTurnHasCompletedFinal(runningThenFinal), true, "a newer completed final remains terminal over stale running output");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, runningThenFinal), false, "the terminal final releases queued follow-ups even if transport lags");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "working" }, runningThenFinal), false, "the newer final completes transcript delivery");
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "working" }, runningThenFinal), false, "stale live output cannot revive the completed turn");
});

test("task controls and delayed transcript delivery settle independently", () => {
  const unfinished = [
    { kind: "user", state: "completed" },
    { kind: "reasoning", state: "running" },
  ];
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "completed" }, unfinished), false, "a completed task cannot be stopped");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, unfinished), true, "its missing final reply must still be fetched");
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "completed" }, unfinished), false, "a completed task heals its missing final without painting old reasoning as live work");
  assert.equal(helpers.terminalSessionNeedsCanonicalHistory({ state: "completed" }, unfinished), true, "task completion without visible final text forces canonical history");

  const finalAfterReasoning = [...unfinished, { kind: "assistant", phase: "final_answer", state: "completed" }];
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, finalAfterReasoning), false, "the final reply ends catch-up even when stale reasoning still says running");
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "completed" }, finalAfterReasoning), false, "the persisted final reply settles presentation independently of stale running rows");
  assert.equal(helpers.terminalSessionNeedsCanonicalHistory({ state: "completed" }, finalAfterReasoning), false, "visible final text completes successful reconciliation");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, [
    { kind: "user", state: "completed" },
    { kind: "assistant", state: "completed" },
    { kind: "reasoning", state: "running" },
  ]), true, "unphased interim narration cannot hide newer unfinished reasoning");
  assert.equal(helpers.latestTurnHasCompletedFinal([
    { kind: "user", state: "completed" },
    { kind: "assistant", state: "completed" },
  ]), false, "an unphased persisted row is not authoritative final evidence");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "working" }, [
    { kind: "user", state: "completed" },
    { kind: "assistant", phase: "final_answer", state: "completed" },
  ]), false, "a final reply that arrives before terminal state is already authoritative");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, [
    { kind: "user", state: "completed" },
    { kind: "assistant", phase: "commentary", state: "completed" },
  ]), true, "terminal state without a final or error keeps healing automatically");

  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "idle" }, [
    ...unfinished,
    { kind: "error", state: "failed" },
  ]), false, "an authoritative error cannot poll forever");
  assert.equal(helpers.terminalSessionNeedsCanonicalHistory({ state: "idle" }, [
    ...unfinished,
    { kind: "error", state: "failed" },
  ]), false, "a visible interruption or failure is the unsuccessful terminal artifact");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "failed" }, unfinished), false, "a failed task cannot poll forever");
});

test("visible turn outcome is independent from the provider transport state", () => {
  const unfinished = [
    { kind: "user", state: "completed" },
    { kind: "reasoning", state: "completed" },
  ];
  const final = [...unfinished, { kind: "assistant", phase: "final_answer", state: "completed" }];
  const interrupted = [...unfinished, { kind: "error", state: "failed" }];

  assert.equal(helpers.presentedSessionState({ state: "idle" }, final), "completed", "a later idle listing cannot erase a visible final answer");
  assert.equal(helpers.presentedSessionState({ state: "working" }, final), "completed", "stale working transport cannot keep a visible final labelled live");
  assert.equal(helpers.presentedSessionState({ state: "working" }, [...final, { kind: "reasoning", state: "running" }]), "working", "new live output must put the task-list spinner above the previous turn's final");
  assert.equal(helpers.presentedSessionState({ state: "completed" }, unfinished), "idle", "task-complete without a visible final must not claim the reply is complete");
  assert.equal(helpers.presentedSessionState({ state: "idle" }, interrupted), "idle", "an interrupted turn remains idle and keeps its visible interruption row");
  assert.equal(helpers.presentedSessionState({ state: "failed" }, interrupted), "failed", "an explicit failed turn remains failed");
});

test("compaction is a non-terminal row while the same turn keeps producing work", () => {
  const compactedTurn = [
    { id: "user-live", kind: "user", state: "completed", body: "Keep working" },
    { id: "reasoning-before", kind: "reasoning", state: "completed", body: "Preparing the change" },
    { id: "compaction", kind: "assistant", phase: "final_answer", state: "completed", title: "System", body: "Session compacted" },
    { id: "reasoning-after", kind: "reasoning", state: "completed", body: "Continuing after compaction" },
  ];

  assert.equal(helpers.presentedSessionState({ state: "working" }, compactedTurn), "working");
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "working" }, compactedTurn), true, "the reasoning shimmer remains live");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, compactedTurn), true, "Stop and queue ownership stay with the active turn");

  const completedTurn = [...compactedTurn, { id: "final", kind: "assistant", phase: "final_answer", state: "completed", body: "Done" }];
  assert.equal(helpers.presentedSessionState({ state: "completed" }, completedTurn), "completed");
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "completed" }, completedTurn), false);
});

test("a native compaction summary and its adjacent completion receipt share one disclosure", () => {
  const summary = { id: "summary", messageId: "summary-message", kind: "assistant", title: "Compaction", body: "## Objective\nPreserve the task", state: "completed", timestamp: "2026-09-07T11:00:00.000Z" };
  const receipt = { id: "receipt", kind: "assistant", title: "System", body: "Session compacted", state: "completed", timestamp: "2026-09-07T11:03:00.000Z" };
  const rows = timelineHelpers.coalesceCompactionCopies([summary, receipt]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, summary.body);
  assert.equal(timelineHelpers.timelineBoundaryLabel(rows[0]), "Session compacted");
  assert.equal(timelineHelpers.coalesceCompactionCopies([{ ...summary, title: undefined }, receipt]).length, 2, "ordinary summaries are not silently folded into compaction");
});

test("a Codex compaction handoff final is not a terminal answer", () => {
  const handoff = [
    { id: "user-live", kind: "user", state: "completed", body: "Keep working" },
    { id: "handoff-summary", kind: "assistant", phase: "final_answer", state: "completed", body: "Current task progress" },
    { id: "compaction", kind: "assistant", state: "completed", title: "System", body: "Session compacted" },
  ];
  assert.equal(helpers.latestTurnHasCompletedFinal(handoff), false, "the explicit compaction boundary proves that the preceding final was a handoff summary");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, handoff), true, "queue and Stop remain owned while compaction continues");

  const continued = [...handoff, { id: "reasoning-after", kind: "reasoning", state: "completed", body: "Continuing after compaction" }];
  assert.equal(helpers.latestTurnHasCompletedFinal(continued), false, "completed post-compaction work remains continuation evidence");
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "working" }, continued), true, "the shimmer and spinner remain live after completed post-compaction work");

  const completed = [...continued, { id: "real-final", kind: "assistant", phase: "final_answer", state: "completed", body: "Done" }];
  assert.equal(helpers.latestTurnHasCompletedFinal(completed), true, "a later genuine final settles the continued turn");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, completed), false, "only the later genuine final releases the queue");
});

test("a fresh provider working transition outranks only the ending visible when that turn began", () => {
  const previousFinal = [
    { id: "user-1", kind: "user", state: "completed" },
    { id: "final-1", messageId: "message-1", kind: "assistant", phase: "final_answer", state: "completed" },
  ];
  const boundary = helpers.captureSessionWorkingBoundary(previousFinal);

  assert.deepEqual(boundary, { visibleEndingIdentity: "final:message-1" });
  assert.equal(helpers.presentedSessionState({ state: "working" }, previousFinal), "completed", "an unlabelled working scalar remains too weak to revive an old final");
  assert.equal(helpers.presentedSessionState({ state: "working" }, previousFinal, boundary), "working", "the event boundary paints the new turn before its first transcript row");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, previousFinal, boundary), true, "Stop and follow-up queue ownership use the same live fact");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "working" }, previousFinal, boundary), true, "the old final cannot stop transcript follow-up for the new turn");

  assert.equal(helpers.terminalStateEventAction("completed", false, false), "apply", "completion is not held behind transcript quietness");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "completed" }, previousFinal, boundary), false, "transport completion retires Stop and queue ownership immediately");
  assert.equal(helpers.presentedSessionState({ state: "completed" }, previousFinal, boundary), "idle", "transport completion alone cannot relabel the previous final as this turn's answer");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, previousFinal, boundary), true, "history keeps healing until this turn has a visible ending");
  assert.equal(helpers.terminalSessionNeedsCanonicalHistory({ state: "completed" }, previousFinal, boundary), true, "terminal transport state forces a canonical read while the visible ending is missing");

  const withRunningRow = [...previousFinal, { id: "reasoning-2", kind: "reasoning", state: "running" }];
  assert.equal(helpers.presentedSessionState({ state: "working" }, withRunningRow), "working", "concrete new output remains sufficient without a boundary");

  const nextFinal = [...previousFinal, { id: "final-2", providerPartId: "part-2", kind: "assistant", phase: "final_answer", state: "completed" }];
  assert.equal(helpers.presentedSessionState({ state: "working" }, nextFinal, boundary), "completed", "a different final identity closes the boundary even if the scalar lags");
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, nextFinal, boundary), false);
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "working" }, nextFinal, boundary), false);
  assert.equal(helpers.sessionBoundaryNeedsVisibleEnding(nextFinal, boundary), false);

  const interrupted = [...previousFinal, { id: "interrupted-2", turnId: "turn-2", kind: "error", state: "failed" }];
  assert.equal(helpers.presentedSessionState({ state: "idle" }, interrupted, boundary), "idle", "an explicit interruption remains terminal");
  assert.equal(helpers.sessionPresentsLiveTurn({ state: "idle" }, interrupted, boundary), false);
  assert.equal(helpers.sessionBoundaryNeedsVisibleEnding(interrupted, boundary), false, "a visible interruption closes the same pending boundary as a final reply");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "idle" }, interrupted, boundary), false);
  assert.equal(helpers.terminalSessionNeedsCanonicalHistory({ state: "idle" }, interrupted, boundary), false);
});

test("canonical history clears only the completed working boundary", () => {
  const previousFinal = [
    { id: "user-1", kind: "user", state: "completed" },
    { id: "final-1", messageId: "message-1", kind: "assistant", phase: "final_answer", state: "completed" },
  ];
  const boundary = helpers.canonicalSessionWorkingBoundary({ state: "working" }, previousFinal, undefined);
  assert.deepEqual(boundary, { visibleEndingIdentity: "final:message-1" });
  assert.strictEqual(helpers.canonicalSessionWorkingBoundary({ state: "completed" }, previousFinal, boundary), boundary, "task completion alone does not erase transcript recovery");

  const nextFinal = [...previousFinal, { id: "final-2", kind: "assistant", phase: "final_answer", state: "completed" }];
  assert.equal(helpers.canonicalSessionWorkingBoundary({ state: "completed" }, nextFinal, boundary), undefined, "the new visible ending clears the boundary");
  assert.equal(helpers.canonicalSessionWorkingBoundary({ state: "working" }, nextFinal, boundary), undefined, "a lagging working scalar cannot immediately invent another turn");
  assert.deepEqual(helpers.canonicalSessionWorkingBoundary({ state: "working" }, nextFinal, undefined), { visibleEndingIdentity: "final:final-2" }, "a later genuine transition can seed a fresh boundary");
});

test("provider attention cannot be hidden by the previous turn's final answer", () => {
  const previousFinal = [
    { id: "user-1", kind: "user", state: "completed" },
    { id: "final-1", messageId: "message-1", kind: "assistant", phase: "final_answer", state: "completed" },
  ];

  for (const state of ["needs_approval", "needs_input"]) {
    assert.equal(helpers.presentedSessionState({ state }, previousFinal), state);
    assert.equal(helpers.sessionHoldsFollowUpQueue({ state }, previousFinal), true);
    assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state }, previousFinal), true);
    assert.equal(helpers.sessionPresentsLiveTurn({ state }, previousFinal), true);
  }
});

test("composer accepts twelve attachments and enforces count and 50 MiB boundaries before upload", () => {
  const mib = 1024 * 1024;
  const exact = helpers.appendAttachmentsWithinLimits([], [
    { path: "first", byteLength: 25 * mib },
    { path: "second", byteLength: 25 * mib },
    { path: "over", byteLength: 1 },
  ]);
  assert.deepEqual(exact.items.map((item) => item.path), ["first", "second"]);
  assert.equal(exact.acceptedCount, 2);
  assert.equal(exact.rejectedForBytes, true);

  const twelve = Array.from({ length: 12 }, (_, index) => ({ path: `item-${index}`, byteLength: 1 }));
  const accepted = helpers.appendAttachmentsWithinLimits([], twelve);
  assert.deepEqual(accepted.items, twelve);
  assert.equal(accepted.acceptedCount, 12);
  assert.equal(accepted.rejectedForCount, false);
  const duplicate = helpers.appendAttachmentsWithinLimits(twelve, [twelve[0]]);
  assert.equal(duplicate.rejectedForCount, false);
  const count = helpers.appendAttachmentsWithinLimits(twelve, [twelve[0], { path: "thirteenth", byteLength: 1 }]);
  assert.equal(count.acceptedCount, 0);
  assert.equal(count.rejectedForCount, true);
  assert.deepEqual(count.items, twelve);
  const bulk = helpers.appendAttachmentsWithinLimits([], [...twelve, { path: "thirteenth", byteLength: 1 }]);
  assert.equal(bulk.acceptedCount, 12);
  assert.equal(bulk.rejectedForCount, true);

  const skipsOversizedButKeepsFitting = helpers.appendAttachmentsWithinLimits(
    [{ path: "existing", byteLength: 40 * mib }],
    [{ path: "too-large", byteLength: 20 * mib }, { path: "fits", byteLength: 5 * mib }],
  );
  assert.deepEqual(skipsOversizedButKeepsFitting.items.map((item) => item.path), ["existing", "fits"]);
  assert.equal(skipsOversizedButKeepsFitting.rejectedForBytes, true);
});

test("OpenCode file gating, bounded prompt history, and queued-message parsing stay local", () => {
  assert.equal(composerUi.supportsGenericFileAttachments("opencode"), true);
  assert.equal(composerUi.supportsGenericFileAttachments("codex"), false);

  const history = composerUi.boundedPromptHistory([
    "newest prompt",
    "newest prompt",
    ...Array.from({ length: 60 }, (_, index) => `prompt ${index}`),
  ]);
  assert.equal(history[0], "newest prompt");
  assert.equal(history.length, 50);
  assert.equal(new Set(history).size, history.length);
  assert.deepEqual(composerUi.boundedPromptHistory(["x".repeat(20_001), "kept"]), ["kept"]);

  const messages = composerUi.queuedMessagesForSession({ messages: [
    { id: "keep", sessionId: "session-a", content: "Run this next", state: "queued", attachments: [{ name: "notes.md" }] },
    { id: "other", sessionId: "session-b", content: "Ignore", state: "queued", attachments: [] },
    { id: "invalid", sessionId: "session-a", content: "Ignore", state: "complete", attachments: [] },
  ] }, "session-a");
  assert.deepEqual(messages, [{
    id: "keep",
    content: "Run this next",
    state: "queued",
    retryable: true,
    attachmentCount: 1,
    attachments: [{ name: "notes.md", mimeType: "application/octet-stream", byteLength: 0 }],
  }]);
  const imageQueue = composerUi.queuedMessagesForSession({ messages: [{
    id: "local-image",
    sessionId: "session-a",
    content: "Review this",
    state: "queued",
    attachments: [
      { name: "screen.png", mimeType: "image/png", byteLength: 3, dataBase64: "AQID" },
      { name: "voice.mp3", mimeType: "audio/mpeg", byteLength: 3, dataUrl: "data:audio/mpeg;base64,BAUG", durationSeconds: 2.5 },
      { name: "notes.md", mimeType: "text/markdown", byteLength: 42 },
    ],
  }] }, "session-a");
  assert.equal(imageQueue[0].attachments[0].dataUrl, "data:image/png;base64,AQID");
  assert.deepEqual(imageQueue[0].attachments[1], { name: "voice.mp3", mimeType: "audio/mpeg", byteLength: 3, dataUrl: "data:audio/mpeg;base64,BAUG", durationSeconds: 2.5 });
  assert.deepEqual(imageQueue[0].attachments[2], { name: "notes.md", mimeType: "text/markdown", byteLength: 42 });
  assert.equal(composerUi.queuedMessagePreview("Same first line\nDifferent detail"), "Same first line");
  assert.equal(composerUi.queuedMessagePreview("\n\n"), "Queued instruction");
});

test("assistant identity appears once on the final or only answer of a turn", () => {
  const item = (id, kind) => ({ id, kind, body: id, timestamp: "2026-08-14T12:00:00.000Z", state: "completed" });
  const timeline = [
    item("user-1", "user"),
    item("assistant-opening", "assistant"),
    item("reasoning", "reasoning"),
    item("assistant-intermediate", "assistant"),
    item("tool", "tool"),
    item("assistant-final", "assistant"),
    item("user-2", "user"),
    item("assistant-only", "assistant"),
  ];
  timeline[1].phase = "commentary";
  timeline[3].phase = "commentary";
  timeline[5].phase = "final_answer";
  assert.deepEqual(timeline.map((_, index) => timelineHelpers.shouldShowAssistantIdentity(timeline, index)), [false, false, false, false, false, true, false, true]);
  assert.equal(timelineHelpers.finalAnswerCopyText(timeline, 5), "assistant-final");
  const splitFinal = [item("user", "user"), { ...item("part-one", "assistant"), phase: "final_answer" }, { ...item("part-two", "assistant"), phase: "final_answer" }];
  assert.equal(timelineHelpers.finalAnswerCopyText(splitFinal, 2), "part-one\n\npart-two");
  const compacted = { ...item("compacted", "assistant"), body: "Context automatically compacted" };
  assert.deepEqual(
    [item("user", "user"), compacted, timeline[1], timeline[5]].map((candidate, index, items) => timelineHelpers.shouldShowAssistantIdentity(items, index)),
    [false, false, false, true],
  );
  const reasoningFirst = [
    item("user", "user"),
    item("reasoning-first", "reasoning"),
    item("assistant-middle", "assistant"),
    item("reasoning-later", "reasoning"),
    item("assistant-final", "assistant"),
  ];
  assert.deepEqual(reasoningFirst.map((_, index) => timelineHelpers.shouldShowAssistantIdentity(reasoningFirst, index)), [false, false, false, false, true]);
  const fastRunningAnswer = [item("user", "user"), { ...item("answer", "assistant"), state: "running" }];
  assert.deepEqual(fastRunningAnswer.map((_, index) => timelineHelpers.shouldShowAssistantIdentity(fastRunningAnswer, index)), [false, true]);
  const failedAfterAnswer = [item("user", "user"), item("answer-before-error", "assistant"), item("provider-error", "error")];
  assert.deepEqual(failedAfterAnswer.map((_, index) => timelineHelpers.shouldShowAssistantIdentity(failedAfterAnswer, index)), [false, true, false]);
});

test("assistant identity marks every final answer and gives the newest live output a breathing mark", () => {
  const item = (id, kind, phase) => ({ id, kind, body: id, timestamp: "2026-08-14T12:00:00.000Z", state: "completed", ...(phase ? { phase } : {}) });
  const twoFinals = [
    item("user", "user"),
    item("intro", "assistant", "commentary"),
    item("first", "assistant", "final_answer"),
    item("followup", "assistant", "commentary"),
    item("second", "assistant", "final_answer"),
  ];
  assert.equal(timelineHelpers.assistantIdentityMode(twoFinals, 1, true), "none");
  assert.equal(timelineHelpers.assistantIdentityMode(twoFinals, 2, true), "final");
  assert.equal(timelineHelpers.assistantIdentityMode(twoFinals, 3, true), "none");
  assert.equal(timelineHelpers.assistantIdentityMode(twoFinals, 4, true), "final");

  const liveCommentary = [item("user", "user"), item("chatty", "assistant", "commentary")];
  assert.equal(timelineHelpers.assistantIdentityMode(liveCommentary, 1, true), "live");
  assert.equal(timelineHelpers.assistantIdentityMode(liveCommentary, 1, false), "none");

  const unphasedRunning = [item("user", "user"), { ...item("answer", "assistant"), state: "running" }];
  assert.equal(timelineHelpers.assistantIdentityMode(unphasedRunning, 1, true), "live");
  assert.equal(timelineHelpers.assistantIdentityMode(unphasedRunning, 1, false), "live");
  const settled = [item("user", "user"), item("answer", "assistant")];
  assert.equal(timelineHelpers.assistantIdentityMode(settled, 1, false), "final");

  const middle = [item("user", "user"), item("part-one", "assistant"), item("part-two", "assistant")];
  assert.equal(timelineHelpers.assistantIdentityMode(middle, 1, false), "none");
  assert.equal(timelineHelpers.assistantIdentityMode(middle, 2, false), "final");
});

test("an active task animates its latest reasoning and otherwise pulses beside the transcript", () => {
  const item = (id, kind, phase) => ({ id, kind, phase, body: id, timestamp: "2026-08-15T12:00:00.000Z", state: "completed" });
  const timeline = [
    item("user", "user"),
    { ...item("thinking", "reasoning"), body: "checked the adapter first" },
    item("progress", "assistant", "commentary"),
  ];
  const active = timelineHelpers.withCurrentActivity(timeline, true);
  // External harness history can close each individual item before it writes the
  // next one. While the task is canonically active, the trailing work group is the
  // live envelope and must not leave a static Reasoning label below a live icon.
  assert.equal(active[1].state, "running", "the existing clickable Reasoning row owns the live envelope");
  assert.equal(active[2].state, "completed", "commentary itself is not rewritten as reasoning");
  assert.equal(active.length, 3, "a span that already has a reasoning row needs no pulse");
  assert.equal(timelineHelpers.showsWorkingPulse(active, true), false, "later commentary must not add a second Reasoning pulse");
  assert.equal(timelineHelpers.groupTimeline(active, true).filter((group) => group.kind === "reasoning").length, 1, "one active span paints one clickable Reasoning control");
  // Streaming commentary is visible output, not evidence of thinking, so a harness that
  // sends no reasoning rows at all still gets something that says the session is alive.
  const commentaryOnly = timelineHelpers.withCurrentActivity([timeline[0], timeline[2]], true);
  assert.equal(commentaryOnly[1].state, "completed");
  // Being busy is a fact about the session, not an entry in its transcript. Nothing is
  // synthesised into the timeline to carry it; the pulse is answered separately.
  assert.equal(commentaryOnly.length, 2, "the pulse is never a timeline row");
  assert.equal(timelineHelpers.showsWorkingPulse(commentaryOnly, true), true);
  assert.equal(timelineHelpers.showsWorkingPulse(commentaryOnly, false), false);
  // A real thought is the record of how the turn was reached, so it outlives the
  // turn and waits behind the collapsed Reasoning control for whoever scrolls back.
  assert.deepEqual(timelineHelpers.withCurrentActivity(timeline, false), timeline);
  const staleRunning = timeline.map((entry, index) => index === 0 ? entry : { ...entry, state: "running" });
  const normalized = timelineHelpers.withCurrentActivity(staleRunning, true);
  // The tail here is streaming commentary, which is visible output rather than
  // evidence of thinking, and the span already carries its own reasoning row, so
  // no synthetic marker is stacked beneath it.
  assert.deepEqual(normalized.map((entry) => entry.state), ["completed", "running", "completed"]);
  assert.equal(normalized.filter((entry) => entry.kind === "reasoning" && entry.state === "running").length, 1);
  assert.equal(timelineHelpers.showsWorkingPulse(normalized, true), false, "streaming commentary reuses the real Reasoning disclosure");
  // A provider's stale `running` flag never outlives the turn: the thought stays,
  // settled, so nothing in the view can still animate once the turn is over.
  assert.deepEqual(timelineHelpers.withCurrentActivity(staleRunning, false).map((entry) => entry.state), ["completed", "completed", "completed"]);
  assert.equal(timelineHelpers.withCurrentActivity(staleRunning, false).filter((entry) => entry.state === "running").length, 0);
  const stalePreviousTurn = [
    item("old-user", "user"),
    { ...item("old-thinking", "reasoning"), state: "running" },
    item("old-answer", "assistant", "final_answer"),
    item("current-user", "user"),
    { ...item("current-thinking", "reasoning"), state: "running" },
  ];
  const currentTurn = timelineHelpers.withCurrentActivity(stalePreviousTurn, true);
  assert.equal(currentTurn.filter((entry) => entry.state === "running").length, 1);
  assert.equal(currentTurn[1].state, "completed");
  assert.equal(currentTurn[4].state, "running");
  const completedExternalTail = [
    timeline[0],
    timeline[2],
    { ...item("finished-tool", "command"), body: "npm test" },
  ];
  const projectedExternalTail = timelineHelpers.withCurrentActivity(completedExternalTail, true);
  assert.deepEqual(projectedExternalTail.map((entry) => entry.state), ["completed", "completed", "running"]);
  assert.equal(timelineHelpers.showsWorkingPulse(projectedExternalTail, true), false, "the trailing work group owns the live shimmer");
  const projectedSegments = timelineHelpers.reasoningSegments([
    { ...item("finished-thought", "reasoning"), body: "Inspecting the state flow." },
    projectedExternalTail[2],
  ]);
  assert.equal(projectedSegments.find((segment) => segment.kind === "thinking")?.item.state, "completed", "the earlier thought stays settled while later work runs");
  const completedFinal = [timeline[0], { ...item("finished", "assistant", "final_answer"), state: "completed" }];
  const workingAfterAnswer = timelineHelpers.withCurrentActivity(completedFinal, true);
  assert.deepEqual(workingAfterAnswer, completedFinal, "a working session writes nothing into its own transcript");
  assert.equal(timelineHelpers.showsWorkingPulse(workingAfterAnswer, true), true);
  assert.deepEqual(timelineHelpers.withCurrentActivity(completedFinal, false), completedFinal);
  // A thought that never produced a word is not evidence of thinking once the
  // turn is over: the settled empty row must disappear (it read as the model
  // still being mid-turn), while it stays visible during the live turn.
  const emptyReasoning = [timeline[0], { ...item("empty-thought", "reasoning"), body: "" }];
  assert.deepEqual(timelineHelpers.withCurrentActivity(emptyReasoning, false), [timeline[0]]);
  const liveEmpty = timelineHelpers.withCurrentActivity(emptyReasoning, true);
  assert.deepEqual(liveEmpty, [timeline[0]], "a row with nothing to read is not kept back to prove the session is busy");
  assert.equal(timelineHelpers.showsWorkingPulse(liveEmpty, true), true);
  // The live artifact is the marker, not the thinking. A row carrying real text
  // survives its turn and becomes the collapsed Reasoning dropdown; removing it
  // took the reader's only route back to how an answer was reached.
  const settledText = [timeline[0], { ...item("real-thought", "reasoning"), body: "actual analysis text" }];
  assert.deepEqual(timelineHelpers.withCurrentActivity(settledText, false), settledText);
  // A title the provider wrote is thinking too, even with nothing under it.
  const titledThought = [timeline[0], { ...item("titled", "reasoning"), title: "Mapped the existing interface", body: "" }];
  assert.deepEqual(timelineHelpers.withCurrentActivity(titledThought, false), titledThought);
  // A generic title over an empty body is the marker wearing a label, not a thought.
  const genericTitle = [timeline[0], { ...item("generic", "reasoning"), title: "Reasoning", body: "" }];
  assert.deepEqual(timelineHelpers.withCurrentActivity(genericTitle, false), [timeline[0]]);
  // Placeholder text is spent whoever wrote it: the body decides, not the identity.
  const strayMarker = [timeline[0], { ...item("stray", "reasoning"), title: "Reasoning", body: "Reasoning…" }];
  assert.deepEqual(timelineHelpers.withCurrentActivity(strayMarker, false), [timeline[0]]);
  // A row left over from the version that synthesised these is dropped on content too,
  // so nothing in the transcript depends on recognising an id we no longer write.
  const lingeringPlaceholder = [timeline[0], {
    id: "tethoq-live-reasoning-task",
    kind: "reasoning",
    title: "Reasoning",
    body: "Reasoning…",
    state: "completed",
    timestamp: "2026-08-15T12:00:00.000Z",
  }];
  assert.deepEqual(timelineHelpers.withCurrentActivity(lingeringPlaceholder, false), [timeline[0]]);
});

test("displaying an image keeps the current reasoning live through preview loading and hydration", () => {
  const row = (id, kind, state = "completed") => ({ id, kind, body: id, timestamp: "2026-09-09T14:00:00Z", state });
  const user = row("request", "user");
  const thought = row("Inspecting the implementation", "reasoning", "running");
  for (const caption of ["", "Here is the current preview"]) {
    for (const preview of [{ name: "preview.png", loading: true }, { name: "preview.png", dataUrl: "data:image/png;base64,AA==" }]) {
      const image = { ...row("image", "assistant"), body: caption, phase: "final_answer", presentationOnly: true, images: [preview] };
      const projected = timelineHelpers.withCurrentActivity([user, thought, image], true);
      assert.equal(projected[1], thought, "showing an image must preserve the same live reasoning row");
      assert.equal(projected[2].state, "completed", "the image itself is a settled artifact");
      assert.equal(timelineHelpers.showsWorkingPulse(projected, true), false, "the existing live disclosure still owns the shimmer");
      assert.equal(timelineHelpers.withCurrentActivity(projected, false)[1].state, "completed", "real task completion still settles reasoning");
      const final = { ...row("actual-final", "assistant"), phase: "final_answer" };
      assert.equal(timelineHelpers.withCurrentActivity([...projected, final], true)[1].state, "completed", "a genuine final remains a boundary");
    }
  }
  const nextUserImage = { ...row("next-request", "user"), images: [{ name: "input.png", loading: true }] };
  const nextTurn = timelineHelpers.withCurrentActivity([user, thought, nextUserImage], true);
  assert.equal(nextTurn[1].state, "completed", "a user image still starts a new visible turn");
  assert.equal(timelineHelpers.showsWorkingPulse(nextTurn, true), true, "the new image turn immediately has a working indicator");
});

test("expanded long-running work keeps its live pulse after the latest activity", () => {
  const row = (id, kind, state = "completed") => ({ id, kind, body: id, timestamp: "2026-09-07T12:00:00Z", state });
  // Goal continuations have no visible user boundary; the work may stay in one
  // expanded group across many completed tools and assistant messages.
  const history = [row("goal", "user"), row("initial thought", "reasoning", "running"),
    ...Array.from({ length: 80 }, (_, index) => row(`tool ${index}`, "tool"))];
  const projected = timelineHelpers.withCurrentActivity(history, true);
  const group = timelineHelpers.groupTimeline(projected, true).at(-1);
  const segments = timelineHelpers.reasoningSegments(group.items, group.key);
  assert.equal(segments.find((segment) => segment.kind === "thinking").item.state, "completed", "old reasoning must not shimmer when a later tool owns the live work");
  assert.deepEqual(timelineHelpers.liveReasoningIds([group]), { groups: [group.key], segments: [] }, "the group stays open without inventing live text");
  assert.equal(timelineHelpers.showsWorkingPulse(projected, true, false, true), true, "expanded work needs a pulse at the transcript end");
  assert.equal(timelineHelpers.showsWorkingPulse(projected, true, false, false), false, "a collapsed group already has one live control");
  assert.equal(timelineHelpers.showsWorkingPulse(projected, false, false, true), false, "settlement removes the pulse");
  assert.equal(timelineHelpers.showsWorkingPulse(projected, true, true, true), false, "retry or compaction status takes precedence");
});

test("live reasoning stays on the bottommost disclosure and never crosses compaction", () => {
  const row = (id, kind, state = "completed", body = id, phase) => ({ id, kind, body, phase, timestamp: "2026-08-29T12:00:00.000Z", state });
  const compacted = { ...row("compacted", "assistant", "completed", "Session compacted"), title: "Session compacted" };
  const history = [
    row("user", "user"),
    compacted,
    row("older-reasoning", "reasoning", "running", "The older command is still reconciling."),
    row("commentary-a", "assistant", "completed", "The first result arrived.", "commentary"),
    row("middle-reasoning", "reasoning", "completed", "Checking the next result."),
    row("commentary-b", "assistant", "completed", "The next result arrived.", "commentary"),
    row("latest-reasoning", "reasoning", "completed", "Reviewing the newest state."),
    row("commentary-c", "assistant", "completed", "Still working.", "commentary"),
  ];
  const runningIds = (timeline) => timeline.filter((item) => item.state === "running").map((item) => item.id);

  const olderStillRunning = timelineHelpers.withCurrentActivity(history, true);
  assert.deepEqual(runningIds(olderStillRunning), ["latest-reasoning"], "an older command flag must not pull the shimmer up from the bottommost disclosure");
  const groups = timelineHelpers.groupTimeline(olderStillRunning, true).filter((group) => group.kind === "reasoning");
  assert.deepEqual(timelineHelpers.liveReasoningIds(groups).groups, [timelineHelpers.reasoningGroupKey(groups.at(-1))], "only the bottommost clickable Reasoning group owns the live envelope");

  const middleNowRunning = timelineHelpers.withCurrentActivity(history.map((item) => item.id === "older-reasoning"
    ? { ...item, state: "completed" }
    : item.id === "middle-reasoning" ? { ...item, state: "running" } : item), true);
  assert.deepEqual(runningIds(middleNowRunning), ["latest-reasoning"], "provider refreshes must not bounce the shimmer between stale historical flags");

  const beforeCompactionStillRunning = timelineHelpers.withCurrentActivity([
    row("user", "user"),
    row("pre-compaction-reasoning", "reasoning", "running", "Preparing the context summary."),
    compacted,
    row("post-compaction-reasoning", "reasoning", "completed", "Continuing after compaction."),
  ], true);
  assert.deepEqual(runningIds(beforeCompactionStillRunning), ["post-compaction-reasoning"], "live state must never project backward across Session compacted");
});

test("a thought with no words in it is the shimmer, not a row that cannot be opened", async () => {
  const at = "2026-08-20T11:00:00.000Z";
  const think = (id, body, state) => ({ id, messageId: "m1", kind: "reasoning", title: "Reasoning", body, timestamp: at, state });
  const asked = { id: "ask", kind: "user", body: "go", timestamp: at, state: "completed" };

  // A harness announces the thought before it writes a word of it. Keeping that
  // announcement put a row on screen saying "Thinking" that could not be opened,
  // because there was nothing behind it - and it stood the shimmer down as well, so
  // a reader watching a task work had neither the sheen nor anything to click.
  const announced = timelineHelpers.withCurrentActivity([asked, think("t", "", "running")], true);
  assert.equal(announced.filter((item) => item.kind === "reasoning").length, 0, "an empty thought is not a row");
  assert.equal(timelineHelpers.showsWorkingPulse(announced, true), true, "the span still reads as thinking");

  // The moment there are words, the thought is a row and speaks for the span itself.
  const written = timelineHelpers.withCurrentActivity([asked, think("t", "Weighing the options", "running")], true);
  assert.equal(written.filter((item) => item.kind === "reasoning").length, 1);
  assert.equal(timelineHelpers.showsWorkingPulse(written, true), false);
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(written.find((i) => i.kind === "reasoning")), true, "and it opens");

  // A settled empty thought is not a row either, so nothing dead is left behind.
  const settled = timelineHelpers.withCurrentActivity([asked, think("t", "", "completed")], false);
  assert.equal(settled.filter((item) => item.kind === "reasoning").length, 0);
});

test("a concrete file change speaks for work without stacking a second pulse", async () => {
  const row = (id, kind, state = "completed") => ({ id, kind, title: kind, body: id, timestamp: "2026-08-20T10:00:00.000Z", state });
  const sent = [row("ask", "user")];
  const current = (items) => timelineHelpers.withCurrentActivity(items, true);

  // Nothing has happened yet: the span is thinking.
  assert.equal(timelineHelpers.showsWorkingPulse(current(sent), true), true);

  // Pathless watcher noise is removed by the bridge. A file row that reaches the
  // transcript therefore names concrete work and must not receive a duplicate
  // Reasoning pulse immediately beneath it.
  assert.equal(timelineHelpers.showsWorkingPulse(current([...sent, row("src/controller.ts", "file")]), true), false);

  // Work that genuinely speaks for the span still does.
  assert.equal(timelineHelpers.showsWorkingPulse(current([...sent, row("ran", "tool")]), true), false);
  assert.equal(timelineHelpers.showsWorkingPulse(current([...sent, row("cmd", "command")]), true), false);
  assert.equal(timelineHelpers.showsWorkingPulse(current([...sent, row("thought", "reasoning")]), true), false);

  assert.equal(timelineHelpers.showsWorkingPulse(current([...sent, row("src/controller.ts", "file", "running")]), true), false);
});

test("a provider retry is one quiet status row, never fake reasoning or an error", async () => {
  const sent = [{ id: "ask", kind: "user", body: "go", timestamp: "2026-08-20T10:00:00.000Z", state: "completed" }];

  assert.equal(timelineHelpers.showsWorkingPulse(sent, true), true, "ordinary working still uses the normal pulse");
  assert.equal(timelineHelpers.showsWorkingPulse(sent, true, true), false, "the retry notice stands in for the pulse");
  assert.equal(
    timelineHelpers.providerStatusNoticeText({ kind: "retry", message: "429 Too Many Requests, request id: req_123456789" }),
    "Retrying — 429 Too Many Requests",
  );
  assert.doesNotMatch(
    timelineHelpers.providerStatusNoticeText({ kind: "retry", message: "request id: req_123456789" }),
    /req_123456789/u,
  );
});

test("a short thought written between tool calls can still be read in full", async () => {
  const think = (id, body, state) => ({ id, messageId: "msg_1", kind: "reasoning", title: "Reasoning", body, timestamp: "2026-08-19T12:00:00.000Z", state });

  // A thought loses nothing by being brief. While it is still being written its body
  // matches its preview only until the next chunk lands, and judging it by that
  // instant sealed every short thought shut: the row rendered disabled, so a reader
  // watching a turn full of tool calls saw a one-line summary of thinking they were
  // never allowed to open. Anything still being written is readable.
  const shortLive = think("live", "The user is a test user. Now step 3: ls.", "running");
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(shortLive), true);
  const longLive = think("long-live", `Weighing the options. ${"More reasoning arrives every moment. ".repeat(6)}`, "running");
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(longLive), true);

  // A finished short thought is a different matter: its preview already carries every
  // word, so a disclosure over it would open onto nothing.
  const shortSettled = think("settled", "The user is a test user. Now step 3: ls.", "completed");
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(shortSettled), false);
  assert.equal(timelineHelpers.reasoningPreview(shortSettled), "The user is a test user. Now step 3: ls.", "the whole thought stays on screen once it settles");

  // An empty row is still not a disclosure, running or not.
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(think("blank", "", "running")), false);

  // And a live thought names itself, so the row it opens is the one being written.
  const live = timelineHelpers.liveReasoningIds(timelineHelpers.groupTimeline([shortLive]));
  assert.equal(live.segments.length, 1);
});

test("a turn another app is driving is followed closely instead of landing in one lump", async () => {

  // A task started in another OpenCode window runs on that window's own server and
  // never sends us its chunks. The shared store is all both apps can see, and it
  // records a thought when the thought ends, so the calm fifteen-second poll showed
  // a whole turn's thinking at once, after it was over.
  assert.ok(helpers.unownedTurnFollowMs <= 1_000, "an open externally owned turn must be followed within a second");
  assert.ok(helpers.unownedTurnSilenceMs < helpers.unownedTurnFollowMs + 1_000);
  assert.ok(helpers.unownedTurnFollowMs < helpers.quietCatchUpIntervalMs, "following must be closer than the calm heal poll");
  const now = Date.now();
  assert.equal(helpers.quietCatchUpDue(now - 200, now, helpers.unownedTurnSilenceMs), false, "live chunks keep the follow away");
  assert.equal(helpers.quietCatchUpDue(now - 5_000, now, helpers.unownedTurnSilenceMs), true);
});

test("a live thought stays open through settlement once the reader has seen it", async () => {
  const item = (id, kind, state, body = id) => ({ id, messageId: "msg_1", kind, title: kind === "reasoning" ? "Reasoning" : kind, body, timestamp: "2026-08-19T12:00:00.000Z", state });

  // Making the reader open the span and then the row meant a live thought was
  // normally missed: by the time both were open the turn had ended, so reasoning
  // only ever appeared finished. The one that is being written names itself.
  const running = timelineHelpers.groupTimeline([
    item("thought", "reasoning", "running", "Weighing the algorithms"),
    item("read", "tool", "completed"),
  ]);
  const live = timelineHelpers.liveReasoningIds(running);
  assert.equal(live.groups.length, 1);
  assert.equal(live.segments.length, 1);
  assert.equal(live.groups[0], timelineHelpers.reasoningGroupKey(running[0]));

  // A settled span names nothing, so nothing reopens under a reader scrolling back.
  const settled = timelineHelpers.groupTimeline([
    item("thought", "reasoning", "completed", "Weighed the algorithms"),
    item("read", "tool", "completed"),
  ]);
  assert.deepEqual(timelineHelpers.liveReasoningIds(settled), { groups: [], segments: [] });

  // Several thoughts in one provider message are separate rows, not one shared id.
  const twoThoughts = timelineHelpers.groupTimeline([
    item("first", "reasoning", "running", "First thought"),
    item("second", "reasoning", "running", "Second thought"),
  ]);
  const both = timelineHelpers.liveReasoningIds(twoThoughts);
  assert.equal(both.segments.length, 2);
  assert.equal(new Set(both.segments).size, 2, "each thought is its own row");

  // The live render opens immediately, then latches that observed disclosure into
  // the reader-owned set so terminal settlement and history reconciliation cannot
  // close it underneath the reader.
  assert.deepEqual([...timelineHelpers.activeDisclosureIds(new Set(), live.groups, new Set())], live.groups);
  const remembered = timelineHelpers.rememberLiveDisclosureIds(new Set(), live.groups, new Set());
  assert.deepEqual([...timelineHelpers.activeDisclosureIds(remembered, [], new Set())], live.groups);
  // Settled history that was never rendered live still starts compact.
  assert.deepEqual([...timelineHelpers.activeDisclosureIds(new Set(), [], new Set())], []);
  assert.deepEqual([...timelineHelpers.activeDisclosureIds(new Set(["manual"]), [], new Set())], ["manual"]);
});

test("closing a live thought remains authoritative through later chunks and settlement", () => {
  const live = ["reasoning:part:prt_live:0"];
  const remembered = timelineHelpers.rememberLiveDisclosureIds(new Set(), live, new Set());
  const closed = new Set(live);
  const readerOpened = new Set([...remembered].filter((id) => !closed.has(id)));

  const afterLaterChunk = timelineHelpers.rememberLiveDisclosureIds(readerOpened, live, closed);
  assert.deepEqual([...timelineHelpers.activeDisclosureIds(afterLaterChunk, live, closed)], []);
  assert.deepEqual([...timelineHelpers.activeDisclosureIds(afterLaterChunk, [], closed)], []);
});
test("thinking outlives its turn as a collapsed dropdown the reader controls", async () => {
  const thought = (over) => ({ id: "t", kind: "reasoning", title: "Reasoning", body: over, timestamp: "2026-08-15T12:00:00.000Z", state: "completed" });

  // Thinking is what survives the turn. Deleting every settled reasoning row to stop a
  // stuck-looking "Reasoning…" line also deleted the only route back to how an answer was
  // reached, so a thought and a status line have to stay distinguishable.
  assert.equal(timelineHelpers.carriesThinking(thought("I checked the adapter first.")), true);
  assert.equal(timelineHelpers.carriesThinking({ ...thought(""), title: "Mapped the interface" }), true);
  assert.equal(timelineHelpers.carriesThinking(thought("")), false);
  assert.equal(timelineHelpers.carriesThinking(thought("   ")), false);
  assert.equal(timelineHelpers.carriesThinking({ ...thought("x"), kind: "assistant" }), false);
  // The text decides, not the identity. A row naming the act rather than the thought is
  // dropped whoever sent it, and a row holding real thinking is kept whatever id it
  // arrives under — which is what lets the timeline stop recognising rows of its own.
  assert.equal(timelineHelpers.carriesThinking(thought("Reasoning…")), false);
  assert.equal(timelineHelpers.carriesThinking(thought("Thinking")), false);
  assert.equal(timelineHelpers.carriesThinking(thought("Working…")), false);
  assert.equal(timelineHelpers.carriesThinking({ ...thought("anything"), id: "tethoq-live-reasoning-x" }), true);
});

test("timeline groups execution detail under reasoning and removes wrapper metadata", () => {
  const item = (id, kind, title = kind, body = id) => ({ id, kind, title, body, timestamp: "2026-08-14T12:00:00.000Z", state: "completed" });
  const timeline = [
    item("reasoning", "reasoning", "Working", "I am checking the relevant source."),
    item("read", "tool", "read", "<path>C:\\project\\app.ts</path>\n<type>file</type>\n<content>const ready = true;</content>"),
    item("run", "command", "npm run typecheck", "Passed"),
    item("answer", "assistant", "assistant", "Done."),
  ];
  const grouped = timelineHelpers.groupTimeline(timeline);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].kind, "reasoning");
  assert.deepEqual(grouped[0].activities.map((activity) => activity.id), ["read", "run"]);
  assert.deepEqual(grouped[0].items.map((activity) => activity.id), ["reasoning", "read", "run"]);
  // Each activity is its own row now, so a run of two produces two segments.
  assert.deepEqual(timelineHelpers.reasoningSegments(grouped[0].items).map((segment) => segment.kind), ["thinking", "activity", "activity"]);
  const unlabelledActivity = [
    item("orphan-run", "command", "npm test", "Passed"),
    item("orphan-read", "file", "read app.ts", "const ready = true;"),
    item("failed", "tool", "write", "Permission denied"),
  ];
  unlabelledActivity[2].state = "failed";
  const unlabelledGroups = timelineHelpers.groupTimeline(unlabelledActivity);
  assert.equal(unlabelledGroups.length, 1);
  assert.equal(unlabelledGroups[0].kind, "reasoning");
  assert.deepEqual(unlabelledGroups[0].activities.map((activity) => activity.id), ["orphan-run", "orphan-read", "failed"]);
  const orphanError = item("provider-error", "error", "Agent error", "Raw provider trace");
  orphanError.state = "failed";
  const errorGroups = timelineHelpers.groupTimeline([orphanError]);
  assert.equal(errorGroups.length, 1);
  assert.equal(errorGroups[0].kind, "item");
  assert.equal(errorGroups[0].item.id, "provider-error");
  assert.equal(
    timelineHelpers.timelineErrorNoticeText({ ...orphanError, body: "exceeded retry limit, last status: 429 Too Many Requests, request id: a2b8789a78be2717-ORD" }),
    "exceeded retry limit, last status: 429 Too Many Requests",
  );
  assert.equal(timelineHelpers.activityLabel(timeline[1]), "Read");
  assert.equal(timelineHelpers.activityLabel(item("inspected", "tool", "Inspected application UI", "visible controls")), "Read");
  assert.equal(timelineHelpers.activityLabel(timeline[2]), "Run");
  const browserRead = item("browser", "tool", "js", '<a node_id="1" href="https://example.test">Example</a>');
  assert.equal(timelineHelpers.activityLabel(browserRead), "Read");
  assert.equal(timelineHelpers.activityTarget(browserRead), "");
  assert.equal(timelineHelpers.readableActivityBody(timeline[1].body), "const ready = true;");
  const browserResult = timelineHelpers.readableActivityBody(JSON.stringify({ executionId: "exec-secret", title: "OVHcloud", url: "https://example.test" }));
  assert.equal(browserResult, "OVHcloud\nhttps://example.test");
  assert.doesNotMatch(browserResult, /exec-secret/);
});

test("late provider reasoning is displayed before the final answer in its turn", () => {
  const entry = (id, kind, phase) => ({ id, kind, phase, title: kind, body: id, timestamp: "2026-08-16T00:00:00.000Z", state: "completed" });
  const normalized = timelineHelpers.normalizeFinalAnswerOrder([
    entry("user", "user"),
    entry("answer", "assistant", "final_answer"),
    entry("late-thinking", "reasoning"),
    entry("next-user", "user"),
  ]);
  assert.deepEqual(normalized.map((item) => item.id), ["user", "late-thinking", "answer", "next-user"]);
});

test("trailing diff echoes below an unphased final answer move above it once the turn settles", () => {
  const item = (id, kind, body = id) => ({ id, kind, title: kind, body, timestamp: "2026-08-18T12:00:00.000Z", state: "completed" });
  // OpenCode emits no final-answer phase and appends its session diff after the
  // answer text, so a settled turn can end with tool rows beneath the final
  // output. The last visible assistant row is that turn's answer; the echoed
  // rows belong above it, not below it ("the final output message should be the
  // final output message, and that's final").
  const turn = [
    item("user", "user", "continue"),
    item("thinking", "reasoning", "analysing"),
    item("edited", "file", "Edit file changed"),
    item("answer", "assistant", "Done."),
  ];
  const echoed = [...turn, item("echo-a", "file", "Edit file changed"), item("echo-b", "file", "Edit file changed")];
  assert.deepEqual(
    timelineHelpers.normalizeFinalAnswerOrder(echoed).map((entry) => entry.id),
    ["user", "thinking", "edited", "echo-a", "echo-b", "answer"],
  );
  // The reconcile is idempotent: re-running the same order changes nothing.
  const once = timelineHelpers.normalizeFinalAnswerOrder(echoed);
  assert.deepEqual(timelineHelpers.normalizeFinalAnswerOrder(once).map((entry) => entry.id), once.map((entry) => entry.id));
  // A still-live turn is left untouched: streaming output must not reshuffle.
  const live = [...turn, item("echo-a", "file", "Edit file changed")];
  live.find((entry) => entry.id === "answer").state = "running";
  assert.deepEqual(timelineHelpers.normalizeFinalAnswerOrder(live).map((entry) => entry.id), live.map((entry) => entry.id));
  // A turn whose provider declares phases moves trailing commentary back into
  // the work span so the explicit final answer remains visually final.
  const phased = [
    { ...turn[0] },
    { ...turn[1] },
    { ...turn[2] },
    { ...turn[3], phase: "final_answer" },
    item("late-commentary", "assistant", "PS.", undefined),
  ];
  phased[4].phase = "commentary";
  assert.deepEqual(timelineHelpers.normalizeFinalAnswerOrder(phased).map((entry) => entry.id), ["user", "thinking", "edited", "late-commentary", "answer"]);
  // An unphased turn without a visible assistant answer cannot pick a final row.
  const noAnswer = [turn[0], turn[1], item("edited", "file", "Edit file changed")];
  assert.deepEqual(timelineHelpers.normalizeFinalAnswerOrder(noAnswer).map((entry) => entry.id), noAnswer.map((entry) => entry.id));
});

test("timeline keeps one outer reasoning group while preserving inner chronology", () => {
  const item = (id, kind, title = kind, body = id) => ({ id, kind, title, body, timestamp: "2026-08-14T12:00:00.000Z", state: "completed" });
  const timeline = [
    item("opening", "assistant", "assistant", "I’ll inspect this."),
    item("thought-a", "reasoning", "Working", "**Considering account location** and controller state before acting."),
    item("read", "tool", "read C:\\project\\controller.ts", "const active = true;"),
    item("run", "command", "npm test", "Passed"),
    item("thought-b", "reasoning", "Working", "Checking the next safe action."),
    item("write", "file", "edit controller.ts", "patched"),
    item("answer", "assistant", "assistant", "Done."),
    item("later-thought", "reasoning", "Working", "This belongs to the next span."),
  ];
  const groups = timelineHelpers.groupTimeline(timeline);
  assert.deepEqual(groups.map((group) => group.kind), ["reasoning", "item", "reasoning"]);
  assert.deepEqual(groups[0].items.map((entry) => entry.id), ["opening", "thought-a", "read", "run", "thought-b", "write"]);
  const segments = timelineHelpers.reasoningSegments(groups[0].items);
  assert.deepEqual(segments.map((segment) => segment.kind), ["thinking", "thinking", "activity", "activity", "thinking", "activity"]);
  assert.deepEqual(segments.map((segment) => segment.kind === "thinking" ? [segment.item.id] : segment.items.map((entry) => entry.id)), [
    ["opening"], ["thought-a"], ["read"], ["run"], ["thought-b"], ["write"],
  ]);
  assert.equal(timelineHelpers.reasoningPreview(timeline[1]), "Considering account location and controller state before acting.");
  assert.equal(timelineHelpers.reasoningPreview(item("summary", "reasoning", "Checked controller state", "verbose raw thought")), "Checked controller state");
  assert.equal(timelineHelpers.formatReasoningText("Verify then poll.Poll until done. `keep.This`\n```txt\nkeep.This\n```\nRead frames.This is ready."), "Verify then poll. Poll until done. `keep.This`\n```txt\nkeep.This\n```\nRead frames. This is ready.");
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(item("same", "reasoning", "Working", "One complete thought.")), false);
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(item("one-more", "reasoning", "One complete thought.", "One complete thought.!")), true);
  // An empty thought must never fall back to a generic title word like "Working":
  // the group already says Reasoning, so the row only needs to say it is thinking.
  assert.equal(timelineHelpers.reasoningPreview(item("empty-thought", "reasoning", "Working", "")), "Thinking…");
  assert.doesNotMatch(timelineHelpers.reasoningPreview(item("empty-thought", "reasoning", "Working", "")), /working/iu);
  // A running thought leads with its freshest lines so the row visibly feeds
  // through while the model streams, instead of freezing on the opening sentence.
  const longRunning = item("live-thought", "reasoning", "Working", `Opening sentence stays constant. ${"The model keeps writing more reasoning. ".repeat(14)}The newest line is the freshest.`);
  longRunning.state = "running";
  assert.ok(timelineHelpers.reasoningPreview(longRunning).endsWith("The newest line is the freshest."));
  assert.doesNotMatch(timelineHelpers.reasoningPreview(longRunning), /Opening sentence/u);
  const liveThought = { ...item("stable-thought", "reasoning", "Reasoning", "Inspecting the state flow."), messageId: "live-message" };
  const liveCommand = { ...item("stable-command", "command", "npm test", "npm test"), messageId: "call-live", state: "running" };
  const beforeCommand = timelineHelpers.reasoningSegments([liveThought], "stable-group");
  const duringCommand = timelineHelpers.reasoningSegments([liveThought, liveCommand], "stable-group");
  const afterCommand = timelineHelpers.reasoningSegments([liveThought, { ...liveCommand, state: "completed", body: "12 tests passed" }], "stable-group");
  assert.equal(duringCommand.find((segment) => segment.kind === "thinking")?.item.state, "completed", "later activity must not reactivate historical reasoning text");
  assert.equal(afterCommand.find((segment) => segment.kind === "thinking")?.item.state, "completed", "settled spans stop text shimmer with the icon");
  assert.equal(beforeCommand[0].id, duringCommand[0].id, "adjacent activity does not remount or remove the reasoning text row");
  assert.equal(duringCommand.length, afterCommand.length, "command completion updates rows in place without structural jitter");
  const separatedByEmptyAssistant = timelineHelpers.groupTimeline([
    item("before-empty", "reasoning", "Working", "First span"),
    item("empty-provider-row", "assistant", "assistant", ""),
    item("after-empty", "reasoning", "Working", "Second span"),
  ]);
  assert.deepEqual(separatedByEmptyAssistant.map((group) => group.kind), ["reasoning"]);
  assert.deepEqual(separatedByEmptyAssistant[0].items.map((entry) => entry.id), ["before-empty", "after-empty"]);

  const sameMessageGroups = timelineHelpers.groupTimeline([
    { ...item("same-a", "reasoning", "Working", "First span"), messageId: "shared-message" },
    { ...item("separator", "assistant", "assistant", "Visible answer"), messageId: "answer-message" },
    { ...item("same-b", "reasoning", "Working", "Second span"), messageId: "shared-message" },
  ]).filter((group) => group.kind === "reasoning");
  assert.deepEqual(sameMessageGroups.map(timelineHelpers.reasoningGroupKey), [
    "reasoning:message:shared-message:0",
    "reasoning:message:shared-message:1",
  ]);
  const segmentKeys = sameMessageGroups.flatMap((group) => timelineHelpers.reasoningSegments(group.items, timelineHelpers.reasoningGroupKey(group)).map((segment) => segment.id));
  assert.equal(new Set(segmentKeys).size, segmentKeys.length, "separate groups never reuse a React segment key");
});

test("an activity-first Reasoning group keeps its identity when thinking arrives", () => {
  const tool = { id: "tool-live", kind: "tool", title: "Read", body: "controller.ts", detail: "call_7", timestamp: "2026-08-20T10:00:00.000Z", state: "running" };
  const thought = { id: "reasoning-live", providerPartId: "prt_8", messageId: "msg_8", kind: "reasoning", title: "Reasoning", body: "Checking the controller", timestamp: "2026-08-20T10:00:01.000Z", state: "running" };

  const before = timelineHelpers.groupTimeline([tool], true)[0];
  const after = timelineHelpers.groupTimeline([tool, thought], true)[0];
  assert.equal(timelineHelpers.reasoningGroupKey(before), timelineHelpers.reasoningGroupKey(after));
  assert.equal(timelineHelpers.reasoningGroupKey(after), "reasoning:activity:tool:call_7:0");
});

test("folding earlier narration does not rename an existing Reasoning disclosure", () => {
  const timeline = [
    { id: "narration", providerPartId: "prt_text", messageId: "msg_1", kind: "assistant", phase: "commentary", body: "I’ll inspect it.", timestamp: "2026-08-20T10:00:00.000Z", state: "completed" },
    { id: "thought", providerPartId: "prt_reasoning", messageId: "msg_1", kind: "reasoning", title: "Reasoning", body: "Checking the adapter.", timestamp: "2026-08-20T10:00:01.000Z", state: "completed" },
    { id: "answer", providerPartId: "prt_answer", messageId: "msg_1", kind: "assistant", phase: "final_answer", body: "Fixed.", timestamp: "2026-08-20T10:00:02.000Z", state: "completed" },
  ];

  const liveGroup = timelineHelpers.groupTimeline(timeline, true).find((group) => group.kind === "reasoning");
  const settledGroup = timelineHelpers.groupTimeline(timeline, false).find((group) => group.kind === "reasoning");
  assert.deepEqual(liveGroup.items.map((item) => item.id), ["thought"]);
  assert.deepEqual(settledGroup.items.map((item) => item.id), ["narration", "thought"]);
  assert.equal(timelineHelpers.reasoningGroupKey(liveGroup), "reasoning:part:prt_reasoning:0");
  assert.equal(timelineHelpers.reasoningGroupKey(settledGroup), timelineHelpers.reasoningGroupKey(liveGroup));
  const liveAnchors = timelineHelpers.renderedTimelineAnchorIds(timeline, true);
  const settledAnchors = timelineHelpers.renderedTimelineAnchorIds(timeline, false);
  assert.equal(liveAnchors.includes("reasoning:part:prt_reasoning:0"), true);
  assert.equal(settledAnchors.includes("reasoning:part:prt_reasoning:0"), true, "live-to-settled folding keeps the Reasoning scroll anchor");
  assert.equal(settledAnchors.includes("narration"), false, "folded narration no longer claims a separate painted row");
});

test("timeline omits empty provider deltas instead of rendering control-only shells", () => {
  const item = (id, kind, body = "") => ({ id, kind, body, timestamp: "2026-08-14T12:00:00.000Z", state: "completed" });
  const empty = item("empty", "assistant");
  const heartbeat = item("heartbeat", "user", "<heartbeat>\n  <automation_id>check</automation_id>\n</heartbeat>");
  const imageOnly = { ...item("image", "assistant"), images: [{ name: "preview.png", dataUrl: "data:image/png;base64,AA==" }] };
  const answer = item("answer", "assistant", "Visible answer");

  assert.equal(timelineHelpers.hasVisibleTimelineContent(empty), false);
  assert.equal(timelineHelpers.hasVisibleTimelineContent(heartbeat), false);
  assert.equal(timelineHelpers.hasVisibleTimelineContent(imageOnly), true);
  const grouped = timelineHelpers.groupTimeline([empty, heartbeat, imageOnly, answer]);
  assert.deepEqual(grouped.map((group) => group.kind), ["reasoning", "item"]);
  assert.deepEqual(grouped[0].items.map((item) => item.id), ["image"]);
  assert.equal(grouped[1].item.id, "answer");
  assert.equal(timelineHelpers.shouldShowAssistantIdentity([empty, answer], 0), false);
  assert.equal(timelineHelpers.shouldShowAssistantIdentity([empty, answer], 1), true);
});

test("timeline marks real compaction notices and the transition into a final answer", () => {
  const item = (id, kind, body, title) => ({ id, kind, body, ...(title ? { title } : {}), timestamp: "2026-08-14T12:00:00.000Z", state: "completed" });
  const timeline = [
    item("user", "user", "Please inspect this."),
    item("commentary", "assistant", "I’ll inspect the relevant source."),
    item("reasoning", "reasoning", "Checking the renderer."),
    item("final", "assistant", "### Fixed\n\nDone."),
  ];
  timeline[1].phase = "commentary";
  timeline[3].phase = "final_answer";
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer(timeline, 1), false);
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer(timeline, 3), true);
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer([timeline[0], timeline[3]], 1), false);

  const compaction = item("compact", "assistant", "Context automatically compacted");
  const system = item("system", "assistant", "Provider reconnected.", "System update");
  assert.equal(timelineHelpers.timelineBoundaryLabel(compaction), "Session compacted");
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("manual-compact", "assistant", "Context compacted")), "Session compacted");
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("session-compact", "assistant", "Session compacted")), "Session compacted");
  assert.equal(timelineHelpers.timelineBoundaryLabel(system), "Provider reconnected.");
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("question", "user", "Context automatically compacted")), null);
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("explanation", "assistant", "If context automatically compacted, this explanation remains a normal answer.")), null);
  assert.equal(timelineHelpers.groupTimeline([compaction])[0].kind, "boundary");
  assert.match(timelineHelpers.compactionDetailText(compaction, "Session compacted"), /automatically summarized/);
  assert.equal(timelineHelpers.compactionDetailText({ ...compaction, detail: "42,000 tokens were condensed." }, "Session compacted"), "42,000 tokens were condensed.");
  const summaryText = "Another language model started to solve this problem and produced a summary of its thinking process.\n\n## Current task progress\n\nKeep the disclosure compact.\n\n## Next steps\n\nVerify it.";
  const summary = { ...item("summary", "assistant", summaryText), phase: "commentary" };
  assert.equal(timelineHelpers.timelineBoundaryLabel(summary), "Session compacted");
  assert.equal(timelineHelpers.compactionDetailText(summary, "Session compacted"), summaryText);
  const boundaryGroups = timelineHelpers.groupTimeline([timeline[0], timeline[2], summary, timeline[3]], false);
  assert.deepEqual(boundaryGroups.map((group) => group.kind), ["item", "reasoning", "boundary", "item"]);
  assert.equal(boundaryGroups[2].item.id, "summary", "compaction remains a directly visible transcript widget");
  const formattedSummary = { ...item("formatted-summary", "reasoning", summaryText.replace(/^.*?\n\n/u, "")), messageId: "compaction-turn" };
  const repeatedSummary = { ...summary, id: "repeated-summary", messageId: "compaction-turn" };
  const deduplicated = timelineHelpers.reasoningSegments([formattedSummary, repeatedSummary]);
  assert.deepEqual(deduplicated.map((segment) => segment.kind), ["compaction"]);
  assert.equal(deduplicated[0].item.id, "repeated-summary");
  assert.equal(deduplicated[0].item.detail, formattedSummary.body);
  assert.deepEqual(timelineHelpers.reasoningSegments([repeatedSummary]).map((segment) => segment.kind), ["compaction"]);
  const activeCopies = timelineHelpers.coalesceCompactionCopies([timeline[0], formattedSummary, repeatedSummary]);
  assert.deepEqual(activeCopies.map((entry) => entry.id), ["user", "repeated-summary"], "active external history keeps only the later compaction event");
  assert.equal(activeCopies[1].detail, formattedSummary.body, "the one disclosure retains the readable summary as hidden detail");
  const citationSuffix = "\n\n<oai-mem-citation>private presentation metadata</oai-mem-citation>";
  const transportCopy = { ...repeatedSummary, id: "transport-copy", body: `${repeatedSummary.body}\n\nThe worktree remains dirty.` , timestamp: "2026-08-14T12:00:01.000Z" };
  const readableCopy = { ...item("readable-copy", "assistant", `${formattedSummary.body}${citationSuffix}`), phase: "final_answer", timestamp: "2026-08-14T12:00:00.000Z" };
  const provenanceMatched = timelineHelpers.coalesceCompactionCopies([timeline[0], readableCopy, transportCopy]);
  assert.deepEqual(provenanceMatched.map((entry) => entry.id), ["user", "transport-copy"], "adjacent explicit compaction provenance does not depend on equal bodies");
  assert.equal(provenanceMatched[1].detail, formattedSummary.body, "presentation metadata is absent from the disclosure detail");
  assert.equal(timelineHelpers.coalesceCompactionCopies([
    timeline[0],
    formattedSummary,
    { ...repeatedSummary, id: "after-user-copy" },
    item("next-user", "user", "Continue."),
    { ...formattedSummary, id: "same-text-next-turn" },
  ]).length, 4, "matching prose in a later user turn is never swallowed");
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer([timeline[0], compaction, timeline[3]], 2), false);
  const running = { ...timeline[3], id: "running", phase: undefined, state: "running" };
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer([timeline[0], timeline[2], running], 2), false);
  const activeUnphasedAnswer = { ...timeline[3], phase: undefined, state: "completed" };
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer([timeline[0], timeline[2], activeUnphasedAnswer], 2, true), false);
});

test("queued new-task reasoning reuses only the newest supported concrete effort", () => {
  const model = { id: "model-a", name: "Model A", efforts: ["low", "high"] };
  const sessions = [
    { providerId: "codex", model: "model-a", effort: "low", updatedAt: "2026-08-15T10:00:00.000Z" },
    { providerId: "codex", model: "model-a", effort: "auto", updatedAt: "2026-08-16T12:00:00.000Z" },
    { providerId: "codex", model: "model-a", effort: "high", updatedAt: "2026-08-16T11:00:00.000Z" },
    { providerId: "grok", model: "model-a", effort: "low", updatedAt: "2026-08-16T13:00:00.000Z" },
  ];
  assert.equal(composerUi.mostRecentReasoningForModel(sessions, "codex", model), "high");
  assert.equal(composerUi.mostRecentReasoningForModel(sessions, "grok", { ...model, efforts: ["medium"] }), undefined);
});

test("recent models follow real session activity instead of unsent picker choices", () => {
  const models = {
    codex: [
      { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
      { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    ],
    grok: [{ id: "grok-4.6", name: "Grok 4.6" }],
    opencode: [
      { id: "opencode-go/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
  };
  const sessions = [
    { providerId: "codex", model: "gpt-5.6-luna", updatedAt: "2026-08-28T10:00:00.000Z" },
    { providerId: "opencode", model: "deepseek/deepseek-v4-pro", updatedAt: "2026-08-28T11:00:00.000Z" },
    { providerId: "opencode", model: "opencode-go/deepseek-v4-pro", updatedAt: "2026-08-28T12:00:00.000Z" },
    { providerId: "grok", model: "GROK 4.6", updatedAt: "2026-08-28T13:00:00.000Z" },
    { providerId: "codex", model: "gpt-5.6-sol", updatedAt: "2026-08-28T14:00:00.000Z" },
    { providerId: "codex", model: "gpt-5.6-sol", updatedAt: "2026-08-28T15:00:00.000Z" },
    { providerId: "opencode", model: "DeepSeek V4 Pro", updatedAt: "2026-08-28T16:00:00.000Z" },
    { providerId: "codex", model: "gpt-5.6-luna", updatedAt: "2026-08-28T17:00:00.000Z", draft: true },
    { providerId: "grok", model: "grok-4.6", updatedAt: "2026-08-28T18:00:00.000Z", sessionKind: "internal" },
    { providerId: "codex", model: "default", updatedAt: "2026-08-28T19:00:00.000Z" },
    { providerId: "codex", model: "model-no-longer-advertised", updatedAt: "2026-08-28T20:00:00.000Z" },
  ];

  assert.deepEqual(composerUi.recentModelKeysFromSessions(sessions, models), [
    "codex:gpt-5.6-sol",
    "grok:grok-4.6",
    "opencode:opencode-go/deepseek-v4-pro",
    "opencode:deepseek/deepseek-v4-pro",
    "codex:gpt-5.6-luna",
  ]);
  assert.deepEqual(composerUi.recentModelKeysFromSessions(sessions, models, 2), [
    "codex:gpt-5.6-sol",
    "grok:grok-4.6",
  ]);
  assert.deepEqual(composerUi.recentModelKeysFromSessions(sessions, models, 0), []);
});

test("recent model usage keeps the previous model after a task switches models", () => {
  const models = {
    codex: [
      { id: "model-a", name: "Model A" },
      { id: "model-b", name: "Model B" },
    ],
    opencode: [{ id: "model-c", name: "Model C" }],
  };
  const previouslyUsed = [
    { key: "codex:model-a", usedAt: Date.parse("2026-08-28T10:00:00.000Z") },
    // Temporarily unavailable models stay in history without occupying a visible row.
    { key: "opencode:model-temporarily-unavailable", usedAt: Date.parse("2026-08-28T09:00:00.000Z") },
  ];
  const switchedSession = [
    { providerId: "codex", model: "model-b", updatedAt: "2026-08-28T11:00:00.000Z" },
  ];

  assert.deepEqual(composerUi.recentModelKeysFromUsage(switchedSession, models, previouslyUsed), [
    "codex:model-b",
    "codex:model-a",
  ]);
  assert.deepEqual(composerUi.mergeRecentModelUses(previouslyUsed, [
    { key: "codex:model-b", usedAt: Date.parse("2026-08-28T11:00:00.000Z") },
    { key: "codex:model-a", usedAt: Date.parse("2026-08-28T12:00:00.000Z") },
    { key: "broken", usedAt: Number.NaN },
  ], 5), [
    { key: "codex:model-a", usedAt: Date.parse("2026-08-28T12:00:00.000Z") },
    { key: "codex:model-b", usedAt: Date.parse("2026-08-28T11:00:00.000Z") },
    { key: "opencode:model-temporarily-unavailable", usedAt: Date.parse("2026-08-28T09:00:00.000Z") },
  ]);
});

test("side chat hides injected parent context and keeps only its own conversation", () => {
  const copiedContext = { id: "host:provider:session:copied:1-0", kind: "user", body: "Parent transcript copied as context", timestamp: "2026-08-16T00:00:00.000Z", state: "completed" };
  const copiedAnswer = { id: "host:provider:session:copied:2-0", kind: "assistant", body: "Copied parent answer", timestamp: "2026-08-16T00:00:00.000Z", state: "completed" };
  const copiedMessageId = { id: "host:provider:session:real-0", messageId: "copied:provider-msg:3", kind: "user", body: "Copied by message id marker", timestamp: "2026-08-16T00:00:00.000Z", state: "completed" };
  const ownQuestion = { id: "host:provider:session:real-1-0", kind: "user", body: "My question", timestamp: "2026-08-16T00:00:00.000Z", state: "completed" };
  const ownAnswer = { id: "host:provider:session:real-2-0", kind: "assistant", body: "My answer", timestamp: "2026-08-16T00:00:00.000Z", state: "completed" };
  const visible = composerUi.visibleSideChatTimeline([copiedContext, copiedAnswer, copiedMessageId, ownQuestion, ownAnswer]);
  assert.deepEqual(visible.map((item) => item.id), ["host:provider:session:real-1-0", "host:provider:session:real-2-0"]);
  assert.deepEqual(composerUi.visibleSideChatTimeline([copiedContext, copiedAnswer, copiedMessageId]), []);
  assert.deepEqual(composerUi.visibleSideChatTimeline([]), []);
});

test("one answer's interim narration stays inside a single Reasoning block", () => {
  // OpenCode splits one assistant message into several parts: it thinks, narrates
  // what it is about to do, thinks again, then answers. Treating the narration as
  // a finished answer produced a run of identical top-level Reasoning labels.
  const message = "msg_single";
  const timeline = [
    { id: "s:reasoning:prt_a", messageId: message, kind: "reasoning", body: "Checking the config.", state: "completed", timestamp: "2026-08-17T00:00:01.000Z" },
    { id: "s:assistant:prt_b", messageId: message, kind: "assistant", body: "Looking at the configuration now.", state: "completed", timestamp: "2026-08-17T00:00:02.000Z" },
    { id: "s:reasoning:prt_c", messageId: message, kind: "reasoning", body: "The port was already taken.", state: "completed", timestamp: "2026-08-17T00:00:03.000Z" },
    { id: "s:assistant:prt_d", messageId: message, kind: "assistant", body: "The server could not bind because the port was in use.", state: "completed", timestamp: "2026-08-17T00:00:04.000Z" },
  ];

  const groups = timelineHelpers.groupTimeline(timeline);

  assert.deepEqual(groups.map((group) => group.kind), ["reasoning", "item"]);
  assert.equal(groups[0].items.length, 3);
  // The last text of the message is the answer and keeps its own row.
  assert.equal(groups[1].item.body, "The server could not bind because the port was in use.");
});

test("a settled unphased turn leaves only its last answer outside Reasoning", () => {
  const timeline = [
    { id: "s:reasoning:r1", messageId: "msg_one", kind: "reasoning", body: "First thought.", state: "completed", timestamp: "2026-08-17T00:00:01.000Z" },
    { id: "s:assistant:a1", messageId: "msg_one", kind: "assistant", body: "First answer.", state: "completed", timestamp: "2026-08-17T00:00:02.000Z" },
    { id: "s:reasoning:r2", messageId: "msg_two", kind: "reasoning", body: "Second thought.", state: "completed", timestamp: "2026-08-17T00:00:03.000Z" },
    { id: "s:assistant:a2", messageId: "msg_two", kind: "assistant", body: "Second answer.", state: "completed", timestamp: "2026-08-17T00:00:04.000Z" },
  ];

  const groups = timelineHelpers.groupTimeline(timeline);

  assert.deepEqual(groups.map((group) => group.kind), ["reasoning", "item"]);
  assert.deepEqual(groups[0].items.map((item) => item.id), ["s:reasoning:r1", "s:assistant:a1", "s:reasoning:r2"]);
  assert.equal(groups[1].item.id, "s:assistant:a2");
  // While the same turn is live, narration remains in normal transcript flow.
  assert.deepEqual(timelineHelpers.groupTimeline(timeline, true).map((group) => group.kind), ["reasoning", "item", "reasoning", "item"]);
});

test("Mesh children stay with their exact originating prompt across completion and history ordering", () => {
  const user = { id: "mesh-user", kind: "user", body: "Ask the four targets.", timestamp: "2026-09-05T11:48:02Z", delegationId: "mesh-one" };
  const reasoning = { id: "mesh-reasoning", kind: "reasoning", body: "Assigning the work.", state: "completed" };
  const dispatch = { id: "mesh-dispatch", kind: "tool", title: "Uar_mesh_dispatch_delegation", body: "", state: "completed" };
  const answer = { id: "mesh-answer", kind: "assistant", body: "20, 10, 19, hello.", state: "completed" };
  const nextUser = { id: "next-user", kind: "user", body: "A different request.", delegationId: "mesh-two" };
  const children = Array.from({ length: 4 }, (_, index) => ({ id: `child-${index}`, kind: "subagent", childSessionId: `session-${index}`, delegationId: "mesh-one", timestamp: "2026-09-05T11:48:01Z", body: "Spawned sub-agent", state: "completed" }));
  const nextChild = { ...children[0], id: "next-child", childSessionId: "next-session", delegationId: "mesh-two" };
  for (const input of [
    [...children, user, reasoning, dispatch, answer, nextUser, nextChild],
    [user, reasoning, dispatch, answer, nextUser, nextChild, ...children],
  ]) {
    const anchored = timelineHelpers.anchorMeshChildren(input);
    assert.deepEqual(anchored, [user, reasoning, dispatch, ...children, answer, nextUser, nextChild]);
    assert.equal(timelineHelpers.anchorMeshChildren(anchored), anchored, "a refresh must not reshuffle an already anchored turn");
    const groups = timelineHelpers.groupTimeline(anchored);
    assert.deepEqual(groups[1].items, [reasoning, dispatch, ...children]);
    assert.equal(groups[2].item, answer);
    assert.equal(groups[3].item, nextUser);
  }
  const running = children.map((child) => ({ ...child, state: "running" }));
  const liveGroups = timelineHelpers.groupTimeline(timelineHelpers.anchorMeshChildren([...running, user, reasoning, dispatch, answer]), true);
  assert.equal(liveGroups.filter((group) => group.kind === "item" && group.item.kind === "subagent").length, 4, "unfinished workers must stay directly visible");
  const partialHistory = [...children, nextUser];
  assert.equal(timelineHelpers.anchorMeshChildren(partialHistory), partialHistory, "missing history must not attach a child to another user's prompt");
});

test("terminal reasoning folding is provider-neutral", () => {
  const item = (id, kind, body, phase) => ({ id, kind, body, ...(phase ? { phase } : {}), state: "completed", timestamp: "2026-08-20T00:00:00.000Z" });
  const codex = [
    item("codex-user", "user", "Fix it"),
    item("codex-commentary", "assistant", "Inspecting the source.", "commentary"),
    item("codex-tool", "tool", "Read file"),
    item("codex-final", "assistant", "Fixed.", "final_answer"),
  ];
  const unphased = (provider) => [
    item(`${provider}-user`, "user", "Fix it"),
    item(`${provider}-thought`, "reasoning", "Inspecting the source."),
    item(`${provider}-artifact`, "assistant", "Running the focused checks."),
    item(`${provider}-tool`, "command", "Tests passed"),
    item(`${provider}-final`, "assistant", "Fixed."),
  ];

  for (const timeline of [codex, unphased("opencode"), unphased("grok")]) {
    const groups = timelineHelpers.groupTimeline(timeline);
    assert.deepEqual(groups.map((group) => group.kind), ["item", "reasoning", "item"]);
    assert.equal(groups[1].items.some((entry) => entry.kind === "assistant"), true);
    assert.equal(groups[2].item.body, "Fixed.");
  }
  // A live turn remains unfolded until terminal evidence arrives.
  assert.deepEqual(timelineHelpers.groupTimeline(codex, true).map((group) => group.kind), ["item", "item", "reasoning", "item"]);
});

test("history paging measures new collapsed transcript rows rather than raw provider records", () => {
  const row = (id, kind, body, phase) => ({ id, messageId: id, kind, body, ...(phase ? { phase } : {}), state: "completed", timestamp: "2026-08-25T10:00:00.000Z" });
  const boundary = row("reasoning-boundary", "reasoning", "Existing thought");
  const final = row("final", "assistant", "Answer", "final_answer");
  const before = [boundary, final];
  // The provider can replay the boundary and add a tool member behind it. The
  // DOM still has the same Reasoning anchor, so this is not visible progress.
  const foldedOnly = [boundary, row("older-tool", "tool", "Older tool activity"), final];
  const withCompaction = [boundary, row("older-tool", "tool", "Older tool activity"), row("older-compaction", "assistant", "Session compacted", "commentary"), final];
  const withConversation = [row("older-user", "user", "Older question"), ...foldedOnly];

  const reasoningAnchor = "reasoning:message:reasoning-boundary:0";
  assert.deepEqual(timelineHelpers.renderedTimelineAnchorIds(before), [reasoningAnchor, "final"]);
  assert.deepEqual(timelineHelpers.renderedTimelineAnchorIds(foldedOnly), [reasoningAnchor, "final"]);
  assert.deepEqual(timelineHelpers.renderedTimelineAnchorIds(withCompaction), [reasoningAnchor, "older-compaction", "final"], "a compaction page creates a real visible history anchor");
  assert.deepEqual(timelineHelpers.renderedTimelineAnchorIds(withConversation), ["older-user", reasoningAnchor, "final"]);
});

test("EYES retries paint one failure notice per user turn", () => {
  const row = (id, kind, extra = {}) => ({
    id,
    kind,
    body: id,
    state: "completed",
    timestamp: "2026-08-28T12:00:00.000Z",
    ...extra,
  });
  const firstUser = row("user-one", "user");
  const firstFailure = row("eyes-one", "tool", { notice: "eyes_failure" });
  const retryFailure = row("eyes-two", "tool", { notice: "eyes_failure" });
  const secondUser = row("user-two", "user");
  const laterFailure = row("eyes-three", "tool", { notice: "eyes_failure" });
  const timeline = [firstUser, firstFailure, retryFailure, secondUser, laterFailure];

  assert.deepEqual(
    timelineHelpers.coalesceEyesFailureNotices(timeline).map((item) => item.id),
    ["user-one", "eyes-one", "user-two", "eyes-three"],
  );
  const alreadyClean = [firstUser, firstFailure, secondUser, laterFailure];
  assert.strictEqual(timelineHelpers.coalesceEyesFailureNotices(alreadyClean), alreadyClean);
});

test("the microphone is offered only where the model can genuinely hear audio", async () => {
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }), false);
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "gpt-5.6-sol", inputModalities: ["text", "image"] }), false);
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "gemini-3.6-flash", inputModalities: ["text", "image", "audio"] }), true);
  assert.equal(helpers.modelAcceptsDirectAudio(undefined), false);
});
