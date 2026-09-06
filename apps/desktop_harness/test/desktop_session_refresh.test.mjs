import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-session-refresh-${process.pid}-${Date.now()}`);
const bundle = join(outputDirectory, "session_refresh.mjs");
const inlineWorkerStubPlugin = {
  name: "inline-worker-stub",
  setup(buildContext) {
    buildContext.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, namespace: "inline-worker-stub" }));
    buildContext.onLoad({ filter: /.*/, namespace: "inline-worker-stub" }, () => ({
      contents: "export default class InlineWorkerStub {}",
      loader: "js",
    }));
  },
};
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "session_refresh.ts")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  plugins: [inlineWorkerStubPlugin],
});
const { mergeAuthoritativeOpenedSession, mergeRefreshedSessions, sameSessionContext, scheduledTaskEventSchedule, scheduledTaskFailureCanRetractPresentation, scheduledTaskHasProviderEvidence, scheduledTaskPresentationState, scheduledTaskScheduleAfterProviderEvidence, withoutRetiredScheduledSessions } = await import(`file:///${bundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

const session = (overrides = {}) => ({
  id: "host/opencode/session-one",
  providerId: "opencode",
  title: "Task",
  state: "working",
  project: "project",
  workingDirectory: "C:\\project",
  preview: "",
  updatedAt: "2026-08-20T10:00:00.000Z",
  model: "deepseek-v4-pro",
  effort: "max",
  ...overrides,
});

test("a refresh response cannot restore a retry cleared by a newer live event", () => {
  const current = session({ updatedAt: "2026-08-20T10:00:02.000Z" });
  const stale = session({
    providerStatus: { kind: "retry", message: "Provider is temporarily busy" },
    updatedAt: "2026-08-20T10:00:01.000Z",
  });

  const merged = mergeRefreshedSessions([current], [stale], undefined, () => true);
  assert.equal(merged[0], current);
  assert.equal(merged[0].providerStatus, undefined);
});

test("an unchanged session still accepts canonical refresh state", () => {
  const current = session({ state: "working" });
  const refreshed = session({ state: "completed", updatedAt: "2026-08-20T10:00:03.000Z" });
  const merged = mergeRefreshedSessions([current], [refreshed], () => true, () => false);
  assert.equal(merged[0], refreshed);
});

test("confirmed interruption rejects stale working snapshots and accepts a newer resumed turn", () => {
  const interruptedAt = "2026-09-06T12:00:00.000Z";
  const stopped = session({ state: "idle", updatedAt: interruptedAt, interruptedAt });
  const stale = session({ state: "working", updatedAt: "2026-09-06T11:59:59.000Z" });
  assert.strictEqual(mergeRefreshedSessions([stopped], [stale])[0], stopped);
  const resumed = session({ state: "working", updatedAt: "2026-09-06T12:00:01.000Z" });
  const reopened = mergeAuthoritativeOpenedSession(stopped, resumed);
  assert.equal(reopened.state, "working");
  assert.equal(reopened.interruptedAt, undefined);
  const confirmed = mergeAuthoritativeOpenedSession(stale, stopped);
  assert.equal(confirmed.state, "idle");
  assert.equal(confirmed.interruptedAt, interruptedAt);
});

test("an authoritative opened task retires stale activity without losing local organisation", () => {
  const current = session({
    providerId: "codex",
    title: "My renamed task",
    renamed: true,
    state: "working",
    externalWriter: true,
    providerStatus: { kind: "retry", message: "Waiting for the old turn" },
    pinned: true,
    unread: 2,
  });
  const opened = session({
    providerId: "codex",
    title: "Provider title",
    state: "idle",
    preview: "Canonical final output",
    updatedAt: "2026-08-20T10:00:03.000Z",
  });

  const merged = mergeAuthoritativeOpenedSession(current, opened);
  assert.equal(merged.state, "idle");
  assert.equal(merged.externalWriter, undefined);
  assert.equal(merged.providerStatus, undefined);
  assert.equal(merged.preview, "Canonical final output");
  assert.equal(merged.title, "My renamed task");
  assert.equal(merged.renamed, true);
  assert.equal(merged.pinned, true);
  assert.equal(merged.unread, 2);
});

test("an older refresh cannot resurrect a terminal failure", () => {
  const current = session({ state: "failed", updatedAt: "2026-08-20T10:00:02.000Z" });
  const stale = session({ state: "working", updatedAt: "2026-08-20T10:00:01.000Z" });
  const merged = mergeRefreshedSessions([current], [stale], undefined, () => false);
  assert.equal(merged[0], current);
});

test("an identical canonical session refresh preserves React identity", () => {
  const current = session({ state: "completed", providerStatus: { kind: "retry", message: "Waiting", retryAt: "2026-08-21T10:01:00.000Z" } });
  const refreshed = structuredClone(current);
  const merged = mergeRefreshedSessions([current], [refreshed], () => true, () => false);
  assert.equal(merged[0], current);
});

test("an accepted Tethoq turn keeps local ownership through a live canonical refresh", () => {
  const current = session({ providerId: "codex", state: "working", externalWriter: false });
  const refreshed = session({ providerId: "codex", state: "working", externalWriter: true, updatedAt: "2026-08-20T10:00:03.000Z" });
  const merged = mergeRefreshedSessions([current], [refreshed], () => false, () => false);
  assert.equal(merged[0].state, "working");
  assert.equal(merged[0].externalWriter, false);
});

test("canonical ownership still applies to a genuinely external turn and after terminal state", () => {
  const idle = session({ providerId: "codex", state: "idle", externalWriter: false });
  const external = session({ providerId: "codex", state: "working", externalWriter: true, updatedAt: "2026-08-20T10:00:03.000Z" });
  assert.equal(mergeRefreshedSessions([idle], [external], () => false, () => false)[0], external);

  const completed = session({ providerId: "codex", state: "completed", externalWriter: false });
  const terminalRefresh = session({ providerId: "codex", state: "completed", externalWriter: true, updatedAt: "2026-08-20T10:00:03.000Z" });
  assert.equal(mergeRefreshedSessions([completed], [terminalRefresh], () => true, () => false)[0], terminalRefresh);
});

const pendingSchedule = (overrides = {}) => ({
  id: "scheduled-one",
  runAt: "2026-08-29T14:05:00.000Z",
  status: "pending",
  content: "Run the complete scheduled instruction",
  ...overrides,
});

test("retired scheduled placeholders cannot be resurrected by a stale refresh", () => {
  const retired = session({ id: "scheduled-task:retired", state: "idle", schedule: pendingSchedule() });
  const current = session({ id: "host/opencode/current" });
  const filtered = withoutRetiredScheduledSessions([retired, current], new Set([retired.id]));
  assert.deepEqual(filtered, [current]);
  assert.equal(filtered[0], current);
});

test("a structurally unchanged schedule preserves the existing React session identity", () => {
  const current = session({ state: "idle", schedule: pendingSchedule() });
  const refreshed = session({ state: "idle", schedule: structuredClone(current.schedule) });
  assert.equal(mergeRefreshedSessions([current], [refreshed], () => true, () => false)[0], current);
});

test("schedule identity, timing, status, failure, and removal are renderer-visible refresh changes", () => {
  const current = session({ state: "idle", schedule: pendingSchedule() });
  for (const changedSchedule of [
    pendingSchedule({ id: "scheduled-two" }),
    pendingSchedule({ runAt: "2026-08-29T14:10:00.000Z" }),
    pendingSchedule({ status: "dispatching" }),
  ]) {
    const changed = session({ state: "idle", schedule: changedSchedule });
    assert.equal(mergeRefreshedSessions([current], [changed], () => true, () => false)[0], changed);
  }
  const failed = session({
    state: "failed",
    schedule: pendingSchedule({ status: "failed", failure: "Harness was offline" }),
  });
  const failedMerge = mergeRefreshedSessions([current], [failed], () => true, () => false);
  assert.equal(failedMerge[0], failed);
  assert.deepEqual(failedMerge[0].schedule, {
    id: "scheduled-one",
    runAt: "2026-08-29T14:05:00.000Z",
    status: "failed",
    content: "Run the complete scheduled instruction",
    failure: "Harness was offline",
  });

  // Once scheduled_task.list contains only the persisted `started` audit row,
  // hydration intentionally returns the provider session without schedule state.
  const afterStartedAudit = session({ state: "working", updatedAt: "2026-08-29T14:05:02.000Z" });
  assert.equal(mergeRefreshedSessions([failed], [afterStartedAudit], () => false, () => false)[0], afterStartedAudit);
  assert.equal(afterStartedAudit.schedule, undefined);
});

test("a newer local schedule event wins over the refresh which triggered it", () => {
  const current = session({ state: "idle", schedule: pendingSchedule({ status: "dispatching" }) });
  const stale = session({ state: "idle", schedule: pendingSchedule() });
  const merged = mergeRefreshedSessions([current], [stale], () => true, () => true);
  assert.equal(merged[0], current);
  assert.equal(merged[0].schedule.status, "dispatching");
});

test("bounded schedule events update status without shortening the durable prompt", () => {
  const full = pendingSchedule({ content: `${"Long instruction. ".repeat(20)}Authoritative tail.` });
  const preview = `${full.content.slice(0, 177).trimEnd()}…`;
  const dispatching = pendingSchedule({ status: "dispatching", content: preview });
  assert.deepEqual(scheduledTaskEventSchedule(full, dispatching), {
    ...dispatching,
    content: full.content,
  });
  assert.equal(scheduledTaskEventSchedule(undefined, dispatching), dispatching);
});

test("a late started schedule acknowledgement never resurrects terminal provider state", () => {
  const final = { id: "final", kind: "assistant", phase: "final_answer", body: "Done", timestamp: "2026-08-29T14:05:01.000Z", state: "completed" };
  const failure = { id: "failure", kind: "error", body: "Stopped", timestamp: "2026-08-29T14:05:01.000Z", state: "failed" };
  assert.equal(scheduledTaskPresentationState(session({ state: "completed" }), [final], "started"), undefined);
  assert.equal(scheduledTaskPresentationState(session({ state: "failed" }), [failure], "started"), undefined);
  assert.equal(scheduledTaskPresentationState(session({ state: "idle" }), [final], "started"), undefined);
  assert.equal(scheduledTaskPresentationState(session({ state: "needs_approval" }), [], "started"), undefined);
  assert.equal(scheduledTaskPresentationState(session({ state: "idle" }), [], "started"), "working");
  assert.equal(scheduledTaskPresentationState(session({ state: "completed" }), [final], "dispatching"), "working");
  assert.equal(scheduledTaskPresentationState(session({ state: "idle" }), [], "failed"), "failed");
});

test("a late scheduler failure cannot override canonical provider evidence", () => {
  const scheduledTaskId = "scheduled-one";
  const final = { id: "final", kind: "assistant", phase: "final_answer", body: "Done", timestamp: "2026-08-29T14:05:01.000Z", state: "completed" };
  const failure = { id: "failure", kind: "error", body: "Provider failed", timestamp: "2026-08-29T14:05:01.000Z", state: "failed" };
  const adoptedUser = { id: "user", kind: "user", body: "Scheduled prompt", scheduledTaskId, messageId: "provider-user-one", timestamp: "2026-08-29T14:05:00.000Z", state: "completed" };
  for (const [providerSession, timeline] of [
    [session({ state: "completed" }), []],
    [session({ state: "needs_approval" }), []],
    [session({ state: "needs_input" }), []],
    [session({ state: "failed" }), []],
    [session({ state: "idle" }), [failure]],
    [session({ state: "idle" }), [final]],
    [session({ state: "idle" }), [adoptedUser]],
  ]) {
    assert.equal(scheduledTaskHasProviderEvidence(providerSession, timeline, scheduledTaskId), true);
    assert.equal(scheduledTaskPresentationState(providerSession, timeline, "failed", scheduledTaskId), undefined);
    assert.equal(scheduledTaskFailureCanRetractPresentation(providerSession, timeline, scheduledTaskId), false);
  }
});

test("provider evidence clears a failed schedule while a genuine scheduler failure remains visible", () => {
  const failedSchedule = pendingSchedule({ status: "failed", failure: "Harness was offline" });
  assert.equal(scheduledTaskScheduleAfterProviderEvidence(session({ state: "completed" }), [], failedSchedule), null);
  assert.equal(scheduledTaskScheduleAfterProviderEvidence(session({ state: "idle" }), [], failedSchedule), failedSchedule);
  const pending = pendingSchedule();
  assert.equal(scheduledTaskScheduleAfterProviderEvidence(session({ state: "completed" }), [], pending), pending);
});

test("a genuine scheduler dispatch failure still fails and retracts its optimistic row", () => {
  const providerSession = session({ state: "idle" });
  assert.equal(scheduledTaskHasProviderEvidence(providerSession, [], "scheduled-one"), false);
  assert.equal(scheduledTaskPresentationState(providerSession, [], "failed", "scheduled-one"), "failed");
  assert.equal(scheduledTaskFailureCanRetractPresentation(providerSession, [], "scheduled-one"), true);
});

test("a restored scheduler-owned failed state remains retractable until the provider supplies evidence", () => {
  const failedSchedule = pendingSchedule({ id: "scheduled-one", status: "failed", failure: "Harness was offline" });
  const restored = session({ state: "failed", schedule: failedSchedule });
  assert.equal(scheduledTaskHasProviderEvidence(restored, [], failedSchedule.id), false);
  assert.equal(scheduledTaskScheduleAfterProviderEvidence(restored, [], failedSchedule), failedSchedule);
  assert.equal(scheduledTaskPresentationState(restored, [], "failed", failedSchedule.id), "failed");
  assert.equal(scheduledTaskFailureCanRetractPresentation(restored, [], failedSchedule.id), true);

  const providerFailure = { id: "provider-failure", kind: "error", body: "Provider failed", timestamp: "2026-08-29T14:05:01.000Z", state: "failed" };
  assert.equal(scheduledTaskHasProviderEvidence(restored, [providerFailure], failedSchedule.id), true);
  assert.equal(scheduledTaskScheduleAfterProviderEvidence(restored, [providerFailure], failedSchedule), null);
});

const context = (overrides = {}) => ({
  sessionId: "host/opencode/session-one",
  modelId: "deepseek-v4-pro",
  usedTokens: 24_000,
  contextWindowTokens: 128_000,
  usedPercent: 18.75,
  compactionThresholdTokens: 96_000,
  minimumThresholdTokens: 32_000,
  supportsManualCompaction: true,
  supportsThreshold: true,
  isCompacting: false,
  compactionKind: null,
  updatedAt: "2026-08-21T10:00:00.000Z",
  usage: { inputTokens: 20_000, outputTokens: 4_000, totalTokens: 24_000, currency: "USD" },
  ...overrides,
});

test("a heartbeat timestamp alone does not turn an unchanged context reading into UI state", () => {
  assert.equal(sameSessionContext(context(), context({ updatedAt: "2026-08-21T10:00:02.500Z" })), true);
});

test("displayed context and usage changes still refresh the UI", () => {
  assert.equal(sameSessionContext(context(), context({ usedTokens: 24_001 })), false);
  assert.equal(sameSessionContext(context(), context({ isCompacting: true, compactionKind: "automatic" })), false);
  assert.equal(sameSessionContext(context(), context({ usage: { inputTokens: 20_001, outputTokens: 4_000, totalTokens: 24_001, currency: "USD" } })), false);
});
