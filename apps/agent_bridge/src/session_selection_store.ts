import { dirname } from "node:path";
import { JsonFileStore } from "./persistence.js";

/**
 * The model and reasoning level a harness last said a session was running.
 *
 * Harnesses differ in when they will tell you this. Grok, for example, reports it
 * only once a session is opened — its session listing carries no reasoning level
 * at all — so without a record of what it said last, every restart showed the
 * model's default until the user opened each chat. Remembering the last reported
 * value lets the task list and composer be right immediately.
 *
 * This is deliberately only a fallback. Whatever a harness reports now always
 * wins, so a level changed inside the harness itself corrects the moment it says
 * so, and a remembered value can never outlive the truth.
 */
export interface SessionSelection {
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  /** `reported` came from the harness; `requested` is only what Tethoq asked for. */
  readonly source: "reported" | "requested";
  readonly updatedAt: string;
}

export interface SessionSelectionState {
  readonly version: 1;
  readonly selections: Readonly<Record<string, SessionSelection>>;
}

/** Bounded so a long-lived install cannot grow this file without limit. */
const maximumSelections = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function selection(value: unknown): SessionSelection | undefined {
  if (!isRecord(value)) return undefined;
  const modelId = optionalString(value.modelId);
  const reasoningEffort = optionalString(value.reasoningEffort);
  if (modelId === undefined && reasoningEffort === undefined) return undefined;
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    source: value.source === "reported" ? "reported" : "requested",
    updatedAt: optionalString(value.updatedAt) ?? new Date(0).toISOString(),
  };
}

function validate(value: unknown): SessionSelectionState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.selections)) {
    throw new Error("Session-selection file is invalid");
  }
  const selections: Record<string, SessionSelection> = {};
  for (const [sessionId, entry] of Object.entries(value.selections)) {
    const parsed = selection(entry);
    if (parsed !== undefined) selections[sessionId] = parsed;
  }
  return { version: 1, selections };
}

export function defaultSessionSelectionStatePath(configPath: string): string {
  return `${dirname(configPath)}/session-selections.json`;
}

/** Keeps the newest entries when the record grows past its bound. */
export function boundSelections(
  selections: Readonly<Record<string, SessionSelection>>,
): Readonly<Record<string, SessionSelection>> {
  const entries = Object.entries(selections);
  if (entries.length <= maximumSelections) return selections;
  entries.sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt));
  return Object.fromEntries(entries.slice(0, maximumSelections));
}

export class SessionSelectionStore {
  readonly #store: JsonFileStore<SessionSelectionState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validate);
  }

  public async read(): Promise<SessionSelectionState> {
    return await this.#store.read({ version: 1, selections: {} });
  }

  public scheduleWrite(selections: Readonly<Record<string, SessionSelection>>): void {
    const state: SessionSelectionState = { version: 1, selections: boundSelections(selections) };
    this.#tail = this.#tail.then(() => this.#store.write(state));
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
