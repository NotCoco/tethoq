import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-progressive-startup-${process.pid}-${Date.now()}`);
const bundle = join(outputDirectory, "progressive-startup.mjs");
await mkdir(outputDirectory, { recursive: true });
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

await build({
  stdin: {
    resolveDir: appRoot,
    sourcefile: "progressive-startup-tests.ts",
    loader: "ts",
    contents: `
      export * from "./src/renderer/src/progressive_startup.ts";
      export * from "./src/renderer/src/composer_draft_store.ts";
      export * from "./src/renderer/src/timeline_presentation.ts";
    `,
  },
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "neutral",
});

const state = await import(`file://${bundle.replaceAll("\\", "/")}`);
const provider = (id, detected = true) => ({
  id,
  name: id,
  state: detected ? "online" : "offline",
  detected,
  authenticated: detected,
  capabilities: ["Create Session", "Send Message", "Session History"],
  supportsAttachments: true,
});

const session = (id, providerId, workingDirectory = "C:\\Projects\\ready") => ({
  id,
  providerId,
  title: id,
  state: "idle",
  project: "ready",
  workingDirectory,
  preview: "",
  updatedAt: "2026-08-27T00:00:00.000Z",
  model: "model",
  effort: "medium",
});

test("the first React paint has a progressive shell without selecting a task", () => {
  const shell = state.progressiveStartupSnapshot("2026-08-27T00:00:00.000Z");
  assert.equal(shell.loading, true);
  assert.equal(shell.sessions[0].id, state.progressiveStartupDraftId);
  assert.equal(shell.sessions[0].draft, true);
  assert.equal(shell.sessions[0].provisional, true);
  assert.equal(shell.timelines[state.progressiveStartupDraftId], undefined, "unresolved history must not pretend to be an empty transcript");
});

test("runtime status stays neutral until startup authoritatively settles", () => {
  const shell = state.progressiveStartupSnapshot("2026-08-27T00:00:00.000Z");
  assert.equal(state.presentedRuntimeConnectionState({ runtimeState: "starting", connected: shell.connected, loading: true }), "starting");
  assert.equal(state.presentedRuntimeConnectionState({ runtimeState: "ready", connected: true, loading: true }), "starting", "an early ready event must not outrun snapshot hydration");
  assert.equal(state.presentedRuntimeConnectionState({ runtimeState: "ready", connected: true, loading: false }), "online");
  assert.equal(state.presentedRuntimeConnectionState({ runtimeState: "ready", connected: false, loading: false }), "offline");
  assert.equal(state.presentedRuntimeConnectionState({ runtimeState: "failed", connected: true, loading: true }), "failed", "the startup recovery banner must own an authoritative loading failure");
  assert.equal(state.presentedRuntimeConnectionState({ runtimeState: "failed", connected: true, loading: false }), "offline", "a post-start runtime failure must become a real outage");
});

test("typing and image intent keep the same task identity while providers hydrate", () => {
  const shell = state.progressiveStartupSnapshot("2026-08-27T00:00:00.000Z");
  const ready = session("ready-task", "opencode");
  const hydrated = { ...shell, loading: false, providers: [provider("opencode")], sessions: [ready] };
  const drafts = state.retainedStartupDraftSessions(shell.sessions, hydrated, ready, (id) => id === state.progressiveStartupDraftId);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, state.progressiveStartupDraftId, "the mounted Composer key must remain stable");
  assert.equal(drafts[0].providerId, "opencode");
  assert.equal(drafts[0].workingDirectory, ready.workingDirectory);
  assert.deepEqual(state.resolvedStartupDraftTimelines({ [ready.id]: [{ id: "existing" }] }, drafts), {
    [ready.id]: [{ id: "existing" }],
    [state.progressiveStartupDraftId]: [],
  }, "hydration must resolve a retained local draft as an empty transcript, not an endless skeleton");
  assert.equal(state.selectedSessionAfterStartupHydration(state.progressiveStartupDraftId, drafts, [ready]), state.progressiveStartupDraftId);
  assert.equal(state.retainedStartupDraftSessions(shell.sessions, hydrated, ready, () => false).length, 0, "an untouched provisional draft should disappear cleanly");
});

test("startup hydration preserves only an explicit valid task or draft selection", () => {
  const shell = state.progressiveStartupSnapshot("2026-08-27T00:00:00.000Z");
  const retainedDraft = { ...shell.sessions[0], provisional: false };
  const ready = session("ready-task", "opencode");

  assert.equal(
    state.selectedSessionAfterStartupHydration(null, [retainedDraft], [ready]),
    null,
    "hydration must not automatically select the first available task",
  );
  assert.equal(state.selectedSessionAfterStartupHydration(ready.id, [retainedDraft], [ready]), ready.id);
  assert.equal(state.selectedSessionAfterStartupHydration(retainedDraft.id, [retainedDraft], [ready]), retainedDraft.id);
  assert.equal(
    state.selectedSessionAfterStartupHydration("stale-task", [retainedDraft], [ready]),
    null,
    "a stale task id must not open an empty workspace",
  );
});

test("sessionless workspace navigation presents the dashboard", () => {
  assert.equal(state.presentedNavigationView("workspace", false), "dashboard");
  assert.equal(state.presentedNavigationView("workspace", true), "workspace");
  assert.equal(state.presentedNavigationView("dashboard", false), "dashboard");
});

test("draft materialization rebinds follow-up text, media, workflow, mode, and mesh state", () => {
  const stores = {
    content: { draft: "Follow-up typed while starting" },
    attachments: { draft: [{ path: "new.png", name: "new.png", mimeType: "image/png", byteLength: 3, dataBase64: "AQID" }] },
    workflows: { draft: [{ id: "flow", name: "Flow", promptReference: "workflow://flow", summary: { eventCount: 1, screenshotCount: 1, apps: [] } }] },
    annotations: { draft: [{ id: "note", text: "selected", annotation: "remember" }] },
    modes: { draft: "steer" },
    meshTargets: { draft: [{ providerId: "grok", modelId: "grok-model" }] },
  };
  const retained = state.composerDraftSnapshot(stores, "draft");
  state.rebindComposerDraftState(stores, "draft", "real", retained);
  assert.equal(stores.content.real, "Follow-up typed while starting");
  assert.equal(stores.attachments.real[0].name, "new.png");
  assert.equal(stores.workflows.real[0].id, "flow");
  assert.equal(stores.annotations.real[0].id, "note");
  assert.equal(stores.modes.real, "steer");
  assert.equal(stores.meshTargets.real[0].providerId, "grok");
  for (const store of Object.values(stores)) assert.equal(Object.hasOwn(store, "draft"), false);
});

test("scroll presentation revisions catch same-length text and widget geometry without hashing preview bytes", () => {
  const base = { id: "row", kind: "user", body: "same", timestamp: "2026-08-27T00:00:00.000Z", state: "completed" };
  const baseSignature = state.timelinePresentationSignature([base]);
  assert.notEqual(state.timelinePresentationSignature([{ ...base, body: "size" }]), baseSignature);
  assert.notEqual(state.timelinePresentationSignature([{ ...base, files: [{ name: "notes.txt", mimeType: "text/plain" }] }]), baseSignature);
  const loading = { ...base, images: [{ name: "screen.png", mimeType: "image/png", loading: true }] };
  const readyA = { ...base, images: [{ name: "screen.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AQID" }] };
  const readyB = { ...base, images: [{ name: "screen.png", mimeType: "image/png", dataUrl: "data:image/png;base64,BAUG" }] };
  assert.notEqual(state.timelinePresentationSignature([loading]), state.timelinePresentationSignature([readyA]));
  assert.equal(state.timelinePresentationSignature([readyA]), state.timelinePresentationSignature([readyB]), "base64 payload changes alone must stay off the hot layout path");
});
