import { dirname } from "node:path";
import { parseEarsModelKey, parseGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export interface EarsHelperState {
  readonly version: 1;
  readonly helpers: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(value: unknown): EarsHelperState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.helpers)) {
    throw new Error("EARS-helper file is invalid");
  }
  const helpers: Record<string, string> = {};
  for (const [key, helperId] of Object.entries(value.helpers)) {
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
  #pending: EarsHelperState | undefined;
  #drain: Promise<void> | undefined;
  #writeFailure: { readonly error: unknown } | undefined;

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validate);
  }

  public async read(): Promise<EarsHelperState> {
    return await this.#store.read({ version: 1, helpers: {} });
  }

  public scheduleWrite(helpers: Readonly<Record<string, string>>): Promise<void> {
    this.#pending = validate({ version: 1, helpers });
    this.#writeFailure = undefined;
    this.ensureDrain();
    return this.flush();
  }

  public async flush(): Promise<void> {
    while (this.#pending !== undefined || this.#drain !== undefined) {
      if (this.#writeFailure !== undefined) throw this.#writeFailure.error;
      this.ensureDrain();
      if (this.#drain !== undefined) await this.#drain;
    }
    if (this.#writeFailure !== undefined) throw this.#writeFailure.error;
  }

  private ensureDrain(): void {
    if (this.#drain !== undefined || this.#pending === undefined || this.#writeFailure !== undefined) return;
    this.#drain = this.drainWrites()
      .catch((error: unknown) => { this.#writeFailure = { error }; })
      .finally(() => {
        this.#drain = undefined;
        if (this.#pending !== undefined && this.#writeFailure === undefined) this.ensureDrain();
      });
  }

  private async drainWrites(): Promise<void> {
    while (this.#pending !== undefined) {
      const state = this.#pending;
      this.#pending = undefined;
      try {
        await this.#store.write(state);
      } catch (error) {
        if (this.#pending === undefined) this.#pending = state;
        throw error;
      }
    }
  }
}
