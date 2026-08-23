import { dirname } from "node:path";
import { parseEarsModelKey, parseGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export interface EarsHelperState {
  readonly version: 1;
  readonly helpers: Readonly<Record<string, string>>;
}

const maximumHelpers = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(value: unknown): EarsHelperState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.helpers)) {
    throw new Error("EARS-helper file is invalid");
  }
  const helpers: Record<string, string> = {};
  for (const [key, helperId] of Object.entries(value.helpers).slice(0, maximumHelpers)) {
    if (typeof helperId !== "string" || key.length > 640 || helperId.length > 2_048) continue;
    try {
      const model = parseEarsModelKey(key);
      const session = parseGlobalSessionId(helperId);
      if (model !== undefined && model.providerId === session.providerId) helpers[key] = helperId;
    } catch {
      // Ignore malformed local records; they must never hide an unrelated task.
    }
  }
  return { version: 1, helpers };
}

export function defaultEarsHelperStatePath(configPath: string): string {
  return `${dirname(configPath)}/ears-helpers.json`;
}

export class EarsHelperStore {
  readonly #store: JsonFileStore<EarsHelperState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validate);
  }

  public async read(): Promise<EarsHelperState> {
    return await this.#store.read({ version: 1, helpers: {} });
  }

  public scheduleWrite(helpers: Readonly<Record<string, string>>): void {
    const bounded = Object.fromEntries(Object.entries(helpers).slice(-maximumHelpers));
    this.#tail = this.#tail.then(() => this.#store.write({ version: 1, helpers: bounded }));
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
