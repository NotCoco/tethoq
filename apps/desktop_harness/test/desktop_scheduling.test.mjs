import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-desktop-scheduling-${process.pid}-${Date.now()}`);
const bridgeBundle = join(outputDirectory, "bridge.mjs");
await mkdir(outputDirectory, { recursive: true });

globalThis.window = { tethoqDesktop: {} };
globalThis.location = { hash: "", search: "" };

await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "bridge.ts")],
  outfile: bridgeBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: { "@shared": join(appRoot, "src", "shared") },
});
const { applyActiveScheduledTasks, isScheduledTaskPlaceholderId, mapActiveScheduledTask, mapScheduledTaskPresentation } = await import(`file:///${bridgeBundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

const task = (overrides = {}) => ({
  requestId: "scheduled-one",
  targetSessionId: "scheduled-task:scheduled-one",
  providerId: "codex",
  title: "Scheduled renderer QA",
  workingDirectory: "C:\\project",
  runAt: "2026-08-29T14:05:00.000Z",
  createdAt: "2026-08-29T14:00:00.000Z",
  status: "pending",
  content: "Run the scheduled renderer QA",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "high",
  ...overrides,
});

const session = (id, overrides = {}) => ({
  id,
  providerId: "codex",
  title: "Scheduled renderer QA",
  state: "idle",
  project: "project",
  workingDirectory: "C:\\project",
  preview: "No recent output.",
  updatedAt: "2026-08-29T14:00:00.000Z",
  model: "gpt-5.6-sol",
  effort: "high",
  ...overrides,
});

test("active scheduled-task records map to bounded renderer state", () => {
  assert.equal(isScheduledTaskPlaceholderId("scheduled-task:scheduled-one"), true);
  assert.equal(isScheduledTaskPlaceholderId("host/codex/materialized-one"), false);
  assert.deepEqual(mapActiveScheduledTask(task()), {
    sessionId: "scheduled-task:scheduled-one",
    schedule: {
      id: "scheduled-one",
      runAt: "2026-08-29T14:05:00.000Z",
      status: "pending",
      content: "Run the scheduled renderer QA",
    },
    preview: "Run the scheduled renderer QA",
    session: {
      id: "scheduled-task:scheduled-one",
      providerId: "codex",
      title: "Scheduled renderer QA",
      state: "idle",
      project: "project",
      workingDirectory: "C:\\project",
      preview: "Run the scheduled renderer QA",
      updatedAt: "2026-08-29T14:00:00.000Z",
      model: "gpt-5.6-sol",
      effort: "high",
      schedule: {
        id: "scheduled-one",
        runAt: "2026-08-29T14:05:00.000Z",
        status: "pending",
        content: "Run the scheduled renderer QA",
      },
    },
  });

  assert.deepEqual(mapActiveScheduledTask(task({ status: "dispatching" })).schedule, {
    id: "scheduled-one",
    runAt: "2026-08-29T14:05:00.000Z",
    status: "dispatching",
    content: "Run the scheduled renderer QA",
  });
  const failed = mapActiveScheduledTask(task({
    status: "failed",
    dispatchingAt: "2026-08-29T14:05:00.125Z",
    failedAt: "2026-08-29T14:05:01.000Z",
    failureMessage: "Harness was offline",
  }));
  assert.deepEqual(failed.schedule, {
    id: "scheduled-one",
    runAt: "2026-08-29T14:05:00.000Z",
    status: "failed",
    content: "Run the scheduled renderer QA",
    failure: "Harness was offline",
  });
  assert.equal(failed.session.updatedAt, "2026-08-29T14:05:01.000Z");
  assert.equal(mapActiveScheduledTask(task({ runAt: "not-a-date" })), null);
  assert.equal(mapActiveScheduledTask(task({ targetSessionId: "" })), null);
  assert.equal(mapActiveScheduledTask(task({ status: "cancelled" })), null);
});

test("session hydration applies only active schedules and ignores persisted started audit rows", () => {
  const pendingId = "scheduled-task:scheduled-one";
  const providerPreviewId = "host/opencode/scheduled-two";
  const startedId = "host/grok/scheduled-three";
  const startedAudit = task({
    requestId: "scheduled-three",
    targetSessionId: startedId,
    status: "started",
    startedAt: "2026-08-29T14:05:02.000Z",
  });
  assert.equal(mapActiveScheduledTask(startedAudit), null, "a completed launch audit became an active schedule");

  const originalStartedSession = session(startedId);
  const hydrated = applyActiveScheduledTasks([
    session(providerPreviewId, { providerId: "opencode", preview: "Provider-owned preview" }),
    originalStartedSession,
  ], [
    task(),
    task({ requestId: "scheduled-two", targetSessionId: providerPreviewId, content: "Do not replace provider output" }),
    startedAudit,
  ]);

  assert.equal(hydrated[0].id, pendingId, "the persisted schedule did not synthesize its local placeholder row");
  assert.equal(hydrated[0].preview, "Run the scheduled renderer QA");
  assert.equal(hydrated[0].schedule?.status, "pending");
  assert.equal(hydrated[1].preview, "Provider-owned preview", "schedule hydration replaced a real provider preview");
  assert.equal(hydrated[1].schedule?.id, "scheduled-two");
  assert.equal(hydrated[2], originalStartedSession, "a persisted started audit row changed the provider session");
  assert.equal(hydrated[2].schedule, undefined);
});

test("hydration does not attach a late failed schedule to a provider session which already completed", () => {
  const providerSession = session("host/codex/materialized-one", {
    state: "completed",
    preview: "Provider already completed the scheduled task",
  });
  const hydrated = applyActiveScheduledTasks([providerSession], [task({
    targetSessionId: providerSession.id,
    status: "failed",
    failedAt: "2026-08-29T14:05:01.000Z",
    failureMessage: "Late scheduler transport failure",
  })]);
  assert.deepEqual(hydrated, [providerSession]);
  assert.equal(hydrated[0].schedule, undefined);
});

test("dispatch paints one optimistic user row which failure can retract by stable identity", () => {
  const dispatching = mapScheduledTaskPresentation(task({
    status: "dispatching",
    dispatchingAt: "2026-08-29T14:05:00.125Z",
  }));
  assert.deepEqual(dispatching, {
    sessionId: "scheduled-task:scheduled-one",
    status: "dispatching",
    presentationId: "local-1788012300125",
    item: {
      id: "local-1788012300125",
      presentationId: "local-1788012300125",
      scheduledTaskId: "scheduled-one",
      kind: "user",
      body: "Run the scheduled renderer QA",
      timestamp: "2026-08-29T14:05:00.125Z",
      state: "completed",
    },
  });
  assert.equal(mapScheduledTaskPresentation(task({ status: "pending" })), null);
  assert.equal(mapScheduledTaskPresentation(task({ status: "dispatching", dispatchingAt: "invalid" })), null);
  assert.equal(mapScheduledTaskPresentation(task({ status: "failed", dispatchingAt: "2026-08-29T14:05:00.125Z" }))?.presentationId, dispatching?.presentationId);
  const started = mapScheduledTaskPresentation(task({
    targetSessionId: "host/codex/materialized-one",
    status: "started",
    dispatchingAt: "2026-08-29T14:05:00.125Z",
    startedAt: "2026-08-29T14:05:00.375Z",
  }));
  assert.equal(started?.sessionId, "host/codex/materialized-one");
  assert.equal(started?.presentationId, dispatching?.presentationId, "materialization changed the optimistic row identity");

  const longContent = `${"Long scheduled instruction. ".repeat(12)}Authoritative tail.`;
  const boundedEventContent = `${longContent.slice(0, 177).trimEnd()}…`;
  assert.equal(
    mapScheduledTaskPresentation(task({
      status: "dispatching",
      dispatchingAt: "2026-08-29T14:05:00.125Z",
      content: boundedEventContent,
    }), longContent)?.item.body,
    longContent,
    "the durable prompt must outrank the bounded replay preview",
  );
});

test("an interrupted dispatch warns before an explicitly requested retry", async () => {
  const app = await readFile(join(appRoot, "src", "renderer", "src", "App.tsx"), "utf8");
  assert.match(app, /outcome is uncertain[\s\S]*It may already have started\. Retrying can run it twice\./u);
  assert.match(app, /uncertainOutcome \? "Retry anyway" : "Retry now"/u);
  assert.match(app, /schedule\.status === "failed"[\s\S]*void act\("cancel"\)[\s\S]*Dismiss/u);
});

test("App retains edits made while schedule persistence is pending in a fresh local draft", async () => {
  const [app, composer] = await Promise.all([
    readFile(join(appRoot, "src", "renderer", "src", "App.tsx"), "utf8"),
    readFile(join(appRoot, "src", "renderer", "src", "Composer.tsx"), "utf8"),
  ]);
  assert.match(composer, /scheduledComposerContent,\s*content: scheduledContent/u, "Composer did not pass its exact submitted snapshot to App");
  assert.match(app, /const previousContent = composerDrafts\.current\[input\.draftSessionId\] \?\? "";\s*const retainedContent = clearScheduledDraftContent\(previousContent, input\.scheduledComposerContent\)/u);
  assert.match(app, /const draftWriteTarget: Session = \{[\s\S]*?draft: true/u);
  assert.match(app, /composerDraftSessionAliases\.current\[input\.draftSessionId\] = draftWriteTargetId/u);
  assert.match(app, /latentComposerDraftSessions\.current\[draftWriteTargetId\] = \{[\s\S]*scheduledSessionId: scheduled\.id/u);
  assert.match(app, /rebindComposerDraftState\(composerDraftStore, input\.draftSessionId, draftWriteTargetId, retainedDraft\)/u);
  assert.match(app, /setSelectedSessionId\(retainedSession\?\.id \?\? scheduled\.id\)/u, "App did not select the retained draft or scheduled placeholder");
  assert.match(app, /resolveComposerDraftWriteSessionId\(selectedSession\.id, attachments\.length > 0\)/u, "A late attachment picker cannot materialize its retained draft");
  assert.match(app, /resolveComposerDraftWriteSessionId\(selectedSession\.id, value\.length > 0\)/u, "Late content cannot materialize its retained draft");
});

test("dispatching rows paint the working spinner instead of an overlapping schedule mark", async () => {
  const navigation = await readFile(join(appRoot, "src", "renderer", "src", "NavigationPanels.tsx"), "utf8");
  assert.match(navigation, /session\.state === "working" \? <span className="session-project-working-indicator"[\s\S]*: scheduledIndicator/u);
  assert.match(navigation, /session\.state === "working" \? null : scheduledIndicator \?\? \(session\.pinned \? <PinIcon/u);
});

test("restored placeholders open locally and hide provider-only task actions", async () => {
  const [app, navigation] = await Promise.all([
    readFile(join(appRoot, "src", "renderer", "src", "App.tsx"), "utf8"),
    readFile(join(appRoot, "src", "renderer", "src", "NavigationPanels.tsx"), "utf8"),
  ]);
  assert.match(app, /if \(isScheduledTaskPlaceholderId\(sessionId\)[\s\S]*session\.schedule !== undefined[\s\S]*initialTimelineWindow\(\[\], null\)[\s\S]*return;/u);
  assert.match(app, /if \(!source \|\| source\.draft \|\| source\.schedule \|\| source\.state === "offline"/u);
  assert.match(app, /const contextSessionKey = session && !session\.draft && !session\.schedule \? session\.id : null/u);
  assert.match(app, /if \(!session \|\| session\.draft \|\| session\.schedule\)[\s\S]*setSessionContext\(null\)[\s\S]*return;/u);
  assert.match(app, /session\.draft \|\| session\.schedule \? null : <ContextUsageControl/u);
  assert.match(app, /session\.draft \|\| session\.schedule \? null : <TaskDetailsControl/u);
  assert.match(navigation, /canBranchMenuSession = connected[\s\S]*menuSession\?\.schedule === undefined/u);
  assert.match(navigation, /menuSession\?\.schedule === undefined \? <>[\s\S]*Rename[\s\S]*Pin to top[\s\S]*Branch in New Task/u);
  assert.match(navigation, /Open in File Explorer[\s\S]*menuSession\?\.schedule === undefined \? <button[\s\S]*Archive/u);
});

test("App retracts a failed scheduled presentation only when provider evidence is absent", async () => {
  const app = await readFile(join(appRoot, "src", "renderer", "src", "App.tsx"), "utf8");
  assert.match(app, /const failureCanRetractPresentation = presentation\?\.status === "failed"[\s\S]*scheduledTaskFailureCanRetractPresentation\([\s\S]*presentationSession[\s\S]*presentationTimeline[\s\S]*presentation\.item\.scheduledTaskId[\s\S]*\)[\s\S]*\[event\.sessionId\]: failureCanRetractPresentation[\s\S]*rollbackOptimisticComposerRow/u);
});
