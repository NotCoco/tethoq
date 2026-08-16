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
import { asJsonObject, isRecord, normalizeOpenCodeMessages, normalizeOpenCodeSession, normalizeStatus } from "./normalize.js";

export interface OpenCodeAdapterOptions extends OpenCodeHttpClientOptions {
  readonly hostId: string;
  readonly directory?: string;
  readonly now?: () => Date;
  readonly activityReader?: OpenCodeActivityReader;
  /** Explicit opt-in to OpenCode's undocumented local SQLite state. */
  readonly localActivity?: false | SqliteOpenCodeActivityReaderOptions;
  readonly activityPollIntervalMs?: number;
}

const capabilities: ProviderCapabilities = {
  authentication: false,
  listSessions: true,
  paginatedSessions: false,
  sessionHistory: true,
  createSession: true,
  resumeSession: true,
  sendMessage: true,
  steering: false,
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

interface SessionListSnapshot {
  readonly sessions: readonly RemoteSession[];
  readonly expiresAt: number;
}

const sessionListSnapshotTtlMs = 5_000;
const maxSessionListSnapshots = 8;
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
  readonly #sessionListSnapshots = new Map<string, SessionListSnapshot>();
  #activityLoop: Promise<void> | null = null;
  #persistedWorking = new Set<string>();
  #nativeStates = new Map<string, RemoteSession["state"]>();
  #eventLoop: Promise<void> | null = null;
  #eventCounter = 0;
  #sessionListSnapshotGeneration = 0;
  #disposed = false;

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
  }

  public async detect(): Promise<ProviderDetection> {
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

  private async loadSessionListSnapshot(options: ListSessionsOptions, snapshotKey: string): Promise<SessionListSnapshot> {
    const generation = this.#sessionListSnapshotGeneration;
    const [value, statuses, persistedWorking] = await Promise.all([
      this.#client.request<unknown>("GET", "/session", {
        query: { ...this.query(), limit: Number.MAX_SAFE_INTEGER },
      }),
      this.sessionStatuses().catch((): Record<string, unknown> => ({})),
      this.readPersistedWorking(),
    ]);
    this.captureNativeStates(statuses);
    const all = Array.isArray(value) ? value : [];
    const filtered = all.filter((entry) => isRecord(entry)
      && (options.workingDirectory === undefined || entry.directory === options.workingDirectory)
      && (options.parentProviderSessionId === undefined || entry.parentID === options.parentProviderSessionId));
    const sessions = Object.freeze(filtered.map((entry) => {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "";
      return Object.freeze(normalizeOpenCodeSession(this.#hostId, entry, this.resolvedStatus(id, statuses[id], persistedWorking)));
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
    return normalizeOpenCodeSession(this.#hostId, session, this.resolvedStatus(providerSessionId, statuses[providerSessionId], persistedWorking));
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
    const current = latest === undefined ? emptyOpenCodeUsage() : addOpenCodeUsage(emptyOpenCodeUsage(), latest);
    const providerId = latest === undefined ? undefined : firstText(latest.providerID, isRecord(latest.model) ? latest.model.providerID : undefined);
    const nativeModelId = latest === undefined ? undefined : firstText(latest.modelID, isRecord(latest.model) ? latest.model.modelID ?? latest.model.id : undefined);
    const modelId = providerId !== undefined && nativeModelId !== undefined ? `${providerId}/${nativeModelId}` : nativeModelId;
    const models = await this.listModels().catch((): readonly RemoteModel[] => []);
    const model = modelId === undefined ? undefined : models.find((candidate) => candidate.id === modelId);
    const contextWindowTokens = model === undefined ? undefined : openCodeContextWindow(model.nativeMetadata);
    const usedTokens = current.inputTokens + current.cacheReadTokens + current.outputTokens;
    return {
      ...(modelId !== undefined ? { modelId } : {}),
      usedTokens: latest === undefined ? null : usedTokens,
      contextWindowTokens: contextWindowTokens ?? null,
      usedPercent: contextWindowTokens !== undefined && contextWindowTokens > 0 && latest !== undefined
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
    const model = request.modelId === undefined ? undefined : parseModel(request.modelId);
    const messageID = `msg_${randomUUID()}`;
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
      },
    });
    return { accepted: true, providerTurnId: messageID, details: ["OpenCode accepted the asynchronous prompt."] };
  }

  public async interrupt(providerSessionId: string): Promise<void> {
    await this.#client.request("POST", `/session/${encodeURIComponent(providerSessionId)}/abort`, { query: this.query() });
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
    await Promise.all([
      this.#eventLoop?.catch(() => undefined),
      this.#activityLoop?.catch(() => undefined),
    ]);
    this.#activityReader.close();
    this.#sessionListSnapshots.clear();
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
      });
    }
    if (this.#activityLoop === null) {
      this.#activityLoop = this.runActivityLoop().finally(() => {
        this.#activityLoop = null;
      });
    }
  }

  private async runActivityLoop(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      const next = await this.readPersistedWorking();
      const ids = new Set([...this.#persistedWorking, ...next]);
      for (const sessionId of ids) {
        if (this.#nativeStates.get(sessionId) !== undefined && this.#nativeStates.get(sessionId) !== "unknown") continue;
        const wasWorking = this.#persistedWorking.has(sessionId);
        const isWorking = next.has(sessionId);
        if (wasWorking === isWorking) continue;
        await this.emit({ providerSessionId: sessionId, type: "session.status_changed", payload: { state: isWorking ? "working" : "idle" } });
      }
      this.#persistedWorking = new Set(next);
      await this.activityDelay();
    }
  }

  private async runEventLoop(): Promise<void> {
    const backoff = new ExponentialBackoff({ initialMs: 250, maximumMs: 10_000 });
    while (!this.#abort.signal.aborted) {
      try {
        for await (const event of this.#client.sse("/global/event", { signal: this.#abort.signal })) {
          if (this.#abort.signal.aborted) return;
          backoff.reset();
          await this.handleEvent(event);
        }
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        await this.emit({ type: "provider.disconnected", payload: { message: error instanceof Error ? error.message : String(error) } });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, backoff.next()));
    }
  }

  private async handleEvent(value: unknown): Promise<void> {
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
      if (sessionId !== undefined) this.#nativeStates.set(sessionId, status);
      return await this.emit({ ...base, type: "session.status_changed", payload: { state: status } });
    }
    if (type === "session.idle") {
      if (sessionId !== undefined) this.#nativeStates.set(sessionId, "idle");
      return await this.emit({ ...base, type: "agent.completed", payload: {} });
    }
    if (type === "message.updated") return await this.emit({ ...base, type: "message.started", payload: asJsonObject(properties) });
    if (type === "message.part.updated") {
      const part = isRecord(properties.part) ? properties.part : {};
      const partType = typeof part.type === "string" ? part.type : "unknown";
      if (partType === "text" || partType === "reasoning") return await this.emit({ ...base, type: "message.delta", payload: { text: typeof properties.delta === "string" ? properties.delta : typeof part.text === "string" ? part.text : "", partType } });
      if (partType === "tool") return await this.emit({ ...base, type: toolEventType(part), payload: asJsonObject(part) });
      if (partType === "patch") return await this.emit({ ...base, type: "file.changed", payload: asJsonObject(part) });
    }
    if (type === "permission.updated" || type === "permission.asked") {
      const permission = type === "permission.asked" ? properties : properties;
      const nativeId = typeof permission.id === "string" ? permission.id : undefined;
      const permissionSessionId = typeof permission.sessionID === "string" ? permission.sessionID : sessionId;
      if (nativeId === undefined || permissionSessionId === undefined) return;
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
    if (type === "command.executed") return await this.emit({ ...base, type: "command.completed", payload: asJsonObject(properties) });
    if (type === "file.edited" || type === "file.watcher.updated" || type === "session.diff") return await this.emit({ ...base, type: "file.changed", payload: asJsonObject(properties) });
    if (type === "session.error") return await this.emit({ ...base, type: "agent.error", payload: asJsonObject(properties) });
  }

  private async emit(input: Omit<ProviderEvent, "eventId" | "providerId" | "occurredAt">): Promise<void> {
    if (input.type !== "provider.connected" && input.type !== "provider.disconnected") {
      this.#sessionListSnapshotGeneration += 1;
      this.#sessionListSnapshots.clear();
    }
    await this.#events.emit({ eventId: `opencode_event_${++this.#eventCounter}`, providerId: this.providerId, occurredAt: this.#now().toISOString(), ...input });
  }

  private captureNativeStates(statuses: Record<string, unknown>): void {
    this.#nativeStates = new Map(Object.entries(statuses).map(([id, status]) => [id, normalizeStatus(status)]));
  }

  private resolvedStatus(sessionId: string, nativeStatus: unknown, persistedWorking: ReadonlySet<string>): unknown {
    return normalizeStatus(nativeStatus) === "unknown" && persistedWorking.has(sessionId) ? "busy" : nativeStatus;
  }

  private async readPersistedWorking(): Promise<ReadonlySet<string>> {
    return await this.#activityReader.readWorkingSessionIds().catch(() => new Set<string>());
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
