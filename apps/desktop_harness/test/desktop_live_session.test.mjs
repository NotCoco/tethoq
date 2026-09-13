import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-live-session-${process.pid}-${Date.now()}`);
await mkdir(outputDirectory, { recursive: true });

async function bundle(entry, name, electronStub = false) {
  const outfile = join(outputDirectory, `${name}.mjs`);
  const plugins = electronStub ? [{
    name: "live-session-electron-stub",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        loader: "js",
        contents: "export const desktopCapturer={getSources:async()=>[]}; export const screen={getAllDisplays(){return []},getDisplayNearestPoint(){throw new Error('stub')},getCursorScreenPoint(){throw new Error('stub')}}; export const nativeImage={};",
      }));
    },
  }] : [];
  await build({
    entryPoints: [join(appRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    plugins,
  });
  return await import(`file:///${outfile.replaceAll("\\", "/")}`);
}

const managerModule = await bundle("src/main/live_session/manager.ts", "live-manager", true);
const preferencesModule = await bundle("src/main/preferences.ts", "preferences");
const promptModule = await bundle("src/shared/live_session_prompt.ts", "prompt");
const audioModule = await bundle("src/renderer/src/live_session_audio.ts", "audio");
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });
const source = async (path) => readFile(join(appRoot, path), "utf8");

class FakeCapture {
  captured = [];
  nextResult;
  delayMs = 0;
  now = Date.now;
  displays() {
    return [{ id: "1", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1, rotation: 0, internal: true }];
  }
  displayNearest() {
    return { id: "1", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1, rotation: 0, internal: true };
  }
  async capture(point) {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.nextResult === "fail") throw new Error("capture adapter failed");
    const capturedWallTimeMs = this.now() + (this.nextResult === "late" ? 5_000 : 0);
    const frame = { kind: "full", label: "A synchronized full-display frame", mimeType: "image/jpeg", dataBase64: Buffer.from("frame").toString("base64"), byteLength: 5, width: 1280, height: 720, capturedWallTimeMs, capturedAt: new Date(capturedWallTimeMs).toISOString(), displayId: "1", displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, displayScaleFactor: 1, cursor: { x: point.x, y: point.y, xNormalized: point.x / 1920, yNormalized: point.y / 1080 } };
    const crop = { ...frame, kind: "cursor", label: "A cursor-centred close-up", dataBase64: Buffer.from("crop").toString("base64"), width: 640, height: 480 };
    this.captured.push(point);
    return { frame, crop };
  }
}

function clock() {
  let wall = 1_800_000_000_000;
  return {
    now: () => wall,
    advance(ms) { wall += ms; },
  };
}

async function fixture(t, { enabled = true, cursor = { x: 640, y: 360 } } = {}) {
  const capture = new FakeCapture();
  const time = clock();
  capture.now = time.now;
  const enabledRef = { value: enabled };
  const states = [];
  const manager = new managerModule.LiveSessionManager({
    isEnabled: () => enabledRef.value,
    platform: "win32",
    now: time.now,
    cursorReader: () => cursor,
    captureAdapter: capture,
    contextProvider: () => ({ appName: "Tethoq", windowTitle: "Browser", browser: { tabId: "tab-1", title: "Docs", url: "https://example.test/docs" } }),
    nativeContextProvider: () => Promise.resolve(undefined),
    onState: (state) => states.push(state),
    limits: { cursorSampleIntervalMs: 10 },
  });
  t.after(async () => { await manager.dispose(); });
  return { manager, capture, time, enabledRef, states };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("instant sessions are gated behind experimental features and stay dormant", async (t) => {
  const value = await fixture(t, { enabled: false });
  assert.equal(value.manager.state().enabled, false);
  await assert.rejects(() => value.manager.begin(), /experimental features/i);
  assert.equal(value.manager.state().phase, "idle");
  value.enabledRef.value = true;
  const active = await value.manager.begin();
  assert.equal(active.phase, "active");
  assert.equal(value.manager.state().enabled, true);
  await value.manager.end("settings-disabled");
  assert.equal(value.manager.state().phase, "idle");
});

test("evidence aligns cursor samples to the utterance window with normalized coordinates", async (t) => {
  const value = await fixture(t, { cursor: { x: 480, y: 270 } });
  await value.manager.begin();
  await sleep(60);
  const startedAtWallMs = value.time.now() - 40;
  await sleep(40);
  const endedAtWallMs = value.time.now();
  const evidence = await value.manager.evidence({ utteranceId: "u-1", startedAtWallMs, endedAtWallMs });
  assert.equal(evidence.formatVersion, 1);
  assert.equal(evidence.utteranceId, "u-1");
  assert.equal(evidence.stale, false);
  assert.ok(evidence.cursor.end !== null);
  assert.equal(evidence.cursor.end.x, 480);
  assert.equal(evidence.cursor.end.y, 270);
  assert.ok(Math.abs(evidence.cursor.end.xNormalized - 480 / 1920) < 0.001);
  assert.ok(evidence.cursor.samples.length >= 1);
  assert.ok(evidence.cursor.samples.every((sample) => sample.wallTimeMs >= startedAtWallMs && sample.wallTimeMs <= endedAtWallMs));
  assert.equal(evidence.frames.length, 2);
  assert.equal(evidence.frames[0].kind, "cursor");
  assert.equal(evidence.frames[1].kind, "full");
  assert.match(evidence.pointerSummary, /normalized \(0\.250, 0\.250\)/);
  assert.match(evidence.hover.browser.url, /example\.test/);
  await value.manager.end("user");
  assert.equal(value.manager.state().active, undefined);
  await assert.rejects(() => value.manager.evidence({ utteranceId: "u-2", startedAtWallMs, endedAtWallMs }), /No instant session is active/);
});

test("capture failure keeps transcript flow usable with an honest error", async (t) => {
  const value = await fixture(t);
  value.capture.nextResult = "fail";
  await value.manager.begin();
  await sleep(30);
  const startedAtWallMs = value.time.now() - 20;
  const endedAtWallMs = value.time.now();
  const evidence = await value.manager.evidence({ utteranceId: "u-fail", startedAtWallMs, endedAtWallMs });
  assert.equal(evidence.frames.length, 0);
  assert.match(evidence.captureError, /capture adapter failed/);
  assert.equal(value.manager.state().active.captureErrors, 1);
});

test("late captures are marked stale so consumers never trust mismatched timing", async (t) => {
  const value = await fixture(t);
  value.capture.nextResult = "late";
  await value.manager.begin();
  await sleep(30);
  const startedAtWallMs = value.time.now() - 20;
  const endedAtWallMs = value.time.now();
  const evidence = await value.manager.evidence({ utteranceId: "u-stale", startedAtWallMs, endedAtWallMs });
  assert.equal(evidence.stale, true);
});

test("invalid utterance windows are rejected before any capture", async (t) => {
  const value = await fixture(t);
  await value.manager.begin();
  const now = value.time.now();
  await assert.rejects(() => value.manager.evidence({ utteranceId: "bad-1", startedAtWallMs: now, endedAtWallMs: now }), /window is invalid/);
  await assert.rejects(() => value.manager.evidence({ utteranceId: "bad-2", startedAtWallMs: now - 70_000, endedAtWallMs: now }), /too long/);
  await assert.rejects(() => value.manager.evidence({ utteranceId: "bad-3", startedAtWallMs: now, endedAtWallMs: now + 10_000 }), /in the future/);
  assert.equal(value.capture.captured.length, 0);
  assert.equal(value.manager.state().active.utteranceCount, 0);
});

test("end tears down sampling and dispose ends with app-shutdown", async (t) => {
  const value = await fixture(t);
  await value.manager.begin();
  await sleep(40);
  assert.ok(value.manager.state().active.cursorSampleCount > 0);
  await value.manager.dispose();
  assert.equal(value.manager.state().phase, "idle");
  assert.equal(value.manager.state().active, undefined);
});

test("oversized frames are omitted instead of breaking the bridge inline limit", async (t) => {
  const value = await fixture(t);
  const original = value.capture.capture.bind(value.capture);
  value.capture.capture = async (point, options) => {
    const result = await original(point, options);
    const huge = Buffer.alloc(950 * 1024, 1).toString("base64");
    return {
      frame: { ...result.frame, dataBase64: huge, byteLength: 950 * 1024 },
      crop: { ...result.crop, dataBase64: huge, byteLength: 950 * 1024 },
    };
  };
  await value.manager.begin();
  await sleep(30);
  const evidence = await value.manager.evidence({ utteranceId: "u-huge", startedAtWallMs: value.time.now() - 20, endedAtWallMs: value.time.now() });
  assert.equal(evidence.frames.length, 0);
  assert.match(evidence.captureError, /too large/);
});

test("grounding prompts carry transcript, times, pointer, and hover context", () => {
  const evidence = {
    window: { startedAtWallMs: 1_800_000_000_100, endedAtWallMs: 1_800_000_001_900 },
    sampledAtWallTimeMs: 1_800_000_002_000,
    cursor: {
      start: { x: 640, y: 360, displayId: "1", displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, displayScaleFactor: 1, xNormalized: 0.333, yNormalized: 0.333 },
      end: { x: 648, y: 362, displayId: "1", displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, displayScaleFactor: 1, xNormalized: 0.338, yNormalized: 0.335 },
      samples: [],
    },
    frames: [{ kind: "full", label: "A synchronized full-display frame", capturedWallTimeMs: 1_800_000_001_950, displayId: "1", displayBounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
    captureError: null,
    stale: false,
    hover: { appName: "Explorer", windowTitle: "Documents - File Explorer", cursorElement: { name: "Budget.xlsx", controlType: "List item" } },
    pointerSummary: "Pointer: start (640, 360) normalized (0.333, 0.333) -> end (648, 362) normalized (0.338, 0.335); 0 samples in the utterance window.",
  };
  const prompt = promptModule.buildUtterancePrompt("Show me this budget", evidence);
  assert.match(prompt, /Show me this budget/);
  assert.match(prompt, /Utterance window:/);
  assert.match(prompt, /Documents - File Explorer/);
  assert.match(prompt, /Hovered element: Budget\.xlsx \(List item\)/);
  assert.match(prompt, /captured at/);
  const question = promptModule.buildEyesQuestion("what is this?", evidence);
  assert.match(question, /what is this\?/);
  assert.match(question, /hovering the element "Budget\.xlsx"/);
  assert.match(question, /normalized position \(0\.338, 0\.335\)/);
});

test("preferences persist experimental, reasoning-display, and concrete agent defaults", async (t) => {
  const path = join(outputDirectory, `preferences-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  t.after(() => rm(path, { force: true }));
  const store = await preferencesModule.DesktopPreferencesStore.load(path);
  assert.equal(store.value().experimentalFeatures, false);
  assert.equal(store.value().allowForeignSubagents, false);
  assert.equal(store.value().reasoningDisplay, "compact");
  assert.equal(store.value().localOpenHandlerId, "system");
  assert.deepEqual(store.value().agentDefaults, {});
  assert.equal(store.value().globalAgentsPath, null);
  assert.equal(store.value().version, 1);
  const changed = [];
  store.onChange((value) => changed.push(value));
  await store.setExperimentalFeatures(true);
  await store.setReasoningDisplay("expanded");
  await store.setLocalOpenHandler("vscode");
  await store.setAgentDefault("codex", { modelId: "gpt-5.6-sol", reasoningEffort: "medium" });
  assert.equal(store.value().experimentalFeatures, true);
  assert.equal(store.value().allowForeignSubagents, true);
  assert.equal(store.value().reasoningDisplay, "expanded");
  assert.equal(store.value().localOpenHandlerId, "vscode");
  assert.deepEqual(store.value().agentDefaults, { codex: { modelId: "gpt-5.6-sol", reasoningEffort: "medium" } });
  assert.equal(changed.length, 4);
  const reloaded = await preferencesModule.DesktopPreferencesStore.load(path);
  assert.equal(reloaded.value().experimentalFeatures, true);
  assert.equal(reloaded.value().allowForeignSubagents, true);
  assert.equal(reloaded.value().reasoningDisplay, "expanded");
  assert.equal(reloaded.value().localOpenHandlerId, "vscode");
  assert.deepEqual(reloaded.value().agentDefaults, { codex: { modelId: "gpt-5.6-sol", reasoningEffort: "medium" } });
  assert.deepEqual(preferencesModule.validateDesktopPreferences({ version: 9, experimentalFeatures: "yes", reasoningDisplay: "verbose", taskListMode: "folders", localOpenHandlerId: "unknown", agentDefaults: { codex: { modelId: "  gpt-5.6-sol  ", reasoningEffort: " high " }, bad: { modelId: "" } }, extra: 1 }), { version: 1, experimentalFeatures: false, reasoningDisplay: "compact", taskListMode: "recent", savedProjectDirectories: [], openLinksInApp: false, localOpenHandlerId: "system", closeAction: "tray", launchAtLogin: "off", alerts: "all", agentDefaults: { codex: { modelId: "gpt-5.6-sol", reasoningEffort: "high" } }, globalAgentsPath: null, taskOverrides: {}, allowForeignSubagents: false, foreignSubagentOverrides: {}, ears: { enabled: false, providerId: null, modelId: null, mode: "cleaned" } });
  assert.equal(preferencesModule.validateDesktopPreferences({ experimentalFeatures: false, allowForeignSubagents: true }).allowForeignSubagents, false);
  assert.equal(preferencesModule.validateDesktopPreferences({ experimentalFeatures: true, allowForeignSubagents: false }).allowForeignSubagents, true);

  const agentsPath = join(outputDirectory, "AGENTS.md");
  await writeFile(agentsPath, "Keep answers calm and concise.\n", "utf8");
  await store.setGlobalAgentsPath(agentsPath);
  assert.equal(store.value().globalAgentsPath, agentsPath);
  assert.equal(await preferencesModule.readGlobalAgentInstructions(agentsPath), "Keep answers calm and concise.\n");
  await store.setGlobalAgentsPath(null);
  assert.equal(store.value().globalAgentsPath, null);
});

test("every instant-session entry point is gated and the backend rejects while disabled", async () => {
  const [composer, app, ipc, livePanel] = await Promise.all([
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "main", "ipc.ts")),
    source(join("src", "renderer", "src", "LiveSession.tsx")),
  ]);

  // Renderer: the composer entry renders only when the experimental gate is on.
  assert.match(composer, /\{experimental && onInstantSession \? <button[\s\S]*?if \(draftSession\) void requestDraftAction\("instant"\)[\s\S]*?Instant session/);
  assert.match(composer, /onInstantSession\?: \(\) => void/);
  assert.doesNotMatch(composer, /session\.vision\.ask/);
  assert.doesNotMatch(composer, /liveSessionAction/);

  // Settings toggle drives the master preference; the panel cannot start while off.
  assert.match(app, /set-experimental-features/);
  assert.match(app, /set-reasoning-display/);
  assert.match(app, /Expanded streams every thought in full as it is written and shows tool calls as their own expandable rows\. It does not change model effort\./);
  assert.match(app, /role="switch"/);
  assert.match(app, /aria-checked=\{preferences\.experimentalFeatures\}/);
  assert.match(livePanel, /disabled=\{!experimental\}/);
  assert.match(livePanel, /session\.vision\.ask/);
  assert.match(livePanel, /message_queue\.enqueue/);
  assert.match(livePanel, /liveSessionAction\(\{ type: "begin" \}\)/);
  assert.match(livePanel, /Microphone access was denied/);

  // Backend: the main process re-checks the gate for every action before capture.
  assert.match(ipc, /options\.preferences\.value\(\)\.experimentalFeatures/);
  assert.match(ipc, /Instant sessions require experimental features/);
  assert.match(ipc, /case "begin": return await options\.liveSession\.begin\(\)/);
});

test("preload exposes the preferences and live-session seams", async () => {
  const [preload, api] = await Promise.all([
    source(join("src", "preload", "index.ts")),
    source(join("src", "shared", "desktop_api.ts")),
  ]);
  assert.match(preload, /ipcRenderer\.invoke\(IPC_CHANNELS\.preferencesGet\)/);
  assert.match(preload, /liveSessionAction: \(action: LiveSessionAction\): ReturnType<DesktopHarnessApi\["liveSessionAction"\]> => ipcRenderer\.invoke\(IPC_CHANNELS\.liveSessionAction, action\)/);
  assert.match(preload, /onLiveSessionState/);
  assert.match(api, /liveSessionState: "tethoq:live-session-state"/);
  assert.match(api, /preferencesAction\(action: PreferencesAction\)/);
  assert.match(api, /liveSessionAction\(action: LiveSessionAction\)/);
});

test("wav encoding produces a valid 16 kHz mono PCM header", () => {
  const bytes = audioModule.encodeWavPcm16(new Float32Array([0, 0.5, -0.5, 1]), 16_000);
  assert.equal(bytes.byteLength, 44 + 4 * 2);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), "WAVE");
  assert.equal(String.fromCharCode(...bytes.subarray(36, 40)), "data");
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), Math.trunc(0.5 * 0x7fff));
  assert.equal(view.getInt16(48, true), Math.round(-0.5 * 0x8000));
});
