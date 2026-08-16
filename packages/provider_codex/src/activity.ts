import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ContentPart, SessionState } from "../../protocol/src/index.js";
import { stripProviderPromptGuidance } from "../../provider_contract/src/index.js";
import { codexUserContentParts, isCodexBootstrapUserText } from "./normalize.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_TAIL_BYTES = 256 * 1_024;
const MESSAGE_READ_CHUNK_BYTES = 64 * 1_024;
const MAX_MESSAGE_BYTES_PER_POLL = 1 * 1_024 * 1_024;
const MAX_ROLLOUT_LINE_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_HISTORY_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_HISTORY_MESSAGES = 400;

type RolloutMarker = "started" | "terminal" | "truncated" | "unknown";

export interface CodexActivityThread {
  readonly providerSessionId: string;
  readonly path?: string | null;
  readonly nativeState: SessionState;
}

export interface CodexObservedMessage {
  readonly messageId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly partType: "text" | "reasoning";
  readonly parts?: readonly ContentPart[];
  readonly phase?: "commentary" | "final_answer";
  readonly createdAt?: string;
}

export interface CodexTurnMetadata {
  readonly modelId?: string;
  readonly reasoningEffort?: string;
}

export interface CodexContextObservation {
  readonly usedTokens: number | null;
  readonly contextWindowTokens: number | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly totalTokens?: number;
  readonly updatedAt?: string;
}

export interface CodexActivityReconcilerOptions {
  readonly codexHome?: string;
  readonly pollIntervalMs?: number;
  readonly tailBytes?: number;
  readonly isLockHeld?: (lockPath: string) => Promise<boolean>;
  readonly onStateChanged: (providerSessionId: string, state: SessionState) => void | Promise<void>;
  readonly onMessage?: (providerSessionId: string, message: CodexObservedMessage) => void | Promise<void>;
  readonly onTurnMetadataChanged?: (providerSessionId: string, metadata: CodexTurnMetadata) => void | Promise<void>;
  readonly onContextChanged?: (providerSessionId: string, context: CodexContextObservation) => void | Promise<void>;
}

interface TrackedThread {
  path: string;
  fingerprint: string | undefined;
  marker: RolloutMarker;
  state: SessionState;
  messageOffset: number;
  partialLine: Buffer;
  droppingOversizedLine: boolean;
}

interface TrackedTurnMetadata {
  path: string;
  fingerprint: string | null;
}

interface RolloutObservation {
  readonly message?: CodexObservedMessage;
  readonly context?: CodexContextObservation;
}

/**
 * Reconciles Codex Desktop-owned threads whose App Server state is notLoaded.
 * It also observes newly appended, user-visible message records. Existing
 * transcript content is skipped when a thread is registered, and raw rollout
 * records never leave this module.
 */
export class CodexActivityReconciler {
  readonly #codexHome: string;
  readonly #pollIntervalMs: number;
  readonly #tailBytes: number;
  readonly #isLockHeld: (lockPath: string) => Promise<boolean>;
  readonly #onStateChanged: (providerSessionId: string, state: SessionState) => void | Promise<void>;
  readonly #onMessage: (providerSessionId: string, message: CodexObservedMessage) => void | Promise<void>;
  readonly #onTurnMetadataChanged: (providerSessionId: string, metadata: CodexTurnMetadata) => void | Promise<void>;
  readonly #onContextChanged: (providerSessionId: string, context: CodexContextObservation) => void | Promise<void>;
  readonly #knownPaths = new Map<string, string>();
  readonly #trackedTurnMetadata = new Map<string, TrackedTurnMetadata>();
  readonly #turnMetadata = new Map<string, CodexTurnMetadata>();
  readonly #context = new Map<string, CodexContextObservation>();
  readonly #tracked = new Map<string, TrackedThread>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #disposed = false;

  public constructor(options: CodexActivityReconcilerOptions) {
    this.#codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
    this.#isLockHeld = options.isLockHeld ?? lockFileExists;
    this.#onStateChanged = options.onStateChanged;
    this.#onMessage = options.onMessage ?? (() => undefined);
    this.#onTurnMetadataChanged = options.onTurnMetadataChanged ?? (() => undefined);
    this.#onContextChanged = options.onContextChanged ?? (() => undefined);
  }

  public async reconcile(threads: readonly CodexActivityThread[]): Promise<ReadonlyMap<string, SessionState>> {
    const result = new Map<string, SessionState>();
    for (const thread of threads) {
      if (validRolloutPath(thread.path)) this.#knownPaths.set(thread.providerSessionId, thread.path);
      const path = validRolloutPath(thread.path) ? thread.path : this.#knownPaths.get(thread.providerSessionId);
      if (path !== undefined) await this.trackTurnMetadata(thread.providerSessionId, path);
      if (thread.nativeState !== "unknown") {
        this.#tracked.delete(thread.providerSessionId);
        result.set(thread.providerSessionId, thread.nativeState);
        continue;
      }

      if (path === undefined) {
        this.#tracked.delete(thread.providerSessionId);
        result.set(thread.providerSessionId, "unknown");
        continue;
      }

      let tracked = this.#tracked.get(thread.providerSessionId);
      if (tracked === undefined || tracked.path !== path) {
        await this.refreshTurnMetadata(thread.providerSessionId, path, this.#turnMetadata.has(thread.providerSessionId));
        tracked = {
          path,
          fingerprint: undefined,
          marker: "unknown",
          state: "unknown",
          messageOffset: await rolloutSize(path) ?? 0,
          partialLine: Buffer.alloc(0),
          droppingOversizedLine: false,
        };
        this.#tracked.set(thread.providerSessionId, tracked);
      }
      tracked.state = await this.resolve(thread.providerSessionId, tracked);
      result.set(thread.providerSessionId, tracked.state);
    }
    this.updateTimer();
    return result;
  }

  public turnMetadata(providerSessionId: string): CodexTurnMetadata | undefined {
    return this.#turnMetadata.get(providerSessionId);
  }

  public context(providerSessionId: string): CodexContextObservation | undefined {
    return this.#context.get(providerSessionId);
  }

  public async activeThreadIds(maximum = 16): Promise<readonly string[]> {
    try {
      const entries = await readdir(join(this.#codexHome, "thread-writer-locks"), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/iu.test(entry.name))
        .slice(0, Math.max(1, maximum))
        .map((entry) => entry.name.slice(0, -".lock".length));
    } catch {
      return [];
    }
  }

  public async recentMessages(providerSessionId: string): Promise<readonly CodexObservedMessage[]> {
    const path = this.#knownPaths.get(providerSessionId);
    return path === undefined ? [] : readRecentRolloutMessages(path);
  }

  /** Exposed for deterministic tests and immediate host refreshes. */
  public async pollNow(): Promise<void> {
    if (this.#disposed || this.#polling) return;
    this.#polling = true;
    try {
      for (const [providerSessionId, tracked] of this.#trackedTurnMetadata) {
        const fingerprint = await fileFingerprint(tracked.path);
        if (fingerprint === tracked.fingerprint) continue;
        tracked.fingerprint = fingerprint;
        await this.refreshTurnMetadata(providerSessionId, tracked.path, true);
        await this.refreshContext(providerSessionId, tracked.path, true);
      }
      for (const [providerSessionId, tracked] of this.#tracked) {
        await this.readNewMessages(providerSessionId, tracked);
        if (this.#tracked.get(providerSessionId) !== tracked) continue;
        const previous = tracked.state;
        const next = await this.resolve(providerSessionId, tracked);
        tracked.state = next;
        if (!this.#disposed && next !== previous) await this.#onStateChanged(providerSessionId, next);
      }
    } finally {
      this.#polling = false;
    }
  }

  public dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#tracked.clear();
    this.#knownPaths.clear();
    this.#trackedTurnMetadata.clear();
    this.#turnMetadata.clear();
    this.#context.clear();
  }

  private async resolve(providerSessionId: string, tracked: TrackedThread): Promise<SessionState> {
    const fingerprint = await fileFingerprint(tracked.path);
    if (fingerprint === null) {
      tracked.fingerprint = undefined;
      tracked.marker = "unknown";
      return "unknown";
    }
    if (fingerprint !== tracked.fingerprint) {
      tracked.fingerprint = fingerprint;
      tracked.marker = await readLatestRolloutMarker(tracked.path, this.#tailBytes);
    }
    if (tracked.marker === "terminal") return "idle";
    if (tracked.marker !== "started" && tracked.marker !== "truncated") return "unknown";
    if (!safeThreadId(providerSessionId)) return "unknown";
    const lockPath = join(this.#codexHome, "thread-writer-locks", `${providerSessionId}.lock`);
    try {
      return await this.#isLockHeld(lockPath) ? "working" : "idle";
    } catch {
      return "unknown";
    }
  }

  private async readNewMessages(providerSessionId: string, tracked: TrackedThread): Promise<void> {
    let handle;
    try {
      const metadata = await stat(tracked.path);
      if (!metadata.isFile()) return;
      if (metadata.size < tracked.messageOffset) {
        // Rollouts are append-only. If one is replaced or truncated, establish
        // a fresh baseline instead of replaying the replacement's history.
        tracked.messageOffset = metadata.size;
        tracked.partialLine = Buffer.alloc(0);
        tracked.droppingOversizedLine = false;
        return;
      }
      if (metadata.size === tracked.messageOffset) return;

      const end = Math.min(metadata.size, tracked.messageOffset + MAX_MESSAGE_BYTES_PER_POLL);
      handle = await open(tracked.path, "r");
      while (tracked.messageOffset < end) {
        const length = Math.min(MESSAGE_READ_CHUNK_BYTES, end - tracked.messageOffset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, tracked.messageOffset);
        if (bytesRead === 0) break;
        tracked.messageOffset += bytesRead;
        const observations = consumeRolloutBytes(tracked, buffer.subarray(0, bytesRead));
        for (const observation of observations) {
          if (this.#disposed || this.#tracked.get(providerSessionId) !== tracked) return;
          if (observation.message !== undefined) await this.#onMessage(providerSessionId, observation.message);
          if (observation.context !== undefined) await this.applyContext(providerSessionId, observation.context, true);
        }
      }
    } catch {
      // A rollout can disappear between thread/list and a poll. Status
      // reconciliation will report that independently; the observer retries.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async trackTurnMetadata(providerSessionId: string, path: string): Promise<void> {
    const tracked = this.#trackedTurnMetadata.get(providerSessionId);
    if (tracked !== undefined && tracked.path === path) return;
    const fingerprint = await fileFingerprint(path);
    await this.refreshTurnMetadata(providerSessionId, path, this.#turnMetadata.has(providerSessionId));
    await this.refreshContext(providerSessionId, path, this.#context.has(providerSessionId));
    this.#trackedTurnMetadata.set(providerSessionId, { path, fingerprint });
  }

  private async refreshTurnMetadata(providerSessionId: string, path: string, notify: boolean): Promise<void> {
    const metadata = await readLatestRolloutTurnMetadata(path, this.#tailBytes);
    if (metadata === null) {
      this.#turnMetadata.delete(providerSessionId);
      return;
    }
    await this.applyTurnMetadata(providerSessionId, metadata, notify);
  }

  private async applyTurnMetadata(providerSessionId: string, metadata: CodexTurnMetadata, notify: boolean): Promise<void> {
    const previous = this.#turnMetadata.get(providerSessionId);
    this.#turnMetadata.set(providerSessionId, metadata);
    if (notify && !sameTurnMetadata(previous, metadata)) await this.#onTurnMetadataChanged(providerSessionId, metadata);
  }

  private async refreshContext(providerSessionId: string, path: string, notify: boolean): Promise<void> {
    const context = await readLatestRolloutContext(path, this.#tailBytes);
    if (context === null) {
      this.#context.delete(providerSessionId);
      return;
    }
    await this.applyContext(providerSessionId, context, notify);
  }

  private async applyContext(providerSessionId: string, context: CodexContextObservation, notify: boolean): Promise<void> {
    const previous = this.#context.get(providerSessionId);
    this.#context.set(providerSessionId, context);
    if (notify && !sameContext(previous, context)) await this.#onContextChanged(providerSessionId, context);
  }

  private updateTimer(): void {
    if (this.#disposed || (this.#tracked.size === 0 && this.#trackedTurnMetadata.size === 0)) {
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
      return;
    }
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => { void this.pollNow(); }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }
}

function consumeRolloutBytes(tracked: TrackedThread, bytes: Buffer): RolloutObservation[] {
  const observations: RolloutObservation[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const segment = bytes.subarray(start, index);
    if (tracked.droppingOversizedLine) {
      tracked.droppingOversizedLine = false;
    } else {
      if (tracked.partialLine.length + segment.length <= MAX_ROLLOUT_LINE_BYTES) {
        const line = tracked.partialLine.length === 0 ? segment : Buffer.concat([tracked.partialLine, segment]);
        const observation = observationFromLine(line);
        if (observation !== null) observations.push(observation);
      }
    }
    tracked.partialLine = Buffer.alloc(0);
    start = index + 1;
  }

  const remainder = bytes.subarray(start);
  if (remainder.length === 0 || tracked.droppingOversizedLine) return observations;
  if (tracked.partialLine.length + remainder.length > MAX_ROLLOUT_LINE_BYTES) {
    tracked.partialLine = Buffer.alloc(0);
    tracked.droppingOversizedLine = true;
  } else {
    tracked.partialLine = tracked.partialLine.length === 0
      ? Buffer.from(remainder)
      : Buffer.concat([tracked.partialLine, remainder]);
  }
  return observations;
}

function observationFromLine(line: Buffer): RolloutObservation | null {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8").trim());
  } catch {
    return null;
  }
  const message = observedMessageFromValue(value);
  const context = contextFromValue(value);
  return message === null && context === null ? null : {
    ...(message !== null ? { message } : {}),
    ...(context !== null ? { context } : {}),
  };
}

function observedMessageFromValue(value: unknown): CodexObservedMessage | null {
  if (!isRecord(value) || value.type !== "response_item" || !isRecord(value.payload)) return null;
  const payload = value.payload;
  if (payload.type === "reasoning") {
    if (typeof payload.id !== "string" || payload.id.length === 0 || !Array.isArray(payload.summary)) return null;
    const text = payload.summary
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "summary_text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    return text.length === 0
      ? null
      : {
          messageId: payload.id,
          role: "assistant",
          text,
          partType: "reasoning",
          ...(typeof value.timestamp === "string" ? { createdAt: value.timestamp } : {}),
        };
  }
  if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) return null;
  if (typeof payload.id !== "string" || payload.id.length === 0 || !Array.isArray(payload.content)) return null;

  const expectedPartType = payload.role === "user" ? "input_text" : "output_text";
  const normalizedUserParts = payload.role === "user" ? codexUserContentParts(payload.content) : undefined;
  const rawText = payload.role === "user"
    ? normalizedUserParts!.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("")
    : payload.content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === expectedPartType && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  if (payload.role === "user" && isCodexBootstrapUserText(rawText)) return null;
  const text = payload.role === "user" ? stripProviderPromptGuidance(rawText) : rawText;
  if (text.length === 0 && (normalizedUserParts?.length ?? 0) === 0) return null;

  const phase = payload.role === "assistant" && (payload.phase === "commentary" || payload.phase === "final_answer")
    ? payload.phase
    : undefined;
  return {
    messageId: payload.id,
    role: payload.role,
    text,
    partType: "text",
    ...(normalizedUserParts !== undefined ? { parts: normalizedUserParts } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(typeof value.timestamp === "string" ? { createdAt: value.timestamp } : {}),
  };
}

/**
 * Reads only a bounded recent tail from a Codex rollout. The parser exposes
 * user/assistant text and reasoning summaries; commands, tool payloads,
 * encrypted content, and the incomplete leading record are ignored.
 */
export async function readRecentRolloutMessages(
  path: string,
  maxMessages = DEFAULT_HISTORY_MESSAGES,
  maxBytes = DEFAULT_HISTORY_BYTES,
): Promise<readonly CodexObservedMessage[]> {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size === 0) return [];
    const length = Math.min(metadata.size, Math.max(1, maxBytes));
    const start = metadata.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const boundary = text.indexOf("\n");
      if (boundary < 0) return [];
      text = text.slice(boundary + 1);
    }
    const messages: CodexObservedMessage[] = [];
    for (const rawLine of text.split("\n")) {
      if (Buffer.byteLength(rawLine, "utf8") > MAX_ROLLOUT_LINE_BYTES) continue;
      let value: unknown;
      try {
        value = JSON.parse(rawLine.trim());
      } catch {
        continue;
      }
      const message = observedMessageFromValue(value);
      if (message !== null) messages.push(message);
    }
    return messages.slice(-Math.max(1, maxMessages));
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function turnMetadataFromValue(value: unknown): CodexTurnMetadata | null {
  if (!isRecord(value) || value.type !== "turn_context" || !isRecord(value.payload)) return null;
  const modelId = typeof value.payload.model === "string" && value.payload.model.trim() ? value.payload.model.trim() : undefined;
  const rawEffort = typeof value.payload.effort === "string" ? value.payload.effort : value.payload.reasoning_effort;
  const reasoningEffort = typeof rawEffort === "string" && rawEffort.trim() ? rawEffort.trim() : undefined;
  if (modelId === undefined && reasoningEffort === undefined) return null;
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

function sameTurnMetadata(left: CodexTurnMetadata | undefined, right: CodexTurnMetadata): boolean {
  return left?.modelId === right.modelId && left?.reasoningEffort === right.reasoningEffort;
}

function finiteToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function contextFromValue(value: unknown): CodexContextObservation | null {
  if (!isRecord(value) || value.type !== "event_msg" || !isRecord(value.payload) || value.payload.type !== "token_count") return null;
  const info = isRecord(value.payload.info) ? value.payload.info : null;
  if (info === null) return null;
  const last = isRecord(info.last_token_usage) ? info.last_token_usage : null;
  const contextWindowTokens = finiteToken(info.model_context_window) ?? null;
  const inputTokens = last === null ? undefined : finiteToken(last.input_tokens);
  const outputTokens = last === null ? undefined : finiteToken(last.output_tokens);
  const cacheReadTokens = last === null ? undefined : finiteToken(last.cached_input_tokens);
  const totalTokens = last === null ? undefined : finiteToken(last.total_tokens);
  const usedTokens = totalTokens ?? (inputTokens !== undefined || outputTokens !== undefined
    ? (inputTokens ?? 0) + (outputTokens ?? 0)
    : null);
  if (usedTokens === null && contextWindowTokens === null) return null;
  return {
    usedTokens,
    contextWindowTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(typeof value.timestamp === "string" ? { updatedAt: value.timestamp } : {}),
  };
}

function sameContext(left: CodexContextObservation | undefined, right: CodexContextObservation): boolean {
  return left?.usedTokens === right.usedTokens
    && left?.contextWindowTokens === right.contextWindowTokens
    && left?.inputTokens === right.inputTokens
    && left?.outputTokens === right.outputTokens
    && left?.cacheReadTokens === right.cacheReadTokens
    && left?.totalTokens === right.totalTokens;
}

function validRolloutPath(value: string | null | undefined): value is string {
  return typeof value === "string" && isAbsolute(value);
}

function safeThreadId(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

async function lockFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function fileFingerprint(path: string): Promise<string | null> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() ? `${metadata.mtimeMs}:${metadata.size}` : null;
  } catch {
    return null;
  }
}

async function rolloutSize(path: string): Promise<number | null> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() ? metadata.size : null;
  } catch {
    return null;
  }
}

export async function readLatestRolloutTurnMetadata(path: string, chunkBytes = DEFAULT_TAIL_BYTES): Promise<CodexTurnMetadata | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const chunkSize = Math.max(1, chunkBytes);
    let end = metadata.size;
    let suffix: string | null = "";
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (suffix === null) {
        const boundary = text.lastIndexOf("\n");
        if (boundary < 0) {
          end = start;
          continue;
        }
        text = text.slice(0, boundary + 1);
        suffix = "";
      }

      const lines: string[] = `${text}${suffix}`.split("\n");
      const leadingPartial: string = start > 0 ? lines.shift() ?? "" : "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const rawLine = lines[index]?.trim();
        if (!rawLine) continue;
        let value: unknown;
        try {
          value = JSON.parse(rawLine);
        } catch {
          continue;
        }
        const result = turnMetadataFromValue(value);
        if (result !== null) return result;
      }
      suffix = leadingPartial.length <= MAX_ROLLOUT_LINE_BYTES ? leadingPartial : null;
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readLatestRolloutContext(path: string, chunkBytes = DEFAULT_TAIL_BYTES): Promise<CodexContextObservation | null> {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const chunkSize = Math.max(1, chunkBytes);
    let end = metadata.size;
    let suffix: string | null = "";
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (suffix === null) {
        const boundary = text.lastIndexOf("\n");
        if (boundary < 0) {
          end = start;
          continue;
        }
        text = text.slice(0, boundary + 1);
        suffix = "";
      }
      const lines: string[] = `${text}${suffix}`.split("\n");
      const leadingPartial = start > 0 ? lines.shift() ?? "" : "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const rawLine = lines[index]?.trim();
        if (!rawLine) continue;
        try {
          const result = contextFromValue(JSON.parse(rawLine));
          if (result !== null) return result;
        } catch {
          // Malformed and incomplete rollout records are ignored.
        }
      }
      suffix = leadingPartial.length <= MAX_ROLLOUT_LINE_BYTES ? leadingPartial : null;
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readLatestRolloutMarker(path: string, tailBytes = DEFAULT_TAIL_BYTES): Promise<RolloutMarker> {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return "unknown";
    const length = Math.min(metadata.size, Math.max(1, tailBytes));
    const start = metadata.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) return "unknown";
      text = text.slice(firstNewline + 1);
    }
    const marker = markerFromJsonLines(text);
    return marker === "unknown" && start > 0 ? "truncated" : marker;
  } catch {
    return "unknown";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function markerFromJsonLines(text: string): RolloutMarker {
  let latest: RolloutMarker = "unknown";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const outer = value.type;
    const inner = isRecord(value.payload) ? value.payload.type : undefined;
    const marker = controlMarker(outer) ?? controlMarker(inner);
    if (marker !== null) latest = marker;
  }
  return latest;
}

function controlMarker(value: unknown): RolloutMarker | null {
  if (value === "task_started" || value === "turn_started" || value === "turn_context") return "started";
  if (value === "task_complete" || value === "turn_complete" || value === "turn_aborted") return "terminal";
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
