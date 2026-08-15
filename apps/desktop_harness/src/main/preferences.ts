import { JsonFileStore } from "../../../agent_bridge/src/persistence.js";

export const DESKTOP_PREFERENCES_VERSION = 1 as const;

export interface DesktopPreferences {
  readonly version: typeof DESKTOP_PREFERENCES_VERSION;
  /** Master gate for optional, experimental desktop capabilities. Defaults to off. */
  readonly experimentalFeatures: boolean;
}

export function validateDesktopPreferences(value: unknown): DesktopPreferences {
  const input = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    version: DESKTOP_PREFERENCES_VERSION,
    experimentalFeatures: input.experimentalFeatures === true,
  };
}

export class DesktopPreferencesStore {
  readonly #store: JsonFileStore<DesktopPreferences>;
  readonly #listeners = new Set<(preferences: DesktopPreferences) => void>();
  #value: DesktopPreferences;

  private constructor(path: string, value: DesktopPreferences) {
    this.#store = new JsonFileStore(path, validateDesktopPreferences);
    this.#value = value;
  }

  public static async load(path: string): Promise<DesktopPreferencesStore> {
    const store = new JsonFileStore(path, validateDesktopPreferences);
    const defaults: DesktopPreferences = { version: DESKTOP_PREFERENCES_VERSION, experimentalFeatures: false };
    const value = await store.read(defaults);
    const validated = validateDesktopPreferences(value);
    if (JSON.stringify(validated) !== JSON.stringify(value)) await store.write(validated);
    return new DesktopPreferencesStore(path, validated);
  }

  public value(): DesktopPreferences {
    return this.#value;
  }

  public onChange(listener: (preferences: DesktopPreferences) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async setExperimentalFeatures(enabled: boolean): Promise<DesktopPreferences> {
    const next: DesktopPreferences = { ...this.#value, experimentalFeatures: enabled === true };
    if (next.experimentalFeatures === this.#value.experimentalFeatures) return this.#value;
    await this.#store.write(next);
    this.#value = next;
    for (const listener of this.#listeners) listener(next);
    return next;
  }
}
