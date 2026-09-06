import type { ProviderQueuedMessage } from "../../provider_contract/src/index.js";
import { isRecord } from "./normalize.js";

export interface GrokNativeQueuedMessage extends ProviderQueuedMessage {
  /** Monotonic Grok queue revision required by versioned native mutations. */
  readonly version: number;
}

export interface GrokNativeQueueSnapshot {
  readonly sessionId: string;
  readonly entries: readonly GrokNativeQueuedMessage[];
  readonly runningPromptId?: string;
}

export function isGrokQueueChangedMethod(method: string): boolean {
  const name = method.toLowerCase();
  return name === "_x.ai/queue/changed" || name === "x.ai/queue/changed" || name.endsWith("/queue/changed");
}

export function parseGrokQueueChanged(params: unknown, now: Date): GrokNativeQueueSnapshot | undefined {
  if (!isRecord(params)) return undefined;
  const sessionId = firstString(params, ["sessionId", "session_id"]);
  if (sessionId === undefined) return undefined;
  const runningPromptId = firstString(params, ["runningPromptId", "running_prompt_id"]);
  const entries = Array.isArray(params.entries)
    ? params.entries.flatMap((entry, index) => {
      const parsed = parseGrokQueueEntry(sessionId, entry, now, index);
      return parsed === undefined ? [] : [parsed];
    })
    : [];
  return {
    sessionId,
    entries,
    ...(runningPromptId !== undefined ? { runningPromptId } : {}),
  };
}

export function grokQueueRemoveParams(providerSessionId: string, messageId: string): Record<string, string> {
  return { sessionId: providerSessionId, id: messageId };
}

export function grokQueueEditParams(providerSessionId: string, messageId: string, content: string): Record<string, string> {
  return { sessionId: providerSessionId, id: messageId, newText: content };
}

export function grokQueueInterjectParams(
  providerSessionId: string,
  messageId: string,
  expectedVersion: number,
  newText?: string,
): Record<string, string | number> {
  return {
    sessionId: providerSessionId,
    id: messageId,
    expectedVersion,
    ...(newText !== undefined ? { newText } : {}),
  };
}

function parseGrokQueueEntry(
  providerSessionId: string,
  value: unknown,
  now: Date,
  index: number,
): GrokNativeQueuedMessage | undefined {
  if (typeof value === "string" && value.trim()) {
    return {
      id: `grok-queue-${index}`,
      providerSessionId,
      content: value,
      state: "queued",
      createdAt: now.toISOString(),
      version: 0,
    };
  }
  if (!isRecord(value)) return undefined;
  const kind = firstString(value, ["kind", "type"])?.toLowerCase();
  if (kind !== undefined && kind !== "prompt" && kind !== "follow_up" && kind !== "follow-up") return undefined;
  const content = firstString(value, ["text", "content", "prompt", "message"]);
  if (content === undefined) return undefined;
  const id = firstString(value, ["id", "entryId", "entry_id", "queue_entry_id"]) ?? `grok-queue-${index}`;
  const version = firstNonNegativeInteger(value, ["version", "queueVersion", "queue_version"]) ?? 0;
  return {
    id,
    providerSessionId,
    content,
    state: "queued",
    createdAt: now.toISOString(),
    version,
  };
}

function firstString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function firstNonNegativeInteger(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}
