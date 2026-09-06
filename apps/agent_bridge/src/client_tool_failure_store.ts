import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { parseGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export type BridgeOwnedClientToolFailureKind =
  | "auth"
  | "usage"
  | "unavailable"
  | "timeout"
  | "interrupted"
  | "unknown";

export interface PersistedBridgeOwnedClientToolFailure {
  readonly callId: string;
  readonly occurredAt: string;
  readonly failureKind: BridgeOwnedClientToolFailureKind;
}

export interface BridgeOwnedClientToolFailureState {
  readonly version: 1;
  readonly failures: Readonly<Record<string, readonly PersistedBridgeOwnedClientToolFailure[]>>;
}

export const maximumBridgeOwnedClientToolFailureSessions = 200;
export const maximumBridgeOwnedClientToolFailuresPerSession = 32;

const safeCallIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const failureKinds = new Set<BridgeOwnedClientToolFailureKind>([
  "auth",
  "usage",
  "unavailable",
  "timeout",
  "interrupted",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tool-call identities are correlation data, not display text. Keep ordinary
 * provider IDs intact, but turn anything path-, URL-, or prose-shaped into a
 * deterministic opaque ID before it can reach events or durable storage.
 */
export function durableClientToolCallId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().replace(/[\r\n\t]+/gu, " ").slice(0, 4_096);
  if (normalized.length === 0) return undefined;
  if (safeCallIdPattern.test(normalized)) return normalized;
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 40);
  return `tethoq-call-${digest}`;
}

function persistedFailure(value: unknown): PersistedBridgeOwnedClientToolFailure | undefined {
  if (!isRecord(value)) return undefined;
  const callId = typeof value.callId === "string" && safeCallIdPattern.test(value.callId)
    ? value.callId
    : undefined;
  const occurredAt = typeof value.occurredAt === "string" && value.occurredAt.length <= 40
    && Number.isFinite(Date.parse(value.occurredAt))
    ? new Date(value.occurredAt).toISOString()
    : undefined;
  const failureKind = typeof value.failureKind === "string" && failureKinds.has(value.failureKind as BridgeOwnedClientToolFailureKind)
    ? value.failureKind as BridgeOwnedClientToolFailureKind
    : undefined;
  if (callId === undefined || occurredAt === undefined || failureKind === undefined) return undefined;
  return { callId, occurredAt, failureKind };
}

function boundedSessionFailures(value: unknown): readonly PersistedBridgeOwnedClientToolFailure[] {
  if (!Array.isArray(value)) return [];
  const byCallId = new Map<string, PersistedBridgeOwnedClientToolFailure>();
  for (const entry of value.slice(-maximumBridgeOwnedClientToolFailuresPerSession * 4)) {
    const parsed = persistedFailure(entry);
    if (parsed === undefined) continue;
    byCallId.delete(parsed.callId);
    byCallId.set(parsed.callId, parsed);
  }
  return [...byCallId.values()].slice(-maximumBridgeOwnedClientToolFailuresPerSession);
}

export function boundBridgeOwnedClientToolFailures(
  failures: unknown,
  expectedHostId?: string,
): Readonly<Record<string, readonly PersistedBridgeOwnedClientToolFailure[]>> {
  if (!isRecord(failures)) return {};
  const bounded: Record<string, readonly PersistedBridgeOwnedClientToolFailure[]> = {};
  for (const [sessionId, entries] of Object.entries(failures)) {
    try {
      const parsedSession = parseGlobalSessionId(sessionId);
      if (expectedHostId !== undefined && parsedSession.hostId !== expectedHostId) continue;
      const parsedEntries = boundedSessionFailures(entries);
      if (parsedEntries.length === 0) continue;
      delete bounded[sessionId];
      bounded[sessionId] = parsedEntries;
      while (Object.keys(bounded).length > maximumBridgeOwnedClientToolFailureSessions) {
        const oldest = Object.keys(bounded)[0];
        if (oldest === undefined) break;
        delete bounded[oldest];
      }
    } catch {
      // A malformed task identity must never attach a failure to another task.
    }
  }
  return bounded;
}

function validate(value: unknown, expectedHostId?: string): BridgeOwnedClientToolFailureState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.failures)) {
    throw new Error("Client-tool failure state file is invalid");
  }
  return {
    version: 1,
    failures: boundBridgeOwnedClientToolFailures(value.failures, expectedHostId),
  };
}

export function defaultBridgeOwnedClientToolFailureStatePath(configPath: string): string {
  return `${dirname(configPath)}/client-tool-failures.json`;
}

export class BridgeOwnedClientToolFailureStore {
  readonly #store: JsonFileStore<BridgeOwnedClientToolFailureState>;
  readonly #expectedHostId: string | undefined;
  #pending: BridgeOwnedClientToolFailureState | undefined;
  #drain: Promise<void> | undefined;
  #writeFailure: { readonly error: unknown } | undefined;

  public constructor(path: string, expectedHostId?: string) {
    this.#expectedHostId = expectedHostId;
    this.#store = new JsonFileStore(path, (value) => validate(value, expectedHostId));
  }

  public async read(): Promise<BridgeOwnedClientToolFailureState> {
    return await this.#store.read({ version: 1, failures: {} });
  }

  public scheduleWrite(
    failures: Readonly<Record<string, readonly PersistedBridgeOwnedClientToolFailure[]>>,
  ): Promise<void> {
    this.#pending = {
      version: 1,
      failures: boundBridgeOwnedClientToolFailures(failures, this.#expectedHostId),
    };
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
