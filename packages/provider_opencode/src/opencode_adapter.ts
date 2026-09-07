import { createHash, randomUUID } from "node:crypto";
import { ExponentialBackoff, type JsonObject, type ProviderCapabilities, type RemoteMessage, type RemoteModel, type RemoteSession, type SessionContextState } from "../../protocol/src/index.js";
import {
  ProviderAdapterError,
  ProviderEventHub,
  isProviderContinuationContent,
  providerPromptContent,
  type AgentProviderAdapter,
  type AuthStatus,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type MessageAttachment,
  type PaginatedSessions,
  type ProviderApprovalResponse,
  type ProviderDetection,
  type ProviderEvent,
  type ProviderEventSink,
  type ProviderSessionPermissions,
  type ProviderUserInputResponse,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../provider_contract/src/index.js";
import { OpenCodeHttpClient, type OpenCodeHttpClientOptions } from "./http_client.js";
import { SqliteOpenCodeActivityReader, type OpenCodeActivityReader, type SqliteOpenCodeActivityReaderOptions } from "./activity.js";
import {
  isOpenCodeSessionIndexCursor,
  SqliteOpenCodeSessionIndexReader,
  type OpenCodeSessionIndexReader,
} from "./catalogue.js";
import { asJsonObject, isContinuingOpenCodeToolPart, isOpenCodeEyesTool, isRecord, normalizeOpenCodeMessages, normalizeOpenCodeProviderStatus, normalizeOpenCodeSession, normalizeOpenCodeToolEventPayload, normalizeStatus } from "./normalize.js";
import { extractedPdfTextAttachment, isPdfAttachment } from "./pdf_fallback.js";

export interface OpenCodeAdapterOptions extends OpenCodeHttpClientOptions {
  readonly hostId: string;
  readonly directory?: string;
  readonly now?: () => Date;
  readonly activityReader?: OpenCodeActivityReader;
  readonly catalogueReader?: OpenCodeSessionIndexReader;
  /** Explicit opt-in to OpenCode's undocumented local SQLite state. */
  readonly localActivity?: false | SqliteOpenCodeActivityReaderOptions;
  readonly activityPollIntervalMs?: number;
  /** How often the small session catalogue is sampled for external activity. */
  readonly activityDiscoveryIntervalMs?: number;
  /** How often the owning OpenCode server's provider-wide status map is sampled. */
  readonly nativeStatusPollIntervalMs?: number;
  /**
   * A second server whose live events keep streaming while the desktop hands
   * over to the user's own server; used until the previous server's turns drain.
   */
  readonly secondaryBaseUrl?: string;
  /** Sessions already in flight on the secondary server when the feed attaches. */
  readonly secondaryActiveSessionIds?: readonly string[];
  /**
   * How long a dispatched turn stays marked active after the local activity
   * database stops reporting it, for servers that never emit session.idle.
   */
  readonly activeTurnSettleMs?: number;
  readonly compactionTimeoutMs?: number;
}

function openCodeMessageId(requestId: string): string {
  // OpenCode persists the caller-supplied message ID. Deriving it from the
  // bridge request identity lets a safe retry target the same native message
  // instead of appending a duplicate user turn after a lost HTTP response.
  return `msg_${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}

const capabilities: ProviderCapabilities = {
  authentication: false,
  listSessions: true,
  paginatedSessions: true,
  sessionHistory: true,
  createSession: true,
  resumeSession: true,
  sendMessage: true,
  steering: true,
  streamingText: true,
  toolEvents: true,
  commandEvents: true,
  fileChanges: true,
  approvals: true,
  userInput: true,
  interrupt: true,
  modelEnumeration: true,
  projectAssociation: true,
  sessionRelationships: true,
  messageEditing: false,
  remoteConnectivity: "documented_remote",
  notes: [
    "Uses OpenCode's documented HTTP/OpenAPI and SSE server surfaces.",
    "Remote-initiated authentication is intentionally disabled; authenticate providers on the host with official OpenCode flows.",
    "Uses a lightweight local session index for complete cursor pagination when local OpenCode state is enabled.",
  ],
};

interface PendingPermission {
  readonly sessionId: string;
  readonly nativePermissionId: string;
}

interface PendingQuestion {
  readonly sessionId: string;
  readonly nativeRequestId: string;
  readonly source: "primary" | "secondary";
  readonly directory: string | undefined;
  readonly questions: readonly JsonObject[];
  readonly payload: JsonObject;
  resolving: boolean;
}

interface GuardAbortGeneration {
  /** The Tethoq-dispatched user message whose impossible continuation was stopped. */
  readonly parentId: string;
  /** The exact same-parent assistant that caused the guarded abort attempt. */
  readonly continuationAssistantId: string;
  /** Whether this guard repairs a completed turn or exposes a provider failure. */
  readonly terminalKind: "completed" | "failed";
  /** A rejected HTTP response is ambiguous because the server may already have acted. */
  outcome: "attempting" | "uncertain" | "confirmed";
  /** The next Tethoq prompt, retained until its provider echo forms a FIFO boundary. */
  successorMessageId: string | undefined;
  /** Started synchronously before the lifecycle lock releases; safe for re-entrant sends. */
  completion: Promise<void> | undefined;
}

interface EmptyUnknownSequence {
  readonly parentId: string;
  readonly assistantIds: string[];
}

interface SettledOwnedSession {
  readonly parentId: string;
  readonly assistantId: string;
}

interface PendingOwnedIdle {
  /** The exact user message this completion may end, including observed turns. */
  readonly parentId: string;
  /** Observing an external turn must never grant the runaway guard ownership. */
  readonly ownedPromptId: string | undefined;
  /** A completed no-tool assistant can prove its own terminal boundary without
   * waiting for OpenCode's later, session-wide idle publication. */
  assistantId: string | undefined;
  /** Preserve the native idle as evidence when the delayed confirmation succeeds. */
  nativeEvent: JsonObject | undefined;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  revision: number;
  confirmedAssistantId: string | undefined;
  checksInFlight: number;
}

interface TerminalCleanupGeneration {
  readonly kind: "interrupted" | "failed";
  readonly parentId: string | undefined;
  successorMessageId: string | undefined;
  cleanupObserved: boolean;
  readonly cleanupObservedSignal: Promise<void>;
  readonly resolveCleanupObserved: () => void;
  interruption: Promise<void> | undefined;
}

type TerminalConfirmation =
  | { readonly kind: "terminal"; readonly assistantId: string }
  | { readonly kind: "continuing" }
  | { readonly kind: "unavailable" };

type RunawayStopResult =
  | { readonly kind: "completed"; readonly completion: Promise<void> }
  | { readonly kind: "stale" }
  | { readonly kind: "uncertain" };

interface SessionListSnapshot {
  readonly sessions: readonly RemoteSession[];
  readonly expiresAt: number;
}

interface NativeStatusSnapshot {
  readonly statuses: Record<string, unknown>;
  readonly nativeEventRevisionAtStart: number;
  readonly connectionGenerationAtStart: number;
}

const sessionListSnapshotTtlMs = 5_000;
const maxSessionListSnapshots = 8;
/**
 * `/session` has a limit but no cursor for older rows. Keep enough recent rows
 * for several local pages without turning a small sidebar request into a full
 * catalogue load. A task with a known session id remains directly addressable.
 */
const minimumSessionListSnapshotEntries = 100;
const sessionListSnapshotPrefetchPages = 5;
const maxSessionListSnapshotEntries = 500;
/** Enough parts for several concurrent turns without growing without bound. */
const maxTrackedParts = 512;
/** Provider-wide discovery is change-driven; this only throttles repeated WAL wakes. */
const defaultActivityDiscoveryIntervalMs = 1_000;
/** Missed filesystem events recover here without turning the DB into a hot poll. */
const defaultActivitySafetyPollIntervalMs = 30_000;
/** Recovers missed status SSE without turning one HTTP request into a per-task poll. */
const defaultNativeStatusPollIntervalMs = 1_500;
/** A dead server cannot hold the activity reconciler behind the general 30s HTTP timeout. */
const nativeStatusRequestTimeoutMs = 1_500;
const questionRecoveryIntervalMs = 10_000;
/** Allow a full model compaction, while bounding both transport and completion. */
const compactionRequestTimeoutMs = 10 * 60_000;
/** Provider events are immediate; this bounded history read only recovers a missed event. */
const compactionCompletionPollIntervalMs = 2_000;
/**
 * Once a task is known to be active, exact indexed checks are tiny and keep a
 * coalesced/missed WAL notification from leaving its spinner stale for half a
 * safety-poll interval. Provider-wide discovery remains change-driven.
 */
// Filesystem notifications are the fast path. This exact-ID read is only the
// missed-notification safety net, and packaged Electron performs it in a short
// isolated Node helper, so keep it slower than the watcher debounce rather than
// spawning a helper more than once per second throughout an active turn.
const knownActiveSafetyPollIntervalMs = 2_000;
/** Lets SQLite finish its first WAL commit before a leading-edge discovery read. */
const activityChangeSettleMs = 100;
/** Hydrate separate externally active tasks together without flooding the local server. */
const maximumConcurrentActivityReconciliations = 8;
/** Persisted messages can trail SSE slightly; retry briefly rather than losing the only idle. */
const ownedIdleConfirmationDelaysMs = [25, 75, 200, 500, 1_000] as const;
/** A second matching read prevents a queued tool part from losing a race to idle. */
const ownedIdleQuietConfirmationMs = 75;
/** Two fully persisted empty generations are provider failure, not useful work. */
const emptyUnknownResponseLimit = 2;
/** A rejected abort can still have acted; give its native cleanup a brief causal window. */
const manualInterruptCleanupGraceMs = 250;
const disabledActivityReader: OpenCodeActivityReader = {
  async readWorkingSessionIds(_sessionIds: ReadonlySet<string>): Promise<ReadonlySet<string>> { return new Set(); },
  close(): void {},
};
const disabledCatalogueReader: OpenCodeSessionIndexReader = {
  async readPage() { return undefined; },
  close(): void {},
};

export class OpenCodeAdapter implements AgentProviderAdapter {
  public readonly providerId = "opencode";
  public readonly displayName = "OpenCode";
  readonly #visionSessions = new Set<string>();
  public readonly sessionCreationFeatures = {
    hiddenDeveloperInstructions: false, ephemeralSessions: false, selectableClientTools: false, visionToolIsolation: true,
  } as const;
  readonly #client: OpenCodeHttpClient;
  readonly #compactionTimeoutMs: number;
  readonly #hostId: string;
  readonly #directory: string | undefined;
  readonly #now: () => Date;
  readonly #events = new ProviderEventHub();
  readonly #permissions = new Map<string, PendingPermission>();
  readonly #questions = new Map<string, PendingQuestion>();
  readonly #questionDirectories = new Set<string | undefined>();
  readonly #questionRecoveries = new Map<string, Promise<void>>();
  #questionRevision = 0;
  #nextQuestionRecoveryAt = 0;
  #questionDiscovery: Promise<void> | undefined;
  readonly #abort = new AbortController();
  readonly #activityReader: OpenCodeActivityReader;
  readonly #sessionIndexReader: OpenCodeSessionIndexReader;
  readonly #activityPollIntervalMs: number;
  readonly #activityDiscoveryIntervalMs: number;
  readonly #nativeStatusPollIntervalMs: number;
  readonly #activeTurnSettleMs: number;
  readonly #sessionListSnapshots = new Map<string, SessionListSnapshot>();
  /** Model limits come from the catalogue, while usage remains a fresh history read. */
  readonly #contextWindowTokensByModel = new Map<string, number | null>();
  readonly #partTexts = new Map<string, string>();
  readonly #partTypes = new Map<string, string>();
  readonly #messageRoles = new Map<string, string>();
  readonly #reportedSelections = new Map<string, { readonly key: string; readonly messageCreatedAt?: number }>();
  readonly #activePromptMessageIds = new Map<string, string>();
  readonly #compactionLifecycleWaiters = new Map<string, Set<() => void>>();
  readonly #compactions = new Map<string, Promise<void>>();
  readonly #continuingToolMessageIds = new Set<string>();
  readonly #terminalPromptCandidates = new Map<string, string>();
  readonly #runawayPromptParents = new Set<string>();
  readonly #emptyUnknownSequences = new Map<string, EmptyUnknownSequence>();
  readonly #suppressedMessageIds = new Set<string>();
  /** Sessions whose current runner was deliberately aborted after a confirmed
   * impossible same-prompt continuation. Native abort/status/idle events for
   * that runner must not overwrite the valid answer we already completed. */
  readonly #guardAbortGenerations = new Map<string, GuardAbortGeneration>();
  /** Quarantines the trailing idle/error finalizers for one interrupted or failed turn. */
  readonly #terminalCleanupGenerations = new Map<string, TerminalCleanupGeneration>();
  readonly #pendingOwnedIdles = new Map<string, PendingOwnedIdle>();
  /**
   * A confirmed no-tool terminal for a Tethoq-owned prompt. OpenCode's runner
   * often stays busy for title generation, snapshot, and plugin wrap-up after
   * the answer is already persisted; those events must not revive the turn.
   */
  readonly #settledOwnedSessions = new Map<string, SettledOwnedSession>();
  /** Serializes session-wide aborts with prompt dispatches. */
  readonly #sessionLifecycleTails = new Map<string, Promise<void>>();
  /** Invalidates an activity snapshot taken across a guard-generation transition. */
  #guardActivityEpoch = 0;
  #activityLoop: Promise<void> | null = null;
  #nativeStatusLoop: Promise<void> | null = null;
  #nextActivityDiscoveryAt = 0;
  #nextActivitySafetyDiscoveryAt = 0;
  #activityRefreshRequested = false;
  #activityDiscoveryPending = false;
  #activityDelayWake: (() => void) | undefined;
  #activityChangeDebounce: NodeJS.Timeout | undefined;
  #stopActivityChangeWatch: (() => void) | undefined;
  #initialActivitySnapshot: Promise<boolean> | undefined;
  /** Lets an event subscriber exact-read a newly discovered task without waiting
   * on the very startup reconciliation whose event it is currently handling. */
  #applyingPersistedWorking: ReadonlySet<string> | undefined;
  #persistedActivityAvailable = false;
  #persistedWorking = new Set<string>();
  readonly #activePrompts = new Set<string>();
  #activeSettleDeadlines = new Map<string, number>();
  #nativeStates = new Map<string, RemoteSession["state"]>();
  #nativeStatuses = new Map<string, unknown>();
  #nativeStatusRead: Promise<NativeStatusSnapshot> | undefined;
  #nativeStatusReconcileTail: Promise<void> = Promise.resolve();
  #nativeEventRevision = 0;
  readonly #nativeEventRevisionBySession = new Map<string, number>();
  #primaryEventStreamDisconnected = false;
  #primaryConnectionGeneration = 0;
  readonly #disconnectedActiveSessionIds = new Set<string>();
  readonly #disconnectedNativeSessionIds = new Set<string>();
  readonly #disconnectedPersistedSessionIds = new Set<string>();
  readonly #primaryReconnectRefreshes = new Set<Promise<void>>();
  #eventLoop: Promise<void> | null = null;
  readonly #eventNamespace = randomUUID();
  #eventCounter = 0;
  #sessionListSnapshotGeneration = 0;
  #everDetected = false;
  #disposed = false;
  /**
   * Optional second server feed. While the desktop hands over to the user's own
   * OpenCode server, its previous server may still be finishing a turn; that
   * server's live events keep streaming through this feed until it drains.
   */
  #secondaryClient: OpenCodeHttpClient | undefined;
  readonly #secondaryClientOptions: OpenCodeHttpClientOptions;
  #secondaryAbort = new AbortController();
  #secondaryLoop: Promise<void> | null = null;
  #secondaryActive = new Set<string>();
  readonly #secondaryActiveSeed: readonly string[];

  public constructor(options: OpenCodeAdapterOptions) {
    this.#client = new OpenCodeHttpClient(options);
    this.#compactionTimeoutMs = options.compactionTimeoutMs ?? compactionRequestTimeoutMs;
    this.#hostId = options.hostId;
    this.#directory = options.directory;
    this.#questionDirectories.add(options.directory);
    this.#now = options.now ?? (() => new Date());
    this.#activityReader = options.activityReader ?? (
      options.localActivity === undefined || options.localActivity === false
        ? disabledActivityReader
        : new SqliteOpenCodeActivityReader({ ...options.localActivity, now: options.localActivity.now ?? this.#now })
    );
    this.#sessionIndexReader = options.catalogueReader ?? (
      options.localActivity === undefined || options.localActivity === false
        ? disabledCatalogueReader
        : new SqliteOpenCodeSessionIndexReader({
            ...(options.localActivity.databasePath !== undefined ? { databasePath: options.localActivity.databasePath } : {}),
          })
    );
    this.#activityPollIntervalMs = options.activityPollIntervalMs ?? defaultActivitySafetyPollIntervalMs;
    this.#activityDiscoveryIntervalMs = options.activityDiscoveryIntervalMs ?? defaultActivityDiscoveryIntervalMs;
    this.#nativeStatusPollIntervalMs = options.nativeStatusPollIntervalMs ?? defaultNativeStatusPollIntervalMs;
    this.#activeTurnSettleMs = options.activeTurnSettleMs ?? 45_000;
    this.#secondaryActiveSeed = options.secondaryActiveSessionIds ?? [];
    this.#secondaryClientOptions = {
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.username !== undefined ? { username: options.username } : {}),
      ...(options.password !== undefined ? { password: options.password } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    };
    if (options.secondaryBaseUrl !== undefined) {
      this.#secondaryClient = new OpenCodeHttpClient({ ...this.#secondaryClientOptions, baseUrl: options.secondaryBaseUrl });
      this.#secondaryActive = new Set(this.#secondaryActiveSeed);
      this.ensureSecondaryLoop();
    } else {
      this.#secondaryClient = undefined;
    }
  }

  public async detect(): Promise<ProviderDetection> {
    const first = await this.probeDetection();
    if (first.available) {
      this.#everDetected = true;
      return first;
    }
    // One dropped probe must not read as "provider gone". A server that has
    // been detected before gets a single immediate second chance; servers that
    // never answered are not double-probed.
    if (!this.#everDetected) return first;
    const second = await this.probeDetection();
    if (second.available) return second;
    return first;
  }

  private async probeDetection(): Promise<ProviderDetection> {
    try {
      const health = await this.#client.request<unknown>("GET", "/global/health");
      const version = isRecord(health) && typeof health.version === "string" ? health.version : undefined;
      return {
        providerId: this.providerId,
        available: true,
        executable: this.#client.baseUrl,
        ...(version !== undefined ? { version } : {}),
        details: ["OpenCode server health endpoint responded."],
      };
    } catch (error) {
      return {
        providerId: this.providerId,
        available: false,
        executable: this.#client.baseUrl,
        details: [
          `No OpenCode server responded at ${this.#client.baseUrl}. The bridge defaults to port 4096 and does not launch or discover an OpenCode server; start one at this URL or set TETHOQ_OPENCODE_URL to the running server URL.`,
          error instanceof Error ? error.message : String(error),
        ],
      };
    }
  }

  public async getAuthStatus(): Promise<AuthStatus> {
    const value = await this.#client.request<unknown>("GET", "/provider", { query: this.query() });
    const connected = isRecord(value) && Array.isArray(value.connected) ? value.connected.filter((entry): entry is string => typeof entry === "string") : [];
    return {
      authenticated: connected.length > 0,
      canAuthenticate: false,
      ...(connected.length > 0 ? { accountLabel: connected.join(", ") } : {}),
      details: ["Provider credentials are managed by OpenCode on this host and are not read by Agent Bridge."],
    };
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    return capabilities;
  }

  public async listModels(): Promise<readonly RemoteModel[]> {
    const value = await this.#client.request<unknown>("GET", "/provider", { query: this.query() });
    const providers = isRecord(value) && Array.isArray(value.all) ? value.all : Array.isArray(value) ? value : [];
    const defaults = isRecord(value) && isRecord(value.default) ? value.default : {};
    const connected = isRecord(value) && Array.isArray(value.connected)
      ? new Set(value.connected.filter((entry): entry is string => typeof entry === "string"))
      : undefined;
    const result: RemoteModel[] = [];
    for (const providerValue of providers) {
      if (!isRecord(providerValue)) continue;
      const providerId = typeof providerValue.id === "string" ? providerValue.id : typeof providerValue.providerID === "string" ? providerValue.providerID : undefined;
      if (providerId === undefined) continue;
      if (connected !== undefined && !connected.has(providerId)) continue;
      const providerName = typeof providerValue.name === "string" ? providerValue.name : providerId;
      const models = isRecord(providerValue.models) ? Object.entries(providerValue.models) : [];
      for (const [modelKey, modelValue] of models) {
        const model = isRecord(modelValue) ? modelValue : {};
        const modelId = typeof model.id === "string" ? model.id : modelKey;
        const modalities = openCodeInputModalities(model);
        result.push({
          id: `${providerId}/${modelId}`,
          providerId: this.providerId,
          displayName: typeof model.name === "string" ? model.name : modelId,
          ...(typeof model.description === "string" ? { description: model.description } : {}),
          isDefault: defaults[providerId] === modelId,
          ...(modalities !== undefined ? { inputModalities: modalities } : {}),
          nativeMetadata: {
            ...asJsonObject(model),
            sourceProviderId: providerId,
            sourceProviderName: providerName,
            source: "OpenCode",
          },
        });
      }
    }
    this.#contextWindowTokensByModel.clear();
    for (const model of result) this.#contextWindowTokensByModel.set(model.id, openCodeContextWindow(model.nativeMetadata) ?? null);
    return result;
  }

  public async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    await this.awaitInitialActivitySnapshot();
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    if (options.cursor === undefined || isOpenCodeSessionIndexCursor(options.cursor)) {
      const indexed = await this.listSessionsFromLocalIndex(options, limit);
      if (indexed !== undefined) return indexed;
      if (options.cursor !== undefined) {
        throw new ProviderAdapterError(this.providerId, "BAD_CURSOR", "OpenCode local session index is unavailable for this cursor", true);
      }
    }
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) throw new ProviderAdapterError(this.providerId, "BAD_CURSOR", "OpenCode local pagination cursor is invalid", false);
    const snapshotLimit = Math.min(maxSessionListSnapshotEntries, Math.max(
      minimumSessionListSnapshotEntries,
      limit * sessionListSnapshotPrefetchPages,
      offset + limit,
    ));
    const snapshotKey = this.sessionListSnapshotKey(options);
    const snapshot = options.cursor === undefined
      ? await this.loadSessionListSnapshot(options, snapshotKey, snapshotLimit)
      : this.cachedSessionListSnapshot(snapshotKey) ?? await this.loadSessionListSnapshot(options, snapshotKey, snapshotLimit);
    const page = snapshot.sessions.slice(offset, offset + limit);
    const next = offset + page.length;
    if (next >= snapshot.sessions.length && this.#sessionListSnapshots.get(snapshotKey) === snapshot) {
      this.#sessionListSnapshots.delete(snapshotKey);
    }
    // `/session` has no older cursor. This fallback is deliberately
    // non-authoritative so a bounded response can enrich the catalogue without
    // deleting older tasks already known to Tethoq.
    return { sessions: page, nextCursor: next < snapshot.sessions.length ? String(next) : null, authoritative: false };
  }

  private async listSessionsFromLocalIndex(
    options: ListSessionsOptions,
    limit: number,
  ): Promise<PaginatedSessions | undefined> {
    let indexed;
    try {
      indexed = await this.#sessionIndexReader.readPage({ ...options, limit });
    } catch (error) {
      if (options.cursor !== undefined) {
        throw new ProviderAdapterError(
          this.providerId,
          "BAD_CURSOR",
          error instanceof Error ? error.message : "OpenCode SQLite session cursor is invalid",
          false,
        );
      }
      return undefined;
    }
    if (indexed === undefined) return undefined;
    const statusSnapshot = await this.sessionStatuses().catch((): undefined => undefined);
    if (statusSnapshot !== undefined) await this.reconcileNativeStatusSnapshot(statusSnapshot);
    const sessions = indexed.entries.map((entry) => {
      const id = entry.id;
      const session = normalizeOpenCodeSession(this.#hostId, entry, this.resolvedStatus(id, this.#nativeStatuses.get(id) ?? this.#nativeStates.get(id), this.#persistedWorking));
      const state = this.activityDerivedState(id, session.state);
      return state === session.state ? session : { ...session, state };
    });
    return { sessions, nextCursor: indexed.nextCursor, authoritative: true };
  }

  /**
   * OpenCode partitions sessions by project, and `GET /session` only ever
   * answers for one of them: without `directory` it reports whichever project
   * the server's own working directory resolves to, and every other project is
   * reachable solely by passing its worktree. So a plain list silently hides
   * every session outside that one project -- which is how a workspace full of
   * OpenCode sessions can show up empty. Walking `/project` is the only way to
   * see the rest. Individual sessions have no such problem: `/session/{id}` and
   * its message history answer identically with or without the parameter, so
   * only the listing needs to fan out.
   *
   * Sessions the server files under the catch-all "global" project stay out of
   * reach unless its worktree is a real path: `directory=/` matches nothing,
   * and no endpoint lists sessions by project id.
   */
  private async listSessionsAcrossProjects(limit: number): Promise<readonly unknown[]> {
    const [primary, ...rest] = await this.sessionListDirectories();
    // The primary listing still throws. A server that is down has to surface as
    // a failed refresh, because an empty list reads as "this provider has no
    // sessions" and would drop every cached session for it.
    const pages = [await this.fetchSessionList(primary, limit)];
    // Supplementary projects are best-effort: one unreadable workspace must not
    // blank out the others.
    pages.push(...await Promise.all(rest.map(async (directory) => await this.fetchSessionList(directory, limit).catch((): readonly unknown[] => []))));
    const merged: unknown[] = [];
    const seen = new Set<string>();
    for (const page of pages) {
      for (const entry of page) {
        const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        merged.push(entry);
      }
    }
    return merged;
  }

  /** `undefined` means the unscoped list, which OpenCode answers with the global project. */
  private async sessionListDirectories(signal?: AbortSignal): Promise<readonly (string | undefined)[]> {
    // A pinned directory is an explicit scope from the host; honour it verbatim.
    if (this.#directory !== undefined) return [this.#directory];
    try {
      const value = await this.#client.request<unknown>("GET", "/project", { ...(signal === undefined ? {} : { signal }) });
      const worktrees = (Array.isArray(value) ? value : [])
        .map((entry) => (isRecord(entry) && typeof entry.worktree === "string" ? entry.worktree : undefined))
        .filter((worktree): worktree is string => worktree !== undefined && worktree !== "" && worktree !== "/");
      return [undefined, ...new Set(worktrees)];
    } catch {
      // Servers without /project still answer the unscoped list correctly, so
      // degrade to it instead of failing the whole refresh.
      return [undefined];
    }
  }

  private async fetchSessionList(directory: string | undefined, limit: number): Promise<readonly unknown[]> {
    const value = await this.#client.request<unknown>("GET", "/session", {
      query: { directory, limit },
    });
    // Old servers and test doubles can ignore `limit`; never retain their full
    // response as continuation state.
    return Array.isArray(value) ? value.slice(0, limit) : [];
  }

  private async fetchChildSessionList(parentProviderSessionId: string, directory: string | undefined, limit: number): Promise<readonly unknown[]> {
    const value = await this.#client.request<unknown>(
      "GET",
      `/session/${encodeURIComponent(parentProviderSessionId)}/children`,
      { query: this.query(directory) },
    );
    return Array.isArray(value) ? value.slice(0, limit) : [];
  }

  private async loadSessionListSnapshot(
    options: ListSessionsOptions,
    snapshotKey: string,
    snapshotLimit: number,
    retryOnInvalidation = options.cursor === undefined,
  ): Promise<SessionListSnapshot> {
    const generation = this.#sessionListSnapshotGeneration;
    const directory = options.workingDirectory ?? this.#directory;
    const listing = options.parentProviderSessionId === undefined
      ? options.workingDirectory === undefined
        ? this.listSessionsAcrossProjects(snapshotLimit)
        : this.fetchSessionList(options.workingDirectory, snapshotLimit)
      : this.fetchChildSessionList(options.parentProviderSessionId, directory, snapshotLimit).catch(async () => (
          options.workingDirectory === undefined
            ? await this.listSessionsAcrossProjects(snapshotLimit)
            : await this.fetchSessionList(options.workingDirectory, snapshotLimit)
        ));
    const [all, statusSnapshot] = await Promise.all([
      listing,
      this.sessionStatuses().catch((): undefined => undefined),
    ]);
    // A live event can clear or replace provider status while these independent
    // reads are in flight. A cursorless refresh is the authority for the page it
    // returns, so repeat that native read once instead of returning the snapshot
    // the event already invalidated. Cursor continuations keep their established
    // single-snapshot behavior, and a second invalidation never creates a loop.
    if (retryOnInvalidation && generation !== this.#sessionListSnapshotGeneration) {
      return await this.loadSessionListSnapshot(options, snapshotKey, snapshotLimit, false);
    }
    if (statusSnapshot !== undefined) await this.reconcileNativeStatusSnapshot(statusSnapshot);
    const filtered = all.filter((entry) => isRecord(entry)
      && (options.workingDirectory === undefined || entry.directory === options.workingDirectory)
      && (options.parentProviderSessionId === undefined || entry.parentID === options.parentProviderSessionId));
    const sessions = filtered.map((entry) => {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "";
      const session = normalizeOpenCodeSession(this.#hostId, entry, this.resolvedStatus(id, this.#nativeStatuses.get(id) ?? this.#nativeStates.get(id), this.#persistedWorking));
      // OpenCode listings carry no session state, so an unknown answer is the
      // normal case rather than a gap. Report the adapter's own truth instead:
      // working only while a turn is genuinely in flight, idle otherwise. This
      // is what lets a finished turn settle instead of shimmering forever.
      const state = this.activityDerivedState(id, session.state);
      return Object.freeze({ ...session, state });
    });
    const sortKey = options.sortKey ?? "updated_at";
    const direction = options.sortDirection === "asc" ? 1 : -1;
    sessions.sort((left, right) => {
      const leftValue = Date.parse(sortKey === "created_at" ? left.createdAt ?? left.lastActivityAt : left.lastActivityAt);
      const rightValue = Date.parse(sortKey === "created_at" ? right.createdAt ?? right.lastActivityAt : right.lastActivityAt);
      const byTime = (leftValue - rightValue) * direction;
      return byTime !== 0 ? byTime : left.providerSessionId.localeCompare(right.providerSessionId);
    });
    const retained = Object.freeze(sessions.slice(0, snapshotLimit));
    const snapshot: SessionListSnapshot = { sessions: retained, expiresAt: this.#now().getTime() + sessionListSnapshotTtlMs };
    if (generation === this.#sessionListSnapshotGeneration) {
      this.#sessionListSnapshots.delete(snapshotKey);
      this.#sessionListSnapshots.set(snapshotKey, snapshot);
      while (this.#sessionListSnapshots.size > maxSessionListSnapshots) {
        const oldest = this.#sessionListSnapshots.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#sessionListSnapshots.delete(oldest);
      }
    }
    return snapshot;
  }

  private cachedSessionListSnapshot(snapshotKey: string): SessionListSnapshot | undefined {
    const snapshot = this.#sessionListSnapshots.get(snapshotKey);
    if (snapshot === undefined) return undefined;
    if (snapshot.expiresAt <= this.#now().getTime()) {
      this.#sessionListSnapshots.delete(snapshotKey);
      return undefined;
    }
    this.#sessionListSnapshots.delete(snapshotKey);
    this.#sessionListSnapshots.set(snapshotKey, snapshot);
    return snapshot;
  }

  private sessionListSnapshotKey(options: ListSessionsOptions): string {
    return JSON.stringify([
      options.workingDirectory ?? null,
      options.parentProviderSessionId ?? null,
      options.sortKey ?? "updated_at",
      options.sortDirection ?? "desc",
    ]);
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    if (this.#applyingPersistedWorking === undefined) await this.awaitInitialActivitySnapshot();
    const persistedWorking = this.#applyingPersistedWorking ?? this.#persistedWorking;
    const [session, statusSnapshot] = await Promise.all([
      this.#client.request<unknown>("GET", `/session/${encodeURIComponent(providerSessionId)}`, { query: this.query() }),
      this.sessionStatuses().catch((): undefined => undefined),
    ]);
    if (this.#eventLoop !== null && isRecord(session) && typeof session.directory === "string") {
      this.#questionDirectories.add(session.directory);
      void this.recoverPendingQuestions("primary", session.directory);
    }
    if (statusSnapshot !== undefined) await this.reconcileNativeStatusSnapshot(statusSnapshot);
    const normalized = normalizeOpenCodeSession(this.#hostId, session, this.resolvedStatus(
      providerSessionId,
      this.#nativeStatuses.get(providerSessionId) ?? this.#nativeStates.get(providerSessionId),
      persistedWorking,
    ));
    const state = this.activityDerivedState(providerSessionId, normalized.state);
    return state === normalized.state ? normalized : { ...normalized, state };
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const value = await this.rawMessages(providerSessionId);
    if (Array.isArray(value)) {
      let latestSelectionInfo: Record<string, unknown> | undefined;
      let latestSelection: OpenCodeMessageSelection | undefined;
      for (const entry of value) {
        const info = isRecord(entry) && isRecord(entry.info) ? entry.info : isRecord(entry) ? entry : undefined;
        if (info === undefined) continue;
        const selection = openCodeMessageSelection(info);
        if (selection === undefined) continue;
        const isNewer = latestSelection === undefined
          || (selection.messageCreatedAt !== undefined && latestSelection.messageCreatedAt === undefined)
          || (selection.messageCreatedAt !== undefined && latestSelection.messageCreatedAt !== undefined
            && selection.messageCreatedAt >= latestSelection.messageCreatedAt)
          || (selection.messageCreatedAt === undefined && latestSelection.messageCreatedAt === undefined);
        if (isNewer) {
          latestSelectionInfo = info;
          latestSelection = selection;
        }
      }
      if (latestSelectionInfo !== undefined) {
        await this.publishReportedSelection(providerSessionId, latestSelectionInfo, { source: "history" });
      }
    }
    return normalizeOpenCodeMessages(this.#hostId, providerSessionId, value);
  }

  public async getSessionContext(providerSessionId: string): Promise<Omit<SessionContextState, "sessionId" | "compactionThresholdTokens" | "minimumThresholdTokens" | "supportsThreshold" | "isCompacting" | "compactionKind">> {
    const value = await this.rawMessages(providerSessionId);
    const entries = Array.isArray(value) ? value : [];
    const assistants = entries
      .map((entry) => isRecord(entry) && isRecord(entry.info) ? entry.info : isRecord(entry) ? entry : null)
      .filter((info): info is Record<string, unknown> => info !== null && info.role === "assistant");
    const latest = assistants.at(-1);
    const totals = assistants.reduce((sum, info) => addOpenCodeUsage(sum, info), emptyOpenCodeUsage());
    // Occupancy is the last turn's input + cache + output, but the last assistant
    // entry does not always carry one: an interrupted turn, a failed request, or a
    // synthetic trailing entry records no tokens at all. Reading that entry alone
    // reported a conversation of real size as literally zero tokens in context —
    // a full-width empty gauge at 0% on a task with a transcript. Nothing left the
    // context when a turn failed to record its usage, so the reading belongs to
    // the most recent turn that actually stated one.
    const occupancy = assistants.filter((info) => openCodeOccupancy(addOpenCodeUsage(emptyOpenCodeUsage(), info)) > 0).at(-1);
    const current = occupancy === undefined ? emptyOpenCodeUsage() : addOpenCodeUsage(emptyOpenCodeUsage(), occupancy);
    const providerId = latest === undefined ? undefined : firstText(latest.providerID, isRecord(latest.model) ? latest.model.providerID : undefined);
    const nativeModelId = latest === undefined ? undefined : firstText(latest.modelID, isRecord(latest.model) ? latest.model.modelID ?? latest.model.id : undefined);
    const modelId = providerId !== undefined && nativeModelId !== undefined ? `${providerId}/${nativeModelId}` : nativeModelId;
    if (modelId !== undefined && !this.#contextWindowTokensByModel.has(modelId)) await this.listModels().catch((): readonly RemoteModel[] => []);
    const cachedContextWindowTokens = modelId === undefined ? undefined : this.#contextWindowTokensByModel.get(modelId);
    const contextWindowTokens = typeof cachedContextWindowTokens === "number" ? cachedContextWindowTokens : undefined;
    const usedTokens = openCodeOccupancy(current);
    // No turn in the whole session stated a usage: the occupancy is unknown, which
    // is not the same claim as empty. Saying nothing is the honest answer; saying
    // zero draws a gauge that reads as a fact.
    const knownUsage = occupancy !== undefined;
    return {
      ...(modelId !== undefined ? { modelId } : {}),
      usedTokens: knownUsage ? usedTokens : null,
      contextWindowTokens: contextWindowTokens ?? null,
      usedPercent: contextWindowTokens !== undefined && contextWindowTokens > 0 && knownUsage
        ? Math.max(0, Math.min(100, usedTokens / contextWindowTokens * 100))
        : null,
      supportsManualCompaction: latest !== undefined && providerId !== undefined && nativeModelId !== undefined,
      updatedAt: this.#now().toISOString(),
      usage: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        totalTokens: totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
        cost: totals.cost,
        currency: "USD",
      },
    };
  }

  public async compactSession(providerSessionId: string): Promise<void> {
    const existing = this.#compactions.get(providerSessionId);
    if (existing !== undefined) return await existing;
    const pending = Promise.resolve().then(() => this.performCompaction(providerSessionId)).finally(() => {
      this.#compactions.delete(providerSessionId);
    });
    this.#compactions.set(providerSessionId, pending);
    return await pending;
  }

  private async performCompaction(providerSessionId: string): Promise<void> {
    const timeoutMs = this.#compactionTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(timeoutMs)]);
    const value = await this.rawMessages(providerSessionId, 500, signal);
    const entries = Array.isArray(value) ? value : [];
    const latest = entries
      .map((entry) => isRecord(entry) && isRecord(entry.info) ? entry.info : isRecord(entry) ? entry : null)
      .filter((info): info is Record<string, unknown> => info !== null)
      .reverse()
      .find((info) => firstText(info.providerID, isRecord(info.model) ? info.model.providerID : undefined) !== undefined
        && firstText(info.modelID, isRecord(info.model) ? info.model.modelID ?? info.model.id : undefined) !== undefined);
    const providerID = latest === undefined ? undefined : firstText(latest.providerID, isRecord(latest.model) ? latest.model.providerID : undefined);
    const modelID = latest === undefined ? undefined : firstText(latest.modelID, isRecord(latest.model) ? latest.model.modelID ?? latest.model.id : undefined);
    if (providerID === undefined || modelID === undefined) throw new Error("OpenCode has not selected a model for this session yet");
    const previousMarkers = openCodeCompactionMarkerIds(entries);
    const requestAbort = new AbortController();
    let requestOutcome: { readonly kind: "completed" } | { readonly kind: "failed"; readonly error: unknown } | undefined;
    const request = this.#client.request("POST", `/session/${encodeURIComponent(providerSessionId)}/summarize`, {
      query: this.query(),
      body: { providerID, modelID },
      signal: AbortSignal.any([requestAbort.signal, signal]),
      timeoutMs,
    }).then(() => {
      requestOutcome = { kind: "completed" };
      this.signalCompactionLifecycle(providerSessionId);
    }, (error: unknown) => {
      requestOutcome = { kind: "failed", error };
      this.signalCompactionLifecycle(providerSessionId);
    });
    try {
      while (!signal.aborted) {
        const recent = await this.rawMessages(providerSessionId, 20, signal);
        if (Array.isArray(recent)) {
          const newMarkers = openCodeCompactionMarkerIds(recent, previousMarkers);
          const outcome = openCodeCompactionOutcome(recent, newMarkers);
          if (outcome === "completed") return;
          if (outcome === "failed") throw new ProviderAdapterError(
            "opencode", "COMPACTION_FAILED", "OpenCode compaction failed or was interrupted", true,
          );
        }
        // HTTP success only accepts the request. Require a new, parent-linked
        // completed summary, including when the marker appears after the ack.
        if (requestOutcome?.kind === "failed") throw requestOutcome.error;
        await this.waitForCompactionLifecycle(providerSessionId, Math.max(0, Math.min(compactionCompletionPollIntervalMs, deadline - Date.now())));
      }
      throw new ProviderAdapterError("opencode", "COMPACTION_INCOMPLETE", "OpenCode compaction completion was not confirmed before timeout or disconnection", true);
    } finally {
      requestAbort.abort(new Error("OpenCode compaction lifecycle finished"));
      await request;
    }
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    let directory = options.workingDirectory;
    if (options.metadata?.internalPurpose === "vision_proxy") {
      // MCP/plugin processes belong to the server workspace, not to each chat.
      // Reuse it instead of starting another stack in the parent's directory.
      if (this.#directory !== undefined) directory = this.#directory;
      else {
        const paths = await this.#client.request<unknown>("GET", "/path");
        if (!isRecord(paths) || typeof paths.directory !== "string" || !paths.directory) {
          throw new ProviderAdapterError(this.providerId, "VISION_ISOLATION_UNAVAILABLE", "OpenCode could not resolve its existing EYES workspace", false);
        }
        directory = paths.directory;
      }
    }
    const value = await this.#client.request<unknown>("POST", "/session", {
      query: this.query(directory),
      body: {
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.metadata?.internalPurpose === "vision_proxy"
          ? { permission: [{ permission: "*", pattern: "*", action: "deny" }] } : {}),
      },
    });
    const session = normalizeOpenCodeSession(this.#hostId, value);
    if (options.metadata?.internalPurpose === "vision_proxy") this.#visionSessions.add(session.providerSessionId);
    if (options.firstInstruction !== undefined) {
      await this.sendMessage(session.providerSessionId, {
        requestId: `create_${randomUUID()}`,
        content: options.firstInstruction,
        ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });
    }
    return session;
  }

  public async branchSession(providerSessionId: string): Promise<RemoteSession> {
    return await this.withSessionLifecycleLock(providerSessionId, async () => {
      const history = await this.rawMessages(providerSessionId);
      if (!Array.isArray(history)) {
        throw new ProviderAdapterError(
          "opencode",
          "BRANCH_HISTORY_UNAVAILABLE",
          "OpenCode history is unavailable, so Tethoq cannot choose a safe branch point",
          true,
        );
      }
      const branchBody = completedOpenCodeBranchBody(history);
      if (history.length > 0 && branchBody === undefined) {
        throw new ProviderAdapterError(
          "opencode",
          "NO_COMPLETED_BRANCH_BOUNDARY",
          "OpenCode does not expose a completed response boundary that is safe to branch from yet",
          true,
        );
      }
      const value = await this.#client.request<unknown>("POST", `/session/${encodeURIComponent(providerSessionId)}/fork`, {
        query: this.query(),
        body: branchBody ?? {},
      });
      return normalizeOpenCodeSession(this.#hostId, value);
    });
  }

  public async resumeSession(providerSessionId: string): Promise<void> {
    await this.getSession(providerSessionId);
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return await this.withSessionLifecycleLock(providerSessionId, async () => {
      if (request.metadata?.internalPurpose === "vision_proxy") this.#visionSessions.add(providerSessionId);
      const model = request.modelId === undefined ? undefined : parseModel(request.modelId);
      const messageID = openCodeMessageId(request.requestId);
      if (typeof request.metadata?.tethoqScheduledTaskId === "string") {
        let existing: unknown;
        try {
          existing = await this.#client.request<unknown>(
            "GET",
            `/session/${encodeURIComponent(providerSessionId)}/message/${encodeURIComponent(messageID)}`,
            { query: this.query() },
          );
        } catch (error) {
          if (!(error instanceof ProviderAdapterError) || error.code !== "HTTP_404") throw error;
        }
        if (existing !== undefined) {
          const info = isRecord(existing) && isRecord(existing.info) ? existing.info : undefined;
          if (info?.id !== messageID || info.role !== "user") {
            throw new ProviderAdapterError(
              "opencode",
              "INVALID_SCHEDULED_MESSAGE_LOOKUP",
              "OpenCode returned an invalid scheduled-message lookup",
              true,
            );
          }
          return { accepted: true, providerTurnId: messageID, details: ["OpenCode already accepted this scheduled prompt."] };
        }
      }
      const attachments = await this.preparePromptAttachments(request.modelId, request.attachments);
      const previousPromptId = this.#activePromptMessageIds.get(providerSessionId);
      const wasActive = this.#activePrompts.has(providerSessionId);
      const guard = this.#guardAbortGenerations.get(providerSessionId);
      if (guard?.outcome === "confirmed") {
        guard.successorMessageId = messageID;
        this.#guardActivityEpoch += 1;
      }
      const terminalCleanup = this.#terminalCleanupGenerations.get(providerSessionId);
      if (terminalCleanup !== undefined) {
        terminalCleanup.successorMessageId = messageID;
        this.#guardActivityEpoch += 1;
      }
      // The SSE feed can publish an idle while prompt_async is still returning.
      // Mark ownership first so that unlabelled lifecycle noise cannot complete or
      // pump the queue for a turn whose model has not produced anything yet.
      this.#settledOwnedSessions.delete(providerSessionId);
      this.cancelPendingOwnedCompletion(providerSessionId);
      this.#emptyUnknownSequences.delete(providerSessionId);
      this.#activePrompts.add(providerSessionId);
      this.#activePromptMessageIds.set(providerSessionId, messageID);
      try {
        await this.#client.request("POST", `/session/${encodeURIComponent(providerSessionId)}/prompt_async`, {
          query: this.query(),
          body: {
            messageID,
            parts: [
              { type: "text", text: providerPromptContent({
                content: request.content,
                ...(request.workflows !== undefined ? { workflows: request.workflows } : {}),
              }), ...(isProviderContinuationContent(request.content) ? { synthetic: true } : {}) },
              ...attachments.map((attachment) => ({
                type: "file",
                mime: attachment.mimeType,
                filename: attachment.name,
                url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
              })),
            ],
            ...(request.developerInstructions !== undefined ? { system: request.developerInstructions } : {}),
            tools: openCodeTurnToolOverrides(request, this.#visionSessions.has(providerSessionId)),
            ...(model !== undefined ? { model } : {}),
            // OpenCode exposes reasoning choices as model variants. The desktop
            // deliberately passes one of those advertised keys, so preserve it
            // verbatim instead of silently running the model's undefined default.
            ...(request.reasoningEffort !== undefined && request.reasoningEffort !== "default"
              ? { variant: request.reasoningEffort }
              : {}),
          },
        });
      } catch (error) {
        let providerObservedPrompt = this.#messageRoles.get(messageID) === "user";
        if (!providerObservedPrompt) {
          try {
            const persisted = await this.#client.request<unknown>(
              "GET",
              `/session/${encodeURIComponent(providerSessionId)}/message/${encodeURIComponent(messageID)}`,
              { query: this.query() },
            );
            const info = isRecord(persisted) && isRecord(persisted.info) ? persisted.info : undefined;
            providerObservedPrompt = info?.id === messageID && info.role === "user";
            if (providerObservedPrompt && isRecord(persisted)) this.rememberMessageRole(persisted);
          } catch {
            // This read only resolves an ambiguous write. Preserve the original
            // prompt failure when native history cannot prove acceptance.
          }
        }
        if (!providerObservedPrompt && this.#activePromptMessageIds.get(providerSessionId) === messageID) {
          if (previousPromptId === undefined) this.#activePromptMessageIds.delete(providerSessionId);
          else this.#activePromptMessageIds.set(providerSessionId, previousPromptId);
          if (!wasActive) this.#activePrompts.delete(providerSessionId);
        }
        if (!providerObservedPrompt && this.#guardAbortGenerations.get(providerSessionId) === guard
          && guard?.successorMessageId === messageID) {
          guard.successorMessageId = undefined;
          this.#guardActivityEpoch += 1;
        }
        if (!providerObservedPrompt && this.#terminalCleanupGenerations.get(providerSessionId) === terminalCleanup
          && terminalCleanup?.successorMessageId === messageID) {
          terminalCleanup.successorMessageId = undefined;
          this.#guardActivityEpoch += 1;
        }
        // prompt_async can lose its HTTP response after the provider has already
        // persisted the exact user message, even before SSE echoes it. Retrying
        // or rolling back the optimistic row would misrepresent that accepted turn.
        if (providerObservedPrompt) {
          return { accepted: true, providerTurnId: messageID, details: ["OpenCode accepted the asynchronous prompt before its response disconnected."] };
        }
        throw error;
      }
      return { accepted: true, providerTurnId: messageID, details: ["OpenCode accepted the asynchronous prompt."] };
    });
  }

  /**
   * OpenCode accepts another prompt while the session runner is active. Its
   * running loop observes the newly persisted user message at the next safe
   * boundary, which is the same live-follow-up behavior exposed by OpenCode's
   * own client. Keep it on the ordinary prompt path so the provider owns the
   * message before Tethoq reports the queued instruction as delivered.
   */
  public async steerMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return await this.sendMessage(providerSessionId, request);
  }

  public hasActiveTurn(providerSessionId: string): boolean {
    if (this.#primaryEventStreamDisconnected || this.#disconnectedActiveSessionIds.has(providerSessionId)) return false;
    if (this.isSettledOwnedSession(providerSessionId)) return false;
    if (this.#activePrompts.has(providerSessionId) || this.#persistedWorking.has(providerSessionId)) return true;
    return this.#nativeStates.get(providerSessionId) === "working";
  }

  public activeSessionIds(options: { readonly includeDisconnected?: boolean } = {}): readonly string[] {
    if (options.includeDisconnected) return [...new Set([...this.knownActiveSessionIds(), ...this.#disconnectedActiveSessionIds])];
    if (this.#primaryEventStreamDisconnected) return [];
    return [...this.knownActiveSessionIds()].filter((sessionId) => !this.#disconnectedActiveSessionIds.has(sessionId));
  }

  public isSecondaryBusy(): boolean {
    return this.#secondaryActive.size > 0;
  }

  public setSecondaryBaseUrl(url: string | undefined): void {
    if (url === undefined) {
      this.#secondaryAbort.abort();
      this.#secondaryLoop?.catch(() => undefined);
      this.#secondaryLoop = null;
      this.#secondaryActive = new Set();
      return;
    }
    if (this.#secondaryClient?.baseUrl === url) return;
    this.#secondaryAbort = new AbortController();
    this.#secondaryActive = new Set(this.#secondaryActiveSeed);
    if (this.#secondaryClient === undefined) {
      this.#secondaryClient = new OpenCodeHttpClient({ ...this.#secondaryClientOptions, baseUrl: url });
    }
    this.ensureSecondaryLoop();
  }

  public async interrupt(providerSessionId: string): Promise<void> {
    let interruption: Promise<void> | undefined;
    await this.withSessionLifecycleLock(providerSessionId, async () => {
      this.retireGuardGeneration(providerSessionId);
      const retained = this.#terminalCleanupGenerations.get(providerSessionId);
      // A completed manual stop remains the authority until a genuinely new
      // prompt owns the session. Repeated Stop requests must not replace that
      // cleanup generation and issue another session-wide abort.
      if (retained?.kind === "interrupted" && !this.hasActiveTurn(providerSessionId)) {
        interruption = retained.interruption;
        return;
      }
      const parentId = this.#activePromptMessageIds.get(providerSessionId);
      const generation = this.rememberTerminalCleanupGeneration(providerSessionId, "interrupted", parentId);
      let aborted = false;
      let abortError: unknown;
      try {
        await this.#client.request("POST", `/session/${encodeURIComponent(providerSessionId)}/abort`, { query: this.query() });
        aborted = true;
      } catch (error) {
        abortError = error;
      }
      if (this.#terminalCleanupGenerations.get(providerSessionId) !== generation) {
        if (!aborted && abortError !== undefined) throw abortError;
        return;
      }
      if (!aborted && !generation.cleanupObserved) {
        await this.waitForTerminalCleanupGeneration(providerSessionId, generation);
      }
      if (this.#terminalCleanupGenerations.get(providerSessionId) !== generation) {
        if (!aborted && abortError !== undefined) throw abortError;
        return;
      }
      if (!aborted && !generation.cleanupObserved) {
        this.retireTerminalCleanupGeneration(providerSessionId, generation);
        throw abortError;
      }
      interruption = this.beginManualInterruption(providerSessionId, generation);
    });
    await interruption;
  }

  public async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    const subscription = this.#events.subscribe(providerSessionId, sink);
    const pendingQuestions = [...this.#questions.entries()];
    this.ensureEventLoop();
    for (const [providerRequestId, pending] of pendingQuestions) {
      if ((providerSessionId !== null && providerSessionId !== pending.sessionId) || this.#questions.get(providerRequestId) !== pending) continue;
      await sink({
        eventId: `opencode_event_${this.#eventNamespace}_${++this.#eventCounter}`,
        providerId: this.providerId, providerSessionId: pending.sessionId,
        type: "user_input.requested", occurredAt: this.#now().toISOString(), payload: pending.payload,
      });
    }
    return subscription;
  }

  public async respondToApproval(response: ProviderApprovalResponse): Promise<void> {
    const pending = this.#permissions.get(response.providerRequestId);
    if (pending === undefined) throw new ProviderAdapterError(this.providerId, "APPROVAL_NOT_FOUND", "OpenCode permission request is stale or unknown", false);
    if (response.choiceId !== "approve" && response.choiceId !== "reject") throw new ProviderAdapterError(this.providerId, "APPROVAL_CHOICE_INVALID", "Only approve once and reject are exposed", false);
    await this.#client.request("POST", `/session/${encodeURIComponent(pending.sessionId)}/permissions/${encodeURIComponent(pending.nativePermissionId)}`, {
      query: this.query(),
      body: { response: response.choiceId === "approve" ? "once" : "reject" },
    });
    this.#permissions.delete(response.providerRequestId);
  }

  public async respondToUserInput(response: ProviderUserInputResponse): Promise<void> {
    const pending = this.#questions.get(response.providerRequestId);
    if (pending === undefined || pending.resolving) {
      throw new ProviderAdapterError(this.providerId, "USER_INPUT_NOT_FOUND", "OpenCode question is stale or already being answered", false);
    }
    const answers = pending.questions.map((question) => openCodeQuestionAnswer(question, response.answers));
    const client = pending.source === "secondary" ? this.#secondaryClient : this.#client;
    if (client === undefined) throw new ProviderAdapterError(this.providerId, "USER_INPUT_NOT_FOUND", "The OpenCode server that asked this question is no longer connected", false);
    pending.resolving = true;
    try {
      await client.request("POST", `/question/${encodeURIComponent(pending.nativeRequestId)}/reply`, {
        query: this.query(pending.directory),
        body: { answers },
      });
    } catch (error) {
      pending.resolving = false;
      throw error;
    }
    // The server can publish its reply before the HTTP response arrives.
    if (this.#questions.get(response.providerRequestId) === pending) {
      this.#questionRevision += 1;
      await this.resolveQuestion(response.providerRequestId, pending.sessionId, "answered");
    }
  }

  public async getSessionPermissions(providerSessionId: string): Promise<ProviderSessionPermissions> {
    const session = await this.#client.request<unknown>("GET", `/session/${encodeURIComponent(providerSessionId)}`, { query: this.query() });
    return openCodeSessionPermissions(session, providerSessionId);
  }

  public async setSessionPermission(providerSessionId: string, controlId: string, value: string): Promise<ProviderSessionPermissions> {
    if (controlId !== "tool_permissions" || (value !== "ask" && value !== "allow" && value !== "deny")) {
      throw new ProviderAdapterError(this.providerId, "PERMISSION_VALUE_INVALID", "Choose Ask, Allow, or Deny for this task's tools", false);
    }
    const path = `/session/${encodeURIComponent(providerSessionId)}`;
    const current = await this.#client.request<unknown>("GET", path, { query: this.query() });
    openCodeSessionPermissions(current, providerSessionId);
    const directory = isRecord(current) && typeof current.directory === "string" ? current.directory : this.#directory;
    // OpenCode 1.18.21 appends these rules; the last matching rule wins.
    // Sending only the new override retains existing provider-managed rules.
    const updated = await this.#client.request<unknown>("PATCH", path, {
      query: this.query(directory),
      body: { permission: [{ permission: "*", pattern: "*", action: value }] },
    });
    return openCodeSessionPermissions(updated, providerSessionId);
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#activityChangeDebounce !== undefined) clearTimeout(this.#activityChangeDebounce);
    this.#activityChangeDebounce = undefined;
    this.#stopActivityChangeWatch?.();
    this.#stopActivityChangeWatch = undefined;
    this.#abort.abort();
    this.#secondaryAbort.abort();
    await Promise.all([
      this.#eventLoop?.catch(() => undefined),
      this.#secondaryLoop?.catch(() => undefined),
      this.#activityLoop?.catch(() => undefined),
      this.#nativeStatusLoop?.catch(() => undefined),
      this.#nativeStatusReconcileTail.catch(() => undefined),
      this.#initialActivitySnapshot?.catch(() => undefined),
      this.#questionDiscovery,
      ...this.#questionRecoveries.values(),
      ...[...this.#primaryReconnectRefreshes].map(async (refresh) => await refresh.catch(() => undefined)),
    ]);
    this.#activityReader.close();
    this.#sessionIndexReader.close();
    this.#activeSettleDeadlines.clear();
    this.#sessionListSnapshots.clear();
    this.#partTexts.clear();
    this.#partTypes.clear();
    this.#messageRoles.clear();
    this.#reportedSelections.clear();
    this.#permissions.clear();
    this.#questions.clear();
    this.#questionDirectories.clear();
    this.#questionRecoveries.clear();
    this.#nativeStates.clear();
    this.#nativeStatuses.clear();
    this.#nativeEventRevisionBySession.clear();
    this.#disconnectedActiveSessionIds.clear();
    this.#disconnectedNativeSessionIds.clear();
    this.#disconnectedPersistedSessionIds.clear();
    this.#primaryReconnectRefreshes.clear();
    this.#activePromptMessageIds.clear();
    this.#continuingToolMessageIds.clear();
    this.#terminalPromptCandidates.clear();
    this.#runawayPromptParents.clear();
    this.#emptyUnknownSequences.clear();
    this.#suppressedMessageIds.clear();
    for (const generation of this.#terminalCleanupGenerations.values()) generation.resolveCleanupObserved();
    this.#terminalCleanupGenerations.clear();
    for (const waiters of this.#compactionLifecycleWaiters.values()) for (const wake of waiters) wake();
    this.#compactionLifecycleWaiters.clear();
    this.#guardAbortGenerations.clear();
    for (const sessionId of this.#pendingOwnedIdles.keys()) this.clearPendingOwnedIdle(sessionId);
    this.#sessionLifecycleTails.clear();
    this.#events.clear();
  }

  private query(directory = this.#directory): Readonly<Record<string, string | undefined>> {
    return { directory };
  }

  private discoverPendingQuestions(): void {
    if (this.#disposed || this.#questionDiscovery !== undefined) return;
    this.#nextQuestionRecoveryAt = this.#now().getTime() + questionRecoveryIntervalMs;
    const discovery = (async () => {
      const initial = this.recoverPendingQuestions("primary", this.#directory);
      const directories = await this.sessionListDirectories(this.#abort.signal);
      if (this.#disposed) return;
      for (const directory of directories) this.#questionDirectories.add(directory);
      await Promise.all([initial, ...[...this.#questionDirectories].flatMap((directory) => [
        this.recoverPendingQuestions("primary", directory),
        ...(this.#secondaryClient === undefined ? [] : [this.recoverPendingQuestions("secondary", directory)]),
      ])]);
    })().catch(() => undefined);
    this.#questionDiscovery = discovery;
    void discovery.finally(() => {
      if (this.#questionDiscovery === discovery) this.#questionDiscovery = undefined;
    });
  }

  private recoverPendingQuestions(source: "primary" | "secondary", directory = this.#directory): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const client = source === "secondary" ? this.#secondaryClient : this.#client;
    if (client === undefined) return Promise.resolve();
    const key = JSON.stringify([source, directory ?? null]);
    const existing = this.#questionRecoveries.get(key);
    if (existing !== undefined) return existing;
    const revision = this.#questionRevision;
    const connection = this.#primaryConnectionGeneration;
    const refresh = (async () => {
      const value = await client.request<unknown>("GET", "/question", {
        query: this.query(directory),
        signal: source === "secondary" ? this.#secondaryAbort.signal : this.#abort.signal,
        timeoutMs: nativeStatusRequestTimeoutMs,
      });
      if (this.#disposed || revision !== this.#questionRevision || !Array.isArray(value)
        || (source === "primary" && connection !== this.#primaryConnectionGeneration)) return;
      const present = new Set<string>();
      for (const request of value) {
        if (revision !== this.#questionRevision) return;
        if (!isRecord(request) || typeof request.id !== "string") continue;
        present.add(`opencode_question_${request.id}`);
        await this.publishQuestion(request, source, directory);
      }
      // Questions are in-memory provider requests. A successful current list
      // also retires requests answered elsewhere or cancelled during an outage.
      for (const [providerRequestId, pending] of this.#questions) {
        if (revision !== this.#questionRevision) return;
        if (pending.source !== source || pending.directory !== directory || present.has(providerRequestId)) continue;
        await this.resolveQuestion(providerRequestId, pending.sessionId, "cancelled");
      }
    })().catch(() => undefined);
    this.#questionRecoveries.set(key, refresh);
    void refresh.finally(() => {
      if (this.#questionRecoveries.get(key) === refresh) this.#questionRecoveries.delete(key);
    });
    return refresh;
  }

  private async publishQuestion(request: Record<string, unknown>, source: "primary" | "secondary", directory: string | undefined, nativeEvent?: JsonObject): Promise<void> {
    if (typeof request.id !== "string" || typeof request.sessionID !== "string"
      || !Array.isArray(request.questions) || request.questions.length === 0
      || !request.questions.every((question) => isRecord(question) && typeof question.question === "string")) return;
    const sessionId = request.sessionID;
    if (source === "primary" && (this.#terminalCleanupGenerations.has(sessionId)
      || this.#guardAbortGenerations.get(sessionId)?.outcome === "confirmed")) return;
    const providerRequestId = `opencode_question_${request.id}`;
    if (this.#questions.has(providerRequestId)) return;
    const questions: JsonObject[] = request.questions.map((question, index) => ({ ...asJsonObject(question), id: `question_${index}` }));
    const first = questions[0]!;
    const payload: JsonObject = {
      providerRequestId,
      title: typeof first.header === "string" ? first.header : "OpenCode needs input",
      question: first.question!,
      questionId: first.id!,
      questions,
    };
    this.#questions.set(providerRequestId, {
      sessionId, nativeRequestId: request.id, source, directory, questions, payload, resolving: false,
    });
    this.#questionDirectories.add(directory);
    if (source === "primary") {
      this.#emptyUnknownSequences.delete(sessionId);
      this.#settledOwnedSessions.delete(sessionId);
      this.cancelPendingOwnedCompletion(sessionId);
      this.#nativeStates.set(sessionId, "working");
      this.clearDisconnectedSession(sessionId);
    } else {
      this.#secondaryActive.add(sessionId);
    }
    await this.emit({ providerSessionId: sessionId, type: "user_input.requested", payload, ...(nativeEvent === undefined ? {} : { nativeEvent }) });
  }

  private async resolveQuestion(providerRequestId: string, sessionId: string, reason: "answered" | "cancelled", nativeEvent?: JsonObject): Promise<void> {
    const pending = this.#questions.get(providerRequestId);
    if (pending !== undefined && pending.sessionId !== sessionId) return;
    this.#questions.delete(providerRequestId);
    await this.emit({
      providerSessionId: sessionId,
      type: "user_input.resolved",
      payload: { providerRequestId, reason },
      ...(nativeEvent === undefined ? {} : { nativeEvent }),
    });
  }

  private async preparePromptAttachments(
    modelId: string | undefined,
    attachments: readonly MessageAttachment[] | undefined,
  ): Promise<readonly MessageAttachment[]> {
    if (attachments === undefined || !attachments.some(isPdfAttachment)) return attachments ?? [];
    const selectedModel = modelId === undefined
      ? undefined
      : await this.listModels()
          .then((models) => models.find((candidate) => candidate.id === modelId))
          .catch((): undefined => undefined);
    if (selectedModel !== undefined && openCodeSupportsNativePdf(selectedModel.nativeMetadata)) return attachments;

    const prepared: MessageAttachment[] = [];
    for (const attachment of attachments) {
      prepared.push(isPdfAttachment(attachment) ? await extractedPdfTextAttachment(attachment) : attachment);
    }
    return prepared;
  }

  private async rawMessages(providerSessionId: string, limit = 500, signal?: AbortSignal): Promise<unknown> {
    return await this.#client.request<unknown>("GET", `/session/${encodeURIComponent(providerSessionId)}/message`, {
      query: { ...this.query(), limit },
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  private signalCompactionLifecycle(providerSessionId: string): void {
    const waiters = this.#compactionLifecycleWaiters.get(providerSessionId);
    if (waiters === undefined) return;
    this.#compactionLifecycleWaiters.delete(providerSessionId);
    for (const wake of waiters) wake();
  }

  private async waitForCompactionLifecycle(providerSessionId: string, timeoutMs: number): Promise<void> {
    if (this.#abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const waiters = this.#compactionLifecycleWaiters.get(providerSessionId) ?? new Set<() => void>();
      this.#compactionLifecycleWaiters.set(providerSessionId, waiters);
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.#abort.signal.removeEventListener("abort", finish);
        waiters.delete(finish);
        if (waiters.size === 0 && this.#compactionLifecycleWaiters.get(providerSessionId) === waiters) {
          this.#compactionLifecycleWaiters.delete(providerSessionId);
        }
        resolve();
      };
      waiters.add(finish);
      this.#abort.signal.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, timeoutMs);
    });
  }

  private sessionStatuses(): Promise<NativeStatusSnapshot> {
    const inFlight = this.#nativeStatusRead;
    if (inFlight !== undefined) return inFlight;
    const reading = this.readNativeStatusSnapshot().finally(() => {
      if (this.#nativeStatusRead === reading) this.#nativeStatusRead = undefined;
    });
    this.#nativeStatusRead = reading;
    return reading;
  }

  /** Reconnect recovery must never reuse a request begun on the dead stream's
   * generation, so this primitive intentionally does not consult the poll cache. */
  private readNativeStatusSnapshot(): Promise<NativeStatusSnapshot> {
    const nativeEventRevisionAtStart = this.#nativeEventRevision;
    const connectionGenerationAtStart = this.#primaryConnectionGeneration;
    return this.#client.request<unknown>("GET", "/session/status", {
      query: this.query(),
      signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(nativeStatusRequestTimeoutMs)]),
    }).then((value): NativeStatusSnapshot => ({
      statuses: isRecord(value) ? value : {},
      nativeEventRevisionAtStart,
      connectionGenerationAtStart,
    }));
  }

  private ensureEventLoop(): void {
    if (this.#disposed) return;
    if (this.#eventLoop === null) {
      this.#eventLoop = this.runEventLoop().finally(() => {
        this.#eventLoop = null;
        if (!this.#disposed && this.#abort.signal.aborted === false) this.ensureEventLoop();
      });
      this.discoverPendingQuestions();
    }
    if (this.#activityLoop === null) {
      this.ensureActivityChangeWatch();
      this.#activityLoop = this.runActivityLoop().finally(() => {
        this.#activityLoop = null;
      });
    }
    if (this.#nativeStatusLoop === null) {
      this.#nativeStatusLoop = this.runNativeStatusLoop().finally(() => {
        this.#nativeStatusLoop = null;
      });
    }
  }

  private ensureSecondaryLoop(): void {
    if (this.#disposed || this.#secondaryClient === undefined) return;
    if (this.#secondaryLoop === null) {
      this.#secondaryLoop = this.runSecondaryEventLoop().finally(() => {
        this.#secondaryLoop = null;
        if (!this.#disposed && this.#secondaryAbort.signal.aborted === false) this.ensureSecondaryLoop();
      });
    }
  }

  /**
   * `/session/status` is one provider-wide map, so one bounded poll recovers
   * every task whose SSE status was missed without creating per-session work.
   * Failed reads preserve the last confirmed map; a successful later snapshot
   * is the only poll allowed to retire it.
   */
  private async runNativeStatusLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      await this.nativeStatusDelay();
      if (this.#abort.signal.aborted) return;
      const snapshot = await this.sessionStatuses().catch((): undefined => undefined);
      if (snapshot !== undefined && !this.#abort.signal.aborted) {
        await this.reconcileNativeStatusSnapshot(snapshot);
      }
      if (!this.#abort.signal.aborted) await this.recoverTerminalResponses();
      if (!this.#abort.signal.aborted && this.#now().getTime() >= this.#nextQuestionRecoveryAt) {
        this.#nextQuestionRecoveryAt = this.#now().getTime() + questionRecoveryIntervalMs;
        for (const directory of this.#questionDirectories) {
          void this.recoverPendingQuestions("primary", directory);
          if (this.#secondaryClient !== undefined) void this.recoverPendingQuestions("secondary", directory);
        }
      }
      if (!this.#primaryEventStreamDisconnected && this.#disconnectedActiveSessionIds.size > 0
        && this.#primaryReconnectRefreshes.size === 0) {
        this.startPrimaryReconnectRefresh(this.#primaryConnectionGeneration);
      }
    }
  }

  private reconcileNativeStatusSnapshot(snapshot: NativeStatusSnapshot): Promise<void> {
    const reconciliation = this.#nativeStatusReconcileTail.then(async () => {
      await this.applyNativeStatusSnapshot(snapshot);
    });
    this.#nativeStatusReconcileTail = reconciliation.catch(() => undefined);
    return reconciliation;
  }

  /** Recover missed finish events for active chats, even when none is open. */
  private async recoverTerminalResponses(): Promise<void> {
    if (this.#primaryEventStreamDisconnected) return;
    const sessions = [...this.knownActiveSessionIds()].filter((id) =>
      !this.#pendingOwnedIdles.has(id) && !this.#secondaryActive.has(id)
      && !this.#disconnectedActiveSessionIds.has(id)
      && !this.#guardAbortGenerations.has(id) && !this.#terminalCleanupGenerations.has(id));
    for (let offset = 0; offset < sessions.length; offset += maximumConcurrentActivityReconciliations) {
      await Promise.all(sessions.slice(offset, offset + maximumConcurrentActivityReconciliations).map(async (sessionId) => {
        const revision = this.#nativeEventRevisionBySession.get(sessionId);
        const connection = this.#primaryConnectionGeneration;
        const value = await this.#client.request<unknown>("GET", `/session/${encodeURIComponent(sessionId)}/message`, {
          query: { ...this.query(), limit: 2 },
          timeoutMs: nativeStatusRequestTimeoutMs,
        }).catch((): unknown => undefined);
        if (this.#disposed || this.#primaryEventStreamDisconnected || connection !== this.#primaryConnectionGeneration
          || revision !== this.#nativeEventRevisionBySession.get(sessionId) || !Array.isArray(value)) return;
        const tail = value.at(-1);
        const info = isRecord(tail) && isRecord(tail.info) ? tail.info : tail;
        if (isRecord(info)) this.armTerminalCompletion(sessionId, info);
      }));
    }
  }

  private async applyNativeStatusSnapshot(snapshot: NativeStatusSnapshot): Promise<void> {
    if (snapshot.connectionGenerationAtStart !== this.#primaryConnectionGeneration) return;
    if (this.#primaryEventStreamDisconnected) {
      // Reads may still succeed while only SSE is down. Retain newly observed
      // work as recovery input, but never let an empty outage-time snapshot
      // erase the sessions that must stay visibly disconnected.
      for (const [sessionId, status] of Object.entries(snapshot.statuses)) {
        if (normalizeStatus(status) !== "working") continue;
        this.#nativeStates.set(sessionId, "working");
        this.#nativeStatuses.set(sessionId, status);
        this.#disconnectedActiveSessionIds.add(sessionId);
        this.#disconnectedNativeSessionIds.add(sessionId);
      }
      return;
    }
    const previousWorking = this.nativeWorkingSessionIds();
    this.captureNativeStates(snapshot);
    const nextWorking = this.nativeWorkingSessionIds();
    const sessionIds = new Set([...previousWorking, ...nextWorking]);
    for (const sessionId of sessionIds) {
      if (this.#disconnectedActiveSessionIds.has(sessionId)) continue;
      if ((this.#nativeEventRevisionBySession.get(sessionId) ?? 0) > snapshot.nativeEventRevisionAtStart) continue;
      const wasWorking = previousWorking.has(sessionId)
        || this.#persistedWorking.has(sessionId)
        || this.#activePrompts.has(sessionId);
      const isWorking = nextWorking.has(sessionId)
        || this.#persistedWorking.has(sessionId)
        || this.#activePrompts.has(sessionId);
      if (wasWorking === isWorking) continue;
      const nativeStatus = snapshot.statuses[sessionId];
      const providerStatus = normalizeOpenCodeProviderStatus(nativeStatus);
      await this.emit({
        providerSessionId: sessionId,
        type: "session.status_changed",
        payload: {
          state: isWorking ? "working" : "idle",
          providerStatus: providerStatus === undefined ? null : asJsonObject(providerStatus),
        },
      });
      if (!isWorking || (this.#nativeEventRevisionBySession.get(sessionId) ?? 0) > snapshot.nativeEventRevisionAtStart) continue;
      // A status event cannot materialize a task the Bridge has never loaded.
      // This companion metadata event invalidates the bounded catalogue.
      await this.emit({ providerSessionId: sessionId, type: "session.updated", payload: { state: "working", activityDiscovered: true } });
    }
  }

  private async nativeStatusDelay(): Promise<void> {
    if (this.#abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, this.#nativeStatusPollIntervalMs);
      const signal = this.#abort.signal;
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async runActivityLoop(): Promise<void> {
    const initialAvailable = await this.ensureInitialActivitySnapshot();
    if (!this.#abort.signal.aborted && initialAvailable) await this.activityDelay();
    while (!this.#abort.signal.aborted) {
      this.#activityRefreshRequested = false;
      const guardEpoch = this.#guardActivityEpoch;
      const connectionGeneration = this.#primaryConnectionGeneration;
      const activityReadAt = this.#now().getTime();
      const safetyDiscovery = activityReadAt >= this.#nextActivitySafetyDiscoveryAt;
      const changeDiscovery = this.#activityDiscoveryPending && activityReadAt >= this.#nextActivityDiscoveryAt;
      const discovery = safetyDiscovery ? "complete" : changeDiscovery ? "recent" : undefined;
      const pendingDiscoveryAttempted = discovery !== undefined && this.#activityDiscoveryPending;
      if (discovery !== undefined) {
        this.#activityDiscoveryPending = false;
        // Record every provider-wide attempt, including an unavailable read, so
        // repeated WAL wakes cannot hot-loop the packaged SQLite helper.
        this.#nextActivityDiscoveryAt = activityReadAt + this.#activityDiscoveryIntervalMs;
      }
      const snapshot = await this.tryReadPersistedWorking(this.activityCandidates(), discovery);
      // A session-wide abort may complete while the database read is in flight.
      // Discard that old snapshot so it cannot resurrect the released generation.
      if (guardEpoch !== this.#guardActivityEpoch || connectionGeneration !== this.#primaryConnectionGeneration) {
        await this.activityDelay();
        continue;
      }
      if (snapshot === undefined) {
        // An unavailable activity source is not evidence that every turn ended.
        // The generic deadline may still *ask* exact history for confirmation;
        // it cannot emit idle on its own.
        if (pendingDiscoveryAttempted) this.#activityDiscoveryPending = true;
        await this.settleUnconfirmedActiveTurns(new Set());
        const retryWait = this.#activityDiscoveryPending
          ? Math.max(0, this.#nextActivityDiscoveryAt - this.#now().getTime())
          : undefined;
        await this.activityDelay(retryWait);
        continue;
      }
      if (discovery !== undefined) {
        this.#nextActivitySafetyDiscoveryAt = activityReadAt + this.#activityPollIntervalMs;
      }
      const next = new Set([...snapshot].filter((sessionId) =>
        this.#guardAbortGenerations.get(sessionId)?.outcome !== "confirmed"
        && !this.#terminalCleanupGenerations.has(sessionId)));
      if (!await this.reconcilePersistedActivity(next, guardEpoch, connectionGeneration)) {
        await this.activityDelay();
        continue;
      }
      const discoveryWait = this.#activityDiscoveryPending
        ? Math.max(0, this.#nextActivityDiscoveryAt - this.#now().getTime())
        : undefined;
      await this.activityDelay(discoveryWait);
    }
  }

  private async reconcilePersistedActivity(
    next: ReadonlySet<string>,
    guardEpoch: number,
    connectionGeneration: number,
  ): Promise<boolean> {
    this.#applyingPersistedWorking = next;
    try {
      const previous = this.#persistedWorking;
      if (connectionGeneration !== this.#primaryConnectionGeneration) return false;
      if (this.#primaryEventStreamDisconnected) {
        if (guardEpoch !== this.#guardActivityEpoch) return false;
        this.#persistedWorking = new Set(next);
        this.#persistedActivityAvailable = true;
        for (const sessionId of next) {
          this.#disconnectedActiveSessionIds.add(sessionId);
          this.#disconnectedPersistedSessionIds.add(sessionId);
        }
        return true;
      }
      const ids = new Set([...previous, ...next]);
      const reconciliations: Array<() => Promise<void>> = [];
      for (const sessionId of ids) {
        const wasWorking = previous.has(sessionId);
        const isWorking = next.has(sessionId);
        if (wasWorking === isWorking) continue;
        reconciliations.push(async () => {
          if (connectionGeneration !== this.#primaryConnectionGeneration || this.#primaryEventStreamDisconnected) return;
          const activePromptId = this.#activePromptMessageIds.get(sessionId);
          if (activePromptId !== undefined) {
            if (isWorking) {
              if (this.hasTerminalOwnedIdleArmed(sessionId)) return;
              this.cancelPendingOwnedCompletion(sessionId);
              await this.emit({ providerSessionId: sessionId, type: "session.status_changed", payload: { state: "working", providerStatus: null } });
            } else {
              // Database disappearance is only a hint. A completed tool step and a
              // genuinely terminal response look identical to the activity query.
              this.rememberPendingOwnedIdle(sessionId, activePromptId);
            }
            return;
          }
          if (this.isSettledOwnedSession(sessionId) && isWorking) return;
          if (this.#nativeStates.get(sessionId) !== undefined && this.#nativeStates.get(sessionId) !== "unknown") return;
          if (!isWorking) {
            // The database is the authoritative completion signal: a turn it once
            // reported as working and now reports as done is over, so the
            // dispatch mark must not re-flag the session on the next listing.
            this.cancelPendingOwnedCompletion(sessionId);
            this.#activePrompts.delete(sessionId);
            this.#activePromptMessageIds.delete(sessionId);
          }
          await this.emit({ providerSessionId: sessionId, type: "session.status_changed", payload: { state: isWorking ? "working" : "idle", providerStatus: null } });
          if (isWorking) {
            // A status event cannot materialize a task the Bridge has never loaded.
            // This metadata event also invalidates its bounded provider catalogue.
            await this.emit({ providerSessionId: sessionId, type: "session.updated", payload: { state: "working", activityDiscovered: true } });
          }
        });
      }
      for (let offset = 0; offset < reconciliations.length; offset += maximumConcurrentActivityReconciliations) {
        await Promise.all(reconciliations
          .slice(offset, offset + maximumConcurrentActivityReconciliations)
          .map(async (reconcile) => await reconcile()));
      }
      if (guardEpoch !== this.#guardActivityEpoch || connectionGeneration !== this.#primaryConnectionGeneration) return false;
      this.#persistedWorking = new Set([...next].filter((id) => !this.isSettledOwnedSession(id)));
      this.#persistedActivityAvailable = true;
      await this.settleUnconfirmedActiveTurns(next);
      return true;
    } finally {
      if (this.#applyingPersistedWorking === next) this.#applyingPersistedWorking = undefined;
    }
  }

  private activityCandidates(): ReadonlySet<string> {
    return this.knownActiveSessionIds();
  }

  /** Internal activity truth is retained through a feed outage so reconnect can
   * reconcile it, while public activity methods suppress it until that happens. */
  private knownActiveSessionIds(): Set<string> {
    return new Set([
      ...this.#activePrompts,
      ...this.#persistedWorking,
      ...(this.#applyingPersistedWorking ?? []),
      ...[...this.#nativeStates].flatMap(([sessionId, state]) => state === "working" ? [sessionId] : []),
      ...this.#disconnectedActiveSessionIds,
    ].filter((id) => !this.isSettledOwnedSession(id)));
  }

  private async ensureInitialActivitySnapshot(): Promise<boolean> {
    if (this.#initialActivitySnapshot === undefined) {
      this.#initialActivitySnapshot = (async () => {
        if (this.#disposed) return false;
        const guardEpoch = this.#guardActivityEpoch;
        const connectionGeneration = this.#primaryConnectionGeneration;
        const activityReadAt = this.#now().getTime();
        const snapshot = await this.tryReadPersistedWorking(this.activityCandidates(), "complete");
        if (this.#disposed || snapshot === undefined || guardEpoch !== this.#guardActivityEpoch
          || connectionGeneration !== this.#primaryConnectionGeneration) return false;
        const next = new Set([...snapshot].filter((sessionId) =>
          this.#guardAbortGenerations.get(sessionId)?.outcome !== "confirmed"
          && !this.#terminalCleanupGenerations.has(sessionId)));
        this.#nextActivityDiscoveryAt = activityReadAt + this.#activityDiscoveryIntervalMs;
        this.#nextActivitySafetyDiscoveryAt = activityReadAt + this.#activityPollIntervalMs;
        return await this.reconcilePersistedActivity(next, guardEpoch, connectionGeneration);
      })();
    }
    const attempt = this.#initialActivitySnapshot;
    const available = await attempt;
    // A missing/locked DB is transient. A later catalogue read or the activity
    // loop may retry, while successful startup discovery remains single-shot.
    if (!available && this.#initialActivitySnapshot === attempt) this.#initialActivitySnapshot = undefined;
    return available;
  }

  private async awaitInitialActivitySnapshot(): Promise<boolean> {
    const initial = this.ensureInitialActivitySnapshot();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        initial,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1_500); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Some servers never emit session.idle (the AI Desktop sidecar does not), so
   * a dispatched turn would otherwise leave the session marked active forever.
   * The local activity database is the authoritative completion signal: once it
   * stops reporting a session as working, wait out a grace period (longer than
   * the dispatch-to-first-message window) and then settle the session to idle.
   */
  private async settleUnconfirmedActiveTurns(confirmedWorking: ReadonlySet<string>): Promise<void> {
    const now = this.#now().getTime();
    for (const sessionId of [...this.#activePrompts]) {
      if (confirmedWorking.has(sessionId)) {
        if (!this.hasTerminalOwnedIdleArmed(sessionId)) this.cancelPendingOwnedCompletion(sessionId);
        continue;
      }
      if (this.#nativeStates.get(sessionId) === "working") continue;
      const deadline = this.#activeSettleDeadlines.get(sessionId) ?? now + this.#activeTurnSettleMs;
      if (now >= deadline) {
        this.#activeSettleDeadlines.delete(sessionId);
        const activePromptId = this.#activePromptMessageIds.get(sessionId);
        if (activePromptId !== undefined) {
          // The timeout is a retry trigger, never completion authority. This
          // also discovers the exact terminal response if its SSE update was lost.
          const pending = this.#pendingOwnedIdles.get(sessionId);
          if (pending?.parentId === activePromptId && (pending.timer !== undefined || pending.checksInFlight > 0)) continue;
          this.rememberPendingOwnedIdle(sessionId, activePromptId);
        } else {
          this.#activePrompts.delete(sessionId);
          await this.emit({ providerSessionId: sessionId, type: "session.status_changed", payload: { state: "idle", providerStatus: null } });
        }
      } else {
        this.#activeSettleDeadlines.set(sessionId, deadline);
      }
    }
  }

  private async markPrimaryDisconnected(cause: unknown): Promise<void> {
    if (this.#primaryEventStreamDisconnected) return;
    for (const sessionId of this.#pendingOwnedIdles.keys()) this.clearPendingOwnedIdle(sessionId);
    const nativeWorking = this.nativeWorkingSessionIds();
    const persistedWorking = new Set([
      ...this.#persistedWorking,
      ...(this.#applyingPersistedWorking ?? []),
    ]);
    const activeSessionIds = this.knownActiveSessionIds();
    this.#primaryEventStreamDisconnected = true;
    this.#primaryConnectionGeneration += 1;
    for (const sessionId of activeSessionIds) {
      this.#disconnectedActiveSessionIds.add(sessionId);
      if (nativeWorking.has(sessionId)) this.#disconnectedNativeSessionIds.add(sessionId);
      if (persistedWorking.has(sessionId)) this.#disconnectedPersistedSessionIds.add(sessionId);
    }
    // The Bridge stops listening as soon as the provider-level event arrives.
    // Publish every affected task first so none is mistaken for completed or
    // interrupted merely because its live transport disappeared.
    for (const sessionId of activeSessionIds) {
      await this.emit({
        providerSessionId: sessionId,
        type: "session.status_changed",
        payload: { state: "disconnected", providerStatus: null },
      });
    }
    await this.emit({
      type: "provider.disconnected",
      payload: { message: cause instanceof Error ? cause.message : String(cause) },
    });
  }

  private beginPrimaryReconnect(): void {
    if (!this.#primaryEventStreamDisconnected) return;
    this.#primaryEventStreamDisconnected = false;
    this.#primaryConnectionGeneration += 1;
    this.startPrimaryReconnectRefresh(this.#primaryConnectionGeneration);
  }

  private startPrimaryReconnectRefresh(connectionGeneration: number): void {
    if (this.#disposed || this.#primaryEventStreamDisconnected
      || connectionGeneration !== this.#primaryConnectionGeneration
      || this.#disconnectedActiveSessionIds.size === 0) return;
    const refresh = this.refreshDisconnectedSessions(connectionGeneration).catch(() => undefined);
    this.#primaryReconnectRefreshes.add(refresh);
    void refresh.finally(() => {
      this.#primaryReconnectRefreshes.delete(refresh);
    }).catch(() => undefined);
  }

  private async refreshDisconnectedSessions(connectionGeneration: number): Promise<void> {
    const sessionIds = new Set(this.#disconnectedActiveSessionIds);
    if (sessionIds.size === 0) return;
    const nativeEventRevisionAtStart = this.#nativeEventRevision;
    // Both reads start before the first reconnect event is handled. A later SSE
    // state change therefore has a strictly newer per-session revision and wins.
    const nativeRead = this.readNativeStatusSnapshot().catch((): undefined => undefined);
    const persistedRead = this.tryReadPersistedWorking(sessionIds);
    const [nativeSnapshot, persistedWorking] = await Promise.all([nativeRead, persistedRead]);
    if (this.#disposed || this.#primaryEventStreamDisconnected
      || connectionGeneration !== this.#primaryConnectionGeneration) return;
    const usableNativeSnapshot = nativeSnapshot?.connectionGenerationAtStart === connectionGeneration
      ? nativeSnapshot
      : undefined;
    if (usableNativeSnapshot !== undefined) this.captureNativeStates(usableNativeSnapshot);
    if (persistedWorking !== undefined) {
      this.#persistedActivityAvailable = true;
      for (const sessionId of sessionIds) {
        if (persistedWorking.has(sessionId)) this.#persistedWorking.add(sessionId);
        else this.#persistedWorking.delete(sessionId);
      }
    }

    for (const sessionId of sessionIds) {
      if (!this.#disconnectedActiveSessionIds.has(sessionId)) continue;
      if ((this.#nativeEventRevisionBySession.get(sessionId) ?? 0) > nativeEventRevisionAtStart) continue;
      const nativeWasRelevant = this.#disconnectedNativeSessionIds.has(sessionId);
      const persistedWasRelevant = this.#disconnectedPersistedSessionIds.has(sessionId);
      const ownedPromptId = this.#activePromptMessageIds.get(sessionId);
      const hasNativeStatus = usableNativeSnapshot !== undefined
        && Object.prototype.hasOwnProperty.call(usableNativeSnapshot.statuses, sessionId);
      const nativeStatus = hasNativeStatus ? usableNativeSnapshot!.statuses[sessionId] : undefined;
      const nativeState = hasNativeStatus
        ? normalizeStatus(nativeStatus)
        : usableNativeSnapshot !== undefined && (nativeWasRelevant || ownedPromptId !== undefined)
          ? "idle"
          : undefined;
      const persistedIsWorking = persistedWorking?.has(sessionId) === true;

      let restoredState: RemoteSession["state"] | undefined;
      if (nativeState === "failed") restoredState = "failed";
      else if (nativeState === "working" || persistedIsWorking) restoredState = "working";
      else if (ownedPromptId !== undefined) {
        // Provider inactivity is not the final-answer signal. Keep this task
        // disconnected while exact history confirms and publishes its terminal
        // assistant response; never invent completion from the reconnect read.
        if (nativeState === "idle" || persistedWorking !== undefined) {
          this.rememberPendingOwnedIdle(sessionId, ownedPromptId);
        }
        continue;
      } else {
        const nativeUnresolved = nativeWasRelevant && nativeState !== "idle";
        const persistedUnresolved = persistedWasRelevant && persistedWorking === undefined;
        if (nativeUnresolved || persistedUnresolved) continue;
        const hasIdleAuthority = (nativeWasRelevant && nativeState === "idle")
          || (persistedWasRelevant && persistedWorking !== undefined);
        if (hasIdleAuthority) restoredState = "idle";
      }
      if (restoredState === undefined) continue;

      if (restoredState === "working") {
        this.cancelPendingOwnedCompletion(sessionId);
      } else {
        this.cancelPendingOwnedCompletion(sessionId);
        this.#activePrompts.delete(sessionId);
        this.#activePromptMessageIds.delete(sessionId);
        this.#persistedWorking.delete(sessionId);
        if (restoredState === "failed") {
          this.#nativeStates.set(sessionId, "failed");
          if (hasNativeStatus) this.#nativeStatuses.set(sessionId, nativeStatus);
        }
      }
      this.clearDisconnectedSession(sessionId);
      const providerStatus = normalizeOpenCodeProviderStatus(nativeStatus);
      await this.emit({
        providerSessionId: sessionId,
        type: "session.status_changed",
        payload: {
          state: restoredState,
          providerStatus: providerStatus === undefined ? null : asJsonObject(providerStatus),
        },
      });
      if (restoredState === "working") {
        await this.emit({
          providerSessionId: sessionId,
          type: "session.updated",
          payload: { state: "working", activityDiscovered: true },
        });
      }
    }
  }

  private async runEventLoop(): Promise<void> {
    const backoff = new ExponentialBackoff({ initialMs: 250, maximumMs: 10_000 });
    while (!this.#abort.signal.aborted) {
      let disconnectCause: unknown = new Error("OpenCode event stream ended.");
      try {
        for await (const event of this.#client.sse("/global/event", { signal: this.#abort.signal })) {
          if (this.#abort.signal.aborted) return;
          this.beginPrimaryReconnect();
          backoff.reset();
          await this.handleEvent(event, "primary");
        }
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        disconnectCause = error;
      }
      if (this.#abort.signal.aborted) return;
      await this.markPrimaryDisconnected(disconnectCause);
      await new Promise<void>((resolve) => setTimeout(resolve, backoff.next()));
    }
  }

  /**
   * The retired server's feed: forwards the same session events, but never
   * reports connection state (that belongs to the primary server) and only
   * marks sessions busy that are actually streaming through it.
   */
  private async runSecondaryEventLoop(): Promise<void> {
    const client = this.#secondaryClient;
    const backoff = new ExponentialBackoff({ initialMs: 250, maximumMs: 10_000 });
    while (!this.#secondaryAbort.signal.aborted && client !== undefined) {
      try {
        for await (const event of client.sse("/global/event", { signal: this.#secondaryAbort.signal })) {
          if (this.#secondaryAbort.signal.aborted) return;
          const global = isRecord(event) && isRecord(event.payload) ? event : { payload: event };
          const payload = isRecord(global.payload) ? global.payload : {};
          if (payload.type === "server.connected") {
            this.discoverPendingQuestions();
            continue;
          }
          backoff.reset();
          await this.handleEvent(event, "secondary");
        }
      } catch {
        if (this.#secondaryAbort.signal.aborted) return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, backoff.next()));
    }
  }

  private async handleEvent(value: unknown, source: "primary" | "secondary" = "primary"): Promise<void> {
    const global = isRecord(value) && isRecord(value.payload) ? value : { payload: value };
    const payload = isRecord(global.payload) ? global.payload : {};
    const type = typeof payload.type === "string" ? payload.type : "unknown";
    const properties = isRecord(payload.properties) ? payload.properties : isRecord(payload.data) ? payload.data : {};
    const sessionId = findSessionId(properties);
    const base = { ...(sessionId !== undefined ? { providerSessionId: sessionId } : {}), nativeEvent: asJsonObject(global) };
    if (source === "primary" && sessionId !== undefined && primaryEventCarriesActivityState(type)) {
      this.#nativeEventRevision += 1;
      this.#nativeEventRevisionBySession.set(sessionId, this.#nativeEventRevision);
    }

    if (source === "primary" && sessionId !== undefined
      && (type === "session.compacted" || type === "session.next.compaction.ended")) {
      this.signalCompactionLifecycle(sessionId);
    }

    if (type === "server.connected") {
      this.discoverPendingQuestions();
      return await this.emit({ ...base, type: "provider.connected", payload: {} });
    }
    if (type === "session.created") return await this.emit({ ...base, type: "session.created", payload: asJsonObject(properties) });
    if (type === "session.updated") return await this.emit({ ...base, type: "session.updated", payload: sessionUpdatePayload(this.#hostId, properties) });
    if (type === "session.status") {
      const status = normalizeStatus(properties.status);
      const providerStatus = normalizeOpenCodeProviderStatus(properties.status);
      if (source === "secondary" && sessionId !== undefined
        && this.#activePromptMessageIds.has(sessionId)
        && (status === "idle" || status === "unknown" || status === "failed")) {
        this.#secondaryActive.delete(sessionId);
        return;
      }
      // Status has only a session id. Until a concrete message acknowledges the
      // next generation, every queued status can still belong to our own abort.
      if (source === "primary" && sessionId !== undefined) {
        if (this.#guardAbortGenerations.get(sessionId)?.outcome === "confirmed") return;
        const terminalCleanup = this.#terminalCleanupGenerations.get(sessionId);
        if (terminalCleanup !== undefined && status !== "failed"
          && (terminalCleanup.successorMessageId === undefined || status === "idle" || status === "unknown")) {
          if (status === "idle" || status === "unknown") this.observeTerminalCleanup(terminalCleanup);
          return;
        }
        this.#nativeStatuses.set(sessionId, properties.status);
        const activePromptId = this.#activePromptMessageIds.get(sessionId);
        if (activePromptId !== undefined && (status === "idle" || status === "unknown")) {
          // This event carries only a session id, so it cannot prove which prompt
          // ended. Keep the provider-side ownership mark until session.idle can
          // be tied to this exact parent through persisted terminal history.
          this.#nativeStates.set(sessionId, "idle");
          this.rememberPendingOwnedIdle(sessionId, activePromptId, base.nativeEvent);
          return;
        }
        if (this.shouldIgnoreWrapUpWorking(sessionId) && status === "working") return;
        // OpenCode re-publishes busy while the runner wraps up (title, snapshot,
        // plugins) after a no-tool stop. That is not a new generation.
        if (activePromptId !== undefined && status === "working" && !this.hasTerminalOwnedIdleArmed(sessionId)) {
          this.cancelPendingOwnedCompletion(sessionId);
        }
        if (status === "failed") {
          this.rememberTerminalCleanupGeneration(sessionId, "failed", activePromptId);
          if (activePromptId !== undefined) this.releaseOwnedPrompt(sessionId, activePromptId);
        }
        if (status !== "unknown") this.clearDisconnectedSession(sessionId);
      }
      if (sessionId !== undefined) this.#nativeStates.set(sessionId, status);
      return await this.emit({
        ...base,
        type: "session.status_changed",
        payload: { state: status, providerStatus: providerStatus === undefined ? null : asJsonObject(providerStatus) },
      });
    }
    if (type === "session.idle") {
      if (source === "secondary" && sessionId !== undefined) {
        this.#secondaryActive.delete(sessionId);
        // The retired server can finish the old generation after the replacement
        // server has accepted a new prompt for the same session. Its unlabelled
        // idle owns only the retired feed; it must not clear or complete the
        // replacement server's newer prompt.
        if (this.#activePromptMessageIds.has(sessionId)) return;
      }
      if (source === "primary" && sessionId !== undefined) this.#nativeStatuses.delete(sessionId);
      if (source === "primary" && sessionId !== undefined) {
        const guard = this.#guardAbortGenerations.get(sessionId);
        const activePromptId = this.#activePromptMessageIds.get(sessionId);
        // Do not count cleanup events. The quarantine is retired by a concrete
        // successor message, never by elapsed time or by one guessed idle.
        if (guard?.outcome === "confirmed") return;
        const terminalCleanup = this.#terminalCleanupGenerations.get(sessionId);
        if (terminalCleanup !== undefined) {
          this.observeTerminalCleanup(terminalCleanup);
          return;
        }
        if (activePromptId !== undefined) {
          // Never block the SSE loop on history: a queued tool part must get a
          // chance to invalidate this otherwise-unlabelled idle first.
          this.#nativeStates.set(sessionId, "idle");
          this.rememberPendingOwnedIdle(sessionId, activePromptId, base.nativeEvent);
          return;
        }
        const pending = this.#pendingOwnedIdles.get(sessionId);
        if (pending !== undefined) {
          this.rememberPendingOwnedIdle(sessionId, pending.parentId, base.nativeEvent);
          return;
        }
        if (this.isSettledOwnedSession(sessionId)) {
          this.#nativeStates.set(sessionId, "idle");
          return;
        }
      }
      if (sessionId !== undefined) {
        const promptMessageId = this.#activePromptMessageIds.get(sessionId);
        if (source === "primary") this.clearDisconnectedSession(sessionId);
        this.#nativeStates.set(sessionId, "idle");
        this.#activePrompts.delete(sessionId);
        this.#activePromptMessageIds.delete(sessionId);
        if (promptMessageId !== undefined) this.#terminalPromptCandidates.delete(promptMessageId);
        if (source === "secondary") this.#secondaryActive.delete(sessionId);
      }
      return await this.emit({ ...base, type: "agent.completed", payload: { providerStatus: null } });
    }
    if (type === "message.updated") {
      const info = isRecord(properties.info) ? properties.info : properties;
      if (source === "primary" && sessionId !== undefined && isCompletedOpenCodeCompactionAssistant(info)) {
        this.signalCompactionLifecycle(sessionId);
      }
      const messageId = typeof info.id === "string" ? info.id : undefined;
      const parentId = typeof info.parentID === "string" ? info.parentID : undefined;
      const role = typeof info.role === "string" ? info.role : undefined;
      const activePromptId = source === "primary" && sessionId !== undefined
        ? this.#activePromptMessageIds.get(sessionId)
        : undefined;
      this.rememberMessageRole(properties);
      if (source === "primary" && sessionId !== undefined) {
        this.retireTerminalCleanupAtNewGenerationBoundary(sessionId, info, activePromptId);
        const guard = this.#guardAbortGenerations.get(sessionId);
        if (guard?.outcome === "uncertain" && role === "assistant"
          && messageId === guard.continuationAssistantId && activePromptId === guard.parentId) {
          if (isOpenCodeAbortError(info.error)) {
            guard.outcome = "confirmed";
            this.#guardActivityEpoch += 1;
            await this.beginGuardCompletion(sessionId, guard);
            return;
          }
          // The event that triggered the attempt was already being handled before
          // this state existed. Any later update for that assistant is fresh proof
          // that the rejected abort did not stop it.
          this.retireGuardGeneration(sessionId, guard);
        }
        this.retireGuardAtNewGenerationBoundary(sessionId, info, activePromptId);
      }
      if (source === "primary" && sessionId !== undefined && this.isSettledTerminalRepeat(sessionId, info)) return;
      if (source === "primary" && sessionId !== undefined) this.#settledOwnedSessions.delete(sessionId);
      if (source === "primary" && sessionId !== undefined && activePromptId === undefined) {
        const pending = this.#pendingOwnedIdles.get(sessionId);
        if (pending !== undefined && !(role === "assistant" && parentId === pending.parentId
          && messageId === pending.assistantId && isOpenCodeTurnExitFinish(info.finish))) {
          this.cancelPendingOwnedCompletion(sessionId);
        }
      }
      if (source === "primary" && sessionId !== undefined && activePromptId !== undefined && messageId !== undefined) {
        const repeatedTerminal = role === "assistant" && parentId === activePromptId
          && this.#terminalPromptCandidates.get(activePromptId) === messageId
          && isOpenCodeTurnExitFinish(info.finish);
        const belongsToActivePrompt = (role === "user" && messageId === activePromptId)
          || (role === "assistant" && parentId === activePromptId);
        // Output after an idle proves that idle was stale. A duplicate update for
        // the same already-known terminal response is the one harmless exception.
        if (belongsToActivePrompt && !repeatedTerminal) this.cancelPendingOwnedCompletion(sessionId);
      }
      if (source === "primary" && role === "assistant" && parentId !== undefined && this.#runawayPromptParents.has(parentId)) {
        if (messageId !== undefined) this.rememberSuppressedMessage(messageId);
        return;
      }
      if (source === "primary" && sessionId !== undefined && role === "assistant" && parentId !== undefined
        && messageId !== undefined && this.#activePromptMessageIds.get(sessionId) === parentId) {
        if (await this.maybeStopEmptyUnknownLoop(sessionId, parentId, messageId, info)) return;
      }
      const terminalAssistantId = parentId === undefined ? undefined : this.#terminalPromptCandidates.get(parentId);
      if (source === "primary" && sessionId !== undefined && role === "assistant" && messageId !== undefined
        && parentId !== undefined && terminalAssistantId !== undefined && messageId !== terminalAssistantId
        && this.#activePromptMessageIds.get(sessionId) === parentId) {
        const confirmation = await this.confirmQuietNoToolTerminal(
          sessionId,
          parentId,
          terminalAssistantId,
          messageId,
        );
        if (confirmation.kind === "terminal") {
          const stopped = await this.stopRunawayContinuation(sessionId, parentId, messageId);
          if (stopped.kind === "completed") {
            await stopped.completion;
            return;
          }
          if (stopped.kind === "stale") {
            this.rememberRunawayPrompt(parentId);
            this.rememberSuppressedMessage(messageId);
            return;
          }
          // One prompt gets at most one abort attempt. If the provider refused
          // it, fail open and do not hammer the session on later updates.
          this.#terminalPromptCandidates.delete(parentId);
        }
        // Missing/contradictory history or a failed abort fails open: show the
        // continuation instead of hiding a legitimate tool-using turn.
        // Keep a terminal candidate when persistence merely trails the live
        // second assistant. A later same-parent message can retry the causal
        // check; only contradictory history proves this was a real continuation.
        if (confirmation.kind === "continuing") this.#terminalPromptCandidates.delete(parentId);
      }
      if (source === "primary" && sessionId !== undefined && !this.isOwnedTerminalAssistantPart(sessionId, messageId)) {
        this.#nativeStates.set(sessionId, "working");
        this.clearDisconnectedSession(sessionId);
      }
      if (source === "secondary" && sessionId !== undefined) this.#secondaryActive.add(sessionId);
      if (sessionId !== undefined) {
        await this.publishReportedSelection(sessionId, info, { source: "live", nativeEvent: base.nativeEvent });
      }
      await this.emit({ ...base, type: "message.started", payload: asJsonObject(properties) });
      if (source === "primary" && sessionId !== undefined) this.armTerminalCompletion(sessionId, info, base.nativeEvent);
      return;
    }
    if (type === "message.part.updated") {
      const part = isRecord(properties.part) ? properties.part : {};
      const messageId = typeof part.messageID === "string" ? part.messageID : undefined;
      if (messageId !== undefined && this.#suppressedMessageIds.has(messageId)) return;
      const partType = typeof part.type === "string" ? part.type : "unknown";
      if (partType === "text" || partType === "reasoning") {
        const partId = typeof part.id === "string" && part.id.length > 0 ? part.id : undefined;
        // OpenCode creates a part here with an empty body and streams the body itself
        // as message.part.delta, which names only the part id. Without the kind recorded
        // now there is no way to tell later whether those chunks are an answer or a thought.
        if (partId !== undefined) this.rememberPartType(partId, partType);
        // OpenCode publishes part updates for the prompt as well as the answer.
        // Streaming those would replay the user's own words as assistant text.
        if (messageId !== undefined && (this.#messageRoles.get(messageId) ?? "assistant") !== "assistant") return;
        const update = this.textDelta(partId, properties.delta, part.text);
        if (update.text === "") return;
        if (source === "primary" && sessionId !== undefined) {
          this.retireAmbiguousGuardAfterContinuationOutput(sessionId, messageId);
        }
        if (source === "primary" && sessionId !== undefined) {
          this.#emptyUnknownSequences.delete(sessionId);
          if (!this.isOwnedTerminalAssistantPart(sessionId, messageId)) {
            this.#settledOwnedSessions.delete(sessionId);
            this.cancelPendingOwnedCompletion(sessionId);
            this.#nativeStates.set(sessionId, "working");
            this.clearDisconnectedSession(sessionId);
          }
        }
        return await this.emit({
          ...base,
          type: "message.delta",
          payload: {
            text: update.text,
            partType,
            // A replaced part carries its whole text, so consumers must overwrite
            // the row rather than append to what they already showed.
            ...(update.replace ? { replace: true } : {}),
            ...(partId !== undefined ? { partId } : {}),
            ...(messageId !== undefined ? { messageId } : {}),
          },
        });
      }
      if (partType === "tool") {
        if (source === "primary" && sessionId !== undefined) {
          this.#emptyUnknownSequences.delete(sessionId);
          this.retireAmbiguousGuardAfterContinuationOutput(sessionId, messageId);
        }
        if (messageId !== undefined && isContinuingOpenCodeToolPart(part)) {
          if (source === "primary" && sessionId !== undefined) {
            this.#settledOwnedSessions.delete(sessionId);
            this.cancelPendingOwnedCompletion(sessionId);
          }
          this.rememberContinuingToolMessage(messageId);
          this.forgetTerminalCandidateForMessage(messageId);
        }
        if (source === "primary" && sessionId !== undefined && !this.isOwnedTerminalAssistantPart(sessionId, messageId)) {
          this.#nativeStates.set(sessionId, "working");
          this.clearDisconnectedSession(sessionId);
        }
        // EYES failures may contain provider response bodies, keys, or paths in
        // the native part. The normalized payload is useful and sanitized; the
        // raw native event must never cross the provider boundary.
        const toolBase = isOpenCodeEyesTool(part.tool)
          ? { ...(sessionId !== undefined ? { providerSessionId: sessionId } : {}) }
          : base;
        return await this.emit({ ...toolBase, type: toolEventType(part), payload: normalizeOpenCodeToolEventPayload(part) });
      }
      if (partType === "patch") {
        const files = Array.isArray(part.files)
          ? part.files.filter((file): file is string => typeof file === "string" && file.trim().length > 0)
          : [];
        if (files.length === 0) return;
        if (source === "primary" && sessionId !== undefined) {
          this.#emptyUnknownSequences.delete(sessionId);
          this.retireAmbiguousGuardAfterContinuationOutput(sessionId, messageId);
        }
        if (source === "primary" && sessionId !== undefined && !this.isOwnedTerminalAssistantPart(sessionId, messageId)) {
          this.#settledOwnedSessions.delete(sessionId);
          this.cancelPendingOwnedCompletion(sessionId);
          this.#nativeStates.set(sessionId, "working");
          this.clearDisconnectedSession(sessionId);
        }
        return await this.emit({ ...base, type: "file.changed", payload: { ...asJsonObject(part), files } });
      }
    }
    /**
     * The live body of an answer or a thought.
     *
     * message.part.updated announces a part with an empty body; every character after
     * that arrives here, one chunk at a time, and OpenCode's own client fills the row
     * by appending delta to the named field. Handling only the announcement is why a
     * live reasoning row stayed blank for the whole turn and only filled in once the
     * finished transcript was reloaded.
     */
    if (type === "message.part.delta") {
      const partId = typeof properties.partID === "string" ? properties.partID : undefined;
      const field = typeof properties.field === "string" ? properties.field : undefined;
      const delta = typeof properties.delta === "string" ? properties.delta : "";
      const messageId = typeof properties.messageID === "string" ? properties.messageID : undefined;
      if (messageId !== undefined && this.#suppressedMessageIds.has(messageId)) return;
      if (partId === undefined || field !== "text" || delta === "") return;
      const partType = this.#partTypes.get(partId);
      // A chunk for a part we never saw announced has no row to belong to. OpenCode's
      // own client drops these rather than guessing, and guessing here would append a
      // thought to an answer.
      if (partType !== "text" && partType !== "reasoning") return;
      if (messageId !== undefined && (this.#messageRoles.get(messageId) ?? "assistant") !== "assistant") return;
      if (source === "primary" && sessionId !== undefined) {
        this.#emptyUnknownSequences.delete(sessionId);
        this.retireAmbiguousGuardAfterContinuationOutput(sessionId, messageId);
      }
      // Keep the snapshot in step so the closing message.part.updated, which repeats the
      // whole part, diffs to nothing instead of sending the body a second time.
      this.rememberPartText(partId, (this.#partTexts.get(partId) ?? "") + delta);
      if (source === "primary" && sessionId !== undefined
        && !this.isOwnedTerminalAssistantPart(sessionId, messageId)) {
        this.#settledOwnedSessions.delete(sessionId);
        this.cancelPendingOwnedCompletion(sessionId);
        this.#nativeStates.set(sessionId, "working");
        this.clearDisconnectedSession(sessionId);
      }
      return await this.emit({
        ...base,
        type: "message.delta",
        payload: {
          text: delta,
          partType,
          partId,
          ...(messageId !== undefined ? { messageId } : {}),
        },
      });
    }
    if (type === "question.asked") {
      this.#questionRevision += 1;
      const eventDirectory = isRecord(value) ? value.directory : undefined;
      const directory = typeof eventDirectory === "string" && eventDirectory !== "global" ? eventDirectory : this.#directory;
      return await this.publishQuestion(properties, source, directory, base.nativeEvent);
    }
    if (type === "question.replied" || type === "question.rejected") {
      this.#questionRevision += 1;
      if (typeof properties.requestID !== "string" || sessionId === undefined) return;
      return await this.resolveQuestion(`opencode_question_${properties.requestID}`, sessionId,
        type === "question.replied" ? "answered" : "cancelled", base.nativeEvent);
    }
    if (type === "permission.updated" || type === "permission.asked") {
      const permission = type === "permission.asked" ? properties : properties;
      const nativeId = typeof permission.id === "string" ? permission.id : undefined;
      const permissionSessionId = typeof permission.sessionID === "string" ? permission.sessionID : sessionId;
      if (nativeId === undefined || permissionSessionId === undefined) return;
      if (source === "primary") {
        this.#emptyUnknownSequences.delete(permissionSessionId);
        this.#settledOwnedSessions.delete(permissionSessionId);
        this.cancelPendingOwnedCompletion(permissionSessionId);
        this.#nativeStates.set(permissionSessionId, "working");
        this.clearDisconnectedSession(permissionSessionId);
      }
      const providerRequestId = `opencode_permission_${nativeId}`;
      this.#permissions.set(providerRequestId, { sessionId: permissionSessionId, nativePermissionId: nativeId });
      return await this.emit({
        providerSessionId: permissionSessionId,
        type: "approval.requested",
        payload: { providerRequestId },
        nativeEvent: asJsonObject(global),
        approval: {
          providerRequestId,
          providerSessionId: permissionSessionId,
          title: typeof permission.title === "string" ? permission.title : "OpenCode permission",
          affectedFiles: filePatterns(permission),
          networkDestinations: [],
          riskMetadata: asJsonObject(permission),
          choices: [
            { id: "approve", label: "Approve once", kind: "approve" },
            { id: "reject", label: "Reject", kind: "reject" },
          ],
        },
      });
    }
    if (type === "permission.replied") return await this.emit({ ...base, type: "approval.resolved", payload: asJsonObject(properties) });
    if (type === "command.executed") {
      if (source === "primary" && sessionId !== undefined) {
        this.#emptyUnknownSequences.delete(sessionId);
        this.#settledOwnedSessions.delete(sessionId);
        this.cancelPendingOwnedCompletion(sessionId);
        this.#nativeStates.set(sessionId, "working");
        this.clearDisconnectedSession(sessionId);
      }
      return await this.emit({ ...base, type: "command.completed", payload: asJsonObject(properties) });
    }
    // These are workspace/diff state notifications, not session-attributed
    // agent edits. In particular OpenCode emits `session.diff { diff: [] }` as
    // an immediate reset at the start of a turn. A message `patch` part above
    // is the authoritative, named evidence that files actually changed.
    if (type === "file.edited" || type === "file.watcher.updated" || type === "session.diff") return;
    if (type === "session.error") {
      if (source === "primary" && sessionId !== undefined && isOpenCodeAbortError(properties.error)) {
        const guard = this.#guardAbortGenerations.get(sessionId);
        if (guard?.outcome === "confirmed") return;
        if (guard !== undefined && this.#activePromptMessageIds.get(sessionId) === guard.parentId) {
          // A lost abort response is ambiguous. The abort-shaped provider event,
          // while the exact attempted generation still owns the session, proves
          // that our request acted and must finish as a clean guarded stop.
          guard.outcome = "confirmed";
          this.#guardActivityEpoch += 1;
          await this.beginGuardCompletion(sessionId, guard);
          return;
        }
        const terminalCleanup = this.#terminalCleanupGenerations.get(sessionId);
        if (terminalCleanup?.kind === "interrupted") {
          this.observeTerminalCleanup(terminalCleanup);
          return;
        }
      }
      if (source === "primary" && sessionId !== undefined) {
        const activePromptId = this.#activePromptMessageIds.get(sessionId);
        this.retireGuardGeneration(sessionId);
        this.rememberTerminalCleanupGeneration(sessionId, "failed", activePromptId);
        this.releaseOwnedPrompt(sessionId, activePromptId);
        this.#nativeStates.set(sessionId, "failed");
        this.clearDisconnectedSession(sessionId);
      }
      return await this.emit({ ...base, type: "agent.error", payload: { ...asJsonObject(properties), providerStatus: null } });
    }
  }

  /**
   * OpenCode republishes the whole part on every `message.part.updated`, so the
   * payload is a snapshot rather than a chunk. Consumers append chunks, which
   * turned a streaming answer into a pile of overlapping copies of itself.
   * Convert the snapshot into the text that is genuinely new.
   */
  private textDelta(partId: string | undefined, delta: unknown, snapshot: unknown): { readonly text: string; readonly replace: boolean } {
    const text = typeof snapshot === "string" ? snapshot : "";
    if (typeof delta === "string" && delta.length > 0) {
      if (partId !== undefined) this.rememberPartText(partId, text.length > 0 ? text : (this.#partTexts.get(partId) ?? "") + delta);
      return { text: delta, replace: false };
    }
    if (partId === undefined) return { text, replace: true };
    const previous = this.#partTexts.get(partId) ?? "";
    this.rememberPartText(partId, text);
    // A rewritten part (OpenCode can replace rather than extend one) resets the
    // row, so the whole new text is sent and marked as a replacement.
    if (!text.startsWith(previous)) return { text, replace: true };
    return { text: text.slice(previous.length), replace: false };
  }

  private rememberMessageRole(properties: Record<string, unknown>): void {
    const info = isRecord(properties.info) ? properties.info : properties;
    const id = typeof info.id === "string" ? info.id : undefined;
    const role = typeof info.role === "string" ? info.role : undefined;
    if (id === undefined || role === undefined) return;
    this.#messageRoles.delete(id);
    this.#messageRoles.set(id, role);
    while (this.#messageRoles.size > maxTrackedParts) {
      const oldest = this.#messageRoles.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#messageRoles.delete(oldest);
    }
  }

  private rememberSuppressedMessage(messageId: string): void {
    this.#suppressedMessageIds.delete(messageId);
    this.#suppressedMessageIds.add(messageId);
    while (this.#suppressedMessageIds.size > maxTrackedParts) {
      const oldest = this.#suppressedMessageIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#suppressedMessageIds.delete(oldest);
    }
  }

  /**
   * A no-tool `stop` should normally be followed by `session.idle`. Do not
   * interfere with that healthy path. Only abort after OpenCode actually starts
   * another assistant message for the same still-active prompt and persisted
   * history confirms that the prior response had no continuing tool call.
   */
  private async stopRunawayContinuation(sessionId: string, parentId: string, continuationAssistantId: string): Promise<RunawayStopResult> {
    return await this.stopGuardedRunaway(sessionId, parentId, continuationAssistantId, "completed");
  }

  private async maybeStopEmptyUnknownLoop(
    sessionId: string,
    parentId: string,
    assistantId: string,
    info: Record<string, unknown>,
  ): Promise<boolean> {
    if (!isCompletedUnknownOpenCodeAssistant(info)) {
      if (isCompletedOpenCodeAssistant(info)) this.#emptyUnknownSequences.delete(sessionId);
      return false;
    }
    if (!hasExplicitZeroOpenCodeUsage(info)) {
      this.#emptyUnknownSequences.delete(sessionId);
      return false;
    }
    const previous = this.#emptyUnknownSequences.get(sessionId);
    const assistantIds = previous?.parentId === parentId ? [...previous.assistantIds] : [];
    if (assistantIds.at(-1) === assistantId) return false;
    assistantIds.push(assistantId);
    while (assistantIds.length > emptyUnknownResponseLimit) assistantIds.shift();
    this.#emptyUnknownSequences.set(sessionId, { parentId, assistantIds });
    if (assistantIds.length < emptyUnknownResponseLimit || this.#guardAbortGenerations.has(sessionId)) return false;
    if (!await this.confirmQuietEmptyUnknownLoop(sessionId, parentId, assistantIds)) return false;
    const stopped = await this.stopGuardedRunaway(sessionId, parentId, assistantId, "failed");
    if (stopped.kind === "completed") {
      await stopped.completion;
      return true;
    }
    this.#emptyUnknownSequences.delete(sessionId);
    return false;
  }

  private async confirmQuietEmptyUnknownLoop(
    sessionId: string,
    parentId: string,
    assistantIds: readonly string[],
  ): Promise<boolean> {
    if (!await this.confirmEmptyUnknownLoop(sessionId, parentId, assistantIds)) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, ownedIdleQuietConfirmationMs));
    if (this.#disposed || this.#activePromptMessageIds.get(sessionId) !== parentId) return false;
    return await this.confirmEmptyUnknownLoop(sessionId, parentId, assistantIds);
  }

  private async confirmEmptyUnknownLoop(
    sessionId: string,
    parentId: string,
    assistantIds: readonly string[],
  ): Promise<boolean> {
    const value = await this.rawMessages(sessionId).catch((): unknown => undefined);
    if (!Array.isArray(value)) return false;
    const matching = value.filter((candidate) => {
      if (!isRecord(candidate)) return false;
      const info = isRecord(candidate.info) ? candidate.info : candidate;
      return info.role === "assistant" && info.parentID === parentId;
    });
    const tail = matching.slice(-assistantIds.length);
    if (tail.length !== assistantIds.length) return false;
    return tail.every((candidate, index) => {
      const entry = candidate as Record<string, unknown>;
      const info = isRecord(entry.info) ? entry.info : entry;
      return info.id === assistantIds[index] && isPersistedEmptyUnknownAssistant(entry);
    });
  }

  private async stopGuardedRunaway(
    sessionId: string,
    parentId: string,
    continuationAssistantId: string,
    terminalKind: GuardAbortGeneration["terminalKind"],
  ): Promise<RunawayStopResult> {
    return await this.withSessionLifecycleLock(sessionId, async () => {
      if (this.#activePromptMessageIds.get(sessionId) !== parentId) return { kind: "stale" };
      // Install narrow abort-error protection before the request. A timeout can
      // happen after the server acted, so rejection must not remove this marker.
      const guard = this.rememberGuardAbortGeneration(sessionId, parentId, continuationAssistantId, terminalKind);
      const aborted = await this.#client.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, { query: this.query() })
        .then(() => true, () => false);
      if (this.#guardAbortGenerations.get(sessionId) !== guard) return { kind: "stale" };
      // A matching abort event can confirm the attempt while its HTTP response is
      // still in flight. Never demote that stronger evidence afterward.
      if (guard.outcome === "confirmed") {
        return { kind: "completed", completion: this.beginGuardCompletion(sessionId, guard) };
      }
      guard.outcome = aborted ? "confirmed" : "uncertain";
      this.#guardActivityEpoch += 1;
      if (!aborted) return { kind: "uncertain" };
      // OpenCode's abort handler awaits runner cancellation. That cancellation
      // publishes the abort error and idle finalizers before the HTTP response,
      // so a later successor message on this same SSE feed is a real FIFO fence.
      // The lock prevents a new prompt from being accepted during the session-
      // wide abort. Keep the ownership check as a generation invariant anyway.
      if (this.#activePromptMessageIds.get(sessionId) !== parentId) return { kind: "stale" };
      // Starting the completion while the lock is still held invokes every sink
      // before a queued send can dispatch. We deliberately do not await it here:
      // a sink is allowed to send the next prompt without deadlocking this lock.
      return { kind: "completed", completion: this.beginGuardCompletion(sessionId, guard) };
    });
  }

  private async confirmNoToolTerminal(
    sessionId: string,
    parentId: string,
    assistantId: string,
    continuationAssistantId: string,
  ): Promise<TerminalConfirmation> {
    return await this.confirmPromptTerminal(sessionId, parentId, assistantId, continuationAssistantId);
  }

  private beginGuardCompletion(sessionId: string, guard: GuardAbortGeneration): Promise<void> {
    if (guard.completion !== undefined) return guard.completion;
    this.rememberRunawayPrompt(guard.parentId);
    this.rememberSuppressedMessage(guard.continuationAssistantId);
    this.rememberSettledOwnedSession(sessionId, guard.parentId, this.#terminalPromptCandidates.get(guard.parentId) ?? guard.continuationAssistantId);
    if (this.#disposed || !this.releaseOwnedPrompt(sessionId, guard.parentId)) {
      guard.completion = Promise.resolve();
      return guard.completion;
    }
    this.#nativeStates.set(sessionId, guard.terminalKind === "failed" ? "failed" : "idle");
    // AgentBridge intentionally strips raw provider metadata. This exact marker
    // is the only completion allowed to bypass renderer quieting.
    guard.completion = guard.terminalKind === "failed"
      ? this.emit({
          providerSessionId: sessionId,
          type: "agent.error",
          payload: {
            code: "EMPTY_RESPONSE_LOOP",
            message: "OpenCode returned repeated empty responses, so Tethoq stopped the turn. Retry or choose another model.",
            providerStatus: null,
          },
        })
      : this.emit({
          providerSessionId: sessionId,
          type: "agent.completed",
          payload: { completionReason: "runaway_guard", providerStatus: null },
        });
    return guard.completion;
  }

  private async confirmQuietNoToolTerminal(
    sessionId: string,
    parentId: string,
    assistantId: string,
    continuationAssistantId: string,
  ): Promise<TerminalConfirmation> {
    const first = await this.confirmNoToolTerminal(sessionId, parentId, assistantId, continuationAssistantId);
    if (first.kind === "continuing") return first;
    await new Promise<void>((resolve) => setTimeout(resolve, ownedIdleQuietConfirmationMs));
    if (this.#disposed || this.#activePromptMessageIds.get(sessionId) !== parentId
      || this.#terminalPromptCandidates.get(parentId) !== assistantId) {
      return { kind: "unavailable" };
    }
    const second = await this.confirmNoToolTerminal(sessionId, parentId, assistantId, continuationAssistantId);
    if (second.kind === "continuing") return second;
    // Both reads must see the same causal watermark. A single later snapshot is
    // not enough to prove a tool part cannot still be catching up behind it.
    return first.kind === "terminal" && second.kind === "terminal"
      ? second
      : { kind: "unavailable" };
  }

  /** Confirms either one exact assistant or the newest assistant for this prompt. */
  private async confirmPromptTerminal(
    sessionId: string,
    parentId: string,
    assistantId?: string,
    continuationAssistantId?: string,
    requireSelectedTail = false,
    requireLatestPrompt = false,
  ): Promise<TerminalConfirmation> {
    const value = await this.rawMessages(sessionId, requireSelectedTail ? 2 : 500).catch((): unknown => undefined);
    if (!Array.isArray(value)) return { kind: "unavailable" };
    let selected: Record<string, unknown> | undefined;
    let continuationPersisted = continuationAssistantId === undefined;
    let selectedCreated = Number.NEGATIVE_INFINITY;
    let selectedIndex = -1;
    let latestAssistantId: string | undefined;
    let latestAssistantCreated = Number.NEGATIVE_INFINITY;
    let latestAssistantCompleted = Number.NEGATIVE_INFINITY;
    let latestAssistantIndex = -1;
    for (const [index, candidate] of value.entries()) {
      if (!isRecord(candidate)) continue;
      const info = isRecord(candidate.info) ? candidate.info : candidate;
      if (info.role !== "assistant" || info.parentID !== parentId) continue;
      const time = isRecord(info.time) ? info.time : {};
      const created = typeof time.created === "number" ? time.created : Number.NEGATIVE_INFINITY;
      const completed = typeof time.completed === "number" ? time.completed : Number.NEGATIVE_INFINITY;
      if (created > latestAssistantCreated
        || (created === latestAssistantCreated && completed > latestAssistantCompleted)
        || (created === latestAssistantCreated && completed === latestAssistantCompleted && index > latestAssistantIndex)) {
        latestAssistantId = typeof info.id === "string" ? info.id : undefined;
        latestAssistantCreated = created;
        latestAssistantCompleted = completed;
        latestAssistantIndex = index;
      }
      if (info.id === continuationAssistantId) continuationPersisted = true;
      if (assistantId !== undefined) {
        if (info.id === assistantId) {
          selected = candidate;
        }
        // Keep scanning: the causal continuation normally follows this terminal
        // record in chronological history.
        continue;
      }
      if (created > selectedCreated || (created === selectedCreated && index > selectedIndex)) {
        selected = candidate;
        selectedCreated = created;
        selectedIndex = index;
      }
    }
    // The live event alone is not enough to stop a whole session. Requiring the
    // suspicious second assistant in the same persisted snapshot is a causal
    // watermark: persistence has advanced beyond the prior terminal response,
    // so any preceding tool continuation would be visible to this check too.
    if (!continuationPersisted) return { kind: "unavailable" };
    if (selected === undefined) return { kind: "unavailable" };
    const info = isRecord(selected.info) ? selected.info : selected;
    if (requireLatestPrompt) {
      // External follow-ups can exist in history before their SSE reaches us.
      // Never settle an older parent just because its own assistant is terminal.
      const latest = value.map((entry) => isRecord(entry) && isRecord(entry.info) ? entry.info : entry)
        .filter((entry): entry is Record<string, unknown> => isRecord(entry) && (entry.role === "user" || entry.role === "assistant"))
        .at(-1);
      if (latest?.id !== info.id) return { kind: "continuing" };
    }
    // A later same-parent assistant already persisted but has not necessarily
    // reached this SSE consumer yet. Do not complete the earlier candidate and
    // race the existing runaway/tool-continuation guard.
    if (requireSelectedTail && info.id !== latestAssistantId) return { kind: "unavailable" };
    const parts = Array.isArray(selected.parts) ? selected.parts : [];
    if (parts.some(isContinuingOpenCodeToolPart)) return { kind: "continuing" };
    if (info.error !== undefined || info.summary === true) return { kind: "continuing" };
    // OpenCode writes `finish` at step-finish and `time.completed` only later in
    // cleanup (snapshot/title/plugins). Missing finish is a lagging persist, not
    // proof the model will continue.
    if (typeof info.finish !== "string" || info.finish.length === 0) return { kind: "unavailable" };
    if (!isOpenCodeTurnExitFinish(info.finish)) return { kind: "continuing" };
    return { kind: "terminal", assistantId: typeof info.id === "string" ? info.id : assistantId ?? "" };
  }

  private rememberPendingOwnedIdle(
    sessionId: string,
    parentId: string,
    nativeEvent?: JsonObject,
    assistantId?: string,
  ): void {
    const existing = this.#pendingOwnedIdles.get(sessionId);
    if (existing?.parentId === parentId) {
      const discoveredAssistant = assistantId !== undefined && existing.assistantId !== assistantId;
      if (nativeEvent !== undefined) existing.nativeEvent = nativeEvent;
      if (assistantId !== undefined) existing.assistantId = assistantId;
      // Duplicate wrap-up updates and a later session.idle must not reset the
      // quiet confirmation; OpenCode republishes the same completed assistant
      // while the runner is still busy.
      if (discoveredAssistant) this.restartPendingOwnedIdleRecheck(sessionId, parentId);
      return;
    }
    this.clearPendingOwnedIdle(sessionId);
    const pending: PendingOwnedIdle = {
      parentId,
      ownedPromptId: this.#activePromptMessageIds.get(sessionId),
      assistantId,
      nativeEvent,
      attempts: 0,
      timer: undefined,
      revision: 0,
      confirmedAssistantId: undefined,
      checksInFlight: 0,
    };
    this.#pendingOwnedIdles.set(sessionId, pending);
    while (this.#pendingOwnedIdles.size > maxTrackedParts) {
      const oldest = this.#pendingOwnedIdles.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.clearPendingOwnedIdle(oldest);
    }
    this.schedulePendingOwnedIdleRecheck(sessionId, pending);
  }

  private restartPendingOwnedIdleRecheck(sessionId: string, parentId: string): void {
    const pending = this.#pendingOwnedIdles.get(sessionId);
    if (pending?.parentId !== parentId) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    pending.attempts = 0;
    pending.revision += 1;
    pending.confirmedAssistantId = undefined;
    this.#activeSettleDeadlines.delete(sessionId);
    this.schedulePendingOwnedIdleRecheck(sessionId, pending);
  }

  private schedulePendingOwnedIdleRecheck(sessionId: string, pending: PendingOwnedIdle, delayOverride?: number): void {
    if (this.#disposed || pending.timer !== undefined) return;
    // Persistence can lag beyond the initial burst. Keep checking the tiny tail
    // on the existing recovery cadence; elapsed time never proves completion.
    const delay = delayOverride ?? ownedIdleConfirmationDelaysMs[pending.attempts] ?? knownActiveSafetyPollIntervalMs;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void this.recheckPendingOwnedIdle(sessionId, pending);
    }, delay);
  }

  private async recheckPendingOwnedIdle(sessionId: string, pending: PendingOwnedIdle): Promise<void> {
    if (this.#disposed || this.#pendingOwnedIdles.get(sessionId) !== pending
      || this.#activePromptMessageIds.get(sessionId) !== pending.ownedPromptId) {
      if (this.#pendingOwnedIdles.get(sessionId) === pending) this.clearPendingOwnedIdle(sessionId);
      return;
    }
    const revision = pending.revision;
    pending.checksInFlight += 1;
    const confirmation = await this.confirmPromptTerminal(
      sessionId,
      pending.parentId,
      pending.assistantId,
      undefined,
      pending.assistantId !== undefined,
      pending.ownedPromptId === undefined,
    );
    pending.checksInFlight -= 1;
    if (this.#disposed || this.#pendingOwnedIdles.get(sessionId) !== pending
      || this.#activePromptMessageIds.get(sessionId) !== pending.ownedPromptId
      || pending.revision !== revision) return;
    if (confirmation.kind === "continuing") {
      this.#terminalPromptCandidates.delete(pending.parentId);
      this.cancelPendingOwnedCompletion(sessionId);
      return;
    }
    if (confirmation.kind === "terminal") {
      if (pending.confirmedAssistantId !== confirmation.assistantId) {
        pending.confirmedAssistantId = confirmation.assistantId;
        pending.attempts = 0;
        this.schedulePendingOwnedIdleRecheck(sessionId, pending, ownedIdleQuietConfirmationMs);
        return;
      }
      const nativeEvent = pending.nativeEvent;
      this.rememberSettledOwnedSession(sessionId, pending.parentId, confirmation.assistantId);
      this.releaseOwnedPrompt(sessionId, pending.ownedPromptId);
      this.#nativeStates.set(sessionId, "idle");
      await this.emit({
        providerSessionId: sessionId,
        ...(nativeEvent !== undefined ? { nativeEvent } : {}),
        type: "agent.completed",
        payload: { providerStatus: null },
      });
      return;
    }
    pending.confirmedAssistantId = undefined;
    pending.attempts += 1;
    this.schedulePendingOwnedIdleRecheck(sessionId, pending);
  }

  private clearPendingOwnedIdle(sessionId: string): void {
    const pending = this.#pendingOwnedIdles.get(sessionId);
    if (pending?.timer !== undefined) clearTimeout(pending.timer);
    this.#pendingOwnedIdles.delete(sessionId);
  }

  private cancelPendingOwnedCompletion(sessionId: string): void {
    this.clearPendingOwnedIdle(sessionId);
    this.#activeSettleDeadlines.delete(sessionId);
  }

  private clearDisconnectedSession(sessionId: string): void {
    this.#disconnectedActiveSessionIds.delete(sessionId);
    this.#disconnectedNativeSessionIds.delete(sessionId);
    this.#disconnectedPersistedSessionIds.delete(sessionId);
  }

  private releaseOwnedPrompt(sessionId: string, expectedParentId?: string): boolean {
    const parentId = this.#activePromptMessageIds.get(sessionId);
    if (expectedParentId !== undefined && parentId !== expectedParentId) return false;
    this.cancelPendingOwnedCompletion(sessionId);
    this.#activePrompts.delete(sessionId);
    this.#activePromptMessageIds.delete(sessionId);
    this.#persistedWorking.delete(sessionId);
    this.#emptyUnknownSequences.delete(sessionId);
    this.clearDisconnectedSession(sessionId);
    if (parentId !== undefined) this.#terminalPromptCandidates.delete(parentId);
    return true;
  }

  private rememberContinuingToolMessage(messageId: string): void {
    this.#continuingToolMessageIds.delete(messageId);
    this.#continuingToolMessageIds.add(messageId);
    while (this.#continuingToolMessageIds.size > maxTrackedParts) {
      const oldest = this.#continuingToolMessageIds.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#continuingToolMessageIds.delete(oldest);
    }
  }

  private rememberTerminalCandidate(parentId: string, assistantId: string): void {
    this.#terminalPromptCandidates.delete(parentId);
    this.#terminalPromptCandidates.set(parentId, assistantId);
    while (this.#terminalPromptCandidates.size > maxTrackedParts) {
      const oldest = this.#terminalPromptCandidates.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#terminalPromptCandidates.delete(oldest);
    }
  }

  private forgetTerminalCandidateForMessage(messageId: string): void {
    for (const [parentId, assistantId] of this.#terminalPromptCandidates) {
      if (assistantId === messageId) this.#terminalPromptCandidates.delete(parentId);
    }
  }

  private isTerminalCandidatePartForActivePrompt(sessionId: string, messageId: string | undefined): boolean {
    if (messageId === undefined) return false;
    const activePromptId = this.#activePromptMessageIds.get(sessionId);
    return activePromptId !== undefined && this.#terminalPromptCandidates.get(activePromptId) === messageId;
  }

  private isOwnedTerminalAssistantPart(sessionId: string, messageId: string | undefined): boolean {
    if (messageId === undefined) return false;
    if (this.#pendingOwnedIdles.get(sessionId)?.assistantId === messageId) return true;
    if (this.isTerminalCandidatePartForActivePrompt(sessionId, messageId)) return true;
    const settled = this.#settledOwnedSessions.get(sessionId);
    return settled !== undefined && settled.assistantId === messageId && !this.#activePromptMessageIds.has(sessionId);
  }

  private hasTerminalOwnedIdleArmed(sessionId: string): boolean {
    return this.#pendingOwnedIdles.get(sessionId)?.assistantId !== undefined;
  }

  private isSettledOwnedSession(sessionId: string): boolean {
    return this.#settledOwnedSessions.has(sessionId) && !this.#activePromptMessageIds.has(sessionId);
  }

  private shouldIgnoreWrapUpWorking(sessionId: string): boolean {
    return this.hasTerminalOwnedIdleArmed(sessionId) || this.isSettledOwnedSession(sessionId);
  }

  private isSettledTerminalRepeat(sessionId: string, info: Record<string, unknown>): boolean {
    const settled = this.#settledOwnedSessions.get(sessionId);
    if (settled === undefined || this.#activePromptMessageIds.has(sessionId)) return false;
    return info.role === "assistant"
      && info.id === settled.assistantId
      && (typeof info.parentID !== "string" || info.parentID === settled.parentId)
      && isOpenCodeTurnExitFinish(info.finish);
  }

  private rememberSettledOwnedSession(sessionId: string, parentId: string, assistantId: string): void {
    this.#settledOwnedSessions.delete(sessionId);
    this.#settledOwnedSessions.set(sessionId, { parentId, assistantId });
    while (this.#settledOwnedSessions.size > maxTrackedParts) {
      const oldest = this.#settledOwnedSessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#settledOwnedSessions.delete(oldest);
    }
  }

  private armTerminalCompletion(sessionId: string, info: Record<string, unknown>, nativeEvent?: JsonObject): void {
    const ownedPromptId = this.#activePromptMessageIds.get(sessionId);
    if (info.role !== "assistant" || typeof info.id !== "string" || typeof info.parentID !== "string"
      || (ownedPromptId !== undefined && ownedPromptId !== info.parentID)
      || !isOpenCodeTurnExitFinish(info.finish) || info.error !== undefined || info.summary === true
      || this.#continuingToolMessageIds.has(info.id) || this.isSettledTerminalRepeat(sessionId, info)
      || this.#guardAbortGenerations.has(sessionId) || this.#terminalCleanupGenerations.has(sessionId)) return;
    if (ownedPromptId !== undefined) this.rememberTerminalCandidate(info.parentID, info.id);
    // Use the same persisted-history proof for observed turns without adopting
    // them into the dispatch/abort ownership maps.
    this.rememberPendingOwnedIdle(sessionId, info.parentID, nativeEvent, info.id);
  }

  private rememberRunawayPrompt(parentId: string): void {
    this.#runawayPromptParents.delete(parentId);
    this.#runawayPromptParents.add(parentId);
    while (this.#runawayPromptParents.size > maxTrackedParts) {
      const oldest = this.#runawayPromptParents.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#runawayPromptParents.delete(oldest);
    }
  }

  private rememberTerminalCleanupGeneration(
    sessionId: string,
    kind: TerminalCleanupGeneration["kind"],
    parentId: string | undefined,
  ): TerminalCleanupGeneration {
    this.cancelPendingOwnedCompletion(sessionId);
    let resolveCleanupObserved!: () => void;
    const cleanupObservedSignal = new Promise<void>((resolve) => { resolveCleanupObserved = resolve; });
    const generation: TerminalCleanupGeneration = {
      kind,
      parentId,
      successorMessageId: undefined,
      cleanupObserved: false,
      cleanupObservedSignal,
      resolveCleanupObserved,
      interruption: undefined,
    };
    this.#terminalCleanupGenerations.get(sessionId)?.resolveCleanupObserved();
    this.#terminalCleanupGenerations.delete(sessionId);
    this.#terminalCleanupGenerations.set(sessionId, generation);
    this.#guardActivityEpoch += 1;
    while (this.#terminalCleanupGenerations.size > maxTrackedParts) {
      const oldest = this.#terminalCleanupGenerations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#terminalCleanupGenerations.get(oldest)?.resolveCleanupObserved();
      this.#terminalCleanupGenerations.delete(oldest);
      this.#guardActivityEpoch += 1;
    }
    return generation;
  }

  private observeTerminalCleanup(generation: TerminalCleanupGeneration): void {
    if (generation.cleanupObserved) return;
    generation.cleanupObserved = true;
    generation.resolveCleanupObserved();
  }

  private async waitForTerminalCleanupGeneration(
    sessionId: string,
    generation: TerminalCleanupGeneration,
  ): Promise<void> {
    if (generation.cleanupObserved || this.#terminalCleanupGenerations.get(sessionId) !== generation) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, manualInterruptCleanupGraceMs);
    });
    try {
      await Promise.race([generation.cleanupObservedSignal, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private beginManualInterruption(sessionId: string, generation: TerminalCleanupGeneration): Promise<void> {
    if (generation.interruption !== undefined) return generation.interruption;
    if (this.#disposed || this.#terminalCleanupGenerations.get(sessionId) !== generation) {
      generation.interruption = Promise.resolve();
      return generation.interruption;
    }
    this.releaseOwnedPrompt(sessionId, generation.parentId);
    this.#nativeStates.set(sessionId, "idle");
    generation.interruption = this.emit({
      providerSessionId: sessionId,
      type: "agent.interrupted",
      payload: { providerStatus: null },
    });
    return generation.interruption;
  }

  private retireTerminalCleanupAtNewGenerationBoundary(
    sessionId: string,
    info: Record<string, unknown>,
    activePromptId: string | undefined,
  ): void {
    const generation = this.#terminalCleanupGenerations.get(sessionId);
    if (generation === undefined) return;
    const role = typeof info.role === "string" ? info.role : undefined;
    const messageId = typeof info.id === "string" ? info.id : undefined;
    const parentId = typeof info.parentID === "string" ? info.parentID : undefined;
    const boundaryPromptId = generation.successorMessageId
      ?? (activePromptId !== generation.parentId ? activePromptId : undefined);
    const acknowledgesOwnedSuccessor = boundaryPromptId !== undefined
      && ((role === "user" && messageId === boundaryPromptId)
        || (role === "assistant" && parentId === boundaryPromptId));
    const acknowledgesExternalSuccessor = activePromptId === undefined
      && ((role === "user" && messageId !== undefined && messageId !== generation.parentId)
        || (role === "assistant" && parentId !== undefined && parentId !== generation.parentId));
    if (acknowledgesOwnedSuccessor || acknowledgesExternalSuccessor) {
      this.retireTerminalCleanupGeneration(sessionId, generation);
    }
  }

  private retireTerminalCleanupGeneration(sessionId: string, expected?: TerminalCleanupGeneration): void {
    const generation = this.#terminalCleanupGenerations.get(sessionId);
    if (generation === undefined || (expected !== undefined && generation !== expected)) return;
    generation.resolveCleanupObserved();
    this.#terminalCleanupGenerations.delete(sessionId);
    this.#guardActivityEpoch += 1;
  }

  /**
   * Cleanup remains attributable to the guarded runner only until OpenCode
   * publishes a concrete message for a newer prompt. The abort endpoint awaits
   * cancellation and its error/idle publications before responding; Tethoq holds
   * the session lock until then. The newer message is therefore the provider's
   * FIFO generation boundary after which normal abort errors stay visible.
   */
  private retireGuardAtNewGenerationBoundary(
    sessionId: string,
    info: Record<string, unknown>,
    activePromptId: string | undefined,
  ): void {
    const guard = this.#guardAbortGenerations.get(sessionId);
    if (guard === undefined) return;
    const role = typeof info.role === "string" ? info.role : undefined;
    const messageId = typeof info.id === "string" ? info.id : undefined;
    const parentId = typeof info.parentID === "string" ? info.parentID : undefined;
    const boundaryPromptId = guard.successorMessageId
      ?? (activePromptId !== guard.parentId ? activePromptId : undefined);
    const acknowledgesOwnedSuccessor = boundaryPromptId !== undefined
      && ((role === "user" && messageId === boundaryPromptId)
        || (role === "assistant" && parentId === boundaryPromptId));
    const acknowledgesExternalSuccessor = activePromptId === undefined
      && ((role === "user" && messageId !== undefined && messageId !== guard.parentId)
        || (role === "assistant" && parentId !== undefined && parentId !== guard.parentId));
    if (acknowledgesOwnedSuccessor || acknowledgesExternalSuccessor) this.retireGuardGeneration(sessionId, guard);
  }

  /** Fresh output after a rejected abort proves that uncertain attempt no longer owns a later error. */
  private retireAmbiguousGuardAfterContinuationOutput(sessionId: string, messageId: string | undefined): void {
    if (messageId === undefined) return;
    const guard = this.#guardAbortGenerations.get(sessionId);
    if (guard?.outcome !== "uncertain"
      || guard.continuationAssistantId !== messageId
      || this.#activePromptMessageIds.get(sessionId) !== guard.parentId) return;
    this.retireGuardGeneration(sessionId, guard);
  }

  private rememberGuardAbortGeneration(
    sessionId: string,
    parentId: string,
    continuationAssistantId: string,
    terminalKind: GuardAbortGeneration["terminalKind"],
  ): GuardAbortGeneration {
    const guard: GuardAbortGeneration = {
      parentId,
      continuationAssistantId,
      terminalKind,
      outcome: "attempting",
      successorMessageId: undefined,
      completion: undefined,
    };
    this.#guardAbortGenerations.delete(sessionId);
    this.#guardAbortGenerations.set(sessionId, guard);
    this.#guardActivityEpoch += 1;
    while (this.#guardAbortGenerations.size > maxTrackedParts) {
      const oldest = this.#guardAbortGenerations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#guardAbortGenerations.delete(oldest);
      this.#guardActivityEpoch += 1;
    }
    return guard;
  }

  private retireGuardGeneration(sessionId: string, expected?: GuardAbortGeneration): void {
    const guard = this.#guardAbortGenerations.get(sessionId);
    if (guard === undefined || (expected !== undefined && guard !== expected)) return;
    this.#guardAbortGenerations.delete(sessionId);
    this.#guardActivityEpoch += 1;
  }

  private rememberPartType(partId: string, partType: string): void {
    this.#partTypes.delete(partId);
    this.#partTypes.set(partId, partType);
    while (this.#partTypes.size > maxTrackedParts) {
      const oldest = this.#partTypes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#partTypes.delete(oldest);
    }
  }

  private rememberPartText(partId: string, text: string): void {
    this.#partTexts.delete(partId);
    this.#partTexts.set(partId, text);
    while (this.#partTexts.size > maxTrackedParts) {
      const oldest = this.#partTexts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#partTexts.delete(oldest);
    }
  }

  private async emit(input: Omit<ProviderEvent, "eventId" | "providerId" | "occurredAt">): Promise<void> {
    if (input.providerSessionId !== undefined && (input.type === "agent.interrupted" || input.type === "agent.completed" || input.type === "agent.error")) {
      this.#questionRevision += 1;
      for (const [providerRequestId, pending] of this.#questions) {
        if (pending.sessionId === input.providerSessionId) await this.resolveQuestion(providerRequestId, pending.sessionId, "cancelled");
      }
    }
    if (input.type !== "provider.connected" && input.type !== "provider.disconnected") {
      this.#sessionListSnapshotGeneration += 1;
      this.#sessionListSnapshots.clear();
    }
    await this.#events.emit({ eventId: `opencode_event_${this.#eventNamespace}_${++this.#eventCounter}`, providerId: this.providerId, occurredAt: this.#now().toISOString(), ...input });
  }

  private async publishReportedSelection(
    providerSessionId: string,
    info: Record<string, unknown>,
    options: { readonly source: "history" | "live"; readonly nativeEvent?: JsonObject },
  ): Promise<void> {
    const selection = openCodeMessageSelection(info);
    if (selection === undefined) return;
    const key = JSON.stringify([selection.modelId, selection.variantId ?? null]);
    const previous = this.#reportedSelections.get(providerSessionId);
    if (previous?.key === key) {
      if (selection.messageCreatedAt !== undefined
        && (previous.messageCreatedAt === undefined || selection.messageCreatedAt > previous.messageCreatedAt)) {
        this.#reportedSelections.set(providerSessionId, { key, messageCreatedAt: selection.messageCreatedAt });
      }
      return;
    }
    if (previous !== undefined) {
      if (previous.messageCreatedAt !== undefined
        && (selection.messageCreatedAt === undefined || selection.messageCreatedAt < previous.messageCreatedAt)) return;
      // A history refresh with no usable ordering evidence must never overwrite
      // the newer selection already observed from the live feed.
      if (options.source === "history" && previous.messageCreatedAt === undefined && selection.messageCreatedAt === undefined) return;
    }
    this.#reportedSelections.set(providerSessionId, {
      key,
      ...(selection.messageCreatedAt !== undefined ? { messageCreatedAt: selection.messageCreatedAt } : {}),
    });
    const { messageCreatedAt: _messageCreatedAt, ...payload } = selection;
    await this.emit({
      providerSessionId,
      type: "session.updated",
      payload,
      ...(options.nativeEvent !== undefined ? { nativeEvent: options.nativeEvent } : {}),
    });
  }

  private async withSessionLifecycleLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionLifecycleTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.#sessionLifecycleTails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#sessionLifecycleTails.get(sessionId) === tail) this.#sessionLifecycleTails.delete(sessionId);
    }
  }

  private captureNativeStates(snapshot: NativeStatusSnapshot): void {
    const next = new Map<string, RemoteSession["state"]>();
    const nextStatuses = new Map<string, unknown>();
    for (const [sessionId, status] of Object.entries(snapshot.statuses)) {
      const normalized = normalizeStatus(status);
      if (normalized === "working"
        && (this.#guardAbortGenerations.get(sessionId)?.outcome === "confirmed"
          || this.#terminalCleanupGenerations.has(sessionId)
          || this.isSettledOwnedSession(sessionId))) continue;
      next.set(sessionId, normalized);
      nextStatuses.set(sessionId, status);
    }
    // The HTTP response has no sequence number. Preserve any per-session state
    // changed by primary SSE after this request began instead of letting a slow
    // old snapshot overwrite the newer event.
    for (const [sessionId, state] of this.#nativeStates) {
      if ((this.#nativeEventRevisionBySession.get(sessionId) ?? 0) > snapshot.nativeEventRevisionAtStart) {
        next.set(sessionId, state);
        if (this.#nativeStatuses.has(sessionId)) nextStatuses.set(sessionId, this.#nativeStatuses.get(sessionId));
      }
    }
    this.#nativeStates = next;
    this.#nativeStatuses = nextStatuses;
  }

  private nativeWorkingSessionIds(): ReadonlySet<string> {
    return new Set([...this.#nativeStates].flatMap(([sessionId, state]) => state === "working" ? [sessionId] : []));
  }

  private resolvedStatus(sessionId: string, nativeStatus: unknown, persistedWorking: ReadonlySet<string>): unknown {
    return normalizeStatus(nativeStatus) === "unknown" && persistedWorking.has(sessionId) ? "busy" : nativeStatus;
  }

  private activityDerivedState(providerSessionId: string, normalizedState: RemoteSession["state"]): RemoteSession["state"] {
    if (this.#primaryEventStreamDisconnected || this.#disconnectedActiveSessionIds.has(providerSessionId)) return "disconnected";
    if ([...this.#questions.values()].some((question) => question.sessionId === providerSessionId)) return "needs_input";
    if (normalizedState === "failed" || normalizedState === "needs_approval" || normalizedState === "needs_input") return normalizedState;
    if (this.#activePrompts.has(providerSessionId) || this.#activePromptMessageIds.has(providerSessionId)) return "working";
    if (this.isSettledOwnedSession(providerSessionId)) return "idle";
    if (normalizedState !== "unknown") return normalizedState;
    // Until one bounded database read succeeds, an empty status response from
    // Tethoq's separate server cannot prove a Desktop-owned task is idle.
    return this.#persistedActivityAvailable ? "idle" : "unknown";
  }

  private async tryReadPersistedWorking(
    sessionIds: ReadonlySet<string>,
    discovery?: "recent" | "complete",
  ): Promise<ReadonlySet<string> | undefined> {
    return await this.#activityReader.readWorkingSessionIds(
      sessionIds,
      discovery === undefined
        ? undefined
        : { discoverRecent: true, ...(discovery === "complete" ? { discoverAll: true } : {}) },
    ).catch(() => undefined);
  }

  private async activityDelay(maximumWaitMs?: number): Promise<void> {
    if (this.#activityRefreshRequested) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (this.#activityDelayWake === finish) this.#activityDelayWake = undefined;
        this.#abort.signal.removeEventListener("abort", finish);
        resolve();
      };
      this.#activityDelayWake = finish;
      const knownActiveWait = this.#activePrompts.size > 0 || this.#persistedWorking.size > 0
        ? knownActiveSafetyPollIntervalMs
        : this.#activityPollIntervalMs;
      timer = setTimeout(finish, Math.min(this.#activityPollIntervalMs, knownActiveWait, maximumWaitMs ?? this.#activityPollIntervalMs));
      this.#abort.signal.addEventListener("abort", finish, { once: true });
      if (this.#activityRefreshRequested) finish();
    });
  }

  private ensureActivityChangeWatch(): void {
    if (this.#stopActivityChangeWatch !== undefined || this.#activityReader.watchChanges === undefined) return;
    this.#stopActivityChangeWatch = this.#activityReader.watchChanges(() => {
      if (this.#disposed || this.#activityChangeDebounce !== undefined) return;
      this.armActivityChangeWake(activityChangeSettleMs);
    });
  }

  private armActivityChangeWake(waitMs: number): void {
    if (this.#disposed || this.#activityChangeDebounce !== undefined) return;
    this.#activityChangeDebounce = setTimeout(() => {
      this.#activityChangeDebounce = undefined;
      if (this.#disposed) return;
      if (this.#initialActivitySnapshot !== undefined && !this.#persistedActivityAvailable) {
        this.armActivityChangeWake(activityChangeSettleMs);
        return;
      }
      // Startup or another provider-wide read may have established a newer
      // deadline while this timer was settling the commit. Recompute here so
      // the wake goes straight to discovery rather than causing an exact read.
      const discoveryWait = Math.max(0, this.#nextActivityDiscoveryAt - this.#now().getTime());
      if (discoveryWait > 0) {
        this.armActivityChangeWake(discoveryWait);
        return;
      }
      this.#activityDiscoveryPending = true;
      this.#activityRefreshRequested = true;
      this.#activityDelayWake?.();
    }, waitMs);
  }
}

function parseModel(modelId: string): { readonly providerID: string; readonly modelID: string } | undefined {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
}

function openCodeTurnToolOverrides(request: SendMessageRequest, visionHelper = false): Readonly<Record<string, boolean>> {
  // OpenCode converts these overrides into session permission rules and removes
  // denied tools from the model request, including arbitrary MCP/plugin names.
  // Reassert on every helper turn, including helpers restored after a restart.
  if (visionHelper || request.metadata?.internalPurpose === "vision_proxy") return { "*": false };
  // OpenCode catalogues custom plugin definitions provider-wide even when a
  // prompt denies execution. The installed definition is therefore neutral;
  // these per-turn flags grant execution only for an explicitly routed image.
  // Keep the former key until already-running OpenCode processes reload.
  const enabled = request.clientToolOverrides?.ask_eyes === true;
  return {
    uar_mesh_ask_eyes: enabled,
    uar_mesh_tethoq_turn_support: enabled,
  };
}

function completedOpenCodeBranchBody(history: readonly unknown[]): Record<string, never> | { readonly messageID: string } | undefined {
  let latestSafeIndex = -1;
  for (let index = 0; index < history.length; index += 1) {
    const candidate = history[index];
    if (!isRecord(candidate)) continue;
    const info = isRecord(candidate.info) ? candidate.info : candidate;
    const parts = Array.isArray(candidate.parts) ? candidate.parts : [];
    if (!isCompletedOpenCodeAssistant(info)
      || (info.finish !== "stop" && info.finish !== "length")
      || parts.some(isContinuingOpenCodeToolPart)) continue;
    if (typeof info.id === "string" && info.id.length > 0) latestSafeIndex = index;
  }
  if (latestSafeIndex < 0) return undefined;

  // OpenCode's native fork boundary is exclusive: it clones every message
  // before `messageID`. Point at the first unsafe trailing message so the
  // completed assistant response remains in the child. When that response is
  // already the tail, omitting the boundary safely clones the whole history.
  const next = history[latestSafeIndex + 1];
  if (next === undefined) return {};
  if (!isRecord(next)) return undefined;
  const nextInfo = isRecord(next.info) ? next.info : next;
  return typeof nextInfo.id === "string" && nextInfo.id.length > 0
    ? { messageID: nextInfo.id }
    : undefined;
}

function openCodeCompactionMarkerIds(history: readonly unknown[], excluded: ReadonlySet<string> = new Set()): ReadonlySet<string> {
  const markers = new Set<string>();
  for (const entry of history) {
    if (!isRecord(entry)) continue;
    const info = isRecord(entry.info) ? entry.info : entry;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    if (info.role !== "user" || !parts.some((part) => isRecord(part) && part.type === "compaction")) continue;
    if (typeof info.id === "string" && !excluded.has(info.id)) markers.add(info.id);
  }
  return markers;
}

function isCompletedOpenCodeCompactionAssistant(info: Record<string, unknown>): boolean {
  const time = isRecord(info.time) ? info.time : {};
  return info.role === "assistant"
    && (info.mode === "compaction" || info.summary === true)
    && typeof time.completed === "number"
    && info.error === undefined;
}

function openCodeCompactionOutcome(history: readonly unknown[], markerIds: ReadonlySet<string>): "completed" | "failed" | undefined {
  for (const entry of history) {
    if (!isRecord(entry)) continue;
    const info = isRecord(entry.info) ? entry.info : entry;
    if (typeof info.parentID !== "string" || !markerIds.has(info.parentID) || info.role !== "assistant"
      || (info.mode !== "compaction" && info.summary !== true)) continue;
    if (info.error !== undefined && info.error !== null) return "failed";
    if (isCompletedOpenCodeCompactionAssistant(info)) return "completed";
  }
  return undefined;
}

function isCompletedOpenCodeAssistant(info: Record<string, unknown>): boolean {
  const time = isRecord(info.time) ? info.time : {};
  return info.role === "assistant" && typeof time.completed === "number" && info.error === undefined;
}

/** OpenCode's prompt loop exits on any finish except `tool-calls` and `unknown`. */
function isOpenCodeTurnExitFinish(finish: unknown): boolean {
  return typeof finish === "string" && finish.length > 0 && finish !== "tool-calls" && finish !== "unknown";
}

function isCompletedUnknownOpenCodeAssistant(info: Record<string, unknown>): boolean {
  return isCompletedOpenCodeAssistant(info) && info.finish === "unknown";
}

function hasExplicitZeroOpenCodeUsage(info: Record<string, unknown>): boolean {
  if (!isRecord(info.tokens)) return false;
  const tokens = info.tokens;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const values = [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    cache.read ?? tokens.cacheRead,
    cache.write ?? tokens.cacheWrite,
  ];
  return values.every((value) => typeof value === "number" && Number.isFinite(value) && value === 0);
}

function isPersistedEmptyUnknownAssistant(entry: Record<string, unknown>): boolean {
  const info = isRecord(entry.info) ? entry.info : entry;
  if (!isCompletedUnknownOpenCodeAssistant(info) || !hasExplicitZeroOpenCodeUsage(info)) return false;
  const parts = Array.isArray(entry.parts) ? entry.parts : [];
  let sawUnknownFinish = false;
  for (const part of parts) {
    if (!isRecord(part) || (part.type !== "step-start" && part.type !== "step-finish")) return false;
    if (part.type === "step-finish") {
      if (part.reason !== "unknown") return false;
      sawUnknownFinish = true;
    }
  }
  return sawUnknownFinish;
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

interface OpenCodeUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

function emptyOpenCodeUsage(): OpenCodeUsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
}

/** What one turn was carrying: everything it read, cached or fresh, plus what it wrote. */
function openCodeOccupancy(usage: OpenCodeUsageTotals): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.outputTokens;
}

function addOpenCodeUsage(total: OpenCodeUsageTotals, info: Record<string, unknown>): OpenCodeUsageTotals {
  const tokens = isRecord(info.tokens) ? info.tokens : {};
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return {
    inputTokens: total.inputTokens + finiteNumber(tokens.input),
    outputTokens: total.outputTokens + finiteNumber(tokens.output) + finiteNumber(tokens.reasoning),
    cacheReadTokens: total.cacheReadTokens + finiteNumber(cache.read ?? tokens.cacheRead),
    cacheWriteTokens: total.cacheWriteTokens + finiteNumber(cache.write ?? tokens.cacheWrite),
    cost: total.cost + finiteNumber(info.cost),
  };
}

function openCodeContextWindow(metadata: JsonObject): number | undefined {
  const limit = isRecord(metadata.limit) ? metadata.limit : {};
  const value = limit.context ?? metadata.contextWindow ?? metadata.contextWindowTokens;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function openCodeInputModalities(model: Record<string, unknown>): readonly ("text" | "image" | "audio")[] | undefined {
  const capabilities = isRecord(model.capabilities) ? model.capabilities : {};
  const input = isRecord(capabilities.input)
    ? capabilities.input
    : isRecord(model.modalities) && isRecord(model.modalities.input)
      ? model.modalities.input
      : {};
  const advertised = Array.isArray(model.inputModalities)
    ? model.inputModalities
    : Array.isArray(isRecord(model.modalities) ? model.modalities.input : undefined)
      ? (model.modalities as Record<string, unknown>).input as unknown[]
      : [];
  const supportsImage = input.image === true || capabilities.attachment === true || advertised.includes("image");
  const supportsAudio = input.audio === true || advertised.includes("audio");
  return ["text" as const, ...(supportsImage ? ["image" as const] : []), ...(supportsAudio ? ["audio" as const] : [])];
}

function openCodeSupportsNativePdf(metadata: JsonObject): boolean {
  const capabilities = isRecord(metadata.capabilities) ? metadata.capabilities : {};
  const input = isRecord(capabilities.input) ? capabilities.input : {};
  return input.pdf === true;
}

type OpenCodeMessageSelection = {
  readonly modelId: string;
  readonly variantId?: string;
  readonly reasoningEffort?: string;
  readonly messageCreatedAt?: number;
};

/** The model route OpenCode persisted on one native message record. */
function openCodeMessageSelection(info: Record<string, unknown>): OpenCodeMessageSelection | undefined {
  const nested = isRecord(info.model) ? info.model : {};
  const user = info.role === "user";
  const providerId = user
    ? firstText(nested.providerID, nested.providerId)
    : firstText(info.providerID, info.providerId, nested.providerID, nested.providerId);
  const nativeModelId = user
    ? firstText(nested.modelID, nested.modelId, nested.id)
    : firstText(info.modelID, info.modelId, nested.modelID, nested.modelId, nested.id);
  if (providerId === undefined || nativeModelId === undefined) return undefined;
  const variant = user
    ? firstText(nested.variant, info.variant)
    : firstText(info.variant, nested.variant);
  const reportedVariant = variant ?? "default";
  const time = isRecord(info.time) ? info.time : {};
  const messageCreatedAt = typeof time.created === "number" && Number.isFinite(time.created) ? time.created : undefined;
  const modelId = nativeModelId.startsWith(`${providerId}/`) ? nativeModelId : `${providerId}/${nativeModelId}`;
  return {
    modelId,
    variantId: reportedVariant,
    reasoningEffort: reportedVariant,
    ...(messageCreatedAt !== undefined ? { messageCreatedAt } : {}),
  };
}

function sessionUpdatePayload(hostId: string, properties: Record<string, unknown>): JsonObject {
  if (!isRecord(properties.info)) return asJsonObject(properties);
  const info = properties.info;
  const explicitStatus = properties.status ?? properties.state ?? info.status ?? info.state;
  let session: RemoteSession;
  try {
    session = normalizeOpenCodeSession(hostId, info, explicitStatus);
  } catch {
    return asJsonObject(properties);
  }
  return {
    ...(typeof info.title === "string" && info.title.trim() && session.title.trim() ? { title: session.title.trim() } : {}),
    ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
    ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
    ...(session.variantId !== undefined ? { variantId: session.variantId } : {}),
    ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.agentNickname !== undefined ? { agentNickname: session.agentNickname } : {}),
    ...(session.agentRole !== undefined ? { agentRole: session.agentRole } : {}),
    ...(explicitStatus !== undefined && session.state !== "unknown" ? { state: session.state } : {}),
  };
}

function findSessionId(properties: Record<string, unknown>): string | undefined {
  if (typeof properties.sessionID === "string") return properties.sessionID;
  if (isRecord(properties.info) && typeof properties.info.sessionID === "string") return properties.info.sessionID;
  if (isRecord(properties.info) && typeof properties.info.id === "string" && "projectID" in properties.info) return properties.info.id;
  if (isRecord(properties.part) && typeof properties.part.sessionID === "string") return properties.part.sessionID;
  return undefined;
}

function isOpenCodeAbortError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.name === "MessageAbortedError" || value.name === "AbortError";
}

function primaryEventCarriesActivityState(type: string): boolean {
  return type === "session.status" || type === "session.idle" || type === "session.error"
    || type === "message.updated" || type === "message.part.updated" || type === "message.part.delta"
    || type === "permission.updated" || type === "permission.asked" || type === "question.asked" || type === "command.executed";
}

function openCodeQuestionAnswer(question: JsonObject, answers: JsonObject): readonly string[] {
  const value = answers[String(question.id)];
  const answer = typeof value === "string" ? [value]
    : Array.isArray(value) ? value
      : isRecord(value) && Array.isArray(value.answers) ? value.answers : undefined;
  if (answer === undefined || answer.length === 0 || answer.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
    || (question.multiple !== true && answer.length > 1)) {
    throw new ProviderAdapterError("opencode", "USER_INPUT_INVALID", `Answer ${typeof question.header === "string" ? question.header : String(question.id)} before continuing`, false);
  }
  const labels = Array.isArray(question.options) ? question.options.flatMap((option) => isRecord(option) && typeof option.label === "string" ? [option.label] : []) : [];
  if (question.custom === false && answer.some((entry) => !labels.includes(entry as string))) {
    throw new ProviderAdapterError("opencode", "USER_INPUT_INVALID", "Choose one of the options offered by OpenCode", false);
  }
  return answer as string[];
}

function openCodeSessionPermissions(value: unknown, sessionId: string): ProviderSessionPermissions {
  if (!isRecord(value) || value.id !== sessionId || (value.permission !== undefined && !Array.isArray(value.permission))) {
    throw new ProviderAdapterError("opencode", "PERMISSIONS_UNAVAILABLE", "OpenCode did not return this task's permission rules", false);
  }
  const rules = Array.isArray(value.permission) ? value.permission : [];
  const last = rules.at(-1);
  const action = isRecord(last) && last.permission === "*" && last.pattern === "*"
    && (last.action === "ask" || last.action === "allow" || last.action === "deny") ? last.action : undefined;
  const current = action ?? (rules.length === 0 ? "default" : "custom");
  return {
    controls: [{
      id: "tool_permissions", label: "Tool permissions", description: "Tool access for this task.", value: current,
      options: [
        ...(current === "default" ? [{ value: "default", label: "Provider settings (current)", disabled: true }] : []),
        ...(current === "custom" ? [{ value: "custom", label: "Custom rules (current)", disabled: true }] : []),
        { value: "ask", label: "Ask before tools" },
        { value: "allow", label: "Allow tools" },
        { value: "deny", label: "Deny tools" },
      ],
    }],
  };
}

function toolEventType(part: Record<string, unknown>): "tool.started" | "tool.completed" {
  const state = isRecord(part.state) ? part.state : {};
  // A failed tool is still the terminal snapshot of that tool part. Emitting an
  // agent.error here creates a second row and falsely marks the whole task failed.
  if (state.status === "completed" || state.status === "error") return "tool.completed";
  return "tool.started";
}

function filePatterns(permission: Record<string, unknown>): readonly string[] {
  const pattern = permission.pattern;
  if (typeof pattern === "string") return [pattern];
  if (Array.isArray(pattern)) return pattern.filter((entry): entry is string => typeof entry === "string");
  return [];
}
