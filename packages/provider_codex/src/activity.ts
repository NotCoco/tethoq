import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { ContentPart, RemoteMessageOrigin, SessionState } from "../../protocol/src/index.js";
import type { ObservedExternalSessionLaunch } from "../../provider_contract/src/index.js";
import { stripProviderPromptGuidance } from "../../provider_contract/src/index.js";
import { codexUserContentParts, isCodexBootstrapUserText, isCodexRealtimeDelegationText, visibleCodexAssistantText } from "./normalize.js";
import { readExternalSessionLaunchesFromRollout } from "./external_launches.js";

// Codex Desktop owns the live stream for an externally opened task, so its local
// append-only rollout is Tethoq's fastest safe read path. A whole second made a
// completed short answer visibly lag behind the owning app; half a second keeps
// the open transcript responsive without turning the fallback into a busy loop.
export const codexExternalActivityPollMs = 500;
const DEFAULT_TAIL_BYTES = 256 * 1_024;
const MESSAGE_READ_CHUNK_BYTES = 64 * 1_024;
const MAX_MESSAGE_BYTES_PER_POLL = 1 * 1_024 * 1_024;
// User records can embed several screenshots as base64. Keep record assembly
// bounded, but do not silently discard ordinary multi-megabyte prompts.
const MAX_ROLLOUT_LINE_BYTES = 64 * 1_024 * 1_024;
const MAX_HISTORY_AUXILIARY_LINE_BYTES = 1 * 1_024 * 1_024;
// The newest unfinished Codex turn can contain several megabytes of reasoning
// and tool output by itself. An 8 MiB tail then contains no previous turn, so the
// reader's first upward scroll falls straight through to a complete 200+ MiB
// rollout reconstruction. Keep a larger bounded recent window and walk older
// byte windows on demand instead.
const DEFAULT_HISTORY_BYTES = 32 * 1_024 * 1_024;
const DEFAULT_HISTORY_MESSAGES = 400;
const MAX_OBSERVED_TOOL_TEXT = 20_000;
const MAX_TRACKED_TOOL_CALLS = 256;
const USER_ITEM_CORRELATION_MAX_DELAY_MS = 2_000;
const USER_ITEM_CORRELATION_MAX_LINES = 8;
// An older page also reads a bounded portion of its newer neighbour. That lets
// the forward parser see a line which crosses the byte boundary, the canonical
// UserMessage record which follows its response record, and nearby terminal or
// tool replacements. The overlap is parsed but never becomes a new byte cursor.
const HISTORY_PAGE_OVERLAP_LINES = USER_ITEM_CORRELATION_MAX_LINES + 2;
const HISTORY_PAGE_OVERLAP_BYTES = MAX_ROLLOUT_LINE_BYTES
  + (HISTORY_PAGE_OVERLAP_LINES - 1) * MAX_HISTORY_AUXILIARY_LINE_BYTES;
const HISTORY_CONTINUITY_BYTES = 128;
// These caches are deliberately small. A progressive page can contain large
// inline image data, and a complete rollout can be much larger still. Evicting
// an old page only means it is reread when the user opens that old task again;
// it never removes any history from the provider.
const MAX_COMPLETE_HISTORY_CACHES = 1;
const MAX_PROGRESSIVE_HISTORY_CACHES = 2;
const MAX_RETIRED_ROLLOUTS = 2_048;
const WRITER_LOCK_PROBE_CACHE_MS = 750;
const ROLLOUT_CURSOR_PREFIX = "codex-rollout-byte:v2:";
const MAX_ROLLOUT_LINEAGE_SEGMENTS = 32;
const MAX_ROLLOUT_LINEAGE_FILES = 20_000;
const activityProfilePath = process.env.TETHOQ_ACTIVITY_PROFILE_PATH?.trim();

function recordActivityProfile(event: Record<string, unknown>): void {
  if (!activityProfilePath) return;
  const memory = process.memoryUsage();
  void appendFile(activityProfilePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  })}\n`, "utf8").catch(() => undefined);
}

type RolloutMarker = "started" | "terminal" | "truncated" | "unknown";

export interface CodexActivityThread {
  readonly providerSessionId: string;
  readonly path?: string | null;
  readonly nativeState: SessionState;
  /**
   * `notLoaded` is also normalized to unknown, but it is not evidence of live
   * work. Set this false for an unwatched cold catalogue row so listing does
   * not scan that rollout from the end twice merely to rediscover "unknown".
   */
  readonly observeUnknown?: boolean;
}

export interface CodexObservedMessage {
  readonly messageId: string;
  /** Provider turn identity shared by Codex's response and canonical user records. */
  readonly turnId?: string;
  /** True once Codex's canonical UserMessage completion has named this action. */
  readonly canonicalUserMessage?: boolean;
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  readonly partType: "text" | "reasoning" | "compaction" | "activity";
  readonly parts?: readonly ContentPart[];
  readonly phase?: "commentary" | "final_answer";
  readonly createdAt?: string;
  readonly origin?: RemoteMessageOrigin;
  readonly terminalError?: boolean;
  readonly terminalFallback?: boolean;
}

export interface CodexRecentMessageWindow {
  readonly messages: readonly CodexObservedMessage[];
  /** True only when the bounded tail covers the complete rollout transcript. */
  readonly complete: boolean;
  /** Opaque boundary for the next bounded read toward byte zero. */
  readonly olderCursor?: string;
}

interface PendingProgressiveHistoryLoad {
  readonly path: string;
  readonly promise: Promise<CodexRecentMessageWindow | undefined>;
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
  /** Durable evidence that a stale writer file no longer represents live work. */
  readonly retirementStatePath?: string;
  readonly pollIntervalMs?: number;
  readonly tailBytes?: number;
  /** Byte size of the recent and each progressively older transcript window. */
  readonly historyBytes?: number;
  readonly isLockHeld?: (lockPath: string) => Promise<boolean>;
  readonly onStateChanged: (providerSessionId: string, state: SessionState) => void | Promise<void>;
  readonly onMessage?: (providerSessionId: string, message: CodexObservedMessage) => void | Promise<void>;
  readonly onTurnMetadataChanged?: (providerSessionId: string, metadata: CodexTurnMetadata) => void | Promise<void>;
  readonly onContextChanged?: (providerSessionId: string, context: CodexContextObservation) => void | Promise<void>;
  /**
   * Called only for writer IDs that appear after the provider's first
   * catalogue-owned lock snapshot. The adapter hydrates that one thread with a
   * metadata-only read before publishing any working state.
   */
  readonly onActiveThreadDiscovered?: (providerSessionId: string) => void | Promise<void>;
}

interface TrackedThread {
  path: string;
  fingerprint: string | undefined;
  rolloutSize: number | undefined;
  marker: RolloutMarker;
  state: SessionState;
  messageOffset: number;
  partialLineChunks: Buffer[];
  partialLineBytes: number;
  droppingOversizedLine: boolean;
  toolCalls: Map<string, ObservedToolCall>;
  pendingFinalAnswer?: CodexObservedMessage;
}

interface ObservedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input?: string;
  readonly createdAt?: string;
}

interface TrackedTurnMetadata {
  path: string;
  offset: number;
  partialLineChunks: Buffer[];
  partialLineBytes: number;
  droppingOversizedLine: boolean;
  toolCalls: Map<string, ObservedToolCall>;
  pendingFinalAnswer?: CodexObservedMessage;
}

interface RolloutObservation {
  readonly message?: CodexObservedMessage;
  readonly metadata?: CodexTurnMetadata;
  readonly context?: CodexContextObservation;
}

interface IncrementalRolloutState {
  partialLineChunks: Buffer[];
  partialLineBytes: number;
  droppingOversizedLine: boolean;
  toolCalls: Map<string, ObservedToolCall>;
  pendingFinalAnswer?: CodexObservedMessage;
}

interface PendingCanonicalUserMessage {
  readonly index: number;
  readonly turnId: string;
  readonly ordinal: number;
  readonly createdAtMs: number;
}

interface CanonicalUserCompletion {
  readonly text: string;
  readonly messageId: string;
  readonly turnId?: string;
  readonly ordinal: number;
  readonly createdAtMs: number;
}

interface CompleteRolloutParserState {
  messages: CodexObservedMessage[];
  messageIndexes: Map<string, number>;
  pendingCanonicalUsers: Map<string, PendingCanonicalUserMessage[]>;
  toolCalls: Map<string, ObservedToolCall>;
  pendingFinalAnswer?: CodexObservedMessage;
  currentTurnHasFinalAnswer: boolean;
  fallbackOrdinal: number;
  partialLineChunks: Buffer[];
  partialLineBytes: number;
  droppingOversizedLine: boolean;
}

interface RolloutFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeMs: string;
}

interface RolloutHistoryBase {
  readonly threadId: string;
  readonly endOrdinalExclusive: number;
  readonly endByteOffset: number;
}

interface RolloutHistorySegment {
  readonly path: string;
  readonly identity: RolloutFileIdentity;
  /** Exclusive logical boundary; a physical predecessor may contain newer rows. */
  readonly endOffset: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
}

interface RolloutHistoryLineage {
  /** Oldest validated physical segment first, current continuation last. */
  readonly segments: readonly RolloutHistorySegment[];
  /** False when a declared ancestor was missing, malformed, ambiguous, or cyclic. */
  readonly complete: boolean;
  /** Stable while the physical chain and every ancestor cutoff stay unchanged. */
  readonly key: string;
}

interface CompleteRolloutCacheEntry {
  readonly path: string;
  readonly identity: RolloutFileIdentity;
  readonly lineageKey: string;
  readonly offset: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
  readonly headProbe: Buffer;
  readonly tailProbe: Buffer;
  readonly state: CompleteRolloutParserState;
  readonly messages: readonly CodexObservedMessage[];
}

interface PendingCompleteHistoryLoad {
  readonly path: string;
  readonly promise: Promise<readonly CodexObservedMessage[]>;
}

interface PendingActiveThreadDiscovery {
  readonly generation: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

interface ProgressiveRolloutHistory {
  readonly path: string;
  readonly segments: readonly RolloutHistorySegment[];
  readonly lineageComplete: boolean;
  readonly endOffset: number;
  /** Oldest boundary reached while finding the cached recent visible rows. */
  readonly recentSegmentIndex: number;
  readonly recentStartOffset: number;
  /** Cursor boundary reached by older-page requests in the current walk. */
  readonly startSegmentIndex: number;
  readonly startOffset: number;
  /** Cached recent page only; older pages are returned as deltas, not retained. */
  readonly messages: readonly CodexObservedMessage[];
}

interface RolloutMessagePage {
  readonly identity: RolloutFileIdentity;
  /** Exclusive original end boundary. Overlap beyond this does not move it. */
  readonly endOffset: number;
  readonly startOffset: number;
  readonly messages: readonly CodexObservedMessage[];
}

interface RetiredRollout {
  readonly path: string;
  readonly fingerprint: string;
  readonly retiredAt: number;
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
  readonly #historyBytes: number;
  readonly #isLockHeld: (lockPath: string) => Promise<boolean>;
  readonly #usesDefaultLockProbe: boolean;
  readonly #onStateChanged: (providerSessionId: string, state: SessionState) => void | Promise<void>;
  readonly #onMessage: (providerSessionId: string, message: CodexObservedMessage) => void | Promise<void>;
  readonly #onTurnMetadataChanged: (providerSessionId: string, metadata: CodexTurnMetadata) => void | Promise<void>;
  readonly #onContextChanged: (providerSessionId: string, context: CodexContextObservation) => void | Promise<void>;
  readonly #onActiveThreadDiscovered: ((providerSessionId: string) => void | Promise<void>) | undefined;
  readonly #retirementStatePath: string | undefined;
  readonly #retirementStateReady: Promise<void>;
  readonly #knownPaths = new Map<string, string>();
  readonly #knownPathHistory = new Map<string, string[]>();
  readonly #trackedTurnMetadata = new Map<string, TrackedTurnMetadata>();
  readonly #turnMetadata = new Map<string, CodexTurnMetadata>();
  readonly #context = new Map<string, CodexContextObservation>();
  readonly #recentMessages = new Map<string, readonly CodexObservedMessage[]>();
  readonly #progressiveHistory = new Map<string, ProgressiveRolloutHistory>();
  readonly #completeHistory = new Map<string, CompleteRolloutCacheEntry>();
  readonly #completeHistoryLoads = new Map<string, PendingCompleteHistoryLoad>();
  /** Shares one bounded read when refresh/open notifications arrive together. */
  readonly #progressiveHistoryLoads = new Map<string, PendingProgressiveHistoryLoad>();
  readonly #tracked = new Map<string, TrackedThread>();
  /**
   * A vanished writer lock is authoritative evidence that the observed turn
   * ended. Keep that evidence even if a later catalogue refresh temporarily
   * stops tracking the rollout, so the same stale lock file cannot resurrect
   * work until the rollout itself changes.
   */
  readonly #retiredRollouts = new Map<string, RetiredRollout>();
  readonly #watchedSessionIds = new Set<string>();
  readonly #activeThreadGenerations = new Map<string, number>();
  readonly #pendingActiveThreadDiscoveries = new Map<string, PendingActiveThreadDiscovery>();
  readonly #writerLockCache = new Map<string, { readonly held: boolean; readonly checkedAt: number }>();
  #activeThreadSnapshot: Set<string> | undefined;
  #activeThreadDiscoveryEnabled = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #retirementWriteTail: Promise<void> = Promise.resolve();
  #polling = false;
  #disposed = false;

  public constructor(options: CodexActivityReconcilerOptions) {
    this.#codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.#pollIntervalMs = options.pollIntervalMs ?? codexExternalActivityPollMs;
    this.#tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
    this.#historyBytes = Math.max(1, options.historyBytes ?? DEFAULT_HISTORY_BYTES);
    this.#usesDefaultLockProbe = options.isLockHeld === undefined;
    this.#isLockHeld = options.isLockHeld ?? lockFileHeld;
    this.#onStateChanged = options.onStateChanged;
    this.#onMessage = options.onMessage ?? (() => undefined);
    this.#onTurnMetadataChanged = options.onTurnMetadataChanged ?? (() => undefined);
    this.#onContextChanged = options.onContextChanged ?? (() => undefined);
    this.#onActiveThreadDiscovered = options.onActiveThreadDiscovered;
    this.#retirementStatePath = options.retirementStatePath;
    this.#retirementStateReady = this.loadRetiredRollouts();
  }

  public async reconcile(threads: readonly CodexActivityThread[]): Promise<ReadonlyMap<string, SessionState>> {
    await this.#retirementStateReady;
    const result = new Map<string, SessionState>();
    for (const thread of threads) {
      const watched = this.#watchedSessionIds.has(thread.providerSessionId);
      const observeUnknown = thread.observeUnknown !== false || watched;
      if (validRolloutPath(thread.path)) {
        if (this.#knownPaths.get(thread.providerSessionId) !== thread.path) {
          this.#completeHistory.delete(thread.providerSessionId);
          this.#progressiveHistory.delete(thread.providerSessionId);
          this.#recentMessages.delete(thread.providerSessionId);
          const retired = this.#retiredRollouts.get(thread.providerSessionId);
          if (retired !== undefined && retired.path !== thread.path) {
            await this.forgetRetiredRollout(thread.providerSessionId);
          }
        }
        this.#knownPaths.set(thread.providerSessionId, thread.path);
        const paths = this.#knownPathHistory.get(thread.providerSessionId) ?? [];
        const next = [...paths.filter((path) => path !== thread.path), thread.path].slice(-8);
        this.#knownPathHistory.set(thread.providerSessionId, next);
      }
      const path = validRolloutPath(thread.path) ? thread.path : this.#knownPaths.get(thread.providerSessionId);
      if (path !== undefined) {
        if ((thread.nativeState === "unknown" && observeUnknown) || watched) {
          await this.trackTurnMetadata(thread.providerSessionId, path);
        } else {
          // A catalogue refresh can contain hundreds of idle tasks. Reading each
          // rollout twice here (latest turn metadata plus context) made the task
          // list wait on every historical file before it could paint. The Codex
          // thread listing already supplies the idle task's display fields; read
          // rollout metadata only for a genuinely active task or when the reader
          // opens it via watchSession().
          this.#trackedTurnMetadata.delete(thread.providerSessionId);
        }
      }
      if (thread.nativeState !== "unknown") {
        const tracked = this.#tracked.get(thread.providerSessionId);
        if (thread.nativeState === "working" || thread.nativeState === "needs_approval" || thread.nativeState === "needs_input") {
          await this.forgetRetiredRollout(thread.providerSessionId);
        } else if (tracked?.fingerprint !== undefined) {
          await this.rememberRetiredRollout(thread.providerSessionId, tracked.path, tracked.fingerprint);
        }
        this.#tracked.delete(thread.providerSessionId);
        result.set(thread.providerSessionId, thread.nativeState);
        continue;
      }

      if (!observeUnknown) {
        this.#tracked.delete(thread.providerSessionId);
        result.set(thread.providerSessionId, "unknown");
        continue;
      }

      if (path === undefined) {
        this.#tracked.delete(thread.providerSessionId);
        result.set(thread.providerSessionId, "unknown");
        continue;
      }

      let tracked = this.#tracked.get(thread.providerSessionId);
      if (tracked === undefined || tracked.path !== path) {
        const initialSize = await rolloutSize(path) ?? 0;
        tracked = {
          path,
          fingerprint: undefined,
          rolloutSize: initialSize,
          marker: "unknown",
          state: "unknown",
          messageOffset: initialSize,
          partialLineChunks: [],
          partialLineBytes: 0,
          droppingOversizedLine: false,
          toolCalls: new Map(),
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

  /** True only while the rollout observer can still prove external activity. */
  public hasActiveTurn(providerSessionId: string): boolean {
    return this.#tracked.get(providerSessionId)?.state === "working";
  }

  /** Keeps sub-second rollout polling scoped to the task the reader opened. */
  public async watchSession(providerSessionId: string): Promise<void> {
    this.#watchedSessionIds.add(providerSessionId);
    const path = this.#knownPaths.get(providerSessionId);
    if (path !== undefined) await this.trackTurnMetadata(providerSessionId, path);
    this.updateTimer();
    await this.pollNow(providerSessionId);
  }

  public unwatchSession(providerSessionId: string): void {
    this.#watchedSessionIds.delete(providerSessionId);
    if (!this.#tracked.has(providerSessionId)) this.#trackedTurnMetadata.delete(providerSessionId);
    this.updateTimer();
  }

  public async hasWriterLock(providerSessionId: string): Promise<boolean> {
    if (!safeThreadId(providerSessionId)) return false;
    const lockPath = join(this.#codexHome, "thread-writer-locks", `${providerSessionId}.lock`);
    const cached = this.#writerLockCache.get(lockPath);
    if (this.#usesDefaultLockProbe && cached !== undefined && Date.now() - cached.checkedAt < WRITER_LOCK_PROBE_CACHE_MS) {
      return cached.held;
    }
    try {
      const held = await this.#isLockHeld(lockPath);
      if (this.#usesDefaultLockProbe) this.#writerLockCache.set(lockPath, { held, checkedAt: Date.now() });
      return held;
    } catch {
      return false;
    }
  }

  public async activeThreadIds(): Promise<readonly string[]> {
    this.#activeThreadDiscoveryEnabled = true;
    const observed = await this.readActiveThreadIds();
    if (observed !== undefined) this.rememberActiveThreadSnapshot(observed, false);
    this.updateTimer();
    return [...(observed ?? this.#activeThreadSnapshot ?? [])];
  }

  public async recentMessages(providerSessionId: string): Promise<readonly CodexObservedMessage[]> {
    const cached = this.#recentMessages.get(providerSessionId);
    if (cached !== undefined) return cached;
    const window = await this.recentMessageWindow(providerSessionId);
    if (window === undefined) return [];
    const messages = window.messages.slice(-DEFAULT_HISTORY_MESSAGES);
    this.#recentMessages.set(providerSessionId, messages);
    return messages;
  }

  public async recentMessageWindow(providerSessionId: string): Promise<CodexRecentMessageWindow | undefined> {
    const path = this.#knownPaths.get(providerSessionId);
    if (path === undefined) return undefined;
    const cached = this.#progressiveHistory.get(providerSessionId);
    if (cached !== undefined && cached.path === path) {
      const currentSize = await rolloutSize(path);
      if (currentSize === null || currentSize === cached.endOffset) {
        const recent = cached.startSegmentIndex === cached.recentSegmentIndex
          && cached.startOffset === cached.recentStartOffset
          ? cached
          : {
              ...cached,
              startSegmentIndex: cached.recentSegmentIndex,
              startOffset: cached.recentStartOffset,
            };
        this.rememberProgressiveHistory(providerSessionId, recent);
        return progressiveMessageWindow(recent);
      }
      // A watcher can establish its incremental baseline after Codex appends a
      // user row. If an earlier page remains cached, later live output cannot
      // backfill that skipped interval. Re-read only the bounded recent window
      // whenever the rollout has advanced since that page was materialized.
      this.#progressiveHistory.delete(providerSessionId);
    }
    const pending = this.#progressiveHistoryLoads.get(providerSessionId);
    if (pending?.path === path) return await pending.promise;
    const promise = this.loadRecentMessageWindow(providerSessionId, path);
    const record: PendingProgressiveHistoryLoad = { path, promise };
    this.#progressiveHistoryLoads.set(providerSessionId, record);
    try {
      return await promise;
    } finally {
      if (this.#progressiveHistoryLoads.get(providerSessionId) === record) {
        this.#progressiveHistoryLoads.delete(providerSessionId);
      }
    }
  }

  private async loadRecentMessageWindow(
    providerSessionId: string,
    path: string,
  ): Promise<CodexRecentMessageWindow | undefined> {
    const lineage = await resolveRolloutHistoryLineage(path);
    if (lineage === null || lineage.segments.length === 0
      || this.#disposed || this.#knownPaths.get(providerSessionId) !== path) return undefined;
    let segmentIndex = lineage.segments.length - 1;
    let boundary = lineage.segments[segmentIndex]!.endOffset;
    let remainingBytes = this.#historyBytes;
    let startOffset = boundary;
    let messages: readonly CodexObservedMessage[] = [];
    // Treat the physical chain as one logical file: if the current continuation
    // is smaller than the recent byte budget, spend the remainder in its
    // validated predecessor instead of hiding all pre-continuation messages.
    while (remainingBytes > 0) {
      const segment = lineage.segments[segmentIndex]!;
      const page = await readRolloutMessagePage(segment.path, boundary, remainingBytes, 0, segment.endOffset);
      if (page === null || !sameRolloutFile(page.identity, segment.identity)
        || page.endOffset !== boundary || this.#disposed || this.#knownPaths.get(providerSessionId) !== path) return undefined;
      messages = mergeProgressiveRolloutMessages(page.messages, messages);
      remainingBytes -= page.endOffset - page.startOffset;
      startOffset = page.startOffset;
      if (page.startOffset > 0 || segmentIndex === 0) break;
      segmentIndex -= 1;
      boundary = lineage.segments[segmentIndex]!.endOffset;
    }
    // A valid tail with no visible rows is still authoritative: it can consist
    // entirely of provider metadata or one incomplete leading record. Walk
    // backward across bounded physical pages until the nearest visible history
    // is found, without ever constructing the complete logical rollout.
    while (messages.length === 0 && (startOffset > 0 || segmentIndex > 0)) {
      if (startOffset === 0) {
        segmentIndex -= 1;
        startOffset = lineage.segments[segmentIndex]!.endOffset;
      }
      const segment = lineage.segments[segmentIndex]!;
      const olderPage = await readRolloutMessagePage(
        segment.path,
        startOffset,
        this.#historyBytes,
        HISTORY_PAGE_OVERLAP_BYTES,
        segment.endOffset,
      );
      if (this.#disposed || this.#knownPaths.get(providerSessionId) !== path) return undefined;
      if (olderPage === null || !sameRolloutFile(olderPage.identity, segment.identity) || olderPage.endOffset !== startOffset) break;
      startOffset = olderPage.startOffset;
      messages = mergeProgressiveRolloutMessages(olderPage.messages, messages);
    }
    const history: ProgressiveRolloutHistory = {
      path,
      segments: lineage.segments,
      lineageComplete: lineage.complete,
      endOffset: lineage.segments.at(-1)!.endOffset,
      recentSegmentIndex: segmentIndex,
      recentStartOffset: startOffset,
      startSegmentIndex: segmentIndex,
      startOffset,
      messages,
    };
    this.rememberProgressiveHistory(providerSessionId, history);
    return progressiveMessageWindow(history);
  }

  public async olderMessageWindow(providerSessionId: string, cursor: string): Promise<CodexRecentMessageWindow | undefined> {
    const path = this.#knownPaths.get(providerSessionId);
    const current = this.#progressiveHistory.get(providerSessionId);
    if (path === undefined || current === undefined || current.path !== path) return undefined;
    const expected = progressiveOlderBoundary(current);
    const boundary = rolloutCursorBoundary(cursor);
    if (expected === null || boundary === null
      || boundary.segmentIdentity !== rolloutFileIdentityKey(current.segments[expected.segmentIndex]!.identity)
      || boundary.segmentIdentity !== expected.segmentIdentity
      || boundary.offset !== expected.offset) return undefined;
    const segment = current.segments[expected.segmentIndex]!;
    const page = await readRolloutMessagePage(
      segment.path,
      boundary.offset,
      this.#historyBytes,
      HISTORY_PAGE_OVERLAP_BYTES,
      segment.endOffset,
    );
    if (page === null || !sameRolloutFile(page.identity, segment.identity) || page.endOffset !== boundary.offset) {
      this.#progressiveHistory.delete(providerSessionId);
      return undefined;
    }
    const expanded: ProgressiveRolloutHistory = {
      ...current,
      startSegmentIndex: expected.segmentIndex,
      startOffset: page.startOffset,
    };
    this.rememberProgressiveHistory(providerSessionId, expanded);
    return rolloutMessagePageWindow(page, expanded);
  }

  public async allMessages(providerSessionId: string): Promise<readonly CodexObservedMessage[]> {
    const path = this.#knownPaths.get(providerSessionId);
    if (path === undefined) return [];
    const pending = this.#completeHistoryLoads.get(providerSessionId);
    if (pending !== undefined && pending.path === path) return await pending.promise;

    const promise = this.loadCompleteHistory(providerSessionId, path);
    const record: PendingCompleteHistoryLoad = { path, promise };
    this.#completeHistoryLoads.set(providerSessionId, record);
    try {
      return await promise;
    } finally {
      if (this.#completeHistoryLoads.get(providerSessionId) === record) {
        this.#completeHistoryLoads.delete(providerSessionId);
      }
    }
  }

  public async externalSessionLaunches(providerSessionId: string, since: string): Promise<readonly ObservedExternalSessionLaunch[]> {
    const latest = this.#knownPaths.get(providerSessionId);
    const paths = this.#knownPathHistory.get(providerSessionId) ?? (latest === undefined ? [] : [latest]);
    const launches = (await Promise.all(paths.map(async (path) => await readExternalSessionLaunchesFromRollout(path, since)))).flat();
    const unique = new Map<string, ObservedExternalSessionLaunch>();
    for (const launch of launches) {
      const key = [launch.targetProviderId, launch.title, launch.workingDirectory ?? "", launch.modelId ?? "", launch.observedAt].join("\u0000").toLowerCase();
      unique.set(key, launch);
    }
    return [...unique.values()].sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  }

  /** Exposed for deterministic tests and immediate host refreshes. */
  public async pollNow(providerSessionId?: string): Promise<void> {
    await this.#retirementStateReady;
    if (this.#disposed || this.#polling) return;
    this.#polling = true;
    try {
      if (providerSessionId === undefined) await this.pollActiveThreadDiscovery();
      const metadataEntries = providerSessionId === undefined
        ? this.#trackedTurnMetadata
        : this.#trackedTurnMetadata.has(providerSessionId)
          ? new Map([[providerSessionId, this.#trackedTurnMetadata.get(providerSessionId)!]])
          : new Map<string, TrackedTurnMetadata>();
      for (const [trackedSessionId, tracked] of metadataEntries) {
        await this.readNewRuntimeMetadata(trackedSessionId, tracked);
      }
      const stateEntries = providerSessionId === undefined
        ? this.#tracked
        : this.#tracked.has(providerSessionId)
          ? new Map([[providerSessionId, this.#tracked.get(providerSessionId)!]])
          : new Map<string, TrackedThread>();
      await this.primeWriterLockCache([...stateEntries.keys()]);
      for (const [trackedSessionId, tracked] of stateEntries) {
        await this.readNewMessages(trackedSessionId, tracked);
        if (this.#tracked.get(trackedSessionId) !== tracked) continue;
        const previous = tracked.state;
        const next = await this.resolve(trackedSessionId, tracked);
        tracked.state = next;
        if (!this.#disposed && next !== previous) await this.#onStateChanged(trackedSessionId, next);
      }
    } finally {
      this.#polling = false;
    }
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#retirementStateReady;
    await this.#retirementWriteTail;
    this.#tracked.clear();
    this.#retiredRollouts.clear();
    this.#knownPaths.clear();
    this.#trackedTurnMetadata.clear();
    this.#turnMetadata.clear();
    this.#context.clear();
    this.#recentMessages.clear();
    this.#progressiveHistory.clear();
    this.#completeHistory.clear();
    this.#completeHistoryLoads.clear();
    this.#progressiveHistoryLoads.clear();
    this.#watchedSessionIds.clear();
    this.#activeThreadSnapshot = undefined;
    this.#activeThreadGenerations.clear();
    this.#pendingActiveThreadDiscoveries.clear();
    this.#writerLockCache.clear();
  }

  private async primeWriterLockCache(providerSessionIds: readonly string[]): Promise<void> {
    if (!this.#usesDefaultLockProbe || process.platform !== "win32") return;
    const now = Date.now();
    const due = providerSessionIds
      .filter(safeThreadId)
      .map((providerSessionId) => join(this.#codexHome, "thread-writer-locks", `${providerSessionId}.lock`))
      .filter((path) => {
        const cached = this.#writerLockCache.get(path);
        return cached === undefined || now - cached.checkedAt >= WRITER_LOCK_PROBE_CACHE_MS;
      });
    if (due.length === 0) return;
    const held = await probeWindowsLockBatch(due);
    const checkedAt = Date.now();
    for (const [index, path] of due.entries()) {
      this.#writerLockCache.set(path, { held: held[index] === true, checkedAt });
    }
  }

  private async resolve(providerSessionId: string, tracked: TrackedThread): Promise<SessionState> {
    const file = await rolloutFileFingerprint(tracked.path);
    if (file === null) {
      tracked.fingerprint = undefined;
      tracked.rolloutSize = undefined;
      tracked.marker = "unknown";
      return "unknown";
    }
    const { fingerprint, size } = file;
    tracked.rolloutSize = size;
    if (fingerprint !== tracked.fingerprint) {
      tracked.fingerprint = fingerprint;
      tracked.marker = await readLatestRolloutMarker(tracked.path, this.#tailBytes);
    }
    if (tracked.marker === "terminal") {
      await this.rememberRetiredRollout(providerSessionId, tracked.path, fingerprint);
      return "idle";
    }
    if (tracked.marker !== "started" && tracked.marker !== "truncated") return "unknown";
    const retired = this.#retiredRollouts.get(providerSessionId);
    if (retired?.path === tracked.path && retired.fingerprint === fingerprint) return "idle";
    if (retired !== undefined) await this.forgetRetiredRollout(providerSessionId);
    if (!safeThreadId(providerSessionId)) return "unknown";
    if (!await this.hasWriterLock(providerSessionId)) {
      await this.rememberRetiredRollout(providerSessionId, tracked.path, fingerprint);
      return "idle";
    }
    return "working";
  }

  private async loadRetiredRollouts(): Promise<void> {
    if (this.#retirementStatePath === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#retirementStatePath, "utf8")) as unknown;
    } catch {
      return;
    }
    for (const [providerSessionId, retired] of parseRetiredRollouts(parsed)) {
      this.#retiredRollouts.set(providerSessionId, retired);
    }
    this.pruneRetiredRollouts();
  }

  private async rememberRetiredRollout(providerSessionId: string, path: string, fingerprint: string): Promise<void> {
    const previous = this.#retiredRollouts.get(providerSessionId);
    if (previous?.path === path && previous.fingerprint === fingerprint) return;
    this.#retiredRollouts.set(providerSessionId, { path, fingerprint, retiredAt: Date.now() });
    this.pruneRetiredRollouts();
    await this.persistRetiredRollouts();
  }

  private async forgetRetiredRollout(providerSessionId: string): Promise<void> {
    if (!this.#retiredRollouts.delete(providerSessionId)) return;
    await this.persistRetiredRollouts();
  }

  private pruneRetiredRollouts(): void {
    if (this.#retiredRollouts.size <= MAX_RETIRED_ROLLOUTS) return;
    const retained = [...this.#retiredRollouts.entries()]
      .sort((left, right) => right[1].retiredAt - left[1].retiredAt)
      .slice(0, MAX_RETIRED_ROLLOUTS);
    this.#retiredRollouts.clear();
    for (const [providerSessionId, retired] of retained) this.#retiredRollouts.set(providerSessionId, retired);
  }

  private async persistRetiredRollouts(): Promise<void> {
    if (this.#retirementStatePath === undefined) return;
    const value = {
      version: 1,
      retiredRollouts: [...this.#retiredRollouts.entries()].map(([providerSessionId, retired]) => ({ providerSessionId, ...retired })),
    };
    const write = this.#retirementWriteTail.then(async () => await writeJsonAtomically(this.#retirementStatePath!, value));
    this.#retirementWriteTail = write.catch(() => undefined);
    // Persistence is best-effort for the current process. The in-memory
    // retirement remains authoritative even if the disk briefly rejects it.
    await write.catch(() => undefined);
  }

  private async loadCompleteHistory(providerSessionId: string, path: string): Promise<readonly CodexObservedMessage[]> {
    const previous = this.#completeHistory.get(providerSessionId);
    const refreshed = await refreshCompleteRolloutCache(path, previous?.path === path ? previous : undefined);
    if (refreshed === null) {
      if (this.#knownPaths.get(providerSessionId) === path) this.#completeHistory.delete(providerSessionId);
      return [];
    }
    if (this.#knownPaths.get(providerSessionId) !== path) return refreshed.messages;
    this.rememberCompleteHistory(providerSessionId, refreshed);
    return refreshed.messages;
  }

  private rememberCompleteHistory(providerSessionId: string, entry: CompleteRolloutCacheEntry): void {
    this.#completeHistory.delete(providerSessionId);
    this.#completeHistory.set(providerSessionId, entry);
    while (this.#completeHistory.size > MAX_COMPLETE_HISTORY_CACHES) {
      const oldest = this.#completeHistory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#completeHistory.delete(oldest);
    }
  }

  private rememberProgressiveHistory(providerSessionId: string, history: ProgressiveRolloutHistory): void {
    this.#progressiveHistory.delete(providerSessionId);
    this.#progressiveHistory.set(providerSessionId, history);
    while (this.#progressiveHistory.size > MAX_PROGRESSIVE_HISTORY_CACHES) {
      const oldest = this.#progressiveHistory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#progressiveHistory.delete(oldest);
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
        tracked.partialLineChunks = [];
        tracked.partialLineBytes = 0;
        tracked.droppingOversizedLine = false;
        tracked.toolCalls.clear();
        delete tracked.pendingFinalAnswer;
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

  private async readNewRuntimeMetadata(providerSessionId: string, tracked: TrackedTurnMetadata): Promise<void> {
    let handle;
    try {
      const metadata = await stat(tracked.path);
      if (!metadata.isFile()) return;
      if (metadata.size < tracked.offset) {
        // Replacement/truncation is exceptional and needs one fresh baseline;
        // ordinary append polling must never rescan historical rollout bytes.
        await this.refreshTurnMetadata(providerSessionId, tracked.path, true);
        await this.refreshContext(providerSessionId, tracked.path, true);
        tracked.offset = metadata.size;
        tracked.partialLineChunks = [];
        tracked.partialLineBytes = 0;
        tracked.droppingOversizedLine = false;
        tracked.toolCalls.clear();
        delete tracked.pendingFinalAnswer;
        return;
      }
      if (metadata.size === tracked.offset) return;

      const end = Math.min(metadata.size, tracked.offset + MAX_MESSAGE_BYTES_PER_POLL);
      handle = await open(tracked.path, "r");
      while (tracked.offset < end) {
        const length = Math.min(MESSAGE_READ_CHUNK_BYTES, end - tracked.offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, tracked.offset);
        if (bytesRead === 0) break;
        tracked.offset += bytesRead;
        for (const observation of consumeRolloutBytes(tracked, buffer.subarray(0, bytesRead))) {
          if (this.#disposed || this.#trackedTurnMetadata.get(providerSessionId) !== tracked) return;
          if (observation.message !== undefined) this.rememberRecentMessage(providerSessionId, observation.message);
          if (observation.metadata !== undefined) await this.applyTurnMetadata(providerSessionId, observation.metadata, true);
          if (observation.context !== undefined) await this.applyContext(providerSessionId, observation.context, true);
        }
      }
    } catch {
      // The rollout may disappear while Codex rotates or removes a task. A
      // later poll/reconcile can re-establish the observer without a busy retry.
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async trackTurnMetadata(providerSessionId: string, path: string): Promise<void> {
    const tracked = this.#trackedTurnMetadata.get(providerSessionId);
    if (tracked !== undefined && tracked.path === path) return;
    if (tracked !== undefined) {
      this.#recentMessages.delete(providerSessionId);
      this.#progressiveHistory.delete(providerSessionId);
    }
    await this.refreshTurnMetadata(providerSessionId, path, this.#turnMetadata.has(providerSessionId));
    await this.refreshContext(providerSessionId, path, this.#context.has(providerSessionId));
    this.#trackedTurnMetadata.set(providerSessionId, {
      path,
      offset: await rolloutSize(path) ?? 0,
      partialLineChunks: [],
      partialLineBytes: 0,
      droppingOversizedLine: false,
      toolCalls: new Map(),
    });
  }

  private rememberRecentMessage(providerSessionId: string, message: CodexObservedMessage): void {
    const existing = [...(this.#recentMessages.get(providerSessionId) ?? [])];
    const replaceIndex = message.partType === "activity"
      ? existing.findIndex((candidate) => candidate.messageId === message.messageId)
      : -1;
    if (replaceIndex >= 0) existing[replaceIndex] = message;
    else existing.push(message);
    this.#recentMessages.set(providerSessionId, existing.slice(-DEFAULT_HISTORY_MESSAGES));
    const progressive = this.#progressiveHistory.get(providerSessionId);
    if (progressive !== undefined) {
      const messages = mergeProgressiveRolloutMessages(progressive.messages, [message]);
      this.rememberProgressiveHistory(providerSessionId, { ...progressive, messages });
    }
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
    const discoversActiveThreads = this.#activeThreadDiscoveryEnabled && this.#onActiveThreadDiscovered !== undefined;
    if (this.#disposed || (this.#tracked.size === 0 && this.#trackedTurnMetadata.size === 0 && !discoversActiveThreads)) {
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
      return;
    }
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => { void this.pollNow(); }, this.#pollIntervalMs);
    this.#timer.unref?.();
  }

  private async readActiveThreadIds(): Promise<Set<string> | undefined> {
    try {
      const entries = await readdir(join(this.#codexHome, "thread-writer-locks"), { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isFile() && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.lock$/iu.test(entry.name))
        .map((entry) => entry.name.slice(0, -".lock".length));
      await this.primeWriterLockCache(candidates);
      const held = await Promise.all(candidates.map(async (providerSessionId) => await this.hasWriterLock(providerSessionId)));
      return new Set(candidates.filter((_, index) => held[index] === true));
    } catch {
      // An unavailable directory is not an authoritative empty snapshot. Keep
      // the last good set so a transient filesystem race cannot retire live
      // tasks or turn every reappearing lock into a fresh discovery storm.
      return undefined;
    }
  }

  private rememberActiveThreadSnapshot(next: Set<string>, queueAdditions: boolean): void {
    const previous = this.#activeThreadSnapshot;
    if (previous !== undefined) {
      for (const providerSessionId of previous) {
        if (!next.has(providerSessionId)) this.#pendingActiveThreadDiscoveries.delete(providerSessionId);
      }
    }
    if (queueAdditions) {
      for (const providerSessionId of next) {
        if (previous?.has(providerSessionId) === true) continue;
        const generation = (this.#activeThreadGenerations.get(providerSessionId) ?? 0) + 1;
        this.#activeThreadGenerations.set(providerSessionId, generation);
        this.#pendingActiveThreadDiscoveries.set(providerSessionId, {
          generation,
          attempts: 0,
          nextAttemptAt: 0,
        });
      }
    }
    this.#activeThreadSnapshot = next;
  }

  private async pollActiveThreadDiscovery(): Promise<void> {
    if (!this.#activeThreadDiscoveryEnabled || this.#onActiveThreadDiscovered === undefined) return;
    const observed = await this.readActiveThreadIds();
    if (observed === undefined) return;
    this.rememberActiveThreadSnapshot(observed, true);
    const now = Date.now();
    const due = [...this.#pendingActiveThreadDiscoveries.entries()]
      .filter(([providerSessionId, pending]) => observed.has(providerSessionId) && pending.nextAttemptAt <= now)
      .slice(0, 8);
    await Promise.all(due.map(async ([providerSessionId, pending]) => {
      try {
        await this.#onActiveThreadDiscovered?.(providerSessionId);
        const current = this.#pendingActiveThreadDiscoveries.get(providerSessionId);
        if (current?.generation === pending.generation && this.#activeThreadSnapshot?.has(providerSessionId) === true) {
          this.#pendingActiveThreadDiscoveries.delete(providerSessionId);
        }
      } catch {
        const current = this.#pendingActiveThreadDiscoveries.get(providerSessionId);
        if (current?.generation !== pending.generation || this.#activeThreadSnapshot?.has(providerSessionId) !== true) return;
        const attempts = pending.attempts + 1;
        const delay = Math.min(8_000, this.#pollIntervalMs * (2 ** Math.min(attempts, 4)));
        this.#pendingActiveThreadDiscoveries.set(providerSessionId, {
          generation: pending.generation,
          attempts,
          nextAttemptAt: Date.now() + delay,
        });
      }
    }));
  }
}

interface RolloutLineAccumulator {
  partialLineChunks: Buffer[];
  partialLineBytes: number;
  droppingOversizedLine: boolean;
}

function clearPartialRolloutLine(state: RolloutLineAccumulator): void {
  state.partialLineChunks = [];
  state.partialLineBytes = 0;
}

function appendPartialRolloutLine(state: RolloutLineAccumulator, bytes: Buffer): boolean {
  if (state.partialLineBytes + bytes.length > MAX_ROLLOUT_LINE_BYTES) return false;
  if (bytes.length > 0) {
    state.partialLineChunks.push(Buffer.from(bytes));
    state.partialLineBytes += bytes.length;
  }
  return true;
}

function materializePartialRolloutLine(state: RolloutLineAccumulator, finalSegment?: Buffer): Buffer | null {
  const finalLength = finalSegment?.length ?? 0;
  const total = state.partialLineBytes + finalLength;
  if (total > MAX_ROLLOUT_LINE_BYTES) return null;
  if (state.partialLineChunks.length === 0) return finalSegment ?? Buffer.alloc(0);
  return Buffer.concat(
    finalLength > 0 ? [...state.partialLineChunks, finalSegment!] : state.partialLineChunks,
    total,
  );
}

function consumeRolloutBytes(tracked: IncrementalRolloutState, bytes: Buffer): RolloutObservation[] {
  const observations: RolloutObservation[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const segment = bytes.subarray(start, index);
    if (tracked.droppingOversizedLine) {
      tracked.droppingOversizedLine = false;
    } else {
      const line = materializePartialRolloutLine(tracked, segment);
      if (line !== null) observations.push(...observationsFromLine(line, tracked));
    }
    clearPartialRolloutLine(tracked);
    start = index + 1;
  }

  const remainder = bytes.subarray(start);
  if (remainder.length === 0 || tracked.droppingOversizedLine) return observations;
  if (!appendPartialRolloutLine(tracked, remainder)) {
    clearPartialRolloutLine(tracked);
    tracked.droppingOversizedLine = true;
  }
  return observations;
}

const compactionPresentationMetadata = /\s*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/iu;
const compactionSummaryMaximumDelayMs = 2_000;

function comparableCompactionText(value: string): string {
  return value.replace(compactionPresentationMetadata, "").replace(/\s+/gu, " ").trim();
}

function compactionSummarizesFinal(compaction: CodexObservedMessage, finalAnswer: CodexObservedMessage): boolean {
  if (compaction.partType !== "compaction" || finalAnswer.phase !== "final_answer") return false;
  const compactionAt = Date.parse(compaction.createdAt ?? "");
  const finalAt = Date.parse(finalAnswer.createdAt ?? "");
  if (Number.isFinite(compactionAt) && Number.isFinite(finalAt)) {
    const delay = compactionAt - finalAt;
    if (delay < 0 || delay > compactionSummaryMaximumDelayMs) return false;
  }
  const compactionText = comparableCompactionText(compaction.text);
  const finalText = comparableCompactionText(finalAnswer.text);
  return finalText.length > 0 && (compactionText === finalText
    || Math.min(compactionText.length, finalText.length) >= 120
      && (compactionText.includes(finalText) || finalText.includes(compactionText)));
}

function rolloutControlType(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return isRecord(value.payload) ? value.payload.type : value.type;
}

function observationsFromLine(line: Buffer, tracked: IncrementalRolloutState): RolloutObservation[] {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8").trim());
  } catch {
    return [];
  }
  const message = observedMessageFromValue(value, tracked.toolCalls);
  const metadata = turnMetadataFromValue(value);
  const context = contextFromValue(value);
  const supplementary: RolloutObservation | null = metadata === null && context === null ? null : {
    ...(metadata !== null ? { metadata } : {}),
    ...(context !== null ? { context } : {}),
  };
  const result: RolloutObservation[] = supplementary === null ? [] : [supplementary];
  const pending = tracked.pendingFinalAnswer;
  const controlType = rolloutControlType(value);

  // Codex writes a synthetic final-answer summary immediately before its
  // `compacted` record, then resumes the very same turn. Hold rollout finals
  // until the next lifecycle record distinguishes a real task completion from
  // that internal handoff, so compaction can never flash the task as finished.
  if (message?.role === "assistant" && message.phase === "final_answer") {
    if (pending !== undefined) result.push({ message: pending });
    tracked.pendingFinalAnswer = message;
    return result;
  }
  if (message?.partType === "compaction") {
    if (pending !== undefined && !compactionSummarizesFinal(message, pending)) result.push({ message: pending });
    delete tracked.pendingFinalAnswer;
    result.push({ message });
    return result;
  }
  if (controlType === "task_complete" || controlType === "turn_complete") {
    if (pending !== undefined) result.push({ message: pending });
    delete tracked.pendingFinalAnswer;
    return result;
  }
  if (controlType === "turn_aborted") {
    delete tracked.pendingFinalAnswer;
    return result;
  }
  if (message !== null) {
    if (pending !== undefined) result.push({ message: pending });
    delete tracked.pendingFinalAnswer;
    result.push({ message });
    return result;
  }
  if ((controlType === "task_started" || controlType === "turn_started") && pending !== undefined) {
    result.push({ message: pending });
    delete tracked.pendingFinalAnswer;
  }
  return result;
}

function observedToolText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, MAX_OBSERVED_TOOL_TEXT) : undefined;
  }
  if (value === undefined || value === null) return undefined;
  try {
    const text = JSON.stringify(value);
    return text ? text.slice(0, MAX_OBSERVED_TOOL_TEXT) : undefined;
  } catch {
    return undefined;
  }
}

function observedToolOutput(value: unknown): string | undefined {
  if (typeof value === "string") return observedToolText(value);
  if (Array.isArray(value)) {
    const text = value.map(observedToolOutput).filter((item): item is string => item !== undefined).join("\n").trim();
    return text ? text.slice(0, MAX_OBSERVED_TOOL_TEXT) : undefined;
  }
  if (isRecord(value)) {
    for (const candidate of [value.output, value.text, value.message, value.content, value.result, value.summary]) {
      const text = observedToolOutput(candidate);
      if (text !== undefined) return text;
    }
  }
  return observedToolText(value);
}

function observedExecCommands(input: string | undefined): string[] {
  if (input === undefined) return ["exec"];
  const commands: string[] = [];
  for (const match of input.matchAll(/(?:\bcmd\b|"cmd")\s*:\s*("(?:\\.|[^"\\])*")/gu)) {
    try {
      const command: unknown = JSON.parse(match[1]!);
      if (typeof command === "string" && command.trim()) commands.push(command.trim().slice(0, MAX_OBSERVED_TOOL_TEXT));
    } catch {
      // Keep looking: one malformed nested call must not hide a valid sibling.
    }
  }
  return commands.length > 0 ? commands : [input.trim().slice(0, MAX_OBSERVED_TOOL_TEXT) || "exec"];
}

function rememberObservedToolCall(toolCalls: Map<string, ObservedToolCall>, call: ObservedToolCall): void {
  toolCalls.set(call.callId, call);
  while (toolCalls.size > MAX_TRACKED_TOOL_CALLS) {
    const oldest = toolCalls.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    toolCalls.delete(oldest);
  }
}

function observedToolMessage(
  call: ObservedToolCall,
  output: string | undefined,
  completed: boolean,
): CodexObservedMessage {
  const parts: readonly ContentPart[] = call.name === "exec"
    ? observedExecCommands(call.input).map((command): ContentPart => ({
        type: "command",
        command,
        ...(output !== undefined ? { output } : {}),
        status: completed ? "completed" : "running",
      }))
    : [{
        type: "tool",
        name: call.name,
        callId: call.callId,
        ...(call.input !== undefined ? { input: call.input } : {}),
        ...(output !== undefined ? { output } : {}),
        status: completed ? "completed" : "running",
      }];
  return {
    messageId: call.callId,
    role: "tool",
    text: output ?? call.input ?? call.name,
    partType: "activity",
    parts,
    ...(call.createdAt !== undefined ? { createdAt: call.createdAt } : {}),
  };
}

function observedMessageFromValue(value: unknown, toolCalls = new Map<string, ObservedToolCall>(), includeTerminalMessages = false): CodexObservedMessage | null {
  if (!isRecord(value) || !isRecord(value.payload)) return null;
  if (value.type === "realtime_item" && value.payload.type === "transcript_segment" && value.payload.role === "user") {
    const messageId = typeof value.payload.id === "string" ? value.payload.id.trim() : "";
    const text = typeof value.payload.text === "string" ? value.payload.text.trim() : "";
    if (!messageId || !text) return null;
    return {
      messageId,
      role: "user",
      text,
      partType: "text",
      ...(typeof value.timestamp === "string" ? { createdAt: value.timestamp } : {}),
    };
  }
  if (value.type === "compacted") {
    const text = typeof value.payload.message === "string" ? value.payload.message.trim() : "";
    const createdAt = typeof value.timestamp === "string" ? value.timestamp : undefined;
    if (!text || createdAt === undefined) return null;
    return {
      messageId: `compaction-${createdAt}`,
      role: "assistant",
      text,
      partType: "compaction",
      phase: "commentary",
      createdAt,
    };
  }
  if (includeTerminalMessages && value.type === "event_msg") {
    const createdAt = typeof value.timestamp === "string" ? value.timestamp : undefined;
    const identity = typeof value.payload.turn_id === "string"
      ? value.payload.turn_id
      : typeof value.ordinal === "number" ? String(value.ordinal) : createdAt ?? "terminal";
    if (value.payload.type === "task_complete") {
      const text = typeof value.payload.last_agent_message === "string" ? visibleCodexAssistantText(value.payload.last_agent_message).trim() : "";
      if (!text) return null;
      return {
        messageId: `task-complete-${identity}`,
        role: "assistant",
        text,
        partType: "text",
        phase: "final_answer",
        terminalFallback: true,
        ...(createdAt !== undefined ? { createdAt } : {}),
      };
    }
    if (value.payload.type === "turn_aborted") {
      return {
        messageId: `turn-aborted-${identity}`,
        role: "assistant",
        text: "Task interrupted",
        partType: "activity",
        parts: [{ type: "error", message: "Task interrupted", code: "TURN_ABORTED" }],
        terminalError: true,
        ...(createdAt !== undefined ? { createdAt } : {}),
      };
    }
  }
  if (value.type !== "response_item") return null;
  const payload = value.payload;
  if (payload.type === "custom_tool_call" || payload.type === "function_call") {
    const callId = typeof payload.call_id === "string" && payload.call_id.trim()
      ? payload.call_id.trim()
      : typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : undefined;
    const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;
    if (callId === undefined || name === undefined) return null;
    const call: ObservedToolCall = {
      callId,
      name,
      ...(observedToolText(payload.type === "function_call" ? payload.arguments : payload.input) !== undefined
        ? { input: observedToolText(payload.type === "function_call" ? payload.arguments : payload.input)! }
        : {}),
      ...(typeof value.timestamp === "string" ? { createdAt: value.timestamp } : {}),
    };
    rememberObservedToolCall(toolCalls, call);
    return observedToolMessage(call, undefined, payload.status === "completed");
  }
  if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
    const callId = typeof payload.call_id === "string" && payload.call_id.trim()
      ? payload.call_id.trim()
      : typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : undefined;
    if (callId === undefined) return null;
    const known = toolCalls.get(callId);
    const call: ObservedToolCall = known ?? {
      callId,
      name: "tool",
      ...(typeof value.timestamp === "string" ? { createdAt: value.timestamp } : {}),
    };
    toolCalls.delete(callId);
    return observedToolMessage(call, observedToolOutput(payload.output), true);
  }
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
  // Voice turns already have authoritative realtime transcript records. The
  // backend handoff repeats that utterance together with rolling transcript
  // context, so rendering it would either duplicate speech or leak XML.
  if (payload.role === "user" && payload.content.some((part) =>
    isRecord(part) && typeof part.text === "string" && isCodexRealtimeDelegationText(part.text))) return null;

  const expectedPartType = payload.role === "user" ? "input_text" : "output_text";
  const normalizedUserParts = payload.role === "user" ? codexUserContentParts(payload.content) : undefined;
  const rawText = payload.role === "user"
    ? normalizedUserParts!.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("")
    : payload.content
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === expectedPartType && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  if (payload.role === "user" && isCodexBootstrapUserText(rawText)) return null;
  const text = payload.role === "user" ? stripProviderPromptGuidance(rawText) : visibleCodexAssistantText(rawText);
  if (text.length === 0 && (normalizedUserParts?.length ?? 0) === 0) return null;

  const phase = payload.role === "assistant" && (payload.phase === "commentary" || payload.phase === "final_answer")
    ? payload.phase
    : undefined;
  const codexDelegation = payload.role === "user" && payload.content.some((part) => isRecord(part) && typeof part.text === "string" && /^\s*<codex_delegation>/iu.test(part.text));
  const internalMetadata = payload.role === "user" && isRecord(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : null;
  const turnId = internalMetadata !== null && typeof internalMetadata.turn_id === "string" && internalMetadata.turn_id.trim()
    ? internalMetadata.turn_id.trim()
    : undefined;
  return {
    messageId: payload.id,
    ...(turnId !== undefined ? { turnId } : {}),
    role: payload.role,
    text,
    partType: "text",
    ...(normalizedUserParts !== undefined ? { parts: normalizedUserParts } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(typeof value.timestamp === "string" ? { createdAt: value.timestamp } : {}),
    ...(codexDelegation ? { origin: { kind: "delegation", sender: "codex" } as const } : {}),
  };
}

function rolloutOrdinal(value: Record<string, unknown>, fallback: number): number {
  return typeof value.ordinal === "number" && Number.isSafeInteger(value.ordinal) && value.ordinal >= 0
    ? value.ordinal
    : fallback;
}

function rolloutTimestampMs(value: Record<string, unknown>): number | undefined {
  if (typeof value.timestamp !== "string") return undefined;
  const timestamp = Date.parse(value.timestamp);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function correlatedUserText(content: unknown): string {
  const text = codexUserContentParts(content)
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  return normalizedCorrelatedUserText(text);
}

function normalizedCorrelatedUserText(text: string): string {
  return stripProviderPromptGuidance(text).replace(/\r\n?/gu, "\n").trim();
}

function rolloutUserCorrelation(value: unknown, fallbackOrdinal: number): { key: string; turnId: string; ordinal: number; createdAtMs: number } | null {
  if (!isRecord(value) || value.type !== "response_item" || !isRecord(value.payload)) return null;
  const payload = value.payload;
  if (payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return null;
  const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : null;
  const turnId = metadata !== null && typeof metadata.turn_id === "string" ? metadata.turn_id.trim() : "";
  const text = correlatedUserText(payload.content);
  const createdAtMs = rolloutTimestampMs(value);
  if (!turnId || !text || createdAtMs === undefined) return null;
  return { key: text, turnId, ordinal: rolloutOrdinal(value, fallbackOrdinal), createdAtMs };
}

function canonicalUserCompletion(value: unknown, fallbackOrdinal: number): CanonicalUserCompletion | null {
  if (!isRecord(value) || value.type !== "event_msg" || !isRecord(value.payload)) return null;
  const payload = value.payload;
  const createdAtMs = rolloutTimestampMs(value);
  if (createdAtMs === undefined) return null;
  if (payload.type === "user_message") {
    const messageId = typeof payload.client_id === "string" ? payload.client_id.trim() : "";
    const text = typeof payload.message === "string" ? normalizedCorrelatedUserText(payload.message) : "";
    if (!messageId || !text) return null;
    return {
      text,
      messageId,
      ordinal: rolloutOrdinal(value, fallbackOrdinal),
      createdAtMs,
    };
  }
  if (payload.type !== "item_completed" || !isRecord(payload.item) || payload.item.type !== "UserMessage") return null;
  const turnId = typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
  const messageId = typeof payload.item.id === "string" ? payload.item.id.trim() : "";
  const text = correlatedUserText(payload.item.content);
  if (!turnId || !messageId || !text) return null;
  return {
    text,
    messageId,
    turnId,
    ordinal: rolloutOrdinal(value, fallbackOrdinal),
    createdAtMs,
  };
}

function recordPendingCanonicalUserMessage(
  pending: Map<string, PendingCanonicalUserMessage[]>,
  value: unknown,
  messageIndex: number,
  fallbackOrdinal: number,
): void {
  const correlation = rolloutUserCorrelation(value, fallbackOrdinal);
  if (correlation === null) return;
  const candidates = pending.get(correlation.key) ?? [];
  candidates.push({ index: messageIndex, turnId: correlation.turnId, ordinal: correlation.ordinal, createdAtMs: correlation.createdAtMs });
  pending.set(correlation.key, candidates);
}

function applyCanonicalUserCompletion(
  messages: CodexObservedMessage[],
  pending: Map<string, PendingCanonicalUserMessage[]>,
  value: unknown,
  fallbackOrdinal: number,
): void {
  const completion = canonicalUserCompletion(value, fallbackOrdinal);
  if (completion === null) return;
  const candidates = pending.get(completion.text);
  if (candidates === undefined) return;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    if (completion.turnId !== undefined && candidate.turnId !== completion.turnId) continue;
    const lineDelay = completion.ordinal - candidate.ordinal;
    const timeDelay = completion.createdAtMs - candidate.createdAtMs;
    if (lineDelay < 0 || lineDelay > USER_ITEM_CORRELATION_MAX_LINES
      || timeDelay < 0 || timeDelay > USER_ITEM_CORRELATION_MAX_DELAY_MS) continue;
    const message = messages[candidate.index];
    if (message !== undefined && message.role === "user") {
      messages[candidate.index] = {
        ...message,
        messageId: completion.messageId,
        ...(completion.turnId !== undefined ? { turnId: completion.turnId } : {}),
        canonicalUserMessage: true,
      };
    }
    candidates.splice(index, 1);
    if (candidates.length === 0) pending.delete(completion.text);
    return;
  }
}

function newCompleteRolloutParserState(): CompleteRolloutParserState {
  return {
    messages: [],
    messageIndexes: new Map(),
    pendingCanonicalUsers: new Map(),
    toolCalls: new Map(),
    currentTurnHasFinalAnswer: false,
    fallbackOrdinal: 0,
    partialLineChunks: [],
    partialLineBytes: 0,
    droppingOversizedLine: false,
  };
}

function cloneCompleteRolloutParserState(state: CompleteRolloutParserState): CompleteRolloutParserState {
  return {
    messages: [...state.messages],
    messageIndexes: new Map(state.messageIndexes),
    pendingCanonicalUsers: new Map([...state.pendingCanonicalUsers].map(([key, candidates]) => [key, [...candidates]])),
    toolCalls: new Map(state.toolCalls),
    ...(state.pendingFinalAnswer !== undefined ? { pendingFinalAnswer: state.pendingFinalAnswer } : {}),
    currentTurnHasFinalAnswer: state.currentTurnHasFinalAnswer,
    fallbackOrdinal: state.fallbackOrdinal,
    partialLineChunks: state.partialLineChunks.map((part) => Buffer.from(part)),
    partialLineBytes: state.partialLineBytes,
    droppingOversizedLine: state.droppingOversizedLine,
  };
}

function appendCompleteRolloutMessage(
  state: CompleteRolloutParserState,
  message: CodexObservedMessage,
  value?: unknown,
): void {
  if (message.messageId.startsWith("task-complete-") && state.currentTurnHasFinalAnswer) return;
  if (message.role === "assistant" && message.phase === "final_answer") state.currentTurnHasFinalAnswer = true;
  const existing = message.partType === "activity" ? state.messageIndexes.get(message.messageId) : undefined;
  if (existing === undefined) {
    if (message.partType === "activity") state.messageIndexes.set(message.messageId, state.messages.length);
    state.messages.push(message);
    if (message.role === "user" && value !== undefined) {
      recordPendingCanonicalUserMessage(state.pendingCanonicalUsers, value, state.messages.length - 1, state.fallbackOrdinal);
    }
  } else {
    state.messages[existing] = message;
  }
}

function flushCompletePendingFinal(state: CompleteRolloutParserState): void {
  if (state.pendingFinalAnswer === undefined) return;
  appendCompleteRolloutMessage(state, state.pendingFinalAnswer);
  delete state.pendingFinalAnswer;
}

function consumeCompleteRolloutLine(state: CompleteRolloutParserState, line: Buffer): void {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8").trim());
  } catch {
    return;
  }
  applyCanonicalUserCompletion(state.messages, state.pendingCanonicalUsers, value, state.fallbackOrdinal);
  const userMessage = isRolloutUserMessage(value);
  if (userMessage) {
    flushCompletePendingFinal(state);
    state.currentTurnHasFinalAnswer = false;
  }
  const message = observedMessageFromValue(value, state.toolCalls, true);
  const controlType = rolloutControlType(value);
  if (message?.role === "assistant" && message.phase === "final_answer" && !message.messageId.startsWith("task-complete-")) {
    flushCompletePendingFinal(state);
    state.pendingFinalAnswer = message;
  } else if (message?.partType === "compaction") {
    if (state.pendingFinalAnswer !== undefined && !compactionSummarizesFinal(message, state.pendingFinalAnswer)) {
      flushCompletePendingFinal(state);
    } else {
      delete state.pendingFinalAnswer;
    }
    state.currentTurnHasFinalAnswer = false;
    appendCompleteRolloutMessage(state, message, value);
  } else if (controlType === "task_complete" || controlType === "turn_complete") {
    flushCompletePendingFinal(state);
    if (message !== null) appendCompleteRolloutMessage(state, message, value);
  } else if (controlType === "turn_aborted") {
    delete state.pendingFinalAnswer;
    if (message !== null) appendCompleteRolloutMessage(state, message, value);
  } else if (message !== null) {
    flushCompletePendingFinal(state);
    appendCompleteRolloutMessage(state, message, value);
  } else if ((controlType === "task_started" || controlType === "turn_started") && state.pendingFinalAnswer !== undefined) {
    flushCompletePendingFinal(state);
  }
  state.fallbackOrdinal += 1;
}

function consumeCompleteRolloutBytes(state: CompleteRolloutParserState, bytes: Buffer): void {
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const segment = bytes.subarray(start, index);
    if (state.droppingOversizedLine) {
      state.droppingOversizedLine = false;
    } else {
      const line = materializePartialRolloutLine(state, segment);
      if (line !== null) consumeCompleteRolloutLine(state, line);
    }
    clearPartialRolloutLine(state);
    start = index + 1;
  }

  const remainder = bytes.subarray(start);
  if (remainder.length === 0 || state.droppingOversizedLine) return;
  if (!appendPartialRolloutLine(state, remainder)) {
    clearPartialRolloutLine(state);
    state.droppingOversizedLine = true;
  }
}

function completeRolloutSnapshot(state: CompleteRolloutParserState): readonly CodexObservedMessage[] {
  const provisional = cloneCompleteRolloutParserState(state);
  if (state.droppingOversizedLine) {
    flushCompletePendingFinal(provisional);
    return provisional.messages;
  }
  // Codex normally terminates every JSONL record with a newline. Keep an
  // unterminated final record provisional so a later append can complete it,
  // while matching the historical reader's behavior for an already-valid EOF.
  if (provisional.partialLineBytes > 0) {
    const finalLine = materializePartialRolloutLine(provisional);
    clearPartialRolloutLine(provisional);
    if (finalLine !== null) consumeCompleteRolloutLine(provisional, finalLine);
  }
  // Preserve an abnormal or still-in-flight EOF for history readers while the
  // live observer continues holding it for the decisive completion/compaction
  // record that normally follows within the same poll.
  flushCompletePendingFinal(provisional);
  return provisional.messages;
}

function rolloutFileIdentity(metadata: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>): RolloutFileIdentity {
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    birthtimeMs: String(metadata.birthtimeMs),
  };
}

function sameRolloutFile(left: RolloutFileIdentity, right: RolloutFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.birthtimeMs === right.birthtimeMs;
}

function rolloutFileIdentityKey(identity: RolloutFileIdentity): string {
  return `${identity.device}:${identity.inode}:${identity.birthtimeMs}`;
}

type RolloutHistoryHeader =
  | { readonly kind: "none"; readonly threadId?: string }
  | { readonly kind: "valid"; readonly threadId: string; readonly base: RolloutHistoryBase }
  | { readonly kind: "invalid"; readonly threadId?: string };

interface RolloutHistoryDescriptor {
  readonly segment: RolloutHistorySegment;
  readonly header: RolloutHistoryHeader;
}

function historyHeaderFromValue(value: unknown): RolloutHistoryHeader {
  if (!isRecord(value) || value.type !== "session_meta" || !isRecord(value.payload)) return { kind: "none" };
  const payload = value.payload;
  const rawThreadId = typeof payload.session_id === "string" ? payload.session_id : payload.id;
  const threadId = typeof rawThreadId === "string" && safeThreadId(rawThreadId) ? rawThreadId : undefined;
  if (!("history_base" in payload)) return { kind: "none", ...(threadId !== undefined ? { threadId } : {}) };
  const rawBase = payload.history_base;
  if (!isRecord(rawBase)) return { kind: "invalid", ...(threadId !== undefined ? { threadId } : {}) };
  const baseThreadId = rawBase.thread_id;
  const endOrdinalExclusive = rawBase.end_ordinal_exclusive;
  const endByteOffset = rawBase.end_byte_offset;
  if (threadId === undefined || typeof baseThreadId !== "string" || !safeThreadId(baseThreadId)
    || !Number.isSafeInteger(endOrdinalExclusive) || (endOrdinalExclusive as number) < 0
    || !Number.isSafeInteger(endByteOffset) || (endByteOffset as number) < 0) {
    return { kind: "invalid", ...(threadId !== undefined ? { threadId } : {}) };
  }
  // The continuation's logical task ID may differ from the physical base task
  // ID, but its first ordinal must begin exactly at the declared base cutoff.
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal !== endOrdinalExclusive) {
    return { kind: "invalid", threadId };
  }
  return {
    kind: "valid",
    threadId,
    base: {
      threadId: baseThreadId,
      endOrdinalExclusive: endOrdinalExclusive as number,
      endByteOffset: endByteOffset as number,
    },
  };
}

async function readFirstRolloutLine(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer | null> {
  const maximum = Math.min(size, MAX_ROLLOUT_LINE_BYTES + 1);
  if (maximum <= 0) return null;
  let offset = 0;
  const parts: Buffer[] = [];
  while (offset < maximum) {
    const length = Math.min(MESSAGE_READ_CHUNK_BYTES, maximum - offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead === 0) break;
    const bytes = buffer.subarray(0, bytesRead);
    const newline = bytes.indexOf(0x0a);
    if (newline >= 0) {
      parts.push(Buffer.from(bytes.subarray(0, newline)));
      return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    }
    parts.push(Buffer.from(bytes));
    offset += bytesRead;
  }
  if (offset < size || parts.reduce((total, part) => total + part.length, 0) > MAX_ROLLOUT_LINE_BYTES) return null;
  return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : Buffer.concat(parts);
}

async function readRolloutHistoryDescriptor(path: string, endOffset?: number): Promise<RolloutHistoryDescriptor | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const logicalEnd = endOffset ?? metadata.size;
    if (!Number.isSafeInteger(logicalEnd) || logicalEnd < 0 || logicalEnd > metadata.size) return null;
    const firstLine = await readFirstRolloutLine(handle, metadata.size);
    let firstValue: unknown;
    try { firstValue = firstLine === null ? undefined : JSON.parse(firstLine.toString("utf8").trim()); }
    catch { firstValue = undefined; }
    return {
      segment: {
        path,
        identity: rolloutFileIdentity(metadata),
        endOffset: logicalEnd,
        modifiedAtMs: metadata.mtimeMs,
        changedAtMs: metadata.ctimeMs,
      },
      header: historyHeaderFromValue(firstValue),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function rolloutBoundaryMatches(path: string, base: RolloutHistoryBase): Promise<boolean> {
  if (base.endOrdinalExclusive === 0) return base.endByteOffset === 0;
  if (base.endByteOffset <= 0) return false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || base.endByteOffset > metadata.size) return false;
    const start = Math.max(0, base.endByteOffset - MAX_ROLLOUT_LINE_BYTES - 2);
    const bytes = await readRolloutProbe(handle, start, base.endByteOffset - start);
    if (bytes.length !== base.endByteOffset - start || bytes.at(-1) !== 0x0a) return false;
    const content = bytes.subarray(0, bytes.length - 1);
    const previousNewline = content.lastIndexOf(0x0a);
    if (previousNewline < 0 && start > 0) return false;
    const line = content.subarray(previousNewline + 1);
    let value: unknown;
    try { value = JSON.parse(line.toString("utf8").trim()); }
    catch { return false; }
    return isRecord(value) && Number.isSafeInteger(value.ordinal)
      && value.ordinal === base.endOrdinalExclusive - 1;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizedRolloutPath(path: string): string {
  const normalized = resolvePath(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function rolloutSessionsRoot(path: string): string {
  let current = dirname(resolvePath(path));
  for (let depth = 0; depth < 8; depth += 1) {
    if (basename(current).toLocaleLowerCase() === "sessions") return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirname(resolvePath(path));
}

async function collectRolloutCandidates(root: string, threadId: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const stack: string[] = [root];
  let inspected = 0;
  while (stack.length > 0 && inspected < MAX_ROLLOUT_LINEAGE_FILES) {
    const directory = stack.pop()!;
    let entries: Dirent[];
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      inspected += 1;
      if (inspected > MAX_ROLLOUT_LINEAGE_FILES) break;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) paths.push(entryPath);
    }
  }
  return paths;
}

async function historyBaseCandidates(currentPath: string, base: RolloutHistoryBase): Promise<readonly RolloutHistoryDescriptor[]> {
  const currentDirectory = dirname(resolvePath(currentPath));
  const candidatePaths = new Map<string, string>();
  let localEntries: Dirent[];
  try { localEntries = await readdir(currentDirectory, { withFileTypes: true }); }
  catch { localEntries = []; }
  for (const entry of localEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !entry.name.includes(base.threadId)) continue;
    const path = join(currentDirectory, entry.name);
    candidatePaths.set(normalizedRolloutPath(path), path);
  }

  const matches: RolloutHistoryDescriptor[] = [];
  const validate = async (path: string): Promise<void> => {
    const descriptor = await readRolloutHistoryDescriptor(path, base.endByteOffset);
    if (descriptor?.header.threadId !== base.threadId || !await rolloutBoundaryMatches(path, base)) return;
    matches.push(descriptor);
  };
  for (const path of candidatePaths.values()) await validate(path);
  if (matches.length > 0) return matches;

  const root = rolloutSessionsRoot(currentPath);
  if (normalizedRolloutPath(root) === normalizedRolloutPath(currentDirectory)) return [];
  for (const path of await collectRolloutCandidates(root, base.threadId)) {
    const key = normalizedRolloutPath(path);
    if (candidatePaths.has(key)) continue;
    candidatePaths.set(key, path);
    await validate(path);
  }
  return matches;
}

async function resolveRolloutHistoryLineage(path: string): Promise<RolloutHistoryLineage | null> {
  const current = await readRolloutHistoryDescriptor(path);
  if (current === null) return null;
  const newestFirst: RolloutHistorySegment[] = [current.segment];
  const visited = new Set<string>([rolloutFileIdentityKey(current.segment.identity)]);
  let header = current.header;
  let complete = true;
  for (let depth = 0; header.kind === "valid"; depth += 1) {
    if (depth >= MAX_ROLLOUT_LINEAGE_SEGMENTS - 1) {
      complete = false;
      break;
    }
    const candidates = await historyBaseCandidates(newestFirst.at(-1)!.path, header.base);
    if (candidates.length !== 1) {
      complete = false;
      break;
    }
    const predecessor = candidates[0]!;
    const visitKey = rolloutFileIdentityKey(predecessor.segment.identity);
    if (visited.has(visitKey)) {
      complete = false;
      break;
    }
    visited.add(visitKey);
    newestFirst.push(predecessor.segment);
    header = predecessor.header;
  }
  if (header.kind === "invalid") complete = false;
  const segments = newestFirst.reverse();
  const key = `${complete ? "complete" : "partial"}|${segments.map((segment, index) => [
    normalizedRolloutPath(segment.path),
    rolloutFileIdentityKey(segment.identity),
    index === segments.length - 1 ? "tip" : String(segment.endOffset),
  ].join("@")).join("|")}`;
  return { segments, complete, key };
}

async function readRolloutRange(
  handle: Awaited<ReturnType<typeof open>>,
  state: CompleteRolloutParserState,
  start: number,
  end: number,
): Promise<number> {
  let offset = start;
  while (offset < end) {
    const length = Math.min(MESSAGE_READ_CHUNK_BYTES, end - offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead === 0) break;
    consumeCompleteRolloutBytes(state, buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return offset;
}

async function readRolloutLineOverlap(
  handle: Awaited<ReturnType<typeof open>>,
  state: CompleteRolloutParserState,
  start: number,
  end: number,
): Promise<number> {
  let offset = start;
  let remainingLines = HISTORY_PAGE_OVERLAP_LINES;
  while (offset < end && remainingLines > 0) {
    const length = Math.min(MESSAGE_READ_CHUNK_BYTES, end - offset);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead === 0) break;
    let consumed = bytesRead;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      remainingLines -= 1;
      if (remainingLines === 0) {
        consumed = index + 1;
        break;
      }
    }
    consumeCompleteRolloutBytes(state, buffer.subarray(0, consumed));
    offset += consumed;
  }
  return offset - start;
}

async function readRolloutProbe(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  length: number,
): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, start);
  return Buffer.from(buffer.subarray(0, bytesRead));
}

async function matchesRolloutContinuity(
  handle: Awaited<ReturnType<typeof open>>,
  previous: CompleteRolloutCacheEntry,
): Promise<boolean> {
  const head = await readRolloutProbe(handle, 0, previous.headProbe.length);
  if (!head.equals(previous.headProbe)) return false;
  const tailStart = Math.max(0, previous.offset - previous.tailProbe.length);
  const tail = await readRolloutProbe(handle, tailStart, previous.tailProbe.length);
  return tail.equals(previous.tailProbe);
}

async function refreshCompleteRolloutCache(
  path: string,
  previous?: CompleteRolloutCacheEntry,
): Promise<CompleteRolloutCacheEntry | null> {
  const startedAt = Date.now();
  recordActivityProfile({ type: "complete-history-start", path, hasCachedPrefix: previous !== undefined });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const lineage = await resolveRolloutHistoryLineage(path);
    if (lineage === null || lineage.segments.length === 0) return null;
    const tip = lineage.segments.at(-1)!;
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const identity = rolloutFileIdentity(metadata);
    if (!sameRolloutFile(identity, tip.identity)) return null;
    let state = newCompleteRolloutParserState();
    let start = 0;
    if (previous !== undefined
      && sameRolloutFile(previous.identity, identity)
      && previous.lineageKey === lineage.key
      && metadata.size >= previous.offset
      && await matchesRolloutContinuity(handle, previous)) {
      if (metadata.size === previous.offset
        && metadata.mtimeMs === previous.modifiedAtMs
        && metadata.ctimeMs === previous.changedAtMs) {
        recordActivityProfile({ type: "complete-history-cache-hit", path, bytesRead: 0, messageCount: previous.messages.length, durationMs: Date.now() - startedAt });
        return previous;
      }
      if (metadata.size > previous.offset) {
        state = cloneCompleteRolloutParserState(previous.state);
        start = previous.offset;
      }
      // A same-size file whose metadata changed may have been rewritten in the
      // middle while retaining its edge probes. Rebuild that exceptional case.
    }

    let offset: number;
    if (start > 0) {
      offset = await readRolloutRange(handle, state, start, metadata.size);
    } else {
      for (let index = 0; index < lineage.segments.length - 1; index += 1) {
        const segment = lineage.segments[index]!;
        let segmentHandle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          segmentHandle = await open(segment.path, "r");
          const segmentMetadata = await segmentHandle.stat();
          if (!segmentMetadata.isFile() || segmentMetadata.size < segment.endOffset
            || !sameRolloutFile(rolloutFileIdentity(segmentMetadata), segment.identity)) return null;
          if (await readRolloutRange(segmentHandle, state, 0, segment.endOffset) !== segment.endOffset) return null;
        } finally {
          await segmentHandle?.close().catch(() => undefined);
        }
      }
      offset = await readRolloutRange(handle, state, 0, metadata.size);
    }
    const probeLength = Math.min(HISTORY_CONTINUITY_BYTES, offset);
    const headProbe = await readRolloutProbe(handle, 0, probeLength);
    const tailProbe = await readRolloutProbe(handle, Math.max(0, offset - probeLength), probeLength);
    const messages = mergeProgressiveRolloutMessages([], completeRolloutSnapshot(state));
    recordActivityProfile({
      type: "complete-history-complete",
      path,
      bytesRead: Math.max(0, offset - start),
      parsedRecords: state.fallbackOrdinal,
      messageCount: messages.length,
      retainedContentBytes: observedContentBytes(messages),
      inlineImageBytes: observedInlineImageBytes(messages),
      durationMs: Date.now() - startedAt,
    });
    return {
      path,
      identity,
      lineageKey: lineage.key,
      offset,
      modifiedAtMs: metadata.mtimeMs,
      changedAtMs: metadata.ctimeMs,
      headProbe,
      tailProbe,
      state,
      messages,
    };
  } catch {
    recordActivityProfile({ type: "complete-history-failed", path, durationMs: Date.now() - startedAt });
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Streams the complete available rollout so old delegated tasks remain fully pageable. */
export async function readAllRolloutMessages(path: string): Promise<readonly CodexObservedMessage[]> {
  return (await refreshCompleteRolloutCache(path))?.messages ?? [];
}

interface RolloutCursorBoundary {
  readonly segmentIdentity: string;
  readonly offset: number;
}

function rolloutCursor(boundary: RolloutCursorBoundary): string {
  return `${ROLLOUT_CURSOR_PREFIX}${Buffer.from(JSON.stringify({
    segment: boundary.segmentIdentity,
    offset: boundary.offset,
  }), "utf8").toString("base64url")}`;
}

function rolloutCursorBoundary(cursor: string): RolloutCursorBoundary | null {
  if (!cursor.startsWith(ROLLOUT_CURSOR_PREFIX)) return null;
  const raw = cursor.slice(ROLLOUT_CURSOR_PREFIX.length);
  if (!raw || raw.length > 1_024) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { return null; }
  if (!isRecord(value) || typeof value.segment !== "string" || !value.segment || value.segment.length > 512
    || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0) return null;
  return { segmentIdentity: value.segment, offset: value.offset as number };
}

function progressiveOlderBoundary(history: ProgressiveRolloutHistory): (RolloutCursorBoundary & { readonly segmentIndex: number }) | null {
  const segmentIndex = history.startOffset > 0
    ? history.startSegmentIndex
    : history.startSegmentIndex - 1;
  if (segmentIndex < 0) return null;
  const segment = history.segments[segmentIndex];
  if (segment === undefined) return null;
  return {
    segmentIndex,
    segmentIdentity: rolloutFileIdentityKey(segment.identity),
    offset: history.startOffset > 0 ? history.startOffset : segment.endOffset,
  };
}

function progressiveMessageWindow(history: ProgressiveRolloutHistory): CodexRecentMessageWindow {
  const boundary = progressiveOlderBoundary(history);
  return {
    messages: history.messages,
    complete: history.lineageComplete && boundary === null,
    ...(boundary !== null ? { olderCursor: rolloutCursor(boundary) } : {}),
  };
}

function rolloutMessagePageWindow(page: RolloutMessagePage, history: ProgressiveRolloutHistory): CodexRecentMessageWindow {
  const boundary = progressiveOlderBoundary(history);
  return {
    messages: page.messages,
    complete: history.lineageComplete && boundary === null,
    ...(boundary !== null ? { olderCursor: rolloutCursor(boundary) } : {}),
  };
}

function observedContentBytes(messages: readonly CodexObservedMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    for (const part of message.parts ?? []) {
      if (part.type === "text" || part.type === "reasoning") total += part.text.length;
      else if (part.type === "tool") total += (part.output?.length ?? 0) + (typeof part.input === "string" ? part.input.length : 0);
      else if (part.type === "command") total += part.command.length + (part.output?.length ?? 0);
      else if (part.type === "file_change") total += part.path.length + (part.patch?.length ?? 0);
      else if (part.type === "error") total += part.message.length + (part.code?.length ?? 0);
      else if (part.type === "image") total += (part.uri?.length ?? 0) + (part.name?.length ?? 0);
      else if (part.type === "audio") total += part.uri.length + part.name.length;
      else if (part.type === "file") total += part.name.length + (part.mimeType?.length ?? 0);
      else if (part.type === "workflow") total += part.workflow.name.length + (part.workflow.promptReference?.length ?? 0);
      else if (part.type === "subagent") total += (part.prompt?.length ?? 0) + (part.summary?.length ?? 0);
    }
  }
  return total;
}

function observedInlineImageBytes(messages: readonly CodexObservedMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === "image" && part.uri?.startsWith("data:") === true) total += part.uri.length;
    }
  }
  return total;
}

function progressiveMessageIdentity(message: CodexObservedMessage): string {
  return `${message.role}\u0000${message.partType}\u0000${message.messageId}`;
}

function progressiveMessageDetail(message: CodexObservedMessage): number {
  return contentPartsDetail(message.parts) + message.text.length
    + (message.canonicalUserMessage === true ? 1_000_000 : 0)
    + (message.phase === "final_answer" ? 100_000 : 0)
    + (message.terminalError === true ? 10_000 : 0)
    - (message.terminalFallback === true ? 1_000 : 0);
}

function contentPartsDetail(parts: readonly ContentPart[] | undefined): number {
  try { return JSON.stringify(parts ?? []).length; }
  catch { return 0; }
}

function mergeProgressiveActivityParts(
  left: readonly ContentPart[] | undefined,
  right: readonly ContentPart[] | undefined,
): readonly ContentPart[] | undefined {
  const leftPart = left?.length === 1 ? left[0] : undefined;
  const rightPart = right?.length === 1 ? right[0] : undefined;
  if (leftPart?.type === "tool" && rightPart?.type === "tool") {
    const named = leftPart.name !== "tool" ? leftPart : rightPart;
    return [{
      type: "tool",
      name: named.name,
      ...(named.callId !== undefined ? { callId: named.callId } : {}),
      ...(leftPart.input !== undefined ? { input: leftPart.input } : rightPart.input !== undefined ? { input: rightPart.input } : {}),
      ...(rightPart.output !== undefined ? { output: rightPart.output } : leftPart.output !== undefined ? { output: leftPart.output } : {}),
      status: leftPart.status === "completed" || rightPart.status === "completed" ? "completed" : "running",
    }];
  }
  if (leftPart?.type === "command" && rightPart?.type === "command") {
    const command = leftPart.command !== "exec" ? leftPart.command : rightPart.command;
    return [{
      type: "command",
      command,
      ...(rightPart.output !== undefined ? { output: rightPart.output } : leftPart.output !== undefined ? { output: leftPart.output } : {}),
      status: leftPart.status === "completed" || rightPart.status === "completed" ? "completed" : "running",
    }];
  }
  return contentPartsDetail(left) >= contentPartsDetail(right)
    ? left
    : right;
}

function mergeProgressiveMessage(left: CodexObservedMessage, right: CodexObservedMessage): CodexObservedMessage {
  const preferred = progressiveMessageDetail(right) > progressiveMessageDetail(left) ? right : left;
  const phase = left.phase === "final_answer" || right.phase === "final_answer"
    ? "final_answer" as const
    : left.phase === "commentary" || right.phase === "commentary" ? "commentary" as const : undefined;
  const activityParts = left.partType === "activity" && right.partType === "activity"
    ? mergeProgressiveActivityParts(left.parts, right.parts)
    : preferred.parts;
  return {
    ...preferred,
    ...(left.turnId !== undefined ? { turnId: left.turnId } : right.turnId !== undefined ? { turnId: right.turnId } : {}),
    ...(left.canonicalUserMessage === true || right.canonicalUserMessage === true ? { canonicalUserMessage: true } : {}),
    ...(activityParts !== undefined ? { parts: activityParts } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(left.origin !== undefined ? { origin: left.origin } : right.origin !== undefined ? { origin: right.origin } : {}),
    ...(left.terminalError === true || right.terminalError === true ? { terminalError: true } : {}),
    ...(left.terminalFallback === true || right.terminalFallback === true ? { terminalFallback: true } : {}),
  };
}

function mergeProgressiveRolloutMessages(
  older: readonly CodexObservedMessage[],
  newer: readonly CodexObservedMessage[],
): readonly CodexObservedMessage[] {
  const merged: CodexObservedMessage[] = [];
  const indexes = new Map<string, number>();
  for (const message of [...older, ...newer]) {
    const identity = progressiveMessageIdentity(message);
    const existing = indexes.get(identity);
    if (existing === undefined) {
      indexes.set(identity, merged.length);
      merged.push(message);
    } else {
      merged[existing] = mergeProgressiveMessage(merged[existing]!, message);
    }
  }
  const actualFinalText = new Set(merged
    .filter((message) => message.phase === "final_answer" && message.terminalFallback !== true)
    .map((message) => message.text));
  return merged.filter((message) => message.terminalFallback !== true || !actualFinalText.has(message.text));
}

async function readRolloutMessagePage(
  path: string,
  requestedEnd: number | undefined,
  maxBytes: number,
  newerOverlapBytes = 0,
  maximumEnd?: number,
): Promise<RolloutMessagePage | null> {
  const startedAt = Date.now();
  recordActivityProfile({ type: "rollout-page-start", path, requestedEnd, maxBytes, newerOverlapBytes });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) return null;
    const logicalMaximum = maximumEnd ?? metadata.size;
    if (!Number.isSafeInteger(logicalMaximum) || logicalMaximum < 0 || logicalMaximum > metadata.size) return null;
    const endOffset = requestedEnd ?? logicalMaximum;
    if (!Number.isSafeInteger(endOffset) || endOffset < 0 || endOffset > logicalMaximum) return null;
    const startOffset = Math.max(0, endOffset - Math.max(1, maxBytes));
    const parseEnd = Math.min(logicalMaximum, endOffset + Math.max(0, newerOverlapBytes));
    const state = newCompleteRolloutParserState();
    // The first record can begin in the preceding page. It is intentionally
    // dropped here and recovered when that preceding page reads into overlap.
    if (startOffset > 0) state.droppingOversizedLine = true;
    const primaryBytesRead = (await readRolloutRange(handle, state, startOffset, endOffset)) - startOffset;
    let overlapBytesRead = 0;
    if (parseEnd > endOffset) {
      // Boundary repair depends on a fixed number of following records, not a
      // fixed 10 MiB slab. Stop after those records so successive pages never
      // reparse most of their already-loaded newer neighbour.
      overlapBytesRead = await readRolloutLineOverlap(handle, state, endOffset, parseEnd);
    }
    const messages = completeRolloutSnapshot(state);
    const page = {
      identity: rolloutFileIdentity(metadata),
      endOffset,
      startOffset,
      messages,
    };
    recordActivityProfile({
      type: "rollout-page-complete",
      path,
      startOffset,
      endOffset,
      bytesRead: primaryBytesRead + overlapBytesRead,
      parsedRecords: state.fallbackOrdinal,
      messageCount: page.messages.length,
      retainedContentBytes: observedContentBytes(messages),
      inlineImageBytes: observedInlineImageBytes(messages),
      durationMs: Date.now() - startedAt,
    });
    return page;
  } catch {
    recordActivityProfile({ type: "rollout-page-failed", path, durationMs: Date.now() - startedAt });
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Reads only a bounded recent tail from a Codex rollout. The parser exposes
 * user/assistant text, reasoning summaries, and bounded tool activity. Encrypted
 * content, unknown response items, and the incomplete leading record are ignored.
 */
export async function readRecentRolloutMessages(
  path: string,
  maxMessages = DEFAULT_HISTORY_MESSAGES,
  maxBytes = DEFAULT_HISTORY_BYTES,
): Promise<readonly CodexObservedMessage[]> {
  // Small awaited reads yield to Electron's event loop, so opening a large task
  // cannot monopolize typing or window input while its recent page is prepared.
  const lineage = await resolveRolloutHistoryLineage(path);
  if (lineage === null || lineage.segments.length === 0) return [];
  let segmentIndex = lineage.segments.length - 1;
  let boundary = lineage.segments[segmentIndex]!.endOffset;
  let remainingBytes = Math.max(1, maxBytes);
  let messages: readonly CodexObservedMessage[] = [];
  while (remainingBytes > 0) {
    const segment = lineage.segments[segmentIndex]!;
    const page = await readRolloutMessagePage(segment.path, boundary, remainingBytes, 0, segment.endOffset);
    if (page === null || !sameRolloutFile(page.identity, segment.identity) || page.endOffset !== boundary) return [];
    messages = mergeProgressiveRolloutMessages(page.messages, messages);
    remainingBytes -= page.endOffset - page.startOffset;
    if (page.startOffset > 0 || segmentIndex === 0) break;
    segmentIndex -= 1;
    boundary = lineage.segments[segmentIndex]!.endOffset;
  }
  return messages.slice(-Math.max(1, maxMessages));
}

function isRolloutUserMessage(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  return value.type === "response_item" && value.payload.type === "message" && value.payload.role === "user"
    || value.type === "realtime_item" && value.payload.type === "transcript_segment" && value.payload.role === "user";
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

async function lockFileHeld(path: string): Promise<boolean> {
  if (process.platform === "win32") return await windowsLockFileHeld(path);
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

interface PendingWindowsLockProbe {
  readonly path: string;
  readonly resolve: (held: boolean) => void;
}

const pendingWindowsLockProbes: PendingWindowsLockProbe[] = [];
let runningWindowsLockProbe = false;

function windowsLockFileHeld(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingWindowsLockProbes.push({ path, resolve });
    if (runningWindowsLockProbe) return;
    runningWindowsLockProbe = true;
    queueMicrotask(() => { void drainWindowsLockProbes(); });
  });
}

async function drainWindowsLockProbes(): Promise<void> {
  while (pendingWindowsLockProbes.length > 0) {
    const batch = pendingWindowsLockProbes.splice(0, 64);
    const results = await probeWindowsLockBatch(batch.map((entry) => entry.path));
    for (const [index, entry] of batch.entries()) entry.resolve(results[index] === true);
  }
  runningWindowsLockProbe = false;
}

const windowsLockProbeScript = [
  "$paths = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$result = foreach ($path in $paths) {",
  "$stream = $null",
  "try {",
  "$stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
  "'0'",
  "} catch [System.IO.IOException] {",
  "if ($_.Exception.HResult -eq -2147024864) { '1' } else { '0' }",
  "} catch { '0' } finally { if ($null -ne $stream) { $stream.Dispose() } }",
  "}",
  "[Console]::Out.Write(($result -join \"`n\"))",
].join("; ");

async function probeWindowsLockBatch(paths: readonly string[]): Promise<readonly boolean[]> {
  if (paths.length === 0) return [];
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return await new Promise<readonly boolean[]>((resolve) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsLockProbeScript], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        resolve(paths.map(() => false));
        return;
      }
      const lines = String(stdout).trim().split(/\r?\n/u);
      resolve(paths.map((_, index) => lines[index]?.trim() === "1"));
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(paths));
  });
}

function parseRetiredRollouts(value: unknown): ReadonlyMap<string, RetiredRollout> {
  const result = new Map<string, RetiredRollout>();
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.retiredRollouts)) return result;
  for (const candidate of value.retiredRollouts) {
    if (!isRecord(candidate)
      || typeof candidate.providerSessionId !== "string"
      || !safeThreadId(candidate.providerSessionId)
      || typeof candidate.path !== "string"
      || !isAbsolute(candidate.path)
      || typeof candidate.fingerprint !== "string"
      || candidate.fingerprint.length === 0
      || typeof candidate.retiredAt !== "number"
      || !Number.isFinite(candidate.retiredAt)) continue;
    result.set(candidate.providerSessionId, {
      path: candidate.path,
      fingerprint: candidate.fingerprint,
      retiredAt: candidate.retiredAt,
    });
  }
  return result;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await replaceFile(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function replaceFile(temporary: string, destination: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (attempt >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * 20));
    }
  }
}

async function rolloutFileFingerprint(path: string): Promise<{ readonly fingerprint: string; readonly size: number } | null> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() ? { fingerprint: `${metadata.mtimeMs}:${metadata.size}`, size: metadata.size } : null;
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
