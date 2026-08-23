import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
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
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "composer_helpers.ts")],
  outfile: helperBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "ChatTimeline.tsx")],
  outfile: timelineBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "Composer.tsx")],
  outfile: composerUiBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  loader: { ".css": "empty" },
});
// The composer reaches the bridge module now, and that module reads `window` as it
// loads. Nothing here renders, so a bare stand-in is enough to import it.
globalThis.window ??= { location: { hash: "" }, addEventListener() {}, removeEventListener() {} };
globalThis.location ??= globalThis.window.location;
const helpers = await import(`file:///${helperBundle.replaceAll("\\", "/")}`);
const timelineHelpers = await import(`file:///${timelineBundle.replaceAll("\\", "/")}`);
const composerUi = await import(`file:///${composerUiBundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });
const source = async (path) => readFile(join(appRoot, path), "utf8");

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
  assert.equal(calls.some((call) => call.type.startsWith("session.")), false);
});

test("one idle externally-owned Codex submission queues exactly once without a direct send", async () => {
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

  assert.deepEqual(calls, ["message_queue.enqueue"]);
  assert.equal(calls.filter((type) => type === "session.send_message").length, 0);
  assert.equal(helpers.composerMessageRequestType({
    liveGuidance: true,
    hasAttachments: false,
    blockedByAttention: true,
    queueingEnabled: false,
    externalWriter: true,
  }), "message_queue.enqueue", "external ownership must outrank direct steering mode");
});

test("an externally-owned Codex attachment uses the acknowledged owner turn path", () => {
  assert.equal(helpers.composerMessageRequestType({
    liveGuidance: false,
    hasAttachments: true,
    blockedByAttention: false,
    queueingEnabled: true,
    externalWriter: true,
    externalWriterAttachmentsSupported: true,
  }), "session.send_message");
  assert.equal(helpers.composerMessageRequestType({
    liveGuidance: false,
    hasAttachments: true,
    blockedByAttention: false,
    queueingEnabled: true,
    externalWriter: true,
    externalWriterAttachmentsSupported: false,
  }), "message_queue.enqueue", "unsupported owner transports must not fake an attachment send");
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

test("the microphone menu always lists MP3 in an unlimited section with an explainer", async () => {
  const [composer, css] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  // The MP3 row is always visible where recordings can be attached, under a
  // section labelled unlimited - generous tier wording, never "free".
  assert.match(composer, /onAudio !== undefined \? \{[\s\S]*?label: "MP3"/u);
  assert.match(composer, /<div className="dictation-section-label"><h5>unlimited<\/h5>/u);
  assert.doesNotMatch(composer, />free<\/h5>/u);
  // Spacing and one quiet rule distinguish the included route from metered
  // provider-key transcription without wrapping either group in another card.
  assert.match(composer, /dictation-source-unavailable.*?\} key=\{directAudioId\} onClick=\{\(\) => select\(directAudioSource\)\}/u);
  assert.match(composer, /<div className="dictation-api-heading"><strong>API transcription<\/strong><small>Uses your provider API key<\/small><\/div>/u);
  assert.match(composer, /className="dictation-sources-scroll" role="group" aria-label="API transcription sources"/u);
  assert.match(css, /\.dictation-source-menu \.composer-popover[^{]*\{[^}]*overflow:\s*visible/u);
  assert.match(css, /\.dictation-sources-scroll \{[^}]*max-height:\s*216px[^}]*overflow-y:\s*hidden/u);
  assert.match(css, /\.dictation-sources-scroll:has\(> button:nth-child\(5\)\) \{[^}]*overflow-y:\s*auto/u);
  assert.match(css, /\.dictation-api-heading \{[^}]*border-top:\s*1px solid #383834/u);
  assert.match(css, /\.dictation-unlimited-group > button, \.dictation-sources-scroll > button \{[^}]*min-height:\s*54px/u);
  // The info 'i' explains why the option exists; unavailable models disable the
  // row instead of hiding it, and the tooltip says so honestly. Its box anchors
  // to the right edge so it can never be cut off by the window.
  assert.match(composer, /className="dictation-info-button" aria-label="About MP3 dictation" data-tooltip-align="end"/u);
  assert.match(composer, /This model allows audio input, so a recording can be used as a dictation alternative\./u);
  assert.match(composer, /This model does not accept audio input\. Recording becomes available with an audio-capable model or EARS transcription\./u);
  assert.match(composer, /disabled=\{!directAudioEnabled\}/u);
  assert.match(composer, /"This model cannot hear a recording"/u);
  assert.match(css, /\.dictation-source-unavailable[^{]*\{[^}]*opacity: \.62/u);
});

test("dictation exposes a persistent microphone picker and a compact wide MP3 widget", async () => {
  const [composer, recorder, css] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "audio_dictation.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  assert.match(composer, /className="dictation-device-settings" aria-label="Choose microphone"/u);
  assert.match(composer, /navigator\.mediaDevices[\s\S]*?enumerateDevices\(\)/u);
  assert.match(composer, /labelsUnavailable[\s\S]*?getUserMedia\(\{ audio: true, video: false \}\)[\s\S]*?getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/u);
  assert.match(composer, /tethoq:dictation-microphone-device/u);
  assert.match(composer, /Default microphone[\s\S]*?Follows the current Windows default/u);
  assert.match(composer, /requestMicrophoneStream\(\)[\s\S]*?recorder\.start\(stream\)/u);
  assert.match(composer, /const stream = await requestMicrophoneStream\(\);[\s\S]*?new MediaRecorder\(stream/u);
  assert.match(recorder, /public async start\(inputStream\?: MediaStream\)/u);
  assert.match(css, /\.audio-playback-dictation \{[^}]*min-width:\s*252px[^}]*grid-template-columns:\s*26px 148px minmax\(30px,auto\) 22px[^}]*grid-template-rows:\s*18px 12px/u);
  assert.match(css, /\.audio-playback-dictation \.audio-dictation-mark \{[^}]*grid-column:\s*2[^}]*grid-row:\s*2/u);
  assert.match(css, /\.audio-playback-dictation \.audio-playback-remove \{[^}]*grid-column:\s*4[^}]*grid-row:\s*1/u);
  assert.match(css, /\.audio-playback-dictation \.audio-trace \{[^}]*width:\s*148px[^}]*height:\s*18px/u);
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

test("an idle status cannot retire a live turn until its own stream is quiet", async () => {
  assert.equal(helpers.shouldApplySessionState("idle", false), false);
  assert.equal(helpers.shouldApplySessionState("completed", false), false);
  assert.equal(helpers.shouldApplySessionState("unknown", false), false);
  assert.equal(helpers.shouldApplySessionState("idle", true), true);
  assert.equal(helpers.shouldApplySessionState("completed", true), true);
  for (const state of ["working", "needs_approval", "needs_input", "failed", "offline", "disconnected"]) {
    assert.equal(helpers.shouldApplySessionState(state, false), true, `${state} must apply immediately`);
  }

  const app = await source(join("src", "renderer", "src", "App.tsx"));
  const wired = app.match(/shouldApplySessionState\(/gu) ?? [];
  assert.equal(wired.length, 3, "session.updated, session.status_changed, and agent.completed must use the quiet-state gate");
  assert.match(app, /if \(applyState && \(normalizedState === "idle" \|\| normalizedState === "completed" \|\| normalizedState === "failed"\)\) \{\s*const timeline[\s\S]*sessionNeedsTranscriptCatchUp/u);
});

test("slash commands open from a bare slash, filter without prefilling, and insert only on selection", () => {
  assert.deepEqual(helpers.slashCommandSuggestions("/").map((item) => item.command), ["/simplify", "/mesh", "/ears", "/eyes"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/sim").map((item) => item.command), ["/simplify"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/me").map((item) => item.command), ["/mesh"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/ea").map((item) => item.command), ["/ears"]);
  // The two settings commands share a first letter, so /e has to offer both.
  assert.deepEqual(helpers.slashCommandSuggestions("/e").map((item) => item.command), ["/ears", "/eyes"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/ey").map((item) => item.command), ["/eyes"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/missing"), []);
  assert.equal(helpers.slashCommandSuggestions("Explain /sim"), null);
  assert.equal(helpers.insertedSlashCommand(helpers.composerSlashCommands[0]), "/simplify ");
  assert.equal(helpers.insertedSlashCommand(helpers.composerSlashCommands[1]), "/mesh ");
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

test("simplify is a compact clickable composer command rather than visible history metadata", async () => {
  const [composer, css] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  assert.match(composer, /className="simplify-command-row"/u);
  assert.match(composer, /label="Simplify settings"/u);
  assert.match(composer, /\[100, 200, 300\]/u);
  assert.match(composer, /Custom guidance/u);
  assert.match(composer, /preview: simplified\.content/u);
  assert.match(css, /\.simplify-command > button/u);
  assert.match(css, /\.simplify-settings/u);
});

test("composer exposes a keyboard and pointer accessible slash command palette", async () => {
  const [composer, css] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  assert.match(composer, /slashCommandSuggestions\(content\)/u);
  assert.match(composer, /role="listbox" aria-label="Commands"/u);
  assert.match(composer, /event\.key === "Enter" \|\| event\.key === "Tab"/u);
  assert.match(composer, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/u);
  assert.match(composer, /setSlashPaletteDismissed\(true\)/u);
  assert.match(css, /\.slash-command-palette/u);
  assert.match(css, /button\[aria-selected="true"\]/u);
});

test("/eyes opens the existing vision picker as a settings route", async () => {
  const [composer, helpers] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "composer_helpers.ts")),
  ]);
  // Listed beside /ears so the palette offers both when the user types /e.
  assert.match(helpers, /id: "eyes",\s*command: "\/eyes",/u);
  assert.match(helpers, /description: "Choose the model that reads images"/u);
  // Same shape as /ears: consumed as a command, never sent as a message.
  assert.ok(composer.includes('if (draftSession || !/^\\/eyes\\s*$/iu.test(content)) return;'));
  assert.match(composer, /setVisionAction\("settings"\);/u);
  // It reuses the picker rather than duplicating one.
  assert.match(composer, /type VisionPickerMode = VisualAction \| "settings";/u);
  assert.match(composer, /action: VisionPickerMode;/u);
  assert.match(composer, /className="chat-picker vision-eyes-picker"/u);
  // Opened on its own there is nothing queued to resume, so it just confirms.
  assert.match(composer, /if \(action === "settings"\) \{ notify\("Vision model saved for this task"\); return; \}/u);
  assert.match(composer, /action === "settings" \? "Pick the model this task uses to read images."/u);
  assert.match(composer, /action === "settings" \? "Cancel" : "Not now"/u);
});

test("mesh is a multi-target drop-up panel with per-target model and reasoning", async () => {
  const [composer, css] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  assert.match(composer, /className="mesh-panel-anchor"/u);
  assert.match(composer, /role="dialog" aria-label="Mesh delegation"/u);
  assert.match(composer, /className="mesh-model-picker"/u);
  // /mesh and its description were already read in the command palette; the panel
  // must not repeat them, and the list references tools rather than adding one.
  assert.match(composer, /<span className="mesh-add-label">Reference coding tool<\/span>/u);
  assert.doesNotMatch(composer, /Reference other coding tools in this turn/u);
  assert.doesNotMatch(css, /\.mesh-panel-header strong/u);
  // One header row carries the heading and the close control, so nothing stacks
  // empty height above the list.
  assert.match(composer, /<header className="mesh-panel-header">\s*<span className="mesh-add-label">/u);
  assert.match(css, /\.mesh-panel-header \{[^}]*justify-content: space-between;/u);
  assert.doesNotMatch(css, /\.mesh-add \{[^}]*padding-top/u);
  // Typing the command opens the panel without consuming the text, and the panel
  // is bound to it: anything that is no longer /mesh closes it again.
  assert.ok(composer.includes('setMeshOpen(/^\\/mesh\\s*$/iu.test(content));'));
  assert.doesNotMatch(composer, /setMeshOpen\(true\);\s*setContent\(""\);/u);
  // Closing the chooser keeps the referenced tools; only sending clears them.
  assert.match(composer, /const closeMesh = \(\) => \{[^}]*setMeshOpen\(false\);\s*setMeshModelPicker\(null\);\s*\};/u);
  assert.doesNotMatch(composer, /const closeMesh = \(\) => \{[^}]*setMeshTargets\(\[\]\)/u);
  assert.match(composer, /else setMeshOpen\(false\);/u);
  // The command itself never becomes the instruction.
  assert.ok(composer.includes('content.trim().replace(/^\\/mesh\\b\\s*/iu, "").trim()'));
  // Referenced tools are widgets on the message line itself: the /mesh command is
  // consumed on commit, the target takes its place inline, and both backspace and
  // the corner X remove it. No chips above the composer.
  assert.match(composer, /className="composer-inline-mesh" role="list" aria-label="Referenced coding tools"/u);
  assert.match(composer, /<strong>\{modelLabel\}<\/strong>\{effortLabel \? <span className="composer-mesh-widget-effort">· \{effortLabel\}<\/span> : null\}/u);
  assert.match(composer, /className="composer-mesh-widget-remove" aria-label=\{`Remove \$\{name\} from mesh`\}/u);
  assert.doesNotMatch(composer, /function MeshChips\(/u);
  assert.doesNotMatch(composer, /className="mesh-chips"/u);
  assert.doesNotMatch(css, /\.mesh-chips/u);
  assert.match(css, /\.composer-mesh-widget-remove \{[^}]*width: 20px/u);
  assert.match(css, /\.composer-mesh-widget:hover \.composer-mesh-widget-remove[^}]*opacity: 1/u);
  assert.match(css, /\.composer-mesh-widget-text strong \{[^}]*font-size: 12\.5px/u);
  assert.match(css, /\.composer-mesh-widget-effort \{[^}]*font-size: 11\.5px/u);
  // The committed target consumes the /mesh command text; the panel closes with it.
  assert.match(composer, /const commitMeshTarget = \(target: MeshTarget\) => \{[\s\S]*?setMeshModelPicker\(null\);[\s\S]*?setContent\(""\);/u);
  assert.match(composer, /setContent\(""\);\s*historyIndex\.current = null;\s*unsentHistoryDraft\.current = "";\s*requestAnimationFrame\(\(\) => textarea\.current\?\.focus\(\)\);/u);
  // Backspace at the start of the line deletes the newest widget like a word.
  assert.match(composer, /event\.key === "Backspace" && event\.currentTarget\.selectionStart === 0 && event\.currentTarget\.selectionEnd === 0 && meshTargets\.length && !draftSession/u);
  assert.match(composer, /removeMeshTarget\(meshTargets\[meshTargets\.length - 1\]!\.providerId\);/u);
  // The inert sliders glyph on a target row is gone along with the row itself.
  assert.doesNotMatch(composer, /className="mesh-target-edit"/u);
  assert.doesNotMatch(css, /\.mesh-target-edit/u);
  assert.doesNotMatch(css, /\.mesh-targets/u);
  assert.match(composer, /request\("delegation\.start", \{ parentSessionId: session\.id, prompt: trimmed, targets: meshTargets\.map/u);
  assert.match(composer, /existing\.modelId \? \{ modelId: existing\.modelId \} : \{\}/u);
  assert.match(composer, /resolveConcreteModelSelection\(models, currentSelection\)/u);
  assert.match(composer, /\(chosenModel\?\.efforts \?\? \[\]\)\.filter/);
  assert.match(composer, /maximumMeshTargets/u);
  assert.match(composer, /next\.slice\(0, maximumMeshTargets\)/u);
  assert.match(composer, /"Send mesh delegation"/u);
  assert.match(composer, /meshTargets\.length \? false/u);
  assert.match(composer, /"Optional instruction for the mesh…"/u);
  assert.match(css, /\.mesh-panel\s*\{[^}]*border-radius:\s*7px/u);
  assert.match(css, /\.mesh-model-picker\s*\{[^}]*bottom:\s*calc\(100% \+ 6px\)/u);
  assert.match(css, /\.mesh-panel\s*\{[^}]*overflow-y:\s*auto/u);
  assert.doesNotMatch(css, /\.mesh[^{]*\{[^}]*font-size:\s*(?:9|10)(?:\.\d+)?px/u);
});

test("composer preserves the session model by stable id across refresh and creation", () => {
  const models = [
    { id: "openai::gpt-first", name: "GPT First" },
    { id: "custom::gpt-selected", name: "GPT Selected" },
  ];
  assert.equal(helpers.resolveComposerModelId(models, "custom::gpt-selected"), "custom::gpt-selected");
  assert.equal(helpers.resolveComposerModelId(models, "GPT Selected"), "custom::gpt-selected");
  assert.equal(helpers.resolveComposerModelId(models, "CLI default"), "default");
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

test("task controls and delayed transcript delivery settle independently", () => {
  const unfinished = [
    { kind: "user", state: "completed" },
    { kind: "reasoning", state: "running" },
  ];
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "completed" }, unfinished), false, "a completed task cannot be stopped");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, unfinished), true, "its missing final reply must still be fetched");

  const finalAfterReasoning = [...unfinished, { kind: "assistant", phase: "final_answer", state: "completed" }];
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, finalAfterReasoning), false, "the final reply ends catch-up even when stale reasoning still says running");
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

  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "idle" }, [
    ...unfinished,
    { kind: "error", state: "failed" },
  ]), false, "an authoritative error cannot poll forever");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "failed" }, unfinished), false, "a failed task cannot poll forever");
});

test("the close-follow timer uses terminal turn evidence, not a stale working scalar", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));
  assert.match(app, /const session = current\?\.sessions\.find\(\(candidate\) => candidate\.id === selected\);/u);
  assert.match(app, /!session \|\| !sessionNeedsTranscriptCatchUp\(session, current\?\.timelines\[selected\] \?\? \[\]\)/u);
  assert.match(app, /const refreshSelectedView = useCallback\(async \(sessionId: string, force = false\)/u);
  assert.match(app, /forcedPass \|\| quietCatchUpDue/u);
  assert.match(app, /terminalTranscriptCatchUpMaxAttempts/u);
  assert.match(app, /The task finished, but its final reply was not available\./u);
  assert.doesNotMatch(app, /sessions\.find\(\(session\) => session\.id === selected\)\?\.state !== "working"/u);
  assert.match(app, /void refreshVisibleState\(false\)\.catch/u);
  assert.doesNotMatch(app, /setTimeout\(\(\) => void tick\(\), 1_500\)/u);
});

test("composer enforces four total attachments and a 50 MiB aggregate before upload", () => {
  const mib = 1024 * 1024;
  const exact = helpers.appendAttachmentsWithinLimits([], [
    { path: "first", byteLength: 25 * mib },
    { path: "second", byteLength: 25 * mib },
    { path: "over", byteLength: 1 },
  ]);
  assert.deepEqual(exact.items.map((item) => item.path), ["first", "second"]);
  assert.equal(exact.acceptedCount, 2);
  assert.equal(exact.rejectedForBytes, true);

  const count = helpers.appendAttachmentsWithinLimits([
    { path: "one", byteLength: 1 }, { path: "two", byteLength: 1 },
    { path: "three", byteLength: 1 }, { path: "four", byteLength: 1 },
  ], [{ path: "one", byteLength: 1 }, { path: "five", byteLength: 1 }]);
  assert.equal(count.acceptedCount, 0);
  assert.equal(count.rejectedForCount, true);

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
  assert.equal(projectedSegments.find((segment) => segment.kind === "thinking")?.item.state, "running", "the text shares the trailing group's live state");
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

test("the version is told where it is asked for, not stamped on the rail", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));
  const nav = await source(join("src", "renderer", "src", "NavigationPanels.tsx"));
  const styles = await source(join("src", "renderer", "src", "styles.css"));

  // A number floating in the corner of every screen, for the one moment a year
  // anybody needs it.
  assert.doesNotMatch(app, /app-version-stamp/u);
  assert.doesNotMatch(styles, /app-version-stamp/u);

  // It belongs with the thing it describes: the box that already answers what the
  // runtime dot is telling you.
  assert.match(nav, /Tethoq v\$\{appVersion\}/u);
  assert.match(nav, /Tethoq version \$\{appVersion\}/u, "and is announced, not only drawn");
  assert.match(app, /appVersion: bootstrap\.app\.version/u);

  // And in settings, as a line in the runtime block rather than a section of its own.
  assert.match(app, /<dt>Tethoq<\/dt><dd>v\{bootstrap\?\.app\.version/u);
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

  // Stopping a task is its own confirmation; it does not need a card.
  const app = await source(join("src", "renderer", "src", "App.tsx"));
  assert.doesNotMatch(app, /notify\("Task interrupted"\)/u);
});

test("a provider retry is one quiet status row, never fake reasoning or an error", async () => {
  const [chat, app, styles] = await Promise.all([
    source(join("src", "renderer", "src", "ChatTimeline.tsx")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);
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

  const noticeSource = chat.slice(chat.indexOf("const ProviderStatusNotice"), chat.indexOf("const ActiveCompactionStatus"));
  assert.match(noticeSource, /className="timeline-provider-status"/u);
  assert.match(noticeSource, /data-provider-status=\{status\.kind\}/u);
  assert.doesNotMatch(noticeSource, /reasoning-group|reasoning-disclosure|timeline-error-notice|Agent error/u);
  assert.equal((chat.match(/<ProviderStatusNotice status=\{providerStatus\}/gu) ?? []).length, 1);
  assert.match(chat, /showsWorkingPulse\(visibleTimeline, active, providerStatus\?\.kind === "retry"\)/u);
  assert.doesNotMatch(styles.match(/\.timeline-provider-status \{[^}]*\}/u)?.[0] ?? "", /background\s*:/u, "the notice is not a card");

  assert.match(app, /providerStatus=\{session\.providerStatus\}/u);
  assert.match(app, /eventClearsProviderStatus\(event\) \? \{ providerStatus: null \} : \{\}/u, "only real provider output clears the retry notice");
  assert.match(app, /agent\.completed[\s\S]{0,900}providerStatus: null/u, "terminal events clear the retry notice");
});

test("a stale note about a harness cannot be the last word on sending to it", async () => {
  const composer = await source(join("src", "renderer", "src", "Composer.tsx"));

  // Whether a tool can take a message is read from a snapshot the window holds,
  // rebuilt only on a few occasions. Any moment the tool could not answer is
  // written into it and stays written, so a tool that is up and healthy could sit
  // there refusing to be written to until the app was relaunched. The refusal now
  // has to come from the tool itself, asked at that moment.
  assert.match(composer, /if \(!canSend\) \{\s*const fresh = await reverifyProvider\(\)/u);
  assert.match(composer, /const usable = fresh\?\.detected === true/u);
  assert.match(composer, /fresh\.capabilities\.includes\("Send Message"\)/u);
  assert.doesNotMatch(composer, /if \(!canSend\) throw new Error/u, "the snapshot alone must never refuse a send");

  // The send control is never disabled by that note either. Fixing only the refusal
  // inside submit left the button dead, so pressing it did nothing at all and the
  // message vanished with no error and no clue - measured: the button read disabled
  // with text in the box, and nothing reached the harness for fourteen seconds.
  assert.doesNotMatch(composer, /disabled=\{sending \|\|[^}]*!canSend/u, "a stale note must not disable send");

  // And the control comes back on its own: a composer that believes it cannot send
  // checks that belief immediately rather than waiting for a relaunch.
  assert.match(composer, /if \(canSend \|\| preview\) return;/u);
  assert.match(composer, /void reverifyProvider\(\)/u);

  // Healing writes back only the provider in question, so a connector the
  // workspace has deliberately hidden cannot reappear on the strength of a send.
  assert.match(composer, /providers: current\.providers\.map\(\(entry\) => entry\.id === fresh\.id \? fresh : entry\)/u);
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

  // The outer disclosure is the only gate. Once it is open, the complete thought
  // is rendered directly rather than being replaced by another preview/button.
  const chat = await source(join("src", "renderer", "src", "ChatTimeline.tsx"));
  assert.match(chat, /function ThinkingFlow\(\{ segment, onLinkOpen \}/);
  assert.match(chat, /<RichText onLinkOpen=\{onLinkOpen\}>\{body\}<\/RichText>/);
  assert.doesNotMatch(chat, /reasoning-segment-preview|Expand thinking|Collapse thinking/);

  // And a live thought names itself, so the row it opens is the one being written.
  const live = timelineHelpers.liveReasoningIds(timelineHelpers.groupTimeline([shortLive]));
  assert.equal(live.segments.length, 1);
});

test("a turn another app is driving is followed closely instead of landing in one lump", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  // A task started in another OpenCode window runs on that window's own server and
  // never sends us its chunks. The shared store is all both apps can see, and it
  // records a thought when the thought ends, so the calm fifteen-second poll showed
  // a whole turn's thinking at once, after it was over.
  assert.ok(helpers.unownedTurnFollowMs <= 1_000, "an open externally owned turn must be followed within a second");
  assert.ok(helpers.unownedTurnSilenceMs < helpers.unownedTurnFollowMs + 1_000);
  assert.ok(helpers.unownedTurnFollowMs < helpers.quietCatchUpIntervalMs, "following must be closer than the calm heal poll");

  // It follows only the open task while the current turn is genuinely live. A
  // terminal final answer outranks a stale working scalar, so a settled task can
  // never stay on this aggressive timer and remount its transcript every 1.5s.
  assert.match(app, /!session \|\| !sessionNeedsTranscriptCatchUp\(session, current\?\.timelines\[selected\] \?\? \[\]\)\) return;/);
  assert.match(app, /quietCatchUpDue\(selectedLastDelta\(selected\), Date\.now\(\), unownedTurnSilenceMs\)/);
  assert.match(app, /\}, unownedTurnFollowMs\);/);
  const now = Date.now();
  assert.equal(helpers.quietCatchUpDue(now - 200, now, helpers.unownedTurnSilenceMs), false, "live chunks keep the follow away");
  assert.equal(helpers.quietCatchUpDue(now - 5_000, now, helpers.unownedTurnSilenceMs), true);
});

test("a live thought stays open through settlement once the reader has seen it", async () => {
  const chat = await source(join("src", "renderer", "src", "ChatTimeline.tsx"));
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
  assert.match(chat, /const live = liveReasoningIds\(groups\);/);
  assert.match(chat, /setOpenedGroups\(\(current\) => rememberLiveDisclosureIds\(current, live\.groups, closedGroups\)\)/);
  assert.match(chat, /activeDisclosureIds\(openedGroups, live\.groups, closedGroups\)/);
  assert.doesNotMatch(chat, /openedSegments|closedSegments|toggleSegment|setSegments/);
  assert.doesNotMatch(chat, /addMissing\(/);
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
  const chat = await source(join("src", "renderer", "src", "ChatTimeline.tsx"));
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

  // Every settled work span keeps one collapsed outer control. Tool output and
  // narration are artifacts of the turn even when a harness emitted no formal thought.
  assert.doesNotMatch(chat, /if \(thinking\.length === 0 && !running\) \{/);
  assert.match(chat, /return <section className="reasoning-group"[^>]*data-scroll-members=/);
  // Whether a span is open is the reader's decision, so the transcript holds it and
  // tells the group. Keeping it inside the group meant any reshape of a streaming turn
  // could hand the component a new identity and silently close the panel under someone
  // who was reading a thought arrive.
  const reasoningGroupSource = chat.slice(chat.indexOf("function ReasoningGroupImpl"), chat.indexOf("const ReasoningGroup = memo"));
  assert.doesNotMatch(reasoningGroupSource, /useState/);
  assert.match(chat, /const \[openedGroups, setOpenedGroups\] = useState<ReadonlySet<string>>/);
  assert.match(chat, /const \[closedGroups, setClosedGroups\] = useState<ReadonlySet<string>>/);
  assert.match(chat, /!closedGroups\.has\(key\) && \(activeGroups\.has\(key\) \|\| reasoningDisplay === "expanded"\)/);
  assert.match(chat, /className=\{`reasoning-disclosure \$\{running \? "reasoning-running" : ""\}`\} aria-expanded=\{expanded\} onClick=\{onToggleGroup\}/);
  // Collapsed by default in compact mode, and the body is not even built until it
  // is opened — which is what keeps a long history of restored spans cheap.
  // Flow-through mode still opens a span by default, but the default now lives with the
  // decision record rather than in the component that gets rebuilt underneath it.
  assert.match(chat, /!closedGroups\.has\(key\) && \(activeGroups\.has\(key\) \|\| reasoningDisplay === "expanded"\)/);
  assert.match(chat, /\{expanded \? <div className="reasoning-detail">/);

  // Being busy with nothing produced yet is a fact about the session, so it is drawn from
  // that fact instead of being smuggled into the transcript as a reasoning row nobody
  // wrote. The old marker offered a dropdown over nothing, and had to be recognised and
  // deleted again on its way out.
  assert.doesNotMatch(chat, /tethoq-live-reasoning-/);
  assert.match(chat, /showsWorkingPulse\(visibleTimeline, active, providerStatus\?\.kind === "retry"\) \? <WorkingPulse \/>/);
  // Before any words arrive this is truthful status, not a disclosure over an empty
  // panel. The real outer Reasoning control replaces it when content exists.
  assert.match(chat, /<div className="reasoning-disclosure reasoning-running" role="status" aria-label="Reasoning">/);
  assert.doesNotMatch(chat, /function WorkingPulse[\s\S]{0,260}<button/);
  assert.doesNotMatch(chat, /Nothing written yet/u);
  assert.doesNotMatch(chat, /reasoning-detail-empty|pulseOpen|setPulseOpen/);
});

test("an opened disclosure carries on from its row instead of restating it", async () => {
  const chat = await source(join("src", "renderer", "src", "ChatTimeline.tsx"));

  // One activity was announcing itself three times - on the summary row, on the row
  // itself, and again as a heading inside the opened panel - with two collapse controls
  // stacked beside the row's own chevron. Thinking rows already solve this by letting
  // the opened body carry on from the line that opened it; activity rows now match.
  // Opening a tool call took three clicks: the group, a row that only summarised the
  // rows beneath it, then the row itself. The summary layer is gone - a reasoning group
  // holds one row per activity and each opens straight onto its detail.
  assert.doesNotMatch(chat, /ActivitySegmentDisclosure/);
  assert.doesNotMatch(chat, /activitySegmentPreview/);
  assert.match(chat, /<ActivityDisclosure key=\{segment\.id\} item=\{segment\.items\[0\]!\}\/>/);
  // Each concrete activity owns exactly one detail toggle.
  assert.match(chat, /const \[expanded, setExpanded\] = useState\(false\);/);
  assert.match(chat, /const toggle = \(\): void => setExpanded\(\(current\) => !current\);/);
  assert.doesNotMatch(chat, /<header>\s*\n\s*<strong>\{visibleLabel\}<\/strong>/);
  assert.doesNotMatch(chat, /<button type="button" onClick=\{collapse\}>Collapse <ChevronDownIcon \/><\/button>/);

  // The remaining controls are the ones that earn their place: enlarging a body too big
  // for the panel, and closing one long enough to have scrolled its own row away.
  assert.match(chat, /\{long \? <header>[\s\S]{0,220}?\{enlarged \? "Reduce" : "Enlarge"\}<\/button>\s*\n\s*<\/header> : null\}/);
  assert.match(chat, /\{long \? <footer><button type="button" onClick=\{collapse\}><ChevronDownIcon \/>Collapse<\/button><\/footer> : null\}/);
});

test("a live reasoning span names its own tense and carries the thinking sheen", async () => {
  const [chat, composer, styles] = await Promise.all([
    source(join("src", "renderer", "src", "ChatTimeline.tsx")),
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);
  // Animated dots alone read as decoration; the word itself has to say it is ongoing.
  assert.match(chat, /\{running \? "Reasoning…" : "Reasoning"\}/);
  assert.match(composer, /active=\{sessionHoldsFollowUpQueue\(session, visible\)\}/);
  // A repeating tile translated by exactly its own width; a non-repeating gradient cannot
  // loop without the highlight snapping back across the text.
  assert.match(styles, /\.reasoning-running \.reasoning-label \{[^}]*background-repeat: repeat-x[^}]*animation: reasoning-label-shimmer/);
  // Positive travel, so the highlight runs left to right with the dots beside it, and the
  // dots' own 1.25s cadence so the two do not visibly disagree.
  assert.match(styles, /@keyframes reasoning-label-shimmer \{ from \{ background-position-x: 0; \} to \{ background-position-x: 10em; \} \}/);
  assert.match(styles, /\.reasoning-running \.reasoning-label \{[^}]*animation: reasoning-label-shimmer 1\.25s linear infinite/);
  assert.match(styles, /\.reasoning-running \.reasoning-mark i \{ animation: reasoning-flow 1\.25s/);
  // Reduced motion keeps the label legible instead of leaving it painted transparent.
  assert.match(styles, /\.reasoning-running \.reasoning-label \{ color: #c3c7c3; background: none; -webkit-text-fill-color: currentColor; \}/);
});

test("settled activity rows collapse behind the same Reasoning shell", async () => {
  const [chat, composer] = await Promise.all([
    source(join("src", "renderer", "src", "ChatTimeline.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  // A completed tool-only span is still execution trace, so it remains available
  // behind one quiet Reasoning disclosure rather than staying in the user's face.
  assert.doesNotMatch(chat, /reasoning-group-settled/);
  assert.match(chat, /<span className="reasoning-label">\{running \? "Reasoning…" : "Reasoning"\}<\/span>/);
  assert.match(composer, /\.message-assistant:has\(\.message-footer\) \+ \.reasoning-group,[\s\S]{0,120}margin-top:\s*36px/);
  assert.match(composer, /\.final-answer-block:has\(\.message-footer\) \+ \.reasoning-group \{[^}]*margin-top:\s*36px/);

  assert.match(chat, /<ActivityDisclosure key=\{segment\.id\} item=\{segment\.items\[0\]!\}\/>/);
  assert.doesNotMatch(chat, /expandedSegments|toggleSegment|onSetSegments/);
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
  assert.equal(duringCommand.find((segment) => segment.kind === "thinking")?.item.state, "running", "live icon state is projected onto its readable thought");
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
  const nestedGroups = timelineHelpers.groupTimeline([timeline[0], timeline[2], summary, timeline[3]], false);
  assert.deepEqual(nestedGroups.map((group) => group.kind), ["item", "reasoning", "item"]);
  assert.deepEqual(timelineHelpers.reasoningSegments(nestedGroups[1].items).map((segment) => segment.kind), ["thinking", "compaction"]);
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

test("composer and chat sources implement the reviewed compact interaction surface", async () => {
  const [composer, chat, css, app, styles, bridge, navigation] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "ChatTimeline.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
    source(join("src", "renderer", "src", "bridge.ts")),
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
  ]);

  assert.match(composer, /rows=\{1\}/);
  assert.match(composer, /growTextarea/);
  assert.match(composer, /dictation\.source\.list/);
  assert.match(composer, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(composer, /dictation\.transcribe/);
  assert.match(composer, /onTranscript\(transcript\)/);
  assert.match(composer, /preferredDictationKey\(providerId\)/);
  assert.match(composer, /recorder\.onstop = null[\s\S]*recorder\.ondataavailable = null[\s\S]*recorder\.onerror = null[\s\S]*recorder\.stop\(\)/);
  assert.match(composer, /Open session browser/);
  assert.match(app, /browserAction\(\{ type: "navigate", tabId: active\.id, input: url \}\)/);
  assert.match(app, /onLinkOpen=\{onLinkOpen\}/);
  assert.match(composer, /Attach workflow/);
  assert.match(composer, /request\("session\.vision\.get", \{ sessionId: session\.id \}\)/);
  assert.match(composer, /status\.primaryModelSupportsImageInput === false && status\.configured === null/);
  assert.match(composer, /request\("vision\.targets", \{\}\)/);
  assert.match(composer, /request\("session\.vision\.configure", \{ sessionId: session\.id, selection \}\)/);
  assert.doesNotMatch(composer, /session\.vision\.ask/);
  assert.doesNotMatch(composer, /Â|â€¦|â€|Ã|�/);
  assert.match(composer, /Delegate a task/);
  assert.match(composer, /className="chat-picker delegation-chat-picker"/);
  assert.match(composer, /onManageWorkflow\(attachment\.id\)/);
  assert.match(composer, /session\.context_handoff/);
  assert.match(composer, /request\("session\.context_handoff", \{ sessionId: session\.id \}\)/);
  assert.match(composer, /100–1000 word handoff range/);
  assert.match(composer, /onComplete\(sessionValue as Record<string, unknown>, summary, prompt\)/);
  assert.match(composer, /Branch in New Task/);
  assert.match(composer, /request\("session\.branch", \{ sessionId: session\.id \}\)/);
  assert.match(composer, /event\.clipboardData\.files/);
  assert.match(composer, /Pasted image attached/);
  assert.match(composer, /className="attachment-thumbnail"/);
  assert.match(composer, /onClick=\{\(\) => setAttachmentPreview\(attachment\)\}/);
  assert.match(composer, /className="image-lightbox composer-image-lightbox"/);
  assert.match(composer, /aria-label="Close attachment preview"/);
  assert.match(composer, /event\.key === "Escape"[\s\S]*setAttachmentPreview\(null\)/);
  assert.match(composer, /captureScreens\(\)/);
  assert.match(composer, /cropScreenSource/);
  assert.match(composer, /className="model-picker-dropup"/);
  assert.match(composer, /<h4>Recent<\/h4>/);
  assert.match(composer, /data-provider-group/);
  assert.doesNotMatch(composer, /defaultKeys\.has\(entry\.key\) \? <small>Default<\/small>/);
  assert.doesNotMatch(composer, /model\.isDefault \? <small>Default<\/small>/);
  assert.match(composer, /function reasoningLabel\(value: string/);
  assert.doesNotMatch(composer, /return "Auto"/);
  assert.match(composer, /reasoningDisplayLabel\(value, context\)/);
  assert.doesNotMatch(composer, /normalized === "low"\) return "Light"/);
  assert.match(composer, /function compactComposerModelLabel\(value: string, providerId: string\)/);
  assert.match(composer, /providerId !== "codex"\) return value/);
  assert.match(composer, /suffix \? `\$\{match\[1\]\} \$\{suffix\}` : match\[1\]!/);
  assert.match(composer, /Open full model browser/);
  assert.match(composer, /Search models and providers/);
  assert.doesNotMatch(composer, /model-session-default|composer-context|CLI default/);
  assert.match(composer, /appendAttachmentsWithinLimits\(attachments, images.map/);
  assert.match(composer, /maximumMessageAttachmentBytes/);
  assert.match(composer, /Attachments can total up to 50 MiB per message/);
  assert.match(composer, /supportsGenericFileAttachments\(providerId\)/);
  assert.match(composer, /window\.tethoqDesktop\.selectFiles\(providerId\)/);
  assert.match(composer, /className="file-attachment-chip"/);
  assert.match(composer, /OpenCode file attachments were removed for this coding tool/);
  assert.match(composer, /request\("message_queue\.list", \{ sessionId: session\.id \}\)/);
  assert.match(composer, /request\("message_queue\.cancel", \{ messageId \}\)/);
  assert.match(composer, /className="queued-strip" role="list" aria-label="Queued instructions"/);
  assert.match(composer, /onContextMenu=\{\(event\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*setMenuOpen\(true\)/);
  assert.match(css, /\.queued-strip \{[^}]*overflow:\s*visible/);
  assert.doesNotMatch(css, /\.queued-strip \{[^}]*(?:overflow-y:\s*auto|scrollbar-gutter)/);
  assert.match(composer, /message_queue\.edit/);
  assert.match(composer, /message_queue\.deliver/);
  assert.match(composer, /Edit message/);
  assert.match(composer, /Open in side chat/);
  assert.match(composer, /onCreateSideChat\(session\.id, undefined, message\.id\)/);
  assert.doesNotMatch(composer, /onCreateSideChat\(session\.id, message\.content, message\.id\)/);
  assert.match(composer, /Turn off queuing/);
  assert.match(composer, /const queuedSubmission = requestType === "message_queue\.enqueue"/);
  assert.match(composer, /state: queuedSubmission \? item\.state : "working"/);
  assert.match(composer, /void loadQueuedMessages\(\)/, "a secondary queue read must not hold the successful send UI open");
  assert.doesNotMatch(composer, /Instruction (?:queued|sent)/, "the visible message is the only ordinary send confirmation");
  assert.ok(
    composer.indexOf("updateSnapshot((current)") < composer.indexOf("void loadQueuedMessages();"),
    "the transcript row must appear before the opportunistic queue refresh",
  );
  assert.match(composer, /event\.key === "ArrowUp" && atStart/);
  assert.match(composer, /event\.key === "ArrowDown" && atEnd/);
  assert.match(composer, /unsentHistoryDraft\.current = content/);
  assert.match(app, /batch\.replayGap \|\| batch\.events\.some[\s\S]*message\.queued" \|\| event\.type === "message\.queue_updated" \|\| event\.type === "message\.queue_removed/);
  assert.match(app, /label: "Keyboard shortcuts"/);
  assert.match(composer, /entry\.model\.walletKind === "user_api" && entry\.model\.apiKeyConfigured === false/);
  assert.match(composer, /model\.caution \?\? `API key required for/);
  assert.match(css, /\.model-api-caution/);
  assert.match(chat, /className=\{`message-images/);
  assert.match(chat, /item\.kind === "user" \? imageGallery : null[\s\S]*className="message-body"[\s\S]*item\.kind === "assistant" \? imageGallery : null/);
  assert.match(chat, /message-images-before/);
  assert.match(chat, /className="image-lightbox"/);
  assert.doesNotMatch(chat, /Click to expand/);
  assert.match(css, /grid-template-columns: repeat\(auto-fill,minmax\(112px,152px\)\)/);
  assert.match(css, /\.message-images > button \{[^}]*aspect-ratio: 4 \/ 3/);
  assert.equal((chat.match(/referrerPolicy="no-referrer"/g) ?? []).length, 2);
  assert.match(css, /\.context-handoff-summary p[\s\S]*font-style:\s*italic/);
  assert.match(app, /initialDraft=\{composerDrafts/);
  assert.doesNotMatch(app, />CLI default</);
  assert.match(composer, /const draftSession = session\.draft === true/);
  assert.match(composer, /allowProviderChange=\{draftSession\}/);
  assert.match(composer, /onDraftSelectionChange\?\.\(\{ providerId: nextProviderId, modelId: resolvedModelId, effort: nextEffort \}\)/);
  assert.match(composer, /await onCreateDraftSend\(\{/);
  assert.match(composer, /draftSessionId: session\.id/);
  assert.doesNotMatch(composer, /request\("session\.create"/);
  assert.match(composer, /!draftSession \? <>/);
  assert.match(composer, /<DictationControl providerId=\{providerId\}/);
  assert.match(app, /request\("wallet\.get", \{ providerId: "direct", endpointId: nextEndpointId \}\)/);
  assert.match(app, /value\.contextHandoffSummary/);
  assert.match(styles, /\.wallet-endpoint-checking/);
  assert.match(app, /className="context-handoff-summary"/);
  assert.doesNotMatch(composer, /<Modal/);
  assert.match(css, /bottom:\s*calc\(100% \+ 7px\)/);
  assert.match(css, /\.message:hover \.message-footer/);
  assert.match(css, /\.composer-entry-row > textarea[\s\S]*font-size:\s*14px/);
  assert.match(composer, /className="composer-setting-label">Model/);
  assert.match(composer, /className="composer-setting-value model-setting-value"><ProviderLogo/);
  assert.match(composer, /className="composer-setting-value choice-setting-value"/);
  assert.match(composer, /<span className="composer-setting-label">Model<\/span>\s*<button[^>]*className=\{`model-picker-trigger/);
  assert.match(composer, /<div className=\{`composer-choice composer-setting/);
  assert.match(composer, /<span className="composer-setting-label">\{triggerDescription\}<\/span>[\s\S]*className="composer-setting-control"/);
  assert.match(composer, /effort && efforts\.length \? <ChoiceMenu[\s\S]*label: reasoningLabel\(item,/);
  assert.match(css, /\.composer-box[\s\S]*max-height:\s*40vh[\s\S]*display:\s*flex[\s\S]*flex-direction:\s*column/);
  assert.match(css, /\.composer-entry-row[\s\S]*grid-template-columns:\s*40px minmax\(80px,1fr\) auto/);
  assert.match(css, /\.composer-footer[\s\S]*position:\s*absolute[\s\S]*bottom:\s*100%/);
  assert.match(css, /\.composer-footer[\s\S]*display:\s*flex[\s\S]*justify-content:\s*flex-end[\s\S]*gap:\s*4px/);
  assert.match(composer, /function ComposerSurfaceOutline\(\)/);
  assert.match(composer, /className="composer-surface-outline"/);
  assert.match(composer, /`C \$\{curveStart \+ 11\} \$\{shelfHeight\} \$\{shelfLeft - 11\} 0 \$\{shelfLeft\} 0`/);
  assert.doesNotMatch(css, /radial-gradient\(circle at 0 0/);
  assert.match(css, /\.composer-setting > button[\s\S]*border:\s*1px solid transparent[\s\S]*background:\s*transparent/);
  assert.match(css, /\.composer-setting > button[\s\S]*width:\s*auto[\s\S]*display:\s*flex/);
  assert.match(css, /\.composer-setting-label[\s\S]*font-size:\s*13px;[\s\S]*line-height:\s*18px/);
  assert.match(css, /\.composer-setting-label[\s\S]*pointer-events:\s*none[\s\S]*user-select:\s*none/);
  assert.match(css, /\.composer-setting-control > button:hover/);
  assert.match(css, /\.composer-setting-value[\s\S]*display:\s*flex[\s\S]*gap:\s*4px[\s\S]*border-left:\s*1px solid/);
  assert.match(css, /\.composer-setting-value strong[\s\S]*font-size:\s*13\.5px;[\s\S]*line-height:\s*18px[\s\S]*text-align:\s*left/);
  assert.match(css, /\.model-picker-trigger \.provider-logo[^{]*\{[^}]*transform:\s*translateY\(1px\)/);
  assert.match(css, /\.conversation \.message-with-identity \.assistant-identity[^{]*\{[^}]*margin-top:\s*-2px/);
  assert.match(css, /@container \(max-width:\s*640px\)/);
  assert.match(css, /\.model-picker-dropup[\s\S]*width:\s*min\(390px/);
  assert.match(css, /\.model-picker-dropup[\s\S]*right:\s*0/);
  assert.match(css, /\.composer-primary-actions \.send-button[\s\S]*width:\s*27px;\s*height:\s*27px/);
  assert.match(css, /\.composer-actions-menu > button::before[\s\S]*width:\s*30px[\s\S]*height:\s*20px[\s\S]*border-radius:\s*7px/);
  assert.match(css, /\.composer-actions-menu > button[\s\S]*width:\s*36px !important[\s\S]*height:\s*36px !important[\s\S]*background:\s*transparent !important/);
  assert.match(css, /\.dictation-main > svg[\s\S]*width:\s*23px/);
  assert.match(composer, /: "Dictate"/);
  assert.match(composer, /label="Choose dictation source"/);
  assert.match(composer, /EARS settings/);
  assert.match(composer, /function EarsSettingsPanel/);
  assert.match(composer, /ears\.process/);
  assert.match(composer, /ears\.cancel/);
  assert.match(composer, /className="ears-cancel"/);
  assert.match(composer, /Cancel transcription/);
  assert.doesNotMatch(composer, /className=\{`send-button[\s\S]*Cancel transcription/);
  assert.match(composer, /origin: "dictation"/);
  assert.match(composer, /origin: "clipboard"/);
  assert.match(composer, /origin: "drag-drop"/);
  assert.match(composer, /onDrop=\{\(event\) => void onComposerDrop\(event\)\}/);
  assert.match(composer, /filterAttachmentsForDestination\(attachments, false, ears\.enabled\)/);
  assert.match(composer, /isEarsCancelledError/);
  assert.match(composer, /isDictationAudioAttachment/);
  assert.match(css, /\.ears-cancel\s*\{[^}]*text-decoration:\s*underline/);
  assert.doesNotMatch(css, /\.ears-cancel[^{]*\{[^}]*border-radius:\s*50%/);
  assert.match(await source(join("src", "renderer", "src", "composer_helpers.ts")), /command: "\/ears"/);
  assert.match(composer, /label: "MP3"/);
  assert.match(composer, /setSelectedId\(stored \|\| \(directAudioEnabled \? directAudioId : chosen\?\.id \?\? ""\)\)/);
  assert.match(composer, /providerAcceptsDirectAudio\(providerId\) && modelAcceptsDirectAudio\(chosenModel\)/);
  // Recording stays offered when EARS can carry the clip to a text-only harness.
  assert.match(composer, /earsCanCarryAudio = ears\.enabled && earsRoutesFromSnapshot\(snapshot\)\.length > 0/);
  assert.match(composer, /audioRecordingAvailable = audioDictationAvailable \|\| earsCanCarryAudio/);
  assert.match(composer, /audioDictationAvailable=\{audioRecordingAvailable\} directToModel=\{audioDictationAvailable\}/);
  assert.match(css, /\.model-catalog-results time \{[^}]*font-size:\s*12px;[^}]*font-weight:\s*650/);
  assert.match(css, /\.dictation-main[\s\S]*z-index:\s*2[\s\S]*width:\s*38px[\s\S]*height:\s*42px[\s\S]*border-radius:\s*19px/);
  assert.doesNotMatch(css, /\.dictation-main\s*\{[^}]*padding-bottom/);
  assert.match(css, /\.dictation-main > svg\s*\{[^}]*z-index:\s*4[^}]*pointer-events:\s*none/);
  assert.match(css, /\.dictation-source-menu\s*\{[^}]*inset:\s*0[^}]*width:\s*38px[^}]*height:\s*42px[^}]*pointer-events:\s*none/);
  assert.match(css, /\.dictation-source-menu > button\s*\{[^}]*bottom:\s*0[^}]*width:\s*38px[^}]*height:\s*18px[^}]*display:\s*block[^}]*overflow:\s*visible[^}]*pointer-events:\s*auto/);
  // A lip on the microphone's own pill, not a second stacked button: the sweep
  // starts in the lower third of the 42px control rather than at its midpoint.
  assert.match(css, /\.dictation-source-menu > button::before\s*\{[^}]*width:\s*38px[^}]*height:\s*42px[^}]*border-radius:\s*19px[^}]*clip-path:\s*path\("M 0 28 Q 19 34\.5 38 28 L 38 42 L 0 42 Z"\)[^}]*pointer-events:\s*none/);
  // Centred outright; the old 1px nudge left it visibly off-axis in the side chat.
  assert.match(css, /\.dictation-source-menu > button svg\s*\{[^}]*left:\s*50%[^}]*bottom:\s*1px[^}]*transform:\s*translateX\(-50%\)/);
  assert.match(css, /\.dictation-source-menu \.composer-popover\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(composer, /!selected \|\| selected\.status !== "ready"\)[\s\S]*setSetupSourceId\(""\)[\s\S]*setSourceMenuOpen\(true\)/u);
  assert.match(composer, /No dictation source is enabled/u);
  assert.match(composer, /Choose a provider below to set one up\./u);
  assert.match(composer, /required · Set up/u);
  assert.match(composer, /const active = source\.status === "ready" && source\.id === selected\?\.id/u);
  assert.match(css, /\.dictation-source-empty\s*\{[^}]*padding-block:\s*10px 9px/u);
  assert.match(composer, /request\("dictation\.source\.configure", \{ sourceId: setupSource\.id, apiKey: apiKey\.trim\(\) \}\)/u);
  assert.match(composer, /type="password"[\s\S]*placeholder="Paste API key"/u);
  assert.match(composer, /this is separate from a consumer subscription/u);
  assert.match(composer, /export function DictationSettings/u);
  assert.doesNotMatch(composer, /Set \$\{source\.setupEnvironmentVariable\} in Bridge/u);
  assert.match(css, /\.dictation-credential-setup[^{]*\{[^}]*width:\s*310px[^}]*display:\s*grid/);
  assert.match(composer, /export type ComposerAttachment = SelectedImage \| SelectedFile/);
  assert.match(composer, /initialAttachments\?: readonly ComposerAttachment\[\]/);
  assert.match(composer, /onAttachmentsChange\?: \(value: readonly ComposerAttachment\[\]\) => void/);
  assert.match(composer, /useState<readonly ComposerAttachment\[\]>\(\(\) => initialAttachments\)/);
  assert.match(composer, /attachmentsChangeRef\.current\?\.\(attachments\)/);
  assert.match(composer, /label="Add attachment"[\s\S]*className="composer-attachment-menu"/);
  assert.match(composer, /className="composer-entry-row"[\s\S]*<textarea[\s\S]*className="composer-primary-actions"/);
  assert.match(composer, /<textarea id="composer-message"/);
  assert.match(app, /<a className="skip-to-message" href="#composer-message">Skip to message<\/a>/);
  assert.match(styles, /\.skip-to-message[^{]*\{[^}]*font-size:\s*12\.5px/);
  assert.match(styles, /\.skip-to-message:focus-visible[^{]*\{[^}]*transform:\s*translateY\(0\)/);
  assert.match(navigation, /className="new-task-button" onClick=\{onNewTask\} onKeyDown=\{\(event\) => \{ if \(event\.key === "Enter"\)/);
  assert.match(composer, /onKeyDown=\{\(event\) => \{ if \(event\.key === "Enter"\) \{ event\.preventDefault\(\); event\.currentTarget\.click\(\); \} \}\}/);
  assert.match(composer, /draftSession \? "Describe the task…"/);
  assert.match(css, /--conversation-content-width:\s*820px/);
  assert.match(css, /\.conversation[^{]*\{[^}]*var\(--conversation-content-width/);
  assert.match(css, /\.composer-wrap[^{]*\{[^}]*var\(--conversation-content-width/);
  assert.match(css, /\.workspace:has\(\.composer-wrap\)[^{]*\{[^}]*grid-template-rows:\s*auto minmax\(0,1fr\)/);
  assert.match(css, /\.workspace:has\(\.composer-wrap\) > \.conversation-scroll[^{]*\{[^}]*grid-row:\s*2/);
  assert.match(css, /\.workspace:has\(\.composer-wrap\) > \.conversation-scroll > \.conversation[^{]*\{[^}]*padding-bottom:\s*0/);
  assert.match(css, /\.composer-wrap[^{]*\{[^}]*--composer-bottom-cover-height:\s*14px[\s\S]*grid-row:\s*2[\s\S]*background:\s*linear-gradient\([\s\S]*#0f0f0e[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\.composer-wrap > \*[^{]*\{[^}]*pointer-events:\s*auto/);
  assert.match(app, /const LIVE_OUTPUT_GAP_PX = 52/);
  assert.match(app, /viewportBounds\.bottom - composerBounds\.top \+ LIVE_OUTPUT_GAP_PX/);
  assert.match(app, /new ResizeObserver\(measure\)/);
  assert.match(app, /const shouldFollow = historyAnchor\.current === null && scrollMode\.current\.kind === "follow_tail";[\s\S]*spacer\.style\.height = `\$\{next\}px`;[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*measuredComposerClearance\.current === next && scrollMode\.current\.kind === "follow_tail"[\s\S]*scrollToLatest\(\)/);
  assert.match(app, /const scrollToLatest = useCallback\(\(\) => \{[\s\S]*setScrollMode\(followTailScrollMode\);[\s\S]*applyScrollTop\(element, element\.scrollHeight\)/);
  assert.match(app, /const steppedOffEnd = !echoed && movedOffEnd\(element, lastScrollTop\.current\)/);
  assert.match(app, /const returnedToEnd = !echoed && readerReturnedToEnd\(element, lastScrollTop\.current, readerInitiated\)/);
  assert.match(app, /const readerAboveEnd = readerInitiated && !isAtPhysicalBottom\(element\);[\s\S]*if \(readerAboveEnd \|\| steppedOffEnd\) \{[\s\S]*setScrollMode\(\{ kind: "preserve_view", anchor \}\);[\s\S]*else if \(returnedToEnd\) \{[\s\S]*setScrollMode\(followTailScrollMode\)/);
  assert.match(app, /className="conversation-tail-spacer" ref=\{tailSpacer\}/);
  assert.match(css, /\.conversation-tail-spacer[^{]*\{[^}]*height:\s*0/);
  assert.match(app, /if \(scrollMode\.current\.kind === "follow_tail"\) followTail\(\)/);
  assert.match(styles, /\.conversation-scroll[^{]*\{[^}]*overflow-anchor:\s*none[^}]*scroll-behavior:\s*auto/);
  assert.match(css, /\.message-footer[^{]*\{[^}]*position:\s*absolute[^}]*top:\s*100%[^}]*left:\s*0[^}]*right:\s*0[^}]*justify-content:\s*flex-start[^}]*opacity:\s*0[^}]*pointer-events:\s*auto/);
  assert.doesNotMatch(css, /\.message-footer[^{]*\{[^}]*background:/);
  assert.match(css, /\.message-footer time[^{]*\{[^}]*font-size:\s*12\.5px/);
  assert.match(css, /\.copy-message[^{]*\{[^}]*width:\s*26px;\s*height:\s*26px/);
  assert.match(css, /\.copy-message svg[^{]*\{[^}]*width:\s*14px;\s*height:\s*14px/);
  assert.match(css, /\.message-user \.message-body[^{]*\{[^}]*padding:\s*6px 12px/);
  assert.match(css, /\.dictation-source-menu > button:hover,[\s\S]*background:\s*#3a3a37/);
  assert.match(composer, /function DictationCrescentIcon\(\)/);
  assert.match(chat, /item\.kind === "assistant"/);
  assert.match(chat, /className="assistant-identity" data-mode=\{identityMode\} aria-label=\{liveIdentity \? `\$\{assistantName\} thinking` : assistantName\}/);
  assert.doesNotMatch(chat, /assistant-identity[\s\S]{0,160}title=/);
  assert.match(chat, /function shouldShowAssistantIdentity/);
  assert.match(chat, /function finalAnswerCopyText/);
  assert.match(chat, /const footerCopyText = item\.kind === "user" \? item\.body\.trim\(\) : identityMode === "final" \? copyText : undefined/);
  assert.match(chat, /footerCopyText \? <div className="message-footer">/);
  assert.match(chat, /className="timeline-error-notice" role="alert" aria-live="assertive" aria-atomic="true"/);
  assert.match(chat, /className="timeline-error-recovery" onClick=\{onContinue\}>Continue in composer<\/button>/);
  assert.match(app, /getElementById\("composer-message"\)[\s\S]*composer\.focus\(\{ preventScroll: true \}\)[\s\S]*composer\.scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(styles, /\.timeline-error-notice[^{]*\{[^}]*background:\s*#272725/);
  assert.doesNotMatch(styles, /\.timeline-error-notice[^{]*\{[^}]*var\(--danger\)|\.timeline-error-notice svg[^{]*\{[^}]*var\(--danger\)/);
  assert.match(chat, /className="timeline-item-meta"/);
  assert.match(chat, /copyLabel="Copy thinking"/);
  assert.match(chat, /copyLabel=\{`Copy \$\{visibleLabel\.toLowerCase\(\)\} details`\}/);
  assert.doesNotMatch(chat, /title=\{shown\}/);
  assert.doesNotMatch(chat, /className="message-meta"/);
  assert.doesNotMatch(chat, /shouldShowTurnStartIdentity|reasoning-identity/);
  assert.doesNotMatch(styles, /\.reasoning-identity/);
  assert.match(chat, /function ChatTimeline\(/);
  assert.match(chat, /function ActiveCompactionStatus\(\{ kind \}/);
  assert.match(chat, /className="timeline-compaction-event timeline-compaction-active" role="status" aria-live="polite"/);
  assert.match(chat, /Automatically compacting context…/);
  assert.match(chat, /Session compacted/);
  assert.match(chat, /isCompacting \? <ActiveCompactionStatus kind=\{compactionKind\} \/>/);
  assert.match(chat, /function groupTimeline\(/);
  assert.match(chat, /function reasoningSegments\(/);
  assert.match(chat, /reasoningDisplay\?: ReasoningDisplay/);
  assert.match(chat, /`reasoning-disclosure /);
  assert.match(chat, /formatReasoningText\(item\.body\)/);
  assert.match(chat, /function ThinkingFlow\(/);
  assert.match(chat, /<RichText onLinkOpen=\{onLinkOpen\}>\{body\}<\/RichText>/);
  assert.doesNotMatch(chat, /reasoning-category-controls|Expand thinking|Collapse thinking|Expand tool calls|Collapse tool calls|reasoning-segment-preview/);
  assert.doesNotMatch(chat, /Fragment|activeSegments|toggleSegment|setSegments/);
  // The reasoning level lives in the composer's existing reasoning choice, not
  // as a badge next to the group label.
  assert.doesNotMatch(chat, /reasoning-effort-badge/);
  assert.doesNotMatch(styles, /\.reasoning-effort-badge/);
  assert.match(chat, /className="activity-row"/);
  assert.match(chat, /"Spawned sub-agent"/);
  assert.doesNotMatch(chat, /className="activity-live"/);
  assert.match(chat, /className=\{`activity-snippet/);
  assert.match(chat, /return <StandaloneReasoningGroup item=\{item\}/);
  // Tool calls stay inside the one outer chain and each concrete row can reveal
  // only its own detail.
  assert.match(chat, /<ActivityDisclosure key=\{segment\.id\} item=\{segment\.items\[0\]!\}\/>/);
  assert.doesNotMatch(chat, /group\.activities\.map|reasoningDisplay === "expanded" && group\.activities\.length/);
  assert.ok((chat.match(/Collapse/g) ?? []).length >= 1);
  assert.match(chat, /enlarged \? "Reduce" : "Enlarge"/);
  // The raw tool-call id is used only to keep segment identity stable across
  // live/history handovers - never rendered as visible content.
  assert.doesNotMatch(chat, />\{item\.detail\}</);
  assert.doesNotMatch(chat, /activity-card|activity-header|activity-output/);
  assert.match(styles, /\.reasoning-flow[\s\S]*font-style:\s*italic/);
  assert.match(styles, /\.reasoning-flow-running[\s\S]*animation:\s*reasoning-flow-shimmer/);
  assert.match(styles, /prefers-reduced-motion:[\s\S]*\.reasoning-flow-running/);
  assert.match(styles, /\.reasoning-disclosure > svg[\s\S]*opacity:\s*0/);
  assert.match(styles, /\.reasoning-thinking-segment, \.activity-line \{ position:\s*relative/);
  assert.match(styles, /\.reasoning-thinking-segment:hover \.timeline-item-meta,[\s\S]*pointer-events:\s*auto/);
  assert.doesNotMatch(styles, /reasoning-category-controls|reasoning-segment-row/);
  assert.match(styles, /\.timeline-boundary/);
  assert.match(styles, /\.timeline-compaction-active[\s\S]*animation:\s*compaction-text-sheen/);
  assert.match(chat, /className="timeline-compaction-toggle" aria-expanded=\{open\}/);
  assert.match(chat, /<CompactionIcon \/>[\s\S]*?<span>\{label\}<\/span>[\s\S]*?<ChevronDownIcon/);
  assert.match(chat, /open \? <div className="timeline-compaction-detail" role="note">/);
  assert.match(chat, /segments\.length === 1 && segments\[0\]\?\.kind === "compaction"/);
  assert.match(chat, /className="timeline-copy-button timeline-compaction-copy"/);
  assert.match(styles, /\.timeline-compaction-disclosure/);
  assert.match(styles, /\.timeline-compaction-toggle\[aria-expanded="true"\]/);
  assert.match(styles, /\.timeline-compaction-detail/);
  assert.match(styles, /\.reasoning-thinking-segment \.timeline-item-meta[^{]*\{[^}]*position:\s*static[^}]*justify-content:\s*flex-end/);
  assert.match(styles, /\.timeline-compaction-footer[^{]*\{[^}]*justify-content:\s*flex-end/);
  assert.match(css, /\.message-assistant:has\(\.message-footer\) \+ \.timeline-compaction-disclosure[\s\S]*margin-top:\s*36px/, "message copy controls reserve space before compaction disclosures");
  assert.match(css, /--turn-boundary-gap:\s*42px/);
  assert.match(css, /\.message-assistant:has\(\.message-footer\) \+ \.reasoning-group,[\s\S]*margin-top:\s*36px/);
  assert.match(css, /\.message-images-before[^{]*\{[^}]*margin:\s*0 0 8px/);
  assert.match(css, /\.send-button\.stop-button[^{]*\{[^}]*background:\s*#765150/);
  assert.match(css, /\.message-assistant \+ \.message-user,[\s\S]*\.message-user \+ \.reasoning-group,[\s\S]*margin-top:\s*var\(--turn-boundary-gap\)/);
  assert.match(styles, /\.timeline-item-meta[^{]*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
  // A mouse click satisfies :focus-within, and toggling a row leaves the focus sitting
  // on it, so the timestamp and copy control stayed lit on a row the pointer had long
  // since left. :focus-visible is the browser's own judgement of when focus should be
  // shown, so these stay reachable by keyboard without being stranded after a click.
  assert.match(styles, /\.reasoning-thinking-segment:has\(:focus-visible\) \.timeline-item-meta/);
  assert.match(styles, /\.activity-line:has\(:focus-visible\) \.timeline-item-meta/);
  assert.doesNotMatch(styles, /:focus-within \.timeline-item-meta/);
  assert.match(styles, /\.timeline-copy-button:hover,[^\{]*\{[^}]*background:\s*#242422/);
  assert.match(app, /event\.type === "message\.started" \|\| event\.type === "message\.delta" \|\| event\.type === "tool\.started" \|\| event\.type === "command\.started"[\s\S]*state:\s*"working"/);
  assert.match(app, /function refreshVisibleState|const refreshVisibleState/);
  assert.match(app, /const \[sessions\] = await Promise\.all\(\[/);
  assert.match(bridge, /export async function listSessions\(\)[\s\S]*request\("sessions\.list"\)/);
  assert.match(bridge, /request\("session\.watch"/);
  assert.match(app, /addEventListener\("focus", onFocus\)/);
  assert.match(app, /addEventListener\("visibilitychange", onVisibility\)/);
  assert.match(app, /loadSessionTimelinePage\(sessionId, undefined, 40, true\)/);
  assert.match(app, /refreshVisibleState\(false\)/);
  assert.match(app, /quietCatchUpDue\(selectedLastDelta\(selected\), Date\.now\(\), 2_000\)/);
  assert.match(app, /request\("sync\.since"/);
  assert.match(app, /loadSessionContext\(session\.id\)[\s\S]*updateContextCompaction\(context\.isCompacting, context\.compactionKind\)/);
  assert.match(app, /onCompactionChange=\{updateContextCompaction\}/);
  assert.match(app, /isCompacting=\{contextCompaction\.isCompacting\}[\s\S]*compactionKind=\{contextCompaction\.kind\}/);
  assert.match(app, /active=\{sessionHoldsFollowUpQueue\(session, timeline\)\}/);
  assert.match(app, /onInterrupt:\s*interruptSession/);
  assert.match(composer, /const stopTaskAvailable = canInterrupt && !dictationRecording && !content\.trim\(\) && annotations\.length === 0 && !attachments\.some\(isDictationAudioAttachment\)/);
  assert.match(composer, /stopTaskAvailable \? "Stop task"/);
  assert.match(composer, /stopTaskAvailable \? <StopIcon \/>/);
  assert.match(composer, /const \[interrupting, setInterrupting\] = useState\(false\)/);
  assert.match(composer, /const interruptingRef = useRef\(false\)/);
  assert.match(composer, /if \(onInterrupt === undefined \|\| interruptingRef\.current\) return/);
  assert.match(composer, /interruptingRef\.current = true;[\s\S]*await onInterrupt\(\);[\s\S]*interruptingRef\.current = false;/);
  assert.match(composer, /disabled=\{sending \|\| interrupting \|\|/);
  assert.match(chat, /function withCurrentActivity\(/);
  assert.match(chat, /candidateIndex === currentIndex[\s\S]*candidate\.state === "running" \? \{ \.\.\.candidate, state: "completed" \}/);
  assert.match(styles, /\.rich-table-scroll table[\s\S]*border-collapse:\s*collapse/);
  assert.match(styles, /\.conversation-scroll[\s\S]*#0f0f0e/);
  assert.match(styles, /\.activity-snippet pre[\s\S]*max-height:\s*330px/);
  assert.match(styles, /\.activity-snippet-enlarged pre[\s\S]*68vh/);
  assert.match(chat, /className=\{item\.kind === "assistant" \? "assistant-message-row"/);
  assert.doesNotMatch(chat, /streaming-label|Responding/);
  assert.doesNotMatch(chat, /user-avatar|>You</);
  assert.doesNotMatch(app, /className="context-strip"/);
  assert.doesNotMatch(app, /function DelegationModal|function Composer|function WorkflowPicker/);
});

test("desktop queue, side-chat, and cross-task surfaces use the narrow bridge contracts", async () => {
  const [app, composer, navigation, chat, bridge, css, navigationCss] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "ChatTimeline.tsx")),
    source(join("src", "renderer", "src", "bridge.ts")),
    source(join("src", "renderer", "src", "composer.css")),
    source(join("src", "renderer", "src", "navigation.css")),
  ]);

  assert.match(app, /request\("side_chat\.list", \{\}\)/);
  assert.match(app, /request\("side_chat\.create", \{ parentSessionId/);
  assert.match(app, /request\("side_chat\.promote", \{ sessionId \}\)/);
  assert.match(app, /event\.type === "side_chat\.created" \|\| event\.type === "side_chat\.updated" \|\| event\.type === "side_chat\.promoted"/);
  assert.match(app, /sideChatEventSession\(event\.payload\.session, next\.sessions, event\.occurredAt\)/);
  assert.match(app, /next\.sessions = \[session, \.\.\.next\.sessions\.filter\(\(candidate\) => candidate\.id !== session\.id\)\]/);
  assert.match(app, /sideChatDrafts[\s\S]*Record<string, SideChatDraft>/);
  assert.match(app, /queueingBySession[\s\S]*Record<string, boolean>/);
  assert.match(app, /queueingEnabled=\{queueingBySession\[selectedSession\?\.id \?\? ""\] \?\? true\}/);
  assert.match(app, /onQueueingEnabledChange=\{\(enabled\) =>/);
  assert.match(app, /draft=\{drafts\[session\.id\] \?\? emptySideChatDraft\}/);
  assert.match(app, /onDraftChange=\{\(update\) => onDraftChange\(session\.id, update\)\}/);
  assert.match(app, /sessions: \[promoted, \.\.\.current\.sessions\.filter\(\(session\) => session\.id !== promoted\.id\)\]/);
  assert.doesNotMatch(app, /session\.id !== sessionId && session\.id !== promoted\.id/);
  assert.match(app, /Side chat copied to a full task/);
  assert.match(app, /event\.type === "message\.remote_received"/);
  assert.match(composer, /request\("message_queue\.edit", \{ messageId, content: nextContent \}\)/);
  assert.match(composer, /request\("message_queue\.deliver", \{ messageId, mode: canSteer \? "steer" : "send" \}\)/);
  assert.match(composer, /Send to new task/);
  assert.match(composer, /request\("message_queue\.move_to_new_task"/);
  assert.match(composer, /className="queue-new-task-picker"/);
  assert.match(composer, /Search models for new task/);
  assert.match(composer, /mostRecentReasoningForModel\(snapshot\.sessions/);
  assert.match(composer, /model\.walletKind !== "user_api" \|\| model\.apiKeyConfigured !== false/);
  assert.match(composer, /request\("session\.send_message", \{ sessionId: session\.id, content: trimmed/);
  assert.match(composer, /<DictationControl providerId=\{session\.providerId\}/);
  assert.match(composer, /export interface SideChatDraft/);
  assert.match(composer, /Discard draft/);
  assert.match(composer, /current\.content === sentContent \? "" : current\.content/);
  assert.match(composer, /queuedAttachmentPreviewCache/);
  assert.match(composer, /className="queued-attachment-widgets"/);
  assert.match(composer, /message\.attachments\.map\(\(attachment, index\) => <QueuedAttachmentWidget/);
  assert.match(composer, /<AudioPlaybackChip className="queued-attachment-audio"/);
  assert.match(composer, /rememberQueuedAttachmentPreviews\(queued, outgoingAttachments, session\.id\)/);
  assert.match(composer, /queueingEnabled, onQueueingEnabledChange/);
  assert.doesNotMatch(composer, /\[queueingEnabled, setQueueingEnabled\] = useState/);
  assert.match(navigation, />Show side chats</);
  assert.match(navigation, /allSideChats\.slice\(0, 2\)/);
  assert.match(navigation, /className="side-chat-controls"/);
  assert.match(navigation, /onSideChatAnchor/);
  assert.match(chat, /From another Tethoq task · \{item\.origin\.sourceTitle \|\| "Untitled task"\}/);
  assert.match(bridge, /origin\.kind !== "cross_session"/);
  assert.match(bridge, /sourceSessionId: origin\.sourceSessionId/);
  assert.match(css, /\.side-chat-connectors path \{[^}]*stroke-dasharray/);
  assert.match(css, /\.queued-attachment-image img \{[^}]*object-fit: cover/);
  assert.match(css, /\.queued-attachment-widgets \{[^}]*flex-wrap: wrap/);
  assert.match(navigationCss, /\.session-side-chats \{ width: 80%; margin-left: 20%/);
  assert.match(navigationCss, /\.side-chat-controls \{[^}]*opacity: 0;[^}]*pointer-events: none/);
  assert.match(navigation, /session\.state === "working" \? <i className="session-row-working-spinner"/);
  assert.doesNotMatch(navigation, /session-row-state-/);
  assert.match(navigationCss, /\.session-row-working-spinner \{[^}]*border-right-color:\s*transparent;[^}]*animation:\s*spin/);
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

test("side chat owns its position, drags and resizes in the viewport, and routes an orthogonal masked tether", async () => {
  const [composer, css] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  // The panel holds its own bounds and only borrows App's wrapper for the
  // first placement, so task-list scrolling can never move it again.
  assert.match(composer, /const \[bounds, setBounds\] = useState<SideChatBounds \| null>\(null\)/);
  assert.match(composer, /useLayoutEffect\(\(\) => \{[\s\S]*setBounds\(clampSideChatBounds\(/);
  assert.match(composer, /const sideChatMinimumWidth = 260/);
  assert.match(composer, /const sideChatMinimumHeight = 180/);
  assert.match(composer, /function clampSideChatBounds\(bounds: SideChatBounds\)/);
  assert.match(composer, /Math\.min\(window\.innerWidth, Math\.max\(bounds\.width, sideChatMinimumWidth\)\)/);
  // Pointer-captured dragging and resizing, with the viewport as a hard edge.
  assert.match(composer, /event\.currentTarget\.setPointerCapture\(event\.pointerId\)/);
  assert.match(composer, /event\.currentTarget\.hasPointerCapture\(pointerId\)/);
  assert.match(composer, /event\.currentTarget\.releasePointerCapture\(pointerId\)/);
  assert.match(composer, /\(event\.target as Element\)\.closest\("button"\)/);
  assert.match(composer, /className="side-chat-resize"/);
  assert.match(composer, /aria-label="Resize side chat"/);
  assert.match(composer, /Math\.max\(sideChatMinimumWidth, Math\.min\(window\.innerWidth - state\.startLeft, state\.startWidth \+ event\.clientX - state\.startX\)\)/);
  assert.match(composer, /Math\.max\(sideChatMinimumHeight, Math\.min\(window\.innerHeight - state\.startTop, state\.startHeight \+ event\.clientY - state\.startY\)\)/);
  // The tether tracks the parent row in the task list, clamps to the list
  // boundary when the row scrolls away, and uses only orthogonal segments.
  assert.match(composer, /document\.querySelector<HTMLElement>\("\.session-list-scroll"\)/);
  assert.match(composer, /`\[data-session-id="\$\{CSS\.escape\(parentSessionId\)\}"\]`/);
  assert.match(composer, /Math\.max\(listBounds\.top \+ 4, Math\.min\(listBounds\.bottom - 4,/);
  assert.match(composer, /const path = `M \$\{anchorX\} \$\{anchorY\} H \$\{midX\} V \$\{attachY\} H \$\{attachX\}`/);
  assert.doesNotMatch(composer, /`M \$\{item\.anchor\.x\} \$\{item\.anchor\.y\} C /);
  assert.match(composer, /document\.addEventListener\("scroll", schedule, true\)/);
  assert.match(composer, /window\.addEventListener\("resize", schedule\)/);
  // The tether vanishes over the conversation column via a blurred mask hole,
  // so it can never paint across message text.
  assert.match(composer, /document\.querySelector<HTMLElement>\("\.conversation-scroll"\)/);
  assert.match(composer, /<feGaussianBlur stdDeviation="9"\/>/);
  assert.match(composer, /<mask id=\{tetherMaskId\} maskUnits="userSpaceOnUse">/);
  assert.match(composer, /fill="black" filter=\{`url\(#\$\{tetherMaskId\}-blur\)`\}/);
  assert.match(composer, /<path d=\{tether\.path\} mask=\{`url\(#\$\{tetherMaskId\}\)`\}\/>/);
  assert.match(composer, /className="side-chat-connectors" width=\{tether\.viewportWidth\}/);
  // The context injection is never rendered as messages; the empty state is a
  // single centred note, and the promote button sits in the header.
  assert.match(composer, /export function visibleSideChatTimeline/);
  assert.match(composer, /!item\.id\.includes\(":copied:"\)/);
  assert.match(composer, /item\.messageId\?\.startsWith\("copied:"\) !== true/);
  assert.match(composer, /visible\.length \? <ChatTimeline timeline=\{visible\}/);
  assert.match(composer, /className="side-chat-context-note">This side chat already carries the parent task's context\.<\/p>/);
  assert.match(composer, /className="side-chat-promote" aria-label="Send findings to the parent task" data-tooltip="Send findings to the parent task"/);
  assert.match(composer, /onClick=\{\(\) => void promote\(\)\}/);
  assert.match(composer, /className="side-chat-promote"[^>]*>[\s\S]*?aria-label="Close side chat"/);

  assert.match(css, /\.side-chat-layer > \.side-chat-connectors[^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.side-chat-connectors path \{[^}]*stroke-dasharray/);
  assert.match(css, /\.side-chat-floating[^{]*\{[^}]*pointer-events:\s*none/);
  assert.match(css, /\.side-chat-panel[^{]*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.side-chat-panel > header[^{]*\{[^}]*cursor:\s*grab[^}]*touch-action:\s*none/);
  assert.match(css, /\.side-chat-panel\.dragging > header[^{]*\{[^}]*cursor:\s*grabbing/);
  assert.match(css, /\.side-chat-transcript:has\(> \.side-chat-context-note\)[^{]*\{[^}]*place-content:\s*center/);
  assert.match(css, /\.side-chat-resize[^{]*\{[^}]*cursor:\s*nwse-resize/);
  assert.match(css, /\.side-chat-panel \[data-tooltip\]::after[^{]*\{[^}]*font-size:\s*11px/);
  // The app's font floor: nothing new in the panel drops below 11px.
  assert.doesNotMatch(css, /\.side-chat-context-note[^{]*\{[^}]*font-size:\s*(?:9|10)(?:\.\d+)?px/);
  assert.doesNotMatch(css, /\.side-chat-resize[^{]*\{[^}]*font-size:\s*(?:9|10)(?:\.\d+)?px/);
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

test("a spoken clip stays marked as voice all the way into the transcript", async () => {
  const composer = await source(join("src", "renderer", "src", "Composer.tsx"));
  const timeline = await source(join("src", "renderer", "src", "ChatTimeline.tsx"));
  const audio = await source(join("src", "renderer", "src", "audio_dictation.tsx"));
  const css = await source(join("src", "renderer", "src", "composer.css"));

  // The optimistic message keeps the distinction between a clip the user spoke
  // and an audio file they attached, so the transcript can show it.
  assert.match(composer, /durationSeconds: attachment\.durationSeconds, dictation: isDictationAudioAttachment\(attachment\)/);
  assert.match(timeline, /<AudioPlaybackChip[^>]*dictation=\{audio\.dictation === true\}/);
  // Voice carries a mark and its own border; a plain attachment does not.
  assert.match(audio, /dictation \? "audio-playback-dictation" : ""/);
  assert.match(css, /\.audio-playback-dictation \{[^}]*box-shadow/);
  // The clip's length is always readable, including while it plays.
  assert.match(audio, /formatSeconds\(progress \* duration\)\} \/ \$\{formatSeconds\(duration, "nearest"\)/);
  // The measured length is used when a clip cannot be decoded for playback.
  assert.match(audio, /const duration = durationSeconds !== undefined && durationSeconds > 0 \? durationSeconds : decodedDuration;/);
  assert.match(timeline, /durationSeconds=\{audio\.durationSeconds\}/);
  assert.doesNotMatch(audio, /const label = playing \? "Playing"/);
});

test("the microphone is offered only where the model can genuinely hear audio", async () => {
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }), false);
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "gpt-5.6-sol", inputModalities: ["text", "image"] }), false);
  assert.equal(helpers.modelAcceptsDirectAudio({ id: "gemini-3.6-flash", inputModalities: ["text", "image", "audio"] }), true);
  assert.equal(helpers.modelAcceptsDirectAudio(undefined), false);

  const composerHelpers = await source(join("src", "renderer", "src", "composer_helpers.ts"));
  assert.doesNotMatch(composerHelpers, /gpt-5\.6-sol/iu);
});
