import { dirname } from "node:path";
import { parseGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export interface CompactionThresholdState {
  readonly version: 1;
  readonly thresholds: Readonly<Record<string, number>>;
}

/** Keeps years of opened tasks from growing a local preference file forever. */
export const maximumCompactionThresholds = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validate(value: unknown): CompactionThresholdState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.thresholds)) {
    throw new Error("Compaction-threshold file is invalid");
  }
  const thresholds: Record<string, number> = {};
  for (const [sessionId, threshold] of Object.entries(value.thresholds).slice(-maximumCompactionThresholds)) {
    if (!validThreshold(threshold)) continue;
    try {
      parseGlobalSessionId(sessionId);
      thresholds[sessionId] = threshold;
    } catch {
      // Ignore malformed local records instead of applying a limit to the wrong task.
    }
  }
  return { version: 1, thresholds };
}

export function defaultCompactionThresholdStatePath(configPath: string): string {
  return `${dirname(configPath)}/compaction-thresholds.json`;
}

export function boundCompactionThresholds(
  thresholds: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(thresholds).slice(-maximumCompactionThresholds));
}

export class CompactionThresholdStore {
  readonly #store: JsonFileStore<CompactionThresholdState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validate);
  }

  public async read(): Promise<CompactionThresholdState> {
    return await this.#store.read({ version: 1, thresholds: {} });
  }

  /** Serializes writes and resolves only after the confirmed setting is durable. */
  public async write(thresholds: Readonly<Record<string, number>>): Promise<void> {
    const state: CompactionThresholdState = { version: 1, thresholds: boundCompactionThresholds(thresholds) };
    const write = this.#tail.then(() => this.#store.write(state));
    this.#tail = write.catch(() => undefined);
    await write;
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
