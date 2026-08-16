import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-desktop-renderer-${process.pid}-${Date.now()}`);
const bridgeBundle = join(outputDirectory, "bridge.mjs");
const searchBundle = join(outputDirectory, "search-helpers.mjs");
await mkdir(outputDirectory, { recursive: true });

const calls = [];
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
      if (type === "sessions.refresh") return { ok: true, payload: { sessions: [{
        id: "external-session",
        providerId: "acme-agent",
        title: "External task",
        state: "idle",
        workingDirectory: "C:\\work",
        lastActivityAt: "2026-08-13T00:00:00.000Z",
        contextHandoffSummary: "Top-level handoff summary",
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
        { id: "first-model", providerId: "acme-agent", displayName: "First model", isDefault: false, nativeMetadata: {} },
        { id: "default-model", providerId: "acme-agent", displayName: "Default model", isDefault: true, nativeMetadata: {} },
      ] } };
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
        parts: [{ type: "text", text: "Context automatically compacted" }],
      }], nextCursor: "older-page" } };
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
  entryPoints: [join(appRoot, "src", "renderer", "src", "search_helpers.ts")],
  outfile: searchBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
const searchHelpers = await import(`file:///${searchBundle.replaceAll("\\", "/")}`);
const bridge = await import(`file:///${bridgeBundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

const source = async (path) => await readFile(join(appRoot, path), "utf8");

test("desktop search stays bounded to normalized in-memory UI metadata", async () => {
  assert.equal(searchHelpers.normalizeUiSearchQuery(" \u0000 ＤＥＦＡＵＬＴ\t ReAsoning "), "default reasoning");
  assert.equal(searchHelpers.normalizeUiSearchQuery("x".repeat(400)).length, 160);

  const [app, navigation] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
  ]);
  const palette = app.match(/function CommandPalette[\s\S]*?(?=\n\}\n\nexport default)/u)?.[0] ?? "";
  assert.match(app, /const settingsSearchCatalogue = \[/u);
  assert.match(app, /default model reasoning effort provider agent/u);
  // The palette indexes one pre-filtered list; internal, side-chat, and archived
  // records are excluded before it ever sees them.
  assert.match(app, /const activeSessions = useMemo\(\(\) => organizedSessions\.filter\(\(session\) => !session\.archived && session\.sessionKind !== "side_chat" && session\.sessionKind !== "internal"\)/u);
  assert.match(app, /<CommandPalette snapshot=\{snapshot\} sessions=\{activeSessions\}/u);
  assert.doesNotMatch(palette, /snapshot\.sessions/u);
  assert.match(palette, /maxLength=\{maximumUiSearchCharacters\}/u);
  assert.doesNotMatch(palette, /workingDirectory|window\.tethoqDesktop|request\(/u);
  assert.match(navigation, /maxLength=\{maximumUiSearchCharacters\}/u);
  assert.doesNotMatch(app.match(/const filteredSessions = useMemo[\s\S]*?\}, \[query/u)?.[0] ?? "", /workingDirectory/u);
});

test("settings expose only truthful model routes and independent compact cards", async () => {
  const [defaults, app, navigation, styles] = await Promise.all([
    source(join("src", "renderer", "src", "AgentDefaultsSettings.tsx")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);

  assert.match(defaults, /New tasks start here\. Existing tasks keep their latest choices\./u);
  assert.match(defaults, /model\.walletKind !== "user_api" \|\| model\.apiKeyConfigured === true/u);
  assert.match(defaults, /API key saved/u);
  assert.match(defaults, /through \$\{model\.source/u);
  assert.match(defaults, /<optgroup key=\{label\} label=\{label\}>/u);
  assert.doesNotMatch(defaults, /Managed by agent/u);
  assert.match(app, /API key required/u);
  assert.match(app, /API providers · keys saved/u);
  assert.doesNotMatch(app, /<small>v\{provider\.version\}<\/small>/u);
  assert.match(app, /const closeSettings = useCallback/u);
  assert.match(app, /className="settings-close-button"[^>]*aria-label="Close settings"[^>]*onClick=\{onClose\}/u);
  assert.match(navigation, /className="sidebar-settings"[^>]*aria-label=\{view === "settings" \? "Close settings" : "Open settings"\}/u);
  assert.doesNotMatch(navigation, /sidebar-settings \$\{view === "settings" \? "active"/u);
  assert.match(styles, /\.settings-close-button \{[^}]*position: sticky;[^}]*width: 32px;[^}]*height: 32px;/u);
  assert.match(styles, /\.settings-page::-webkit-scrollbar \{ width: 10px; \}/u);
  assert.match(styles, /\.settings-page::-webkit-scrollbar-thumb:hover \{ background: #8a8a83; \}/u);
  assert.match(styles, /\.settings-list\.provider-settings \{ overflow: visible; \}/u);
  assert.match(styles, /\.settings-compact-grid \{[^}]*align-items: start;/u);
});

test("initial renderer snapshot preserves dynamic providers and keyed input answers", async () => {
  calls.length = 0;
  const result = await bridge.loadInitialSnapshot();

  assert.deepEqual(calls.slice(0, 3).map((call) => call.type).sort(), [
    "approval.list",
    "sessions.refresh",
    "user_input.list",
  ]);
  assert.deepEqual(result.snapshot.inputRequests, [{
    id: "input-1",
    sessionId: "session-1",
    title: "Choose target",
    prompt: "Where should this deploy?",
    answerKey: "deployment_target",
    options: ["Staging", "Production"],
  }]);
  assert.equal(result.snapshot.providers[0].id, "acme-agent");
  assert.equal(result.snapshot.providers[0].supportsAttachments, true);
  assert.equal(result.snapshot.providers[0].iconDataUrl, "data:image/png;base64,AA==");
  assert.equal(result.snapshot.sessions[0].providerId, "acme-agent");
  assert.equal(result.snapshot.sessions[0].contextSummary, "Top-level handoff summary");
  assert.equal(result.snapshot.sessions[1].contextSummary, "Legacy metadata summary");
  assert.equal(result.snapshot.models["acme-agent"][0].isDefault, undefined);
  assert.equal(result.snapshot.models["acme-agent"][1].isDefault, true);
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

test("desktop context control applies a model-bounded threshold from the enlarged usage bar", async () => {
  const [app, styles] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);

  assert.match(app, />Set automatic compaction</);
  assert.match(app, /className="context-threshold-meter"/);
  assert.match(app, /className="context-expanded-track" role="progressbar"/);
  assert.match(app, /aria-label="Automatic compaction threshold" type="range"/);
  assert.match(app, /Math\.max\(minimum, Math\.min\(maximum, requestedThreshold\)\)/);
  assert.match(app, /session\.state === "working"/);
  assert.match(app, /session\.state === "needs_approval"/);
  assert.match(app, /Applying now may compact while this turn is still running\./);
  assert.match(app, /Sets how full this task can get before it compacts automatically\./);
  assert.match(app, /onClick=\{\(\) => void save\(safeThreshold, true\)\}/);
  assert.match(app, /\} Apply<\/Button>/);
  assert.match(app, /className="context-usage-tooltip"[^>]*><strong>Context window<\/strong><span>\{compactUsage\}<\/span>/);
  assert.match(app, /<section className="context-usage-details"/);
  assert.match(app, /<h3 id=\{`context-usage-details-/);
  assert.match(app, /<dt>Compacts at<\/dt>/);
  assert.match(app, /<dt>Capacity<\/dt>/);
  assert.doesNotMatch(app, /<details className="context-usage-details"|<summary>Usage details<\/summary>/);
  assert.doesNotMatch(app, /pendingImmediateThreshold|Compact this conversation now\?|Save threshold/);
  assert.doesNotMatch(app, /percent === null \? "—"/);
  assert.match(styles, /\.context-expanded-track \{[^}]*height: 8px/);
  assert.match(styles, /\.context-threshold-meter input\[type="range"\] \{[^}]*position: absolute/);
  assert.match(styles, /\.context-usage \{[^}]*transform: translateY\(2px\)/);
  assert.match(styles, /\.context-usage-tooltip \{[^}]*right: calc\(100% \+ 8px\)/);
  assert.match(styles, /\.context-usage-trigger \{[^}]*min-height: 28px[^}]*padding: 1px 3px 1px 9px/);
  assert.match(styles, /\.context-usage-popover \{[^}]*background-color: #181817[^}]*opacity: 1[^}]*backdrop-filter: none/);
});

test("task header exposes concise child-task details instead of a duplicate interrupt action", async () => {
  const [app, bridge, styles] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "bridge.ts")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);
  assert.match(app, /function TaskDetailsControl/);
  assert.match(app, />Sub-agents<\/h2>/);
  assert.match(app, /No sub-agents for this task\./);
  assert.match(app, /onOpenChild\(child\)/);
  assert.match(app, /<TaskDetailsControl session=\{session\}/);
  assert.doesNotMatch(app, /> Interrupt<\/Button>/);
  assert.match(bridge, /export async function listChildSessions\(sessionId: string\)[\s\S]*request\("session\.children"/);
  assert.match(styles, /\.task-details-popover \{[^}]*background-color: #181817[^}]*opacity: 1/);
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

  assert.equal(first.id, second.id);
  assert.equal(first.body, "Hello ");
  assert.equal(second.body, "from Grok");
  assert.equal(thought.kind, "reasoning");
  assert.equal(thought.body, "Checking files");
});

test("session history preserves renderer-safe inline image data", async () => {
  const timeline = await bridge.loadSessionTimeline("external-session");
  const image = timeline.find((item) => item.images?.length);
  assert.equal(image.kind, "user");
  assert.equal(image.body, "Inspect this");
  assert.equal(image.images[0].name, "screen.png");
  assert.equal(image.images[0].dataUrl, "data:image/png;base64,AQID");
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
  assert.equal(page.items[2].body, "Context automatically compacted");
  assert.equal(page.items.some((item) => item.body.includes("Internal system trace")), false);
});

test("large history images hydrate through bounded Bridge chunks", async () => {
  const rendererBridge = await source(join("src", "renderer", "src", "bridge.ts"));
  assert.match(rendererBridge, /request\("session\.image\.get", \{ sessionId, retrievalId, offset \}\)/);
  assert.match(rendererBridge, /maximumHistoryImageBytes\s*=\s*25 \* 1024 \* 1024/);
  assert.match(rendererBridge, /index < 64/);
  assert.match(rendererBridge, /hydrateHistoryImages\(sessionId, remoteMessages\(payload\.messages\)\)/);
});

test("timeline image mapping admits HTTPS and exact loopback HTTP URLs only", () => {
  assert.equal(bridge.renderableImageUri("https://images.example/safe.png"), "https://images.example/safe.png");
  assert.equal(bridge.renderableImageUri("http://localhost:8080/output.png"), "http://localhost:8080/output.png");
  assert.equal(bridge.renderableImageUri("http://127.0.0.1:8080/output.png"), "http://127.0.0.1:8080/output.png");
  assert.equal(bridge.renderableImageUri("http://[::1]:8080/output.png"), "http://[::1]:8080/output.png");
  assert.equal(bridge.renderableImageUri("http://images.example/unsafe.png"), undefined);
  assert.equal(bridge.renderableImageUri("http://localhost.example/unsafe.png"), undefined);
  assert.equal(bridge.renderableImageUri("http://127.0.0.1.example/unsafe.png"), undefined);
});

test("renderer source keeps initial and forced history loading wired", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  assert.match(app, /timelineWindows\[selectedSessionId\]\s*===\s*undefined[\s\S]*?openSession\(selectedSessionId\)/);
  assert.match(app, /const timelinePage = selected \? await loadSessionTimelinePage\(selected\)\.catch\(\(\) => null\) : null/);
  assert.match(app, /const hasPagedWindow = timelineWindows\[sessionId\] !== undefined/);
  assert.match(app, /alreadyLoaded !== undefined && hasPagedWindow && !force/);
  assert.match(app, /!sameSession[\s\S]*?initialTimelineRevealStart\(alreadyLoaded\)/);
  assert.match(app, /reconcileTimelinePage\(page\.items, current\.timelines\[sessionId\] \?\? \[\]\)/);
  assert.match(app, /const visibleTimeline = timelineWindow \? timeline\?\.slice\(timelineWindow\.revealStart\) : undefined/);
  assert.doesNotMatch(app, /loadSessionTimeline\(/);
});

test("task history opens on the recent assistant tail and pages upward without jumping", async () => {
  const [app, rendererBridge] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "bridge.ts")),
  ]);
  assert.match(rendererBridge, /loadSessionTimelinePage\(sessionId: string, cursor\?: string, limit = 40, refresh = false\)/);
  assert.match(rendererBridge, /nextCursor: typeof payload\.nextCursor === "string" \? payload\.nextCursor : null/);
  assert.match(app, /initialTimelineRevealStart\(items: readonly TimelineItem\[\], assistantCount = 3\)/);
  assert.match(app, /const messageId = item\.messageId \?\? item\.id/);
  assert.match(app, /loadSessionTimelinePage\(selected\)\.then\(\(page\)/);
  assert.match(app, /\[selected\]: \{ nextCursor: page\.nextCursor, revealStart: initialTimelineRevealStart\(page\.items\), loadingOlder: false \}/);
  assert.match(app, /if \(element\.scrollTop < 48\) void loadOlder\(\)/);
  assert.match(app, /current\.scrollTop = previousTop \+ Math\.max\(0, current\.scrollHeight - previousHeight\)/);
});

test("renderer source reconciles live provider, session, and attention events", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  assert.match(app, /provider\.connected[\s\S]*?provider\.disconnected[\s\S]*?refreshProvidersNeeded\s*=\s*true/);
  assert.match(app, /session\.created[\s\S]*?session\.updated[\s\S]*?refreshSessionsNeeded\s*=\s*true/);
  assert.match(app, /approval\.requested[\s\S]*?approval\.resolved[\s\S]*?user_input\.requested[\s\S]*?refreshAttentionNeeded\s*=\s*true/);
  assert.match(app, /let refreshSessionsNeeded\s*=\s*batch\.replayGap/);
  assert.match(app, /void refreshAll\(false\)/);
});

test("renderer source submits keyed input answers and chunked attachment ids", async () => {
  const [app, composer, helpers] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "composer_helpers.ts")),
  ]);

  assert.match(app, /user_input\.respond[\s\S]*?answers:\s*\{\s*\[input\.answerKey\]:\s*\[answer\]\s*\}/);
  assert.match(helpers, /attachment\.upload\.begin[\s\S]*?attachment\.upload\.chunk[\s\S]*?attachment\.upload\.complete/);
  assert.match(helpers, /onUploadStarted\(uploadId\)/);
  assert.match(composer, /attachmentIds\.length \? \{ attachmentIds: \[\.\.\.attachmentIds\] \} : \{\}/);
  assert.match(composer, /pendingUploadIds\.map\(\(uploadId\) => request\("attachment\.upload\.cancel"/);
});

test("composer resets per task and gates attachment support from provider metadata", async () => {
  const [app, composer, rendererBridge] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "bridge.ts")),
  ]);

  assert.match(app, /<Composer\s+key=\{session\.id\}/);
  assert.match(app, /composerAttachments[\s\S]*?Record<string, readonly ComposerAttachment\[\]>/);
  assert.match(app, /initialAttachments=\{composerAttachments\[selectedSession\?\.id \?\? ""\] \?\? \[\]\}/);
  assert.match(app, /onAttachmentsChange=\{\(attachments\) =>/);
  assert.match(composer, /provider\?\.supportsAttachments === true/);
  assert.match(composer, /useState<readonly ComposerAttachment\[\]>\(\(\) => initialAttachments\)/);
  assert.match(composer, /attachmentsChangeRef\.current\?\.\(attachments\)/);
  assert.match(composer, /disabled=\{!canAttach\}/);
  assert.match(rendererBridge, /builtInImageEntryProviders[^;]+"direct"/);
});

test("renderer sources keep providers generic and data-driven", async () => {
  const [app, bridge, components, types] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "bridge.ts")),
    source(join("src", "renderer", "src", "components.tsx")),
    source(join("src", "renderer", "src", "types.ts")),
  ]);

  assert.doesNotMatch(bridge, /allowedProviderIds/);
  assert.match(types, /export type ProviderId = string/);
  assert.match(types, /models: Record<string, ModelOption\[\]>/);
  assert.match(app, /providers\.map\(\(provider\)/);
  assert.match(components, /providerInitials/);
  assert.doesNotMatch(`${app}\n${bridge}\n${components}`, /Claude/i);
});

test("browser preview and release QA exercise dynamic connector models through local drafts", async () => {
  const [app, demo, visualQa, packagedSmoke] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "demo.ts")),
    source(join("scripts", "visual-qa.cjs")),
    source(join("scripts", "packaged-smoke.cjs")),
  ]);

  assert.match(app, /data-connector-id=\{connector\.id\}/);
  assert.match(app, /connector\.permissions\.filesystem/);
  assert.match(app, /connector\.permissions\.network/);
  assert.match(app, /connector\.permissions\.spawnProcesses/);
  assert.match(app, /connector\.capabilities\.attachments/);
  assert.match(app, /connector\.capabilities\.reasoningEfforts/);
  assert.match(app, /connector\.capabilities\.messageQueue/);
  assert.match(app, /This connector will run executable code on your computer/);
  assert.match(app, /permission declarations are informational, not an operating-system sandbox/);
  assert.match(app, /provider's terms/);
  assert.match(app, /Credentials must stay with the provider's local tool or this connector/);
  assert.match(app, /Enable after restart/);
  assert.match(app, /Disabled now\. Restart Tethoq to complete cleanup\./);
  assert.match(app, /providers\.filter\(\(provider\) => !removedIds\.has\(provider\.id\)\)/);
  assert.match(app, /delete models\[providerId\]/);
  assert.match(demo, /id: "tethoq-example"/);
  assert.match(demo, /name: "Tethoq Example Reasoning"/);
  assert.match(demo, /export const demoBootstrap: DesktopBootstrap/);
  assert.match(visualQa, /settings-connectors-1440x900/);
  assert.match(visualQa, /new-task-1100x760[^\n]*kind: 'new-task-draft'/);
  assert.match(visualQa, /new-task-minimum-760x480[^\n]*kind: 'new-task-draft'/);
  assert.match(visualQa, /workspace \.workspace-location\.draft-location/);
  assert.match(visualQa, /model-picker-dropup \[data-provider-group="tethoq-example"\]/);
  assert.match(visualQa, /modalCount: document\.querySelectorAll\('\.modal'\)\.length/);
  assert.match(visualQa, /layout\.newTaskDraft\.modalCount, 0/);
  assert.match(visualQa, /layout\.newTaskDraft\.modelPicker\?\.visible, true/);
  assert.match(visualQa, /layout\.newTaskDraft\.directoryControl\?\.visible, true/);
  assert.match(visualQa, /layout\.newTaskDraft\.pickerCheck\?\.selectedConnectorModel/);
  assert.match(visualQa, /\['model picker', layout\.newTaskDraft\.modelPicker\], \['directory', layout\.newTaskDraft\.directoryControl\]/);
  assert.match(visualQa, /draft \$\{name\} control is outside the visible viewport/);
  assert.match(visualQa, /document\.querySelector\('\.sidebar-tasks'\)/);
  assert.doesNotMatch(visualQa, /new-session-form|session-list-panel|workflow-settings-card|\.modal\[aria-label="Start a new task"\]/);

  assert.match(packagedSmoke, /task-filter-popover \.provider-options button/);
  assert.match(packagedSmoke, /pending connector local draft/);
  assert.match(packagedSmoke, /model-picker-dropup \[data-provider-group="community\.echo"\]/);
  assert.match(packagedSmoke, /picker\.modelOptions, \['Echo Fast', 'Echo Careful'\]/);
  assert.match(packagedSmoke, /selectedModel === 'Echo Fast'/);
  assert.match(packagedSmoke, /draftSelection\.sendDisabled, true/);
  assert.doesNotMatch(packagedSmoke, /new-session-form|\.harness-grid/);
  const approvedDraftStart = packagedSmoke.indexOf("'approved connector local draft'");
  const directEchoStart = packagedSmoke.indexOf("const created = await bridgeRequest('session.create'", approvedDraftStart);
  assert.ok(approvedDraftStart >= 0 && directEchoStart > approvedDraftStart);
  assert.doesNotMatch(packagedSmoke.slice(approvedDraftStart, directEchoStart), /bridgeRequest\('session\.(?:create|send_message)'/);
  assert.match(packagedSmoke.slice(directEchoStart), /bridgeRequest\('session\.send_message'[\s\S]*?Echo: packaged streaming/);
  assert.doesNotMatch(`${app}\n${demo}\n${visualQa}`, /Claude/i);
});

test("attention-blocked sessions queue follow-up messages", async () => {
  const composer = await source(join("src", "renderer", "src", "Composer.tsx"));

  assert.match(composer, /session\.state === "working" \|\| session\.state === "needs_approval" \|\| session\.state === "needs_input"/);
  assert.match(composer, /const requestType = liveGuidance \? "session\.steer_message" : attachments\.length \|\| \(blockedByAttention && queueingEnabled\) \? "message_queue\.enqueue" : "session\.send_message"/);
});

test("workflow recorder progress refreshes live counts and pauses its lone timer while hidden", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  assert.match(app, /event\.type === "progress"[\s\S]*?setRecorder\(\(current\) => \(\{ \.\.\.current, phase: "recording", active: event\.recording \}\)\)/);
  assert.match(app, /event\.type === "state"[\s\S]*?setRecorder\(event\.state\)/);
  const recordingBar = app.match(/function RecordingBar[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(recordingBar, /window\.setInterval\(update, 1_000\)/);
  assert.match(recordingBar, /document\.hidden \? stop\(\) : start\(\)/);
  assert.match(recordingBar, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
  assert.match(recordingBar, /document\.removeEventListener\("visibilitychange", onVisibilityChange\)/);
  assert.doesNotMatch(app.slice(0, app.indexOf("function RecordingBar")), /setInterval\([^)]*setNow/);
});

test("browser chrome exposes live download management and Ctrl L address focus", async () => {
  const [app, main] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "main", "index.ts")),
  ]);

  assert.match(app, /notice\.action === "focus-address"[\s\S]*?setBrowserAddressFocusToken/);
  assert.match(app, /addressInput\.current\?\.focus\(\)[\s\S]*?addressInput\.current\?\.select\(\)/);
  assert.match(main, /notice\.type === "focus-address"\) window\.webContents\.focus\(\)/);
  assert.match(app, /type: "clear-download-history"/);
  assert.match(app, /action: download\.paused \? "resume" : "pause"/);
  assert.match(app, /action: "cancel"/);
  assert.match(app, /download\.savePath[\s\S]*?revealPath/);
  assert.match(app, /browser-download-progress/);
  assert.match(app, /browser-download-popover/);
  assert.match(app, /aria-haspopup="dialog"/);
  assert.match(app, /role="dialog" aria-modal="false" aria-label="Downloads"/);
  assert.match(app, /role="progressbar"/);
  assert.match(app, /aria-valuenow=\{progress\}/);
  assert.match(app, /downloads\.some\(\(item\) => item\.state === "progressing"\) \? <span>/);
  assert.match(app, /disabled=\{!isBrowserPreview && current\?\.visible !== true\}/);
  assert.match(app, /document\.addEventListener\("pointerdown", closeOnOutsideClick\)/);
  assert.match(app, /event\.key !== "Escape"/);
  assert.match(app, /type: "open-overlay"/);
  assert.match(app, /type: "close-overlay"/);
  assert.match(app, /browser-freeze-frame/);
  const visualQa = await source(join("scripts", "visual-qa.cjs"));
  assert.match(visualQa, /browser-downloads-1440x900/);
  assert.match(visualQa, /browser-downloads-minimum-980x680/);
  assert.match(visualQa, /browser-download-panel \.browser-download-progress/);
  assert.match(visualQa, /opening downloads shifted the browser viewport/);
  const packagedSmoke = await source(join("scripts", "packaged-smoke.cjs"));
  assert.match(packagedSmoke, /exerciseBrowserDownloadPopover/);
  assert.match(packagedSmoke, /browserCompactDownloadPopover: true/);
  assert.match(packagedSmoke, /Unapproved connector code executed before review/);
  assert.match(packagedSmoke, /connectorAction[\s\S]*?type: 'approve'/);
  assert.match(packagedSmoke, /approval\.restartRequired/);
  assert.match(packagedSmoke, /await quitPackagedApp\(\)[\s\S]*?await launchPackagedApp\(\)/);
});

test("desktop navigation keeps browser and workflow complexity session-scoped", async () => {
  const [app, navigation, composer, workflows, components, visualQa, packagedSmoke] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "WorkflowSettings.tsx")),
    source(join("src", "renderer", "src", "components.tsx")),
    source(join("scripts", "visual-qa.cjs")),
    source(join("scripts", "packaged-smoke.cjs")),
  ]);

  assert.doesNotMatch(navigation, />Browser<|>Workflows</);
  assert.match(composer, /Open session browser/);
  assert.match(composer, /Manage workflows/);
  assert.match(composer, /onManageWorkflow\(attachment\.id\)/);
  assert.match(app, /onBrowser=\{\(\) => setView\("browser"\)\}/);
  assert.match(app, /setSelectedWorkflowId\(id \?\? null\); openSettings\(\)/);
  assert.match(workflows, /workflow-detail-timing/);
  assert.match(workflows, /workflow-capture-metrics/);
  assert.match(workflows, /Captured apps/);
  assert.match(components, /state !== "idle" && state !== "working"/);
  assert.match(visualQa, /Open session browser/);
  assert.match(visualQa, /Manage workflows/);
  assert.match(packagedSmoke, /Open session browser/);
  assert.doesNotMatch(packagedSmoke, /primary-nav button[^\n]*Browser/);
});

test("startup loading state uses readable type and plain local-connection copy", async () => {
  const [app, components, styles] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "components.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);

  assert.match(components, /Connecting to your coding tools on this computer…/);
  assert.doesNotMatch(components, /local Tethoq runtime/);
  assert.match(styles, /\.loading-state strong[^{]*\{[^}]*font-size:\s*15px;[^}]*line-height:\s*1\.3/);
  assert.match(styles, /\.loading-state small[^{]*\{[^}]*color:\s*#969b96;[^}]*font-size:\s*12\.5px;[^}]*line-height:\s*1\.45/);
  assert.match(app, /const page = await loadSessionTimelinePage\(first\.id\);[\s\S]*setSnapshot\(initialSnapshot\)/);
  assert.match(styles, /\.app-loading \{ position:\s*fixed; inset:\s*0;[\s\S]*place-items:\s*center/);
  assert.match(styles, /@keyframes app-shell-enter[\s\S]*\.desktop-app[^{]*\{[^}]*animation:\s*app-shell-enter \.14s ease-out both/);
});

test("merged sidebar task search and composable agent filters stay compact", async () => {
  const [navigation, styles, app] = await Promise.all([
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "navigation.css")),
    source(join("src", "renderer", "src", "App.tsx")),
  ]);

  assert.match(navigation, /className="sidebar-task-search"/);
  assert.match(navigation, /data-expanded=\{searchExpanded\}/);
  assert.match(navigation, /const searchExpanded = searchOpen \|\| Boolean\(query\)/);
  assert.doesNotMatch(navigation, /searchOpen \|\| Boolean\(query\) \|\| filtersOpen/);
  assert.match(navigation, /const openTaskSearch = \(\) => \{[\s\S]*?setSearchOpen\(true\);[\s\S]*?requestAnimationFrame\(\(\) => searchInput\.current\?\.focus\(\)\)/);
  assert.match(navigation, /onClick=\{openTaskSearch\}/);
  assert.match(navigation, /searchInput\.current\?\.focus\(\)/);
  assert.match(navigation, /<header className="sidebar-task-header">[\s\S]*?<h2>Tasks<\/h2>[\s\S]*?<div className="sidebar-task-tools"[\s\S]*?<button type="button" onClick=\{onNewTask\}/);
  assert.match(navigation, /<\/div>\s*<button ref=\{filterButton\} type="button" className=\{filtersOpen \|\| activeFilterCount \? "sidebar-task-filter active" : "sidebar-task-filter"\}/);
  assert.doesNotMatch(navigation, /className="sidebar-task-search"[^]*className=\{filtersOpen \|\| activeFilterCount \? "filter-toggle/);
  assert.match(navigation, /className="task-filter-popover"/);
  assert.match(navigation, />Agent</);
  assert.match(navigation, /All agents/);
  assert.match(navigation, /Available agents/);
  assert.match(navigation, /Status/);
  assert.match(navigation, /title=\{location\}/);
  assert.match(navigation, /onContextMenu=\{onContextMenu\}/);
  assert.match(navigation, /event\.preventDefault\(\)/);
  assert.match(navigation, /className="session-context-menu" role="menu"/);
  assert.match(navigation, /role="menuitem" disabled=\{!sessionMenu\.workingDirectory\}/);
  assert.match(navigation, />Open in File Explorer</);
  assert.match(navigation, /if \(path\) onOpenDirectory\(path\)/);
  assert.doesNotMatch(navigation, /onOpenDirectory\(sessionMenu\.title|onOpenDirectory\(session\.project/);
  assert.match(app, /onOpenDirectory=\{openSessionDirectory\}/);
  assert.match(app, /window\.tethoqDesktop\.openLocalTarget\(\{ path, handlerId: "system" \}\)/);
  assert.match(navigation, /chooseProvider = \(value: ProviderFilter\) => \{ onProvider\(value\); setFiltersOpen\(false\); \}/);
  assert.match(navigation, /toggleProvider = \(value: ProviderId\)/);
  assert.match(navigation, /role="checkbox" aria-checked=\{isIncluded\}/);
  assert.match(navigation, /onClick=\{\(\) => toggleProvider\(option\.id\)\}/);
  assert.match(navigation, /available: provider\.detected/);
  assert.match(app, /availableProviders = new Set\(snapshot\.providers\.filter\(\(provider\) => provider\.detected\)/);
  assert.match(app, /providerFilters\.some\(\(providerId\) => providerId === "available" \? availableProviders\.has\(session\.providerId\) : session\.providerId === providerId\)/);
  assert.match(navigation, /chooseState = \(value: SessionFilter\) => \{ onFilter\(value\); setFiltersOpen\(false\); \}/);
  assert.doesNotMatch(navigation, /task-state-dot task-state-|className="task-state-slot"/);
  assert.doesNotMatch(navigation, /Refresh tasks|Provider diagnostics|All states|>Filtered<|<Status|session-list-collapse|quiet-refresh/);
  assert.match(styles, /\.sidebar-task-search \{[\s\S]*?width: 34px/);
  assert.match(styles, /\.sidebar-task-search\[data-expanded="true"\] \{[\s\S]*?width: auto;[\s\S]*?flex: 1 1 auto/);
  assert.doesNotMatch(styles, /\.sidebar-task-search:(?:hover|focus-within),/);
  assert.match(styles, /transition: none/);
  assert.match(styles, /\.sidebar-task-filter \{[\s\S]*?width: 31px;[\s\S]*?height: 31px;[\s\S]*?margin-left: auto/);
  assert.match(styles, /\.sidebar-task-tools \{[\s\S]*?align-items: center;[\s\S]*?gap: 6px/);
  assert.match(styles, /\.provider-filter-checkbox\[aria-checked="true"\]/);
  assert.match(styles, /\.provider-filter-option\.unavailable \{ opacity: \.3/);
  assert.match(styles, /\.session-row-top strong \{ font-size: 12\.5px/);
  assert.match(navigation, /className="session-row-trailing"/);
  // Pin and time occupy the same reserved trailing slot, so neither shifts the row.
  assert.match(navigation, /<span className="session-row-trailing">\{session\.pinned \? <PinIcon className="session-row-pin" \/> : null\}<time>\{relativeTime\(session\.updatedAt\)\}<\/time><\/span>\s*\{session\.state === "working" \? <i className="session-row-working-spinner"/);
  assert.doesNotMatch(navigation, /session-row-state-/);
  assert.match(navigation, /aria-current=\{selected \? "page" : undefined\}/);
  assert.match(styles, /\.session-row \{ min-height: 66px; grid-template-columns: 36px minmax\(0, 1fr\) 32px;[\s\S]*?align-content: center;[\s\S]*?row-gap: 3px/);
  assert.doesNotMatch(styles, /\.session-row:hover,[\s\S]*?grid-template-columns/);
  assert.match(styles, /\.session-row-top \{ display: contents; \}/);
  assert.match(styles, /\.session-row-top \.provider-logo \{[^}]*grid-row: 1 \/ span 2;[^}]*align-self: center;[^}]*transform: translate\(-5px, -10px\)/);
  assert.match(navigation, /<ProviderLogo providerId=\{session\.providerId\} provider=\{provider\} size=\{36\}\/>/);
  assert.match(styles, /\.session-row-trailing \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);[\s\S]*?gap: 0/);
  assert.match(styles, /\.session-row-working-spinner \{[^}]*width: 12px;[^}]*height: 12px;[^}]*grid-column: 1;[^}]*grid-row: 2;[^}]*align-self: end;[^}]*justify-self: center;[^}]*translate: -5px 0;[^}]*border-right-color:\s*transparent;[^}]*animation:\s*spin/);
  assert.match(styles, /\.session-row-top time \{[\s\S]*?font-size: 11\.5px;[\s\S]*?opacity: 0;[\s\S]*?transform: translateY\(2px\)/);
  assert.match(styles, /\.session-row:hover \.session-row-top time,[\s\S]*?\.session-row:focus-visible \.session-row-top time,[\s\S]*?\.session-row\.selected \.session-row-top time \{ opacity: 1; \}/);
  assert.match(navigation, /<OverflowReveal axis="horizontal" className="session-row-title">/);
  assert.match(navigation, /<OverflowReveal axis="vertical" className="session-row-preview">/);
  assert.match(navigation, /const pixelsPerSecond = axis === "vertical" \? 18 : 28/);
  assert.match(navigation, /const duration = distance \/ pixelsPerSecond/);
  assert.match(navigation, /"--overflow-duration": `\$\{duration\.toFixed\(2\)\}s`/);
  assert.match(styles, /\.overflow-reveal-horizontal\[data-overflow="true"\][\s\S]*mask-image:[^;]*transparent 100%/);
  assert.match(styles, /\.session-row-title \{[^}]*margin-left: -6px/);
  assert.match(styles, /\.session-row-preview \{[^}]*margin-left: -6px/);
  assert.match(styles, /\.overflow-reveal-vertical\[data-overflow="true"\][^}]*calc\(100% - 3px\)[^}]*rgba\(0,0,0,\.72\) 100%/);
  assert.match(styles, /\.overflow-reveal-horizontal\[data-overflow="true"\]:hover > span[\s\S]*translateX/);
  assert.match(styles, /\.session-row:hover \.overflow-reveal-vertical\[data-overflow="true"\] > span[\s\S]*translateY/);
  assert.match(styles, /transition: transform var\(--overflow-duration\) linear \.55s/);
  assert.match(styles, /\.session-list-scroll \{[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
  assert.match(styles, /\.session-row-preview \{[^}]*grid-column: 2 \/ -1/);
  assert.match(styles, /\.session-row-meta \{[\s\S]*?position: absolute;[\s\S]*?clip-path: inset\(50%\)/);
  assert.match(styles, /\.session-list-scroll \{[\s\S]*?margin-right: -8px;[\s\S]*?scrollbar-gutter: stable/);
  assert.match(styles, /\.session-list-scroll \{[\s\S]*?padding: 1px 0 8px/);
  assert.match(styles, /\.session-list-scroll::-webkit-scrollbar \{ width: 10px; \}/);
  assert.match(styles, /\.session-list-scroll::-webkit-scrollbar-thumb:hover \{ background: #8a8a83; \}/);
  assert.match(styles, /font-variant-numeric: tabular-nums/);
  assert.match(styles, /\.session-row-top time \{[\s\S]*?font-size: 11\.5px/);
  assert.match(styles, /\.session-row\.selected \{[\s\S]*?box-shadow: none/);
  assert.match(styles, /\.session-context-menu \{[\s\S]*?position: fixed/);
  assert.doesNotMatch(styles, /\.task-state-working \{|\.provider-options > button i/);
});

test("sidebar owns the task list in one resizable navigation column", async () => {
  const [navigation, styles, app] = await Promise.all([
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "navigation.css")),
    source(join("src", "renderer", "src", "App.tsx")),
  ]);

  assert.match(navigation, /export interface SidebarProps/);
  assert.match(navigation, /className="sidebar-tasks"/);
  assert.match(navigation, /className="sidebar-task-header"/);
  assert.match(navigation, /onClick=\{onNewTask\}/);
  assert.match(navigation, /onCommandSearch: \(\) => void/);
  assert.match(navigation, /className="sidebar-command-search"/);
  assert.match(navigation, /data-tooltip="Commands · Ctrl K"/);
  assert.match(navigation, />Dashboard</);
  assert.match(navigation, /className="sidebar-footer"/);
  assert.match(navigation, /sidebar-runtime-indicator/);
  assert.match(styles, /\.sidebar-footer \{[^}]*margin-right: -8px;[^}]*margin-left: -5px;[^}]*padding: 7px 8px 0 5px;[^}]*border-top: 1px solid/);
  assert.match(styles, /\.sidebar-footer \.sidebar-settings \{[^}]*padding: 0 27px 0 7px/);
  assert.doesNotMatch(navigation, />Agents<|sidebar-section|provider-nav|export function SessionList|session-list-new|Start a new task|<TerminalIcon|<kbd>Ctrl N/);
  assert.match(styles, /:root \{ --navigation-panel: 248px; \}/);
  assert.match(styles, /\.app-body,[\s\S]*?grid-template-columns: var\(--navigation-panel\) minmax\(400px, 1fr\)/);
  assert.match(styles, /\.new-task-row \.new-task-button \{[\s\S]*?font-size: 13px/);
  assert.match(styles, /\.new-task-row \.new-task-button \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 17px minmax\(0, 1fr\) 17px/);
  assert.match(styles, /\.new-task-row \.new-task-button span \{ grid-column: 2; justify-self: center; \}/);
  assert.match(styles, /\.new-task-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 38px/);
  assert.match(styles, /\.new-task-row \.new-task-button \{[\s\S]*?min-height: 38px/);
  assert.match(styles, /\.sidebar-command-search \{[\s\S]*?width: 38px;[\s\S]*?height: 38px/);
  assert.match(styles, /\.primary-nav \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 38px/);
  assert.match(styles, /\.primary-nav button \{[\s\S]*?width: 100%;[\s\S]*?min-height: 38px/);
  assert.match(styles, /\.primary-nav button \{[^}]*display: grid;[^}]*grid-template-columns: 18px minmax\(0, 1fr\) 18px/);
  assert.match(styles, /\.primary-nav button span \{ grid-column: 2; justify-self: center; \}/);
  assert.match(styles, /\.sidebar \{[\s\S]*?padding-left: 5px/);
  assert.match(styles, /--navigation-panel: 232px/);
  assert.match(styles, /--navigation-panel: 270px/);
  assert.match(styles, /\.primary-nav button \{[\s\S]*?font-size: 12\.5px/);
  assert.match(app, /navigationPanelStorageKey = "tethoq\.navigation-panel-width"/);
  assert.match(app, /clampNavigationPanelWidth\(startWidth \+ moveEvent\.clientX - startX, window\.innerWidth\)/);
  assert.match(app, /role="separator"[\s\S]*?aria-label="Resize task list"[\s\S]*?aria-orientation="vertical"/);
  assert.match(app, /onPointerDown=\{beginSidebarResize\}/);
  assert.match(app, /onKeyDown=\{resizeSidebarWithKeyboard\}/);
  assert.match(app, /"--navigation-panel": `\$\{navigationPanelWidth\}px`/);
  assert.match(styles, /\.navigation-resize-handle \{[\s\S]*?left: calc\(var\(--navigation-panel\) - 5px\);[\s\S]*?width: 10px;[\s\S]*?cursor: col-resize/);
  assert.match(styles, /\.sidebar-resizing, \.sidebar-resizing \* \{ cursor: col-resize !important; user-select: none !important; \}/);
});

test("new task opens a local draft and materializes it once from the composer", async () => {
  const [app, composer, types] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "types.ts")),
  ]);

  assert.match(types, /draft\?: boolean/);
  assert.match(app, /const startDraftTask = useCallback/);
  assert.match(app, /draft: true/);
  assert.match(app, /const localOnly = current\.sessions\.filter\(\(session\) => \(session\.draft \|\| session\.sessionKind === "side_chat"\) && !refreshedIds\.has\(session\.id\)\)/);
  assert.match(app, /sessions: \[\.\.\.localOnly, \.\.\.sessions\]/);
  assert.doesNotMatch(app, /function NewSessionModal|<NewSessionModal/);
  assert.match(app, /const createDraftSend = useCallback/);
  assert.match(app, /const separatedFirstTurn = input\.attachmentIds\.length > 0 \|\| input\.workflowIds\.length > 0/);
  assert.match(app, /\.\.\.\(separatedFirstTurn \? \{\} : \{ firstInstruction: input\.content \}\)/);
  assert.match(app, /await request\("session\.send_message"/);
  assert.match(app, /input\.workflowIds\.length \? \{ workflowIds: \[\.\.\.input\.workflowIds\] \} : \{\}/);
  assert.match(app, /input\.workflows\.length \? \{ workflows: input\.workflows \} : \{\}/);
  assert.match(app, /Choose a project folder before starting this task/);
  assert.match(app, /onDraftSelectionChange=\{onDraftSelectionChange\}/);
  assert.match(app, /onCreateDraftSend=\{onCreateDraftSend\}/);
  assert.match(composer, /if \(draftSession\)[\s\S]*?await onCreateDraftSend/);
});

test("workspace keeps repeated path metadata hidden until intent", async () => {
  const [app, styles] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);

  assert.match(app, /className=\{`workspace-location \$\{session\.draft \? "draft-location" : ""\}`\}/);
  assert.match(app, /session\.draft \? "Choose the project folder" : session\.workingDirectory \|\| session\.project/);
  assert.match(styles, /\.workspace-location \{ opacity: 0/);
  assert.match(styles, /\.workspace-header:hover \.workspace-location/);
  assert.match(styles, /\.workspace-title:not\(:has\(\.draft-location\)\) \{[^}]*align-self: stretch;[^}]*align-items: center/);
  assert.match(styles, /\.workspace-title:not\(:has\(\.draft-location\)\) > button \{[^}]*position: absolute/);
  assert.match(styles, /\.workspace-title \.status \{ transform: translateY\(1px\)/);
  assert.doesNotMatch(styles, /\.context-strip/);
});

test("desktop wallet UI exposes direct-key safety, local budgets, and custom endpoints", async () => {
  const [app, bridge, styles, icons] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "bridge.ts")),
    source(join("src", "renderer", "src", "styles.css")),
    source(join("src", "renderer", "src", "icons.tsx")),
  ]);
  assert.match(app, /request\("wallet\.get"/);
  assert.match(app, /request\("wallet\.configure"/);
  assert.match(app, /status\?\.availableEndpoints/);
  assert.match(app, /loadProviderModels\(\[directProvider\]\)/);
  assert.match(app, /type="password" autoComplete="new-password"/);
  assert.match(app, /status\.kind === "user_api" \? <div><dt>API key<\/dt><dd>\{status\.apiKeyConfigured \? "Saved" : "Not added"\}<\/dd><\/div> : null/);
  assert.match(app, /status\?\.kind === "user_api" \? <footer><LockIcon \/>API keys stay in the local Bridge and are never shown again\.<\/footer> : null/);
  assert.doesNotMatch(app, /status\.apiKeyConfigured \? status\.apiKeyLabel \?\? "Configured"/);
  assert.match(app, /setApiKey\(""\)/);
  assert.match(app, /local limit for tracking API spend, not money stored by Tethoq/);
  assert.match(app, /Advanced custom endpoint/);
  assert.match(app, /Responses API/);
  assert.match(app, /OpenAI-compatible Chat Completions/);
  assert.match(app, /local HTTP is allowed only for localhost/);
  assert.match(bridge, /sourceProviderId/);
  assert.match(styles, /\.wallet-user_api\s*\{\s*--wallet-tone:\s*#69aaf9/);
  assert.match(styles, /\.wallet-harness\s*\{\s*--wallet-tone:\s*#e9a15a/);
  assert.doesNotMatch(app, /aria-label="Refresh wallet"/);
  assert.match(app, /<RefreshIcon className="refresh-icon" \/>/);
  assert.match(styles, /svg\.refresh-icon \{[^}]*width: 20px !important/);
  assert.match(icons, /M4 8c2\.7-5\.2 10\.6-6\.2 16 0/);
  assert.match(icons, /m16\.5 4\.5 3\.5 3\.5-3\.5 3\.5/);
});

test("task context menu can branch an online persisted task without replacing Explorer access", async () => {
  const [app, navigation] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
  ]);
  assert.match(navigation, /Branch in New Task/);
  assert.match(navigation, /disabled=\{!canBranchMenuSession\}/);
  assert.match(navigation, /menuSession\?\.draft !== true/);
  assert.match(navigation, /menuProvider\.capabilities\.includes\("Create Session"\)/);
  assert.match(navigation, /menuProvider\.capabilities\.includes\("Send Message"\)/);
  assert.match(navigation, /menuProvider\.capabilities\.includes\("Session History"\)/);
  assert.match(navigation, /Open in File Explorer/);
  assert.match(app, /request\("session\.branch", \{ sessionId \}\)/);
  assert.match(app, /insertDerivedSession\(source, result\.session as Record<string, unknown>\)/);
});
