import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { connect, type Socket } from "node:net";

import {
  ProviderAdapterError,
  type EnqueueProviderMessageRequest,
  type ProviderQueuedMessageAttachment,
  type ProviderQueuedMessage,
  type RestoreProviderMessageRequest,
  type SendMessageRequest,
  type SendMessageResult,
} from "../../provider_contract/src/index.js";
import { codexTurnInput } from "./codex_input.js";

interface DesktopQueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly context: Record<string, unknown>;
  readonly cwd: string;
  readonly createdAt: number;
  readonly mentionedBrowserFamilies?: readonly string[];
  readonly pausedReason?: string | null;
}

type DesktopQueueState = Record<string, readonly DesktopQueuedMessage[]>;

interface IpcResponse {
  readonly type: "response";
  readonly requestId: string;
  readonly resultType: "success" | "error";
  readonly method?: string;
  readonly handledByClientId?: string;
  readonly result?: unknown;
  readonly error?: string;
}

type DesktopQueueWatchFactory = (
  directory: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;

export interface CodexDesktopQueueOptions {
  readonly statePath?: string;
  readonly pipePath?: string;
  readonly ownerRecoveryWindowMs?: number;
  readonly ownerRetryDelayMs?: number;
  readonly requestTimeoutMs?: number;
  readonly watchFactory?: DesktopQueueWatchFactory;
  readonly onChanged: (messages: readonly ProviderQueuedMessage[]) => void | Promise<void>;
}

export type CodexDesktopTurnStartAttempt =
  | { readonly outcome: "accepted"; readonly result: SendMessageResult }
  | {
      readonly outcome: "not_delivered";
      readonly reason: "desktop_unavailable" | "owner_missing" | "owner_discovery_failed" | "no_client_found";
    }
  | { readonly outcome: "delivery_unknown"; readonly error: ProviderAdapterError };

const queueKey = "queued-follow-ups";
// A typical dark 1400x900 PNG is around 160 KiB on disk but just over 200 KiB
// once Base64-encoded. Keep ordinary Codex Desktop screenshots previewable
// without allowing multi-megabyte queue events into the renderer.
const maximumQueuedPreviewCharacters = 256 * 1024;
const maximumQueuedPreviewCharactersPerMessage = 640 * 1024;
const defaultOwnerRecoveryWindowMs = 3_000;
const defaultOwnerRetryDelayMs = 75;
const maximumOwnerRetryDelayMs = 400;
const defaultRequestTimeoutMs = 5_000;
// Codex Desktop's queued-steer handler can wait 30 seconds for the active turn
// id to become available. Keep this IPC alive beyond that native budget so a
// late success cannot race Tethoq's queue restoration.
const minimumQueuedSteerRequestTimeoutMs = 40_000;
// An explicit NoActiveTurn response proves that Desktop did not accept the
// steer, so one fresh owner-discovery attempt is safe. Keep this bounded: each
// Desktop steer may itself wait up to 30 seconds for the active turn id.
const maximumQueuedSteerAttempts = 2;
const initialWatcherRetryDelayMs = 100;
const maximumWatcherRetryDelayMs = 5_000;
// Codex Desktop rejects a request with `no-client-found` when its protocol
// revision does not match, even when the target owner is otherwise reachable.
const ipcVersions: Readonly<Record<string, number>> = {
  "thread-owner-discovery": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-steer-turn": 1,
};

export class CodexDesktopQueue {
  readonly #statePath: string;
  readonly #pipePath: string;
  readonly #onChanged: CodexDesktopQueueOptions["onChanged"];
  public readonly ownerRecoveryWindowMs: number;
  public readonly ownerRetryDelayMs: number;
  readonly #requestTimeoutMs: number;
  readonly #watchFactory: DesktopQueueWatchFactory;
  #watcher: FSWatcher | null = null;
  #refreshTimer: NodeJS.Timeout | null = null;
  #watcherRetryTimer: NodeJS.Timeout | null = null;
  #nextWatcherRetryDelayMs = initialWatcherRetryDelayMs;
  #messages: readonly ProviderQueuedMessage[] = [];
  #mutationTail: Promise<void> = Promise.resolve();
  #disposed = false;

  public constructor(options: CodexDesktopQueueOptions) {
    const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
    this.#statePath = options.statePath ?? join(codexHome, ".codex-global-state.json");
    this.#pipePath = options.pipePath ?? "\\\\.\\pipe\\codex-ipc";
    this.#onChanged = options.onChanged;
    this.ownerRecoveryWindowMs = Math.max(0, options.ownerRecoveryWindowMs ?? defaultOwnerRecoveryWindowMs);
    this.ownerRetryDelayMs = Math.max(1, options.ownerRetryDelayMs ?? defaultOwnerRetryDelayMs);
    this.#requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? defaultRequestTimeoutMs);
    this.#watchFactory = options.watchFactory ?? ((directory, listener) => watch(directory, listener));
  }

  public async start(): Promise<void> {
    if (this.#disposed) return;
    await this.refresh();
    if (this.#disposed) return;
    this.armWatcher();
  }

  private armWatcher(): void {
    if (this.#disposed || this.#watcher !== null || this.#watcherRetryTimer !== null) return;
    let watcher: FSWatcher;
    try {
      watcher = this.#watchFactory(dirname(this.#statePath), (_event, filename) => {
        if (this.#watcher !== watcher || this.#disposed) return;
        this.#nextWatcherRetryDelayMs = initialWatcherRetryDelayMs;
        if (filename?.toString() !== undefined && filename.toString() !== this.#statePath.split(/[\\/]/).at(-1)) return;
        if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
        this.#refreshTimer = setTimeout(() => {
          this.#refreshTimer = null;
          void this.refresh().catch(() => undefined);
        }, 50);
      });
    } catch {
      // Codex Desktop may not have created its state directory yet.
      this.scheduleWatcherRetry();
      return;
    }
    this.#watcher = watcher;
    watcher.on("error", () => this.handleWatcherError(watcher));
  }

  private handleWatcherError(watcher: FSWatcher): void {
    if (this.#watcher !== watcher) return;
    this.#watcher = null;
    try {
      watcher.close();
    } catch {
      // A failed watcher can already be closed by Node when it reports error.
    }
    this.scheduleWatcherRetry();
  }

  private scheduleWatcherRetry(): void {
    if (this.#disposed || this.#watcher !== null || this.#watcherRetryTimer !== null) return;
    const retryDelayMs = this.#nextWatcherRetryDelayMs;
    this.#nextWatcherRetryDelayMs = Math.min(
      maximumWatcherRetryDelayMs,
      Math.ceil(this.#nextWatcherRetryDelayMs * 2),
    );
    this.#watcherRetryTimer = setTimeout(() => {
      this.#watcherRetryTimer = null;
      this.armWatcher();
      if (this.#watcher !== null) void this.refresh().catch(() => undefined);
    }, retryDelayMs);
    this.#watcherRetryTimer.unref();
  }

  public list(): readonly ProviderQueuedMessage[] {
    return this.#messages;
  }

  public async enqueue(providerSessionId: string, request: EnqueueProviderMessageRequest): Promise<ProviderQueuedMessage> {
    assertNativeQueueAttachments(request.attachments);
    return await this.withMutation(async () => {
      const state = await this.readState();
      const id = nativeQueueMessageId(providerSessionId, request.requestId);
      const requestHash = nativeQueueRequestHash(request);
      const existing = (state[providerSessionId] ?? []).find((message) => message.id === id);
      if (existing !== undefined) {
        if (existing.context.tethoqRequestHash !== requestHash) {
          throw new Error("That Codex queue request ID is already in use for different content");
        }
        return normalizeQueuedMessage(providerSessionId, existing);
      }
      const desktopMessage: DesktopQueuedMessage = {
        id,
        text: request.content,
        context: nativeComposerContext(request, id, requestHash),
        cwd: request.workingDirectory,
        createdAt: Date.now(),
        mentionedBrowserFamilies: [],
        pausedReason: null,
      };
      await this.replaceConversationQueue(providerSessionId, state, [...(state[providerSessionId] ?? []), desktopMessage]);
      return normalizeQueuedMessage(providerSessionId, desktopMessage);
    });
  }

  /** Starts a real turn inside the Codex Desktop process that owns this task. */
  public async startTurn(
    providerSessionId: string,
    request: SendMessageRequest,
    dynamicTools?: readonly Record<string, unknown>[],
  ): Promise<SendMessageResult> {
    const deadline = Date.now() + this.ownerRecoveryWindowMs;
    let delayMs = this.ownerRetryDelayMs;
    while (true) {
      const attempt = await this.tryStartTurn(providerSessionId, request, dynamicTools);
      if (attempt.outcome === "accepted") return attempt.result;
      if (attempt.outcome === "delivery_unknown") throw attempt.error;
      if (Date.now() >= deadline) break;
      await delay(Math.min(delayMs, Math.max(1, deadline - Date.now())));
      delayMs = Math.min(maximumOwnerRetryDelayMs, Math.ceil(delayMs * 1.5));
    }
    throw new Error("Codex has another writer for this task, but it did not become reachable during safe delivery. Your draft is unchanged.");
  }

  /** Distinguishes definite non-delivery from a response that may have started the turn. */
  public async tryStartTurn(
    providerSessionId: string,
    request: SendMessageRequest,
    dynamicTools?: readonly Record<string, unknown>[],
  ): Promise<CodexDesktopTurnStartAttempt> {
    let client: CodexIpcClient;
    try {
      client = await CodexIpcClient.connect(this.#pipePath, this.#requestTimeoutMs);
    } catch {
      // Desktop is an optional peer. When it is closed (or its coordination
      // channel is still starting), the ordinary Codex App Server route owns
      // tasks that are not positively marked as externally written.
      return { outcome: "not_delivered", reason: "desktop_unavailable" };
    }
    try {
      const params = {
        conversationId: providerSessionId,
        turnStart: {
          request: {
            threadId: providerSessionId,
            clientUserMessageId: request.requestId,
            input: codexTurnInput(request),
            ...(request.modelId !== undefined ? { model: request.modelId } : {}),
            ...(request.reasoningEffort !== undefined ? { effort: request.reasoningEffort } : {}),
            ...(dynamicTools !== undefined ? { dynamicTools } : {}),
          },
        },
      };
      let owner: IpcResponse;
      try {
        owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: providerSessionId });
      } catch {
        // No turn-start request was written, so switching routes remains safe.
        return { outcome: "not_delivered", reason: "owner_discovery_failed" };
      }
      if (owner.resultType !== "success" || owner.handledByClientId === undefined) {
        return { outcome: "not_delivered", reason: "owner_missing" };
      }
      let response: IpcResponse;
      try {
        response = await client.request(
          "thread-follower-start-turn",
          params,
          owner.handledByClientId,
        );
      } catch (error) {
        // The request reached the point where the target might have accepted it.
        // Never cross-fallback or retry this ambiguous result.
        return { outcome: "delivery_unknown", error: desktopTurnDeliveryUnknown(error) };
      }
      if (response.resultType !== "success") {
        if (isNoClientFound(response)) return { outcome: "not_delivered", reason: "no_client_found" };
        return {
          outcome: "delivery_unknown",
          error: desktopTurnDeliveryUnknown(new Error(response.error ?? "Codex Desktop did not confirm delivery")),
        };
      }
      const forwarded = isRecord(response.result) && isRecord(response.result.result) ? response.result.result : undefined;
      const turn = forwarded !== undefined && isRecord(forwarded.turn) ? forwarded.turn : undefined;
      const turnId = turn !== undefined && typeof turn.id === "string" ? turn.id : undefined;
      if (turnId === undefined || !turnId.trim()) {
        return { outcome: "delivery_unknown", error: desktopTurnDeliveryUnknown(new Error("Codex Desktop did not confirm that the turn started")) };
      }
      return { outcome: "accepted", result: { accepted: true, providerTurnId: turnId, details: [] } };
    } finally {
      client.dispose();
    }
  }

  /**
   * Moves one native queued follow-up into the turn owned by Codex Desktop.
   * The full original composer record is supplied as `restoreMessage`, so Codex
   * can put back images/files/context if the active turn ends during the steer.
   */
  public async steerQueuedMessage(providerSessionId: string, messageId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return await this.withMutation(async () => {
      let initialState: DesktopQueueState;
      try {
        initialState = await this.readState();
      } catch (error) {
        // Nothing has been sent or removed when the source queue cannot be read.
        throw desktopQueueOwnerUnavailable(error);
      }
      const current = [...(initialState[providerSessionId] ?? [])];
      const index = current.findIndex((message) => message.id === messageId);
      if (index < 0) throw new Error("That queued Codex instruction is no longer available");
      const original = current[index]!;

      const steerParams = {
        conversationId: providerSessionId,
        input: codexTurnInput({ ...request, content: original.text }),
        restoreMessage: original,
        serviceTier: null,
        attachments: [],
        clientUserMessageId: original.id,
      };

      let sawNoActiveTurn = false;
      for (let attempt = 0; attempt < maximumQueuedSteerAttempts; attempt += 1) {
        let retryNoActiveTurn = false;
        let client: CodexIpcClient;
        try {
          client = await CodexIpcClient.connect(
            this.#pipePath,
            Math.max(this.#requestTimeoutMs, minimumQueuedSteerRequestTimeoutMs),
          );
        } catch (error) {
          // No steer frame was written. If a previous owner already proved the
          // old turn ended, preserve that stronger result so the Bridge can
          // reconcile the task to idle; otherwise keep the native row retryable.
          throw sawNoActiveTurn ? desktopNoActiveTurn(error) : desktopQueueOwnerUnavailable(error);
        }
        try {
          let owner: IpcResponse;
          try {
            owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: providerSessionId });
          } catch (error) {
            // Owner discovery happens before queue removal and before any steer
            // frame, so this is definite non-delivery rather than ambiguity.
            throw sawNoActiveTurn ? desktopNoActiveTurn(error) : desktopQueueOwnerUnavailable(error);
          }
          if (owner.resultType !== "success" || owner.handledByClientId === undefined) {
            throw sawNoActiveTurn ? desktopNoActiveTurn() : desktopQueueOwnerUnavailable();
          }
          // Re-read immediately before each removal. A NoActiveTurn attempt can
          // spend up to 30 seconds in Desktop; reusing its old global snapshot on
          // the retry would erase queue entries added in Desktop during that wait.
          let attemptState: DesktopQueueState;
          try {
            attemptState = await this.readState();
          } catch (error) {
            throw sawNoActiveTurn ? desktopNoActiveTurn(error) : desktopQueueOwnerUnavailable(error);
          }
          const attemptQueue = [...(attemptState[providerSessionId] ?? [])];
          const attemptIndex = attemptQueue.findIndex((message) => message.id === original.id);
          if (attemptIndex < 0) throw desktopQueueMessageUnavailable();
          const next = [...attemptQueue.slice(0, attemptIndex), ...attemptQueue.slice(attemptIndex + 1)];
          await this.replaceConversationQueueWithClient(client, owner.handledByClientId, providerSessionId, attemptState, next);
          let response: IpcResponse;
          try {
            response = await client.request(
              "thread-follower-steer-turn",
              steerParams,
              owner.handledByClientId,
            );
          } catch (error) {
            // The steer request was handed to the Desktop coordination channel,
            // so a timeout or broken pipe cannot prove non-delivery. Restoring the
            // row here would let the same instruction be steered twice after a
            // lost acknowledgement. Leave the consumed native state untouched and
            // force callers to reconcile history before offering another attempt.
            throw desktopSteerDeliveryUnknown(error);
          }
          if (response.resultType !== "success") {
            if (isNoActiveTurn(response)) {
              // Desktop's explicit NoActiveTurn response proves that the steer
              // did not start. Restore the exact native row before either making
              // one fresh owner-discovery attempt or returning it for later.
              sawNoActiveTurn = true;
              const latestState = await this.readState();
              const restored = restoreRemovedQueueMessage(latestState[providerSessionId] ?? [], current, original);
              await this.replaceConversationQueueWithClient(client, owner.handledByClientId, providerSessionId, latestState, restored);
              if (attempt + 1 >= maximumQueuedSteerAttempts) throw desktopNoActiveTurn();
              retryNoActiveTurn = true;
            } else {
              // An unclassified owner error can occur after forwarding. Without a
              // typed non-delivery guarantee, restoring would expose an at-most-once
              // instruction for a second steer after Desktop may have accepted it.
              throw desktopSteerDeliveryUnknown(new Error(response.error ?? "Codex Desktop did not confirm the queued steer"));
            }
          } else {
            const forwarded = isRecord(response.result) && isRecord(response.result.result) ? response.result.result : undefined;
            const turnId = forwarded !== undefined && typeof forwarded.turnId === "string" ? forwarded.turnId : undefined;
            return { accepted: true, ...(turnId !== undefined ? { providerTurnId: turnId } : {}), details: [] };
          }
        } finally {
          client.dispose();
        }
        if (retryNoActiveTurn) await delay(this.ownerRetryDelayMs);
      }
      throw desktopNoActiveTurn();
    });
  }

  public async restore(providerSessionId: string, request: RestoreProviderMessageRequest): Promise<ProviderQueuedMessage> {
    assertNativeQueueAttachments(request.attachments);
    return await this.withMutation(async () => {
      if (request.originalMessage.providerSessionId !== providerSessionId) {
        throw new Error("The queued instruction belongs to a different Codex task");
      }
      const createdAt = Date.parse(request.originalMessage.createdAt);
      if (!Number.isFinite(createdAt)) throw new Error("The original queued instruction time is invalid");
      const state = await this.readState();
      const current = [...(state[providerSessionId] ?? [])];
      const existing = current.find((message) => message.id === request.originalMessage.id);
      if (existing !== undefined) {
        if (existing.text !== request.content) throw new Error("The original Codex queue ID is already in use");
        return normalizeQueuedMessage(providerSessionId, existing);
      }
      const desktopMessage: DesktopQueuedMessage = {
        id: request.originalMessage.id,
        text: request.content,
        context: nativeComposerContext(request, request.originalMessage.id, nativeQueueRequestHash(request)),
        cwd: request.workingDirectory,
        createdAt,
        mentionedBrowserFamilies: [],
        pausedReason: null,
      };
      const requestedIndex = request.beforeMessageId === undefined
        ? -1
        : current.findIndex((message) => message.id === request.beforeMessageId);
      const chronologicalIndex = current.findIndex((message) => message.createdAt > createdAt);
      const insertAt = requestedIndex >= 0
        ? requestedIndex
        : chronologicalIndex >= 0 ? chronologicalIndex : current.length;
      current.splice(insertAt, 0, desktopMessage);
      await this.replaceConversationQueue(providerSessionId, state, current);
      return normalizeQueuedMessage(providerSessionId, desktopMessage);
    });
  }

  public async cancel(providerSessionId: string, messageId: string): Promise<boolean> {
    return await this.withMutation(async () => {
      const state = await this.readState();
      const current = state[providerSessionId] ?? [];
      const next = current.filter((message) => message.id !== messageId);
      if (next.length === current.length) return false;
      await this.replaceConversationQueue(providerSessionId, state, next);
      return true;
    });
  }

  public async update(providerSessionId: string, messageId: string, content: string): Promise<ProviderQueuedMessage | null> {
    const trimmed = content.trim();
    if (trimmed.length === 0 || trimmed.length > 100_000) throw new Error("Queued instructions must contain between 1 and 100000 characters");
    return await this.withMutation(async () => {
      const state = await this.readState();
      const current = state[providerSessionId] ?? [];
      const index = current.findIndex((message) => message.id === messageId);
      if (index < 0) return null;
      const existing = current[index]!;
      const updated: DesktopQueuedMessage = {
        ...existing,
        text: trimmed,
        context: { ...existing.context, prompt: trimmed },
      };
      const next = [...current];
      next[index] = updated;
      await this.replaceConversationQueue(providerSessionId, state, next);
      return normalizeQueuedMessage(providerSessionId, updated);
    });
  }

  public dispose(): void {
    this.#disposed = true;
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    if (this.#watcherRetryTimer !== null) clearTimeout(this.#watcherRetryTimer);
    this.#watcherRetryTimer = null;
    try {
      this.#watcher?.close();
    } catch {
      // The watcher may already have been closed while reporting an error.
    }
    this.#watcher = null;
  }

  private async refresh(): Promise<void> {
    let state: DesktopQueueState;
    try {
      state = await this.readState();
    } catch {
      // A replace/write can make the shared state file briefly unreadable.
      // Keep the last confirmed queue until a later refresh succeeds.
      return;
    }
    const next = normalizeQueueState(state);
    if (JSON.stringify(next) === JSON.stringify(this.#messages)) return;
    this.#messages = next;
    await this.#onChanged(next);
  }

  private async readState(): Promise<DesktopQueueState> {
    const source = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
    if (!isRecord(source)) return {};
    return parseQueueState(source[queueKey]);
  }

  private async replaceConversationQueue(
    providerSessionId: string,
    current: DesktopQueueState,
    messages: readonly DesktopQueuedMessage[],
  ): Promise<void> {
    let client: CodexIpcClient;
    try {
      client = await CodexIpcClient.connect(this.#pipePath);
    } catch (error) {
      throw desktopQueueOwnerUnavailable(error);
    }
    try {
      let owner: IpcResponse;
      try {
        owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: providerSessionId });
      } catch (error) {
        throw desktopQueueOwnerUnavailable(error);
      }
      if (owner.resultType !== "success" || owner.handledByClientId === undefined) {
        throw desktopQueueOwnerUnavailable();
      }
      await this.replaceConversationQueueWithClient(client, owner.handledByClientId, providerSessionId, current, messages);
    } finally {
      client.dispose();
    }
  }

  private async replaceConversationQueueWithClient(
    client: CodexIpcClient,
    ownerClientId: string,
    providerSessionId: string,
    current: DesktopQueueState,
    messages: readonly DesktopQueuedMessage[],
  ): Promise<void> {
    const state: DesktopQueueState = { ...current };
    if (messages.length === 0) delete state[providerSessionId];
    else state[providerSessionId] = messages;
    const response = await client.request(
      "thread-follower-set-queued-follow-ups-state",
      { conversationId: providerSessionId, state },
      ownerClientId,
    );
    if (response.resultType !== "success") throw new Error(response.error ?? "Codex Desktop rejected the queue update");
    this.#messages = normalizeQueueState(state);
    await this.#onChanged(this.#messages);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function desktopQueueOwnerUnavailable(cause?: unknown): ProviderAdapterError {
  return new ProviderAdapterError(
    "codex",
    "PROVIDER_QUEUE_OWNER_UNAVAILABLE",
    "Codex Desktop is not currently exposing this task's queue.",
    true,
    cause === undefined ? undefined : { cause },
  );
}

function isNoClientFound(response: IpcResponse): boolean {
  return response.resultType === "error" && response.error?.replace(/[^a-z]/giu, "").toLowerCase() === "noclientfound";
}

function isNoActiveTurn(response: IpcResponse): boolean {
  if (response.resultType !== "error") return false;
  const normalized = response.error?.replace(/[^a-z]/giu, "").toLowerCase();
  return normalized === "noactiveturn" || normalized === "noactivecodexturnisavailabletosteer";
}

function desktopNoActiveTurn(cause?: unknown): ProviderAdapterError {
  return new ProviderAdapterError(
    "codex",
    "NO_ACTIVE_TURN",
    "No active Codex turn is available to steer",
    true,
    cause === undefined ? undefined : { cause },
  );
}

function desktopQueueMessageUnavailable(): ProviderAdapterError {
  return new ProviderAdapterError(
    "codex",
    "QUEUE_MESSAGE_NOT_FOUND",
    "That queued Codex instruction is no longer available",
    true,
  );
}

function desktopSteerDeliveryUnknown(cause: unknown): ProviderAdapterError {
  return new ProviderAdapterError(
    "codex",
    "DELIVERY_UNKNOWN",
    "Codex Desktop may have accepted this steering instruction, but Tethoq did not receive confirmation. Reopen the task and verify its transcript before trying again.",
    false,
    { cause },
  );
}

function desktopTurnDeliveryUnknown(cause: unknown): ProviderAdapterError {
  return new ProviderAdapterError(
    "codex",
    "DELIVERY_UNKNOWN",
    "Codex Desktop may have accepted this instruction, but Tethoq did not receive confirmation. Delivery will be reconciled before another attempt.",
    false,
    { cause },
  );
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(typeof value === "string" && value.trim() ? value : fallback);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Restores only the row removed for steering. The latest Desktop snapshot owns
 * every other row, including entries added while the steer handler was waiting.
 */
function restoreRemovedQueueMessage(
  latest: readonly DesktopQueuedMessage[],
  originalQueue: readonly DesktopQueuedMessage[],
  original: DesktopQueuedMessage,
): readonly DesktopQueuedMessage[] {
  if (latest.some((message) => message.id === original.id)) return latest;

  const restored = [...latest];
  const originalIndex = originalQueue.findIndex((message) => message.id === original.id);
  for (let index = originalIndex + 1; index < originalQueue.length; index += 1) {
    const nextIndex = restored.findIndex((message) => message.id === originalQueue[index]!.id);
    if (nextIndex >= 0) {
      restored.splice(nextIndex, 0, original);
      return restored;
    }
  }
  for (let index = originalIndex - 1; index >= 0; index -= 1) {
    const previousIndex = restored.findIndex((message) => message.id === originalQueue[index]!.id);
    if (previousIndex >= 0) {
      restored.splice(previousIndex + 1, 0, original);
      return restored;
    }
  }

  const chronologicalIndex = restored.findIndex((message) => message.createdAt > original.createdAt);
  restored.splice(chronologicalIndex >= 0 ? chronologicalIndex : restored.length, 0, original);
  return restored;
}

class CodexIpcClient {
  readonly #socket: Socket;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<string, {
    readonly resolve: (response: IpcResponse) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  #clientId = "initializing-client";
  #buffer = Buffer.alloc(0);
  #disposed = false;

  private constructor(socket: Socket, requestTimeoutMs: number) {
    this.#socket = socket;
    this.#requestTimeoutMs = requestTimeoutMs;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error) => this.failPending(asError(error, "Codex Desktop IPC connection failed")));
    socket.on("close", () => this.failPending(new Error("Codex Desktop IPC connection closed before confirming the request")));
  }

  public static async connect(pipePath: string, requestTimeoutMs = defaultRequestTimeoutMs): Promise<CodexIpcClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(pipePath, () => resolve(candidate));
      candidate.once("error", reject);
    });
    const client = new CodexIpcClient(socket, requestTimeoutMs);
    const initialized = await client.request("initialize", { clientType: "tethoq" });
    if (initialized.resultType !== "success" || !isRecord(initialized.result) || typeof initialized.result.clientId !== "string") {
      client.dispose();
      throw new Error("Could not join the Codex Desktop coordination channel");
    }
    client.#clientId = initialized.result.clientId;
    return client;
  }

  public async request(method: string, params: Record<string, unknown>, targetClientId?: string): Promise<IpcResponse> {
    const requestId = randomUUID();
    const response = new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Codex Desktop IPC request timed out: ${method}`));
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
    });
    try {
      this.writeFrame({
        type: "request",
        requestId,
        sourceClientId: this.#clientId,
        version: ipcVersions[method] ?? 0,
        method,
        params,
        ...(targetClientId !== undefined ? { targetClientId } : {}),
      });
    } catch (error) {
      const pending = this.#pending.get(requestId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(requestId);
      }
      throw error;
    }
    return await response;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#socket.destroy();
    this.failPending(new Error("Codex Desktop IPC client was closed before confirming the request"));
  }

  private writeFrame(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.#socket.write(frame);
  }

  private handleData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length === 0 || length > 256 * 1024 * 1024) {
        this.dispose();
        return;
      }
      if (this.#buffer.length < 4 + length) return;
      const source = JSON.parse(this.#buffer.subarray(4, 4 + length).toString("utf8")) as unknown;
      this.#buffer = this.#buffer.subarray(4 + length);
      if (!isRecord(source) || source.type !== "response" || typeof source.requestId !== "string") continue;
      const pending = this.#pending.get(source.requestId);
      if (pending === undefined) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(source.requestId);
      pending.resolve(source as unknown as IpcResponse);
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function nativeComposerContext(
  request: EnqueueProviderMessageRequest,
  nativeMessageId: string,
  requestHash: string,
): Record<string, unknown> {
  const imageAttachments = (request.attachments ?? []).map((attachment, index) => ({
    id: `${nativeMessageId}:image:${index}`,
    filename: attachment.name,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    src: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
  }));
  return {
    addedFiles: [],
    chatGptConversationContexts: [],
    ideContext: null,
    imageAttachments,
    imageCommentDrafts: [],
    prompt: request.content,
    appshotContexts: [],
    fileAttachments: [],
    pastedTextAttachments: [],
    inAppBrowserContext: null,
    commentAttachments: [],
    mcpAppModelContextAttachments: [],
    selectedTextAttachments: [],
    responseTextAnnotations: [],
    pullRequestChecks: [],
    pullRequestMergeConflict: null,
    existingWorkspaceRoot: null,
    localProjectId: null,
    workspaceRoots: [request.workingDirectory],
    threadReferences: [],
    tethoqRequestId: request.requestId,
    tethoqRequestHash: requestHash,
    ...(request.developerInstructions !== undefined ? { tethoqDeveloperInstructions: request.developerInstructions } : {}),
  };
}

function assertNativeQueueAttachments(attachments: SendMessageRequest["attachments"]): void {
  for (const attachment of attachments ?? []) {
    if (!attachment.mimeType.toLowerCase().startsWith("image/")) {
      throw new Error("Codex Desktop's native follow-up queue supports image attachments only");
    }
  }
}

function nativeQueueRequestHash(request: SendMessageRequest & { readonly workingDirectory: string }): string {
  const hash = createHash("sha256");
  const append = (value: string | number | undefined): void => {
    const text = value === undefined ? "" : String(value);
    hash.update(String(Buffer.byteLength(text, "utf8")));
    hash.update(":");
    hash.update(text);
    hash.update(";");
  };
  append(request.content);
  append(request.workingDirectory);
  append(request.developerInstructions);
  append(request.modelId);
  append(request.reasoningEffort);
  append(request.attachments?.length ?? 0);
  for (const attachment of request.attachments ?? []) {
    append(attachment.name);
    append(attachment.mimeType);
    append(attachment.byteLength);
    append(attachment.dataBase64);
  }
  return hash.digest("hex");
}

function nativeQueueMessageId(providerSessionId: string, requestId: string): string {
  const bytes = createHash("sha256")
    .update("tethoq-codex-native-queue-v1\0")
    .update(providerSessionId)
    .update("\0")
    .update(requestId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseQueueState(value: unknown): DesktopQueueState {
  if (!isRecord(value)) return {};
  const result: Record<string, readonly DesktopQueuedMessage[]> = {};
  for (const [providerSessionId, messages] of Object.entries(value)) {
    if (!Array.isArray(messages)) continue;
    const valid = messages.filter(isDesktopQueuedMessage);
    if (valid.length > 0) result[providerSessionId] = valid;
  }
  return result;
}

function normalizeQueueState(state: DesktopQueueState): readonly ProviderQueuedMessage[] {
  return Object.entries(state)
    .flatMap(([providerSessionId, messages]) => messages.map((message) => normalizeQueuedMessage(providerSessionId, message)))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function normalizeQueuedMessage(providerSessionId: string, message: DesktopQueuedMessage): ProviderQueuedMessage {
  const error = typeof message.pausedReason === "string" && message.pausedReason.trim() ? message.pausedReason : undefined;
  const attachments = nativeQueuedAttachments(message.context);
  return {
    id: message.id,
    providerSessionId,
    content: message.text,
    state: error === undefined ? "queued" : "failed",
    createdAt: new Date(message.createdAt).toISOString(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof message.context.tethoqDeveloperInstructions === "string" && message.context.tethoqDeveloperInstructions.trim()
      ? { developerInstructions: message.context.tethoqDeveloperInstructions }
      : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function nativeQueuedAttachments(context: Record<string, unknown>): readonly ProviderQueuedMessageAttachment[] {
  const result: ProviderQueuedMessageAttachment[] = [];
  let previewCharacters = 0;
  const seen = new Set<string>();
  const append = (value: unknown, fallbackName: string, fallbackMimeType: string): void => {
    if (!isRecord(value)) return;
    const previewCandidate = firstString(value.previewSrc, value.imageDataUrl, value.uploadSrc, value.src, value.dataUrl);
    const preview = safeQueuedPreview(previewCandidate, previewCharacters);
    if (preview !== undefined) previewCharacters += preview.length;
    const pathCandidate = firstString(value.localPath, value.path, value.imagePath);
    const name = firstString(value.filename, value.fileName, value.name, value.title)
      ?? (pathCandidate === undefined ? undefined : basename(pathCandidate))
      ?? fallbackName;
    const mimeType = firstMimeType(value.mimeType, value.mediaType, value.contentType)
      ?? mimeTypeFromDataUrl(preview)
      ?? mimeTypeFromName(name)
      ?? fallbackMimeType;
    const byteLength = firstNonNegativeNumber(value.byteLength, value.size, value.fileSize)
      ?? decodedDataUrlBytes(preview)
      ?? 0;
    const durationSeconds = firstPositiveNumber(value.durationSeconds, value.duration);
    const key = `${name}\u0000${mimeType}\u0000${byteLength}\u0000${preview ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      name,
      mimeType,
      byteLength,
      ...(preview !== undefined ? { dataUrl: preview } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    });
  };
  const appendArray = (value: unknown, fallbackName: string, fallbackMimeType: string): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) append(item, fallbackName, fallbackMimeType);
  };

  appendArray(context.imageAttachments, "Image", "image/*");
  appendArray(context.appshotContexts, "App screenshot", "image/*");
  appendArray(context.mcpAppModelContextAttachments, "Image", "image/*");
  appendArray(context.fileAttachments, "File", "application/octet-stream");
  appendArray(context.pastedTextAttachments, "Pasted text", "text/plain");
  return result;
}

function safeQueuedPreview(value: string | undefined, usedCharacters: number): string | undefined {
  if (value === undefined || value.length > maximumQueuedPreviewCharacters) return undefined;
  if (usedCharacters + value.length > maximumQueuedPreviewCharactersPerMessage) return undefined;
  return /^data:(?:image|audio)\/[a-z0-9.+-]+;base64,[a-z0-9+/]*={0,2}$/iu.test(value) ? value : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function firstMimeType(...values: readonly unknown[]): string | undefined {
  return firstString(...values)?.match(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu)?.[0]?.toLowerCase();
}

function firstNonNegativeNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  return undefined;
}

function firstPositiveNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

function mimeTypeFromDataUrl(value: string | undefined): string | undefined {
  return value?.match(/^data:([^;,]+);base64,/iu)?.[1]?.toLowerCase();
}

function mimeTypeFromName(name: string): string | undefined {
  switch (extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".txt": return "text/plain";
    case ".md": return "text/markdown";
    case ".pdf": return "application/pdf";
    default: return undefined;
  }
}

function decodedDataUrlBytes(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const encoded = value.slice(value.indexOf(",") + 1);
  if (!encoded) return 0;
  return Math.max(0, Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0));
}

function isDesktopQueuedMessage(value: unknown): value is DesktopQueuedMessage {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof value.cwd === "string" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    isRecord(value.context) &&
    (value.mentionedBrowserFamilies === undefined || (Array.isArray(value.mentionedBrowserFamilies) && value.mentionedBrowserFamilies.every((item) => typeof item === "string")));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
