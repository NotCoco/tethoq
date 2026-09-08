import { dirname } from "node:path";
import { parseGlobalSessionId, sessionGoalObjectiveMaxLength, sessionGoalStatuses, type SessionGoal } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export interface GoalState {
  readonly version: 1;
  readonly goals: Readonly<Record<string, SessionGoal>>;
}

export const maximumStoredGoals = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validGoal(sessionId: string, value: unknown): value is SessionGoal {
  if (!isRecord(value)) return false;
  try { parseGlobalSessionId(sessionId); } catch { return false; }
  return value.sessionId === sessionId
    && typeof value.objective === "string"
    && value.objective.trim().length > 0
    && value.objective.length <= sessionGoalObjectiveMaxLength
    && sessionGoalStatuses.includes(value.status as never)
    && value.source === "tethoq"
    && (value.activationId === undefined || (typeof value.activationId === "string" && value.activationId.trim().length > 0 && value.activationId.length <= 256))
    && (value.tokenBudget === null || (typeof value.tokenBudget === "number" && Number.isSafeInteger(value.tokenBudget) && value.tokenBudget > 0))
    && typeof value.tokensUsed === "number" && Number.isSafeInteger(value.tokensUsed) && value.tokensUsed >= 0
    && typeof value.timeUsedSeconds === "number" && Number.isSafeInteger(value.timeUsedSeconds) && value.timeUsedSeconds >= 0
    && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
    && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
    && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

function validate(value: unknown): GoalState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.goals)) throw new Error("Goal file is invalid");
  const goals: Record<string, SessionGoal> = {};
  for (const [sessionId, goal] of Object.entries(value.goals).slice(-maximumStoredGoals)) {
    if (validGoal(sessionId, goal)) goals[sessionId] = goal;
  }
  return { version: 1, goals };
}

export function defaultGoalStatePath(configPath: string): string {
  return `${dirname(configPath)}/goals.json`;
}

export class GoalStore {
  readonly #store: JsonFileStore<GoalState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) { this.#store = new JsonFileStore(path, validate); }

  public async read(): Promise<GoalState> { return await this.#store.read({ version: 1, goals: {} }); }

  public async write(goals: Readonly<Record<string, SessionGoal>>): Promise<void> {
    const bounded = Object.fromEntries(Object.entries(goals).filter(([, goal]) => goal.source === "tethoq").slice(-maximumStoredGoals));
    const write = this.#tail.then(() => this.#store.write({ version: 1, goals: bounded }));
    this.#tail = write.catch(() => undefined);
    await write;
  }

  public async flush(): Promise<void> { await this.#tail; }
}
