import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const outputDirectory = join(tmpdir(), `tethoq-recorder-tests-${process.pid}-${Date.now()}`);
await mkdir(outputDirectory, { recursive: true });

async function bundle(entry, name) {
  const outfile = join(outputDirectory, `${name}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    plugins: [{
      name: "recorder-native-stubs",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        pluginBuild.onResolve({ filter: /^uiohook-napi$/ }, () => ({ path: "uiohook-napi", namespace: "stub" }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({
          loader: "js",
          contents: path === "electron"
            ? "export const globalShortcut={register(){return true},unregister(){}}; export const shell={showItemInFolder(){}}; export const desktopCapturer={getSources:async()=>[]}; export const nativeImage={createFromPath(){return {isEmpty(){return true}}},createFromBuffer(){return {isEmpty(){return true}}},createFromBitmap(){return {isEmpty(){return true}}}}; export const screen={getAllDisplays(){return []},getDisplayNearestPoint(){throw new Error('stub')}};"
            : "export const uIOhook={on(){},off(){},start(){},stop(){}};",
        }));
      },
    }],
  });
  return await import(`file:///${outfile.replaceAll("\\", "/")}`);
}

const recorderModule = await bundle("../src/main/recorder/manager.ts", "manager");
const captureModule = await bundle("../src/main/recorder/capture.ts", "capture");
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

class FakeHook {
  starts = 0;
  stops = 0;
  listeners;
  start(listeners) { this.starts += 1; this.listeners = listeners; }
  stop() { this.stops += 1; this.listeners = undefined; }
  emit(type, event) { this.listeners?.[type]?.(event); }
}

class FakeCapture {
  captures = [];
  summaries = [];
  displays() {
    return [{ id: "1", bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1, rotation: 0, internal: true }];
  }
  async capture(request) {
    this.captures.push(request);
    await Promise.all([writeFile(request.fullPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9])), writeFile(request.cursorPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))]);
    return { frameId: request.frameId, triggerEventId: request.triggerEventId, timestamp: request.timestamp, displayId: "1", displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, imageSize: { width: 1920, height: 1080 }, fullPath: request.fullPath, cursorPath: request.cursorPath, fullRelativePath: `screens/full/${request.frameId}.jpg`, cursorRelativePath: `screens/cursor/${request.frameId}.jpg`, cursor: { screen: { x: request.x, y: request.y }, image: { x: request.x, y: request.y }, normalized: { x: request.x / 1919, y: request.y / 1079 }, embeddedInImage: true }, bytesWritten: 8 };
  }
  async createDragSummary(request) {
    this.summaries.push(request);
    return { cropBounds: { x: 0, y: 0, width: 800, height: 540 }, framePaths: [], bytesWritten: 0 };
  }
}

class FakeShortcut {
  callback;
  registered = 0;
  unregistered = 0;
  register(_shortcut, callback) { this.callback = callback; this.registered += 1; return true; }
  unregister() { this.callback = undefined; this.unregistered += 1; }
  panic() { this.callback?.(); }
}

function clock() {
  let wall = 1_800_000_000_000;
  let mono = 5_000_000_000n;
  return {
    now: () => wall,
    monotonicNow: () => mono,
    advance(ms) { wall += ms; mono += BigInt(ms) * 1_000_000n; },
  };
}

function mouse(x, y, button = 1) {
  return { x, y, button, clicks: 1, alt: false, ctrl: false, meta: false, shift: false };
}

async function fixture(t) {
  const directory = join(outputDirectory, `workflows-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const hook = new FakeHook();
  const capture = new FakeCapture();
  const shortcut = new FakeShortcut();
  const time = clock();
  const events = new EventEmitter();
  const live = [];
  const manager = new recorderModule.RecorderManager({
    rootDirectory: directory,
    platform: "win32",
    inputHook: hook,
    captureAdapter: capture,
    shortcutAdapter: shortcut,
    now: time.now,
    monotonicNow: time.monotonicNow,
    contextProvider: () => ({ appName: "Tethoq", windowTitle: "Browser", browser: { tabId: "tab-1", title: "Docs", url: "https://example.test/docs" } }),
    onEvent: (event) => { live.push(event); events.emit("event", event); },
    limits: { mouseSampleIntervalMs: 20, dragScreenshotIntervalMs: 100, keyScreenshotIntervalMs: 500, maxPendingCaptures: 2 },
  });
  t.after(async () => { await manager.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { manager, directory, hook, capture, shortcut, time, live };
}

test("recorder stays fully dormant until explicit start and cleans up after stop", async (t) => {
  const value = await fixture(t);
  assert.equal(value.manager.state().phase, "idle");
  assert.equal(value.hook.starts, 0);
  assert.equal(value.shortcut.registered, 0);
  assert.deepEqual(await value.manager.list(), []);
  assert.equal(value.hook.starts, 0, "listing must not start the native hook");

  await value.manager.start({ privacyConsent: true });
  assert.equal(value.hook.starts, 1);
  assert.equal(value.manager.state().hookActive ?? true, true);
  const staged = await value.manager.stop("user");
  assert.equal(staged.status, "staged");
  assert.equal(value.hook.stops, 1);
  assert.equal(value.shortcut.callback, undefined);
  assert.equal(value.manager.state().phase, "staged");
});

test("recorder configuration clamps unsafe queue and storage overrides", () => {
  const limits = recorderModule.normalizeRecorderLimits({
    mouseSampleIntervalMs: 0,
    maxPendingCaptures: 1_000,
    maxContextQueue: Number.POSITIVE_INFINITY,
    maxWorkflowBytes: 1,
  });
  assert.equal(limits.mouseSampleIntervalMs, 8);
  assert.equal(limits.maxPendingCaptures, 8);
  assert.equal(limits.maxContextQueue, 1);
  assert.equal(limits.maxWorkflowBytes, 1_048_576);
});

test("curved drag samples path, schedules bounded frames, and persists exact timestamps", async (t) => {
  const value = await fixture(t);
  await value.manager.start({ privacyConsent: true });
  value.hook.emit("mousedown", mouse(100, 100));
  for (const [x, y] of [[130, 105], [160, 125], [190, 165], [215, 220], [240, 280]]) {
    value.time.advance(25);
    value.hook.emit("mousemove", mouse(x, y));
  }
  value.time.advance(25);
  value.hook.emit("mouseup", mouse(275, 320));
  await new Promise((resolve) => setImmediate(resolve));
  const staged = await value.manager.stop("user");
  const events = (await readFile(staged.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const drag = events.find((event) => event.type === "drag-complete");
  assert.ok(drag);
  assert.equal(drag.path.length, 7);
  assert.deepEqual(drag.path.map(({ x, y }) => [x, y]), [[100, 100], [130, 105], [160, 125], [190, 165], [215, 220], [240, 280], [275, 320]]);
  assert.equal(drag.durationMs, 150);
  assert.equal(drag.wallTimeMs, 1_800_000_000_150);
  assert.equal(drag.monotonicMs, 150);
  assert.ok(value.capture.captures.length >= 2, "drag start and periodic/end frames are captured");
  assert.equal(value.capture.summaries.length, 1);
  assert.equal(staged.summary.dragCount, 1);
  assert.ok(staged.summary.droppedFrames <= 1, "the bounded queue may intentionally drop one burst frame");
});

test("finalize names and rebases a workflow; attachment is explicitly local-only; delete removes it", async (t) => {
  const value = await fixture(t);
  await value.manager.start({ privacyConsent: true });
  value.hook.emit("click", mouse(400, 300));
  await new Promise((resolve) => setImmediate(resolve));
  const staged = await value.manager.stop("user");
  const saved = await value.manager.finalize("Import footage into CapCut");
  assert.equal(saved.name, "Import footage into CapCut");
  assert.equal(saved.status, "saved");
  assert.notEqual(saved.path, staged.path);
  assert.equal((await value.manager.list())[0].id, saved.id);

  const screenshots = await value.manager.screenshots(saved.id);
  assert.deepEqual(screenshots, [{ frameId: "frame-000001", name: "frame-000001.jpg" }]);
  const screenshot = await value.manager.screenshot(saved.id, "frame-000001", "full");
  assert.equal(screenshot.name, "frame-000001.jpg");
  assert.match(screenshot.dataUrl, /^data:image\/jpeg;base64,/u);

  const attachment = await value.manager.attachment(saved.id);
  assert.equal(attachment.localOnly, true);
  assert.equal(attachment.neverUploadedAutomatically, true);
  assert.match(attachment.promptReference, /Import footage into CapCut/);
  assert.match(attachment.promptReference, /workflow\.json/);
  await value.manager.delete(saved.id);
  assert.deepEqual(await value.manager.list(), []);
});

test("discard removes unnamed staging data", async (t) => {
  const value = await fixture(t);
  await value.manager.start({ privacyConsent: true });
  const staged = await value.manager.stop("user");
  assert.ok((await readdir(value.directory)).some((entry) => entry.includes(staged.id)));
  await value.manager.discard();
  assert.equal(value.manager.state().phase, "idle");
  assert.deepEqual(await value.manager.list(), []);
});

test("panic shortcut stops hooks and stages a recoverable workflow", async (t) => {
  const value = await fixture(t);
  await value.manager.start({ privacyConsent: true });
  value.shortcut.panic();
  for (let attempt = 0; attempt < 200 && value.manager.state().phase !== "staged"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(value.manager.state().phase, "staged");
  assert.equal(value.hook.stops, 1);
  assert.ok(value.live.some((event) => event.type === "panic-stop"));
  assert.equal(value.manager.state().staged.stopReason, "panic-shortcut");
});

test("drag crop comfortably contains path and remains inside its display", () => {
  assert.deepEqual(captureModule.dragBounds([
    { x: 40, y: 50 },
    { x: 600, y: 350 },
    { x: 940, y: 710 },
  ], { x: 0, y: 0, width: 1000, height: 800 }, 100, { width: 720, height: 540 }), {
    x: 0,
    y: 0,
    width: 1000,
    height: 800,
  });
  assert.deepEqual(captureModule.dragBounds([
    { x: 850, y: 450 },
    { x: 950, y: 520 },
  ], { x: 500, y: 200, width: 1000, height: 800 }, 100, { width: 720, height: 540 }), {
    x: 540,
    y: 215,
    width: 720,
    height: 540,
  });
});

test("drag crop accepts virtual desktops with negative cross-display coordinates", () => {
  assert.deepEqual(captureModule.dragBounds([
    { x: -900, y: 300 },
    { x: 400, y: 500 },
  ], { x: -1920, y: 0, width: 3840, height: 1080 }, 120, { width: 720, height: 540 }), {
    x: -1020,
    y: 130,
    width: 1540,
    height: 540,
  });
});

test("captured screenshots burn in a crisp high-contrast pointer", () => {
  const width = 64;
  const height = 64;
  const original = Buffer.alloc(width * height * 4, 127);
  const marked = captureModule.drawCursorOnBitmap(original, width, height, { x: 20, y: 18 });
  assert.notDeepEqual(marked, original);
  const tones = new Set();
  for (let offset = 0; offset < marked.length; offset += 4) tones.add(marked[offset]);
  assert.ok(tones.has(20), "pointer outline is visible on light content");
  assert.ok(tones.has(246), "pointer fill is visible on dark content");
  assert.equal(original.every((value) => value === 127), true, "the source bitmap is not mutated");
});

test("typing keeps every key code but throttles expensive foreground context", async (t) => {
  const value = await fixture(t);
  let contextCalls = 0;
  // Replace the fixture with a manager whose provider lets us count calls.
  await value.manager.dispose();
  const directory = join(value.directory, "typing");
  const manager = new recorderModule.RecorderManager({
    rootDirectory: directory,
    platform: "win32",
    inputHook: value.hook,
    captureAdapter: value.capture,
    shortcutAdapter: value.shortcut,
    now: value.time.now,
    monotonicNow: value.time.monotonicNow,
    contextProvider: () => { contextCalls += 1; return { appName: "Editor" }; },
    limits: { keyContextIntervalMs: 750 },
  });
  t.after(async () => manager.dispose());
  await manager.start({ privacyConsent: true });
  for (let index = 0; index < 12; index += 1) {
    value.hook.emit("keydown", { keycode: 30 + index, alt: false, ctrl: false, meta: false, shift: false });
    value.hook.emit("keyup", { keycode: 30 + index, alt: false, ctrl: false, meta: false, shift: false });
    value.time.advance(50);
  }
  const staged = await manager.stop("user");
  const events = (await readFile(staged.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter((event) => event.type === "key-down" || event.type === "key-up").length, 24);
  assert.equal(events.filter((event) => event.type === "context").length, 1);
  assert.equal(contextCalls, 1);
});

test("keyboard records repeat, hold duration, orphaned releases, and interrupted stop releases without text", async (t) => {
  const value = await fixture(t);
  await value.manager.start({ privacyConsent: true });

  value.hook.emit("keydown", { keycode: 30, key: "A", repeat: false, alt: false, ctrl: false, meta: false, shift: false });
  value.time.advance(120);
  value.hook.emit("keydown", { keycode: 30, key: "A", repeat: true, alt: false, ctrl: false, meta: false, shift: false });
  value.time.advance(230);
  value.hook.emit("keyup", { keycode: 30, key: "A", repeat: false, alt: false, ctrl: false, meta: false, shift: false });
  value.time.advance(10);
  value.hook.emit("keyup", { keycode: 48, key: "B", repeat: false, alt: false, ctrl: false, meta: false, shift: false });
  value.hook.emit("keydown", { keycode: 42, key: "Shift", repeat: false, alt: false, ctrl: false, meta: false, shift: true });
  value.time.advance(40);

  const staged = await value.manager.stop("user");
  const events = (await readFile(staged.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const keys = events.filter((event) => event.type === "key-down" || event.type === "key-up");
  assert.equal(keys.length, 6);
  assert.equal(keys[0].key, "A");
  assert.equal(keys[0].repeat, false);
  assert.equal(keys[0].textCaptured, false);
  assert.equal(keys[1].repeat, true);
  assert.equal(keys[1].repeatIndex, 1);
  assert.equal(keys[1].downEventId, keys[0].eventId);
  assert.equal(keys[2].holdDurationMs, 350);
  assert.equal(keys[2].repeatCount, 1);
  assert.equal(keys[2].interrupted, false);
  assert.equal(keys[3].orphaned, true);
  assert.equal(keys[5].key, "Shift");
  assert.equal(keys[5].holdDurationMs, 40);
  assert.equal(keys[5].interrupted, true);
  assert.equal(keys[5].interruptionReason, "user");
  assert.ok(keys.every((event) => event.textCaptured === false));
  assert.ok(keys.every((event) => !("text" in event) && !("character" in event) && !("clipboard" in event)));
});

test("recorder bounds drag path memory under long mouse movement bursts", async (t) => {
  const value = await fixture(t);
  await value.manager.dispose();
  const directory = join(value.directory, "bounded");
  const manager = new recorderModule.RecorderManager({
    rootDirectory: directory,
    platform: "win32",
    inputHook: value.hook,
    captureAdapter: value.capture,
    shortcutAdapter: value.shortcut,
    now: value.time.now,
    monotonicNow: value.time.monotonicNow,
    contextProvider: () => ({ appName: "Editor" }),
    limits: { maxDragPathPoints: 100, maxContextQueue: 1, mouseSampleIntervalMs: 8 },
  });
  t.after(async () => manager.dispose());
  await manager.start({ privacyConsent: true });
  value.hook.emit("mousedown", mouse(10, 10));
  for (let index = 1; index < 20; index += 1) {
    value.time.advance(10);
    value.hook.emit("mousemove", mouse(index * 10, index * 10));
  }
  value.time.advance(10);
  value.hook.emit("mouseup", mouse(250, 250));
  await new Promise((resolve) => setImmediate(resolve));
  const staged = await manager.stop("user");
  const events = (await readFile(staged.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const drag = events.find((event) => event.type === "drag-complete");
  assert.ok(drag.path.length <= 101, "bounded samples plus the exact end point are retained");
  assert.ok(value.live.filter((event) => event.type === "progress").length <= 3, "live UI progress is throttled independently of durable drag samples");
});

test("stop waits for an in-flight drag summary and event paths stay relative after finalize", async (t) => {
  const value = await fixture(t);
  let resolveSummary;
  value.capture.createDragSummary = async (request) => {
    value.capture.summaries.push(request);
    return await new Promise((resolve) => { resolveSummary = resolve; });
  };
  await value.manager.start({ privacyConsent: true });
  value.hook.emit("mousedown", mouse(100, 100));
  value.time.advance(100);
  value.hook.emit("mousemove", mouse(300, 250));
  value.time.advance(100);
  value.hook.emit("mouseup", mouse(500, 400));
  const stopping = value.manager.stop("user");
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  for (let attempt = 0; resolveSummary === undefined && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stopped, false, "stop must await drag postprocessing");
  assert.equal(typeof resolveSummary, "function", "drag postprocessing started");
  resolveSummary({ cropBounds: { x: 0, y: 0, width: 800, height: 540 }, framePaths: [join(value.directory, "old", "summary.jpg")], bytesWritten: 5 });
  await stopping;
  const saved = await value.manager.finalize("Curved drag");
  const events = (await readFile(saved.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const screenshot = events.find((event) => event.type === "screenshot");
  const drag = events.find((event) => event.type === "drag-complete");
  assert.match(screenshot.fullPath, /^screens\/full\//);
  assert.match(screenshot.cursorPath, /^screens\/cursor\//);
  assert.equal(screenshot.cursor.embeddedInImage, true);
  assert.deepEqual(screenshot.cursor.image, screenshot.cursor.screen);
  assert.equal(screenshot.cursor.normalized.x, screenshot.cursor.screen.x / 1919);
  assert.equal(screenshot.cursor.normalized.y, screenshot.cursor.screen.y / 1079);
  assert.match(drag.dragSummary.framePaths[0], /^screens\/drag-summary\//);
  assert.doesNotMatch(JSON.stringify({ screenshot, drag }), /\.recording-|\.staged-/);
});
