import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export type QueueDeliveryState = "prepared" | "in_flight" | "unknown" | "confirmed" | "rejected";

export interface QueueDeliveryAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly durationSeconds?: number;
}

/** Durable evidence for one attempt to move a queued instruction into provider history. */
export interface QueueDeliveryRecord {
  readonly source: "queue" | "direct";
  readonly deliveryId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly providerId: string;
  readonly providerSessionId: string;
  readonly providerOwned: boolean;
  readonly providerMessageId?: string;
  readonly mode: "send" | "steer";
  /** User-authored text shown by a direct-send tombstone when provider bootstrap text differs. */
  readonly displayContent?: string;
  readonly content: string;
  readonly contentHash: string;
  readonly payloadHash: string;
  readonly queuedCreatedAt: string;
  readonly attachments: readonly QueueDeliveryAttachment[];
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly state: QueueDeliveryState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error?: string;
  /** Hides an unresolved tombstone without making the delivery safe to retry. */
  readonly dismissedAt?: string;
}

export interface QueueDeliveryStateFile {
  readonly version: 1;
  readonly deliveries: readonly QueueDeliveryRecord[];
}

export const maximumQueueDeliveryRecords = 1_024;
export const maximumQueueDeliveryContentLength = 100_000;
export const maximumQueueDeliveryStateBytes = 32 * 1024 * 1024;

const states = new Set<QueueDeliveryState>(["prepared", "in_flight", "unknown", "confirmed", "rejected"]);
const digestPattern = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`Persisted queue-delivery ${name} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, name: string, optional = false): string | undefined {
  const parsed = boundedString(value, name, 64, optional);
  if (parsed === undefined) return undefined;
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`Persisted queue-delivery ${name} is invalid`);
  return new Date(parsed).toISOString();
}

function attachment(value: unknown): QueueDeliveryAttachment {
  if (!isRecord(value)) throw new Error("Persisted queue-delivery attachment is invalid");
  const byteLength = value.byteLength;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
    throw new Error("Persisted queue-delivery attachment size is invalid");
  }
  const durationSeconds = value.durationSeconds;
  if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
    throw new Error("Persisted queue-delivery attachment duration is invalid");
  }
  return {
    name: boundedString(value.name, "attachment name", 1_024)!,
    mimeType: boundedString(value.mimeType, "attachment MIME type", 256)!,
    byteLength: byteLength as number,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

export function normalizeQueueDeliveryContent(content: string): string {
  return content.trim().replace(/\r\n?/gu, "\n");
}

export function queueDeliveryContentHash(content: string): string {
  return createHash("sha256").update(normalizeQueueDeliveryContent(content), "utf8").digest("hex");
}

export function queueDeliveryPayloadHash(input: Pick<QueueDeliveryRecord,
  "source" | "providerId" | "providerSessionId" | "providerOwned" | "providerMessageId" | "mode" | "displayContent" | "content" | "attachments" | "modelId" | "reasoningEffort"
>): string {
  return createHash("sha256").update(JSON.stringify({
    source: input.source,
    providerId: input.providerId,
    providerSessionId: input.providerSessionId,
    providerOwned: input.providerOwned,
    providerMessageId: input.providerMessageId ?? null,
    mode: input.mode,
    displayContent: input.displayContent ?? null,
    content: normalizeQueueDeliveryContent(input.content),
    attachments: input.attachments.map((item) => ({
      name: item.name,
      mimeType: item.mimeType,
      byteLength: item.byteLength,
      durationSeconds: item.durationSeconds ?? null,
    })),
    modelId: input.modelId ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
  }), "utf8").digest("hex");
}

function delivery(value: unknown, expectedHostId?: string): QueueDeliveryRecord {
  if (!isRecord(value)) throw new Error("Persisted queue-delivery record is invalid");
  const sessionId = boundedString(value.sessionId, "session ID", 16_384)!;
  const providerId = boundedString(value.providerId, "provider ID", 256)!;
  const providerSessionId = boundedString(value.providerSessionId, "provider session ID", 16_384)!;
  const parsedSession = parseGlobalSessionId(sessionId);
  if (parsedSession.providerId !== providerId || parsedSession.providerSessionId !== providerSessionId
    || (expectedHostId !== undefined && parsedSession.hostId !== expectedHostId)) {
    throw new Error("Persisted queue-delivery session identity is invalid");
  }
  const state = value.state;
  if (typeof state !== "string" || !states.has(state as QueueDeliveryState)) {
    throw new Error("Persisted queue-delivery state is invalid");
  }
  const mode = value.mode;
  if (mode !== "send" && mode !== "steer") throw new Error("Persisted queue-delivery mode is invalid");
  const source = value.source;
  if (source !== "queue" && source !== "direct") throw new Error("Persisted queue-delivery source is invalid");
  if (typeof value.providerOwned !== "boolean") throw new Error("Persisted queue-delivery ownership is invalid");
  const attachments = Array.isArray(value.attachments) && value.attachments.length <= 128
    ? value.attachments.map(attachment)
    : (() => { throw new Error("Persisted queue-delivery attachments are invalid"); })();
  if (typeof value.content !== "string" || value.content.length > maximumQueueDeliveryContentLength) {
    throw new Error("Persisted queue-delivery content is invalid");
  }
  const content = value.content;
  const contentHash = boundedString(value.contentHash, "content hash", 64)!;
  const payloadHash = boundedString(value.payloadHash, "payload hash", 64)!;
  const record: QueueDeliveryRecord = {
    source,
    deliveryId: boundedString(value.deliveryId, "delivery ID", 256)!,
    requestId: boundedString(value.requestId, "request ID", 256)!,
    messageId: boundedString(value.messageId, "message ID", 4_096)!,
    sessionId,
    providerId,
    providerSessionId,
    providerOwned: value.providerOwned,
    ...(value.providerMessageId !== undefined ? { providerMessageId: boundedString(value.providerMessageId, "provider message ID", 4_096)! } : {}),
    mode,
    ...(value.displayContent !== undefined
      ? {
          displayContent: typeof value.displayContent === "string" && value.displayContent.length <= maximumQueueDeliveryContentLength
            ? value.displayContent
            : (() => { throw new Error("Persisted queue-delivery display content is invalid"); })(),
        }
      : {}),
    content,
    contentHash,
    payloadHash,
    queuedCreatedAt: timestamp(value.queuedCreatedAt, "queued creation time")!,
    attachments,
    ...(value.modelId !== undefined ? { modelId: boundedString(value.modelId, "model ID", 512)! } : {}),
    ...(value.reasoningEffort !== undefined ? { reasoningEffort: boundedString(value.reasoningEffort, "reasoning effort", 128)! } : {}),
    state: state as QueueDeliveryState,
    createdAt: timestamp(value.createdAt, "creation time")!,
    updatedAt: timestamp(value.updatedAt, "update time")!,
    ...(value.error !== undefined ? { error: boundedString(value.error, "error", 4_096)! } : {}),
    ...(value.dismissedAt !== undefined ? { dismissedAt: timestamp(value.dismissedAt, "dismissal time")! } : {}),
  };
  if (!digestPattern.test(contentHash) || contentHash !== queueDeliveryContentHash(content)
    || !digestPattern.test(payloadHash) || payloadHash !== queueDeliveryPayloadHash(record)) {
    throw new Error("Persisted queue-delivery hash is invalid");
  }
  if (record.dismissedAt !== undefined && record.state !== "unknown" && record.state !== "confirmed") {
    throw new Error("Persisted queue-delivery dismissal is invalid");
  }
  return record;
}

export function validateQueueDeliveryState(value: unknown, expectedHostId?: string): QueueDeliveryStateFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.deliveries)
    || value.deliveries.length > maximumQueueDeliveryRecords) {
    throw new Error("Queue-delivery state file is invalid");
  }
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { throw new Error("Queue-delivery state file is invalid"); }
  if (bytes > maximumQueueDeliveryStateBytes) throw new Error("Queue-delivery state file exceeds its byte limit");
  const deliveries = value.deliveries.map((entry) => delivery(entry, expectedHostId));
  for (const key of ["deliveryId", "requestId", "messageId"] as const) {
    if (new Set(deliveries.map((entry) => entry[key])).size !== deliveries.length) {
      throw new Error(`Persisted queue deliveries contain duplicate ${key}s`);
    }
  }
  return { version: 1, deliveries };
}

export function defaultQueueDeliveryStatePath(configPath: string): string {
  return join(dirname(configPath), "queue-deliveries.json");
}

export class QueueDeliveryStore {
  readonly #store: JsonFileStore<QueueDeliveryStateFile>;
  readonly #expectedHostId: string | undefined;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string, expectedHostId?: string) {
    this.#expectedHostId = expectedHostId;
    this.#store = new JsonFileStore(path, (value) => validateQueueDeliveryState(value, expectedHostId));
  }

  public async read(): Promise<QueueDeliveryStateFile> {
    await this.#tail;
    return await this.#store.read({ version: 1, deliveries: [] });
  }

  public scheduleWrite(deliveries: readonly QueueDeliveryRecord[]): Promise<void> {
    const snapshot = validateQueueDeliveryState({ version: 1, deliveries }, this.#expectedHostId);
    const write = this.#tail.then(() => this.#store.write(snapshot));
    this.#tail = write.catch(() => undefined);
    return write;
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
