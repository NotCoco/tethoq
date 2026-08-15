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

test("dictation helpers prefer ready persisted source and insert editable text", () => {
  const sources = [
    { id: "openai-stt", label: "OpenAI", status: "needs_credential", setupEnvironmentVariable: "OPENAI", capabilities: { batch: true, maxAudioBytes: 10 } },
    { id: "xai-stt", label: "xAI", status: "ready", setupEnvironmentVariable: "XAI", capabilities: { batch: true, maxAudioBytes: 10 } },
  ];
  assert.equal(helpers.chooseTranscriptionSource(sources, "openai-stt").id, "xai-stt");
  assert.equal(helpers.appendTranscript("Existing", " spoken words "), "Existing spoken words");
  assert.equal(helpers.appendTranscript("", " spoken words "), "spoken words");
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
  assert.equal(composerUi.reasoningLabel("low"), "Light");
  assert.equal(composerUi.reasoningLabel("Low"), "Light");
  assert.equal(composerUi.reasoningLabel("default"), "Auto");
  assert.equal(composerUi.reasoningLabel("High"), "High");
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
  assert.deepEqual(messages, [{ id: "keep", content: "Run this next", state: "queued", attachmentCount: 1 }]);
  assert.equal(composerUi.queuedMessagePreview("Same first line\nDifferent detail"), "Same first line · Different detail");
  assert.equal(composerUi.queuedMessagePreview("\n\n"), "Queued instruction");
});

test("assistant identity appears only at the opening and final answer of a turn", () => {
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
  assert.deepEqual(timeline.map((_, index) => timelineHelpers.shouldShowAssistantIdentity(timeline, index)), [false, true, false, false, false, true, false, true]);
  const compacted = { ...item("compacted", "assistant"), body: "Context automatically compacted" };
  assert.deepEqual(
    [item("user", "user"), compacted, timeline[1], timeline[5]].map((candidate, index, items) => timelineHelpers.shouldShowAssistantIdentity(items, index)),
    [false, false, true, true],
  );
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
  assert.equal(errorGroups[0].kind, "reasoning");
  assert.deepEqual(errorGroups[0].activities.map((activity) => activity.id), ["provider-error"]);
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

test("timeline omits empty provider deltas instead of rendering control-only shells", () => {
  const item = (id, kind, body = "") => ({ id, kind, body, timestamp: "2026-08-14T12:00:00.000Z", state: "completed" });
  const empty = item("empty", "assistant");
  const heartbeat = item("heartbeat", "user", "<heartbeat>\n  <automation_id>check</automation_id>\n</heartbeat>");
  const imageOnly = { ...item("image", "assistant"), images: [{ name: "preview.png", dataUrl: "data:image/png;base64,AA==" }] };
  const answer = item("answer", "assistant", "Visible answer");

  assert.equal(timelineHelpers.hasVisibleTimelineContent(empty), false);
  assert.equal(timelineHelpers.hasVisibleTimelineContent(heartbeat), false);
  assert.equal(timelineHelpers.hasVisibleTimelineContent(imageOnly), true);
  assert.deepEqual(timelineHelpers.groupTimeline([empty, heartbeat, imageOnly, answer]).map((group) => group.item?.id), ["image", "answer"]);
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
  assert.equal(timelineHelpers.timelineBoundaryLabel(compaction), "Context compacted");
  assert.equal(timelineHelpers.timelineBoundaryLabel(system), "Provider reconnected.");
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("question", "user", "Context automatically compacted")), null);
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("explanation", "assistant", "If context automatically compacted, this explanation remains a normal answer.")), null);
  assert.equal(timelineHelpers.groupTimeline([compaction])[0].kind, "boundary");
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer([timeline[0], compaction, timeline[3]], 2), false);
  const running = { ...timeline[3], id: "running", phase: undefined, state: "running" };
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer([timeline[0], timeline[2], running], 2), false);
});

test("composer and chat sources implement the reviewed compact interaction surface", async () => {
  const [composer, chat, css, app, styles] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "ChatTimeline.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
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
  assert.match(composer, /Recent models/);
  assert.match(composer, /data-provider-group/);
  assert.match(composer, /defaultKeys\.has\(entry\.key\) \? <small>Default<\/small>/);
  assert.match(composer, /function reasoningLabel\(value: string\)/);
  assert.match(composer, /normalized === "default"\) return "Auto"/);
  assert.match(composer, /normalized === "low"\) return "Light"/);
  assert.match(composer, /function compactComposerModelLabel\(value: string, providerId: string\)/);
  assert.match(composer, /providerId !== "codex"\) return value/);
  assert.match(composer, /suffix \? `\$\{match\[1\]\} \$\{suffix\}` : match\[1\]!/);
  assert.match(composer, /Open full model browser/);
  assert.match(composer, /Search models and providers/);
  assert.doesNotMatch(composer, /model-session-default|composer-context|CLI default/);
  assert.match(composer, /appendAttachmentsWithinLimits\(attachments, images\)/);
  assert.match(composer, /maximumMessageAttachmentBytes/);
  assert.match(composer, /Attachments can total up to 50 MiB per message/);
  assert.match(composer, /supportsGenericFileAttachments\(providerId\)/);
  assert.match(composer, /window\.tethoqDesktop\.selectFiles\(providerId\)/);
  assert.match(composer, /className="file-attachment-chip"/);
  assert.match(composer, /OpenCode file attachments were removed for this coding tool/);
  assert.match(composer, /request\("message_queue\.list", \{ sessionId: session\.id \}\)/);
  assert.match(composer, /request\("message_queue\.cancel", \{ messageId \}\)/);
  assert.match(composer, /<strong>Queued next<\/strong>/);
  assert.match(composer, /if \(requestType !== "message_queue\.enqueue"\)/);
  assert.match(composer, /requestType === "message_queue\.enqueue" \? "Instruction queued"/);
  assert.match(composer, /event\.key === "ArrowUp" && atStart/);
  assert.match(composer, /event\.key === "ArrowDown" && atEnd/);
  assert.match(composer, /unsentHistoryDraft\.current = content/);
  assert.match(app, /batch\.replayGap \|\| batch\.events\.some[\s\S]*message\.queued" \|\| event\.type === "message\.queue_updated" \|\| event\.type === "message\.queue_removed/);
  assert.match(app, /label: "Keyboard shortcuts"/);
  assert.match(composer, /entry\.model\.walletKind === "user_api" && entry\.model\.apiKeyConfigured === false/);
  assert.match(composer, /model\.caution \?\? `API key required for/);
  assert.match(css, /\.model-api-caution/);
  assert.match(chat, /className="message-images"/);
  assert.match(chat, /className="image-lightbox"/);
  assert.match(css, /grid-template-columns: repeat\(auto-fill,minmax\(112px,152px\)\)/);
  assert.match(css, /\.message-images > button \{[^}]*aspect-ratio: 4 \/ 3/);
  assert.equal((chat.match(/referrerPolicy="no-referrer"/g) ?? []).length, 2);
  assert.match(css, /\.context-handoff-summary p[\s\S]*font-style:\s*italic/);
  assert.match(app, /initialDraft=\{composerDrafts/);
  assert.doesNotMatch(app, />CLI default</);
  assert.match(composer, /const draftSession = session\.draft === true/);
  assert.match(composer, /allowProviderChange=\{draftSession\}/);
  assert.match(composer, /onDraftSelectionChange\?\.\(\{ providerId: nextProviderId, modelId: nextModelId, effort: nextEffort \}\)/);
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
  assert.match(css, /\.message:hover \.message-meta/);
  assert.match(css, /\.composer-box > textarea[\s\S]*font-size:\s*14px/);
  assert.match(composer, /className="composer-setting-label">Model/);
  assert.match(composer, /className="composer-setting-value model-setting-value"><ProviderLogo/);
  assert.match(composer, /className="composer-setting-value choice-setting-value"/);
  assert.match(composer, /options=\{efforts\.map\(\(item\) => \(\{ value: item, label: reasoningLabel\(item\) \}\)\)\}/);
  assert.match(css, /\.composer-box[\s\S]*grid-template-columns:\s*minmax\(220px,1fr\) minmax\(360px,410px\)/);
  assert.match(css, /\.composer-box > textarea[\s\S]*grid-row:\s*1 \/ 3/);
  assert.match(css, /\.composer-footer[\s\S]*grid-column:\s*2/);
  assert.match(css, /\.composer-footer[\s\S]*display:\s*flex[\s\S]*justify-content:\s*flex-end[\s\S]*gap:\s*10px/);
  assert.match(css, /\.composer-setting > button[\s\S]*border:\s*1px solid transparent[\s\S]*background:\s*transparent/);
  assert.match(css, /\.composer-setting > button[\s\S]*width:\s*auto[\s\S]*display:\s*flex/);
  assert.match(css, /\.composer-setting-label[\s\S]*font-size:\s*13px/);
  assert.match(css, /\.composer-setting-value[\s\S]*display:\s*flex[\s\S]*gap:\s*5px[\s\S]*border-left:\s*1px solid/);
  assert.match(css, /\.composer-setting-value strong[\s\S]*font-size:\s*13\.5px[\s\S]*text-align:\s*left/);
  assert.match(css, /@container \(max-width:\s*640px\)/);
  assert.match(css, /\.model-picker-dropup[\s\S]*width:\s*min\(390px/);
  assert.match(css, /\.model-picker-dropup[\s\S]*right:\s*0/);
  assert.match(css, /\.composer-primary-actions \.send-button[\s\S]*width:\s*27px;\s*height:\s*27px/);
  assert.match(css, /\.dictation-main > svg[\s\S]*width:\s*22px/);
  assert.match(chat, /item\.kind === "assistant"/);
  assert.match(chat, /title=\{assistantName\}/);
  assert.match(chat, /function shouldShowAssistantIdentity/);
  assert.match(chat, /function ChatTimeline\(/);
  assert.match(chat, /function groupTimeline\(/);
  assert.match(chat, /`reasoning-disclosure /);
  assert.match(chat, /className="activity-row"/);
  assert.match(chat, /className=\{`activity-snippet/);
  assert.match(chat, /return <ReasoningGroup reasoning=\{reasoning\} activities=\{\[item\]\}/);
  assert.doesNotMatch(chat, /return <ActivityDisclosure item=\{item\}\/>/);
  assert.ok((chat.match(/Collapse/g) ?? []).length >= 2);
  assert.match(chat, /enlarged \? "Reduce" : "Enlarge"/);
  assert.doesNotMatch(chat, /item\.detail/);
  assert.doesNotMatch(chat, /activity-card|activity-header|activity-output/);
  assert.match(styles, /\.reasoning-flow[\s\S]*font-style:\s*italic/);
  assert.match(styles, /\.reasoning-flow-running[\s\S]*animation:\s*reasoning-text-shimmer/);
  assert.match(styles, /prefers-reduced-motion:[\s\S]*\.reasoning-flow-running/);
  assert.match(styles, /\.timeline-boundary/);
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
