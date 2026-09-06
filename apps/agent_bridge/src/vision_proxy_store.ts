import { dirname } from "node:path";
import { parseGlobalSessionId, type VisionProxySelection } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export interface PersistedVisionProxy {
  readonly selection: VisionProxySelection;
  readonly helperSessionId?: string;
  readonly helperToolIsolation?: 1;
}

export interface VisionProxyState {
  readonly version: 1;
  readonly proxies: Readonly<Record<string, PersistedVisionProxy>>;
  /** Includes retired helpers so a model change cannot expose an older EYES chat. */
  readonly helperSessionIds: readonly string[];
}

export const maximumPersistedVisionProxies = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximumLength ? trimmed : undefined;
}

function persistedProxy(parentSessionId: string, value: unknown, expectedHostId?: string): PersistedVisionProxy | undefined {
  if (!isRecord(value) || !isRecord(value.selection)) return undefined;
  const providerId = boundedString(value.selection.providerId, 160);
  const modelId = boundedString(value.selection.modelId, 1_024);
  const reasoningEffort = boundedString(value.selection.reasoningEffort, 160);
  if (providerId === undefined || modelId === undefined) return undefined;
  try {
    const parent = parseGlobalSessionId(parentSessionId);
    if (expectedHostId !== undefined && parent.hostId !== expectedHostId) return undefined;
    const helperSessionId = boundedString(value.helperSessionId, 2_048);
    if (helperSessionId === undefined) {
      return { selection: { providerId, modelId, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) } };
    }
    const helper = parseGlobalSessionId(helperSessionId);
    if (helperSessionId === parentSessionId || helper.hostId !== parent.hostId || helper.providerId !== providerId) return undefined;
    return {
      selection: { providerId, modelId, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) },
      helperSessionId,
      ...(value.helperToolIsolation === 1 ? { helperToolIsolation: 1 as const } : {}),
    };
  } catch {
    return undefined;
  }
}

function validate(value: unknown, expectedHostId?: string): VisionProxyState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.proxies) || !Array.isArray(value.helperSessionIds)) {
    throw new Error("EYES state file is invalid");
  }
  const proxies: Record<string, PersistedVisionProxy> = {};
  for (const [parentSessionId, entry] of Object.entries(value.proxies).slice(-maximumPersistedVisionProxies)) {
    const parsed = persistedProxy(parentSessionId, entry, expectedHostId);
    if (parsed !== undefined) proxies[parentSessionId] = parsed;
  }
  const helperSessionIds: string[] = [];
  const seenHelperSessionIds = new Set<string>();
  for (const entry of value.helperSessionIds) {
    const helperId = boundedString(entry, 2_048);
    if (helperId === undefined || seenHelperSessionIds.has(helperId)) continue;
    try {
      const helper = parseGlobalSessionId(helperId);
      if (expectedHostId === undefined || helper.hostId === expectedHostId) {
        helperSessionIds.push(helperId);
        seenHelperSessionIds.add(helperId);
      }
    } catch {
      // Malformed records must never hide an unrelated task.
    }
  }
  for (const proxy of Object.values(proxies)) {
    if (proxy.helperSessionId !== undefined && !seenHelperSessionIds.has(proxy.helperSessionId)) {
      helperSessionIds.push(proxy.helperSessionId);
      seenHelperSessionIds.add(proxy.helperSessionId);
    }
  }
  // A retired helper can remain in a provider catalogue indefinitely. Never
  // discard a valid privacy marker merely to keep this local file smaller.
  return { version: 1, proxies, helperSessionIds };
}

export function defaultVisionProxyStatePath(configPath: string): string {
  return `${dirname(configPath)}/eyes-state.json`;
}

export class VisionProxyStore {
  readonly #store: JsonFileStore<VisionProxyState>;
  readonly #expectedHostId: string | undefined;
  #pending: VisionProxyState | undefined;
  #drain: Promise<void> | undefined;
  #writeFailure: { readonly error: unknown } | undefined;

  public constructor(path: string, expectedHostId?: string) {
    this.#expectedHostId = expectedHostId;
    this.#store = new JsonFileStore(path, (value) => validate(value, expectedHostId));
  }

  public async read(): Promise<VisionProxyState> {
    return await this.#store.read({ version: 1, proxies: {}, helperSessionIds: [] });
  }

  public scheduleWrite(
    proxies: Readonly<Record<string, PersistedVisionProxy>>,
    helperSessionIds: readonly string[],
  ): Promise<void> {
    this.#pending = validate({ version: 1, proxies, helperSessionIds }, this.#expectedHostId);
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
