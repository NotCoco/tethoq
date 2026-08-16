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

test("slash commands open from a bare slash, filter without prefilling, and insert only on selection", () => {
  assert.deepEqual(helpers.slashCommandSuggestions("/").map((item) => item.command), ["/simplify"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/sim").map((item) => item.command), ["/simplify"]);
  assert.deepEqual(helpers.slashCommandSuggestions("/missing"), []);
  assert.equal(helpers.slashCommandSuggestions("Explain /sim"), null);
  assert.equal(helpers.insertedSlashCommand(helpers.composerSlashCommands[0]), "/simplify ");
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
  assert.equal(composerUi.reasoningLabel("default"), "");
  assert.equal(composerUi.reasoningLabel("High"), "High");
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
    attachments: [{ name: "screen.png", mimeType: "image/png", byteLength: 3, dataBase64: "AQID" }],
  }] }, "session-a");
  assert.equal(imageQueue[0].attachments[0].dataUrl, "data:image/png;base64,AQID");
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

test("an active task animates its latest reasoning and otherwise shows one truthful live placeholder", () => {
  const item = (id, kind, phase) => ({ id, kind, phase, body: id, timestamp: "2026-08-15T12:00:00.000Z", state: "completed" });
  const timeline = [
    item("user", "user"),
    item("thinking", "reasoning"),
    item("progress", "assistant", "commentary"),
  ];
  const active = timelineHelpers.withCurrentActivity(timeline, true);
  assert.equal(active[1].state, "running");
  assert.equal(active[2].state, "completed");
  const commentaryOnly = timelineHelpers.withCurrentActivity([timeline[0], timeline[2]], true);
  assert.equal(commentaryOnly[1].state, "completed");
  assert.deepEqual(commentaryOnly.at(-1), {
    id: "tethoq-live-reasoning-progress",
    kind: "reasoning",
    title: "Working",
    body: "Working…",
    state: "running",
    timestamp: "2026-08-15T12:00:00.000Z",
  });
  assert.deepEqual(timelineHelpers.withCurrentActivity(timeline, false), timeline);
  const staleRunning = timeline.map((entry, index) => index === 0 ? entry : { ...entry, state: "running" });
  const normalized = timelineHelpers.withCurrentActivity(staleRunning, true);
  assert.deepEqual(normalized.map((entry) => entry.state), ["completed", "completed", "running"]);
  assert.deepEqual(timelineHelpers.withCurrentActivity(staleRunning, false).map((entry) => entry.state), ["completed", "completed", "completed"]);
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
  const completedFinal = [timeline[0], { ...item("finished", "assistant", "final_answer"), state: "completed" }];
  assert.equal(timelineHelpers.withCurrentActivity(completedFinal, true).at(-1).body, "Working…");
  assert.deepEqual(timelineHelpers.withCurrentActivity(completedFinal, false), completedFinal);
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
  assert.deepEqual(timelineHelpers.reasoningSegments(grouped[0].items).map((segment) => segment.kind), ["thinking", "activity"]);
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
  assert.deepEqual(groups.map((group) => group.kind), ["item", "reasoning", "item", "reasoning"]);
  assert.deepEqual(groups[1].items.map((entry) => entry.id), ["thought-a", "read", "run", "thought-b", "write"]);
  const segments = timelineHelpers.reasoningSegments(groups[1].items);
  assert.deepEqual(segments.map((segment) => segment.kind), ["thinking", "activity", "thinking", "activity"]);
  assert.deepEqual(segments.map((segment) => segment.kind === "thinking" ? [segment.item.id] : segment.items.map((entry) => entry.id)), [
    ["thought-a"], ["read", "run"], ["thought-b"], ["write"],
  ]);
  assert.equal(timelineHelpers.reasoningPreview(timeline[1]), "Considering account location and controller state before acting.");
  assert.equal(timelineHelpers.reasoningPreview(item("summary", "reasoning", "Checked controller state", "verbose raw thought")), "Checked controller state");
  assert.equal(timelineHelpers.formatReasoningText("Verify then poll.Poll until done. `keep.This`\n```txt\nkeep.This\n```\nRead frames.This is ready."), "Verify then poll. Poll until done. `keep.This`\n```txt\nkeep.This\n```\nRead frames. This is ready.");
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(item("same", "reasoning", "Working", "One complete thought.")), false);
  assert.equal(timelineHelpers.thinkingExpansionAddsContent(item("one-more", "reasoning", "One complete thought.", "One complete thought.!")), true);
  assert.match(timelineHelpers.activitySegmentPreview([timeline[2], timeline[3]]), /^Read C:\\project\\controller\.ts · 1 more$/u);
  assert.match(timelineHelpers.activitySegmentPreview([item("delegate", "subagent", "Layout review", "Checking visual alignment")]), /^Spawned sub-agent · Layout review$/u);
  assert.deepEqual(timelineHelpers.defaultExpandedSegmentIds(segments, "compact"), []);
  assert.deepEqual(timelineHelpers.defaultExpandedSegmentIds(segments, "expanded"), []);

  const separatedByEmptyAssistant = timelineHelpers.groupTimeline([
    item("before-empty", "reasoning", "Working", "First span"),
    item("empty-provider-row", "assistant", "assistant", ""),
    item("after-empty", "reasoning", "Working", "Second span"),
  ]);
  assert.deepEqual(separatedByEmptyAssistant.map((group) => group.kind), ["reasoning", "reasoning"]);
  assert.deepEqual(separatedByEmptyAssistant.map((group) => group.items[0].id), ["before-empty", "after-empty"]);
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
  assert.equal(timelineHelpers.timelineBoundaryLabel(compaction), "Automatically compacted context");
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("manual-compact", "assistant", "Context compacted")), "Context compacted");
  assert.equal(timelineHelpers.timelineBoundaryLabel(system), "Provider reconnected.");
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("question", "user", "Context automatically compacted")), null);
  assert.equal(timelineHelpers.timelineBoundaryLabel(item("explanation", "assistant", "If context automatically compacted, this explanation remains a normal answer.")), null);
  assert.equal(timelineHelpers.groupTimeline([compaction])[0].kind, "boundary");
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer([timeline[0], compaction, timeline[3]], 2), false);
  const running = { ...timeline[3], id: "running", phase: undefined, state: "running" };
  assert.equal(timelineHelpers.shouldSeparateFinalAnswer([timeline[0], timeline[2], running], 2), false);
});

test("composer and chat sources implement the reviewed compact interaction surface", async () => {
  const [composer, chat, css, app, styles, bridge] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "ChatTimeline.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
    source(join("src", "renderer", "src", "bridge.ts")),
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
  assert.doesNotMatch(composer, /return "Auto"/);
  assert.match(composer, /isAmbiguousSelectionValue\(value\)\) return ""/);
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
  assert.match(composer, /<span className="composer-setting-label">Model<\/span>\s*<button className=\{`model-picker-trigger/);
  assert.match(composer, /<div className=\{`composer-choice composer-setting/);
  assert.match(composer, /<span className="composer-setting-label">\{triggerDescription\}<\/span>[\s\S]*className="composer-setting-control"/);
  assert.match(composer, /effort && efforts\.length \? <ChoiceMenu[\s\S]*options=\{efforts\.map\(\(item\) => \(\{ value: item, label: reasoningLabel\(item\) \}\)\)\}/);
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
  assert.match(css, /\.dictation-main[\s\S]*z-index:\s*2[\s\S]*width:\s*38px[\s\S]*height:\s*42px[\s\S]*border-radius:\s*19px/);
  assert.doesNotMatch(css, /\.dictation-main\s*\{[^}]*padding-bottom/);
  assert.match(css, /\.dictation-main > svg\s*\{[^}]*z-index:\s*4[^}]*pointer-events:\s*none/);
  assert.match(css, /\.dictation-source-menu\s*\{[^}]*inset:\s*0[^}]*width:\s*38px[^}]*height:\s*42px[^}]*pointer-events:\s*none/);
  assert.match(css, /\.dictation-source-menu > button\s*\{[^}]*bottom:\s*0[^}]*width:\s*38px[^}]*height:\s*18px[^}]*display:\s*block[^}]*overflow:\s*visible[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.dictation-source-menu > button::before\s*\{[^}]*width:\s*38px[^}]*height:\s*42px[^}]*border-radius:\s*19px[^}]*clip-path:\s*path\("M 0 23 Q 19 29 38 23 L 38 42 L 0 42 Z"\)[^}]*pointer-events:\s*none/);
  assert.match(css, /\.dictation-source-menu > button svg\s*\{[^}]*left:\s*calc\(50% - 1px\)[^}]*bottom:\s*2px[^}]*transform:\s*translateX\(-50%\)/);
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
  assert.match(app, /const shouldFollow = historyAnchor\.current === null && \(pinnedToBottom\.current \|\| isAtBottom\(element\)\);[\s\S]*spacer\.style\.height = `\$\{next\}px`;[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*measuredComposerClearance\.current === next && pinnedToBottom\.current[\s\S]*scrollToLatest\(\)/);
  assert.match(app, /const scrollToLatest = useCallback\(\(\) => \{[\s\S]*pinnedToBottom\.current = true;[\s\S]*applyScrollTop\(element, element\.scrollHeight\)/);
  assert.match(app, /const movedUp = element\.scrollTop < lastScrollTop\.current - 1/);
  assert.match(app, /if \(isAtBottom\(element\)\) pinnedToBottom\.current = true;[\s\S]*else if \(movedUp && !echoed\) pinnedToBottom\.current = false/);
  assert.match(app, /className="conversation-tail-spacer" ref=\{tailSpacer\}/);
  assert.match(css, /\.conversation-tail-spacer[^{]*\{[^}]*height:\s*0/);
  assert.match(app, /if \(pinnedToBottom\.current\) scrollToLatest\(\)/);
  assert.match(styles, /\.conversation-scroll[^{]*\{[^}]*overflow-anchor:\s*none[^}]*scroll-behavior:\s*auto/);
  assert.match(css, /\.message-footer[^{]*\{[^}]*position:\s*absolute[^}]*top:\s*100%[^}]*left:\s*0[^}]*justify-content:\s*flex-start[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
  assert.doesNotMatch(css, /\.message-footer[^{]*\{[^}]*background:/);
  assert.match(css, /\.copy-message[^{]*\{[^}]*width:\s*21px;\s*height:\s*21px/);
  assert.match(css, /\.message-user \.message-body[^{]*\{[^}]*padding:\s*6px 12px/);
  assert.match(css, /\.dictation-source-menu > button:hover,[\s\S]*background:\s*#3a3a37/);
  assert.match(composer, /function DictationCrescentIcon\(\)/);
  assert.match(chat, /item\.kind === "assistant"/);
  assert.match(chat, /title=\{assistantName\}/);
  assert.match(chat, /function shouldShowAssistantIdentity/);
  assert.match(chat, /function finalAnswerCopyText/);
  assert.match(chat, /const footerCopyText = item\.kind === "user" \? item\.body\.trim\(\) : identity \? copyText : undefined/);
  assert.match(chat, /footerCopyText \? <div className="message-footer">/);
  assert.match(chat, /className="timeline-error-notice" role="status" aria-live="polite"/);
  assert.match(styles, /\.timeline-error-notice[^{]*\{[^}]*background:\s*#272725/);
  assert.doesNotMatch(styles, /\.timeline-error-notice[^{]*\{[^}]*var\(--danger\)|\.timeline-error-notice svg[^{]*\{[^}]*var\(--danger\)/);
  assert.match(chat, /className="timeline-item-meta"/);
  assert.match(chat, /copyLabel="Copy thinking"/);
  assert.match(chat, /copyLabel=\{`Copy \$\{visibleLabel\.toLowerCase\(\)\} details`\}/);
  assert.doesNotMatch(chat, /className="message-meta"/);
  assert.doesNotMatch(chat, /shouldShowTurnStartIdentity|reasoning-identity/);
  assert.doesNotMatch(styles, /\.reasoning-identity/);
  assert.match(chat, /function ChatTimeline\(/);
  assert.match(chat, /function ActiveCompactionStatus\(\{ kind \}/);
  assert.match(chat, /className="timeline-compaction-event timeline-compaction-active" role="status" aria-live="polite"/);
  assert.match(chat, /Automatically compacting context…/);
  assert.match(chat, /Automatically compacted context/);
  assert.match(chat, /isCompacting \? <ActiveCompactionStatus kind=\{compactionKind\} \/>/);
  assert.match(chat, /function groupTimeline\(/);
  assert.match(chat, /function reasoningSegments\(/);
  assert.match(chat, /reasoningDisplay\?: ReasoningDisplay/);
  assert.match(chat, /defaultExpandedSegmentIds\(segments, reasoningDisplay\)/);
  assert.match(chat, /`reasoning-disclosure /);
  assert.match(chat, /className="reasoning-category-controls"/);
  assert.match(chat, /disabled=\{!expandableThinking\.length\}/);
  assert.match(chat, /disabled=\{!expandable\}/);
  assert.match(chat, /formatReasoningText\(item\.body\)/);
  assert.match(chat, /"Collapse thinking" : "Expand thinking"/);
  assert.match(chat, /"Collapse tool calls" : "Expand tool calls"/);
  assert.match(chat, /className="reasoning-segment-preview"/);
  assert.match(chat, /className="activity-row"/);
  assert.match(chat, /"Spawned sub-agent"/);
  assert.doesNotMatch(chat, /className="activity-live"/);
  assert.match(chat, /className=\{`activity-snippet/);
  assert.match(chat, /return <ReasoningGroup items=\{\[item\]\}/);
  assert.doesNotMatch(chat, /return <ActivityDisclosure item=\{item\}\/>/);
  assert.ok((chat.match(/Collapse/g) ?? []).length >= 2);
  assert.match(chat, /enlarged \? "Reduce" : "Enlarge"/);
  assert.doesNotMatch(chat, /item\.detail/);
  assert.doesNotMatch(chat, /activity-card|activity-header|activity-output/);
  assert.match(styles, /\.reasoning-flow[\s\S]*font-style:\s*italic/);
  assert.match(styles, /\.reasoning-flow-running[\s\S]*animation:\s*reasoning-text-shimmer/);
  assert.match(styles, /prefers-reduced-motion:[\s\S]*\.reasoning-flow-running/);
  assert.match(styles, /\.reasoning-disclosure > svg[\s\S]*opacity:\s*0/);
  assert.match(styles, /\.reasoning-segment-row > svg[\s\S]*opacity:\s*0/);
  assert.match(styles, /\.reasoning-segment-row:disabled[^{]*\{[^}]*cursor:\s*default;[^}]*opacity:\s*1/);
  assert.doesNotMatch(styles, /\.reasoning-category-controls:(?:hover|focus-within)/);
  assert.match(styles, /\.reasoning-category-controls button:hover:not\(:disabled\)[\s\S]*background:/);
  assert.match(styles, /\.reasoning-category-controls button:disabled[^{]*\{[^}]*cursor:\s*default/);
  assert.match(styles, /\.timeline-boundary/);
  assert.match(styles, /\.timeline-compaction-active[\s\S]*animation:\s*compaction-text-sheen/);
  assert.match(styles, /\.timeline-compaction-completed/);
  assert.match(css, /--turn-boundary-gap:\s*42px/);
  assert.match(css, /\.message-assistant:has\(\.message-footer\) \+ \.reasoning-group,[\s\S]*margin-top:\s*32px/);
  assert.match(css, /\.message-images-before[^{]*\{[^}]*margin:\s*0 0 8px/);
  assert.match(css, /\.send-button\.stop-button[^{]*\{[^}]*background:\s*#765150/);
  assert.match(css, /\.message-assistant \+ \.message-user,[\s\S]*\.message-user \+ \.reasoning-group,[\s\S]*margin-top:\s*var\(--turn-boundary-gap\)/);
  assert.match(styles, /\.timeline-item-meta[^{]*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/);
  assert.match(styles, /\.timeline-copy-button:hover,[^\{]*\{[^}]*background:\s*#242422/);
  assert.match(app, /event\.type === "message\.started" \|\| event\.type === "message\.delta" \|\| event\.type === "tool\.started" \|\| event\.type === "command\.started"[\s\S]*state:\s*"working"/);
  assert.match(app, /function refreshVisibleState|const refreshVisibleState/);
  assert.match(app, /const \[sessions, timelinePage\] = await Promise\.all\(\[\s*listSessions\(\)/);
  assert.match(bridge, /export async function listSessions\(\)[\s\S]*request\("sessions\.list"\)/);
  assert.match(app, /addEventListener\("focus", refreshWhenVisible\)[\s\S]*addEventListener\("visibilitychange", refreshWhenVisible\)/);
  assert.match(app, /selectedSession\.state !== "working"[\s\S]*loadSessionTimelinePage\(sessionId, undefined, 40, true\)/);
  assert.match(app, /setTimeout\(\(\) => void reconcile\(\), 850\)/);
  assert.match(app, /loadSessionContext\(session\.id\)[\s\S]*updateContextCompaction\(context\.isCompacting, context\.compactionKind\)/);
  assert.match(app, /onCompactionChange=\{updateContextCompaction\}/);
  assert.match(app, /isCompacting=\{contextCompaction\.isCompacting\}[\s\S]*compactionKind=\{contextCompaction\.kind\}/);
  assert.match(app, /active=\{session\.state === "working"\}/);
  assert.match(app, /onInterrupt:\s*interruptSession/);
  assert.match(composer, /canInterrupt && !content\.trim\(\) \? "Stop task"/);
  assert.match(composer, /canInterrupt && !content\.trim\(\) \? <StopIcon \/>/);
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
  assert.match(composer, /className="queued-attachment-preview"/);
  assert.match(composer, /previewAttachment\?\.dataUrl \?/);
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
  assert.match(css, /\.queued-attachment-preview \{[^}]*object-fit: cover/);
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
