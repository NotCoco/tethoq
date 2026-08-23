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
      if (type === "sessions.list") return { ok: true, payload: { sessions: [{
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
      if (type === "sessions.refresh") return { ok: true, payload: { sessions: [{
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
  assert.match(app, /agent provider connection model default reasoning/u);
  // The palette indexes one pre-filtered list; internal, side-chat, and archived
  // records are excluded before it ever sees them.
  assert.match(app, /const activeSessions = useMemo\(\(\) => topLevelSessions\.filter\(\(session\) => !session\.archived && session\.sessionKind !== "side_chat" && session\.sessionKind !== "internal"\)/u);
  assert.match(app, /<CommandPalette snapshot=\{snapshot\} sessions=\{activeSessions\}/u);
  assert.doesNotMatch(palette, /snapshot\.sessions/u);
  assert.match(palette, /maxLength=\{maximumUiSearchCharacters\}/u);
  assert.doesNotMatch(palette, /workingDirectory|window\.tethoqDesktop|request\(/u);
  assert.match(navigation, /maxLength=\{maximumUiSearchCharacters\}/u);
  assert.doesNotMatch(app.match(/const filteredSessions = useMemo[\s\S]*?\}, \[query/u)?.[0] ?? "", /workingDirectory/u);
});

test("renderer transient dialogs have names, focus return, and correct modal semantics", async () => {
  const [components, app, composer, navigation] = await Promise.all([
    source(join("src", "renderer", "src", "components.tsx")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
  ]);
  assert.match(components, /focusableSelector/);
  assert.match(components, /event\.key !== "Tab"/);
  assert.match(components, /target && target\.isConnected\) target\.focus\(\)/);
  assert.match(components, /aria-modal="true"/);
  assert.match(app, /<Modal title="" label="Command palette"/);
  assert.match(app, /task-details-popover" role="dialog" aria-modal="false"/);
  assert.match(app, /context-usage-popover" role="dialog" aria-modal="false"/);
  assert.match(app, /requestAnimationFrame\(\(\) => trigger\.current\?\.focus\(\)\)/);
  assert.match(app, /closeOutside = \(event: MouseEvent\) => \{ if \(!root\.current\?\.contains\(event\.target as Node\)\) closeFromOutside\(\); \}/);
  assert.match(composer, /model-library" role="dialog" aria-modal="true"/);
  assert.match(composer, /modelLibrary\.current\?\.querySelector/);
  assert.match(composer, /const closePicker = \(restoreFocus = true\)/);
  assert.match(composer, /!root\.current\?\.contains\(event\.target as Node\)\) closePicker\(false\)/);
  assert.match(composer, /side-chat-panel .*role="dialog" aria-modal="false"/);
  assert.match(composer, /const restoreFocus = \(\) =>/);
  assert.match(navigation, /session-subagents-popover" style=\{popoverStyle\} role="dialog" aria-modal="false"/);
  assert.match(navigation, /const popoverId = `session-subagents-\$\{session\.id\}`/);
  assert.match(navigation, /!root\.current\?\.contains\(event\.target as Node\)\) closeFromOutside\(\)/);
});

test("settings expose one agents catalogue with truthful model routes and compact cards", async () => {
  const [defaults, app, navigation, styles] = await Promise.all([
    source(join("src", "renderer", "src", "AgentDefaultsSettings.tsx")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);

  assert.match(defaults, /Your coding tools and their default models\./u);
  assert.match(defaults, /model\.walletKind !== "user_api" \|\| model\.apiKeyConfigured === true/u);
  assert.match(defaults, /API key saved/u);
  assert.match(defaults, /through \$\{model\.source/u);
  assert.match(defaults, /endpointName \?\? "Other models"/u);
  assert.match(defaults, /role="listbox"/u);
  assert.match(defaults, /role="option"/u);
  assert.doesNotMatch(defaults, /<optgroup/u);
  assert.match(defaults, /className="agent-default-reasoning"/u);
  assert.match(defaults, /aria-label=\{`Default reasoning for \$\{provider\.name\}`\}/u);
  assert.match(defaults, /efforts\.length && selectedEffort/u);
  assert.doesNotMatch(defaults, /Managed by agent/u);
  assert.match(defaults, /API key required/u);
  assert.match(defaults, /API providers · keys saved/u);
  // The Agents catalogue lives in one place now: connection dot and reconnect
  // ride the model row instead of a duplicate provider list.
  assert.match(defaults, /className=\{`connection-dot \$\{provider\.state\}`\}/u);
  assert.match(defaults, /className="settings-icon-action"/u);
  assert.match(defaults, /contextWindowTokens/u);
  assert.match(defaults, /inputPricePerMillion/u);
  assert.match(defaults, /outputPricePerMillion/u);
  assert.match(defaults, /Efforts · \{efforts\.join\(", "\)\}/u);
  assert.doesNotMatch(app, /id="agent-connections"/u);
  assert.match(app, /settings:agents[^\n]*targetId: "agent-defaults"/u);
  assert.doesNotMatch(app, /settings:agent-defaults/u);
  assert.doesNotMatch(app, /<small>v\{provider\.version\}<\/small>/u);
  assert.match(app, /const closeSettings = useCallback/u);
  assert.match(app, /className="settings-close-button"[^>]*aria-label="Close settings"[^>]*onClick=\{onClose\}/u);
  assert.match(navigation, /className="sidebar-settings"[^>]*aria-label=\{view === "settings" \? "Close settings" : "Open settings"\}/u);
  assert.doesNotMatch(navigation, /sidebar-settings \$\{view === "settings" \? "active"/u);
  assert.match(styles, /\.settings-close-button \{[^}]*position: sticky;[^}]*width: 32px;[^}]*height: 32px;/u);
  assert.match(styles, /\.settings-page::-webkit-scrollbar \{ width: 10px; \}/u);
  assert.match(styles, /\.settings-page::-webkit-scrollbar-thumb:hover \{ background: #8a8a83; \}/u);
  assert.match(styles, /\.agent-default-list \{[^}]*overflow: visible;/u);
  assert.match(styles, /\.agent-default-list > article \{[^}]*grid-template-columns: minmax\(180px,\.8fr\) minmax\(280px,1\.2fr\) 16px 32px/u);
  assert.match(styles, /\.agent-model-tip \{[^}]*position: fixed/u);
  assert.match(styles, /\.agent-model-tip \{[^}]*opacity: 0;[^}]*transition: opacity \.11s ease \.45s/u);
  // Values line up because the label column is a fixed width, not an auto column
  // sized to whichever word it holds.
  assert.match(styles, /\.agent-default-list \{ --agent-default-label: 68px;/u);
  assert.match(styles, /\.agent-default-model-row \{[^}]*grid-template-columns: var\(--agent-default-label\) minmax\(0,1fr\)/u);
  // Both chevrons are the same glyph at the same offset in the same column.
  assert.match(defaults, /<span className="agent-default-select">/u);
  assert.match(defaults, /<ChevronDownIcon aria-hidden="true" \/>/u);
  assert.match(styles, /\.agent-default-reasoning \{[^}]*appearance: none;/u);
  assert.match(styles, /\.agent-default-select > svg \{[^}]*right: 8px;[^}]*width: 13px;/u);
  assert.match(styles, /\.agent-model-trigger \{[^}]*padding: 0 8px;/u);
  // A long catalogue is filterable; the list scrolls beneath a fixed field.
  assert.match(defaults, /const searchable = models\.length > 8;/u);
  assert.match(defaults, /className="agent-model-search"/u);
  assert.match(defaults, /placeholder="Search models"/u);
  assert.match(defaults, /aria-label=\{`Search models for \$\{providerName\}`\}/u);
  assert.match(defaults, /modelMatchesCatalogQuery\(needle, providerId, providerName, model\)/u);
  assert.match(defaults, /modelCatalogRoute\(providerId, providerName, model\)\.label/u);
  // modelGroups always returns at least one group, so the empty state has to key
  // off the matches themselves or it can never render.
  assert.match(defaults, /\{matches\.length \? groups\.map/u);
  assert.match(defaults, /No model matches that search/u);
  assert.match(styles, /\.agent-model-scroll \{[^}]*overflow-y: auto;/u);
  // The filter field is a textbox, so it cannot sit inside the listbox role.
  assert.match(defaults, /<div className="agent-model-scroll" role="listbox"/u);
  assert.doesNotMatch(defaults, /<div className="agent-model-dropdown" role="listbox"/u);
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
  assert.equal(result.snapshot.sessions[0].externalWriter, true);
  assert.equal(result.snapshot.sessions[1].contextSummary, "Legacy metadata summary");
  assert.equal(result.snapshot.models["acme-agent"][0].isDefault, undefined);
  assert.equal(result.snapshot.models["acme-agent"][1].isDefault, true);
  // Native context window and per-token pricing become renderer-facing facts;
  // absent provider data stays absent instead of defaulting to zero.
  assert.equal(result.snapshot.models["acme-agent"][0].contextWindowTokens, 128_000);
  assert.equal(result.snapshot.models["acme-agent"][0].inputPricePerMillion, 3);
  assert.equal(result.snapshot.models["acme-agent"][0].outputPricePerMillion, 15);
  assert.equal(result.snapshot.models["acme-agent"][1].contextWindowTokens, undefined);
  assert.equal(result.snapshot.models["acme-agent"][1].inputPricePerMillion, undefined);
  assert.equal(result.snapshot.models["acme-agent"][1].outputPricePerMillion, undefined);
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

  // The meter reads one context, owned by the workspace and polled on a cadence
  // keyed to the session rather than to its traffic. Its own timer was rebuilt by
  // every render and keyed on session.updatedAt, which a streaming turn changes
  // faster than the timer's delay — so the timer never reached its callback and
  // the meter held whatever it had when the turn began. For a task opened during
  // its first turn that is nothing, which is what showed as a stuck empty bar.
  assert.match(app, /const \[sessionContext, setSessionContext\] = useState<SessionContextState \| null>\(null\)/);
  assert.match(app, /<ContextUsageControl key=\{session\.id\} session=\{session\} context=\{sessionContext\?\.sessionId === session\.id \? sessionContext : null\}/);
  assert.match(app, /\}, \[session\?\.draft, session\?\.id, session\?\.state, updateContextCompaction\]\)/);
  assert.doesNotMatch(app, /\[refresh, session\.state, session\.updatedAt\]/);
  assert.doesNotMatch(app, /window\.setInterval\(\(\) => \{ void refresh\(\); \}/);
  // One reading is a snapshot, and a snapshot taken while a provider was still
  // warming up became the answer for the life of the task. A settled task keeps a
  // calm heartbeat so a wrong reading corrects itself, pauses while nobody is
  // looking, and takes a fresh one the moment the window is looked at again.
  assert.match(app, /let delay = active \? 650 : 2_500;/);
  assert.match(app, /if \(document\.hidden\) return schedule\(4_000\);/);
  assert.match(app, /const wake = \(\) => \{ if \(!document\.hidden\) void poll\(\); \};/);
  assert.match(app, /document\.addEventListener\("visibilitychange", wake\);\s*\n\s*window\.addEventListener\("focus", wake\)/);
  assert.match(app, /failures \+= 1;\s*\n\s*delay = Math\.min\(8_000, 400 \* 2 \*\* Math\.min\(failures, 5\)\);/);
  // Overlapping polls would stack timers behind each other.
  assert.match(app, /if \(disposed \|\| inFlight\) return;/);
  // An arriving poll refreshes the numbers under an open panel without snatching
  // back a threshold the reader is part-way through dragging.
  assert.match(app, /const threshold = draftThreshold \?\? context\?\.compactionThresholdTokens \?\? context\?\.contextWindowTokens \?\? null/);
  // A draft is local to one open popover. Closing by the trigger, outside click,
  // or Escape must discard it so reopening shows only the bridge-confirmed value.
  assert.match(app, /const dismiss = useCallback\(\(\) => \{\s*setOpen\(false\);\s*setDraftThreshold\(null\);\s*requestAnimationFrame\(\(\) => trigger\.current\?\.focus\(\)\);\s*\}, \[\]\)/);
  assert.match(app, /event\.key === "Escape"\) dismiss\(\)/);
  assert.match(app, /onClick=\{\(\) => open \? dismiss\(\) : setOpen\(true\)\}/);

  // The visible percentage answers the user's actual question: how close this
  // task is to its automatic-compaction point. The model's larger raw capacity
  // remains separately visible in Usage.
  assert.match(app, /const meterLimit = thresholdAvailable \? safeThreshold : appliedLimit/);
  assert.match(app, /used \/ meterLimit \* 100/);
  assert.match(app, /Automatic compaction limit used/);
  assert.match(app, /% of \$\{thresholdAvailable \? "automatic compaction limit" : "context"\} used/);

  // An agent can report what a task used without reporting the model's limit. A
  // share of an unknown limit cannot be drawn, and an empty gauge reads exactly
  // like a full one at zero — which is what makes a working meter look broken.
  // Show the true part, the tokens used, and draw no gauge at all.
  assert.match(app, /\{percent !== null \? <span className="context-usage-track"/);
  assert.match(app, /: used !== null \? <span className="context-usage-percent">\{compactTokens\(used\)\}<\/span>/);
  assert.match(app, /const compactUsage = used === null \? "Usage unavailable"\s*\n\s*: meterLimit === null \? `\$\{compactTokens\(used\)\} used`/);
  assert.match(app, /: used !== null \? `\$\{compactTokens\(used\)\} of context used; this agent does not report a limit`/);
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
  assert.match(app, /const parentSessionId = parentSessionIdForBack\(session\)/);
  assert.match(app, /label="Back to parent task"[\s\S]*onOpenParent\(parentSessionId\)/);
  assert.match(app, /onOpenParent=\{\(parentSessionId\) => void openSession\(parentSessionId\)\}/);
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

test("unknown provider session status is idle rather than offline", async () => {
  const rendererBridge = await source(join("src", "renderer", "src", "bridge.ts"));
  assert.match(rendererBridge, /if \(value === "unknown"\) return "idle"/);
  assert.match(rendererBridge, /resolveModelReasoningProfile\(/);
  assert.match(rendererBridge, /payloadLooksLikeReasoning\(event\.payload\)/);
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

test("session history preserves provider content-part identity", async () => {
  const timeline = await bridge.loadSessionTimeline("part-identity");
  assert.deepEqual(timeline.map((item) => item.providerPartId), ["prt_reasoning", "prt_text"]);
  assert.deepEqual(timeline.map((item) => item.messageId), ["provider-message", "provider-message"]);
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
  // Working sessions still catch up through the page load once the live stream
  // goes quiet; the adapter only session/loads when no chunks are arriving.
  // Quietness is measured on the selected session itself, not the whole feed.
  assert.match(app, /timelinePage = selected && quietCatchUpDue\(selectedLastDelta\(selected\), Date\.now\(\), 3_000\)/);
  assert.doesNotMatch(app, /workingSessionIds\.current\.has\(sessionId\)\) return/);
  assert.match(app, /const hasPagedWindow = timelineWindows\[sessionId\] !== undefined/);
  assert.match(app, /alreadyLoaded !== undefined && hasPagedWindow && !force/);
  assert.doesNotMatch(app, /!sameSession[\s\S]*?initialTimelineRevealStart\(alreadyLoaded\)/);
  assert.match(app, /Revealed history belongs to the task just like its scroll mode/);
  assert.match(app, /reconcileTimelinePage\(page\.items, current\.timelines\[sessionId\] \?\? \[\]\)/);
  assert.match(app, /applyOpenedSessionPreview\(current\.sessions, page\.session\)/);
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
  assert.match(app, /if \(shouldRequestOlder\(element\)\) void loadOlder\(\)/);
  assert.match(app, /applyScrollTop\(element, anchoredScrollTop\(element, historyAnchor\.current\)\)/);
  // A page landing wholly above the fold leaves no scroll event to ask for the next.
  assert.match(app, /element\.scrollTop <= 1\) void loadOlder\(\)/);
});

test("renderer source reconciles live provider, session, and attention events", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  assert.match(app, /refreshProvidersNeeded = batch\.replayGap \|\| batch\.events\.some\(\(event\) => event\.type === "provider\.connected" \|\| event\.type === "provider\.disconnected"\)/);
  assert.match(app, /refreshSessionsNeeded = batch\.replayGap \|\| remotelyUpdatedSessionIds\.length > 0[\s\S]*?event\.type === "session\.created"/);
  assert.match(app, /session\.updated[\s\S]*?event\.payload\.reasoningEffort[\s\S]*?replaceSession/);
  assert.match(app, /import \{ mergeRefreshedSessions, sameSessionContext \} from "\.\/session_refresh"/);
  assert.match(app, /liveSessionRevisionBySession/);
  assert.match(app, /attentionChanged = batch\.events\.some\(\(event\) => event\.type === "approval\.requested" \|\| event\.type === "approval\.resolved" \|\| event\.type === "user_input\.requested"\)/);
  assert.match(app, /let refreshSessionsNeeded\s*=\s*batch\.replayGap/);
  assert.match(app, /void refreshAll\(false\)/);
  assert.match(app, /if \(refreshInFlight\.current\) \{[\s\S]*?refreshQueued\.current = true;[\s\S]*?return;/);
  assert.match(app, /refreshInFlight\.current = false;[\s\S]*?if \(refreshQueued\.current\) \{[\s\S]*?void refreshAll\(false\);/);
});

test("renderer bridge names OpenCode reasoning levels through the composer choice, not the label", async () => {
  const [composer, rendererBridge] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "bridge.ts")),
  ]);
  // OpenCode calls its reasoning level a variant (max, high, low, …); the task
  // record surfaces it as the effort without overriding a native reasoningEffort.
  assert.match(rendererBridge, /effort: value\.reasoningEffort \?\? value\.variantId \?\? "Default"/u);
  // Model efforts come from the whole native blob, so OpenCode's variants object
  // advertises its levels to the composer's existing reasoning choice.
  assert.match(rendererBridge, /advertised: metadata,/u);
  // The composer resolves the session's effort against the advertised levels, so
  // the reasoning choice in the chatbox shows Max/High for OpenCode sessions.
  assert.match(composer, /resolveConcreteModelSelection\(models, \{ modelId: session\.model, reasoningEffort: session\.effort \}/u);
  assert.match(composer, /effort && efforts\.length \? <ChoiceMenu/);
  // Reasoning rows never claim a literal "Working" title again; the label already
  // says Reasoning, and an empty thought says Thinking… in the preview instead.
  assert.doesNotMatch(rendererBridge, /"Working"/u);
  assert.match(rendererBridge, /kind: "reasoning", title: part\.redacted \? "Protected reasoning" : "Reasoning"/u);
  assert.match(rendererBridge, /kind === "reasoning" \? \{ title: "Reasoning" \}/u);
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

  assert.match(composer, /const holdsFollowUpQueue = sessionHoldsFollowUpQueue\(session, timeline\)/);
  assert.match(composer, /const blockedByAttention = holdsFollowUpQueue \|\| turnInFlight\.current/);
  assert.match(composer, /const requestType = composerMessageRequestType\(\{[\s\S]*?externalWriter: session\.externalWriter === true,[\s\S]*?\}\)/);
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
  assert.match(styles, /\.titlebar \{[^}]*background:\s*var\(--bg\)/);
  assert.match(styles, /\.app-loading \{[^}]*background:\s*var\(--bg\)/);
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
  assert.match(styles, /\.session-row-top time \{[\s\S]*?font-size: 12\.5px;[\s\S]*?opacity: 0;[\s\S]*?transform: translateY\(2px\)/);
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
  assert.match(styles, /\.session-row-top time \{[\s\S]*?font-size: 12\.5px/);
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
  // Refreshes omit derived sessions, so locally tracked drafts, side chats, and
  // delegated children must survive the merge instead of blanking their workspace.
  assert.match(app, /const localOnly = current\.sessions\.filter\(\(session\) => \(session\.draft \|\| session\.sessionKind === "side_chat" \|\| session\.parentSessionId !== undefined \|\| !incomingProviders\.has\(session\.providerId\) \|\| changedSinceRefresh\(session\.id\)\) && !refreshedIds\.has\(session\.id\)\)/);
  assert.match(app, /sessions: applyOpenedSessionPreview\(\[\.\.\.localOnly, \.\.\.mergeRefreshedSessions\(current\.sessions, sessions, quiet, changedSinceRefresh\)\], timelinePage\?\.session\)/);
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
  assert.match(app, /A local ceiling Tethoq stops you at\. It is not credit, and no money is held here\./);
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

test("provider model catalogues load for every provider and never block the boot", async () => {
  const [app, rendererBridge] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "bridge.ts")),
  ]);
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
  // The periodic catch-up heals a provider whose models never arrived: the
  // selected task's provider with an empty catalogue gets a bounded reload.
  assert.match(app, /healMissingModels = useCallback/u);
  assert.match(app, /loadProviderModels\(\[provider\]\)/u);
  assert.match(app, /healMissingModels\(\);/u);
  assert.match(app, /modelHealAttempts\.current\.get\(provider\.id\)/u);
  // No single models.list call may hang the initial snapshot forever.
  assert.match(rendererBridge, /withTimeout\(request\("models\.list"/u);
});

test("OpenCode parented user chats stay in the task list while explicit subagents stay hidden", async () => {
  const listed = await bridge.listSessions();
  assert.equal(listed.some((session) => session.id === "host/opencode/root-chat"), true);
  assert.equal(listed.some((session) => session.id === "host/opencode/spawned"), false);
  const mapped = listed.find((session) => session.id === "host/opencode/root-chat");
  assert.equal(mapped?.parentSessionId, "host/opencode/workspace");
  assert.equal(mapped?.providerId, "opencode");
  assert.equal(mapped?.childCount, 1, "the visible parent must carry the hidden child count");
  assert.deepEqual(mapped?.childProviderIds, ["opencode"], "the parent control must use the child's provider identity");
  assert.deepEqual(mapped?.providerStatus, { kind: "retry", message: "Provider is temporarily busy", retryAt: "2026-08-20T12:00:00.000Z" });
});

test("task rows expose the sub-agent disclosure only when children exist and handle singular and plural labels", async () => {
  const refreshed = await bridge.refreshSessions();
  assert.equal(refreshed.every((session) => session.childCount === undefined), true, "ordinary tasks must not reserve empty child chrome");

  const navigation = await source(join("src", "renderer", "src", "NavigationPanels.tsx"));
  assert.match(navigation, /const displayedChildCount = childrenLoaded \? children\.length : session\.childCount/);
  assert.match(navigation, /if \(!displayedChildCount\) return null;/);
  assert.match(navigation, /displayedChildCount === 1 \? "" : "s"/);
  assert.match(navigation, /children\.map\(\(child\) =>/);
  assert.match(navigation, /setInterval\(\(\) => \{ void refreshChildren\(false\); \}, 1_500\)/);
  assert.match(navigation, /child\.state === "working" \? <span className="spinner"/);
  assert.match(navigation, /aria-label=\{`Sub-agents for \$\{session\.title\}`\}/);
  assert.match(navigation, /onClick=\{\(\) => \{ close\(\); onOpenChild\(child\); \}\}/);

  const app = await source(join("src", "renderer", "src", "App.tsx"));
  assert.match(app, /topLevelSessions = useMemo\(\(\) => organizedSessions\.filter\(\(session\) => session\.relationshipKind !== "subagent"\)/);
  assert.match(app, /return topLevelSessions\.filter\(\(session\) =>/);
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

test("delegated children map safely and stay visible across refreshes even when their provider is missing", async () => {
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

  const app = await source(join("src", "renderer", "src", "App.tsx"));
  // Both refresh merges preserve derived sessions instead of dropping them.
  const localOnlyMatches = app.match(/const localOnly = current\.sessions\.filter\(\(session\) => \(session\.draft \|\| session\.sessionKind === "side_chat" \|\| session\.parentSessionId !== undefined \|\| !incomingProviders\.has\(session\.providerId\) \|\| changedSinceRefresh\(session\.id\)\) && !refreshedIds\.has\(session\.id\)\)/gu) ?? [];
  assert.equal(localOnlyMatches.length, 2);
  assert.match(app, /sessions: applyOpenedSessionPreview\(\[\.\.\.localOnly, \.\.\.mergeRefreshedSessions\(current\.sessions, sessions, quiet, changedSinceRefresh\)\], timelinePage\?\.session\)/);
  // Opening a child inserts it into the tracked sessions before its timeline loads.
  assert.match(app, /onOpenChild=\{\(child\) => \{[\s\S]*?sessions: \[child, \.\.\.current\.sessions\.filter/);
  // The child row tolerates a provider that is absent from the provider list.
  assert.match(app, /const childProvider = providers\.find\(\(provider\) => provider\.id === child\.providerId\)/);
  assert.match(app, /<ProviderLogo providerId=\{child\.providerId\} provider=\{childProvider\}/);
});

test("foreign sub-agent permission UI exposes a master switch and a per-task checkbox only while enabled", async () => {
  const [app, api] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "shared", "desktop_api.ts")),
  ]);

  // Both preference actions exist in the shared API and dispatch through the IPC.
  assert.match(api, /"set-allow-foreign-subagents"/);
  assert.match(api, /"set-session-foreign-subagents"/);
  assert.match(app, /type: "set-allow-foreign-subagents", enabled/);
  assert.match(app, /type: "set-session-foreign-subagents", sessionId: selectedSession\.id, allowed/);
  assert.match(app, /foreignSubagentsEnabled=\{preferences\.allowForeignSubagents === true\}/);
  assert.match(app, /sessionForeignSubagents=\{preferences\.foreignSubagentOverrides\?\.\[selectedSession\?\.id \?\? ""\] \?\? true\}/);

  // The per-task control renders only while the master gate is on, so a
  // disabled gate leaves no section, no heading, and no reserved gap.
  assert.match(app, /\{foreignSubagentsEnabled \? <section className="task-details-section" aria-labelledby=\{`task-foreign-subagents-\$\{session\.id\}`\}>[\s\S]*?<\/section> : null\}/);
  assert.match(app, /This task may spawn sub-agents on a different coding tool\./);

  // Settings row mirrors the experimental toggle's switch markup and copy.
  assert.match(app, /<h2>Sub-agents<\/h2>/);
  assert.match(app, /Allow sub-agents from other coding tools/);
  assert.match(app, /aria-checked=\{preferences\.allowForeignSubagents === true\}/);
  assert.match(app, /className=\{`settings-toggle \$\{preferences\.allowForeignSubagents === true \? "on" : ""\}`\}/);
  assert.match(app, /role="switch"/);
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

  // An assistant message.started is only a turn marker and must not draw a row.
  assert.equal(bridge.eventToTimeline({
    ...base,
    eventId: "grok:assistant-start",
    type: "message.started",
    payload: { messageId: "assistant_0", role: "assistant" },
  }), null);
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
