import { dirname } from "node:path";
import type { CrossSessionMessage, CrossSessionMessageEnvelope } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export interface CrossSessionInboxState {
  readonly version: 1;
  readonly messages: readonly CrossSessionMessage[];
}

export const maxCrossSessionMessages = 2_000;
export const maxPendingCrossSessionMessagesPerTarget = 100;
export const maxCrossSessionContentLength = 32_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`Persisted cross-session ${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  const result = boundedString(value, name, 64)!;
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Persisted cross-session ${name} is invalid`);
  return result;
}

function envelope(value: unknown): CrossSessionMessageEnvelope {
  if (!isRecord(value) || value.version !== 1) throw new Error("Persisted cross-session envelope is invalid");
  return {
    version: 1,
    id: boundedString(value.id, "envelope ID", 128)!,
    requestId: boundedString(value.requestId, "request ID", 256)!,
    sourceSessionId: boundedString(value.sourceSessionId, "source session ID", 16_384)!,
    sourceTitle: boundedString(value.sourceTitle, "source title", 240)!,
    targetSessionId: boundedString(value.targetSessionId, "target session ID", 16_384)!,
    content: boundedString(value.content, "message", maxCrossSessionContentLength)!,
    createdAt: timestamp(value.createdAt, "creation time"),
  };
}

function message(value: unknown): CrossSessionMessage {
  if (!isRecord(value)) throw new Error("Persisted cross-session message is invalid");
  const parsedEnvelope = envelope(value.envelope);
  const state = value.state;
  if (state !== "pending" && state !== "sending" && state !== "delivered" && state !== "failed") {
    throw new Error("Persisted cross-session message state is invalid");
  }
  if (!Number.isSafeInteger(value.attemptCount) || (value.attemptCount as number) < 0 || (value.attemptCount as number) > 1_000) {
    throw new Error("Persisted cross-session attempt count is invalid");
  }
  const updatedAt = timestamp(value.updatedAt, "update time");
  const deliveredAt = value.deliveredAt === undefined ? undefined : timestamp(value.deliveredAt, "delivery time");
  const error = boundedString(value.error, "error", 2_000, true);
  const providerMessageIds = value.providerMessageIds === undefined
    ? undefined
    : Array.isArray(value.providerMessageIds)
      && value.providerMessageIds.length <= 4
      && value.providerMessageIds.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 1_024)
        ? [...new Set(value.providerMessageIds)] as string[]
        : (() => { throw new Error("Persisted cross-session provider message IDs are invalid"); })();
  if (state === "delivered" && deliveredAt === undefined) throw new Error("Persisted delivered cross-session message has no delivery time");
  return {
    envelope: parsedEnvelope,
    state,
    attemptCount: value.attemptCount as number,
    updatedAt,
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(providerMessageIds !== undefined ? { providerMessageIds } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

export function validateCrossSessionInboxState(value: unknown): CrossSessionInboxState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.messages) || value.messages.length > maxCrossSessionMessages) {
    throw new Error("Cross-session inbox state file is invalid");
  }
  const messages = value.messages.map(message);
  if (new Set(messages.map((entry) => entry.envelope.id)).size !== messages.length) {
    throw new Error("Persisted cross-session inbox contains duplicate envelope IDs");
  }
  const idempotencyKeys = messages.map((entry) => `${entry.envelope.sourceSessionId}\u0000${entry.envelope.requestId}`);
  if (new Set(idempotencyKeys).size !== idempotencyKeys.length) {
    throw new Error("Persisted cross-session inbox contains duplicate request IDs");
  }
  const pendingPerTarget = new Map<string, number>();
  for (const entry of messages) {
    if (entry.state !== "pending") continue;
    const count = (pendingPerTarget.get(entry.envelope.targetSessionId) ?? 0) + 1;
    if (count > maxPendingCrossSessionMessagesPerTarget) {
      throw new Error("Persisted cross-session inbox exceeds the per-task pending-message limit");
    }
    pendingPerTarget.set(entry.envelope.targetSessionId, count);
  }
  return { version: 1, messages };
}

export function defaultCrossSessionInboxStatePath(configPath: string): string {
  return `${dirname(configPath)}/cross-session-inbox.json`;
}

export class CrossSessionInboxStore {
  readonly #store: JsonFileStore<CrossSessionInboxState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validateCrossSessionInboxState);
  }

  public async read(): Promise<CrossSessionInboxState> {
    return await this.#store.read({ version: 1, messages: [] });
  }

  public scheduleWrite(messages: readonly CrossSessionMessage[]): Promise<void> {
    const snapshot = messages.map((entry) => ({
      ...entry,
      envelope: { ...entry.envelope },
      ...(entry.providerMessageIds !== undefined ? { providerMessageIds: [...entry.providerMessageIds] } : {}),
    }));
    const write = this.#tail.then(() => this.#store.write({ version: 1, messages: snapshot }));
    this.#tail = write.catch(() => undefined);
    return write;
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
