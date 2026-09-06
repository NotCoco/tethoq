import { dirname, join } from "node:path";
import type { DelegationTarget } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export const scheduledTaskStatuses = ["pending", "dispatching", "started", "failed", "cancelled"] as const;
export type ScheduledTaskStatus = (typeof scheduledTaskStatuses)[number];

export const maxScheduledTaskRecords = 1_000;
export const maxScheduledTaskStateBytes = 8 * 1024 * 1024;
/**
 * Leave a full MiB for the response envelope and authenticated-frame tag. The
 * paired-device transport rejects a sealed frame above 8 MiB, while the local
 * store also retains terminal audit rows that scheduled_task.list omits.
 */
export const maxScheduledTaskListPayloadBytes = 7 * 1024 * 1024;
export const maxScheduledTaskContentLength = 100_000;
export const maxScheduledTaskTargetSessionIdLength = 16_384;
export const maxScheduledTaskFailureMessageLength = 2_000;
export const scheduledTaskPlaceholderPrefix = "scheduled-task:";

const maximumTransitionTimestamp = "+275760-09-13T00:00:00.000Z";
// JSON.stringify escapes each unpaired surrogate as six ASCII bytes. Both
// validators admit them, making this the largest representation per allowed
// UTF-16 code unit for transition-controlled strings.
const maximumTransitionFailureMessage = "\ud800".repeat(maxScheduledTaskFailureMessageLength);
const maximumMaterializedTargetSessionId = "\ud800".repeat(maxScheduledTaskTargetSessionIdLength);

/** Stable local row identity used before a provider task exists. */
export function scheduledTaskPlaceholderId(requestId: string): string {
  return `${scheduledTaskPlaceholderPrefix}${requestId}`;
}

export function isScheduledTaskPlaceholderId(sessionId: string): boolean {
  return sessionId.startsWith(scheduledTaskPlaceholderPrefix);
}

export interface ScheduledTask {
  readonly kind: "new_task";
  readonly requestId: string;
  readonly targetSessionId: string;
  readonly providerId: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  /** Explicit cross-harness targets selected for a scheduled Mesh delegation. */
  readonly meshTargets?: readonly DelegationTarget[];
  readonly workingDirectory: string;
  readonly title: string;
  readonly content: string;
  readonly runAt: string;
  /** Immutable time from the original create request, retained for durable request replay. */
  readonly originalRunAt?: string;
  readonly createdAt: string;
  readonly status: ScheduledTaskStatus;
  readonly dispatchingAt?: string;
  readonly startedAt?: string;
  readonly failedAt?: string;
  readonly failureMessage?: string;
  readonly cancelledAt?: string;
}

export interface ScheduledTaskState {
  readonly version: 1;
  readonly tasks: readonly ScheduledTask[];
}

export interface ScheduledTaskPersistence {
  read(): Promise<ScheduledTaskState>;
  write(tasks: readonly ScheduledTask[]): Promise<void>;
  flush(): Promise<void>;
}

function activeScheduledTask(task: ScheduledTask): boolean {
  return task.status !== "started" && task.status !== "cancelled";
}

function maximumTransitionTask(task: ScheduledTask): ScheduledTask {
  if (!activeScheduledTask(task)) return task;
  const { startedAt: _startedAt, cancelledAt: _cancelledAt, ...transitioning } = task;
  return {
    ...transitioning,
    targetSessionId: isScheduledTaskPlaceholderId(task.targetSessionId)
      ? maximumMaterializedTargetSessionId
      : task.targetSessionId,
    status: "failed",
    dispatchingAt: maximumTransitionTimestamp,
    failedAt: maximumTransitionTimestamp,
    failureMessage: maximumTransitionFailureMessage,
  };
}

/** Bytes needed if every actionable row reaches its largest durable state. */
export function projectedScheduledTaskStateBytes(tasks: readonly ScheduledTask[]): number {
  return Buffer.byteLength(JSON.stringify({ version: 1, tasks: tasks.map(maximumTransitionTask) }), "utf8");
}

/** Exact payload shape returned by scheduled_task.list. */
export function scheduledTaskListPayloadBytes(tasks: readonly ScheduledTask[]): number {
  return Buffer.byteLength(JSON.stringify({ tasks: tasks.filter(activeScheduledTask) }), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedSingleLineString(value: unknown, name: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Persisted scheduled-task ${name} is invalid`);
  }
  return value;
}

function boundedText(value: unknown, name: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim().length === 0
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Persisted scheduled-task ${name} is invalid`);
  }
  return value;
}

function meshTargets(value: unknown, parentProviderId: string): readonly DelegationTarget[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) {
    throw new Error("Persisted scheduled-task Mesh targets are invalid");
  }
  const targets = value.map((entry): DelegationTarget => {
    if (!isRecord(entry)) throw new Error("Persisted scheduled-task Mesh target is invalid");
    const providerId = boundedSingleLineString(entry.providerId, "Mesh provider ID", 128)!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u.test(providerId) || providerId === parentProviderId) {
      throw new Error("Persisted scheduled-task Mesh provider ID is invalid");
    }
    const modelId = boundedSingleLineString(entry.modelId, "Mesh model ID", 256, true);
    const reasoningEffort = boundedSingleLineString(entry.reasoningEffort, "Mesh reasoning effort", 128, true);
    if (reasoningEffort !== undefined && modelId === undefined) {
      throw new Error("Persisted scheduled-task Mesh reasoning effort requires a model");
    }
    return {
      providerId,
      ...(modelId !== undefined ? { modelId } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
  });
  if (new Set(targets.map((target) => target.providerId)).size !== targets.length) {
    throw new Error("Persisted scheduled-task Mesh targets contain duplicate providers");
  }
  return targets;
}

function isoTimestamp(value: unknown, name: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  const result = boundedSingleLineString(value, name, 64)!;
  const milliseconds = Date.parse(result);
  if (!Number.isFinite(milliseconds)) throw new Error(`Persisted scheduled-task ${name} is invalid`);
  try {
    if (new Date(milliseconds).toISOString() !== result) {
      throw new Error(`Persisted scheduled-task ${name} is invalid`);
    }
  } catch {
    throw new Error(`Persisted scheduled-task ${name} is invalid`);
  }
  return result;
}

function assertStatusFields(
  status: ScheduledTaskStatus,
  dispatchingAt: string | undefined,
  startedAt: string | undefined,
  failedAt: string | undefined,
  failureMessage: string | undefined,
  cancelledAt: string | undefined,
): void {
  const invalid = (): never => { throw new Error("Persisted scheduled-task status timestamps are invalid"); };
  if (status === "pending") {
    if (dispatchingAt !== undefined || startedAt !== undefined || failedAt !== undefined || failureMessage !== undefined || cancelledAt !== undefined) invalid();
    return;
  }
  if (status === "dispatching") {
    if (dispatchingAt === undefined || startedAt !== undefined || failedAt !== undefined || failureMessage !== undefined || cancelledAt !== undefined) invalid();
    return;
  }
  if (status === "started") {
    if (dispatchingAt === undefined || startedAt === undefined || failedAt !== undefined || failureMessage !== undefined || cancelledAt !== undefined) invalid();
    return;
  }
  if (status === "failed") {
    if (dispatchingAt === undefined || startedAt !== undefined || failedAt === undefined || failureMessage === undefined || cancelledAt !== undefined) invalid();
    return;
  }
  if (startedAt !== undefined || failedAt !== undefined || failureMessage !== undefined || cancelledAt === undefined) invalid();
}

export function validateScheduledTask(value: unknown): ScheduledTask {
  if (!isRecord(value) || value.kind !== "new_task") throw new Error("Persisted scheduled task is invalid");
  const status = value.status;
  if (typeof status !== "string" || !scheduledTaskStatuses.includes(status as ScheduledTaskStatus)) {
    throw new Error("Persisted scheduled-task status is invalid");
  }
  const providerId = boundedSingleLineString(value.providerId, "provider ID", 128)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u.test(providerId)) {
    throw new Error("Persisted scheduled-task provider ID is invalid");
  }
  const modelId = boundedSingleLineString(value.modelId, "model ID", 256, true);
  const reasoningEffort = boundedSingleLineString(value.reasoningEffort, "reasoning effort", 128, true);
  const scheduledMeshTargets = meshTargets(value.meshTargets, providerId);
  const dispatchingAt = isoTimestamp(value.dispatchingAt, "dispatch time", true);
  const startedAt = isoTimestamp(value.startedAt, "start time", true);
  const failedAt = isoTimestamp(value.failedAt, "failure time", true);
  const failureMessage = boundedText(value.failureMessage, "failure message", maxScheduledTaskFailureMessageLength, true);
  const cancelledAt = isoTimestamp(value.cancelledAt, "cancellation time", true);
  assertStatusFields(status as ScheduledTaskStatus, dispatchingAt, startedAt, failedAt, failureMessage, cancelledAt);
  return {
    kind: "new_task",
    requestId: boundedSingleLineString(value.requestId, "request ID", 256)!,
    targetSessionId: boundedSingleLineString(value.targetSessionId, "target session ID", maxScheduledTaskTargetSessionIdLength)!,
    providerId,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(scheduledMeshTargets !== undefined ? { meshTargets: scheduledMeshTargets } : {}),
    workingDirectory: boundedSingleLineString(value.workingDirectory, "working directory", 32_768)!,
    title: boundedSingleLineString(value.title, "title", 240)!,
    content: boundedText(value.content, "content", maxScheduledTaskContentLength)!,
    runAt: isoTimestamp(value.runAt, "run time")!,
    ...(value.originalRunAt !== undefined ? { originalRunAt: isoTimestamp(value.originalRunAt, "original run time")! } : {}),
    createdAt: isoTimestamp(value.createdAt, "creation time")!,
    status: status as ScheduledTaskStatus,
    ...(dispatchingAt !== undefined ? { dispatchingAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(failedAt !== undefined ? { failedAt } : {}),
    ...(failureMessage !== undefined ? { failureMessage } : {}),
    ...(cancelledAt !== undefined ? { cancelledAt } : {}),
  };
}

export function validateScheduledTaskState(value: unknown): ScheduledTaskState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tasks) || value.tasks.length > maxScheduledTaskRecords) {
    throw new Error("Scheduled-task state file is invalid");
  }
  let persistedBytes: number;
  try {
    persistedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new Error("Scheduled-task state file is invalid");
  }
  if (persistedBytes > maxScheduledTaskStateBytes) throw new Error("Scheduled-task state file exceeds its byte limit");
  const tasks = value.tasks.map(validateScheduledTask);
  if (new Set(tasks.map((task) => task.requestId)).size !== tasks.length) {
    throw new Error("Persisted scheduled tasks contain duplicate request IDs");
  }
  if (new Set(tasks.map((task) => task.targetSessionId)).size !== tasks.length) {
    throw new Error("Persisted scheduled tasks contain duplicate target sessions");
  }
  if (projectedScheduledTaskStateBytes(tasks) > maxScheduledTaskStateBytes) {
    throw new Error("Scheduled-task state file cannot reserve its transition capacity");
  }
  if (scheduledTaskListPayloadBytes(tasks) > maxScheduledTaskListPayloadBytes) {
    throw new Error("Scheduled-task active list exceeds its transport byte limit");
  }
  return { version: 1, tasks };
}

export function defaultScheduledTaskStatePath(configPath: string): string {
  return join(dirname(configPath), "scheduled-tasks.json");
}

export class ScheduledTaskStore implements ScheduledTaskPersistence {
  readonly #store: JsonFileStore<ScheduledTaskState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validateScheduledTaskState);
  }

  public async read(): Promise<ScheduledTaskState> {
    await this.#tail;
    return await this.#store.read({ version: 1, tasks: [] });
  }

  public async write(tasks: readonly ScheduledTask[]): Promise<void> {
    const state = validateScheduledTaskState({ version: 1, tasks });
    const write = this.#tail.then(() => this.#store.write(state));
    this.#tail = write.catch(() => undefined);
    await write;
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
