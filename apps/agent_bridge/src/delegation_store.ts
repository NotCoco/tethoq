import { dirname } from "node:path";
import {
  delegationStates,
  sessionStates,
  type DelegationChild,
  type DelegationPresentationSegment,
  type DelegationTask,
  type DelegationTarget,
} from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export interface DelegationState {
  readonly version: 1;
  readonly tasks: readonly DelegationTask[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function child(value: unknown): DelegationChild {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.providerId !== "string" ||
      typeof value.state !== "string" || !sessionStates.includes(value.state as (typeof sessionStates)[number])) {
    throw new Error("Persisted delegation child is invalid");
  }
  const sessionId = optionalString(value.sessionId);
  const modelId = optionalString(value.modelId);
  const reasoningEffort = optionalString(value.reasoningEffort);
  const error = optionalString(value.error);
  return {
    id: value.id,
    providerId: value.providerId,
    state: value.state as DelegationChild["state"],
    ...(optionalString(value.interruptedAt) !== undefined ? { interruptedAt: value.interruptedAt as string } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function target(value: unknown): DelegationTarget {
  if (!isRecord(value) || typeof value.providerId !== "string" || value.providerId.length === 0) {
    throw new Error("Persisted delegation target is invalid");
  }
  const modelId = optionalString(value.modelId);
  const reasoningEffort = optionalString(value.reasoningEffort);
  if (reasoningEffort !== undefined && modelId === undefined) {
    throw new Error("Persisted delegation target reasoning requires a model");
  }
  return {
    providerId: value.providerId,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

function presentationSegment(value: unknown, targetCount: number): DelegationPresentationSegment {
  if (!isRecord(value)) throw new Error("Persisted delegation presentation segment is invalid");
  if (value.type === "text" && typeof value.text === "string") return { type: "text", text: value.text };
  if (value.type === "mesh" && Number.isSafeInteger(value.targetIndex)
    && (value.targetIndex as number) >= 0 && (value.targetIndex as number) < targetCount) {
    return { type: "mesh", targetIndex: value.targetIndex as number };
  }
  throw new Error("Persisted delegation presentation segment is invalid");
}

function task(value: unknown): DelegationTask {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.parentSessionId !== "string" ||
      typeof value.prompt !== "string" || typeof value.state !== "string" ||
      !delegationStates.includes(value.state as (typeof delegationStates)[number]) ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.children)) {
    throw new Error("Persisted delegation task is invalid");
  }
  const error = optionalString(value.error);
  const orchestration = value.orchestration === "parent" ? "parent" as const : undefined;
  if (value.orchestration !== undefined && orchestration === undefined) {
    throw new Error("Persisted delegation orchestration is invalid");
  }
  const targets = value.targets === undefined
    ? undefined
    : Array.isArray(value.targets) ? value.targets.map(target) : (() => { throw new Error("Persisted delegation targets are invalid"); })();
  const presentationSegments = value.presentationSegments === undefined
    ? undefined
    : Array.isArray(value.presentationSegments)
      ? value.presentationSegments.map((segment) => presentationSegment(segment, targets?.length ?? 0))
      : (() => { throw new Error("Persisted delegation presentation is invalid"); })();
  if (orchestration === "parent") {
    if (targets === undefined || targets.length === 0 || targets.length > 4 || presentationSegments === undefined) {
      throw new Error("Persisted parent-orchestrated delegation is incomplete");
    }
    const indexes = presentationSegments.flatMap((segment) => segment.type === "mesh" ? [segment.targetIndex] : []);
    if (indexes.length !== targets.length || new Set(indexes).size !== targets.length) {
      throw new Error("Persisted delegation presentation does not match its targets");
    }
    if (presentationSegments.filter((segment) => segment.type === "text").map((segment) => segment.text).join("") !== value.prompt) {
      throw new Error("Persisted delegation presentation does not reconstruct its prompt");
    }
  }
  const parentModelId = optionalString(value.parentModelId);
  const parentReasoningEffort = optionalString(value.parentReasoningEffort);
  const parentTurnAcceptedAt = optionalString(value.parentTurnAcceptedAt);
  const parentTurnId = optionalString(value.parentTurnId);
  const dispatchFingerprint = optionalString(value.dispatchFingerprint);
  return {
    id: value.id,
    parentSessionId: value.parentSessionId,
    prompt: value.prompt,
    state: value.state as DelegationTask["state"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(optionalString(value.interruptedAt) !== undefined ? { interruptedAt: value.interruptedAt as string } : {}),
    children: value.children.map(child),
    ...(orchestration !== undefined ? { orchestration } : {}),
    ...(targets !== undefined ? { targets } : {}),
    ...(presentationSegments !== undefined ? { presentationSegments } : {}),
    ...(parentModelId !== undefined ? { parentModelId } : {}),
    ...(parentReasoningEffort !== undefined ? { parentReasoningEffort } : {}),
    ...(parentTurnAcceptedAt !== undefined ? { parentTurnAcceptedAt } : {}),
    ...(parentTurnId !== undefined ? { parentTurnId } : {}),
    ...(dispatchFingerprint !== undefined ? { dispatchFingerprint } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function validate(value: unknown): DelegationState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tasks)) {
    throw new Error("Delegation-state file is invalid");
  }
  return { version: 1, tasks: value.tasks.map(task) };
}

export function defaultDelegationStatePath(configPath: string): string {
  return `${dirname(configPath)}/delegations.json`;
}

export class DelegationStateStore {
  readonly #store: JsonFileStore<DelegationState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validate);
  }

  public async read(): Promise<DelegationState> {
    return await this.#store.read({ version: 1, tasks: [] });
  }

  public scheduleWrite(tasks: readonly DelegationTask[]): void {
    const state: DelegationState = { version: 1, tasks };
    this.#tail = this.#tail.then(() => this.#store.write(state));
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
