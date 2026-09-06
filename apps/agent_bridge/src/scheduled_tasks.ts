import type {
  DelegationTarget,
} from "../../../packages/protocol/src/index.js";
import type {
  ScheduledTask,
  ScheduledTaskPersistence,
} from "./scheduled_task_store.js";
import {
  isScheduledTaskPlaceholderId,
  maxScheduledTaskListPayloadBytes,
  maxScheduledTaskRecords,
  maxScheduledTaskStateBytes,
  projectedScheduledTaskStateBytes,
  scheduledTaskListPayloadBytes,
  scheduledTaskPlaceholderId,
  validateScheduledTask,
} from "./scheduled_task_store.js";

const maximumTimerDelayMs = 2_147_483_647;
const settlementPersistenceRetryMs = 1_000;
const wallClockReconciliationIntervalMs = 30_000;

export const interruptedScheduledTaskFailureMessage =
  "The prior dispatch was interrupted and its outcome is uncertain. Retry explicitly if needed.";

export interface CreateScheduledTaskInput {
  readonly requestId: string;
  readonly targetSessionId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly meshTargets?: readonly DelegationTarget[];
  readonly workingDirectory: string;
  readonly title: string;
  readonly content: string;
  readonly runAt: string;
}

export interface RetryScheduledTaskOptions {
  /** Omit to retry immediately. */
  readonly runAt?: string;
}

export interface ScheduledTaskDispatchResult {
  /** Replaces the local placeholder only after the provider accepted its first turn. */
  readonly targetSessionId?: string;
}

export type ScheduledTaskChangeReason = "created" | "updated" | "cancelled";

export interface ScheduledTaskChange {
  readonly reason: ScheduledTaskChangeReason;
  readonly task: ScheduledTask;
  /** Present when a process-bound empty provider task was replaced safely. */
  readonly previousTargetSessionId?: string;
}

export interface ScheduledTaskSchedulerOptions {
  readonly store: ScheduledTaskPersistence;
  readonly dispatch: (task: ScheduledTask) => Promise<ScheduledTaskDispatchResult | void>;
  readonly onChange?: (change: ScheduledTaskChange) => void | Promise<void>;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly onError?: (error: unknown) => void;
}

function defaultSetTimeout(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

function defaultClearTimeout(handle: unknown): void {
  globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    ...(task.meshTargets !== undefined
      ? { meshTargets: task.meshTargets.map((target) => ({ ...target })) }
      : {}),
  };
}

function sameMeshTargets(
  left: readonly DelegationTarget[] | undefined,
  right: readonly DelegationTarget[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((target, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && target.providerId === candidate.providerId
      && target.modelId === candidate.modelId
      && target.reasoningEffort === candidate.reasoningEffort;
  });
}

function sameCreation(existing: ScheduledTask, input: CreateScheduledTaskInput): boolean {
  return existing.requestId === input.requestId
    && (existing.targetSessionId === input.targetSessionId
      || input.targetSessionId === scheduledTaskPlaceholderId(input.requestId))
    && existing.providerId === input.providerId
    && existing.modelId === input.modelId
    && existing.reasoningEffort === input.reasoningEffort
    && sameMeshTargets(existing.meshTargets, input.meshTargets)
    && existing.workingDirectory === input.workingDirectory
    && existing.title === input.title
    && existing.content === input.content
    && (existing.originalRunAt ?? existing.runAt) === input.runAt;
}

function dispatchFailureMessage(error: unknown): string {
  const candidate = error instanceof Error ? error.message : String(error);
  const sanitized = candidate
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .trim();
  return (sanitized || "Scheduled task dispatch failed").slice(0, 2_000);
}

export class ScheduledTaskScheduler {
  readonly #store: ScheduledTaskPersistence;
  readonly #dispatch: (task: ScheduledTask) => Promise<ScheduledTaskDispatchResult | void>;
  readonly #now: () => number;
  readonly #setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #onError: (error: unknown) => void;
  readonly #onChange: (change: ScheduledTaskChange) => void | Promise<void>;
  readonly #tasks = new Map<string, ScheduledTask>();
  readonly #dispatches = new Set<Promise<void>>();
  readonly #pendingSettlements = new Map<string, ScheduledTask>();
  readonly #pendingTargetRemaps = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();
  #timer: { readonly handle: unknown } | undefined;
  #disposePromise: Promise<void> | undefined;
  #reconciliationRetryNotBefore: number | undefined;
  #started = false;
  #disposing = false;
  #disposed = false;

  private constructor(options: ScheduledTaskSchedulerOptions, tasks: readonly ScheduledTask[]) {
    this.#store = options.store;
    this.#dispatch = options.dispatch;
    this.#now = options.now ?? Date.now;
    this.#setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.#clearTimeout = options.clearTimeout ?? defaultClearTimeout;
    this.#onError = options.onError ?? (() => undefined);
    this.#onChange = options.onChange ?? (() => undefined);
    for (const task of tasks) this.#tasks.set(task.requestId, cloneTask(task));
  }

  public static async open(options: ScheduledTaskSchedulerOptions): Promise<ScheduledTaskScheduler> {
    const state = await options.store.read();
    const scheduler = new ScheduledTaskScheduler(options, state.tasks);
    await scheduler.initialize();
    return scheduler;
  }

  /** Begin overdue reconciliation and timer ownership after providers are ready. */
  public async start(): Promise<void> {
    await this.enqueue(async () => {
      this.assertActive();
      if (this.#started) return;
      this.#started = true;
      await this.reconcileInternal();
    });
  }

  public list(): readonly ScheduledTask[] {
    return [...this.#tasks.values()]
      .sort((left, right) => left.runAt.localeCompare(right.runAt) || left.createdAt.localeCompare(right.createdAt))
      .map(cloneTask);
  }

  public get(requestId: string): ScheduledTask | undefined {
    const task = this.#tasks.get(requestId);
    return task === undefined ? undefined : cloneTask(task);
  }

  /** Validate a prospective record and current capacity without changing durable state. */
  public preflightCreate(input: CreateScheduledTaskInput): void {
    this.assertActive();
    const candidate = this.creationCandidate(input);
    const existing = this.#tasks.get(candidate.requestId);
    if (existing !== undefined) {
      if (!sameCreation(existing, input)) throw new Error("Scheduled-task request ID is already in use");
      return;
    }
    if ([...this.#tasks.values()].some((task) => task.targetSessionId === candidate.targetSessionId)) {
      throw new Error("Scheduled-task target session is already in use");
    }
    this.withCapacityFor(candidate);
  }

  public async create(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    return await this.enqueue(async () => {
      this.assertActive();
      const candidate = this.creationCandidate(input);
      const existing = this.#tasks.get(candidate.requestId);
      if (existing !== undefined) {
        if (!sameCreation(existing, input)) throw new Error("Scheduled-task request ID is already in use");
        return cloneTask(existing);
      }
      if ([...this.#tasks.values()].some((task) => task.targetSessionId === candidate.targetSessionId)) {
        throw new Error("Scheduled-task target session is already in use");
      }
      await this.persist(this.withCapacityFor(candidate));
      await this.notifyChange("created", candidate);
      if (this.#started) await this.reconcileInternal();
      return cloneTask(this.#tasks.get(candidate.requestId)!);
    });
  }

  public async cancel(requestId: string): Promise<ScheduledTask> {
    return await this.enqueue(async () => {
      this.assertActive();
      const task = this.requireTask(requestId);
      if (task.status === "cancelled") return cloneTask(task);
      if (task.status !== "pending" && task.status !== "failed") {
        throw new Error("Only a pending or failed scheduled task can be cancelled");
      }
      const cancelled = validateScheduledTask({
        ...task,
        status: "cancelled",
        cancelledAt: this.nowTimestamp(),
        startedAt: undefined,
        failedAt: undefined,
        failureMessage: undefined,
      });
      await this.persist(this.replacing(cancelled));
      await this.notifyChange("cancelled", cancelled);
      if (this.#started) this.armNearestTimer();
      return cloneTask(cancelled);
    });
  }

  public async retry(requestId: string, options: RetryScheduledTaskOptions = {}): Promise<ScheduledTask> {
    return await this.enqueue(async () => {
      this.assertActive();
      const task = this.requireTask(requestId);
      if (task.status !== "failed") throw new Error("Only a failed scheduled task can be retried");
      const pending = validateScheduledTask({
        kind: task.kind,
        requestId: task.requestId,
        targetSessionId: task.targetSessionId,
        providerId: task.providerId,
        ...(task.modelId !== undefined ? { modelId: task.modelId } : {}),
        ...(task.reasoningEffort !== undefined ? { reasoningEffort: task.reasoningEffort } : {}),
        ...(task.meshTargets !== undefined ? { meshTargets: task.meshTargets } : {}),
        workingDirectory: task.workingDirectory,
        title: task.title,
        content: task.content,
        runAt: options.runAt ?? this.nowTimestamp(),
        ...(task.originalRunAt !== undefined ? { originalRunAt: task.originalRunAt } : {}),
        createdAt: task.createdAt,
        status: "pending",
      });
      await this.persist(this.replacing(pending));
      await this.notifyChange("updated", pending);
      if (this.#started) await this.reconcileInternal();
      return cloneTask(this.#tasks.get(requestId)!);
    });
  }

  /** Durably replace a dispatching placeholder once its provider task exists. */
  public async materializeTargetSession(requestId: string, targetSessionId: string): Promise<ScheduledTask> {
    return await this.enqueue(async () => {
      // Materialization settles provider creation that may already be in
      // flight when shutdown starts. Rejecting it during the drain would
      // orphan the provider task behind its local placeholder.
      this.assertNotDisposed();
      const task = this.requireTask(requestId);
      if (task.status !== "dispatching") {
        throw new Error("Only a dispatching scheduled task can materialize a provider session");
      }
      if (task.targetSessionId === targetSessionId) return cloneTask(task);
      if (!isScheduledTaskPlaceholderId(task.targetSessionId)) {
        throw new Error("Scheduled task already targets a provider session");
      }
      const materialized = validateScheduledTask({ ...task, targetSessionId });
      if ([...this.#tasks.values()].some((candidate) =>
        candidate.requestId !== requestId && candidate.targetSessionId === materialized.targetSessionId)) {
        throw new Error("Scheduled-task target session is already in use");
      }
      const materializedTasks = this.replacing(materialized);
      this.#pendingTargetRemaps.set(requestId, task.targetSessionId);
      // Once createSession has returned, keep that identity in runtime even
      // if the first store write fails. The dispatch settlement then persists
      // the same target, and an explicit retry cannot create a second task.
      this.replaceRuntime(materializedTasks);
      await this.#store.write(materializedTasks);
      await this.notifyChange("updated", materialized, task.targetSessionId);
      this.#pendingTargetRemaps.delete(requestId);
      return cloneTask(materialized);
    });
  }

  /** Make a pending task due immediately without changing its stable request ID. */
  public async runNow(requestId: string): Promise<ScheduledTask> {
    return await this.enqueue(async () => {
      this.assertActive();
      const task = this.requireTask(requestId);
      if (task.status !== "pending") throw new Error("Only a pending scheduled task can run now");
      const pending = validateScheduledTask({
        ...task,
        runAt: this.nowTimestamp(),
      });
      await this.persist(this.replacing(pending));
      await this.notifyChange("updated", pending);
      if (this.#started) await this.reconcileInternal();
      return cloneTask(this.#tasks.get(requestId)!);
    });
  }

  /** Reconcile after startup, resume, or a wall-clock change. */
  public async reconcile(): Promise<void> {
    await this.enqueue(async () => {
      this.assertActive();
      if (!this.#started) throw new Error("Scheduled-task scheduler has not started");
      await this.reconcileInternal();
    });
  }

  public async flush(): Promise<void> {
    for (;;) {
      const tail = this.#tail;
      await tail;
      const dispatches = [...this.#dispatches];
      if (dispatches.length > 0) await Promise.allSettled(dispatches);
      if (tail !== this.#tail || this.#dispatches.size > 0) continue;
      const pendingSettlements = [...this.#pendingSettlements.values()];
      if (pendingSettlements.length > 0) {
        await this.enqueue(async () => {
          for (const settled of pendingSettlements) await this.persistDispatchSettlement(settled);
        });
        continue;
      }
      if (tail === this.#tail && this.#dispatches.size === 0 && this.#pendingSettlements.size === 0) break;
    }
    await this.#store.flush();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) {
      await this.flush();
      return;
    }
    if (this.#disposePromise !== undefined) {
      await this.#disposePromise;
      return;
    }
    this.#disposing = true;
    this.clearTimer();
    const completion = (async () => {
      try {
        await this.flush();
        this.#disposed = true;
      } catch (error) {
        this.#disposing = false;
        this.armNearestTimer();
        throw error;
      }
    })();
    this.#disposePromise = completion;
    try {
      await completion;
    } finally {
      this.#disposePromise = undefined;
    }
  }

  private async initialize(): Promise<void> {
    const failedAt = this.nowTimestamp();
    const normalized = [...this.#tasks.values()].map((task): ScheduledTask => task.status === "dispatching"
      ? validateScheduledTask({
        ...task,
        status: "failed",
        failedAt,
        failureMessage: interruptedScheduledTaskFailureMessage,
      })
      : task);
    const interrupted = normalized.filter((task) => this.#tasks.get(task.requestId)?.status !== task.status);
    if (interrupted.length > 0) {
      await this.persist(normalized);
      for (const task of interrupted) await this.notifyChange("updated", task);
    }
  }

  private async reconcileInternal(): Promise<void> {
    this.clearTimer();
    let succeeded = false;
    try {
      for (const settled of [...this.#pendingSettlements.values()]) {
        await this.persistDispatchSettlement(settled);
      }
      for (;;) {
        const now = this.nowMilliseconds();
        const due = [...this.#tasks.values()]
          .filter((task) => task.status === "pending" && Date.parse(task.runAt) <= now)
          .sort((left, right) => left.runAt.localeCompare(right.runAt) || left.createdAt.localeCompare(right.createdAt))[0];
        if (due === undefined) break;
        await this.dispatchTask(due);
      }
      succeeded = true;
    } catch (error) {
      // A due task remains due when its transition write fails. Without a
      // floor, the nearest-task timer would re-arm at zero and spin on a full
      // disk or another persistent storage failure.
      this.#reconciliationRetryNotBefore = this.nowMilliseconds() + settlementPersistenceRetryMs;
      throw error;
    } finally {
      if (succeeded) this.#reconciliationRetryNotBefore = undefined;
      this.armNearestTimer();
    }
  }

  private async dispatchTask(task: ScheduledTask): Promise<void> {
    const dispatching = validateScheduledTask({
      ...task,
      status: "dispatching",
      dispatchingAt: this.nowTimestamp(),
    });
    await this.persist(this.replacing(dispatching));
    await this.notifyChange("updated", dispatching);
    const completion = this.completeDispatch(dispatching);
    this.#dispatches.add(completion);
    void completion.catch(this.#onError).finally(() => this.#dispatches.delete(completion));
  }

  private async completeDispatch(dispatching: ScheduledTask): Promise<void> {
    let settled: ScheduledTask;
    try {
      const result = await this.#dispatch(cloneTask(dispatching));
      settled = validateScheduledTask({
        ...dispatching,
        ...(result?.targetSessionId !== undefined ? { targetSessionId: result.targetSessionId } : {}),
        status: "started",
        startedAt: this.nowTimestamp(),
      });
    } catch (error) {
      settled = validateScheduledTask({
        ...dispatching,
        status: "failed",
        failedAt: this.nowTimestamp(),
        failureMessage: dispatchFailureMessage(error),
      });
    }
    this.#pendingSettlements.set(dispatching.requestId, settled);
    try {
      await this.enqueue(async () => await this.persistDispatchSettlement(settled));
    } catch (error) {
      // The provider outcome is already known, so never send the prompt again.
      // Keep the durable row in `dispatching` and retry only the settlement write.
      this.armNearestTimer();
      throw error;
    }
  }

  private async persistDispatchSettlement(settled: ScheduledTask): Promise<void> {
    const pending = this.#pendingSettlements.get(settled.requestId);
    if (pending === undefined || pending.status !== settled.status
      || pending.startedAt !== settled.startedAt || pending.failedAt !== settled.failedAt) return;
    const current = this.#tasks.get(settled.requestId);
    if (current?.status !== "dispatching" || current.dispatchingAt !== settled.dispatchingAt) {
      this.#pendingSettlements.delete(settled.requestId);
      return;
    }
    if (
      current.targetSessionId !== settled.targetSessionId
      && !isScheduledTaskPlaceholderId(current.targetSessionId)
      && !isScheduledTaskPlaceholderId(settled.targetSessionId)
    ) {
      throw new Error("Scheduled-task dispatch resolved to a conflicting provider session");
    }
    const durableSettlement = current.targetSessionId !== settled.targetSessionId
      && !isScheduledTaskPlaceholderId(current.targetSessionId)
      ? validateScheduledTask({ ...settled, targetSessionId: current.targetSessionId })
      : settled;
    const previousTargetSessionId = this.#pendingTargetRemaps.get(settled.requestId)
      ?? (current.targetSessionId === durableSettlement.targetSessionId ? undefined : current.targetSessionId);
    await this.persist(this.replacing(durableSettlement));
    this.#pendingSettlements.delete(settled.requestId);
    try {
      await this.notifyChange("updated", durableSettlement, previousTargetSessionId);
    } finally {
      this.#pendingTargetRemaps.delete(settled.requestId);
      // Reconciliation may have armed the one-second settlement fallback while
      // this completion was queued behind it. Replace that stale wake-up with
      // the next real pending task (or no timer at all).
      this.armNearestTimer();
    }
  }

  private async persist(tasks: readonly ScheduledTask[]): Promise<void> {
    await this.#store.write(tasks);
    this.replaceRuntime(tasks);
  }

  private replaceRuntime(tasks: readonly ScheduledTask[]): void {
    this.#tasks.clear();
    for (const task of tasks) this.#tasks.set(task.requestId, cloneTask(task));
  }

  private replacing(task: ScheduledTask): readonly ScheduledTask[] {
    return [...this.#tasks.values()].map((candidate) => candidate.requestId === task.requestId ? task : candidate);
  }

  private creationCandidate(input: CreateScheduledTaskInput): ScheduledTask {
    return validateScheduledTask({
      kind: "new_task",
      requestId: input.requestId,
      targetSessionId: input.targetSessionId,
      providerId: input.providerId,
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.meshTargets !== undefined ? { meshTargets: input.meshTargets } : {}),
      workingDirectory: input.workingDirectory,
      title: input.title,
      content: input.content,
      runAt: input.runAt,
      originalRunAt: input.runAt,
      createdAt: this.nowTimestamp(),
      status: "pending",
    });
  }

  private withCapacityFor(candidate: ScheduledTask): readonly ScheduledTask[] {
    const retained = [...this.#tasks.values()];
    const oldestCompleted = retained
      .filter((task) => task.status === "started" || task.status === "cancelled")
      .sort((left, right) => (
        left.startedAt ?? left.cancelledAt ?? left.createdAt
      ).localeCompare(right.startedAt ?? right.cancelledAt ?? right.createdAt));
    while (
      retained.length + 1 > maxScheduledTaskRecords
      || Buffer.byteLength(JSON.stringify({ version: 1, tasks: [...retained, candidate] }), "utf8") > maxScheduledTaskStateBytes
      || projectedScheduledTaskStateBytes([...retained, candidate]) > maxScheduledTaskStateBytes
      || scheduledTaskListPayloadBytes([...retained, candidate]) > maxScheduledTaskListPayloadBytes
    ) {
      const oldest = oldestCompleted.shift();
      if (oldest === undefined) throw new Error("Scheduled-task capacity is full");
      const index = retained.findIndex((task) => task.requestId === oldest.requestId);
      if (index >= 0) retained.splice(index, 1);
    }
    return [...retained, candidate];
  }

  private async notifyChange(
    reason: ScheduledTaskChangeReason,
    task: ScheduledTask,
    previousTargetSessionId?: string,
  ): Promise<void> {
    await this.#onChange({
      reason,
      task: cloneTask(task),
      ...(previousTargetSessionId !== undefined ? { previousTargetSessionId } : {}),
    });
  }

  private requireTask(requestId: string): ScheduledTask {
    const task = this.#tasks.get(requestId);
    if (task === undefined) throw new Error("Scheduled task was not found");
    return task;
  }

  private nowMilliseconds(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) throw new Error("Scheduled-task clock returned an invalid time");
    return value;
  }

  private nowTimestamp(): string {
    try {
      return new Date(this.nowMilliseconds()).toISOString();
    } catch {
      throw new Error("Scheduled-task clock returned an invalid time");
    }
  }

  private armNearestTimer(): void {
    this.clearTimer();
    if (this.#disposing || this.#disposed || !this.#started) return;
    const next = [...this.#tasks.values()]
      .filter((task) => task.status === "pending")
      .sort((left, right) => left.runAt.localeCompare(right.runAt))[0];
    if (next === undefined && this.#pendingSettlements.size === 0) return;
    const nextTaskDelayMs = next === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Date.parse(next.runAt) - this.nowMilliseconds());
    const nextSettlementDelayMs = this.#pendingSettlements.size > 0
      ? settlementPersistenceRetryMs
      : Number.POSITIVE_INFINITY;
    // setTimeout follows elapsed time, while runAt follows the wall clock. Wake
    // periodically so an awake-machine clock correction cannot leave a task
    // waiting on the delay calculated before that correction.
    const normalDelayMs = Math.min(maximumTimerDelayMs, wallClockReconciliationIntervalMs, nextTaskDelayMs, nextSettlementDelayMs);
    const reconciliationRetryDelayMs = this.#reconciliationRetryNotBefore === undefined
      ? 0
      : Math.max(0, this.#reconciliationRetryNotBefore - this.nowMilliseconds());
    const delayMs = Math.max(normalDelayMs, reconciliationRetryDelayMs);
    const handle = this.#setTimeout(() => {
      this.#timer = undefined;
      void this.reconcile().catch(this.#onError);
    }, delayMs);
    this.#timer = { handle };
  }

  private clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimeout(this.#timer.handle);
    this.#timer = undefined;
  }

  private assertActive(): void {
    if (this.#disposing || this.#disposed) throw new Error("Scheduled-task scheduler is disposed");
  }

  private assertNotDisposed(): void {
    if (this.#disposed) throw new Error("Scheduled-task scheduler is disposed");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function openScheduledTaskScheduler(options: ScheduledTaskSchedulerOptions): Promise<ScheduledTaskScheduler> {
  return await ScheduledTaskScheduler.open(options);
}
