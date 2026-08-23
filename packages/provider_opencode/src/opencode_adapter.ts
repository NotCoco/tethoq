import { randomUUID } from "node:crypto";
import { ExponentialBackoff, type JsonObject, type ProviderCapabilities, type RemoteMessage, type RemoteModel, type RemoteSession, type SessionContextState } from "../../protocol/src/index.js";
import {
  ProviderAdapterError,
  ProviderEventHub,
  providerPromptContent,
  type AgentProviderAdapter,
  type AuthStatus,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type PaginatedSessions,
  type ProviderApprovalResponse,
  type ProviderDetection,
  type ProviderEvent,
  type ProviderEventSink,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../provider_contract/src/index.js";
import { OpenCodeHttpClient, type OpenCodeHttpClientOptions } from "./http_client.js";
import { SqliteOpenCodeActivityReader, type OpenCodeActivityReader, type SqliteOpenCodeActivityReaderOptions } from "./activity.js";
import { asJsonObject, isContinuingOpenCodeToolPart, isRecord, normalizeOpenCodeMessages, normalizeOpenCodeProviderStatus, normalizeOpenCodeSession, normalizeOpenCodeToolEventPayload, normalizeStatus } from "./normalize.js";

export interface OpenCodeAdapterOptions extends OpenCodeHttpClientOptions {
  readonly hostId: string;
  readonly directory?: string;
  readonly now?: () => Date;
  readonly activityReader?: OpenCodeActivityReader;
  /** Explicit opt-in to OpenCode's undocumented local SQLite state. */
  readonly localActivity?: false | SqliteOpenCodeActivityReaderOptions;
  readonly activityPollIntervalMs?: number;
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
}

const capabilities: ProviderCapabilities = {
  authentication: false,
  listSessions: true,
  paginatedSessions: false,
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
  userInput: false,
  interrupt: true,
  modelEnumeration: true,
  projectAssociation: true,
  sessionRelationships: true,
  messageEditing: false,
  remoteConnectivity: "documented_remote",
  notes: [
    "Uses OpenCode's documented HTTP/OpenAPI and SSE server surfaces.",
    "Remote-initiated authentication is intentionally disabled; authenticate providers on the host with official OpenCode flows.",
    "The server returns a complete session array rather than a cursor, so this adapter applies local cursor pagination.",
  ],
};

interface PendingPermission {
  readonly sessionId: string;
  readonly nativePermissionId: string;
}

interface GuardAbortGeneration {
  /** The Tethoq-dispatched user message whose impossible continuation was stopped. */
  readonly parentId: string;
  /** The exact same-parent assistant that caused the guarded abort attempt. */
  readonly continuationAssistantId: string;
  /** A rejected HTTP response is ambiguous because the server may already have acted. */
  outcome: "attempting" | "uncertain" | "confirmed";
  /** The next Tethoq prompt, retained until its provider echo forms a FIFO boundary. */
  successorMessageId: string | undefined;
  /** Started synchronously before the lifecycle lock releases; safe for re-entrant sends. */
  completion: Promise<void> | undefined;
}

interface PendingOwnedIdle {
  /** The exact Tethoq-dispatched user message this otherwise-unlabelled idle may end. */
  readonly parentId: string;
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

const sessionListSnapshotTtlMs = 5_000;
const maxSessionListSnapshots = 8;
/** Enough parts for several concurrent turns without growing without bound. */
const maxTrackedParts = 512;
/** Persisted messages can trail SSE slightly; retry briefly rather than losing the only idle. */
const ownedIdleConfirmationDelaysMs = [25, 75, 200, 500, 1_000] as const;
/** A second matching read prevents a queued tool part from losing a race to idle. */
const ownedIdleQuietConfirmationMs = 75;
/** A rejected abort can still have acted; give its native cleanup a brief causal window. */
const manualInterruptCleanupGraceMs = 250;
const disabledActivityReader: OpenCodeActivityReader = {
  async readWorkingSessionIds(): Promise<ReadonlySet<string>> { return new Set(); },
  close(): void {},
};

export class OpenCodeAdapter implements AgentProviderAdapter {
  public readonly providerId = "opencode";
  public readonly displayName = "OpenCode";
  readonly #client: OpenCodeHttpClient;
  readonly #hostId: string;
  readonly #directory: string | undefined;
  readonly #now: () => Date;
  readonly #events = new ProviderEventHub();
  readonly #permissions = new Map<string, PendingPermission>();
  readonly #abort = new AbortController();
  readonly #activityReader: OpenCodeActivityReader;
  readonly #activityPollIntervalMs: number;
  readonly #activeTurnSettleMs: number;
  readonly #sessionListSnapshots = new Map<string, SessionListSnapshot>();
  readonly #partTexts = new Map<string, string>();
  readonly #partTypes = new Map<string, string>();
  readonly #messageRoles = new Map<string, string>();
  readonly #activePromptMessageIds = new Map<string, string>();
  readonly #continuingToolMessageIds = new Set<string>();
  readonly #terminalPromptCandidates = new Map<string, string>();
  readonly #runawayPromptParents = new Set<string>();
  readonly #suppressedMessageIds = new Set<string>();
  /** Sessions whose current runner was deliberately aborted after a confirmed
   * impossible same-prompt continuation. Native abort/status/idle events for
   * that runner must not overwrite the valid answer we already completed. */
  readonly #guardAbortGenerations = new Map<string, GuardAbortGeneration>();
  /** Quarantines the trailing idle/error finalizers for one interrupted or failed turn. */
  readonly #terminalCleanupGenerations = new Map<string, TerminalCleanupGeneration>();
  readonly #pendingOwnedIdles = new Map<string, PendingOwnedIdle>();
  /** Serializes session-wide aborts with prompt dispatches. */
  readonly #sessionLifecycleTails = new Map<string, Promise<void>>();
  /** Invalidates an activity snapshot taken across a guard-generation transition. */
  #guardActivityEpoch = 0;
  #activityLoop: Promise<void> | null = null;
  #persistedWorking = new Set<string>();
  readonly #activePrompts = new Set<string>();
  #activeSettleDeadlines = new Map<string, number>();
  #nativeStates = new Map<string, RemoteSession["state"]>();
  #eventLoop: Promise<void> | null = null;
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
    this.#hostId = options.hostId;
    this.#directory = options.directory;
    this.#now = options.now ?? (() => new Date());
    this.#activityReader = options.activityReader ?? (
      options.localActivity === undefined || options.localActivity === false
        ? disabledActivityReader
        : new SqliteOpenCodeActivityReader({ ...options.localActivity, now: options.localActivity.now ?? this.#now })
    );
    this.#activityPollIntervalMs = options.activityPollIntervalMs ?? 5_000;
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
    return result;
  }

  public async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) throw new ProviderAdapterError(this.providerId, "BAD_CURSOR", "OpenCode local pagination cursor is invalid", false);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const snapshotKey = this.sessionListSnapshotKey(options);
    const snapshot = options.cursor === undefined
      ? await this.loadSessionListSnapshot(options, snapshotKey)
      : this.cachedSessionListSnapshot(snapshotKey) ?? await this.loadSessionListSnapshot(options, snapshotKey);
    const page = snapshot.sessions.slice(offset, offset + limit);
    const next = offset + page.length;
    if (next >= snapshot.sessions.length && this.#sessionListSnapshots.get(snapshotKey) === snapshot) {
      this.#sessionListSnapshots.delete(snapshotKey);
    }
    return { sessions: page, nextCursor: next < snapshot.sessions.length ? String(next) : null };
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
  private async listSessionsAcrossProjects(): Promise<readonly unknown[]> {
    const [primary, ...rest] = await this.sessionListDirectories();
    // The primary listing still throws. A server that is down has to surface as
    // a failed refresh, because an empty list reads as "this provider has no
    // sessions" and would drop every cached session for it.
    const pages = [await this.fetchSessionList(primary)];
    // Supplementary projects are best-effort: one unreadable workspace must not
    // blank out the others.
    pages.push(...await Promise.all(rest.map(async (directory) => await this.fetchSessionList(directory).catch((): readonly unknown[] => []))));
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
  private async sessionListDirectories(): Promise<readonly (string | undefined)[]> {
    // A pinned directory is an explicit scope from the host; honour it verbatim.
    if (this.#directory !== undefined) return [this.#directory];
    try {
      const value = await this.#client.request<unknown>("GET", "/project", {});
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

  private async fetchSessionList(directory: string | undefined): Promise<readonly unknown[]> {
    const value = await this.#client.request<unknown>("GET", "/session", {
      query: { directory, limit: Number.MAX_SAFE_INTEGER },
    });
    return Array.isArray(value) ? value : [];
  }

  private async loadSessionListSnapshot(
    options: ListSessionsOptions,
    snapshotKey: string,
    retryOnInvalidation = options.cursor === undefined,
  ): Promise<SessionListSnapshot> {
    const generation = this.#sessionListSnapshotGeneration;
    const [all, statuses, persistedWorking] = await Promise.all([
      options.workingDirectory === undefined
        ? this.listSessionsAcrossProjects()
        : this.fetchSessionList(options.workingDirectory),
      this.sessionStatuses().catch((): Record<string, unknown> => ({})),
      this.readPersistedWorking(),
    ]);
    // A live event can clear or replace provider status while these independent
    // reads are in flight. A cursorless refresh is the authority for the page it
    // returns, so repeat that native read once instead of returning the snapshot
    // the event already invalidated. Cursor continuations keep their established
    // single-snapshot behavior, and a second invalidation never creates a loop.
    if (retryOnInvalidation && generation !== this.#sessionListSnapshotGeneration) {
      return await this.loadSessionListSnapshot(options, snapshotKey, false);
    }
    this.captureNativeStates(statuses);
    const filtered = all.filter((entry) => isRecord(entry)
      && (options.workingDirectory === undefined || entry.directory === options.workingDirectory)
      && (options.parentProviderSessionId === undefined || entry.parentID === options.parentProviderSessionId));
    const sessions = Object.freeze(filtered.map((entry) => {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "";
      const session = normalizeOpenCodeSession(this.#hostId, entry, this.resolvedStatus(id, statuses[id], persistedWorking));
      // OpenCode listings carry no session state, so an unknown answer is the
      // normal case rather than a gap. Report the adapter's own truth instead:
      // working only while a turn is genuinely in flight, idle otherwise. This
      // is what lets a finished turn settle instead of shimmering forever.
      const state: RemoteSession["state"] = session.state === "unknown"
        ? this.hasActiveTurn(id) ? "working" : "idle"
        : session.state;
      return Object.freeze({ ...session, state });
    }));
    const snapshot: SessionListSnapshot = { sessions, expiresAt: this.#now().getTime() + sessionListSnapshotTtlMs };
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
    return JSON.stringify([options.workingDirectory ?? null, options.parentProviderSessionId ?? null]);
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    const [session, statuses, persistedWorking] = await Promise.all([
      this.#client.request<unknown>("GET", `/session/${encodeURIComponent(providerSessionId)}`, { query: this.query() }),
      this.sessionStatuses().catch((): Record<string, unknown> => ({})),
      this.readPersistedWorking(),
    ]);
    this.captureNativeStates(statuses);
    const normalized = normalizeOpenCodeSession(this.#hostId, session, this.resolvedStatus(providerSessionId, statuses[providerSessionId], persistedWorking));
    const state: RemoteSession["state"] = normalized.state === "unknown"
      ? this.hasActiveTurn(providerSessionId) ? "working" : "idle"
      : normalized.state;
    return state === normalized.state ? normalized : { ...normalized, state };
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const value = await this.rawMessages(providerSessionId);
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
    const models = await this.listModels().catch((): readonly RemoteModel[] => []);
    const model = modelId === undefined ? undefined : models.find((candidate) => candidate.id === modelId);
    const contextWindowTokens = model === undefined ? undefined : openCodeContextWindow(model.nativeMetadata);
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
    const value = await this.rawMessages(providerSessionId);
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
    await this.#client.request("POST", `/session/${encodeURIComponent(providerSessionId)}/summarize`, {
      query: this.query(),
      body: { providerID, modelID },
    });
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    const directory = options.workingDirectory;
    const value = await this.#client.request<unknown>("POST", "/session", {
      query: this.query(directory),
      body: { ...(options.title !== undefined ? { title: options.title } : {}) },
    });
    const session = normalizeOpenCodeSession(this.#hostId, value);
    if (options.firstInstruction !== undefined) {
      await this.sendMessage(session.providerSessionId, {
        requestId: `create_${randomUUID()}`,
        content: options.firstInstruction,
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });
    }
    return session;
  }

  public async branchSession(providerSessionId: string): Promise<RemoteSession> {
    const value = await this.#client.request<unknown>("POST", `/session/${encodeURIComponent(providerSessionId)}/fork`, {
      query: this.query(),
      body: {},
    });
    return normalizeOpenCodeSession(this.#hostId, value);
  }

  public async resumeSession(providerSessionId: string): Promise<void> {
    await this.getSession(providerSessionId);
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return await this.withSessionLifecycleLock(providerSessionId, async () => {
      const model = request.modelId === undefined ? undefined : parseModel(request.modelId);
      const messageID = `msg_${randomUUID()}`;
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
      this.cancelPendingOwnedCompletion(providerSessionId);
      this.#activePrompts.add(providerSessionId);
      this.#activePromptMessageIds.set(providerSessionId, messageID);
      try {
        await this.#client.request("POST", `/session/${encodeURIComponent(providerSessionId)}/prompt_async`, {
          query: this.query(),
          body: {
            messageID,
            parts: [
              { type: "text", text: providerPromptContent(request) },
              ...(request.attachments ?? []).map((attachment) => ({
                type: "file",
                mime: attachment.mimeType,
                filename: attachment.name,
                url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
              })),
            ],
            ...(model !== undefined ? { model } : {}),
            // OpenCode exposes reasoning choices as model variants. The desktop
            // deliberately passes one of those advertised keys, so preserve it
            // verbatim instead of silently running the model's undefined default.
            ...(request.reasoningEffort !== undefined ? { variant: request.reasoningEffort } : {}),
          },
        });
      } catch (error) {
        const providerObservedPrompt = this.#messageRoles.get(messageID) === "user";
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
        // persisted and echoed the exact user message. Retrying would duplicate it.
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
    return this.#activePrompts.has(providerSessionId)
      || this.#persistedWorking.has(providerSessionId)
      || this.#nativeStates.get(providerSessionId) === "working";
  }

  public activeSessionIds(): readonly string[] {
    return [...this.#activePrompts];
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
    this.ensureEventLoop();
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

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort();
    this.#secondaryAbort.abort();
    await Promise.all([
      this.#eventLoop?.catch(() => undefined),
      this.#secondaryLoop?.catch(() => undefined),
      this.#activityLoop?.catch(() => undefined),
    ]);
    this.#activityReader.close();
    this.#activeSettleDeadlines.clear();
    this.#sessionListSnapshots.clear();
    this.#partTexts.clear();
    this.#partTypes.clear();
    this.#messageRoles.clear();
    this.#activePromptMessageIds.clear();
    this.#continuingToolMessageIds.clear();
    this.#terminalPromptCandidates.clear();
    this.#runawayPromptParents.clear();
    this.#suppressedMessageIds.clear();
    for (const generation of this.#terminalCleanupGenerations.values()) generation.resolveCleanupObserved();
    this.#terminalCleanupGenerations.clear();
    this.#guardAbortGenerations.clear();
    for (const sessionId of this.#pendingOwnedIdles.keys()) this.clearPendingOwnedIdle(sessionId);
    this.#sessionLifecycleTails.clear();
    this.#events.clear();
  }

  private query(directory = this.#directory): Readonly<Record<string, string | undefined>> {
    return { directory };
  }

  private async rawMessages(providerSessionId: string): Promise<unknown> {
    return await this.#client.request<unknown>("GET", `/session/${encodeURIComponent(providerSessionId)}/message`, {
      query: { ...this.query(), limit: 500 },
    });
  }

  private async sessionStatuses(): Promise<Record<string, unknown>> {
    const value = await this.#client.request<unknown>("GET", "/session/status", { query: this.query() });
    return isRecord(value) ? value : {};
  }

  private ensureEventLoop(): void {
    if (this.#disposed) return;
    if (this.#eventLoop === null) {
      this.#eventLoop = this.runEventLoop().finally(() => {
        this.#eventLoop = null;
        if (!this.#disposed && this.#abort.signal.aborted === false) this.ensureEventLoop();
      });
    }
    if (this.#activityLoop === null) {
      this.#activityLoop = this.runActivityLoop().finally(() => {
        this.#activityLoop = null;
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

  private async runActivityLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const guardEpoch = this.#guardActivityEpoch;
      const snapshot = await this.tryReadPersistedWorking();
      // A session-wide abort may complete while the database read is in flight.
      // Discard that old snapshot so it cannot resurrect the released generation.
      if (guardEpoch !== this.#guardActivityEpoch) {
        await this.activityDelay();
        continue;
      }
      if (snapshot === undefined) {
        // An unavailable activity source is not evidence that every turn ended.
        // The generic deadline may still *ask* exact history for confirmation;
        // it cannot emit idle on its own.
        await this.settleUnconfirmedActiveTurns(new Set());
        await this.activityDelay();
        continue;
      }
      const next = new Set([...snapshot].filter((sessionId) =>
        this.#guardAbortGenerations.get(sessionId)?.outcome !== "confirmed"
        && !this.#terminalCleanupGenerations.has(sessionId)));
      const ids = new Set([...this.#persistedWorking, ...next]);
      for (const sessionId of ids) {
        const wasWorking = this.#persistedWorking.has(sessionId);
        const isWorking = next.has(sessionId);
        if (wasWorking === isWorking) continue;
        const activePromptId = this.#activePromptMessageIds.get(sessionId);
        if (activePromptId !== undefined) {
          if (isWorking) {
            this.cancelPendingOwnedCompletion(sessionId);
            await this.emit({ providerSessionId: sessionId, type: "session.status_changed", payload: { state: "working", providerStatus: null } });
          } else {
            // Database disappearance is only a hint. A completed tool step and a
            // genuinely terminal response look identical to the activity query.
            this.rememberPendingOwnedIdle(sessionId, activePromptId);
          }
          continue;
        }
        if (this.#nativeStates.get(sessionId) !== undefined && this.#nativeStates.get(sessionId) !== "unknown") continue;
        if (!isWorking) {
          // The database is the authoritative completion signal: a turn it once
          // reported as working and now reports as done is over, so the
          // dispatch mark must not re-flag the session on the next listing.
          this.cancelPendingOwnedCompletion(sessionId);
          this.#activePrompts.delete(sessionId);
          this.#activePromptMessageIds.delete(sessionId);
        }
        await this.emit({ providerSessionId: sessionId, type: "session.status_changed", payload: { state: isWorking ? "working" : "idle", providerStatus: null } });
      }
      if (guardEpoch !== this.#guardActivityEpoch) {
        await this.activityDelay();
        continue;
      }
      this.#persistedWorking = new Set(next);
      await this.settleUnconfirmedActiveTurns(next);
      await this.activityDelay();
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
        this.cancelPendingOwnedCompletion(sessionId);
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

  private async runEventLoop(): Promise<void> {
    const backoff = new ExponentialBackoff({ initialMs: 250, maximumMs: 10_000 });
    while (!this.#abort.signal.aborted) {
      try {
        for await (const event of this.#client.sse("/global/event", { signal: this.#abort.signal })) {
          if (this.#abort.signal.aborted) return;
          backoff.reset();
          await this.handleEvent(event, "primary");
        }
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        await this.emit({ type: "provider.disconnected", payload: { message: error instanceof Error ? error.message : String(error) } });
      }
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
          if (payload.type === "server.connected") continue;
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
    const properties = isRecord(payload.properties) ? payload.properties : {};
    const sessionId = findSessionId(properties);
    const base = { ...(sessionId !== undefined ? { providerSessionId: sessionId } : {}), nativeEvent: asJsonObject(global) };

    if (type === "server.connected") return await this.emit({ ...base, type: "provider.connected", payload: {} });
    if (type === "session.created") return await this.emit({ ...base, type: "session.created", payload: asJsonObject(properties) });
    if (type === "session.updated") return await this.emit({ ...base, type: "session.updated", payload: sessionUpdatePayload(this.#hostId, properties) });
    if (type === "session.status") {
      const status = normalizeStatus(properties.status);
      const providerStatus = normalizeOpenCodeProviderStatus(properties.status);
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
        const activePromptId = this.#activePromptMessageIds.get(sessionId);
        if (activePromptId !== undefined && (status === "idle" || status === "unknown")) {
          // This event carries only a session id, so it cannot prove which prompt
          // ended. Keep the provider-side ownership mark until session.idle can
          // be tied to this exact parent through persisted terminal history.
          this.#nativeStates.set(sessionId, "idle");
          this.rememberPendingOwnedIdle(sessionId, activePromptId, base.nativeEvent);
          return;
        }
        if (activePromptId !== undefined && status === "working") this.cancelPendingOwnedCompletion(sessionId);
        if (status === "failed") {
          this.rememberTerminalCleanupGeneration(sessionId, "failed", activePromptId);
          if (activePromptId !== undefined) this.releaseOwnedPrompt(sessionId, activePromptId);
        }
      }
      if (sessionId !== undefined) this.#nativeStates.set(sessionId, status);
      return await this.emit({
        ...base,
        type: "session.status_changed",
        payload: { state: status, providerStatus: providerStatus === undefined ? null : asJsonObject(providerStatus) },
      });
    }
    if (type === "session.idle") {
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
      }
      if (sessionId !== undefined) {
        const promptMessageId = this.#activePromptMessageIds.get(sessionId);
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
      if (source === "primary" && sessionId !== undefined && activePromptId !== undefined && messageId !== undefined) {
        const repeatedTerminal = role === "assistant" && parentId === activePromptId
          && this.#terminalPromptCandidates.get(activePromptId) === messageId
          && info.finish === "stop" && isRecord(info.time) && typeof info.time.completed === "number";
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
      if (source === "secondary" && sessionId !== undefined) this.#secondaryActive.add(sessionId);
      await this.emit({ ...base, type: "message.started", payload: asJsonObject(properties) });
      if (source === "primary" && sessionId !== undefined && role === "assistant" && parentId !== undefined
        && this.#activePromptMessageIds.get(sessionId) === parentId
        && messageId !== undefined && info.finish === "stop" && isRecord(info.time) && typeof info.time.completed === "number"
        && !this.#continuingToolMessageIds.has(messageId)) {
        this.rememberTerminalCandidate(parentId, messageId);
        this.restartPendingOwnedIdleRecheck(sessionId, parentId);
      }
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
        if (source === "primary" && sessionId !== undefined) this.cancelPendingOwnedCompletion(sessionId);
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
          this.retireAmbiguousGuardAfterContinuationOutput(sessionId, messageId);
        }
        if (messageId !== undefined && isContinuingOpenCodeToolPart(part)) {
          if (source === "primary" && sessionId !== undefined) this.cancelPendingOwnedCompletion(sessionId);
          this.rememberContinuingToolMessage(messageId);
          this.forgetTerminalCandidateForMessage(messageId);
        }
        return await this.emit({ ...base, type: toolEventType(part), payload: normalizeOpenCodeToolEventPayload(part) });
      }
      if (partType === "patch") {
        const files = Array.isArray(part.files)
          ? part.files.filter((file): file is string => typeof file === "string" && file.trim().length > 0)
          : [];
        if (files.length === 0) return;
        if (source === "primary" && sessionId !== undefined) {
          this.retireAmbiguousGuardAfterContinuationOutput(sessionId, messageId);
        }
        if (source === "primary" && sessionId !== undefined) this.cancelPendingOwnedCompletion(sessionId);
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
        this.retireAmbiguousGuardAfterContinuationOutput(sessionId, messageId);
      }
      // Keep the snapshot in step so the closing message.part.updated, which repeats the
      // whole part, diffs to nothing instead of sending the body a second time.
      this.rememberPartText(partId, (this.#partTexts.get(partId) ?? "") + delta);
      if (source === "primary" && sessionId !== undefined) this.cancelPendingOwnedCompletion(sessionId);
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
    if (type === "permission.updated" || type === "permission.asked") {
      const permission = type === "permission.asked" ? properties : properties;
      const nativeId = typeof permission.id === "string" ? permission.id : undefined;
      const permissionSessionId = typeof permission.sessionID === "string" ? permission.sessionID : sessionId;
      if (nativeId === undefined || permissionSessionId === undefined) return;
      if (source === "primary") this.cancelPendingOwnedCompletion(permissionSessionId);
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
      if (source === "primary" && sessionId !== undefined) this.cancelPendingOwnedCompletion(sessionId);
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
    return await this.withSessionLifecycleLock(sessionId, async () => {
      if (this.#activePromptMessageIds.get(sessionId) !== parentId) return { kind: "stale" };
      // Install narrow abort-error protection before the request. A timeout can
      // happen after the server acted, so rejection must not remove this marker.
      const guard = this.rememberGuardAbortGeneration(sessionId, parentId, continuationAssistantId);
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
    if (this.#disposed || !this.releaseOwnedPrompt(sessionId, guard.parentId)) {
      guard.completion = Promise.resolve();
      return guard.completion;
    }
    this.#nativeStates.set(sessionId, "idle");
    // AgentBridge intentionally strips raw provider metadata. This exact marker
    // is the only completion allowed to bypass renderer quieting.
    guard.completion = this.emit({
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
  ): Promise<TerminalConfirmation> {
    const value = await this.rawMessages(sessionId).catch((): unknown => undefined);
    if (!Array.isArray(value)) return { kind: "unavailable" };
    let selected: Record<string, unknown> | undefined;
    let continuationPersisted = continuationAssistantId === undefined;
    let selectedCreated = Number.NEGATIVE_INFINITY;
    let selectedIndex = -1;
    for (const [index, candidate] of value.entries()) {
      if (!isRecord(candidate)) continue;
      const info = isRecord(candidate.info) ? candidate.info : candidate;
      if (info.role !== "assistant" || info.parentID !== parentId) continue;
      if (info.id === continuationAssistantId) continuationPersisted = true;
      if (assistantId !== undefined) {
        if (info.id === assistantId) {
          selected = candidate;
        }
        // Keep scanning: the causal continuation normally follows this terminal
        // record in chronological history.
        continue;
      }
      const time = isRecord(info.time) ? info.time : {};
      const created = typeof time.created === "number" ? time.created : Number.NEGATIVE_INFINITY;
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
    const time = isRecord(info.time) ? info.time : {};
    const parts = Array.isArray(selected.parts) ? selected.parts : [];
    if (parts.some(isContinuingOpenCodeToolPart)) return { kind: "continuing" };
    if (info.finish !== "stop" || typeof time.completed !== "number" || info.error !== undefined) {
      return { kind: "continuing" };
    }
    return { kind: "terminal", assistantId: typeof info.id === "string" ? info.id : assistantId ?? "" };
  }

  private rememberPendingOwnedIdle(sessionId: string, parentId: string, nativeEvent?: JsonObject): void {
    const existing = this.#pendingOwnedIdles.get(sessionId);
    if (existing?.parentId === parentId) {
      if (nativeEvent !== undefined) existing.nativeEvent = nativeEvent;
      this.restartPendingOwnedIdleRecheck(sessionId, parentId);
      return;
    }
    this.clearPendingOwnedIdle(sessionId);
    const pending: PendingOwnedIdle = {
      parentId,
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
    const delay = delayOverride ?? ownedIdleConfirmationDelaysMs[pending.attempts];
    if (delay === undefined) {
      // History remains the authority. The long deadline only starts another
      // bounded confirmation pass; it never completes a prompt by itself.
      this.#activeSettleDeadlines.set(sessionId, this.#now().getTime() + this.#activeTurnSettleMs);
      return;
    }
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void this.recheckPendingOwnedIdle(sessionId, pending);
    }, delay);
  }

  private async recheckPendingOwnedIdle(sessionId: string, pending: PendingOwnedIdle): Promise<void> {
    if (this.#disposed || this.#pendingOwnedIdles.get(sessionId) !== pending
      || this.#activePromptMessageIds.get(sessionId) !== pending.parentId) {
      if (this.#pendingOwnedIdles.get(sessionId) === pending) this.clearPendingOwnedIdle(sessionId);
      return;
    }
    const revision = pending.revision;
    pending.checksInFlight += 1;
    const confirmation = await this.confirmPromptTerminal(sessionId, pending.parentId);
    pending.checksInFlight -= 1;
    if (this.#disposed || this.#pendingOwnedIdles.get(sessionId) !== pending
      || this.#activePromptMessageIds.get(sessionId) !== pending.parentId
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
      this.releaseOwnedPrompt(sessionId, pending.parentId);
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

  private releaseOwnedPrompt(sessionId: string, expectedParentId?: string): boolean {
    const parentId = this.#activePromptMessageIds.get(sessionId);
    if (expectedParentId !== undefined && parentId !== expectedParentId) return false;
    this.cancelPendingOwnedCompletion(sessionId);
    this.#activePrompts.delete(sessionId);
    this.#activePromptMessageIds.delete(sessionId);
    this.#persistedWorking.delete(sessionId);
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

  private rememberGuardAbortGeneration(sessionId: string, parentId: string, continuationAssistantId: string): GuardAbortGeneration {
    const guard: GuardAbortGeneration = {
      parentId,
      continuationAssistantId,
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
    if (input.type !== "provider.connected" && input.type !== "provider.disconnected") {
      this.#sessionListSnapshotGeneration += 1;
      this.#sessionListSnapshots.clear();
    }
    await this.#events.emit({ eventId: `opencode_event_${++this.#eventCounter}`, providerId: this.providerId, occurredAt: this.#now().toISOString(), ...input });
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

  private captureNativeStates(statuses: Record<string, unknown>): void {
    this.#nativeStates = new Map(Object.entries(statuses).map(([id, status]) => [id, normalizeStatus(status)]));
  }

  private resolvedStatus(sessionId: string, nativeStatus: unknown, persistedWorking: ReadonlySet<string>): unknown {
    return normalizeStatus(nativeStatus) === "unknown" && persistedWorking.has(sessionId) ? "busy" : nativeStatus;
  }

  private async readPersistedWorking(): Promise<ReadonlySet<string>> {
    return (await this.tryReadPersistedWorking()) ?? new Set<string>();
  }

  private async tryReadPersistedWorking(): Promise<ReadonlySet<string> | undefined> {
    return await this.#activityReader.readWorkingSessionIds().catch(() => undefined);
  }

  private async activityDelay(): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.#abort.signal.removeEventListener("abort", finish);
        resolve();
      };
      timer = setTimeout(finish, this.#activityPollIntervalMs);
      this.#abort.signal.addEventListener("abort", finish, { once: true });
    });
  }
}

function parseModel(modelId: string): { readonly providerID: string; readonly modelID: string } | undefined {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
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

function toolEventType(part: Record<string, unknown>): "tool.started" | "tool.completed" | "agent.error" {
  const state = isRecord(part.state) ? part.state : {};
  if (state.status === "completed") return "tool.completed";
  if (state.status === "error") return "agent.error";
  return "tool.started";
}

function filePatterns(permission: Record<string, unknown>): readonly string[] {
  const pattern = permission.pattern;
  if (typeof pattern === "string") return [pattern];
  if (Array.isArray(pattern)) return pattern.filter((entry): entry is string => typeof entry === "string");
  return [];
}
