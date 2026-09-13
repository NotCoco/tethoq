import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-desktop-renderer-${process.pid}-${Date.now()}`);
const bridgeBundle = join(outputDirectory, "bridge.mjs");
const timelineMergeBundle = join(outputDirectory, "timeline-merge.mjs");
const timelineBundle = join(outputDirectory, "timeline.mjs");
const searchBundle = join(outputDirectory, "search-helpers.mjs");
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

const calls = [];
let releaseDeferredHistoryImage;
let deferredHistoryImageId = "deferred-image";
const deferredHistoryImage = new Promise((resolve) => { releaseDeferredHistoryImage = resolve; });
globalThis.window = {
  tethoqDesktop: {
    selectFiles: async (providerId) => providerId === "opencode" ? [{ kind: "file", name: "notes.ts", path: "C:\\notes.ts", mimeType: "text/plain", byteLength: 4, dataBase64: "dGVzdA==" }] : [],
    bootstrap: async () => ({
      app: { name: "Tethoq", version: "test", platform: "win32", packaged: false },
      host: { id: "desktop_test", displayName: "Test host", connectionState: "online" },
      providers: [{
        providerId: "acme-agent",
        displayName: "Acme Agent",
        state: "online",
        detected: true,
        authenticated: true,
        iconDataUrl: "data:image/png;base64,AA==",
        capabilities: { sendMessage: true, steering: true },
      }],
      allowedProviders: ["codex", "opencode", "grok", "acme-agent"],
      connectors: {
        directory: "C:\\connectors",
        loaded: [{
          id: "acme-agent",
          name: "Acme Agent",
          version: "1.0.0",
          source: "external",
          fingerprint: `sha256:${"1".repeat(64)}`,
          directory: "C:\\connectors\\acme-agent",
          permissions: { filesystem: "workspace", network: false, spawnProcesses: true },
          capabilities: { attachments: true, reasoningEfforts: true, messageQueue: false },
        }],
        pending: [],
        diagnostics: [],
      },
      latestSequence: 0,
      openCode: { state: "stopped", url: "http://127.0.0.1:4096/", managed: false },
    }),
    request: async (type, payload = {}) => {
      calls.push({ type, payload });
      if (type === "sessions.list") return { ok: true, payload: { sessions: [{
        id: "external-session",
        providerId: "acme-agent",
        title: "External task",
        state: "idle",
        workingDirectory: "C:\\work",
        lastActivityAt: "2026-08-13T00:00:00.000Z",
        contextHandoffSummary: "Top-level handoff summary",
        externalWriter: true,
        nativeMetadata: { tethoqHandoffSummary: "Legacy summary must not win" },
      }, {
        id: "legacy-handoff-session",
        providerId: "acme-agent",
        title: "Legacy handoff",
        state: "idle",
        workingDirectory: "C:\\work",
        lastActivityAt: "2026-08-13T00:00:00.000Z",
        nativeMetadata: { tethoqHandoffSummary: "Legacy metadata summary" },
      }, {
        id: "host/opencode/root-chat",
        providerId: "opencode",
        title: "OpenCode project chat",
        state: "idle",
        workingDirectory: "C:\\work",
        lastActivityAt: "2026-08-13T00:00:00.000Z",
        parentSessionId: "host/opencode/workspace",
        providerStatus: { kind: "retry", message: "Provider is temporarily busy", retryAt: "2026-08-20T12:00:00.000Z" },
        nativeMetadata: {},
      }, {
        id: "host/opencode/spawned",
        providerId: "opencode",
        title: "Spawned helper",
        state: "idle",
        workingDirectory: "C:\\work",
        lastActivityAt: "2026-08-13T00:00:00.000Z",
        parentSessionId: "host/opencode/root-chat",
        relationship: { kind: "subagent", sourceSessionId: "host/opencode/root-chat", strategy: "native" },
        nativeMetadata: {},
      }] } };
      if (type === "sessions.bootstrap" || type === "sessions.refresh") return { ok: true, payload: { sessions: [{
        id: "external-session",
        providerId: "acme-agent",
        title: "External task",
        state: "idle",
        workingDirectory: "C:\\work",
        lastActivityAt: "2026-08-13T00:00:00.000Z",
        contextHandoffSummary: "Top-level handoff summary",
        externalWriter: true,
        nativeMetadata: { tethoqHandoffSummary: "Legacy summary must not win" },
      }, {
        id: "legacy-handoff-session",
        providerId: "acme-agent",
        title: "Legacy handoff",
        state: "idle",
        workingDirectory: "C:\\work",
        lastActivityAt: "2026-08-13T00:00:00.000Z",
        nativeMetadata: { tethoqHandoffSummary: "Legacy metadata summary" },
      }] } };
      if (type === "approval.list") return { ok: true, payload: { approvals: [] } };
      if (type === "user_input.list") return { ok: true, payload: { requests: [{
        requestId: "input-1",
        hostId: "desktop_test",
        providerId: "acme-agent",
        sessionId: "session-1",
        providerRequestId: "native-1",
        createdAt: "2026-08-13T00:00:00.000Z",
        title: "Fallback title",
        request: {
          questions: [{
            id: "deployment_target",
            header: "Choose target",
            question: "Where should this deploy?",
            options: [{ label: "Staging" }, { label: "Production" }],
          }],
        },
      }] } };
      if (type === "models.list") return { ok: true, payload: { models: [
        { id: "first-model", providerId: "acme-agent", displayName: "First model", isDefault: false, nativeMetadata: { sourceProviderId: "synthetic", sourceProviderName: "Synthetic", contextWindow: 128_000, pricing: { input: 3 / 1_000_000, output: 15 / 1_000_000 } } },
        { id: "default-model", providerId: "acme-agent", displayName: "Default model", isDefault: true, nativeMetadata: {} },
      ] } };
      if (type === "session.open" && payload.sessionId === "deferred-history-image") return { ok: true, payload: { messages: [{
        id: "deferred-image-message",
        sessionId: payload.sessionId,
        providerMessageId: "deferred-image-native",
        role: "user",
        createdAt: "2026-08-25T10:00:00.000Z",
        status: "completed",
        nativeMetadata: {},
        parts: [
          { type: "text", text: "Text must render before the preview arrives." },
          { type: "image", retrievalId: deferredHistoryImageId, mimeType: "image/png", name: "slow.png" },
        ],
      }] } };
      if (type === "session.image.get" && ["deferred-image", "deferred-image-new"].includes(payload.retrievalId)) {
        await deferredHistoryImage;
        return { ok: true, payload: { retrievalId: payload.retrievalId, offset: 0, totalBytes: 3, dataBase64: payload.retrievalId === "deferred-image" ? "AQID" : "BAUG", nextOffset: null, mimeType: "image/png" } };
      }
      if (type === "session.open" && payload.sessionId === "role-mapping") return { ok: true, payload: { messages: [{
        id: "assistant-message",
        sessionId: payload.sessionId,
        providerMessageId: "assistant-native",
        role: "assistant",
        createdAt: "2026-08-14T09:59:00.000Z",
        status: "completed",
        nativeMetadata: {},
        parts: [{ type: "text", text: "Visible answer" }],
      }, {
        id: "tool-message",
        sessionId: payload.sessionId,
        providerMessageId: "tool-native",
        role: "tool",
        createdAt: "2026-08-14T10:00:00.000Z",
        status: "completed",
        nativeMetadata: { toolName: "Read", toolCallId: "call-7" },
        parts: [{ type: "text", text: "A large raw tool result" }],
      }, {
        id: "raw-system-message",
        sessionId: payload.sessionId,
        providerMessageId: "system-native",
        role: "system",
        createdAt: "2026-08-14T10:01:00.000Z",
        status: "completed",
        nativeMetadata: {},
        parts: [{ type: "text", text: "Internal system trace that must not enter the visible conversation" }],
      }, {
        id: "compaction-message",
        sessionId: payload.sessionId,
        providerMessageId: "compaction-native",
        role: "system",
        createdAt: "2026-08-14T10:02:00.000Z",
        status: "completed",
        nativeMetadata: {},
        parts: [{ type: "text", text: "Session compacted" }],
      }], nextCursor: "older-page" } };
      if (type === "session.open" && payload.sessionId === "part-identity") return { ok: true, payload: { messages: [{
        id: "assistant-parts",
        sessionId: payload.sessionId,
        providerMessageId: "provider-message",
        role: "assistant",
        createdAt: "2026-08-20T10:00:00.000Z",
        status: "completed",
        nativeMetadata: {},
        parts: [
          { type: "reasoning", providerPartId: "prt_reasoning", text: "Considering it" },
          { type: "text", providerPartId: "prt_text", text: "Done" },
        ],
      }] } };
      if (type === "session.open" && payload.sessionId === "pending-command") return { ok: true, payload: { messages: [{
        id: "command-message",
        sessionId: payload.sessionId,
        providerMessageId: "command-native",
        role: "tool",
        createdAt: "2026-08-21T10:00:00.000Z",
        status: "streaming",
        nativeMetadata: {},
        parts: [{ type: "command", command: "npm test -- --runInBand", status: "pending" }],
      }] } };
      if (type === "session.open" && payload.sessionId === "preview-hydration") return { ok: true, payload: {
        session: {
          id: "preview-hydration",
          hostId: "desktop_test",
          providerId: "opencode",
          providerSessionId: "native-preview-hydration",
          title: "New session - 2026-08-22",
          preview: "Take the hostile base-population research forward aggressively and autonomously.",
          state: "idle",
          lastActivityAt: "2026-08-22T10:00:00.000Z",
          needsApproval: false,
          stale: false,
          nativeMetadata: {},
        },
        messages: [],
      } };
      if (type === "session.open") return { ok: true, payload: { messages: [{
        id: "message-image",
        sessionId: payload.sessionId,
        providerMessageId: "native-image",
        role: "user",
        createdAt: "2026-08-14T10:00:00.000Z",
        status: "completed",
        nativeMetadata: {},
        parts: [{ type: "text", text: "Inspect this" }, { type: "image", uri: "data:image/png;base64,AQID", mimeType: "image/png", name: "screen.png" }],
      }] } };
      if (type === "session.context.get" || type === "session.context.set_threshold") return { ok: true, payload: { context: {
        sessionId: payload.sessionId,
        modelId: "test-model",
        usedTokens: 42_800,
        contextWindowTokens: 128_000,
        usedPercent: 33.4375,
        compactionThresholdTokens: payload.thresholdTokens ?? 96_000,
        minimumThresholdTokens: 8_000,
        supportsManualCompaction: true,
        supportsThreshold: true,
        isCompacting: false,
        updatedAt: "2026-08-14T10:00:00.000Z",
        usage: { inputTokens: 39_100, outputTokens: 3_700, totalTokens: 42_800, cost: .42, currency: "USD" },
      } } };
      if (type === "session.children") return { ok: true, payload: { sessions: [{
        id: "delegated-child",
        hostId: "desktop_test",
        providerId: "missing-agent",
        providerSessionId: "child-native",
        title: "Delegated: Review the layout",
        state: "working",
        workingDirectory: "C:\\work",
        lastActivityAt: "2026-08-13T00:00:00.000Z",
        parentSessionId: "external-session",
        relationship: { kind: "subagent", sourceSessionId: "external-session", strategy: "native" },
        agentNickname: "Acme delegate",
        agentRole: "cross_harness_delegate",
        needsApproval: false,
        stale: false,
        nativeMetadata: {},
      }] } };
      if (type === "scheduled_task.list") return { ok: true, payload: { tasks: [] } };
      throw new Error(`Unexpected request: ${type}`);
    },
  },
};

await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "bridge.ts")],
  outfile: bridgeBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: { "@shared": join(appRoot, "src", "shared") },
});
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "timeline_merge.ts")],
  outfile: timelineMergeBundle,
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
  plugins: [inlineWorkerStubPlugin],
});
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "search_helpers.ts")],
  outfile: searchBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
const searchHelpers = await import(`file:///${searchBundle.replaceAll("\\", "/")}`);
const bridge = await import(`file:///${bridgeBundle.replaceAll("\\", "/")}`);
const timelineMerge = await import(`file:///${timelineMergeBundle.replaceAll("\\", "/")}`);
const timelineHelpers = await import(`file:///${timelineBundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });


test("desktop search normalizes Unicode, controls, whitespace, and excessive input", async () => {
  assert.equal(searchHelpers.normalizeUiSearchQuery(" \u0000 ＤＥＦＡＵＬＴ\t ReAsoning "), "default reasoning");
  assert.equal(searchHelpers.normalizeUiSearchQuery("x".repeat(400)).length, 160);
});

test("initial renderer snapshot paints providers before attention requests settle", async () => {
  calls.length = 0;
  const result = await bridge.loadInitialSnapshot();

  assert.deepEqual(calls.slice(0, 2).map((call) => call.type).sort(), [
    "scheduled_task.list",
    "sessions.list",
  ]);
  assert.deepEqual(result.snapshot.inputRequests, []);
  const attention = await result.attentionHydration;
  assert.deepEqual(attention.inputRequests, [{
    id: "input-1",
    sessionId: "session-1",
    title: "Choose target",
    prompt: "Where should this deploy?",
    answerKey: "deployment_target",
    options: ["Staging", "Production"],
    questions: [{ id: "deployment_target", title: "Choose target", prompt: "Where should this deploy?", options: [{ value: "Staging", label: "Staging" }, { value: "Production", label: "Production" }], multiple: false, allowCustom: true, secret: false }],
  }]);
  assert.equal(result.snapshot.providers[0].id, "acme-agent");
  assert.equal(result.snapshot.providers[0].supportsAttachments, true);
  assert.equal(result.snapshot.providers[0].iconDataUrl, "data:image/png;base64,AA==");
  assert.equal(result.snapshot.sessions[0].providerId, "acme-agent");
  assert.equal(result.snapshot.sessions[0].contextSummary, "Top-level handoff summary");
  assert.equal(result.snapshot.sessions[0].externalWriter, true);
  assert.equal(result.snapshot.sessions[1].contextSummary, "Legacy metadata summary");
  // First paint deliberately does not wait for any provider's model catalogue.
  assert.deepEqual(result.snapshot.models, {});
});

test("context usage parsing and threshold updates preserve provider values", async () => {
  calls.length = 0;
  const initial = await bridge.loadSessionContext("external-session");
  const updated = await bridge.setSessionContextThreshold("external-session", 64_000, true);

  assert.equal(initial.usedTokens, 42_800);
  assert.equal(initial.usage.cost, .42);
  assert.equal(updated.compactionThresholdTokens, 64_000);
  assert.deepEqual(calls.at(-1), {
    type: "session.context.set_threshold",
    payload: { sessionId: "external-session", thresholdTokens: 64_000, compactNow: true },
  });
});

test("renderer generic file selection is gated to OpenCode", async () => {
  await assert.rejects(() => bridge.selectFiles("codex"), /only for OpenCode/);
  assert.deepEqual(await bridge.selectFiles("opencode"), [{
    kind: "file",
    name: "notes.ts",
    path: "C:\\notes.ts",
    mimeType: "text/plain",
    byteLength: 4,
    dataBase64: "dGVzdA==",
  }]);
});

test("failed compaction reports a retryable system notice without claiming success", () => {
  const item = bridge.eventToTimeline({
    sequence: 1, eventId: "compact-failed", type: "context.compaction_failed",
    hostId: "desktop_test", providerId: "codex", sessionId: "session-1",
    occurredAt: "2026-09-06T00:00:00.000Z", payload: { kind: "automatic" },
  });
  assert.equal(item.title, "System");
  assert.equal(item.body, "Compaction could not be completed. You can try again.");
  assert.equal(item.state, "completed");
});

test("OpenCode compaction summaries use a disclosure in history and from the first live text", () => {
  const message = { id: "opencode/summary", providerMessageId: "summary", sessionId: "session", role: "assistant",
    createdAt: "2026-09-07T11:00:00.000Z", status: "completed",
    nativeMetadata: { mode: "compaction", summary: true },
    parts: [{ type: "reasoning", text: "Internal summary preparation", redacted: false }, { type: "text", text: "## Objective\nPreserve the goal and next steps" }] };
  const items = bridge.mapMessages([message]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Compaction");
  assert.equal(items[0].body, message.parts[1].text);
  const event = { sequence: 1, eventId: "summary-chunk", type: "message.delta", hostId: "host", providerId: "opencode", sessionId: "session",
    occurredAt: message.createdAt, payload: { messageId: "summary", partId: "text", partType: "text", text: "## Objective", compaction: true } };
  assert.equal(bridge.eventToTimeline(event).title, "Compaction");
  assert.equal(bridge.eventToTimeline({ ...event, payload: { ...event.payload, partType: "reasoning" } }), null);
  assert.equal(bridge.mapMessages([{ ...message, nativeMetadata: {}, parts: [message.parts[1]] }])[0].title, undefined, "ordinary answers with identical headings remain visible");
  const failed = bridge.mapMessages([{ ...message, status: "failed", parts: [...message.parts, { type: "error", message: "Summary failed" }] }]);
  assert.equal(failed[0].state, "failed");
  assert.equal(failed[1].body, "Summary failed");
});

test("streaming events reuse provider message identity through completion", () => {
  const base = {
    sequence: 1,
    hostId: "desktop_test",
    providerId: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T00:00:00.000Z",
    nativeEvent: undefined,
  };
  const delta = bridge.eventToTimeline({ ...base, eventId: "event-1", type: "message.delta", payload: { messageId: "message-1", delta: "Hello" } });
  const completed = bridge.eventToTimeline({ ...base, sequence: 2, eventId: "event-2", type: "message.completed", payload: { messageId: "message-1", text: "Hello world" } });

  assert.equal(delta.id, completed.id);
  assert.equal(delta.state, "running");
  assert.equal(completed.state, "completed");
});

test("Codex item completion reuses the streamed item id and exposes completed text", () => {
  const base = {
    sequence: 1,
    hostId: "desktop_test",
    providerId: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-13T00:00:00.000Z",
  };
  const delta = bridge.eventToTimeline({ ...base, eventId: "codex:delta", type: "message.delta", payload: { itemId: "item-7", text: "Hello " } });
  const completed = bridge.eventToTimeline({ ...base, sequence: 2, eventId: "codex:completed", type: "message.completed", payload: { item: { id: "item-7", type: "agentMessage", text: "Hello world" } } });

  assert.equal(delta.id, completed.id);
  assert.equal(delta.body, "Hello ");
  assert.equal(completed.body, "Hello world");
});

test("completed user events expose only safe loading placeholders for image attachments", () => {
  const base = {
    sequence: 1,
    hostId: "desktop_test",
    providerId: "codex",
    sessionId: "session-1",
    occurredAt: "2026-09-02T08:00:00.000Z",
  };
  const completed = bridge.eventToTimeline({
    ...base,
    eventId: "codex:user-with-image",
    type: "message.completed",
    payload: {
      messageId: "user-with-image",
      role: "user",
      text: "This message has an image.",
      imageAttachments: [{
        name: " C:\\private\\screenshot.png ",
        mimeType: "image/png",
        uri: "file:///C:/private/screenshot.png",
        path: "C:\\private\\screenshot.png",
        src: "data:image/png;base64,AQID",
        dataBase64: "AQID",
      }, {
        name: "preview",
        mimeType: "text/html",
        base64: "unsafe",
      }, {
        name: "   ",
        mimeType: "image/jpeg",
      }],
    },
  });

  assert.equal(completed.kind, "user");
  assert.equal(completed.body, "This message has an image.");
  assert.deepEqual(completed.images, [
    { name: "screenshot.png", mimeType: "image/png", loading: true },
    { name: "preview", loading: true },
    { name: "Attached image", mimeType: "image/jpeg", loading: true },
  ]);
  assert.equal(timelineHelpers.hasVisibleTimelineContent(completed), true);
  assert.doesNotMatch(JSON.stringify(completed.images), /file:|C:\\\\private|data:image|AQID|unsafe/u);

  const delta = bridge.eventToTimeline({
    ...base,
    eventId: "codex:user-delta",
    type: "message.delta",
    payload: { messageId: "user-delta", role: "user", text: "Streaming", imageAttachments: [{ name: "ignored.png", mimeType: "image/png" }] },
  });
  const assistant = bridge.eventToTimeline({
    ...base,
    eventId: "codex:assistant-with-descriptor",
    type: "message.completed",
    payload: { messageId: "assistant-with-descriptor", role: "assistant", text: "Done", imageAttachments: [{ name: "ignored.png", mimeType: "image/png" }] },
  });
  const ordinary = bridge.eventToTimeline({
    ...base,
    eventId: "codex:ordinary-user",
    type: "message.completed",
    payload: { messageId: "ordinary-user", role: "user", text: "No attachment" },
  });
  assert.equal(delta.images, undefined);
  assert.equal(assistant.images, undefined);
  assert.equal(ordinary.images, undefined);
});

test("live and canonical Codex attachment records coalesce two images without fallback duplicates", () => {
  const body = "Compare both attached screenshots.";
  const live = bridge.eventToTimeline({
    sequence: 1,
    eventId: "codex:response-item:user-message",
    hostId: "desktop_test",
    providerId: "codex",
    sessionId: "session-two-images",
    occurredAt: "2026-09-02T08:15:00.000Z",
    type: "message.completed",
    payload: {
      messageId: "response-item-user-message",
      turnId: "turn-two-images",
      role: "user",
      text: body,
      imageAttachments: [
        { name: "first.png", mimeType: "image/png" },
        { mimeType: "image/png" },
      ],
    },
  });
  const canonical = bridge.mapMessages([{
    id: "canonical-user-message",
    sessionId: "session-two-images",
    providerMessageId: "canonical-user-message",
    role: "user",
    createdAt: "2026-09-02T08:15:05.000Z",
    completedAt: "2026-09-02T08:15:05.000Z",
    status: "completed",
    nativeMetadata: { turnId: "turn-two-images", canonicalUserMessage: true },
    parts: [
      { type: "text", text: body },
      { type: "image", retrievalId: "first-image", mimeType: "image/png", name: "first.png", uri: "data:image/png;base64,AQID" },
      { type: "image", retrievalId: "second-image", mimeType: "image/png", uri: "data:image/png;base64,BAUG" },
    ],
  }]);

  assert.ok(live);
  assert.deepEqual(live.images?.map((image) => image.name), ["first.png", "Attached image"]);
  assert.equal(canonical.length, 1);
  assert.deepEqual(canonical[0].images?.map((image) => image.name), ["first.png", "Attached image"]);

  const reconciled = timelineMerge.reconcileTimelinePage(canonical, [live]);
  assert.equal(reconciled.length, 1, "one Codex turn remains one user row");
  assert.equal(reconciled[0].kind, "user");
  assert.equal(reconciled[0].body, body);
  assert.equal(reconciled[0].images?.length, 2, "the transcript renders exactly two image widgets");
  assert.deepEqual(reconciled[0].images?.map((image) => image.name), ["first.png", "Attached image"]);
  assert.deepEqual(reconciled[0].images?.map((image) => image.dataUrl), [
    "data:image/png;base64,AQID",
    "data:image/png;base64,BAUG",
  ]);

  const reopened = timelineMerge.reconcileTimelinePage(canonical, reconciled);
  assert.equal(reopened.length, 1, "a repeated canonical refresh cannot duplicate the user row");
  assert.equal(reopened[0].images?.length, 2, "fallback naming cannot duplicate the unnamed image widget");
});

test("Codex command activity carries its call identity into timeline reconciliation", () => {
  const row = bridge.eventToTimeline({
    sequence: 1,
    eventId: "codex:command",
    hostId: "desktop_test",
    providerId: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-21T10:00:00.000Z",
    type: "command.started",
    payload: { itemId: "call-1", command: "npm test" },
  });

  assert.equal(row.id, "session-1:command:call-1");
  assert.equal(row.messageId, "call-1");
  assert.equal(row.body, "npm test", "known command text is visible from the first event");

  const generic = bridge.eventToTimeline({
    sequence: 2,
    eventId: "codex:command-generic",
    hostId: "desktop_test",
    providerId: "codex",
    sessionId: "session-1",
    occurredAt: "2026-08-21T10:00:00.000Z",
    type: "command.started",
    payload: { itemId: "call-2", command: "pnpm typecheck", text: "Command is running…" },
  });
  assert.equal(generic.body, "pnpm typecheck", "generic lifecycle prose never replaces known input");
});

test("stored pending commands display their known input before output arrives", async () => {
  const page = await bridge.loadSessionTimelinePage("pending-command");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].kind, "command");
  assert.equal(page.items[0].state, "running");
  assert.equal(page.items[0].body, "npm test -- --runInBand");
  assert.doesNotMatch(page.items[0].body, /Command is running/iu);
});

test("history text and placeholders return before deferred image bytes", async () => {
  const page = await Promise.race([
    bridge.loadSessionTimelinePage("deferred-history-image"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("History page waited for its image")), 500)),
  ]);

  assert.equal(page.items[0]?.body, "Text must render before the preview arrives.");
  assert.equal(page.items[0]?.images?.[0]?.name, "slow.png");
  assert.equal(page.items[0]?.images?.[0]?.dataUrl, undefined);
  assert.equal(page.items[0]?.images?.[0]?.loading, true);
  assert.ok(page.imageHydration instanceof Promise);

  releaseDeferredHistoryImage();
  const hydrated = await page.imageHydration;
  assert.equal(hydrated[0]?.images?.[0]?.dataUrl, "data:image/png;base64,AQID");

  const imageRequests = calls.filter((call) => call.type === "session.image.get" && call.payload.retrievalId === "deferred-image").length;
  const reopened = await bridge.loadSessionTimelinePage("deferred-history-image");
  assert.equal(reopened.items[0]?.images?.[0]?.dataUrl, hydrated[0]?.images?.[0]?.dataUrl, "a cached image must be present in the first refreshed paint");
  assert.equal(reopened.imageHydration, undefined, "a cached image must not schedule another placeholder-to-image transition");
  await reopened.imageHydration;
  assert.equal(calls.filter((call) => call.type === "session.image.get" && call.payload.retrievalId === "deferred-image").length, imageRequests, "the hydrated preview is reused from the bounded renderer cache");
  deferredHistoryImageId = "deferred-image-new";
  const replaced = await bridge.loadSessionTimelinePage("deferred-history-image");
  assert.equal(replaced.items[0]?.images?.[0]?.dataUrl, undefined, "a new image identity must not reuse old bytes with the same filename");
  assert.equal(replaced.items[0]?.images?.[0]?.retrievalId, deferredHistoryImageId);
  const replacement = await replaced.imageHydration;
  assert.equal(replacement[0]?.images?.[0]?.dataUrl, "data:image/png;base64,BAUG");
  const refreshedReplacement = await bridge.loadSessionTimelinePage("deferred-history-image");
  assert.equal(refreshedReplacement.items[0]?.images?.[0]?.dataUrl, "data:image/png;base64,BAUG");
  assert.equal(refreshedReplacement.imageHydration, undefined);
  deferredHistoryImageId = "deferred-image";
});

test("an opened session returns its first-prompt preview to the renderer", async () => {
  const page = await bridge.loadSessionTimelinePage("preview-hydration");
  assert.equal(page.session?.title, "New session - 2026-08-22", "the provider title stays untouched");
  assert.equal(page.session?.preview, "Take the hostile base-population research forward aggressively and autonomously.");
});

test("OpenCode native part identity coalesces real text delta events", () => {
  const makeEvent = (sequence, eventId, text) => ({
    sequence,
    eventId,
    type: "message.delta",
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: { text, partType: "text" },
    nativeEvent: {
      payload: {
        type: "message.part.updated",
        properties: {
          delta: text,
          part: { id: "part-1", messageID: "message-9", sessionID: "native-session", type: "text" },
        },
      },
    },
  });
  const first = bridge.eventToTimeline(makeEvent(1, "opencode:1", "Hello "));
  const second = bridge.eventToTimeline(makeEvent(2, "opencode:2", "there"));

  assert.equal(first.id, second.id);
  assert.equal(first.body, "Hello ");
  assert.equal(second.body, "there");
});

test("OpenCode id-less normalized deltas share the active session stream", () => {
  const base = {
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-13T00:00:00.000Z",
    type: "message.delta",
  };
  const first = bridge.eventToTimeline({ ...base, sequence: 1, eventId: "opencode:1", payload: { text: "One", partType: "text" } });
  const second = bridge.eventToTimeline({ ...base, sequence: 2, eventId: "opencode:2", payload: { text: " two", partType: "text" } });

  assert.equal(first.id, second.id);
});

test("OpenCode edit, write, and run activity reaches the timeline with concrete details", () => {
  const base = {
    sequence: 1,
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-22T00:00:00.000Z",
    type: "tool.completed",
  };
  const edit = bridge.eventToTimeline({ ...base, eventId: "oc:edit", payload: {
    id: "edit_part",
    name: "Edit C:\\work\\src\\app.ts",
    output: "File: C:\\work\\src\\app.ts\n\nReplaced:\nold\n\nWith:\nnew",
  } });
  const write = bridge.eventToTimeline({ ...base, sequence: 2, eventId: "oc:write", payload: {
    id: "write_part",
    name: "Write C:\\work\\notes.md",
    output: "File: C:\\work\\notes.md\n\nWritten content:\nRelease ready",
  } });
  const run = bridge.eventToTimeline({ ...base, sequence: 3, eventId: "oc:run", payload: {
    id: "run_part",
    name: "Run npm test",
    output: "Command: npm test\n\nResult:\n12 tests passed",
  } });

  assert.deepEqual([edit.title, write.title, run.title], [
    "Edit C:\\work\\src\\app.ts",
    "Write C:\\work\\notes.md",
    "Run npm test",
  ]);
  assert.match(edit.body, /Replaced:\nold[\s\S]*With:\nnew/u);
  assert.match(write.body, /Written content:\nRelease ready/u);
  assert.match(run.body, /Command: npm test[\s\S]*12 tests passed/u);
});

test("OpenCode tool snapshots keep one provider-part row as call details arrive", () => {
  const base = {
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-26T00:00:00.000Z",
  };
  const pending = bridge.eventToTimeline({
    ...base,
    sequence: 1,
    eventId: "oc:tool-pending",
    type: "tool.started",
    payload: { id: "tool_part_1", partId: "tool_part_1", messageID: "assistant_1", name: "Run", output: "Running…", status: "pending" },
  });
  const running = bridge.eventToTimeline({
    ...base,
    sequence: 2,
    eventId: "oc:tool-running",
    type: "tool.started",
    payload: { id: "tool_part_1", partId: "tool_part_1", messageID: "assistant_1", callId: "call_1", name: "Run npm test", output: "Command: npm test\n\nResult:\nRunning…", status: "running" },
  });
  const completed = bridge.eventToTimeline({
    ...base,
    sequence: 3,
    eventId: "oc:tool-complete",
    type: "tool.completed",
    payload: { id: "tool_part_1", partId: "tool_part_1", messageID: "assistant_1", callId: "call_1", name: "Run npm test", output: "Command: npm test\n\nResult:\n12 tests passed", status: "completed" },
  });

  assert.equal(pending.id, running.id);
  assert.equal(running.id, completed.id);
  assert.equal(completed.id, "session-1:tool:tool_part_1");
  assert.equal(completed.providerPartId, "tool_part_1");
  assert.equal(completed.messageId, "assistant_1");
  assert.equal(running.detail, "tool_part_1");
  assert.deepEqual([pending.streamDelta, running.streamDelta, completed.streamDelta], [false, false, false]);
  assert.deepEqual([pending.state, running.state, completed.state], ["running", "running", "completed"]);

  const failedRunning = bridge.eventToTimeline({
    ...base,
    sequence: 4,
    eventId: "oc:tool-failed-running",
    type: "tool.started",
    payload: { id: "tool_part_2", partId: "tool_part_2", messageID: "assistant_1", name: "Run missing command", output: "Running…", status: "running" },
  });
  const failed = bridge.eventToTimeline({
    ...base,
    sequence: 5,
    eventId: "oc:tool-failed",
    type: "tool.completed",
    payload: { id: "tool_part_2", partId: "tool_part_2", messageID: "assistant_1", callId: "call_2", name: "Run missing command", output: "Missing command", status: "failed" },
  });
  assert.equal(failedRunning.id, failed.id, "a failed tool abandoned its live row");
  assert.equal(failed.state, "failed");

  const generic = bridge.eventToTimeline({
    ...base,
    providerId: "codex",
    sequence: 6,
    eventId: "codex:tool-output",
    type: "tool.output",
    payload: { toolCallId: "call_2", output: "one chunk" },
  });
  assert.equal(generic.streamDelta, undefined, "non-OpenCode tool chunks retain append semantics");
});

test("Grok ACP content and thought chunks display their nested text", () => {
  const base = {
    hostId: "desktop_test",
    providerId: "grok",
    sessionId: "session-1",
    occurredAt: "2026-08-13T00:00:00.000Z",
    type: "message.delta",
  };
  const first = bridge.eventToTimeline({ ...base, sequence: 1, eventId: "grok:1", payload: { messageId: "message-1", role: "assistant", content: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "Hello " } } } });
  const second = bridge.eventToTimeline({ ...base, sequence: 2, eventId: "grok:2", payload: { messageId: "message-1", role: "assistant", content: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "from Grok" } } } });
  const thought = bridge.eventToTimeline({ ...base, sequence: 3, eventId: "grok:3", payload: { reasoning: { type: "text", text: "Checking files" } } });
  const grokThought = bridge.eventToTimeline({
    ...base,
    sequence: 4,
    eventId: "grok:4",
    payload: {
      messageId: "thought-1",
      role: "assistant",
      partType: "reasoning",
      content: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting" } },
    },
  });
  const grokThoughtWithoutPartType = bridge.eventToTimeline({
    ...base,
    sequence: 5,
    eventId: "grok:5",
    payload: {
      messageId: "thought-2",
      role: "assistant",
      content: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Still thinking" } },
    },
  });
  const directReasoning = bridge.eventToTimeline({
    ...base,
    providerId: "direct",
    sequence: 6,
    eventId: "direct:1",
    payload: { messageId: "answer-1", reasoning: "Considering options" },
  });

  assert.equal(first.id, second.id);
  assert.equal(first.body, "Hello ");
  assert.equal(second.body, "from Grok");
  assert.equal(thought.kind, "reasoning");
  assert.equal(thought.body, "Checking files");
  assert.equal(grokThought.kind, "reasoning");
  assert.equal(grokThought.state, "running");
  assert.equal(grokThought.body, "Inspecting");
  assert.equal(grokThoughtWithoutPartType.kind, "reasoning");
  assert.equal(grokThoughtWithoutPartType.body, "Still thinking");
  assert.equal(directReasoning.kind, "reasoning");
  assert.equal(directReasoning.body, "Considering options");
});

test("session history preserves renderer-safe inline image data", async () => {
  const timeline = await bridge.loadSessionTimeline("external-session");
  const image = timeline.find((item) => item.images?.length);
  assert.equal(image.kind, "user");
  assert.equal(image.body, "Inspect this");
  assert.equal(image.images[0].name, "screen.png");
  assert.equal(image.images[0].dataUrl, "data:image/png;base64,AQID");
});

test("image-only history keeps media metadata without inventing visible prose", () => {
  const timeline = bridge.mapMessages([{
    id: "image-only-history",
    sessionId: "host/opencode/image-only",
    providerMessageId: "native-image-only",
    role: "user",
    createdAt: "2026-08-28T08:00:00.000Z",
    completedAt: "2026-08-28T08:00:00.000Z",
    status: "completed",
    nativeMetadata: {},
    parts: [
      { type: "image", uri: "data:image/png;base64,AQID", mimeType: "image/png", name: "one.png" },
      { type: "image", uri: "data:image/png;base64,BAUG", mimeType: "image/png", name: "two.png" },
    ],
  }]);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, "user");
  assert.equal(timeline[0].body, "");
  assert.deepEqual(timeline[0].images.map((image) => image.name), ["one.png", "two.png"]);
});

test("session history preserves provider content-part identity", async () => {
  const timeline = await bridge.loadSessionTimeline("part-identity");
  assert.deepEqual(timeline.map((item) => item.providerPartId), ["prt_reasoning", "prt_text"]);
  assert.deepEqual(timeline.map((item) => item.messageId), ["provider-message", "provider-message"]);
});

test("a recovered OpenCode reasoning leak renders inside Reasoning with only the answer top-level", () => {
  const mapped = bridge.mapMessages([{
    id: "opencode-leaked-reasoning",
    sessionId: "host/opencode/session",
    providerMessageId: "assistant_leaked",
    role: "assistant",
    createdAt: "2026-08-31T00:00:00.000Z",
    completedAt: "2026-08-31T00:00:01.000Z",
    status: "completed",
    nativeMetadata: {},
    parts: [{
      type: "reasoning",
      text: "The user is asking for a concise result. Keep it short.",
      redacted: false,
      providerPartId: "leaked_text:reasoning-presentation",
    }, {
      type: "text",
      text: "I fixed the stale completion state.",
      providerPartId: "leaked_text",
    }],
  }]);
  const groups = timelineHelpers.groupTimeline(mapped, false);

  assert.deepEqual(mapped.map((item) => item.kind), ["reasoning", "assistant"]);
  assert.deepEqual(groups.map((group) => group.kind), ["reasoning", "item"]);
  assert.equal(groups[0].items[0].body, "The user is asking for a concise result. Keep it short.");
  assert.equal(groups[1].item.body, "I fixed the stale completion state.");
});

test("OpenCode tool history preserves the same provider-part identity as live snapshots", () => {
  const timeline = bridge.mapMessages([{
    id: "assistant-history",
    sessionId: "host/opencode/session",
    providerMessageId: "assistant_1",
    role: "assistant",
    createdAt: "2026-08-26T00:00:00.000Z",
    completedAt: "2026-08-26T00:00:01.000Z",
    status: "completed",
    nativeMetadata: {},
    parts: [{ type: "tool", providerPartId: "tool_part_1", name: "Run npm test", output: "12 tests passed", status: "completed" }],
  }]);

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].providerPartId, "tool_part_1");
  assert.equal(timeline[0].messageId, "assistant_1");
});

test("pasted files render as user attachment widgets without transport metadata", () => {
  const timeline = bridge.mapMessages([{
    id: "user-paste",
    sessionId: "host/codex/thread",
    providerMessageId: "provider-user-paste",
    role: "user",
    createdAt: "2026-08-24T16:10:25.000Z",
    completedAt: "2026-08-24T16:10:25.000Z",
    status: "completed",
    nativeMetadata: {},
    parts: [
      { type: "file", name: "Pasted text", mimeType: "text/plain" },
      { type: "text", text: "Build this experience from the attached brief." },
    ],
  }]);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.kind, "user");
  assert.equal(timeline[0]?.body, "Build this experience from the attached brief.");
  assert.deepEqual(timeline[0]?.files, [{ name: "Pasted text", mimeType: "text/plain" }]);
  assert.doesNotMatch(JSON.stringify(timeline), /Files pasted|attachments\\|C:\\\\Users/u);
});

test("history role mapping nests tool text and suppresses unrecognized system trace", async () => {
  const page = await bridge.loadSessionTimelinePage("role-mapping");

  assert.equal(page.nextCursor, "older-page");
  assert.deepEqual(page.items.map((item) => item.kind), ["assistant", "tool", "reasoning"]);
  assert.equal(page.items[0].messageId, "assistant-native");
  assert.equal(page.items[1].title, "Read");
  assert.equal(page.items[1].detail, "call-7");
  assert.equal(page.items[1].body, "A large raw tool result");
  assert.equal(page.items[2].title, "System");
  assert.equal(page.items[2].body, "Session compacted");
  assert.equal(page.items.some((item) => item.body.includes("Internal system trace")), false);
});

test("timeline image mapping admits safe remote and validated local raster references only", () => {
  assert.equal(bridge.renderableImageUri("https://images.example/safe.png"), "https://images.example/safe.png");
  assert.equal(bridge.renderableImageUri("http://localhost:8080/output.png"), "http://localhost:8080/output.png");
  assert.equal(bridge.renderableImageUri("http://127.0.0.1:8080/output.png"), "http://127.0.0.1:8080/output.png");
  assert.equal(bridge.renderableImageUri("http://[::1]:8080/output.png"), "http://[::1]:8080/output.png");
  assert.equal(bridge.renderableImageUri("http://images.example/unsafe.png"), undefined);
  assert.equal(bridge.renderableImageUri("http://localhost.example/unsafe.png"), undefined);
  assert.equal(bridge.renderableImageUri("http://127.0.0.1.example/unsafe.png"), undefined);
  assert.equal(bridge.renderableImageUri("C:\\Users\\test\\Pictures\\result.png"), "tethoq-media://local/C%3A%5CUsers%5Ctest%5CPictures%5Cresult.png");
  assert.equal(bridge.renderableImageUri("file:///C:/Users/test/Pictures/result%20two.webp"), "tethoq-media://local/C%3A%2FUsers%2Ftest%2FPictures%2Fresult%20two.webp");
  assert.equal(bridge.renderableImageUri("file:///C:/Users/test/Pictures/result.svg"), undefined);
  assert.equal(bridge.renderableImageUri("file://server/share/result.png"), undefined);
  assert.equal(bridge.renderableImageUri("relative.png"), undefined);
});

test("provider model catalogues load for every provider and never block the boot", async () => {
  // A provider not yet detected at snapshot time (the supervised OpenCode
  // server starts asynchronously) must still get its catalogue loaded, or the
  // model picker and the composer's reasoning choice stay empty.
  const models = await bridge.loadProviderModels([
    { id: "acme-agent", state: "online", detected: true },
    { id: "late-provider", state: "online", detected: false },
  ]);
  assert.equal(models["acme-agent"]?.length, 2);
  assert.equal(models["acme-agent"]?.[0]?.sourceProviderId, "synthetic");
  assert.equal(models["acme-agent"]?.[0]?.sourceProviderName, "Synthetic");
  assert.equal(models["late-provider"]?.length, 2, "a provider detected late must still get its catalogue");
  assert.equal(models["acme-agent"]?.[0]?.isDefault, undefined);
  assert.equal(models["acme-agent"]?.[1]?.isDefault, true);
  // Native context window and per-token pricing become renderer-facing facts;
  // absent provider data stays absent instead of defaulting to zero.
  assert.equal(models["acme-agent"]?.[0]?.contextWindowTokens, 128_000);
  assert.equal(models["acme-agent"]?.[0]?.inputPricePerMillion, 3);
  assert.equal(models["acme-agent"]?.[0]?.outputPricePerMillion, 15);
  assert.equal(models["acme-agent"]?.[1]?.contextWindowTokens, undefined);
  assert.equal(models["acme-agent"]?.[1]?.inputPricePerMillion, undefined);
  assert.equal(models["acme-agent"]?.[1]?.outputPricePerMillion, undefined);
});

test("renderer preserves the semantic realtime voice preview marker", () => {
  const mapped = bridge.mapSession({
    id: "host/codex/voice",
    hostId: "host",
    providerId: "codex",
    providerSessionId: "voice",
    title: "New Realtime Voice Chat",
    state: "idle",
    preview: "What folder are you in?",
    lastActivityAt: "2026-08-30T16:05:40.170Z",
    needsApproval: false,
    stale: false,
    nativeMetadata: { tethoqRealtimeVoice: true },
  });
  assert.equal(mapped?.preview, "What folder are you in?");
  assert.equal(mapped?.previewKind, "realtime_voice");
});

test("OpenCode parented user chats stay in the task list while explicit subagents stay hidden", async () => {
  const listed = await bridge.listSessions();
  assert.equal(listed.some((session) => session.id === "host/opencode/root-chat"), true);
  assert.equal(listed.some((session) => session.id === "host/opencode/spawned"), false);
  const mapped = listed.find((session) => session.id === "host/opencode/root-chat");
  assert.equal(mapped?.parentSessionId, "host/opencode/workspace");
  assert.equal(mapped?.providerId, "opencode");
  assert.equal(mapped?.childCount, 1, "the visible parent must carry the hidden child count");
  assert.deepEqual(mapped?.childProviderIds, ["opencode"], "session aggregation retains truthful child-provider metadata without repeating it in the generic trigger");
  assert.deepEqual(mapped?.providerStatus, { kind: "retry", message: "Provider is temporarily busy", retryAt: "2026-08-20T12:00:00.000Z" });
});

test("refresh retains an unknown child count without inventing zero children", async () => {
  const refreshed = await bridge.refreshSessions();
  assert.equal(refreshed.length, 2);
  assert.equal(refreshed.every((session) => session.childCount === undefined), true, "ordinary tasks must not reserve empty child chrome");
});

test("renderer accepts only the display-safe retry status contract", () => {
  assert.deepEqual(bridge.providerStatusValue({
    kind: "retry",
    message: "  Provider is temporarily busy  ",
    retryAt: "2026-08-20T12:00:00.000Z",
    requestId: "request-secret",
    attempt: 7,
  }), {
    kind: "retry",
    message: "Provider is temporarily busy",
    retryAt: "2026-08-20T12:00:00.000Z",
  });
  assert.equal(bridge.providerStatusValue({ kind: "retry", message: "   " }), undefined);
  assert.equal(bridge.providerStatusValue({ kind: "error", message: "failed" }), undefined);
});

test("delegated children retain safe display fields when their provider is missing", async () => {
  // Opening a cross-harness delegated child must never crash the mapping, and
  // the refresh merges must keep the child tracked so its workspace cannot
  // collapse to a blank pane when a refresh omits derived sessions.
  const children = await bridge.listChildSessions("external-session");
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.providerId, "missing-agent");
  assert.equal(child.parentSessionId, "external-session");
  assert.equal(child.relationshipKind, "subagent");
  assert.equal(child.agentNickname, "Acme delegate");
  assert.equal(child.agentRole, "cross_harness_delegate");
  // Fields a delegated child may not report fall back instead of crashing render.
  assert.equal(child.model, "CLI default");
  assert.equal(child.effort, "Default");
  assert.ok(child.title && child.preview && child.updatedAt && child.workingDirectory);
});

test("an echoed Grok user chunk renders live instead of waiting for a history reload", () => {
  const base = {
    sequence: 1,
    hostId: "desktop_test",
    providerId: "grok",
    sessionId: "session-1",
    occurredAt: "2026-08-17T00:00:00.000Z",
  };
  // Grok reports the prompt it accepted as message.started with role "user".
  const echo = bridge.eventToTimeline({
    ...base,
    eventId: "grok:user-1",
    type: "message.started",
    payload: { messageId: "user_0", role: "user", text: "Fix the streaming" },
  });

  assert.equal(echo.kind, "user");
  assert.equal(echo.body, "Fix the streaming");
  assert.equal(echo.streamDelta, true);
  assert.equal(echo.sourceEventId, "grok:user-1");

  // Codex local rollout records arrive as completed messages, not starts. The
  // role is still authoritative: this must never render with assistant identity.
  const completedEcho = bridge.eventToTimeline({
    ...base,
    providerId: "codex",
    eventId: "codex:user-completed",
    type: "message.completed",
    payload: { messageId: "user_1", role: "user", text: "Keep my role" },
  });
  assert.equal(completedEcho.kind, "user");
  assert.equal(completedEcho.body, "Keep my role");

  const annotationEnvelope = `\n# Response annotations:\nTransport instructions.\n<response-annotations>\n[{"text":"Final answer versus task complete","annotation":"What is the difference?"}]\n</response-annotations>\n\n## My request:\n`;
  const completedAnnotation = bridge.eventToTimeline({
    ...base,
    providerId: "codex",
    eventId: "codex:annotation-completed",
    type: "message.completed",
    payload: { messageId: "user_2", role: "user", text: annotationEnvelope },
  });
  assert.equal(completedAnnotation.kind, "user");
  assert.equal(completedAnnotation.body, "");
  assert.deepEqual(completedAnnotation.annotations.map(({ text, annotation }) => ({ text, annotation })), [
    { text: "Final answer versus task complete", annotation: "What is the difference?" },
  ]);

  // An assistant message.started is only a turn marker and must not draw a row.
  assert.equal(bridge.eventToTimeline({
    ...base,
    eventId: "grok:assistant-start",
    type: "message.started",
    payload: { messageId: "assistant_0", role: "assistant" },
  }), null);
});

test("verified cross-task sender attribution survives live echoes and history reconciliation", () => {
  const origin = {
    kind: "cross_session",
    envelopeId: "remote_verified",
    sourceSessionId: "desktop_test/codex/source-task",
    sourceTitle: "Final integration and verification",
  };
  const message = {
    id: "user-remote",
    providerMessageId: "user-remote",
    sessionId: "session-1",
    role: "user",
    createdAt: "2026-09-06T12:00:00.000Z",
    status: "completed",
    parts: [{ type: "text", text: "Please confirm the final build is ready." }],
    origin,
    nativeMetadata: {},
  };
  const history = bridge.mapMessages([message]);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].origin, origin);
  for (const type of ["message.started", "message.completed"]) {
    const echo = bridge.eventToTimeline({
      sequence: 1,
      hostId: "desktop_test",
      providerId: "codex",
      sessionId: "session-1",
      eventId: `cross-task:${type}`,
      occurredAt: message.createdAt,
      type,
      payload: { messageId: message.providerMessageId, role: "user", text: message.parts[0].text, origin },
    });
    assert.equal(echo.kind, "user");
    assert.equal(echo.body, message.parts[0].text);
    assert.deepEqual(echo.origin, origin);
    const merged = timelineMerge.reconcileTimelinePage(history, [echo]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].origin, origin);
  }
  const ordinary = bridge.mapMessages([{ ...message, origin: undefined }]);
  assert.equal(ordinary[0].origin, undefined);
  const invalid = bridge.mapMessages([{ ...message, origin: { ...origin, kind: "unverified" } }]);
  assert.equal(invalid[0].origin, undefined);
});

test("child status follows confirmed child lifecycle across parent cancellation and reload", () => {
  const interruptedAt = "2026-09-06T12:01:00.000Z";
  const task = {
    id: "delegation", parentSessionId: "parent", state: "failed", interruptedAt,
    createdAt: "2026-09-06T12:00:00.000Z", updatedAt: interruptedAt,
    children: [
      { id: "running", sessionId: "running", providerId: "grok", state: "working" },
      { id: "stopped", sessionId: "stopped", providerId: "codex", state: "idle", interruptedAt },
      { id: "idle", sessionId: "idle", providerId: "opencode", state: "idle" },
    ],
  };
  const rows = bridge.delegationTimelineItems([task]);
  assert.equal(rows[0].state, "running", "a failed parent cannot stop a running child in presentation");
  assert.equal(rows[0].childInterruptedAt, undefined);
  assert.equal(rows[1].state, "completed");
  assert.equal(rows[1].childInterruptedAt, interruptedAt);
  assert.equal(rows[2].childInterruptedAt, undefined, "parent cancellation alone does not prove the child was interrupted");
  assert.equal(bridge.delegationTimelineItems([{ ...task, state: "completed" }])[0].state, "running");
  assert.equal(timelineMerge.settleRunningTimeline(rows, "failed")[0].state, "running", "parent settlement must preserve independent child activity");

  const child = {
    id: "running", state: "idle", interruptedAt, updatedAt: interruptedAt,
    relationshipKind: "subagent", relationshipSourceSessionId: "parent",
  };
  const corrected = bridge.reconcileSubagentTimeline("parent", rows, [child]);
  assert.equal(corrected[0].state, "completed");
  assert.equal(corrected[0].childInterruptedAt, interruptedAt);
  assert.strictEqual(bridge.reconcileSubagentTimeline("parent", rows, [{ ...child, relationshipSourceSessionId: "other" }]), rows);
  const olderWorking = { ...child, state: "working", interruptedAt: undefined, updatedAt: "2026-09-06T12:00:30.000Z" };
  assert.strictEqual(bridge.reconcileSubagentTimeline("parent", corrected, [olderWorking]), corrected, "stale cached working must not revive the stopped child");
  const resumed = bridge.reconcileSubagentTimeline("parent", corrected, [{ ...olderWorking, updatedAt: "2026-09-06T12:02:00.000Z" }]);
  assert.equal(resumed[0].state, "running");
  assert.equal(resumed[0].childInterruptedAt, undefined);

  const beforeConfirmedStop = { ...rows[1], childInterruptedAt: undefined };
  const confirmed = timelineMerge.mergeTimeline([beforeConfirmedStop], rows[1]);
  assert.equal(confirmed[0].childInterruptedAt, interruptedAt, "an unchanged idle status still updates the stop reason");
  const mapped = bridge.mapSession({ id: "stopped", providerId: "codex", title: "Stopped child", state: "idle", lastActivityAt: interruptedAt, nativeMetadata: { tethoqInterruptedAt: interruptedAt } }, true);
  assert.equal(mapped.interruptedAt, interruptedAt);
});

test("an explicit interruption becomes one quiet terminal boundary", () => {
  const interrupted = bridge.eventToTimeline({
    sequence: 1,
    hostId: "desktop_test",
    providerId: "codex",
    sessionId: "session-1",
    eventId: "codex:interrupted",
    occurredAt: "2026-08-25T00:00:00.000Z",
    type: "agent.interrupted",
    payload: { turnId: "turn-1" },
  });

  assert.equal(interrupted.kind, "assistant");
  assert.equal(interrupted.title, "Task interrupted");
  assert.equal(interrupted.body, "Task interrupted");
  assert.equal(interrupted.state, "completed");
  assert.equal(interrupted.notice, "interruption");
  assert.equal(timelineHelpers.timelineBoundaryLabel(interrupted), "Task interrupted");
});

test("OpenCode saved Aborted errors reconcile with the live interruption without hiding actual failures", () => {
  const sessionId = "session-1";
  const live = bridge.eventToTimeline({ sessionId, providerId: "opencode", type: "agent.interrupted",
    eventId: "interrupted", occurredAt: "2026-09-09T00:00:02.000Z", payload: { turnId: "prompt-1" } });
  const message = { id: "opencode/answer", sessionId, providerMessageId: "answer", role: "assistant",
    createdAt: "2026-09-09T00:00:01.000Z", completedAt: "2026-09-09T00:00:02.000Z", status: "failed",
    nativeMetadata: { parentID: "prompt-1" }, parts: [{ type: "error", code: "MessageAbortedError", message: "Aborted" }] };
  const history = bridge.mapMessages([message]);
  const reconciled = timelineMerge.reconcileTimelinePage(history, [live]);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].notice, "interruption");
  assert.equal(timelineHelpers.groupTimeline(reconciled, false)[0].kind, "boundary");
  assert.equal(timelineMerge.mergeTimeline(history, live).length, 1, "history arriving first must also deduplicate");
  const unrelated = bridge.mapMessages([{ ...message, parts: [{ type: "error", code: "APIError", message: "Request aborted by upstream failure" }] }]);
  assert.equal(unrelated[0].kind, "error");
  assert.equal(unrelated[0].state, "failed");
  const codex = bridge.mapMessages([{ ...message, providerMessageId: "turn-aborted-turn-1", nativeMetadata: { turnId: "turn-1" },
    parts: [{ type: "error", code: "TURN_ABORTED", message: "Task interrupted" }] }]);
  assert.equal(codex[0].notice, "interruption", "native Codex interruption history must remain neutral too");
  assert.equal(codex[0].turnId, "turn-1");
  const second = bridge.eventToTimeline({ sessionId, providerId: "opencode", type: "agent.interrupted",
    eventId: "second-stop", occurredAt: "2026-09-09T00:00:03.000Z", payload: { turnId: "prompt-2" } });
  assert.equal(timelineMerge.mergeTimeline(reconciled, second).length, 2, "separate stopped turns remain separate");
});

test("streamed message deltas carry their event identity so a replay cannot duplicate text", () => {
  const base = {
    sequence: 4,
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-17T00:00:00.000Z",
  };
  const delta = bridge.eventToTimeline({ ...base, eventId: "oc:1", type: "message.delta", payload: { partId: "prt_1", messageId: "msg_1", text: "Hello", partType: "text" } });
  const reasoning = bridge.eventToTimeline({ ...base, sequence: 5, eventId: "oc:2", type: "message.delta", payload: { partId: "prt_2", messageId: "msg_1", text: "Thinking", partType: "reasoning" } });
  const completed = bridge.eventToTimeline({ ...base, sequence: 6, eventId: "oc:3", type: "message.completed", payload: { partId: "prt_1", messageId: "msg_1", text: "Hello world" } });

  assert.equal(delta.streamDelta, true);
  assert.equal(delta.sourceEventId, "oc:1");
  assert.equal(delta.providerPartId, "prt_1");
  // Two parts of one message stay two rows, so a later part cannot erase an earlier one.
  assert.notEqual(delta.id, reasoning.id);
  assert.equal(reasoning.kind, "reasoning");
  assert.equal(reasoning.providerPartId, "prt_2");
  assert.equal(delta.id, completed.id);
  assert.equal(completed.streamDelta, undefined);
});

test("only resumed assistant activity clears a provider retry", () => {
  const base = {
    sequence: 8,
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-20T10:00:00.000Z",
    type: "message.started",
  };
  assert.equal(bridge.eventClearsProviderStatus({ ...base, eventId: "oc:user", payload: { role: "user" } }), false);
  assert.equal(bridge.eventClearsProviderStatus({ ...base, eventId: "oc:user-info", payload: { info: { role: "user" } } }), false);
  assert.equal(bridge.eventClearsProviderStatus({ ...base, eventId: "oc:assistant-info", payload: { info: { role: "assistant" } } }), true);
});

test("nested provider part ids identify live rows before their shared message id", () => {
  const row = bridge.eventToTimeline({
    sequence: 7,
    eventId: "oc:nested",
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-20T10:00:00.000Z",
    type: "message.delta",
    payload: { messageId: "msg_shared", partType: "reasoning", part: { id: "prt_nested", text: "Nested thought" } },
  });

  assert.equal(row.providerPartId, "prt_nested");
  assert.equal(row.messageId, "msg_shared");
  assert.match(row.id, /prt_nested$/u);
});

test("file activity requires concrete evidence instead of fabricating File changed", () => {
  const base = {
    sequence: 1,
    eventId: "oc:file",
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-20T10:00:00.000Z",
    type: "file.changed",
  };

  assert.equal(bridge.eventToTimeline({ ...base, payload: {} }), null);
  assert.equal(bridge.eventToTimeline({ ...base, payload: { message: "File changed" } }), null);
  assert.equal(bridge.eventToTimeline({ ...base, payload: { summary: "Applied a patch successfully" } }), null);
  const named = bridge.eventToTimeline({ ...base, eventId: "oc:named-file", payload: { path: "src/controller.ts" } });
  assert.equal(named.kind, "file");
  assert.equal(named.title, "src/controller.ts");
  assert.equal(named.body, "src/controller.ts");
});

test("a replaced provider part overwrites its row instead of appending a second copy", () => {
  const base = {
    sequence: 9,
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-17T00:00:00.000Z",
  };
  const rewritten = bridge.eventToTimeline({
    ...base,
    eventId: "oc:replace",
    type: "message.delta",
    payload: { partId: "prt_9", messageId: "msg_9", text: "A different plan", partType: "reasoning", replace: true },
  });

  assert.equal(rewritten.body, "A different plan");
  // Still live, but the body is authoritative rather than an increment.
  assert.equal(rewritten.state, "running");
  assert.equal(rewritten.streamDelta, false);
});

test("a row keeps its part identity while still reporting the message it belongs to", () => {
  const base = {
    sequence: 1,
    hostId: "desktop_test",
    providerId: "opencode",
    sessionId: "session-1",
    occurredAt: "2026-08-17T00:00:00.000Z",
  };
  const first = bridge.eventToTimeline({ ...base, eventId: "oc:a", type: "message.delta", payload: { partId: "prt_a", messageId: "msg_1", text: "Thinking", partType: "reasoning" } });
  const second = bridge.eventToTimeline({ ...base, sequence: 2, eventId: "oc:b", type: "message.delta", payload: { partId: "prt_b", messageId: "msg_1", text: "Answering", partType: "text" } });

  // Distinct rows, so a later part cannot overwrite an earlier one...
  assert.notEqual(first.id, second.id);
  // ...but both report the one message, which is what turn grouping needs.
  assert.equal(first.messageId, "msg_1");
  assert.equal(second.messageId, "msg_1");
});
