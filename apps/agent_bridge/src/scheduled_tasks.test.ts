import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_SECURE_FRAME_BYTES } from "../../../packages/protocol/src/secure_transport.js";
import {
  maxScheduledTaskContentLength,
  maxScheduledTaskFailureMessageLength,
  maxScheduledTaskListPayloadBytes,
  maxScheduledTaskStateBytes,
  maxScheduledTaskTargetSessionIdLength,
  projectedScheduledTaskStateBytes,
  scheduledTaskListPayloadBytes,
  ScheduledTaskStore,
  type ScheduledTask,
  type ScheduledTaskPersistence,
  type ScheduledTaskState,
  validateScheduledTask,
  validateScheduledTaskState,
} from "./scheduled_task_store.js";
import {
  interruptedScheduledTaskFailureMessage,
  openScheduledTaskScheduler,
  type CreateScheduledTaskInput,
  type ScheduledTaskChange,
} from "./scheduled_tasks.js";

class MemoryScheduledTaskStore implements ScheduledTaskPersistence {
  public state: ScheduledTaskState;
  public readonly writes: ScheduledTaskState[] = [];
  public failNextWrite = false;

  public constructor(state: ScheduledTaskState = { version: 1, tasks: [] }) {
    this.state = validateScheduledTaskState(state);
  }

  public async read(): Promise<ScheduledTaskState> {
    return validateScheduledTaskState(this.state);
  }

  public async write(tasks: readonly ScheduledTask[]): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("scheduled-task storage temporarily unavailable");
    }
    this.state = validateScheduledTaskState({ version: 1, tasks });
    this.writes.push(this.state);
  }

  public async flush(): Promise<void> {}
}

class ManualClock {
  public now: number;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  #nextId = 1;

  public constructor(now: number) {
    this.now = now;
  }

  public readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  public readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.#timers.delete(handle);
  };

  public get timerCount(): number {
    return this.#timers.size;
  }

  public advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      this.now = next[1].at;
      this.#timers.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

class WallJumpClock {
  public now: number;
  public armedDelayMs: number | null = null;
  #timer: { readonly id: number; readonly callback: () => void } | null = null;
  #nextId = 1;

  public constructor(now: number) {
    this.now = now;
  }

  public readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId++;
    this.armedDelayMs = delayMs;
    this.#timer = { id, callback };
    return id;
  };

  public readonly clearTimeout = (handle: unknown): void => {
    if (this.#timer?.id === handle) this.#timer = null;
  };

  public jumpWallClockBy(milliseconds: number): void {
    this.now += milliseconds;
  }

  public elapseArmedDelay(): void {
    const timer = this.#timer;
    const delayMs = this.armedDelayMs;
    assert.ok(timer && delayMs !== null);
    this.#timer = null;
    this.now += delayMs;
    timer.callback();
  }
}

const start = Date.parse("2026-08-29T10:00:00.000Z");

function creation(requestId: string, targetSessionId: string, runAt: number): CreateScheduledTaskInput {
  return {
    requestId,
    targetSessionId,
    providerId: "fake",
    modelId: "fake-model",
    reasoningEffort: "high",
    workingDirectory: "C:\\workspace",
    title: `Scheduled ${requestId}`,
    content: `Start ${requestId}`,
    runAt: new Date(runAt).toISOString(),
  };
}

function pendingRecord(requestId: string, targetSessionId: string, runAt: number): ScheduledTask {
  return validateScheduledTask({
    kind: "new_task",
    ...creation(requestId, targetSessionId, runAt),
    createdAt: new Date(start - 10 * 60_000).toISOString(),
    status: "pending",
  });
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("a five-minute task persists before dispatch and uses one nearest timer", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const dispatches: string[] = [];
  const changes: ScheduledTaskChange[] = [];
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (change) => { changes.push(change); },
    dispatch: async (task) => {
      assert.equal(store.state.tasks.find((candidate) => candidate.requestId === task.requestId)?.status, "dispatching");
      assert.equal(changes.at(-1)?.task.status, "dispatching");
      dispatches.push(task.requestId);
    },
  });
  assert.equal(clock.timerCount, 0);
  await scheduler.start();
  await scheduler.start();

  const input = creation("schedule-five", "host/fake/session-five", start + 5 * 60_000);
  assert.equal((await scheduler.create(input)).status, "pending");
  assert.equal(clock.timerCount, 1);
  assert.equal(store.writes.at(-1)?.tasks[0]?.status, "pending");

  // A confirmation retry with the same stable ID is idempotent.
  assert.equal((await scheduler.create(input)).requestId, input.requestId);
  assert.equal(scheduler.list().length, 1);
  assert.equal(changes.length, 1);

  clock.advanceBy(5 * 60_000 - 1);
  await scheduler.flush();
  assert.deepEqual(dispatches, []);

  clock.advanceBy(1);
  await scheduler.flush();
  assert.deepEqual(dispatches, [input.requestId]);
  assert.equal(scheduler.get(input.requestId)?.status, "started");
  assert.deepEqual(changes.map((change) => `${change.reason}:${change.task.status}`), [
    "created:pending",
    "updated:dispatching",
    "updated:started",
  ]);
  assert.deepEqual(store.writes.map((state) => state.tasks[0]?.status), ["pending", "dispatching", "started"]);
  assert.equal(clock.timerCount, 0);

  await Promise.all([scheduler.reconcile(), scheduler.reconcile()]);
  assert.deepEqual(dispatches, [input.requestId], "repeated reconciliation must not dispatch twice");
  await scheduler.dispose();
});

test("scheduled Mesh targets persist as isolated clones and participate in creation idempotency", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async () => undefined,
  });
  const mutableTargets = [
    { providerId: "grok", modelId: "grok-4.6", reasoningEffort: "high" },
    { providerId: "codex", modelId: "gpt-5.6-luna", reasoningEffort: "max" },
  ];
  const input = {
    ...creation("schedule-mesh-clones", "host/fake/schedule-mesh-clones", start + 5 * 60_000),
    meshTargets: mutableTargets,
  };
  const expectedTargets = mutableTargets.map((target) => ({ ...target }));
  const created = await scheduler.create(input);
  assert.deepEqual(created.meshTargets, expectedTargets);
  assert.deepEqual((await scheduler.create({ ...input, meshTargets: expectedTargets.map((target) => ({ ...target })) })).meshTargets, expectedTargets);

  await assert.rejects(
    () => scheduler.create({
      ...input,
      meshTargets: [{ providerId: "grok", modelId: "grok-4.6", reasoningEffort: "low" }],
    }),
    /request ID is already in use/u,
  );

  mutableTargets[0]!.modelId = "mutated-input";
  (created.meshTargets![0] as { modelId?: string }).modelId = "mutated-result";
  assert.deepEqual(scheduler.get(input.requestId)?.meshTargets, expectedTargets);
  assert.deepEqual(store.state.tasks[0]?.meshTargets, expectedTargets);
  await scheduler.dispose();
});

test("an awake forward wall-clock adjustment dispatches at the next bounded reconciliation", async () => {
  const clock = new WallJumpClock(start);
  const store = new MemoryScheduledTaskStore();
  const dispatches: string[] = [];
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async (task) => { dispatches.push(task.requestId); },
  });
  await scheduler.start();
  await scheduler.create(creation("wall-clock-forward", "host/fake/wall-clock-forward", start + 5 * 60_000));
  assert.equal(clock.armedDelayMs, 30_000, "far-future schedules keep a bounded wall-clock checkpoint");

  clock.jumpWallClockBy(5 * 60_000);
  clock.elapseArmedDelay();
  await scheduler.flush();
  assert.deepEqual(dispatches, ["wall-clock-forward"]);
  await scheduler.dispose();
});

test("an accepted dispatch durably replaces its placeholder exactly once", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const changes: ScheduledTaskChange[] = [];
  const dispatches: ScheduledTask[] = [];
  const placeholderId = "scheduled-task:retarget-me";
  const realSessionId = "host/fake/process-two";
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (change) => { changes.push(change); },
    dispatch: async (task) => {
      dispatches.push(task);
      return { targetSessionId: realSessionId };
    },
  });
  await scheduler.start();
  const input = creation("retarget-me", placeholderId, start + 5 * 60_000);
  await scheduler.create(input);

  clock.advanceBy(5 * 60_000);
  await scheduler.flush();
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0]?.targetSessionId, placeholderId);
  assert.equal(dispatches[0]?.requestId, input.requestId);
  const started = scheduler.get(input.requestId);
  assert.equal(started?.status, "started");
  assert.equal(started?.targetSessionId, realSessionId);
  assert.equal(store.state.tasks[0]?.targetSessionId, realSessionId);
  assert.deepEqual(changes.at(-1), {
    reason: "updated",
    task: started,
    previousTargetSessionId: placeholderId,
  });

  await Promise.all([scheduler.reconcile(), scheduler.reconcile()]);
  assert.equal(dispatches.length, 1);
  assert.equal(changes.filter((change) => change.previousTargetSessionId === placeholderId).length, 1);
  await scheduler.dispose();
});

test("dispatch-time materialization survives failure and retry reuses the provider task", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const changes: ScheduledTaskChange[] = [];
  const dispatchTargets: string[] = [];
  const placeholderId = "scheduled-task:materialized-retry";
  const realSessionId = "host/fake/materialized-retry";
  let attempt = 0;
  let scheduler!: Awaited<ReturnType<typeof openScheduledTaskScheduler>>;
  scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (change) => { changes.push(change); },
    dispatch: async (task) => {
      attempt += 1;
      dispatchTargets.push(task.targetSessionId);
      if (attempt === 1) {
        const materialized = await scheduler.materializeTargetSession(task.requestId, realSessionId);
        assert.equal(materialized.status, "dispatching");
        assert.equal(materialized.targetSessionId, realSessionId);
        assert.equal(store.state.tasks[0]?.targetSessionId, realSessionId);
        const writeCount = store.writes.length;
        const changeCount = changes.length;
        assert.equal(
          (await scheduler.materializeTargetSession(task.requestId, realSessionId)).targetSessionId,
          realSessionId,
        );
        assert.equal(store.writes.length, writeCount, "same-target materialization rewrote durable state");
        assert.equal(changes.length, changeCount, "same-target materialization emitted another change");
        throw new Error("first prompt was rejected");
      }
      assert.equal(task.targetSessionId, realSessionId, "retry did not reuse the materialized provider task");
      const writeCount = store.writes.length;
      const changeCount = changes.length;
      await scheduler.materializeTargetSession(task.requestId, realSessionId);
      assert.equal(store.writes.length, writeCount);
      assert.equal(changes.length, changeCount);
    },
  });
  await scheduler.start();
  await scheduler.create(creation("materialized-retry", placeholderId, start + 60 * 60_000));
  await scheduler.runNow("materialized-retry");
  await scheduler.flush();

  const failed = scheduler.get("materialized-retry");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.targetSessionId, realSessionId);
  assert.equal(store.state.tasks[0]?.targetSessionId, realSessionId);
  const remaps = changes.filter((change) => change.previousTargetSessionId !== undefined);
  assert.equal(remaps.length, 1);
  assert.equal(remaps[0]?.reason, "updated");
  assert.equal(remaps[0]?.previousTargetSessionId, placeholderId);
  assert.equal(remaps[0]?.task.status, "dispatching");
  assert.equal(remaps[0]?.task.targetSessionId, realSessionId);
  assert.equal(changes.find((change) => change.task.status === "failed")?.previousTargetSessionId, undefined);

  await scheduler.retry("materialized-retry");
  await scheduler.flush();
  assert.deepEqual(dispatchTargets, [placeholderId, realSessionId]);
  assert.equal(scheduler.get("materialized-retry")?.status, "started");
  assert.equal(scheduler.get("materialized-retry")?.targetSessionId, realSessionId);
  assert.equal(changes.filter((change) => change.previousTargetSessionId !== undefined).length, 1);
  await scheduler.dispose();
});

test("materialization rejects conflicting provider targets without changing durable state", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const changes: ScheduledTaskChange[] = [];
  let releaseDispatches!: () => void;
  const held = new Promise<void>((resolve) => { releaseDispatches = resolve; });
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (change) => { changes.push(change); },
    dispatch: async () => { await held; },
  });
  await scheduler.start();
  await scheduler.create(creation("materialize-first", "scheduled-task:materialize-first", start + 60 * 60_000));
  await scheduler.create(creation("materialize-second", "scheduled-task:materialize-second", start + 60 * 60_000));
  await scheduler.runNow("materialize-first");
  const realSessionId = "host/fake/shared-provider-target";
  await scheduler.materializeTargetSession("materialize-first", realSessionId);
  const writesAfterMaterialization = store.writes.length;
  const changesAfterMaterialization = changes.length;
  await assert.rejects(
    () => scheduler.materializeTargetSession("materialize-first", "host/fake/different-provider-target"),
    /already targets a provider session/,
  );

  await scheduler.runNow("materialize-second");
  await assert.rejects(
    () => scheduler.materializeTargetSession("materialize-second", realSessionId),
    /target session is already in use/,
  );
  assert.equal(store.writes.length, writesAfterMaterialization + 2, "rejected remap mutated durable state");
  assert.equal(changes.length, changesAfterMaterialization + 2, "rejected remap emitted a change");
  assert.equal(scheduler.get("materialize-first")?.targetSessionId, realSessionId);
  assert.equal(scheduler.get("materialize-second")?.targetSessionId, "scheduled-task:materialize-second");

  releaseDispatches();
  await scheduler.flush();
  assert.equal(scheduler.get("materialize-first")?.targetSessionId, realSessionId);
  assert.equal(scheduler.get("materialize-second")?.targetSessionId, "scheduled-task:materialize-second");
  await scheduler.dispose();
});

test("same-time providers begin independently when one dispatch is slow", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const dispatches: string[] = [];
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async (task) => {
      dispatches.push(task.requestId);
      if (task.requestId === "slow-codex") await slow;
    },
  });
  await scheduler.start();
  const runAt = start + 5 * 60_000;
  await scheduler.create(creation("slow-codex", "host/codex/slow", runAt));
  await scheduler.create(creation("fast-opencode", "host/opencode/fast", runAt));
  await scheduler.create(creation("fast-grok", "host/grok/fast", runAt));

  clock.advanceBy(5 * 60_000);
  for (let index = 0; index < 10 && dispatches.length < 3; index += 1) await nextTurn();
  assert.deepEqual(dispatches, ["slow-codex", "fast-opencode", "fast-grok"]);
  assert.equal(scheduler.get("slow-codex")?.status, "dispatching");

  releaseSlow();
  await scheduler.flush();
  assert.deepEqual(scheduler.list().map((task) => task.status), ["started", "started", "started"]);
  await scheduler.dispose();
});

test("a failed settlement write retries persistence without dispatching the task twice", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const dispatches: string[] = [];
  const errors: string[] = [];
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)); },
    dispatch: async (task) => {
      dispatches.push(task.requestId);
      store.failNextWrite = true;
    },
  });
  await scheduler.start();
  await scheduler.create(creation("settlement-retry", "host/codex/settlement-retry", start + 5 * 60_000));

  clock.advanceBy(5 * 60_000);
  for (let index = 0; index < 10 && errors.length === 0; index += 1) await nextTurn();
  assert.deepEqual(dispatches, ["settlement-retry"]);
  assert.equal(scheduler.get("settlement-retry")?.status, "dispatching");
  assert.deepEqual(errors, ["scheduled-task storage temporarily unavailable"]);
  assert.equal(clock.timerCount, 1, "the failed settlement did not arm a persistence-only retry");

  clock.advanceBy(1_000);
  await scheduler.flush();
  assert.deepEqual(dispatches, ["settlement-retry"], "settlement recovery resent an accepted prompt");
  assert.equal(scheduler.get("settlement-retry")?.status, "started");
  assert.equal(clock.timerCount, 0);
  await scheduler.dispose();
});

test("a failed due-transition write backs off instead of spinning at zero delay", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const dispatches: string[] = [];
  const errors: string[] = [];
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onError: (error) => { errors.push(error instanceof Error ? error.message : String(error)); },
    dispatch: async (task) => { dispatches.push(task.requestId); },
  });
  await scheduler.start();
  await scheduler.create(creation("transition-backoff", "host/fake/transition-backoff", start + 5 * 60_000));
  store.failNextWrite = true;

  clock.advanceBy(5 * 60_000);
  for (let index = 0; index < 10 && errors.length === 0; index += 1) await nextTurn();
  assert.deepEqual(errors, ["scheduled-task storage temporarily unavailable"]);
  assert.deepEqual(dispatches, []);
  assert.equal(scheduler.get("transition-backoff")?.status, "pending");
  assert.equal(clock.timerCount, 1, "the failed due transition did not retain one bounded retry");

  clock.advanceBy(999);
  await nextTurn();
  assert.deepEqual(errors, ["scheduled-task storage temporarily unavailable"], "the due row retried before its backoff elapsed");
  assert.deepEqual(dispatches, []);

  clock.advanceBy(1);
  await scheduler.flush();
  assert.deepEqual(dispatches, ["transition-backoff"]);
  assert.equal(scheduler.get("transition-backoff")?.status, "started");
  await scheduler.dispose();
});

test("dispose drains a known provider outcome after a one-time settlement write failure", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const realSessionId = "host/fake/dispose-settlement";
  let dispatchCount = 0;
  let scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async () => {
      dispatchCount += 1;
      store.failNextWrite = true;
      return { targetSessionId: realSessionId };
    },
  });
  await scheduler.start();
  await scheduler.create(creation("dispose-settlement", "scheduled-task:dispose-settlement", start + 60 * 60_000));
  await scheduler.runNow("dispose-settlement");
  await scheduler.dispose();

  assert.equal(dispatchCount, 1);
  assert.equal(store.state.tasks[0]?.status, "started");
  assert.equal(store.state.tasks[0]?.targetSessionId, realSessionId);

  scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async () => { dispatchCount += 1; },
  });
  assert.equal(scheduler.get("dispose-settlement")?.status, "started");
  assert.equal(scheduler.get("dispose-settlement")?.targetSessionId, realSessionId);
  await scheduler.start();
  await scheduler.flush();
  assert.equal(dispatchCount, 1, "restart resent a provider-accepted prompt");
  await scheduler.dispose();
});

test("dispose drains an in-flight provider creation through materialization", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const placeholderId = "scheduled-task:dispose-materialization";
  const realSessionId = "host/fake/dispose-materialization";
  let releaseProviderCreation!: () => void;
  let providerCreationStarted!: () => void;
  const providerCreation = new Promise<void>((resolve) => { releaseProviderCreation = resolve; });
  const providerCreationStart = new Promise<void>((resolve) => { providerCreationStarted = resolve; });
  let scheduler!: Awaited<ReturnType<typeof openScheduledTaskScheduler>>;
  scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async (task) => {
      providerCreationStarted();
      await providerCreation;
      await scheduler.materializeTargetSession(task.requestId, realSessionId);
      throw new Error("bridge shut down before the prompt send");
    },
  });
  await scheduler.start();
  await scheduler.create(creation("dispose-materialization", placeholderId, start + 60 * 60_000));
  await scheduler.runNow("dispose-materialization");
  await providerCreationStart;

  const disposal = scheduler.dispose();
  releaseProviderCreation();
  await disposal;

  assert.equal(store.state.tasks[0]?.status, "failed");
  assert.equal(store.state.tasks[0]?.targetSessionId, realSessionId);
  assert.equal(scheduler.get("dispose-materialization")?.targetSessionId, realSessionId);
});

test("a failed materialization write keeps and reuses the provider target", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const changes: ScheduledTaskChange[] = [];
  const placeholderId = "scheduled-task:materialization-write-retry";
  const realSessionId = "host/fake/materialization-write-retry";
  const dispatchTargets: string[] = [];
  let attempt = 0;
  let scheduler!: Awaited<ReturnType<typeof openScheduledTaskScheduler>>;
  scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (change) => { changes.push(change); },
    dispatch: async (task) => {
      attempt += 1;
      dispatchTargets.push(task.targetSessionId);
      if (attempt === 1) {
        store.failNextWrite = true;
        await scheduler.materializeTargetSession(task.requestId, realSessionId);
      }
    },
  });
  await scheduler.start();
  await scheduler.create(creation(
    "materialization-write-retry",
    placeholderId,
    start + 60 * 60_000,
  ));
  await scheduler.runNow("materialization-write-retry");
  await scheduler.flush();

  assert.equal(scheduler.get("materialization-write-retry")?.status, "failed");
  assert.equal(scheduler.get("materialization-write-retry")?.targetSessionId, realSessionId);
  assert.equal(store.state.tasks[0]?.targetSessionId, realSessionId);
  assert.equal(
    changes.filter((change) => change.previousTargetSessionId === placeholderId).length,
    1,
    "the recovered materialization did not emit exactly one placeholder remap",
  );

  await scheduler.retry("materialization-write-retry");
  await scheduler.flush();
  assert.deepEqual(dispatchTargets, [placeholderId, realSessionId]);
  assert.equal(scheduler.get("materialization-write-retry")?.status, "started");
  assert.equal(scheduler.get("materialization-write-retry")?.targetSessionId, realSessionId);
  await scheduler.dispose();
});

test("startup fails stale dispatching records and reconciles overdue pending records once", async () => {
  const clock = new ManualClock(start);
  const stalePending = pendingRecord("stale", "host/fake/stale", start - 5 * 60_000);
  const staleDispatching = validateScheduledTask({
    ...stalePending,
    status: "dispatching",
    dispatchingAt: new Date(start - 4 * 60_000).toISOString(),
  });
  const overdue = pendingRecord("overdue", "host/fake/overdue", start - 60_000);
  const store = new MemoryScheduledTaskStore({ version: 1, tasks: [staleDispatching, overdue] });
  const dispatches: string[] = [];
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async (task) => { dispatches.push(task.requestId); },
  });

  assert.deepEqual(dispatches, [], "opening must not dispatch before providers are ready");
  assert.equal(clock.timerCount, 0);
  assert.equal(scheduler.get("stale")?.status, "failed");
  await scheduler.start();
  await scheduler.flush();
  assert.deepEqual(dispatches, ["overdue"]);
  const stale = scheduler.get("stale");
  assert.equal(stale?.status, "failed");
  assert.equal(stale?.failureMessage, interruptedScheduledTaskFailureMessage);
  assert.equal(stale?.failedAt, new Date(start).toISOString());
  assert.equal(scheduler.get("overdue")?.status, "started");

  await scheduler.reconcile();
  await scheduler.reconcile();
  assert.deepEqual(dispatches, ["overdue"]);

  const retried = await scheduler.retry("stale");
  assert.equal(retried.status, "dispatching");
  await scheduler.flush();
  assert.equal(scheduler.get("stale")?.status, "started");
  assert.equal(retried.requestId, "stale");
  assert.deepEqual(dispatches, ["overdue", "stale"]);
  await scheduler.dispose();
});

test("run now, cancellation, and failure transitions enforce their status gates", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const changes: ScheduledTaskChange[] = [];
  let attempt = 0;
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onChange: (change) => { changes.push(change); },
    dispatch: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("provider unavailable\u0000temporarily");
    },
  });
  await scheduler.start();

  await scheduler.create(creation("run-now", "host/fake/run-now", start + 60 * 60_000));
  const failed = await scheduler.runNow("run-now");
  assert.equal(failed.status, "dispatching");
  await scheduler.flush();
  const failedAfterDispatch = scheduler.get("run-now");
  assert.equal(failedAfterDispatch?.status, "failed");
  assert.equal(failedAfterDispatch?.failureMessage, "provider unavailable temporarily");
  assert.equal(failedAfterDispatch?.failedAt, new Date(start).toISOString());
  await assert.rejects(() => scheduler.runNow("run-now"), /Only a pending/);

  assert.equal((await scheduler.retry("run-now")).status, "dispatching");
  await scheduler.flush();
  assert.equal(scheduler.get("run-now")?.status, "started");
  await assert.rejects(() => scheduler.retry("run-now"), /Only a failed/);

  await scheduler.create(creation("cancel-me", "host/fake/cancel-me", start + 2 * 60 * 60_000));
  const cancelled = await scheduler.cancel("cancel-me");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(scheduler.get("cancel-me")?.status, "cancelled");
  assert.equal(changes.at(-1)?.reason, "cancelled");

  attempt = 0;
  await scheduler.create(creation("dismiss-failed", "host/fake/dismiss-failed", start + 3 * 60 * 60_000));
  await scheduler.runNow("dismiss-failed");
  await scheduler.flush();
  assert.equal(scheduler.get("dismiss-failed")?.status, "failed");
  await scheduler.cancel("dismiss-failed");
  assert.equal(scheduler.get("dismiss-failed")?.status, "cancelled");
  await scheduler.dispose();
});

test("create replay remains idempotent after run-time mutation, materialization, cancellation, and restart", async () => {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore();
  const input = creation("durable-create-replay", "scheduled-task:durable-create-replay", start + 60 * 60_000);
  const realSessionId = "host/fake/durable-create-replay";
  let dispatchCount = 0;
  let scheduler!: Awaited<ReturnType<typeof openScheduledTaskScheduler>>;
  scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async (task) => {
      dispatchCount += 1;
      await scheduler.materializeTargetSession(task.requestId, realSessionId);
      throw new Error("provider refused the first prompt");
    },
  });
  await scheduler.start();
  await scheduler.create(input);
  await scheduler.runNow(input.requestId);
  await scheduler.flush();
  assert.equal(scheduler.get(input.requestId)?.status, "failed");
  assert.equal(scheduler.get(input.requestId)?.targetSessionId, realSessionId);
  assert.equal(scheduler.get(input.requestId)?.runAt, new Date(start).toISOString());
  assert.equal((await scheduler.create(input)).status, "failed", "the original create replay was rejected after mutable fields changed");

  const cancelled = await scheduler.cancel(input.requestId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await scheduler.create(input)).status, "cancelled", "the original create replay recreated a cancelled schedule");
  await scheduler.dispose();

  scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async () => { dispatchCount += 1; },
  });
  await scheduler.start();
  assert.equal((await scheduler.create(input)).status, "cancelled");
  assert.equal(dispatchCount, 1, "restart replay dispatched a cancelled schedule again");
  await assert.rejects(() => scheduler.create({ ...input, title: "Conflicting replay" }), /request ID is already in use/u);
  await scheduler.dispose();
});

test("creation prunes the oldest started audit row without evicting active or failed work", async () => {
  const clock = new ManualClock(start);
  const startedRows = Array.from({ length: 998 }, (_, index) => {
    const pending = pendingRecord(`started-${index}`, `host/fake/started-${index}`, start + 5 * 60_000);
    return validateScheduledTask({
      ...pending,
      status: "started",
      dispatchingAt: new Date(start - (2_000 - index) * 1_000).toISOString(),
      startedAt: new Date(start - (1_000 - index) * 1_000).toISOString(),
    });
  });
  const protectedPending = pendingRecord("protected-pending", "host/fake/protected-pending", start + 60 * 60_000);
  const failedBase = pendingRecord("protected-failed", "host/fake/protected-failed", start - 60_000);
  const protectedFailed = validateScheduledTask({
    ...failedBase,
    status: "failed",
    dispatchingAt: new Date(start - 30_000).toISOString(),
    failedAt: new Date(start - 20_000).toISOString(),
    failureMessage: "Provider rejected the request",
  });
  const store = new MemoryScheduledTaskStore({
    version: 1,
    tasks: [...startedRows, protectedPending, protectedFailed],
  });
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async () => {},
  });

  await scheduler.create(creation("replacement", "host/fake/replacement", start + 2 * 60 * 60_000));
  assert.equal(scheduler.list().length, 1_000);
  assert.equal(scheduler.get("started-0"), undefined);
  assert.equal(scheduler.get("started-1")?.status, "started");
  assert.equal(scheduler.get("protected-pending")?.status, "pending");
  assert.equal(scheduler.get("protected-failed")?.status, "failed");
  assert.equal(scheduler.get("replacement")?.status, "pending");
  assert.equal(clock.timerCount, 0, "creation before start must not arm timers");
  await scheduler.dispose();
});

test("capacity validation reserves every active row's largest transition and a transport-safe list", () => {
  assert.ok(
    maxScheduledTaskListPayloadBytes + 1024 * 1024 <= MAX_SECURE_FRAME_BYTES,
    "the active-list budget must retain room for its response envelope and authentication tag",
  );
  const largeContent = "x".repeat(maxScheduledTaskContentLength);
  const pending = Array.from({ length: 70 }, (_, index) => validateScheduledTask({
    ...pendingRecord(`reserved-${index}`, `scheduled-task:reserved-${index}`, start + 5 * 60_000),
    content: largeContent,
  }));
  const actualBytes = Buffer.byteLength(JSON.stringify({ version: 1, tasks: pending }), "utf8");
  assert.ok(actualBytes < maxScheduledTaskStateBytes, "fixture must fit without transition reservation");
  assert.ok(scheduledTaskListPayloadBytes(pending) < maxScheduledTaskListPayloadBytes, "fixture must fit the active-list budget");
  assert.ok(projectedScheduledTaskStateBytes(pending) > maxScheduledTaskStateBytes, "fixture must exceed only after future transitions are reserved");
  assert.throws(
    () => validateScheduledTaskState({ version: 1, tasks: pending }),
    /transition capacity/u,
  );
});

test("transition capacity covers maximally escaped provider targets and failures", () => {
  const pending = pendingRecord("escaped-transition", "scheduled-task:escaped-transition", start + 5 * 60_000);
  const worstAllowedTransition = validateScheduledTask({
    ...pending,
    targetSessionId: "\ud800".repeat(maxScheduledTaskTargetSessionIdLength),
    status: "failed",
    dispatchingAt: new Date(start).toISOString(),
    failedAt: new Date(start).toISOString(),
    failureMessage: "\ud800".repeat(maxScheduledTaskFailureMessageLength),
  });
  const actualTransitionBytes = Buffer.byteLength(JSON.stringify({ version: 1, tasks: [worstAllowedTransition] }), "utf8");
  assert.ok(
    projectedScheduledTaskStateBytes([pending]) >= actualTransitionBytes,
    "preflight reservation must cover JSON escaping in every transition-controlled string",
  );
});

test("the JSON store validates controls, canonical ISO times, record identity, and bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-scheduled-tasks-"));
  const path = join(directory, "scheduled-tasks.json");
  try {
    const task = pendingRecord("persisted", "host/fake/persisted", start + 5 * 60_000);
    const store = new ScheduledTaskStore(path);
    await store.write([task]);
    await store.flush();
    assert.deepEqual((await new ScheduledTaskStore(path).read()).tasks, [task]);
    assert.match(await readFile(path, "utf8"), /"version": 1/);

    assert.throws(() => validateScheduledTask({ ...task, providerId: "fake\u0000provider" }), /provider ID is invalid/);
    assert.throws(() => validateScheduledTask({ ...task, runAt: "2026-08-29T10:05:00+00:00" }), /run time is invalid/);
    assert.throws(
      () => validateScheduledTaskState({ version: 1, tasks: [task, { ...task }] }),
      /duplicate request IDs/,
    );

    const largeContent = "x".repeat(100_000);
    const oversized = Array.from({ length: 84 }, (_, index) => validateScheduledTask({
      ...task,
      requestId: `large-${index}`,
      targetSessionId: `host/fake/large-${index}`,
      content: largeContent,
    }));
    assert.throws(() => validateScheduledTaskState({ version: 1, tasks: oversized }), /byte limit/);

    await writeFile(path, JSON.stringify({ version: 1, tasks: [{ ...task, title: "bad\nline" }] }), "utf8");
    await assert.rejects(() => new ScheduledTaskStore(path).read(), /title is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
