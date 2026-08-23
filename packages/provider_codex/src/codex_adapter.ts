import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  makeGlobalSessionId,
  type ContentPart,
  type JsonObject,
  type JsonValue,
  type ProviderCapabilities,
  type RemoteMessage,
  type RemoteModel,
  type RemoteSession,
  type SessionContextState,
  type SessionState,
} from "../../protocol/src/index.js";
import {
  buildSpawnCommand,
  JsonLineProcessTransport,
  JsonRpcPeer,
  ProviderAdapterError,
  ProviderEventHub,
  resolveCommand,
  type AgentProviderAdapter,
  type AuthRequest,
  type AuthResult,
  type AuthStatus,
  type CreateSessionOptions,
  type EnqueueProviderMessageRequest,
  type EditMessageRequest,
  type JsonRpcTransport,
  type ListSessionsOptions,
  type PaginatedSessions,
  type ProviderApprovalResponse,
  type ProviderDetection,
  type ProviderClientTooling,
  type ProviderEvent,
  type ProviderEventSink,
  type ProviderQueuedMessage,
  type ProviderUserInputResponse,
  type RestoreProviderMessageRequest,
  type RpcId,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../provider_contract/src/index.js";

import {
  CodexActivityReconciler,
  type CodexActivityReconcilerOptions,
  type CodexContextObservation,
  type CodexObservedMessage,
  type CodexTurnMetadata,
} from "./activity.js";
import { externalSessionLaunchesFromCommand } from "./external_launches.js";
import { codexTurnInput } from "./codex_input.js";
import { CodexDesktopQueue } from "./desktop_queue.js";
import { isRecord, jsonObject, messagesFromCodexThread, normalizeCodexStatus, normalizeCodexThread } from "./normalize.js";
import type { AccountReadResponse, ModelListResponse, ThreadForkResponse, ThreadListResponse, ThreadResponse, TurnResponse } from "./wire.js";

interface PendingServerRequest {
  readonly method: string;
  readonly providerSessionId: string;
  readonly params?: Record<string, unknown>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export interface CodexAdapterOptions {
  readonly hostId: string;
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly cwd?: string;
  readonly transportFactory?: () => JsonRpcTransport;
  readonly requestTimeoutMs?: number;
  /** Grace period before a bridge-approved idle transport is closed. */
  readonly idleReleaseMs?: number;
  readonly now?: () => Date;
  /** Explicit opt-in to reading Codex-owned rollout and lock files. */
  readonly localActivity?: false | Omit<CodexActivityReconcilerOptions, "onStateChanged" | "onMessage" | "onTurnMetadataChanged" | "onContextChanged">;
  /** Explicit opt-in to Codex Desktop's private queue state and IPC surface. */
  readonly desktopQueue?: false | { readonly statePath?: string; readonly pipePath?: string };
}

const defaultIdleReleaseMs = 3_000;

const capabilities: ProviderCapabilities = {
  authentication: true,
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
  messageEditing: true,
  remoteConnectivity: "experimental_remote",
  notes: [
    "Uses the documented local Codex App Server protocol; provider credentials stay with Codex on the host.",
    "Codex WebSocket transport is documented as experimental, so the adapter defaults to stdio JSONL.",
  ],
};

function codexHistoryIdentity(message: RemoteMessage): string {
  return `${message.role}:${message.providerMessageId}:${message.parts.map((part) => part.type).join(",")}`;
}

function messageTextSize(message: RemoteMessage): number {
  return message.parts.reduce((total, part) => total + ((part.type === "text" || part.type === "reasoning") ? part.text.length : 0), 0);
}

/** Authoritative thread history owns chronology; rollout observations add fresher live detail. */
export function mergeCodexMessageHistory(
  canonical: readonly RemoteMessage[],
  observed: readonly RemoteMessage[],
): readonly RemoteMessage[] {
  const merged = [...canonical];
  const indexes = new Map(merged.map((message, index) => [codexHistoryIdentity(message), index]));
  for (const message of observed) {
    const key = codexHistoryIdentity(message);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, merged.length);
      merged.push(message);
      continue;
    }
    const current = merged[index]!;
    if (message.status === "streaming" || messageTextSize(message) > messageTextSize(current)) merged[index] = message;
  }
  return merged.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export class CodexAdapter implements AgentProviderAdapter {
  public readonly providerId = "codex";
  public readonly displayName = "OpenAI Codex";
  public readonly sessionCreationFeatures = {
    hiddenDeveloperInstructions: true,
    ephemeralSessions: true,
    selectableClientTools: true,
  } as const;
  public readonly listQueuedMessages?: () => Promise<readonly ProviderQueuedMessage[]>;
  public readonly enqueueQueuedMessage?: (providerSessionId: string, request: EnqueueProviderMessageRequest) => Promise<ProviderQueuedMessage>;
  public readonly sendMessageToExternalOwner?: (providerSessionId: string, request: SendMessageRequest) => Promise<SendMessageResult>;
  public readonly restoreQueuedMessage?: (providerSessionId: string, request: RestoreProviderMessageRequest) => Promise<ProviderQueuedMessage>;
  public readonly updateQueuedMessage?: (providerSessionId: string, messageId: string, content: string) => Promise<ProviderQueuedMessage | null>;
  public readonly cancelQueuedMessage?: (providerSessionId: string, messageId: string) => Promise<boolean>;
  public readonly steerQueuedMessage?: (providerSessionId: string, messageId: string, request: SendMessageRequest) => Promise<SendMessageResult>;
  readonly #events = new ProviderEventHub();
  readonly #pendingServerRequests = new Map<string, PendingServerRequest>();
  readonly #currentTurns = new Map<string, string>();
  readonly #ownedThreads = new Set<string>();
  readonly #hostId: string;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #cwd: string | undefined;
  readonly #transportFactory: (() => JsonRpcTransport) | undefined;
  readonly #requestTimeoutMs: number;
  readonly #idleReleaseMs: number;
  readonly #now: () => Date;
  readonly #activity: CodexActivityReconciler | null;
  readonly #desktopQueue: CodexDesktopQueue | null;
  readonly #sessionStates = new Map<string, SessionState>();
  readonly #sessionMetadata = new Map<string, CodexTurnMetadata>();
  readonly #sessionContext = new Map<string, Omit<SessionContextState, "sessionId" | "compactionThresholdTokens" | "minimumThresholdTokens" | "supportsThreshold" | "isCompacting" | "compactionKind">>();
  #peer: JsonRpcPeer | null = null;
  #startingPeer: JsonRpcPeer | null = null;
  #initializing: Promise<JsonRpcPeer> | null = null;
  #closing: Promise<void> | null = null;
  #idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  #resourceGeneration = 0;
  #disposed = false;
  #eventCounter = 0;
  #clientTooling: ProviderClientTooling | undefined;

  public constructor(options: CodexAdapterOptions) {
    this.#hostId = options.hostId;
    this.#command = options.command ?? "codex";
    this.#args = options.commandArgs ?? ["app-server", "--listen", "stdio://"];
    this.#cwd = options.cwd;
    this.#transportFactory = options.transportFactory;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.#idleReleaseMs = options.idleReleaseMs ?? defaultIdleReleaseMs;
    this.#now = options.now ?? (() => new Date());
    this.#activity = options.localActivity === undefined || options.localActivity === false
      ? null
      : new CodexActivityReconciler({
          ...options.localActivity,
          onStateChanged: (providerSessionId, state) => this.emitSessionState(providerSessionId, state),
          onMessage: (providerSessionId, message) => this.emitObservedMessage(providerSessionId, message),
          onTurnMetadataChanged: (providerSessionId, metadata) => this.applySessionMetadata(providerSessionId, metadata, true),
          onContextChanged: (providerSessionId, context) => this.applyObservedContext(providerSessionId, context),
        });
    this.#desktopQueue = options.desktopQueue === undefined || options.desktopQueue === false
      ? null
      : new CodexDesktopQueue({
          ...(options.desktopQueue.statePath !== undefined ? { statePath: options.desktopQueue.statePath } : {}),
          ...(options.desktopQueue.pipePath !== undefined ? { pipePath: options.desktopQueue.pipePath } : {}),
          onChanged: (messages) => this.emitDesktopQueueChanges(messages),
        });
    if (this.#desktopQueue !== null) {
      const desktopQueue = this.#desktopQueue;
      this.listQueuedMessages = async () => {
        await desktopQueue.start();
        return desktopQueue.list();
      };
      this.enqueueQueuedMessage = async (providerSessionId, request) => await desktopQueue.enqueue(providerSessionId, request);
      this.sendMessageToExternalOwner = async (providerSessionId, request) =>
        await desktopQueue.tryStartTurn(providerSessionId, request) ?? await this.sendMessageToAppServer(providerSessionId, request);
      this.restoreQueuedMessage = async (providerSessionId, request) => await desktopQueue.restore(providerSessionId, request);
      this.updateQueuedMessage = async (providerSessionId, messageId, content) => await desktopQueue.update(providerSessionId, messageId, content);
      this.cancelQueuedMessage = async (providerSessionId, messageId) => await desktopQueue.cancel(providerSessionId, messageId);
      this.steerQueuedMessage = async (providerSessionId, messageId, request) => await desktopQueue.steerQueuedMessage(providerSessionId, messageId, request);
    }
  }

  public configureClientTooling(tooling: ProviderClientTooling): void {
    this.#clientTooling = tooling;
  }

  public async detect(): Promise<ProviderDetection> {
    if (this.#transportFactory !== undefined) return { providerId: this.providerId, available: true, version: "injected-transport", details: ["Transport supplied by caller."] };
    return await new Promise((resolve) => {
      const resolved = resolveCommand(this.#command);
      const launch = buildSpawnCommand(resolved, ["--version"]);
      execFile(launch.command, [...launch.args], { timeout: 5_000, ...(launch.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}) }, (error, stdout) => {
        if (error !== null) {
          resolve({ providerId: this.providerId, available: false, executable: this.#command, details: [`${error.message} (resolved ${resolved.file})`] });
          return;
        }
        const version = stdout.trim();
        resolve({ providerId: this.providerId, available: true, executable: this.#command, ...(version ? { version } : {}), details: [`resolved ${resolved.file}`] });
      });
    });
  }

  public async getAuthStatus(): Promise<AuthStatus> {
    const peer = await this.peer();
    const response = await peer.request<AccountReadResponse>("account/read", { refreshToken: false });
    const account = response.account;
    const label = isRecord(account) ? [account.email, account.name].find((value): value is string => typeof value === "string") : undefined;
    return {
      authenticated: account !== null && account !== undefined,
      canAuthenticate: true,
      ...(label !== undefined ? { accountLabel: label } : {}),
      details: response.requiresOpenaiAuth === true ? ["Codex reports that OpenAI authentication is required."] : [],
    };
  }

  public async authenticate(request: AuthRequest): Promise<AuthResult> {
    const peer = await this.peer();
    const method = request.method ?? "chatgpt";
    let params: unknown;
    if (method === "apiKey") {
      if (!request.credential) throw new ProviderAdapterError(this.providerId, "AUTH_CREDENTIAL_REQUIRED", "An API key is required for Codex API-key login", false);
      params = { type: "apiKey", apiKey: request.credential };
    } else if (method === "chatgptDeviceCode") {
      params = { type: "chatgptDeviceCode" };
    } else if (method === "chatgpt") {
      params = { type: "chatgpt" };
    } else {
      throw new ProviderAdapterError(this.providerId, "AUTH_METHOD_UNSUPPORTED", `Unsupported Codex login method ${method}`, false);
    }
    const response = await peer.request<unknown>("account/login/start", params);
    const result = isRecord(response) ? response : {};
    const verificationUri = [result.authUrl, result.verificationUri, result.verification_url].find((value): value is string => typeof value === "string");
    const userCode = [result.userCode, result.user_code].find((value): value is string => typeof value === "string");
    return {
      authenticated: result.completed === true,
      pending: result.completed !== true,
      ...(verificationUri !== undefined ? { verificationUri } : {}),
      ...(userCode !== undefined ? { userCode } : {}),
      details: ["The documented Codex login flow runs on the host; no browser cookie is copied to the remote device."],
    };
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    return capabilities;
  }

  public async listModels(): Promise<readonly RemoteModel[]> {
    const peer = await this.peer();
    const models: RemoteModel[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await peer.request<ModelListResponse>("model/list", { ...(cursor ? { cursor } : {}), limit: 100 });
      const page = response.data ?? [];
      for (const value of page) {
        if (!isRecord(value)) continue;
        const id = [value.id, value.model, value.slug].find((candidate): candidate is string => typeof candidate === "string");
        if (id === undefined) continue;
        const displayName = [value.displayName, value.name].find((candidate): candidate is string => typeof candidate === "string") ?? id;
        const modalities = codexModelInputModalities(id, value.inputModalities);
        models.push({
          id,
          providerId: this.providerId,
          displayName,
          ...(typeof value.description === "string" ? { description: value.description } : {}),
          isDefault: value.isDefault === true || value.default === true,
          ...(modalities !== undefined ? { inputModalities: modalities } : {}),
          nativeMetadata: jsonObject(value),
        });
      }
      cursor = response.nextCursor;
    } while (cursor !== null && cursor !== undefined);
    return models;
  }

  public async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const peer = await this.peer();
    const response = await peer.request<ThreadListResponse>("thread/list", {
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.sortKey !== undefined ? { sortKey: options.sortKey } : {}),
      ...(options.sortDirection !== undefined ? { sortDirection: options.sortDirection } : {}),
      ...(options.workingDirectory !== undefined ? { cwd: options.workingDirectory } : {}),
      ...(options.parentProviderSessionId !== undefined ? { parentThreadId: options.parentProviderSessionId } : {}),
      archived: false,
    });
    const sessions = [...await this.normalizeThreads(response.data)];
    if (options.cursor === undefined && this.#activity !== null) {
      const listed = new Set(response.data.map((thread) => thread.id));
      const missingActiveIds = (await this.#activity.activeThreadIds()).filter((providerSessionId) => !listed.has(providerSessionId));
      const activeThreads = await Promise.all(missingActiveIds.map(async (providerSessionId) => {
        try {
          return (await peer.request<ThreadResponse>("thread/read", { threadId: providerSessionId, includeTurns: false })).thread;
        } catch {
          return null;
        }
      }));
      const activeSessions = await Promise.all((await this.normalizeThreads(activeThreads.filter((thread): thread is NonNullable<typeof thread> => thread !== null)))
        .map(async (session) => this.withRecentActivityPreview(session)));
      sessions.unshift(...activeSessions);
    }
    return { sessions, nextCursor: response.nextCursor };
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    const response = await (await this.peer()).request<ThreadResponse>("thread/read", { threadId: providerSessionId, includeTurns: false });
    return (await this.normalizeThreads([response.thread]))[0] ?? normalizeCodexThread(this.#hostId, response.thread);
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const observed = await this.#activity?.recentMessages(providerSessionId) ?? [];
    const sessionId = makeGlobalSessionId(this.#hostId, this.providerId, providerSessionId);
    let latestLiveIndex = -1;
    if (this.#sessionStates.get(providerSessionId) === "working") {
      for (let index = observed.length - 1; index >= 0; index -= 1) {
        const message = observed[index];
        if (message?.role === "assistant" && (message.partType === "reasoning" || message.phase === "commentary")) {
          latestLiveIndex = index;
          break;
        }
      }
    }
    const observedMessages: readonly RemoteMessage[] = observed.map((message, index) => {
      const createdAt = validIsoTimestamp(message.createdAt) ?? new Date(index).toISOString();
      const running = index === latestLiveIndex;
      return {
        id: `codex/rollout/${message.messageId}/${message.partType}`,
        sessionId,
        providerMessageId: message.messageId,
        role: message.role,
        createdAt,
        ...(running ? {} : { completedAt: createdAt }),
        parts: message.partType === "reasoning"
          ? [{ type: "reasoning" as const, text: message.text, redacted: false }]
          : message.parts?.length
            ? message.parts
            : [{ type: "text" as const, text: message.text }],
        status: running ? "streaming" as const : "completed" as const,
        nativeMetadata: message.phase !== undefined ? { phase: message.phase } : {},
      };
    });
    try {
      const response = await (await this.peer()).request<ThreadResponse>("thread/read", { threadId: providerSessionId, includeTurns: true });
      return mergeCodexMessageHistory(messagesFromCodexThread(this.#hostId, response.thread), observedMessages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (observedMessages.length > 0) return observedMessages;
      if (/thread\s+[0-9a-f-]+\s+is not materialized yet; includeTurns is unavailable before first user message/iu.test(message)) return [];
      throw error;
    }
  }

  public async getSessionContext(providerSessionId: string): Promise<Omit<SessionContextState, "sessionId" | "compactionThresholdTokens" | "minimumThresholdTokens" | "supportsThreshold" | "isCompacting" | "compactionKind">> {
    return this.#sessionContext.get(providerSessionId) ?? {
      ...(this.#sessionMetadata.get(providerSessionId)?.modelId !== undefined ? { modelId: this.#sessionMetadata.get(providerSessionId)!.modelId } : {}),
      usedTokens: null,
      contextWindowTokens: null,
      usedPercent: null,
      supportsManualCompaction: true,
      updatedAt: this.#now().toISOString(),
      usage: {},
    };
  }

  public async compactSession(providerSessionId: string): Promise<void> {
    await (await this.peer()).request("thread/compact/start", { threadId: providerSessionId });
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    const response = await (await this.peer()).request<ThreadResponse>("thread/start", {
      cwd: options.workingDirectory,
      ...(options.modelId !== undefined ? { model: options.modelId } : {}),
      ...(options.developerInstructions !== undefined ? { developerInstructions: options.developerInstructions } : {}),
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
      ...(options.mcpServers === "none" ? { config: { mcp_servers: {} } } : {}),
      ...(this.#clientTooling !== undefined && options.clientTools !== "none" ? {
        dynamicTools: this.#clientTooling.definitions.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      } : {}),
    });
    this.#ownedThreads.add(response.thread.id);
    let session = (await this.normalizeThreads([response.thread]))[0] ?? normalizeCodexThread(this.#hostId, response.thread);
    if (options.modelId !== undefined) {
      await this.applySessionMetadata(response.thread.id, { modelId: options.modelId }, false);
      session = { ...session, modelId: options.modelId };
    }
    if (options.firstInstruction !== undefined) {
      await this.sendMessage(response.thread.id, {
        requestId: `create_${randomUUID()}`,
        content: options.firstInstruction,
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });
    }
    return session;
  }

  public async branchSession(providerSessionId: string): Promise<RemoteSession> {
    const response = await (await this.peer()).request<ThreadForkResponse>("thread/fork", { threadId: providerSessionId });
    this.#ownedThreads.add(response.thread.id);
    let session = (await this.normalizeThreads([response.thread]))[0] ?? normalizeCodexThread(this.#hostId, response.thread);
    const modelId = response.model ?? this.#sessionMetadata.get(providerSessionId)?.modelId;
    const reasoningEffort = response.reasoningEffort ?? this.#sessionMetadata.get(providerSessionId)?.reasoningEffort;
    if (modelId !== undefined || reasoningEffort !== undefined) {
      await this.applySessionMetadata(response.thread.id, {
        ...(modelId !== undefined ? { modelId } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      }, false);
      session = {
        ...session,
        ...(modelId !== undefined ? { modelId } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      };
    }
    return session;
  }

  public async resumeSession(providerSessionId: string): Promise<void> {
    const response = await (await this.peer()).request<ThreadResponse>("thread/resume", { threadId: providerSessionId });
    if (response.thread.id !== providerSessionId) throw new ProviderAdapterError(this.providerId, "RESUME_ID_MISMATCH", "Codex resumed a different thread ID", false);
    this.#ownedThreads.add(providerSessionId);
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    if ((request.attachments?.length ?? 0) > 0 && this.#desktopQueue !== null) {
      const desktopResult = await this.#desktopQueue.tryStartTurn(providerSessionId, request);
      if (desktopResult !== null) return desktopResult;
    }
    return await this.sendMessageToAppServer(providerSessionId, request);
  }

  private async sendMessageToAppServer(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const input = codexTurnInput(request);
    const peer = await this.peer();
    const params = {
      threadId: providerSessionId,
      clientUserMessageId: request.requestId,
      input,
      ...(request.modelId !== undefined ? { model: request.modelId } : {}),
      ...(request.reasoningEffort !== undefined ? { effort: request.reasoningEffort } : {}),
    };
    let response: TurnResponse;
    try {
      response = await peer.request<TurnResponse>("turn/start", params);
    } catch (error) {
      if (!isCodexThreadNotFound(error)) throw error;
      const resumed = await peer.request<ThreadResponse>("thread/resume", { threadId: providerSessionId });
      if (resumed.thread.id !== providerSessionId) {
        throw new ProviderAdapterError(this.providerId, "RESUME_ID_MISMATCH", "Codex resumed a different thread ID", false);
      }
      this.#ownedThreads.add(providerSessionId);
      response = await peer.request<TurnResponse>("turn/start", params);
    }
    this.#ownedThreads.add(providerSessionId);
    const turnId = response.turn?.id;
    if (turnId !== undefined) this.#currentTurns.set(providerSessionId, turnId);
    if (request.modelId !== undefined || request.reasoningEffort !== undefined) {
      await this.applySessionMetadata(providerSessionId, {
        ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
        ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
      }, true);
    }
    return { accepted: true, ...(turnId !== undefined ? { providerTurnId: turnId } : {}), details: [] };
  }

  public hasActiveTurn(providerSessionId: string): boolean {
    return this.#sessionStates.get(providerSessionId) === "working";
  }

  public async steerMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const expectedTurnId = this.#currentTurns.get(providerSessionId);
    if (expectedTurnId === undefined) {
      throw new ProviderAdapterError(this.providerId, "NO_ACTIVE_TURN", "No active Codex turn is available to steer", false);
    }
    const input = codexTurnInput(request);
    const response = await (await this.peer()).request<{ readonly turnId: string }>("turn/steer", {
      threadId: providerSessionId,
      clientUserMessageId: request.requestId,
      input,
      expectedTurnId,
    });
    return { accepted: true, providerTurnId: response.turnId, details: ["Instruction steered into the active Codex turn."] };
  }

  public async editMessage(providerSessionId: string, request: EditMessageRequest): Promise<SendMessageResult> {
    const response = await (await this.peer()).request<ThreadResponse>("thread/read", {
      threadId: providerSessionId,
      includeTurns: true,
    });
    const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
    const targetIndex = turns.findIndex((turn) => {
      if (!isRecord(turn) || !Array.isArray(turn.items)) return false;
      return turn.items.some((item) =>
        isRecord(item) && item.type === "userMessage" && item.id === request.providerMessageId
      );
    });
    if (targetIndex < 0) {
      throw new ProviderAdapterError(this.providerId, "MESSAGE_NOT_EDITABLE", "Codex could not map that message to a persisted turn", false);
    }
    const targetTurn = turns[targetIndex];
    if (!isRecord(targetTurn) || !Array.isArray(targetTurn.items)) {
      throw new ProviderAdapterError(this.providerId, "MESSAGE_NOT_EDITABLE", "Codex returned an invalid target turn", false);
    }
    const userItems = targetTurn.items.filter((item) => isRecord(item) && item.type === "userMessage");
    const target = userItems.find((item) => isRecord(item) && item.id === request.providerMessageId);
    if (!isRecord(target) || userItems.length !== 1 || !isPlainTextUserMessage(target)) {
      throw new ProviderAdapterError(this.providerId, "MESSAGE_NOT_EDITABLE", "Only a standalone plain-text Codex message can be edited safely", false);
    }
    const activeTurn = turns.slice(targetIndex).some((turn) =>
      isRecord(turn) && (turn.status === "inProgress" || turn.status === "in_progress" || turn.status === "running")
    );
    if (activeTurn) {
      throw new ProviderAdapterError(this.providerId, "TURN_ACTIVE", "Stop the active Codex turn before editing a message", false);
    }
    await (await this.peer()).request("thread/rollback", {
      threadId: providerSessionId,
      numTurns: turns.length - targetIndex,
    });
    return await this.sendMessage(providerSessionId, {
      requestId: request.requestId,
      content: request.content,
      ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
      ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
    });
  }

  public async interrupt(providerSessionId: string): Promise<void> {
    const turnId = this.#currentTurns.get(providerSessionId);
    if (turnId === undefined) throw new ProviderAdapterError(this.providerId, "NO_ACTIVE_TURN", "No active Codex turn is known for this thread", false);
    await (await this.peer()).request("turn/interrupt", { threadId: providerSessionId, turnId });
  }

  public async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    await this.peer();
    return this.#events.subscribe(providerSessionId, sink);
  }

  public async respondToApproval(response: ProviderApprovalResponse): Promise<void> {
    const pending = this.#pendingServerRequests.get(response.providerRequestId);
    if (pending === undefined) throw new ProviderAdapterError(this.providerId, "APPROVAL_NOT_FOUND", "Codex approval request is stale or unknown", false);
    const kind = approvalKindForMethod(pending.method);
    if (kind === null) throw new ProviderAdapterError(this.providerId, "REQUEST_KIND_MISMATCH", "Pending Codex request is not an approval", false);
    if (response.choiceId !== "approve" && response.choiceId !== "reject") throw new ProviderAdapterError(this.providerId, "APPROVAL_CHOICE_INVALID", "Only approve and reject are exposed by this client", false);
    const approved = response.choiceId === "approve";
    this.#pendingServerRequests.delete(response.providerRequestId);
    if (kind === "decision") {
      // item/commandExecution/requestApproval and item/fileChange/requestApproval.
      pending.resolve({ decision: approved ? "accept" : "decline" });
    } else if (kind === "review") {
      // Legacy applyPatchApproval and execCommandApproval use ReviewDecision.
      pending.resolve({ decision: approved ? "approved" : { denied: { rejection: "Rejected from Tethoq." } } });
    } else {
      // item/permissions/requestApproval has no decline case; rejecting grants
      // an empty profile for the current turn only. Approval never grants
      // session-wide permissions from this client.
      const requested = isRecord(pending.params) ? pending.params.permissions : undefined;
      pending.resolve({ permissions: approved ? grantedProfile(requested) : {}, scope: "turn" });
    }
  }

  public async respondToUserInput(response: ProviderUserInputResponse): Promise<void> {
    const pending = this.#pendingServerRequests.get(response.providerRequestId);
    if (pending === undefined || !pending.method.includes("requestUserInput")) throw new ProviderAdapterError(this.providerId, "INPUT_REQUEST_NOT_FOUND", "Codex input request is stale or unknown", false);
    this.#pendingServerRequests.delete(response.providerRequestId);
    pending.resolve({ answers: codexAnswersFromUserResponse(response.answers) });
  }

  public async releaseIdleResources(): Promise<void> {
    if (this.#disposed) return;
    this.cancelIdleRelease();
    const generation = this.#resourceGeneration;
    const timer = setTimeout(() => {
      if (this.#idleReleaseTimer === timer) this.#idleReleaseTimer = null;
      void this.closeIdlePeer(generation).catch(() => undefined);
    }, this.#idleReleaseMs);
    timer.unref();
    this.#idleReleaseTimer = timer;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resourceGeneration += 1;
    this.cancelIdleRelease();
    this.#desktopQueue?.dispose();
    this.#activity?.dispose();
    for (const pending of this.#pendingServerRequests.values()) pending.reject(new Error("Codex adapter disposed"));
    this.#pendingServerRequests.clear();
    this.#ownedThreads.clear();
    this.#events.clear();
    const startingPeer = this.#startingPeer;
    if (startingPeer !== null) await startingPeer.close().catch(() => undefined);
    const initializing = this.#initializing;
    if (initializing !== null) await initializing.catch(() => undefined);
    const closing = this.#closing;
    if (closing !== null) await closing.catch(() => undefined);
    const peer = this.#peer;
    this.#peer = null;
    if (peer !== null) await peer.close().catch(() => undefined);
  }

  private async peer(): Promise<JsonRpcPeer> {
    if (this.#disposed) throw new ProviderAdapterError(this.providerId, "ADAPTER_DISPOSED", "Codex adapter has been disposed", false);
    this.#resourceGeneration += 1;
    this.cancelIdleRelease();
    const closing = this.#closing;
    if (closing !== null) await closing;
    if (this.#disposed) throw new ProviderAdapterError(this.providerId, "ADAPTER_DISPOSED", "Codex adapter has been disposed", false);
    if (this.#peer !== null) return this.#peer;
    if (this.#initializing !== null) return await this.#initializing;
    const initializing = this.initialize();
    this.#initializing = initializing;
    try {
      return await initializing;
    } finally {
      if (this.#initializing === initializing) this.#initializing = null;
    }
  }

  private async initialize(): Promise<JsonRpcPeer> {
    const transport = this.#transportFactory?.() ?? new JsonLineProcessTransport({
      command: this.#command,
      args: this.#args,
      ...(this.#cwd !== undefined ? { cwd: this.#cwd } : {}),
    });
    const peer = new JsonRpcPeer(transport, {
      includeJsonRpc: false,
      timeoutMs: this.#requestTimeoutMs,
      idPrefix: "codex",
      onError: (error) => this.emit({
        type: "provider.disconnected",
        payload: { message: error.message, source: "json_rpc_callback" },
      }),
    });
    this.#startingPeer = peer;
    peer.onNotification((method, params) => this.handleNotification(method, params));
    peer.onRequest((method, params, id) => this.handleServerRequest(method, params, id));
    try {
      await peer.request("initialize", {
        clientInfo: { name: "tethoq", title: "Tethoq", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      await peer.notify("initialized", undefined);
      if (this.#disposed) throw new Error("Codex adapter disposed during initialization");
      this.#peer = peer;
      return peer;
    } catch (error) {
      await peer.close();
      throw new ProviderAdapterError(this.providerId, "INITIALIZE_FAILED", `Codex App Server initialization failed: ${error instanceof Error ? error.message : String(error)}`, true, { cause: error });
    } finally {
      if (this.#startingPeer === peer) this.#startingPeer = null;
    }
  }

  private cancelIdleRelease(): void {
    if (this.#idleReleaseTimer === null) return;
    clearTimeout(this.#idleReleaseTimer);
    this.#idleReleaseTimer = null;
  }

  private async closeIdlePeer(generation: number): Promise<void> {
    if (this.#disposed || generation !== this.#resourceGeneration) return;
    const initializing = this.#initializing;
    if (initializing !== null) await initializing.catch(() => undefined);
    if (this.#disposed || generation !== this.#resourceGeneration) return;
    const peer = this.#peer;
    if (peer === null) return;
    this.#peer = null;
    const closing = peer.close();
    this.#closing = closing;
    try {
      await closing;
    } finally {
      this.#ownedThreads.clear();
      if (this.#closing === closing) this.#closing = null;
    }
  }

  private async handleServerRequest(method: string, params: unknown, id: RpcId): Promise<unknown> {
    const requestId = String(id);
    const source = isRecord(params) ? params : {};
    const providerSessionId = [source.threadId, source.conversationId, source.sessionId].find((value): value is string => typeof value === "string") ?? "unknown";
    if (method === "item/tool/call") {
      if (this.#clientTooling === undefined) throw new ProviderAdapterError(this.providerId, "CLIENT_TOOLS_UNAVAILABLE", "Client tools are not configured", false);
      const tool = typeof source.tool === "string" ? source.tool : undefined;
      const input = isRecord(source.arguments) ? jsonObject(source.arguments) : {};
      if (tool === undefined) throw new ProviderAdapterError(this.providerId, "CLIENT_TOOL_INVALID", "Codex requested an unnamed client tool", false);
      try {
        const output = await this.#clientTooling.execute(this.providerId, providerSessionId, tool, input);
        return { contentItems: [{ type: "inputText", text: JSON.stringify(output) }], success: true };
      } catch (error) {
        return { contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }], success: false };
      }
    }
    if (method.includes("requestApproval") || method === "applyPatchApproval" || method === "execCommandApproval") {
      const command = extractCommand(source);
      const affectedFiles = extractFiles(source);
      const choice = await new Promise<unknown>((resolve, reject) => {
        this.#pendingServerRequests.set(requestId, { method, providerSessionId, params: source, resolve, reject });
        void this.emit({
          type: "approval.requested",
          providerSessionId,
          payload: { providerRequestId: requestId, method },
          approval: {
            providerRequestId: requestId,
            providerSessionId,
            title: approvalTitle(method),
            ...(typeof source.reason === "string" ? { reason: source.reason } : {}),
            ...(command !== undefined ? { command } : {}),
            ...(typeof source.cwd === "string" ? { workingDirectory: source.cwd } : {}),
            affectedFiles,
            networkDestinations: extractNetworkDestinations(source),
            riskMetadata: jsonObject(source),
            choices: [
              { id: "approve", label: "Approve", kind: "approve" },
              { id: "reject", label: "Reject", kind: "reject" },
            ],
          },
        });
      });
      return choice;
    }
    if (method.includes("requestUserInput") || method.includes("elicitation/request")) {
      return await new Promise<unknown>((resolve, reject) => {
        this.#pendingServerRequests.set(requestId, { method, providerSessionId, params: source, resolve, reject });
        const enriched = userInputRequestPayload(source);
        void this.emit({ type: "user_input.requested", providerSessionId, payload: { providerRequestId: requestId, request: enriched } });
      });
    }
    throw new ProviderAdapterError(this.providerId, "SERVER_REQUEST_UNSUPPORTED", `Codex server requested unsupported client method ${method}`, false);
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    const source = isRecord(params) ? params : {};
    const providerSessionId = [source.threadId, isRecord(source.thread) ? source.thread.id : undefined].find((value): value is string => typeof value === "string");
    const turnId = [source.turnId, isRecord(source.turn) ? source.turn.id : undefined].find((value): value is string => typeof value === "string");
    if (providerSessionId !== undefined && turnId !== undefined && method === "turn/started") this.#currentTurns.set(providerSessionId, turnId);
    if (providerSessionId !== undefined && method === "turn/completed") this.#currentTurns.delete(providerSessionId);

    if (providerSessionId !== undefined && method === "thread/tokenUsage/updated") {
      const tokenUsage = isRecord(source.tokenUsage) ? source.tokenUsage : source;
      const total = isRecord(tokenUsage.total) ? tokenUsage.total : tokenUsage;
      const last = isRecord(tokenUsage.last) ? tokenUsage.last : {};
      const contextWindowTokens = firstFiniteNumber(tokenUsage.modelContextWindow, source.modelContextWindow);
      // `total` is the lifetime amount billed across every turn in this thread.
      // It can reach tens of millions while the model's current prompt still
      // occupies only a few thousand tokens, especially immediately after a
      // compaction. Automatic compaction must follow the current/last window or
      // it will consider the task permanently full and compact after every turn.
      const usedTokens = firstFiniteNumber(last.totalTokens, tokenUsage.lastTotalTokens, tokenUsage.totalTokens, total.totalTokens);
      const inputTokens = firstFiniteNumber(last.inputTokens, tokenUsage.lastInputTokens, tokenUsage.inputTokens, total.inputTokens);
      const outputTokens = firstFiniteNumber(last.outputTokens, tokenUsage.lastOutputTokens, tokenUsage.outputTokens, total.outputTokens);
      const cacheReadTokens = firstFiniteNumber(last.cachedInputTokens, last.cacheReadTokens, tokenUsage.lastCachedInputTokens, tokenUsage.cachedInputTokens, total.cachedInputTokens, total.cacheReadTokens);
      this.#sessionContext.set(providerSessionId, {
        ...(this.#sessionMetadata.get(providerSessionId)?.modelId !== undefined ? { modelId: this.#sessionMetadata.get(providerSessionId)!.modelId } : {}),
        usedTokens: usedTokens ?? null,
        contextWindowTokens: contextWindowTokens ?? null,
        usedPercent: usedTokens !== undefined && contextWindowTokens !== undefined && contextWindowTokens > 0
          ? Math.max(0, Math.min(100, usedTokens / contextWindowTokens * 100))
          : null,
        supportsManualCompaction: true,
        updatedAt: this.#now().toISOString(),
        usage: {
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(usedTokens !== undefined ? { totalTokens: usedTokens } : {}),
        },
      });
    }

    if (providerSessionId !== undefined && method === "thread/status/changed") {
      const nativeState = normalizeCodexStatus(source.status);
      const reconciled = await this.#activity?.reconcile([{ providerSessionId, nativeState }]);
      await this.emitSessionState(providerSessionId, reconciled?.get(providerSessionId) ?? nativeState, source);
      return;
    }

    const event = normalizeNotification(method, source, providerSessionId, turnId);
    if (event !== null) await this.emit(event);
  }

  private async emit(input: Omit<ProviderEvent, "eventId" | "providerId" | "occurredAt">): Promise<void> {
    await this.#events.emit({
      eventId: `codex_event_${++this.#eventCounter}`,
      providerId: this.providerId,
      occurredAt: this.#now().toISOString(),
      ...input,
    });
  }

  private async emitDesktopQueueChanges(messages: readonly ProviderQueuedMessage[]): Promise<void> {
    await this.#events.emit({
      eventId: `codex-queue-snapshot-${++this.#eventCounter}`,
      providerId: this.providerId,
      type: "message.queue_updated",
      occurredAt: this.#now().toISOString(),
      payload: { messages: messages as unknown as JsonObject["messages"] },
    });
  }

  private async normalizeThreads(threads: readonly import("./wire.js").CodexThread[]): Promise<readonly RemoteSession[]> {
    const sessions = threads.map((thread) => normalizeCodexThread(this.#hostId, thread));
    const externalWriters = await Promise.all(sessions.map(async (session) =>
      !this.#ownedThreads.has(session.providerSessionId) && await this.#activity?.hasWriterLock(session.providerSessionId) === true));
    const states = await this.#activity?.reconcile(threads.map((thread, index) => ({
      providerSessionId: thread.id,
      ...(thread.path !== undefined ? { path: thread.path } : {}),
      nativeState: sessions[index]?.state ?? "unknown",
    }))) ?? new Map<string, SessionState>();
    return sessions.map((session, index) => {
      const state = states.get(session.providerSessionId) ?? session.state;
      const observedMetadata = this.#activity?.turnMetadata(session.providerSessionId);
      const observedContext = this.#activity?.context(session.providerSessionId);
      const knownMetadata = this.#sessionMetadata.get(session.providerSessionId);
      const metadata: CodexTurnMetadata = {
        ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
        ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
        ...(observedMetadata ?? {}),
        ...(knownMetadata ?? {}),
      };
      if (metadata.modelId !== undefined || metadata.reasoningEffort !== undefined) this.#sessionMetadata.set(session.providerSessionId, metadata);
      if (observedContext !== undefined) this.applyObservedContext(session.providerSessionId, observedContext);
      this.#sessionStates.set(session.providerSessionId, state);
      return {
        ...session,
        state,
        ...(externalWriters[index] === true ? { externalWriter: true } : {}),
        ...(metadata.modelId !== undefined ? { modelId: metadata.modelId } : {}),
        ...(metadata.reasoningEffort !== undefined ? { reasoningEffort: metadata.reasoningEffort } : {}),
      };
    });
  }

  private async withRecentActivityPreview(session: RemoteSession): Promise<RemoteSession> {
    const observed = await this.#activity?.recentMessages(session.providerSessionId) ?? [];
    let latest: CodexObservedMessage | undefined;
    for (let index = observed.length - 1; index >= 0; index -= 1) {
      const candidate = observed[index];
      if (candidate?.partType === "text" && candidate.text.trim().length > 0) {
        latest = candidate;
        break;
      }
    }
    if (latest === undefined) return session;
    const preview = latest.text.trim().replace(/\s+/gu, " ").slice(0, 240);
    const observedAt = validIsoTimestamp(latest.createdAt);
    return {
      ...session,
      preview,
      ...(observedAt !== undefined && observedAt > session.lastActivityAt ? { lastActivityAt: observedAt } : {}),
    };
  }

  private async applySessionMetadata(providerSessionId: string, update: CodexTurnMetadata, emitChange: boolean): Promise<void> {
    const previous = this.#sessionMetadata.get(providerSessionId);
    const next: CodexTurnMetadata = {
      ...(previous ?? {}),
      ...(update.modelId !== undefined ? { modelId: update.modelId } : {}),
      ...(update.reasoningEffort !== undefined ? { reasoningEffort: update.reasoningEffort } : {}),
    };
    if (previous?.modelId === next.modelId && previous?.reasoningEffort === next.reasoningEffort) return;
    this.#sessionMetadata.set(providerSessionId, next);
    if (!emitChange) return;
    await this.emit({
      type: "session.updated",
      providerSessionId,
      payload: {
        ...(next.modelId !== undefined ? { modelId: next.modelId } : {}),
        ...(next.reasoningEffort !== undefined ? { reasoningEffort: next.reasoningEffort } : {}),
      },
    });
  }

  private applyObservedContext(providerSessionId: string, context: CodexContextObservation): void {
    const usedTokens = context.usedTokens;
    const contextWindowTokens = context.contextWindowTokens;
    this.#sessionContext.set(providerSessionId, {
      ...(this.#sessionMetadata.get(providerSessionId)?.modelId !== undefined ? { modelId: this.#sessionMetadata.get(providerSessionId)!.modelId } : {}),
      usedTokens,
      contextWindowTokens,
      usedPercent: usedTokens !== null && contextWindowTokens !== null && contextWindowTokens > 0
        ? Math.max(0, Math.min(100, usedTokens / contextWindowTokens * 100))
        : null,
      supportsManualCompaction: true,
      updatedAt: validIsoTimestamp(context.updatedAt) ?? this.#now().toISOString(),
      usage: {
        ...(context.inputTokens !== undefined ? { inputTokens: context.inputTokens } : {}),
        ...(context.outputTokens !== undefined ? { outputTokens: context.outputTokens } : {}),
        ...(context.cacheReadTokens !== undefined ? { cacheReadTokens: context.cacheReadTokens } : {}),
        ...(context.totalTokens !== undefined ? { totalTokens: context.totalTokens } : {}),
      },
    });
  }

  private async emitSessionState(providerSessionId: string, state: SessionState, nativeSource?: Record<string, unknown>): Promise<void> {
    if (this.#sessionStates.get(providerSessionId) === state) return;
    this.#sessionStates.set(providerSessionId, state);
    await this.emit({
      type: "session.status_changed",
      providerSessionId,
      payload: { ...(nativeSource !== undefined ? jsonObject(nativeSource) : {}), state },
      ...(nativeSource !== undefined ? { nativeEvent: jsonObject({ method: "thread/status/changed", params: nativeSource }) } : {}),
    });
  }

  private async emitObservedMessage(providerSessionId: string, message: CodexObservedMessage): Promise<void> {
    const activities = message.parts ?? [];
    const commands = activities.filter((activity): activity is Extract<ContentPart, { type: "command" }> => activity.type === "command");
    if (commands.length > 0) {
      for (const [index, activity] of commands.entries()) {
        const observedAt = message.createdAt ?? this.#now().toISOString();
        const launches = externalSessionLaunchesFromCommand(activity.command, observedAt);
        await this.emit({
          type: activity.status === "pending" || activity.status === "running" ? "command.started" : "command.completed",
          providerSessionId,
          payload: {
            itemId: commands.length === 1 ? message.messageId : `${message.messageId}:${index + 1}`,
            command: activity.command,
            ...(activity.cwd !== undefined ? { cwd: activity.cwd } : {}),
            ...(activity.output !== undefined ? { output: activity.output } : {}),
            ...(launches.length > 0 ? { externalSessionLaunches: launches as unknown as JsonValue } : {}),
            source: "codex-local-rollout",
          },
        });
      }
      return;
    }
    const activity = activities[0];
    if (activity?.type === "tool") {
      await this.emit({
        type: activity.status === "pending" || activity.status === "running" ? "tool.started" : "tool.completed",
        providerSessionId,
        payload: {
          callId: activity.callId ?? message.messageId,
          name: activity.name,
          ...(activity.input !== undefined ? { input: activity.input } : {}),
          ...(activity.output !== undefined ? { output: activity.output } : {}),
          source: "codex-local-rollout",
        },
      });
      return;
    }
    const base: JsonObject = {
      messageId: message.messageId,
      role: message.role,
      partType: message.partType,
      source: "codex-local-rollout",
      ...(message.phase !== undefined ? { phase: message.phase } : {}),
    };
    // A rollout response_item is already a complete persisted record. Replaying
    // it as started/delta/completed made the renderer briefly mark finished work
    // as live and the text-free completion could erase the answer until history
    // catch-up restored it. One completed event is both faster and truthful.
    await this.emit({ type: "message.completed", providerSessionId, payload: { ...base, text: message.text } });
  }

  public async getExternalSessionLaunches(providerSessionId: string, since: string) {
    return await this.#activity?.externalSessionLaunches(providerSessionId, since) ?? [];
  }
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function inputModalities(value: unknown): readonly ("text" | "image" | "audio")[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modalities = value.filter((entry): entry is "text" | "image" | "audio" => entry === "text" || entry === "image" || entry === "audio");
  return modalities.length > 0 ? modalities : undefined;
}

/** GPT-5.6 Sol accepts native MP3 input even when an older app-server omits it. */
function codexModelInputModalities(id: string, value: unknown): readonly ("text" | "image" | "audio")[] | undefined {
  const reported = inputModalities(value);
  if (id.trim().toLowerCase() !== "gpt-5.6-sol") return reported;
  return [...new Set([...(reported ?? ["text", "image"]), "audio" as const])];
}

function isCodexThreadNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bthread not found\b/iu.test(message);
}

function validIsoTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function extractCommand(source: Record<string, unknown>): string | undefined {
  const command = source.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((entry) => typeof entry === "string")) return command.join(" ");
  if (isRecord(source.item)) return extractCommand(source.item);
  return undefined;
}

function extractFiles(source: Record<string, unknown>): readonly string[] {
  const values = [source.files, source.affectedFiles, source.changes];
  const files = new Set<string>();
  for (const value of values) {
    if (Array.isArray(value)) for (const entry of value) {
      if (typeof entry === "string") files.add(entry);
      else if (isRecord(entry) && typeof entry.path === "string") files.add(entry.path);
    }
  }
  // applyPatchApproval carries a { path: FileChange } map rather than an array.
  if (isRecord(source.fileChanges)) for (const path of Object.keys(source.fileChanges)) files.add(path);
  if (isRecord(source.item)) for (const file of extractFiles(source.item)) files.add(file);
  return [...files];
}

function extractNetworkDestinations(source: Record<string, unknown>): readonly string[] {
  const result = new Set<string>();
  for (const key of ["host", "hostname", "url", "networkDestination"]) {
    if (typeof source[key] === "string") result.add(source[key]);
  }
  return [...result];
}
function approvalKindForMethod(method: string): "decision" | "review" | "permissions" | null {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return "decision";
  if (method === "applyPatchApproval" || method === "execCommandApproval") return "review";
  if (method === "item/permissions/requestApproval") return "permissions";
  return null;
}

function approvalTitle(method: string): string {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") return "Approve command execution";
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") return "Approve file changes";
  if (method === "item/permissions/requestApproval") return "Approve permission request";
  return "Approve Codex action";
}

/** Convert a requested permission profile into a granted profile (nulls removed). */ function grantedProfile(requested: unknown): Record<string, unknown> {   if (!isRecord(requested)) return {};   const result: Record<string, unknown> = {};   if (isRecord(requested.network)) result.network = omitNulls(requested.network);   if (isRecord(requested.fileSystem)) result.fileSystem = omitNulls(requested.fileSystem);   return result; }  function omitNulls(value: Record<string, unknown>): Record<string, unknown> {   const result: Record<string, unknown> = {};   for (const [key, entry] of Object.entries(value)) {     if (entry !== null && entry !== undefined) result[key] = entry;   }   return result; }

/**
 * Normalize remote answers into the Codex ToolRequestUserInputResponse shape:
 * { [questionId]: { answers: string[] } }. Accepts string arrays, native
 * { answers: [...] } objects, or scalar values from older clients.
 */
function codexAnswersFromUserResponse(answers: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      result[key] = { answers: value };
    } else if (isRecord(value) && Array.isArray(value.answers) && value.answers.every((entry) => typeof entry === "string")) {
      result[key] = { answers: value.answers };
    } else {
      result[key] = { answers: [String(value)] };
    }
  }
  return result;
}

function isPlainTextUserMessage(item: Record<string, unknown>): boolean {
  const content = Array.isArray(item.content) ? item.content : [];
  return content.length > 0 && content.every((entry) =>
    isRecord(entry) && (entry.type === "text" || entry.type === "input_text") && typeof entry.text === "string"
  );
}

/**
 * Enrich a Codex user-input request for the bridge registry. The native
 * ToolRequestUserInputParams carries `questions[]`, so surface the first
 * question as the bridge title/prompt when present.
 */
function userInputRequestPayload(source: Record<string, unknown>): JsonObject {
  const payload = { ...jsonObject(source) };
  const questions = Array.isArray(source.questions) ? source.questions : [];
  const first = questions.find((entry): entry is Record<string, unknown> => isRecord(entry));
  if (first !== undefined) {
    if (typeof first.question === "string") payload.question = first.question;
    if (typeof first.header === "string") payload.title = first.header;
    if (typeof first.id === "string") payload.questionId = first.id;
  }
  return payload;
}

function normalizeNotification(
  method: string,
  source: Record<string, unknown>,
  providerSessionId: string | undefined,
  turnId: string | undefined,
): Omit<ProviderEvent, "eventId" | "providerId" | "occurredAt"> | null {
  const base = {
    ...(providerSessionId !== undefined ? { providerSessionId } : {}),
    nativeEvent: jsonObject({ method, params: source }),
  };
  if (method === "thread/started") return { ...base, type: "session.created", payload: { thread: jsonObject(source.thread) } };
  if (method === "turn/started") return { ...base, type: "message.started", payload: { ...(turnId !== undefined ? { turnId } : {}) } };
  if (method === "turn/completed") return { ...base, type: "agent.completed", payload: { ...(turnId !== undefined ? { turnId } : {}), turn: jsonObject(source.turn) } };
  if (method === "item/agentMessage/delta") return { ...base, type: "message.delta", payload: { text: typeof source.delta === "string" ? source.delta : "", ...(typeof source.itemId === "string" ? { itemId: source.itemId } : {}) } };
  if (method === "item/started") {
    const item = isRecord(source.item) ? source.item : {};
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type === "commandExecution") return { ...base, type: "command.started", payload: { command: extractCommand(item) ?? "command", item: jsonObject(item) } };
    if (type === "fileChange") return { ...base, type: "file.changed", payload: { files: [...extractFiles(item)], item: jsonObject(item) } };
    if (type.includes("Tool") || type === "webSearch") return { ...base, type: "tool.started", payload: { name: typeof item.name === "string" ? item.name : type, item: jsonObject(item) } };
    if (type === "agentMessage" || type === "plan" || type === "reasoning") return { ...base, type: "message.started", payload: { item: jsonObject(item) } };
    return null;
  }
  if (method === "item/completed") {
    const item = isRecord(source.item) ? source.item : {};
    const type = typeof item.type === "string" ? item.type : "unknown";
    if (type === "commandExecution") return { ...base, type: "command.completed", payload: { item: jsonObject(item) } };
    if (type === "fileChange") return { ...base, type: "file.changed", payload: { files: [...extractFiles(item)], item: jsonObject(item) } };
    if (type.includes("Tool") || type === "webSearch") return { ...base, type: "tool.completed", payload: { item: jsonObject(item) } };
    if (type === "reasoning") return { ...base, type: "message.completed", payload: { partType: "reasoning", item: jsonObject(item) } };
    if (type === "agentMessage" || type === "plan") return { ...base, type: "message.completed", payload: { item: jsonObject(item) } };
    if (type === "contextCompaction") return { ...base, type: "message.completed", payload: { text: "Session compacted", ...(typeof item.id === "string" ? { itemId: item.id } : {}) } };
    return null;
  }
  if (method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta" || method === "process/outputDelta") return { ...base, type: "command.output", payload: { output: typeof source.delta === "string" ? source.delta : typeof source.output === "string" ? source.output : "" } };
  if (method === "item/mcpToolCall/progress") return { ...base, type: "tool.output", payload: jsonObject(source) };
  if (method === "item/fileChange/outputDelta" || method === "item/fileChange/patchUpdated" || method === "turn/diff/updated" || method === "fs/changed") return { ...base, type: "file.changed", payload: jsonObject(source) };
  if (method === "error") return { ...base, type: "agent.error", payload: jsonObject(source) };
  // The protocol currently has an error terminal but no warning terminal.
  // Relabelling Codex's informational warnings as agent.error briefly fails a
  // successful task and leaves a false "Agent error" row (notably after normal
  // context compaction). Ignore them until there is a truthful warning surface;
  // genuine App Server `error` notifications still flow above unchanged.
  if (method === "warning" || method === "guardianWarning" || method === "configWarning") return null;
  return null;
}
