import { dirname } from "node:path";
import {
  delegationStates,
  sessionStates,
  type DelegationChild,
  type DelegationTask,
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
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function task(value: unknown): DelegationTask {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.parentSessionId !== "string" ||
      typeof value.prompt !== "string" || typeof value.state !== "string" ||
      !delegationStates.includes(value.state as (typeof delegationStates)[number]) ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string" || !Array.isArray(value.children)) {
    throw new Error("Persisted delegation task is invalid");
  }
  const error = optionalString(value.error);
  return {
    id: value.id,
    parentSessionId: value.parentSessionId,
    prompt: value.prompt,
    state: value.state as DelegationTask["state"],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    children: value.children.map(child),
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
