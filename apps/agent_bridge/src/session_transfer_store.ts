import { dirname } from "node:path";
import type { RemoteMessage, SessionRelationship } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export interface SessionTransferRecord {
  readonly sessionId: string;
  readonly relationship: SessionRelationship;
  readonly pending: boolean;
  readonly summary?: string;
  readonly prompt?: string;
  readonly bootstrap?: string;
  readonly copiedMessages?: readonly RemoteMessage[];
  readonly sideChatPreview?: string;
}

export interface SessionTransferState {
  readonly version: 1;
  readonly transfers: readonly SessionTransferRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`Persisted ${name} is invalid`);
  return value;
}

function relationship(value: unknown): SessionRelationship {
  if (!isRecord(value)) throw new Error("Persisted session-transfer relationship is invalid");
  const kind = value.kind;
  const strategy = value.strategy;
  const sourceSessionId = boundedString(value.sourceSessionId, "source session ID", 16_384)!;
  if (kind === "handoff" && strategy === "summary_bootstrap") return { kind, strategy, sourceSessionId };
  if ((kind === "branch" || kind === "side_chat") && (strategy === "native" || strategy === "transcript_bootstrap")) return { kind, strategy, sourceSessionId };
  throw new Error("Persisted session-transfer relationship is invalid");
}

function messages(value: unknown): readonly RemoteMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000 || Buffer.byteLength(JSON.stringify(value), "utf8") > 2_000_000) {
    throw new Error("Persisted branch message copy is invalid");
  }
  for (const message of value) {
    if (!isRecord(message) || typeof message.id !== "string" || typeof message.sessionId !== "string"
      || typeof message.providerMessageId !== "string" || !["user", "assistant", "system", "tool"].includes(String(message.role))
      || typeof message.createdAt !== "string" || !Array.isArray(message.parts)
      || !["streaming", "completed", "failed"].includes(String(message.status)) || !isRecord(message.nativeMetadata)) {
      throw new Error("Persisted branch message copy is invalid");
    }
  }
  return value as RemoteMessage[];
}

function transfer(value: unknown): SessionTransferRecord {
  if (!isRecord(value) || typeof value.pending !== "boolean") throw new Error("Persisted session transfer is invalid");
  const sessionId = boundedString(value.sessionId, "session ID", 16_384)!;
  const relation = relationship(value.relationship);
  const summary = boundedString(value.summary, "handoff summary", 200_000, true);
  const prompt = boundedString(value.prompt, "handoff prompt", 100_000, true);
  const bootstrap = boundedString(value.bootstrap, "branch bootstrap", 1_000_000, true);
  const sideChatPreview = boundedString(value.sideChatPreview, "side-chat preview", 1_000, true);
  const copiedMessages = messages(value.copiedMessages);
  if (relation.kind === "handoff" && summary === undefined) throw new Error("Persisted handoff summary is missing");
  if ((relation.kind === "branch" || relation.kind === "side_chat") && relation.strategy === "transcript_bootstrap" && value.pending === true && bootstrap === undefined) {
    throw new Error("Persisted pending branch bootstrap is missing");
  }
  return {
    sessionId,
    relationship: relation,
    pending: value.pending,
    ...(summary !== undefined ? { summary } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(bootstrap !== undefined ? { bootstrap } : {}),
    ...(copiedMessages !== undefined ? { copiedMessages } : {}),
    ...(sideChatPreview !== undefined ? { sideChatPreview } : {}),
  };
}

function validate(value: unknown): SessionTransferState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.transfers) || value.transfers.length > 1_000) {
    throw new Error("Session-transfer state file is invalid");
  }
  const transfers = value.transfers.map(transfer);
  if (new Set(transfers.map((entry) => entry.sessionId)).size !== transfers.length) throw new Error("Persisted session transfers contain duplicate sessions");
  return { version: 1, transfers };
}

export function defaultSessionTransferStatePath(configPath: string): string {
  return `${dirname(configPath)}/session-transfers.json`;
}

export class SessionTransferStateStore {
  readonly #store: JsonFileStore<SessionTransferState>;
  #tail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#store = new JsonFileStore(path, validate);
  }

  public async read(): Promise<SessionTransferState> {
    return await this.#store.read({ version: 1, transfers: [] });
  }

  public scheduleWrite(transfers: readonly SessionTransferRecord[]): void {
    this.#tail = this.#tail.then(() => this.#store.write({ version: 1, transfers }));
  }

  public async flush(): Promise<void> {
    await this.#tail;
  }
}
