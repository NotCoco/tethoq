import { randomUUID } from "node:crypto";
import {
  makeGlobalSessionId,
  sessionGoalObjectiveMaxLength,
  type ContentPart,
  type JsonObject,
  type JsonValue,
  type ProviderCapabilities,
  type RemoteMessage,
  type RemoteModel,
  type RemoteSession,
  type SessionContextState,
  type SessionGoalStatus,
  type SessionState,
} from "../../protocol/src/index.js";
import {
  JsonLineProcessTransport,
  JsonRpcPeer,
  JsonRpcRemoteError,
  ProviderAdapterError,
  ProviderEventHub,
  providerPromptContent,
  elicitationResponse,
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
  type RecentProviderMessages,
  type ProviderSessionGoal,
  type ProviderSessionPermissions,
  type ProviderSessionGoalUpdate,
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
import { CodexCommandResolver, probeCodexVersion } from "./codex_command.js";
import { externalSessionLaunchesFromCommand } from "./external_launches.js";
import { codexTurnInput } from "./codex_input.js";
import { CodexSessionPermissions } from "./permissions.js";
import { CodexDesktopQueue } from "./desktop_queue.js";
import { codexVisionIsolationConfig, prepareCodexVisionCatalog, type CodexVisionCatalog } from "./vision_isolation.js";
import { isRecord, jsonObject, messagesFromCodexThread, normalizeCodexStatus, normalizeCodexThread, normalizeCodexThreadName, visibleCodexAssistantDelta, visibleCodexAssistantText } from "./normalize.js";
import type { AccountReadResponse, ModelListResponse, ThreadForkResponse, ThreadGoalClearResponse, ThreadGoalResponse, ThreadListResponse, ThreadResponse, TurnResponse } from "./wire.js";

interface PendingServerRequest {
  readonly method: string;
  readonly providerSessionId: string;
  readonly params?: Record<string, unknown>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingCompaction {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly previousTurnId: string | undefined;
  turnId?: string;
  itemId?: string;
  itemCompleted?: boolean;
}

class CodexPreTurnStartError extends Error {
  public override readonly cause: unknown;

  public constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CodexPreTurnStartError";
    this.cause = cause;
  }
}

export interface CodexAdapterOptions {
  readonly permissionStatePath?: string;
  /** Internal EYES runtime; never enabled on the user's ordinary adapter. */
  readonly isolatedVisionRuntime?: boolean;
  readonly hostId: string;
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly transportFactory?: (args?: readonly string[]) => JsonRpcTransport;
  readonly requestTimeoutMs?: number;
  readonly compactionTimeoutMs?: number;
  /** Grace period before a bridge-approved idle transport is closed. */
  readonly idleReleaseMs?: number;
  readonly now?: () => Date;
  /** Explicit opt-in to reading Codex-owned rollout and lock files. */
  readonly localActivity?: false | Omit<CodexActivityReconcilerOptions, "onStateChanged" | "onMessage" | "onTurnMetadataChanged" | "onContextChanged" | "onActiveThreadDiscovered">;
  /** Explicit opt-in to Codex Desktop's private queue state and IPC surface. */
  readonly desktopQueue?: false | {
    readonly statePath?: string;
    readonly pipePath?: string;
    readonly ownerRecoveryWindowMs?: number;
    readonly ownerRetryDelayMs?: number;
    readonly requestTimeoutMs?: number;
  };
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
  // One Codex item can reach us with a richer or differently ordered part list
  // from the rollout than from App Server history. The provider item id is the
  // identity; part shape is mergeable detail, not a second visible message.
  return `${message.role}:${message.providerMessageId}`;
}

function messageDetailSize(message: RemoteMessage): number {
  return message.parts.reduce((total, part) => {
    if (part.type === "text" || part.type === "reasoning") return total + part.text.length;
    if (part.type === "image") return total + (part.uri?.length ?? 0) + (part.retrievalId?.length ?? 0) + (part.name?.length ?? 0);
    if (part.type === "audio") return total + part.uri.length + part.name.length;
    if (part.type === "file") return total + part.name.length;
    if (part.type === "workflow") return total + part.workflow.name.length;
    return total;
  }, 0);
}

function remoteMessageText(message: RemoteMessage): string {
  return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim();
}

function safeObservedAttachmentName(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw || /^(?:data|file|https?):/iu.test(raw)) return "Attached image";
  const name = raw.replaceAll("\\", "/").split("/").at(-1)?.trim();
  if (!name || name === "." || name === ".." || /[\u0000-\u001f]|;base64,/iu.test(name)) return "Attached image";
  return name.slice(0, 255);
}

function observedImageAttachments(parts: readonly ContentPart[]): JsonObject[] {
  return parts.flatMap((part) => {
    if (part.type !== "image") return [];
    const mimeType = part.mimeType?.trim();
    return [{
      name: safeObservedAttachmentName(part.name),
      ...(mimeType !== undefined && /^image\/[a-z0-9][a-z0-9.+-]*$/iu.test(mimeType) ? { mimeType } : {}),
    }];
  });
}

function isScheduledMessageRequest(request: SendMessageRequest): boolean {
  const scheduledTaskId = request.metadata?.tethoqScheduledTaskId;
  return typeof scheduledTaskId === "string" && scheduledTaskId.trim().length > 0;
}

function normalizedScheduledPrompt(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function codexUserMessageText(item: Record<string, unknown>): string | null {
  const values = Array.isArray(item.content) ? item.content : [item.content ?? item.text];
  const text = values.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (!isRecord(value) || (value.type !== "text" && value.type !== "input_text")) return [];
    return typeof value.text === "string" ? [value.text] : [];
  });
  return text.length > 0 ? text.join("\n") : null;
}

function persistedCodexUserTurn(
  thread: ThreadResponse["thread"],
  requestId: string,
  expectedPrompt: string,
): { readonly turnId?: string } | null {
  for (const turn of thread.turns ?? []) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
    const accepted = turn.items.some((item) => {
      if (!isRecord(item) || item.type !== "userMessage" || item.id !== requestId) return false;
      const text = codexUserMessageText(item);
      return text !== null && normalizedScheduledPrompt(text) === expectedPrompt;
    });
    if (!accepted) continue;
    return typeof turn.id === "string" && turn.id.length > 0 ? { turnId: turn.id } : {};
  }
  return null;
}

function mergeCodexMessageMetadata(current: RemoteMessage, observed: RemoteMessage): RemoteMessage["nativeMetadata"] {
  const currentPhase = current.nativeMetadata.phase;
  const observedPhase = observed.nativeMetadata.phase;
  const phase = currentPhase === "final_answer" || observedPhase === "final_answer"
    ? "final_answer"
    : observedPhase === "commentary" || currentPhase === "commentary"
      ? "commentary"
      : undefined;
  return {
    ...current.nativeMetadata,
    ...observed.nativeMetadata,
    ...(phase !== undefined ? { phase } : {}),
  };
}

function canonicalTimestampIsAuthoritative(message: RemoteMessage): boolean {
  const source = message.nativeMetadata.tethoqCodexTimestampSource;
  // Messages constructed by other adapters/tests predate the source marker;
  // their explicit timestamps remain trustworthy. Codex turn/thread fallbacks
  // are placeholders and must never participate in chronological ordering.
  return source === undefined || source === "item";
}

function mergeMatchingCodexMessages(current: RemoteMessage, observed: RemoteMessage): RemoteMessage {
  const preferred = observed.status === "streaming" || messageDetailSize(observed) > messageDetailSize(current)
    ? observed
    : current;
  return {
    ...preferred,
    // The rollout is append-only and owns the real per-record time. Preserve
    // richer canonical structure without preserving its invented task time.
    createdAt: observed.createdAt,
    ...(observed.completedAt !== undefined ? { completedAt: observed.completedAt } : {}),
    nativeMetadata: mergeCodexMessageMetadata(current, observed),
  };
}

/** Rollout history owns chronology; App Server history adds richer structured detail. */
export function mergeCodexMessageHistory(
  canonical: readonly RemoteMessage[],
  observed: readonly RemoteMessage[],
): readonly RemoteMessage[] {
  if (observed.length === 0) return [...canonical];

  const canonicalByIdentity = new Map(canonical.map((message) => [codexHistoryIdentity(message), message]));
  const matchedCanonical = new Set<string>();
  const mergedIndexes = new Map<string, number>();
  const merged: RemoteMessage[] = [];
  for (const message of observed) {
    if (message.nativeMetadata.terminalFallback === true && canonical.some((candidate) =>
      candidate.role === "assistant" && remoteMessageText(candidate) === remoteMessageText(message))) continue;
    const key = codexHistoryIdentity(message);
    const existingIndex = mergedIndexes.get(key);
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeMatchingCodexMessages(merged[existingIndex]!, message);
      continue;
    }
    const current = canonicalByIdentity.get(key);
    if (current === undefined) {
      mergedIndexes.set(key, merged.length);
      merged.push(message);
      continue;
    }
    matchedCanonical.add(key);
    mergedIndexes.set(key, merged.length);
    merged.push(mergeMatchingCodexMessages(current, message));
  }

  // The rollout is the accurate ordered copy. Insert App Server-only records
  // around its matching anchors while preserving their supplied sequence. An
  // explicit per-item timestamp may place a record chronologically; a
  // task/turn fallback never may.
  for (let canonicalIndex = 0; canonicalIndex < canonical.length; canonicalIndex += 1) {
    const message = canonical[canonicalIndex]!;
    const key = codexHistoryIdentity(message);
    if (matchedCanonical.has(key)) continue;

    if (canonicalTimestampIsAuthoritative(message)) {
      const insertion = merged.findIndex((candidate) => candidate.createdAt.localeCompare(message.createdAt) > 0);
      if (insertion >= 0) merged.splice(insertion, 0, message);
      else merged.push(message);
      continue;
    }

    let nextAnchor = -1;
    for (let next = canonicalIndex + 1; next < canonical.length; next += 1) {
      const nextKey = codexHistoryIdentity(canonical[next]!);
      const candidateIndex = merged.findIndex((candidate) => codexHistoryIdentity(candidate) === nextKey);
      if (candidateIndex < 0) continue;
      nextAnchor = candidateIndex;
      break;
    }
    if (nextAnchor >= 0) merged.splice(nextAnchor, 0, message);
    else merged.push(message);
  }
  return merged;
}

export class CodexAdapter implements AgentProviderAdapter {
  public readonly providerId = "codex";
  public readonly displayName = "OpenAI Codex";
  public readonly sessionCreationFeatures = {
    visionToolIsolation: true,
    hiddenDeveloperInstructions: true,
    ephemeralSessions: true,
    selectableClientTools: true,
  } as const;
  public readonly listQueuedMessages?: () => Promise<readonly ProviderQueuedMessage[]>;
  public readonly enqueueQueuedMessage?: (providerSessionId: string, request: EnqueueProviderMessageRequest) => Promise<ProviderQueuedMessage>;
  public readonly sendMessageToExternalOwner?: (providerSessionId: string, request: SendMessageRequest) => Promise<SendMessageResult>;
  public readonly restoreQueuedMessage?: (providerSessionId: string, request: RestoreProviderMessageRequest) => Promise<ProviderQueuedMessage>;
  public readonly updateQueuedMessage?: (providerSessionId: string, messageId: string, content: string) => Promise<ProviderQueuedMessage | null>;
  public readonly cancelQueuedMessage?: (providerSessionId: string, messageId: string, expectedContent?: string) => Promise<boolean>;
  public readonly readQueuedMessage?: (providerSessionId: string, messageId: string) => Promise<SendMessageRequest | null>;
  public readonly steerQueuedMessage?: (providerSessionId: string, messageId: string, request: SendMessageRequest) => Promise<SendMessageResult>;
  readonly #events = new ProviderEventHub();
  readonly #pendingServerRequests = new Map<string, PendingServerRequest>();
  readonly #sessionPermissions: CodexSessionPermissions;
  readonly #currentTurns = new Map<string, string>();
  readonly #compactions = new Map<string, PendingCompaction>();
  readonly #compactionTurns = new Map<string, string>();
  readonly #ownedThreads = new Set<string>();
  readonly #hostId: string;
  readonly #displayCommand: string;
  readonly #commandResolver: CodexCommandResolver;
  readonly #automaticCommand: boolean;
  readonly #args: readonly string[];
  readonly #cwd: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #transportFactory: ((args?: readonly string[]) => JsonRpcTransport) | undefined;
  readonly #requestTimeoutMs: number;
  readonly #idleReleaseMs: number;
  readonly #now: () => Date;
  readonly #activity: CodexActivityReconciler | null;
  readonly #desktopQueue: CodexDesktopQueue | null;
  readonly #inFlightMessageSends = new Map<string, Promise<SendMessageResult>>();
  readonly #sessionStates = new Map<string, SessionState>();
  readonly #sessionMetadata = new Map<string, CodexTurnMetadata>();
  readonly #sessionContext = new Map<string, Omit<SessionContextState, "sessionId" | "compactionThresholdTokens" | "minimumThresholdTokens" | "supportsThreshold" | "isCompacting" | "compactionKind">>();
  readonly #threadsWithClientTools = new Set<string>();
  readonly #threadsWithoutClientTools = new Set<string>();
  readonly #visionThreads = new Set<string>();
  readonly #visionMessages = new Map<string, RemoteMessage>();
  readonly #visionChildren = new Map<string, { readonly adapter: CodexAdapter; readonly catalog: CodexVisionCatalog }>();
  readonly #options: CodexAdapterOptions;
  readonly #clientToolResumes = new Map<string, Promise<void>>();
  readonly #observedHistory = new WeakMap<readonly CodexObservedMessage[], {
    readonly providerSessionId: string;
    readonly state: SessionState | undefined;
    readonly messages: readonly RemoteMessage[];
  }>();
  #peer: JsonRpcPeer | null = null;
  #startingPeer: JsonRpcPeer | null = null;
  #initializing: Promise<JsonRpcPeer> | null = null;
  #closing: Promise<void> | null = null;
  #idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  #resourceGeneration = 0;
  #activePeerRequests = 0;
  #disposed = false;
  #eventCounter = 0;
  #clientTooling: ProviderClientTooling | undefined;

  public constructor(options: CodexAdapterOptions) {
    this.#sessionPermissions = new CodexSessionPermissions(options.permissionStatePath);
    this.#options = options;
    this.#hostId = options.hostId;
    this.#displayCommand = options.command ?? "codex";
    this.#automaticCommand = options.command === undefined;
    this.#commandResolver = new CodexCommandResolver({
      ...(options.command !== undefined ? { configuredCommand: options.command } : {}),
      env: options.environment ?? process.env,
    });
    this.#args = options.commandArgs ?? ["app-server", "--listen", "stdio://"];
    this.#cwd = options.cwd;
    this.#environment = options.environment ?? process.env;
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
          onActiveThreadDiscovered: (providerSessionId) => this.publishDiscoveredActiveThread(providerSessionId),
        });
    this.#desktopQueue = options.desktopQueue === undefined || options.desktopQueue === false
      ? null
      : new CodexDesktopQueue({
          ...(options.desktopQueue.statePath !== undefined ? { statePath: options.desktopQueue.statePath } : {}),
          ...(options.desktopQueue.pipePath !== undefined ? { pipePath: options.desktopQueue.pipePath } : {}),
          ...(options.desktopQueue.ownerRecoveryWindowMs !== undefined ? { ownerRecoveryWindowMs: options.desktopQueue.ownerRecoveryWindowMs } : {}),
          ...(options.desktopQueue.ownerRetryDelayMs !== undefined ? { ownerRetryDelayMs: options.desktopQueue.ownerRetryDelayMs } : {}),
          ...(options.desktopQueue.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.desktopQueue.requestTimeoutMs } : {}),
          onChanged: (messages) => this.emitDesktopQueueChanges(messages),
        });
    if (this.#desktopQueue !== null) {
      const desktopQueue = this.#desktopQueue;
      this.listQueuedMessages = async () => {
        await desktopQueue.start();
        return desktopQueue.list();
      };
      this.enqueueQueuedMessage = async (providerSessionId, request) => await desktopQueue.enqueue(providerSessionId, request);
      this.sendMessageToExternalOwner = async (providerSessionId, request) => {
        const existing = await this.acceptedScheduledMessage(providerSessionId, request);
        if (existing !== null) return existing;
        this.assertExternalOwnerToolRoutingSafe(request, "active_writer");
        return await desktopQueue.startTurn(providerSessionId, request, this.dynamicToolsForRequest(request));
      };
      this.restoreQueuedMessage = async (providerSessionId, request) => await desktopQueue.restore(providerSessionId, request);
      this.updateQueuedMessage = async (providerSessionId, messageId, content) => await desktopQueue.update(providerSessionId, messageId, content);
      this.cancelQueuedMessage = async (providerSessionId, messageId, expectedContent) => await desktopQueue.cancel(providerSessionId, messageId, expectedContent);
      this.readQueuedMessage = async (providerSessionId, messageId) => await desktopQueue.readMessage(providerSessionId, messageId);
      this.steerQueuedMessage = async (providerSessionId, messageId, request) => await desktopQueue.steerQueuedMessage(providerSessionId, messageId, request);
    }
  }

  public configureClientTooling(tooling: ProviderClientTooling): void {
    this.#clientTooling = tooling;
    // A new definition set must be persisted onto any pre-existing task before
    // its next turn. New tasks receive the same set through thread/start.
    this.#threadsWithClientTools.clear();
  }

  private dynamicTools(): readonly Record<string, unknown>[] | undefined {
    if (this.#clientTooling === undefined) return undefined;
    return this.#clientTooling.definitions.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  private dynamicToolsForRequest(request: SendMessageRequest): readonly Record<string, unknown>[] | undefined {
    const internalPurpose = request.metadata?.internalPurpose;
    return internalPurpose === "vision_proxy" || internalPurpose === "ears"
      ? undefined
      : this.dynamicTools();
  }

  private requestRequiresLiveClientToolHandler(request: SendMessageRequest): boolean {
    const overrides = request.clientToolOverrides;
    const dynamicTools = this.dynamicToolsForRequest(request);
    if (overrides === undefined || dynamicTools === undefined) return false;
    const available = new Set(dynamicTools.flatMap((tool) => typeof tool.name === "string" ? [tool.name] : []));
    return Object.entries(overrides).some(([name, enabled]) => enabled === true && available.has(name));
  }

  private assertExternalOwnerToolRoutingSafe(
    request: SendMessageRequest,
    failure: "active_writer" | "pre_delivery",
  ): void {
    if (!this.requestRequiresLiveClientToolHandler(request)) return;
    throw new ProviderAdapterError(
      this.providerId,
      failure === "active_writer" ? "EXTERNAL_WRITER_UNAVAILABLE" : "SAFE_DELIVERY_UNAVAILABLE",
      failure === "active_writer"
        ? "Codex Desktop currently owns this task, but this turn needs a Tethoq tool that only works through Tethoq's live Codex connection. Close the task in Codex Desktop or hand it back to Tethoq, then retry. Your draft and attachments are unchanged."
        : "This turn needs a Tethoq tool that only works through Tethoq's live Codex connection, so it cannot be handed to another Codex owner after local setup failed. Reopen the task in Tethoq, then retry. Your draft and attachments are unchanged.",
      true,
    );
  }

  /**
   * Codex persists dynamic tools in thread metadata. Existing tasks predate
   * Tethoq's thread/start call, so resume them once with the current tool set
   * before starting a turn; this hot-applies the neutral Tethoq tool surface
   * without an app restart.
   */
  private async ensureClientTools(providerSessionId: string): Promise<void> {
    const dynamicTools = this.dynamicTools();
    if (dynamicTools === undefined
      || this.#threadsWithoutClientTools.has(providerSessionId)
      || this.#threadsWithClientTools.has(providerSessionId)) return;
    const pending = this.#clientToolResumes.get(providerSessionId);
    if (pending !== undefined) return await pending;
    const resume = (async () => {
      const response = await this.request<ThreadResponse>("thread/resume", { threadId: providerSessionId, dynamicTools });
      if (response.thread.id !== providerSessionId) throw new ProviderAdapterError(this.providerId, "RESUME_ID_MISMATCH", "Codex resumed a different thread ID", false);
      this.#ownedThreads.add(providerSessionId);
      this.#threadsWithClientTools.add(providerSessionId);
    })();
    this.#clientToolResumes.set(providerSessionId, resume);
    try {
      await resume;
    } finally {
      if (this.#clientToolResumes.get(providerSessionId) === resume) this.#clientToolResumes.delete(providerSessionId);
    }
  }

  public async detect(): Promise<ProviderDetection> {
    if (this.#transportFactory !== undefined) return { providerId: this.providerId, available: true, version: "injected-transport", details: ["Transport supplied by caller."] };
    let selection;
    try {
      selection = await this.#commandResolver.resolve();
    } catch (error) {
      return {
        providerId: this.providerId,
        available: false,
        executable: this.#displayCommand,
        details: [error instanceof Error ? error.message : String(error)],
      };
    }
    const version = selection.version ?? await probeCodexVersion(selection.command, this.#environment);
    if (version === undefined) {
      return {
        providerId: this.providerId,
        available: false,
        executable: selection.command,
        details: [`Codex version probe failed for ${selection.command}`],
      };
    }
    return {
      providerId: this.providerId,
      available: true,
      executable: selection.command,
      version,
      details: [`selected ${selection.source} Codex executable ${selection.command}`],
    };
  }

  public async getAuthStatus(): Promise<AuthStatus> {
    const response = await this.request<AccountReadResponse>("account/read", { refreshToken: false });
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
    const response = await this.request<unknown>("account/login/start", params);
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
    const models: RemoteModel[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await this.request<ModelListResponse>("model/list", { ...(cursor ? { cursor } : {}), limit: 100 });
      const page = response.data ?? [];
      for (const value of page) {
        if (!isRecord(value)) continue;
        const id = [value.id, value.model, value.slug].find((candidate): candidate is string => typeof candidate === "string");
        if (id === undefined) continue;
        const displayName = [value.displayName, value.name].find((candidate): candidate is string => typeof candidate === "string") ?? id;
        const modalities = inputModalities(value.inputModalities);
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
    const response = await this.request<ThreadListResponse>("thread/list", {
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.sortKey !== undefined ? { sortKey: options.sortKey } : {}),
      ...(options.sortDirection !== undefined ? { sortDirection: options.sortDirection } : {}),
      ...(options.workingDirectory !== undefined ? { cwd: options.workingDirectory } : {}),
      ...(options.parentProviderSessionId !== undefined ? { parentThreadId: options.parentProviderSessionId } : {}),
      // Older App Servers default to the configured model backend. Keep saved
      // tasks discoverable after that setting changes by explicitly including all.
      modelProviders: [],
      // Catalogue rows come from Codex's indexed state. Allowing thread/list to
      // repair that index by rescanning rollout JSONL files makes a small page
      // rebuild enormous long-running tasks before it can answer. Tethoq loads
      // transcript data through its dedicated progressive-history path.
      useStateDbOnly: true,
      archived: false,
    });
    const sessions = [...await this.normalizeThreads(response.data)];
    if (options.cursor === undefined && this.#activity !== null) {
      const listed = new Set(response.data.map((thread) => thread.id));
      const missingActiveIds = (await this.#activity.activeThreadIds()).filter((providerSessionId) => !listed.has(providerSessionId));
      const activeThreads: Array<ThreadResponse["thread"] | null> = [];
      for (let offset = 0; offset < missingActiveIds.length; offset += 8) {
        const batch = missingActiveIds.slice(offset, offset + 8);
        activeThreads.push(...await Promise.all(batch.map(async (providerSessionId) => {
          try {
            return (await this.request<ThreadResponse>("thread/read", { threadId: providerSessionId, includeTurns: false })).thread;
          } catch {
            return null;
          }
        })));
      }
      // A catalogue row must stay a summary. Reading every missing writer's
      // recent rollout here used to start one 32 MiB transcript parse per lock
      // at the same time; a handful of externally owned tasks could therefore
      // push Electron past a gigabyte before the user opened any of them.
      // thread/read(includeTurns:false) already supplies the task title,
      // preview, recency, and path needed to normalize state. Transcript detail
      // is loaded progressively only when that task is opened.
      const activeSessions = await this.normalizeThreads(activeThreads.filter((thread): thread is NonNullable<typeof thread> => thread !== null));
      sessions.unshift(...activeSessions);
    }
    return { sessions, nextCursor: response.nextCursor };
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    const child = this.#visionChildren.get(providerSessionId);
    if (child !== undefined) return await child.adapter.getSession(providerSessionId);
    if (this.#visionThreads.has(providerSessionId) && this.#peer === null && this.#initializing === null) {
      throw new ProviderAdapterError(this.providerId, "SESSION_NOT_FOUND", "The ephemeral EYES session is no longer loaded", true);
    }
    const params = { threadId: providerSessionId, includeTurns: false };
    let response: ThreadResponse;
    try {
      response = await this.request<ThreadResponse>("thread/read", params);
    } catch (error) {
      if (!isCodexThreadNotFound(error)) throw error;
      if (this.#visionThreads.has(providerSessionId)) {
        throw new ProviderAdapterError(this.providerId, "SESSION_NOT_FOUND", "The ephemeral EYES session is no longer loaded", true, { cause: error });
      }
      await this.resumeSession(providerSessionId);
      response = await this.request<ThreadResponse>("thread/read", params);
    }
    return (await this.normalizeThreads([response.thread]))[0] ?? normalizeCodexThread(this.#hostId, response.thread);
  }

  public async getRecentMessages(providerSessionId: string): Promise<RecentProviderMessages> {
    const child = this.#visionChildren.get(providerSessionId);
    if (child !== undefined) return await child.adapter.getRecentMessages(providerSessionId);
    let recent = await this.#activity?.recentMessageWindow(providerSessionId);
    if (recent === undefined && this.#activity !== null) {
      // A task restored from Tethoq's persisted catalogue can be opened before
      // Codex's current first page has taught the activity reader its rollout
      // path. Hydrate only thread metadata, then retry the bounded local page.
      // Falling straight through to includeTurns rebuilds the entire thread and
      // can allocate hundreds of megabytes for a single visible history page.
      await this.getSession(providerSessionId);
      recent = await this.#activity.recentMessageWindow(providerSessionId);
    }
    // An empty bounded page is still a successful read. The rollout may contain
    // only provider records, bootstrap metadata, or a large non-visible item;
    // using message count as an availability signal caused a needless complete
    // history reconstruction. Only fall back when the local rollout is absent.
    if (recent !== undefined) {
      return {
        messages: this.observedRemoteMessages(providerSessionId, recent.messages),
        complete: recent.complete,
        ...(recent.olderCursor ? { olderCursor: recent.olderCursor } : {}),
      };
    }
    return { messages: await this.getMessages(providerSessionId), complete: true };
  }

  public async getOlderMessages(providerSessionId: string, cursor: string): Promise<RecentProviderMessages> {
    const older = await this.#activity?.olderMessageWindow(providerSessionId, cursor);
    if (older !== undefined) {
      return {
        messages: this.observedRemoteMessages(providerSessionId, older.messages),
        complete: older.complete,
        ...(older.olderCursor ? { olderCursor: older.olderCursor } : {}),
        pageOnly: true as const,
      };
    }
    return { messages: await this.getMessages(providerSessionId), complete: true };
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const child = this.#visionChildren.get(providerSessionId);
    if (child !== undefined) return await child.adapter.getMessages(providerSessionId);
    if (this.#visionThreads.has(providerSessionId)) {
      // Native ephemeral threads reject includeTurns. Keep only the latest
      // completed observation, without persisting images or a helper transcript.
      const message = this.#visionMessages.get(providerSessionId);
      return message === undefined ? [] : [message];
    }
    const observed = await this.#activity?.allMessages(providerSessionId) ?? [];
    const observedMessages = this.observedRemoteMessages(providerSessionId, observed);
    // The append-only rollout already owns exact order, timestamps, attachments,
    // tool activity, terminal state, and the complete pageable transcript. On a
    // large task App Server's includeTurns reconstruction can take many seconds
    // (or longer) because it rebuilds the whole thread before returning. Never
    // put that work in front of the visible history page; keep thread/read as the
    // fallback for sessions whose local rollout is unavailable.
    if (observedMessages.length > 0) return observedMessages;
    // An existing, empty rollout is authoritative too. Do not ask App Server
    // to reconstruct turns that do not exist (some versions reject list_turns).
    const localWindow = await this.#activity?.recentMessageWindow(providerSessionId);
    if (localWindow?.complete && localWindow.messages.length === 0) return observedMessages;
    try {
      const response = await this.request<ThreadResponse>("thread/read", { threadId: providerSessionId, includeTurns: true });
      return messagesFromCodexThread(this.#hostId, response.thread);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/thread\s+[0-9a-f-]+\s+is not materialized yet; includeTurns is unavailable before first user message/iu.test(message)) return [];
      throw error;
    }
  }

  private observedRemoteMessages(providerSessionId: string, observed: readonly CodexObservedMessage[]): readonly RemoteMessage[] {
    const state = this.#sessionStates.get(providerSessionId);
    const cached = this.#observedHistory.get(observed);
    if (cached?.providerSessionId === providerSessionId && cached.state === state) return cached.messages;
    const sessionId = makeGlobalSessionId(this.#hostId, this.providerId, providerSessionId);
    let latestLiveIndex = -1;
    if (state === "working") {
      for (let index = observed.length - 1; index >= 0; index -= 1) {
        const message = observed[index];
        if (message?.role === "assistant" && (message.partType === "reasoning" || message.phase === "commentary")) {
          latestLiveIndex = index;
          break;
        }
      }
    }
    const messages = observed.map((message, index) => {
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
        status: running ? "streaming" as const : message.terminalError ? "failed" as const : "completed" as const,
        ...(message.role === "user" && (message.parts?.every((part) => part.type === "text") ?? true) ? { editable: true } : {}),
        ...(message.origin ? { origin: message.origin } : {}),
        nativeMetadata: {
          partType: message.partType,
          ...(message.phase !== undefined ? { phase: message.phase } : {}),
          ...(message.terminalFallback ? { terminalFallback: true } : {}),
          ...(message.terminalError ? { terminalError: true } : {}),
          ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
          ...(message.canonicalUserMessage ? { canonicalUserMessage: true } : {}),
        },
      };
    });
    this.#observedHistory.set(observed, { providerSessionId, state, messages });
    return messages;
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
    const existing = this.#compactions.get(providerSessionId);
    if (existing !== undefined) return await existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const timer = setTimeout(() => reject(new ProviderAdapterError(
      this.providerId, "COMPACTION_TIMEOUT", "Codex did not confirm compaction completion in time", true,
    )), this.#options.compactionTimeoutMs ?? 10 * 60_000);
    const start = async (): Promise<void> => {
      const params = { threadId: providerSessionId };
      try {
        await this.request("thread/compact/start", params);
      } catch (error) {
        if (!isCodexThreadNotFound(error)) throw error;
        // A persisted task must be loaded into a fresh App Server first.
        await this.resumeSession(providerSessionId);
        await this.request("thread/compact/start", params);
      }
    };
    // Register before sending: native notifications may precede the RPC ack.
    const promise = Promise.all([Promise.resolve().then(start), completion]).then(() => undefined).finally(() => {
      clearTimeout(timer);
      this.#compactions.delete(providerSessionId);
      void this.releaseIdleResources();
    });
    this.#compactions.set(providerSessionId, {
      promise, resolve, reject,
      previousTurnId: this.#currentTurns.get(providerSessionId),
    });
    return await promise;
  }

  public async getGoal(providerSessionId: string): Promise<ProviderSessionGoal | null | undefined> {
    try {
      const response = await this.request<ThreadGoalResponse>("thread/goal/get", { threadId: providerSessionId });
      if (!isRecord(response) || !("goal" in response)) throw invalidGoalResponse("thread/goal/get");
      validateGoalEnvelope(response, providerSessionId, "thread/goal/get");
      return response.goal === null ? null : requireNativeGoal(response.goal, "thread/goal/get", providerSessionId);
    } catch (error) {
      if (isUnsupportedGoalError(error)) return undefined;
      throw error;
    }
  }

  public async setGoal(providerSessionId: string, update: ProviderSessionGoalUpdate): Promise<ProviderSessionGoal | undefined> {
    try {
      const response = await this.request<ThreadGoalResponse>("thread/goal/set", {
        threadId: providerSessionId,
        ...(update.objective !== undefined ? { objective: update.objective } : {}),
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.tokenBudget !== undefined ? { tokenBudget: update.tokenBudget } : {}),
      });
      if (!isRecord(response) || !("goal" in response) || response.goal === null) throw invalidGoalResponse("thread/goal/set");
      validateGoalEnvelope(response, providerSessionId, "thread/goal/set");
      return requireNativeGoal(response.goal, "thread/goal/set", providerSessionId);
    } catch (error) {
      if (isUnsupportedGoalError(error)) return undefined;
      throw error;
    }
  }

  public async clearGoal(providerSessionId: string): Promise<boolean | undefined> {
    try {
      const response = await this.request<ThreadGoalClearResponse>("thread/goal/clear", { threadId: providerSessionId });
      if (!isRecord(response) || typeof response.cleared !== "boolean") throw invalidGoalResponse("thread/goal/clear");
      validateGoalEnvelope(response, providerSessionId, "thread/goal/clear");
      return response.cleared;
    } catch (error) {
      if (isUnsupportedGoalError(error)) return undefined;
      throw error;
    }
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    const visionHelper = options.metadata?.internalPurpose === "vision_proxy";
    let visionConfig: JsonObject | undefined;
    if (visionHelper) {
      const effective = await this.request<unknown>("config/read", { cwd: options.workingDirectory, includeLayers: false });
      if (!isRecord(effective) || !isRecord(effective.config)) {
        throw new ProviderAdapterError(this.providerId, "VISION_ISOLATION_UNAVAILABLE", "Codex could not read the configuration needed to isolate EYES", false);
      }
      visionConfig = codexVisionIsolationConfig(effective.config);
      if (this.#options.isolatedVisionRuntime !== true) {
        const command = (await this.#commandResolver.resolve()).command;
        const catalog = await prepareCodexVisionCatalog(command, options.modelId, effective.config, this.#environment);
        const adapter = new CodexAdapter({
          ...this.#options,
          command,
          commandArgs: [...this.#args, "-c", `model_catalog_json=${JSON.stringify(catalog.path)}`],
          isolatedVisionRuntime: true,
          localActivity: false,
          desktopQueue: false,
        });
        let helperSessionId: string | undefined;
        try {
          await adapter.subscribe(null, async (event) => {
            if (event.providerSessionId !== undefined) {
              // Children share this provider ID, but not its event counter.
              // Assign IDs at the parent to avoid Bridge deduplication losses.
              const { eventId: _eventId, providerId: _providerId, occurredAt: _occurredAt, ...input } = event;
              await this.emit(input);
            }
            else if (event.type === "provider.disconnected" && helperSessionId !== undefined) {
              // A private runtime failure must not disconnect ordinary Codex
              // chats sharing the provider ID on the parent adapter.
              await this.emit({ type: "agent.error", providerSessionId: helperSessionId, payload: { message: "The private EYES runtime disconnected" } });
            }
          });
          const session = await adapter.createSession(options);
          helperSessionId = session.providerSessionId;
          this.#visionChildren.set(session.providerSessionId, { adapter, catalog });
          return session;
        } catch (error) {
          await adapter.dispose();
          await catalog.dispose();
          throw error;
        }
      }
    }
    const response = await this.request<ThreadResponse>("thread/start", {
      cwd: options.workingDirectory,
      ...(options.modelId !== undefined ? { model: options.modelId } : {}),
      ...(options.developerInstructions !== undefined ? { developerInstructions: options.developerInstructions } : {}),
      ...(options.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
      ...(visionConfig !== undefined ? {
        config: visionConfig,
        baseInstructions: options.developerInstructions ?? "You are a private vision helper. Describe only the supplied images. You have no tools.",
        dynamicTools: [],
      } : options.mcpServers === "none" ? { config: { mcp_servers: {} } } : {}),
      ...(!visionHelper && options.clientTools !== "none" && this.dynamicTools() !== undefined ? { dynamicTools: this.dynamicTools() } : {}),
    });
    this.#ownedThreads.add(response.thread.id);
    if (visionHelper) this.#visionThreads.add(response.thread.id);
    if (visionHelper || options.clientTools === "none") this.#threadsWithoutClientTools.add(response.thread.id);
    else if (this.#clientTooling !== undefined) this.#threadsWithClientTools.add(response.thread.id);
    let session = (await this.normalizeThreads([response.thread]))[0] ?? normalizeCodexThread(this.#hostId, response.thread);
    if (options.modelId !== undefined) {
      await this.applySessionMetadata(response.thread.id, { modelId: options.modelId }, false);
      session = { ...session, modelId: options.modelId };
    }
    if (options.firstInstruction !== undefined) {
      await this.sendMessage(response.thread.id, {
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
    const params = { threadId: providerSessionId };
    let response: ThreadForkResponse;
    try {
      response = await this.request<ThreadForkResponse>("thread/fork", params);
    } catch (error) {
      if (!isCodexThreadNotFound(error)) throw error;
      await this.resumeSession(providerSessionId);
      response = await this.request<ThreadForkResponse>("thread/fork", params);
    }
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
    const dynamicTools = this.#threadsWithoutClientTools.has(providerSessionId) ? undefined : this.dynamicTools();
    const response = await this.request<ThreadResponse>("thread/resume", {
      threadId: providerSessionId,
      ...(dynamicTools === undefined ? {} : { dynamicTools }),
    });
    if (response.thread.id !== providerSessionId) throw new ProviderAdapterError(this.providerId, "RESUME_ID_MISMATCH", "Codex resumed a different thread ID", false);
    this.#ownedThreads.add(providerSessionId);
    if (dynamicTools !== undefined) this.#threadsWithClientTools.add(providerSessionId);
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const child = this.#visionChildren.get(providerSessionId);
    if (child !== undefined) return await child.adapter.sendMessage(providerSessionId, request);
    const key = `${providerSessionId}\u0000${request.requestId}`;
    const existing = this.#inFlightMessageSends.get(key);
    if (existing !== undefined) return await existing;
    const send = this.sendMessageOnce(providerSessionId, request);
    this.#inFlightMessageSends.set(key, send);
    try {
      return await send;
    } finally {
      if (this.#inFlightMessageSends.get(key) === send) this.#inFlightMessageSends.delete(key);
    }
  }

  private async sendMessageOnce(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const existing = await this.acceptedScheduledMessage(providerSessionId, request);
    if (existing !== null) return existing;
    if (this.#desktopQueue === null) {
      try {
        return await this.sendMessageToAppServer(providerSessionId, request);
      } catch (error) {
        if (error instanceof CodexPreTurnStartError) throw error.cause;
        throw error;
      }
    }

    let appServerFailure: "active_writer" | "pre_delivery";
    try {
      // App Server is the ordinary writer even when Codex Desktop's IPC pipe
      // happens to exist. Desktop routing is justified only by App Server's
      // explicit active-writer rejection or another failure proven to precede
      // turn/start.
      return await this.sendMessageToAppServer(providerSessionId, request);
    } catch (error) {
      if (isCodexActiveWriter(error)) appServerFailure = "active_writer";
      else if (error instanceof CodexPreTurnStartError) appServerFailure = "pre_delivery";
      else throw error;
    }

    this.assertExternalOwnerToolRoutingSafe(request, appServerFailure);

    const deadline = Date.now() + this.#desktopQueue.ownerRecoveryWindowMs;
    let retryDelayMs = this.#desktopQueue.ownerRetryDelayMs;
    while (true) {
      const desktopAttempt = await this.#desktopQueue.tryStartTurn(
        providerSessionId,
        request,
        this.dynamicToolsForRequest(request),
      );
      if (desktopAttempt.outcome === "accepted") return desktopAttempt.result;
      if (desktopAttempt.outcome === "delivery_unknown") throw desktopAttempt.error;

      if (appServerFailure === "active_writer") {
        // Discovery failures and NoClientFound prove that Desktop did not start
        // the turn. Retry App Server with the identical request identity: its
        // writer lock may have been released while Desktop ownership converged.
        try {
          return await this.sendMessageToAppServer(providerSessionId, request);
        } catch (error) {
          if (isCodexActiveWriter(error)) {
            appServerFailure = "active_writer";
          } else if (error instanceof CodexPreTurnStartError) {
            // The retry still did not reach turn/start. Desktop remains safe,
            // but another App Server attempt would only repeat the preflight.
            appServerFailure = "pre_delivery";
          } else {
            throw error;
          }
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(retryDelayMs, remainingMs));
      retryDelayMs = Math.min(400, Math.ceil(retryDelayMs * 1.5));
    }

    throw new ProviderAdapterError(
      this.providerId,
      appServerFailure === "active_writer" ? "EXTERNAL_WRITER_UNAVAILABLE" : "SAFE_DELIVERY_UNAVAILABLE",
      appServerFailure === "active_writer"
        ? "Codex still has another writer for this task, but it did not become reachable during safe delivery. Your draft and attachments are unchanged."
        : "Codex could not complete its pre-delivery task setup and no Desktop owner accepted the turn. Your draft and attachments are unchanged.",
      true,
    );
  }

  private async acceptedScheduledMessage(
    providerSessionId: string,
    request: SendMessageRequest,
  ): Promise<SendMessageResult | null> {
    if (!isScheduledMessageRequest(request)) return null;
    const params = { threadId: providerSessionId, includeTurns: true };
    let response: ThreadResponse;
    try {
      response = await this.readScheduledHistory(params);
    } catch (error) {
      // A thread/start response can precede Codex materializing its first-turn
      // history. That state proves there is no persisted scheduled turn to
      // adopt yet, so the original request identity may proceed to turn/start.
      if (isCodexThreadHistoryUnavailableBeforeFirstMessage(error)) return null;
      if (!isCodexThreadNotFound(error)) throw error;
      await this.resumeSession(providerSessionId);
      try {
        response = await this.readScheduledHistory(params);
      } catch (resumedReadError) {
        if (isCodexThreadHistoryUnavailableBeforeFirstMessage(resumedReadError)) return null;
        throw resumedReadError;
      }
    }
    const persisted = persistedCodexUserTurn(
      response.thread,
      request.requestId,
      normalizedScheduledPrompt(providerPromptContent(request)),
    );
    if (persisted === null) return null;
    return {
      accepted: true,
      ...(persisted.turnId !== undefined ? { providerTurnId: persisted.turnId } : {}),
      details: ["Codex already accepted this scheduled prompt."],
    };
  }

  /**
   * Scheduled delivery checks are read-only and protect an exact-once write.
   * A long-lived App Server can survive a Desktop update while becoming unable
   * to traverse the newer rollout lineage. Replace that stale process once and
   * repeat only the safe history read; turn/start remains outside this retry.
   */
  private async readScheduledHistory(params: { readonly threadId: string; readonly includeTurns: boolean }): Promise<ThreadResponse> {
    try {
      return await this.request<ThreadResponse>("thread/read", params);
    } catch (error) {
      if (!isRecoverableScheduledHistoryRead(error) || !await this.recyclePeerAfterSafeRead()) throw error;
      return await this.request<ThreadResponse>("thread/read", params);
    }
  }

  private async recyclePeerAfterSafeRead(): Promise<boolean> {
    if (this.#disposed) return false;
    const peer = this.#peer;
    if (peer === null) return true;
    if (this.#activePeerRequests > 0 || this.#pendingServerRequests.size > 0 || this.hasOwnedActiveTurn()) return false;
    this.#resourceGeneration += 1;
    this.cancelIdleRelease();
    this.#peer = null;
    this.#commandResolver.invalidate();
    const closing = peer.close().catch(() => undefined);
    this.#closing = closing;
    try {
      await closing;
    } finally {
      this.#ownedThreads.clear();
      this.#currentTurns.clear();
      if (this.#closing === closing) this.#closing = null;
    }
    return !this.#disposed;
  }

  private async sendMessageToAppServer(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const internalPurpose = request.metadata?.internalPurpose;
    let permissionOverrides: Record<string, unknown> = {};
    if (internalPurpose === "vision_proxy" || internalPurpose === "ears") {
      // Restored helpers were created by an earlier adapter instance, so the
      // createSession(clientTools: "none") policy is no longer in memory. The
      // hidden helper marker on every internal turn restores that isolation
      // before ensureClientTools can resume the task with recursive tools.
      this.#threadsWithoutClientTools.add(providerSessionId);
      this.#threadsWithClientTools.delete(providerSessionId);
    }
    try {
      await this.ensureClientTools(providerSessionId);
      // Separating process initialization from the turn/start request gives the
      // caller a truthful exact-once boundary: a discovery or initialization
      // failure here cannot have submitted the user's instruction.
      await this.peer();
      if (internalPurpose !== "vision_proxy" && internalPurpose !== "ears" && !this.#visionThreads.has(providerSessionId)) {
        permissionOverrides = await this.#sessionPermissions.turnOverrides(providerSessionId, () => this.request("configRequirements/read"));
      }
    } catch (error) {
      throw new CodexPreTurnStartError(error);
    }
    const input = codexTurnInput(request);
    const params = {
      threadId: providerSessionId,
      clientUserMessageId: request.requestId,
      input,
      ...permissionOverrides,
      ...(request.modelId !== undefined ? { model: request.modelId } : {}),
      ...(request.reasoningEffort !== undefined ? { effort: request.reasoningEffort } : {}),
    };
    let response: TurnResponse;
    try {
      response = await this.requestWithDeliveryBoundary<TurnResponse>("turn/start", params);
    } catch (error) {
      if (!isCodexThreadNotFound(error)) throw error;
      const dynamicTools = this.#threadsWithoutClientTools.has(providerSessionId) ? undefined : this.dynamicTools();
      let resumed: ThreadResponse;
      try {
        resumed = await this.request<ThreadResponse>("thread/resume", {
          threadId: providerSessionId,
          ...(dynamicTools === undefined ? {} : { dynamicTools }),
        });
      } catch (resumeError) {
        // The preceding turn/start was explicitly rejected as missing, so this
        // resume is still provably pre-delivery.
        throw new CodexPreTurnStartError(resumeError);
      }
      if (resumed.thread.id !== providerSessionId) {
        throw new ProviderAdapterError(this.providerId, "RESUME_ID_MISMATCH", "Codex resumed a different thread ID", false);
      }
      this.#ownedThreads.add(providerSessionId);
      response = await this.requestWithDeliveryBoundary<TurnResponse>("turn/start", params);
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
    // A cached status label is presentation state, not proof that a turn still
    // exists. App Server work owns a concrete turn id; Desktop-owned work is
    // authoritative only while the rollout reconciler still observes it.
    return this.#currentTurns.has(providerSessionId)
      || this.#activity?.hasActiveTurn(providerSessionId) === true;
  }

  public ownsActiveTurn(providerSessionId: string): boolean {
    // Desktop-started turns also have a real turn id, but they never enter this
    // adapter's current-turn map. This map is populated only after App Server
    // accepts turn/start and is cleared by its matching turn/completed event.
    return this.#currentTurns.has(providerSessionId);
  }

  /** The rollout reconciler reads only newly appended bytes on each live tick. */
  public async watchSession(providerSessionId: string): Promise<boolean> {
    if (this.#activity === null) return false;
    await this.#activity.watchSession(providerSessionId);
    await this.releaseIdleResources();
    return true;
  }

  public unwatchSession(providerSessionId: string): void {
    this.#activity?.unwatchSession(providerSessionId);
  }

  public async steerMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const expectedTurnId = this.#currentTurns.get(providerSessionId);
    if (expectedTurnId === undefined) {
      throw new ProviderAdapterError(this.providerId, "NO_ACTIVE_TURN", "No active Codex turn is available to steer", false);
    }
    const input = codexTurnInput(request);
    const response = await this.requestWithDeliveryBoundary<{ readonly turnId: string }>("turn/steer", {
      threadId: providerSessionId,
      clientUserMessageId: request.requestId,
      input,
      expectedTurnId,
    });
    return { accepted: true, providerTurnId: response.turnId, details: ["Instruction steered into the active Codex turn."] };
  }

  public async editMessage(providerSessionId: string, request: EditMessageRequest): Promise<SendMessageResult> {
    const response = await this.request<ThreadResponse>("thread/read", {
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
    await this.request("thread/rollback", {
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
    const child = this.#visionChildren.get(providerSessionId);
    if (child !== undefined) return await child.adapter.interrupt(providerSessionId);
    let turnId = this.#currentTurns.get(providerSessionId);
    if (turnId === undefined) {
      // Reconnected and externally started tasks need the actual live turn ID.
      // Absence from this adapter's map is not evidence that the task stopped.
      const { thread } = await this.request<ThreadResponse>("thread/read", { threadId: providerSessionId, includeTurns: true });
      const active = [...(thread?.turns ?? [])].reverse().find((turn) => isRecord(turn)
        && (turn.status === "inProgress" || turn.status === "in_progress" || turn.status === "running"));
      if (isRecord(active) && typeof active.id === "string") turnId = active.id;
      else if (thread !== undefined && normalizeCodexStatus(thread.status) === "idle") return;
      else throw new ProviderAdapterError(this.providerId, "INTERRUPTION_UNCONFIRMED", "Codex could not identify the active turn to interrupt. Refresh the task and try Stop again.", true);
    }
    const locallyTracked = this.#currentTurns.get(providerSessionId) === turnId;
    await this.request("turn/interrupt", { threadId: providerSessionId, turnId });
    const deadline = Date.now() + Math.min(this.#requestTimeoutMs, 15_000);
    do {
      if (locallyTracked && !this.#currentTurns.has(providerSessionId)) return;
      const { thread } = await this.request<ThreadResponse>("thread/read", { threadId: providerSessionId, includeTurns: true });
      const turn = thread?.turns?.find((entry) => isRecord(entry) && entry.id === turnId);
      if (isRecord(turn) && (turn.status === "interrupted" || turn.status === "completed" || turn.status === "failed")
        || !isRecord(turn) && thread !== undefined && normalizeCodexStatus(thread.status) === "idle") {
        await this.handleNotification("turn/completed", { threadId: providerSessionId, turn: { id: turnId, status: "interrupted" } });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new ProviderAdapterError(this.providerId, "INTERRUPTION_UNCONFIRMED", "Codex has not confirmed that the task stopped. Try Stop again.", true);
  }

  public async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    await this.peer();
    await this.releaseIdleResources();
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

  public async getSessionPermissions(providerSessionId: string): Promise<ProviderSessionPermissions> {
    if (this.#visionThreads.has(providerSessionId)) return { controls: [], note: "Private helper permissions are fixed." };
    const native = await this.request("thread/resume", { threadId: providerSessionId, excludeTurns: true });
    const requirements = await this.request("configRequirements/read");
    return await this.#sessionPermissions.describe(providerSessionId, native, requirements);
  }

  public async setSessionPermission(providerSessionId: string, controlId: string, value: string): Promise<ProviderSessionPermissions> {
    const available = await this.getSessionPermissions(providerSessionId);
    await this.#sessionPermissions.set(providerSessionId, controlId, value, available);
    return await this.getSessionPermissions(providerSessionId);
  }

  public async respondToUserInput(response: ProviderUserInputResponse): Promise<void> {
    const pending = this.#pendingServerRequests.get(response.providerRequestId);
    if (pending?.method.includes("elicitation/request")) {
      const result = elicitationResponse(pending.params ?? {}, response.answers);
      this.#pendingServerRequests.delete(response.providerRequestId);
      pending.resolve({ ...result, _meta: null });
      return;
    }
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
    for (const pending of this.#compactions.values()) pending.reject(new Error("Codex adapter disposed during compaction"));
    this.#compactionTurns.clear();
    const children = [...this.#visionChildren.values()];
    this.#visionChildren.clear();
    await Promise.all(children.map(async ({ adapter, catalog }) => {
      await adapter.dispose();
      await catalog.dispose();
    }));
    this.#resourceGeneration += 1;
    this.cancelIdleRelease();
    this.#desktopQueue?.dispose();
    await this.#activity?.dispose();
    for (const pending of this.#pendingServerRequests.values()) pending.reject(new Error("Codex adapter disposed"));
    this.#pendingServerRequests.clear();
    this.#ownedThreads.clear();
    this.#threadsWithClientTools.clear();
    this.#threadsWithoutClientTools.clear();
    this.#visionThreads.clear();
    this.#visionMessages.clear();
    this.#clientToolResumes.clear();
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

  public async releaseSession(providerSessionId: string): Promise<void> {
    const child = this.#visionChildren.get(providerSessionId);
    if (child !== undefined) {
      await child.adapter.dispose();
      await child.catalog.dispose();
      this.#visionChildren.delete(providerSessionId);
      return;
    }
    if (!this.#visionThreads.has(providerSessionId)) return;
    if (this.#peer !== null && this.#ownedThreads.has(providerSessionId)) {
      await this.request("thread/unsubscribe", { threadId: providerSessionId });
    }
    this.#ownedThreads.delete(providerSessionId);
    this.#threadsWithoutClientTools.delete(providerSessionId);
    this.#visionThreads.delete(providerSessionId);
    this.#visionMessages.delete(providerSessionId);
  }

  private async request<T>(method: string, params: unknown = {}): Promise<T> {
    const peer = await this.peer();
    this.#activePeerRequests += 1;
    try {
      return await peer.request<T>(method, params);
    } finally {
      this.#activePeerRequests -= 1;
      await this.releaseIdleResources();
    }
  }

  private async requestWithDeliveryBoundary<T>(method: string, params: unknown): Promise<T> {
    const peer = await this.peer();
    this.#activePeerRequests += 1;
    try {
      const started = peer.startRequest<T>(method, params);
      // Own the result rejection immediately while the transport acceptance
      // boundary is awaited separately.
      void started.result.catch(() => undefined);
      await started.sent;
      try {
        return await started.result;
      } catch (error) {
        // A JSON-RPC error is an explicit provider rejection, not an ambiguous
        // lost acknowledgement. Transport failure or timeout after the frame
        // was accepted must never be retried blindly.
        if (error instanceof JsonRpcRemoteError) throw error;
        throw new ProviderAdapterError(
          this.providerId,
          "DELIVERY_UNKNOWN",
          "Codex received the instruction frame, but Tethoq could not confirm whether the provider accepted it. Delivery will be reconciled before another attempt.",
          false,
          { cause: error },
        );
      }
    } finally {
      this.#activePeerRequests -= 1;
      await this.releaseIdleResources();
    }
  }

  private async initialize(): Promise<JsonRpcPeer> {
    try {
      return await this.initializeOnce();
    } catch (error) {
      if (!this.#automaticCommand || this.#transportFactory !== undefined) throw error;
      // Codex Desktop updates replace the hashed executable directory. If that
      // happens between a cached version probe and process spawn, discovery is
      // still pre-turn and may be repeated once without duplicate-delivery risk.
      this.#commandResolver.invalidate();
      try {
        return await this.initializeOnce();
      } catch (retryError) {
        this.#commandResolver.invalidate();
        throw retryError;
      }
    }
  }

  private async initializeOnce(): Promise<JsonRpcPeer> {
    let transport: JsonRpcTransport;
    try {
      if (this.#transportFactory !== undefined) {
        transport = this.#transportFactory(this.#args);
      } else {
        // Re-scan on every new process. Codex Desktop can update while Tethoq
        // stays open, and an older executable may still launch successfully
        // while being unable to read the newer rollout lineage.
        if (this.#automaticCommand) this.#commandResolver.invalidate();
        const selection = await this.#commandResolver.resolve();
        transport = new JsonLineProcessTransport({
          command: selection.command,
          args: this.#args,
          ...(this.#cwd !== undefined ? { cwd: this.#cwd } : {}),
          env: this.#environment,
        });
      }
    } catch (error) {
      throw new ProviderAdapterError(this.providerId, "INITIALIZE_FAILED", `Codex App Server initialization failed: ${error instanceof Error ? error.message : String(error)}`, true, { cause: error });
    }
    let peer!: JsonRpcPeer;
    peer = new JsonRpcPeer(transport, {
      includeJsonRpc: false,
      timeoutMs: this.#requestTimeoutMs,
      idPrefix: "codex",
      onError: (error) => this.emit({
        type: "provider.disconnected",
        payload: { message: error.message, source: "json_rpc_callback" },
      }),
      onTransportClosed: (error) => this.handlePeerTransportClosed(peer, error),
    });
    this.#startingPeer = peer;
    peer.onNotification((method, params) => this.handleNotification(method, params));
    peer.onRequest(async (method, params, id) => {
      this.#activePeerRequests += 1;
      try {
        return await this.handleServerRequest(method, params, id);
      } finally {
        this.#activePeerRequests -= 1;
        await this.releaseIdleResources();
      }
    });
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

  private async handlePeerTransportClosed(peer: JsonRpcPeer, error: Error): Promise<void> {
    const current = this.#peer === peer;
    const starting = this.#startingPeer === peer;
    if (!current && !starting) return;
    for (const pending of this.#compactions.values()) pending.reject(error);
    this.#compactionTurns.clear();
    const interruptedSessionIds = current ? [...this.#currentTurns.keys()] : [];
    if (current) this.#peer = null;
    if (starting) this.#startingPeer = null;
    this.#resourceGeneration += 1;
    this.cancelIdleRelease();
    this.#ownedThreads.clear();
    this.#currentTurns.clear();
    const pendingRequests = [...this.#pendingServerRequests];
    this.#pendingServerRequests.clear();
    for (const [, pending] of pendingRequests) pending.reject(error);
    for (const [requestId, pending] of pendingRequests) {
      if (!pending.method.includes("requestUserInput") && !pending.method.includes("elicitation/request")) continue;
      await this.emit({ type: "user_input.resolved", providerSessionId: pending.providerSessionId,
        payload: { providerRequestId: requestId, reason: "cancelled" } });
    }
    for (const providerSessionId of interruptedSessionIds) {
      const reconciled = await this.#activity?.reconcile([{ providerSessionId, nativeState: "unknown" }]);
      await this.emitSessionState(providerSessionId, reconciled?.get(providerSessionId) ?? "unknown");
    }
    await this.emit({
      type: "provider.disconnected",
      payload: { message: error.message, source: "transport_closed" },
    });
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
    if (this.#activePeerRequests > 0 || this.#pendingServerRequests.size > 0 || this.hasOwnedActiveTurn()) {
      await this.releaseIdleResources();
      return;
    }
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

  private hasOwnedActiveTurn(): boolean {
    return this.#compactions.size > 0 || [...this.#ownedThreads].some((providerSessionId) =>
      this.#currentTurns.has(providerSessionId)
      || [...this.#pendingServerRequests.values()].some((pending) => pending.providerSessionId === providerSessionId));
  }

  private async handleServerRequest(method: string, params: unknown, id: RpcId): Promise<unknown> {
    const requestId = String(id);
    const source = isRecord(params) ? params : {};
    const providerSessionId = [source.threadId, source.conversationId, source.sessionId].find((value): value is string => typeof value === "string") ?? "unknown";
    if (method === "item/tool/call") {
      if (this.#threadsWithoutClientTools.has(providerSessionId)) {
        return { contentItems: [{ type: "inputText", text: "Tools are disabled for this private helper." }], success: false };
      }
      if (this.#clientTooling === undefined) throw new ProviderAdapterError(this.providerId, "CLIENT_TOOLS_UNAVAILABLE", "Client tools are not configured", false);
      const tool = typeof source.tool === "string" ? source.tool : undefined;
      const input = isRecord(source.arguments) ? jsonObject(source.arguments) : {};
      if (tool === undefined) throw new ProviderAdapterError(this.providerId, "CLIENT_TOOL_INVALID", "Codex requested an unnamed client tool", false);
      try {
        const output = await this.#clientTooling.execute(this.providerId, providerSessionId, tool, input, {
          callId: requestId,
          lifecycleOwner: "provider",
        });
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
        const enriched = method.includes("elicitation/request")
          ? jsonObject({ ...source, kind: "elicitation", title: source.serverName ?? "Question", prompt: source.message })
          : userInputRequestPayload(source);
        void this.emit({ type: "user_input.requested", providerSessionId, payload: { providerRequestId: requestId, request: enriched } });
      });
    }
    throw new ProviderAdapterError(this.providerId, "SERVER_REQUEST_UNSUPPORTED", `Codex server requested unsupported client method ${method}`, false);
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    const source = isRecord(params) ? params : {};
    const providerSessionId = [source.threadId, isRecord(source.thread) ? source.thread.id : undefined].find((value): value is string => typeof value === "string");
    const turnId = [source.turnId, isRecord(source.turn) ? source.turn.id : undefined].find((value): value is string => typeof value === "string");
    const compaction = providerSessionId === undefined ? undefined : this.#compactions.get(providerSessionId);
    if (providerSessionId !== undefined && compaction !== undefined && turnId !== undefined
      && turnId !== compaction.previousTurnId) {
      if (method === "turn/started" && compaction.turnId === undefined) {
        compaction.turnId = turnId;
        this.#compactionTurns.delete(providerSessionId);
        this.#compactionTurns.set(providerSessionId, turnId);
        if (this.#compactionTurns.size > 128) this.#compactionTurns.delete(this.#compactionTurns.keys().next().value!);
      }
      if (compaction.turnId === turnId) {
        const item = isRecord(source.item) ? source.item : {};
        if (method === "item/started" && item.type === "contextCompaction" && typeof item.id === "string") {
          compaction.itemId = item.id;
        }
        if (method === "item/completed" && item.type === "contextCompaction" && item.id === compaction.itemId
          && compaction.itemId !== undefined) compaction.itemCompleted = true;
        if (method === "turn/completed") {
          const status = isRecord(source.turn) ? source.turn.status : undefined;
          if (status === "completed" && compaction.itemCompleted) compaction.resolve();
          else if (status !== "completed") compaction.reject(new ProviderAdapterError(
            this.providerId, "COMPACTION_FAILED", "Codex compaction failed or was interrupted", true,
          ));
        }
        if (method === "error" && source.willRetry !== true) compaction.reject(new ProviderAdapterError(
          this.providerId, "COMPACTION_FAILED", "Codex compaction failed", true,
        ));
      }
    }
    if (providerSessionId !== undefined && this.#visionThreads.has(providerSessionId)
      && turnId !== undefined && method === "item/completed" && isRecord(source.item)
      && source.item.type === "agentMessage" && typeof source.item.id === "string") {
      const text = assistantItemText(source.item);
      const currentTurnId = this.#currentTurns.get(providerSessionId);
      if (text && (currentTurnId === undefined || currentTurnId === turnId)) {
        const now = this.#now().toISOString();
        this.#visionMessages.set(providerSessionId, {
          id: `codex/${source.item.id}`,
          sessionId: makeGlobalSessionId(this.#hostId, this.providerId, providerSessionId),
          providerMessageId: source.item.id,
          role: "assistant",
          createdAt: now,
          completedAt: now,
          parts: [{ type: "text", text }],
          status: "completed",
          nativeMetadata: { turnId },
        });
      }
    }
    if (providerSessionId !== undefined && turnId !== undefined && method === "turn/started") this.#currentTurns.set(providerSessionId, turnId);
    if (providerSessionId !== undefined && method === "turn/completed") {
      const currentTurnId = this.#currentTurns.get(providerSessionId);
      // A delayed terminal event for turn A cannot retire a newer owned turn B.
      // Missing identity is likewise insufficient once a concrete turn is live.
      if (currentTurnId !== undefined && turnId !== currentTurnId) return;
      this.#currentTurns.delete(providerSessionId);
      for (const [requestId, pending] of this.#pendingServerRequests) {
        if (pending.providerSessionId !== providerSessionId || (typeof pending.params?.turnId === "string" && pending.params.turnId !== turnId)) continue;
        if (!pending.method.includes("requestUserInput") && !pending.method.includes("elicitation/request")) continue;
        this.#pendingServerRequests.delete(requestId);
        pending.resolve(pending.method.includes("elicitation/request") ? { action: "cancel", content: null, _meta: null } : { answers: {} });
        await this.emit({ type: "user_input.resolved", providerSessionId, payload: { providerRequestId: requestId, reason: "cancelled" } });
      }
    }

    // Manual compaction has its own bridge lifecycle. Its native turn must not
    // look like another user turn (or trigger automatic compaction recursively).
    if (providerSessionId !== undefined && (
      (turnId !== undefined && this.#compactionTurns.get(providerSessionId) === turnId
        && (method === "turn/started" || method === "turn/completed" || method === "error"
          || (isRecord(source.item) && source.item.type === "contextCompaction")))
      || (compaction !== undefined && method === "thread/status/changed")
    )) return;

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
      const lifecycleState = this.ownsActiveTurn(providerSessionId)
        && (nativeState === "idle" || nativeState === "unknown")
        ? "working"
        : nativeState;
      const externalWriter = !this.#ownedThreads.has(providerSessionId)
        && await this.#activity?.hasWriterLock(providerSessionId) === true;
      const coldNotLoaded = isColdNotLoadedStatus(source.status, externalWriter, this.ownsActiveTurn(providerSessionId));
      const reconciled = await this.#activity?.reconcile([{
        providerSessionId,
        nativeState: coldNotLoaded ? "idle" : externalWriter ? "unknown" : lifecycleState,
        ...(coldNotLoaded ? { observeUnknown: false } : {}),
      }]);
      await this.emitSessionState(providerSessionId, reconciled?.get(providerSessionId) ?? (coldNotLoaded ? "idle" : lifecycleState), source);
      return;
    }

    if (providerSessionId !== undefined && method === "thread/name/updated") {
      const title = normalizeCodexThreadName(source.threadName);
      if (title !== undefined) await this.emit({ type: "session.updated", providerSessionId, payload: { title } });
      return;
    }

    if (method === "thread/goal/updated") {
      const goalThreadId = requireGoalNotificationThread(source, method);
      const goal = requireNativeGoal(source.goal, method, goalThreadId);
      await this.emit({ type: "session.goal_updated", providerSessionId: goalThreadId, payload: { goal: goal as unknown as JsonObject } });
      return;
    }
    if (method === "thread/goal/cleared") {
      const goalThreadId = requireGoalNotificationThread(source, method);
      validateGoalOrderingFields(source, method);
      const payload: JsonObject = {
        ...(hasOwn(source, "revision") ? { revision: source.revision as number } : {}),
        ...(hasOwn(source, "updatedAt") ? { updatedAt: source.updatedAt as number | string } : {}),
      };
      await this.emit({
        type: "session.goal_cleared",
        providerSessionId: goalThreadId,
        payload,
      });
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
    const states = await this.#activity?.reconcile(threads.map((thread, index) => {
      const listedState = sessions[index]?.state ?? "unknown";
      const lifecycleState = this.ownsActiveTurn(thread.id) && (listedState === "idle" || listedState === "unknown")
        ? "working"
        : listedState;
      return {
        providerSessionId: thread.id,
        ...(thread.path !== undefined ? { path: thread.path } : {}),
      // App Server's `notLoaded` is a cold catalogue state, not an active or
      // unknown turn. Once the external writer lock is gone (and Tethoq has
      // no owned turn), expose it as idle without asking the reconciler to
      // reopen the historical rollout.
        nativeState: isColdNotLoadedStatus(thread.status, externalWriters[index] === true, this.ownsActiveTurn(thread.id))
          ? "idle"
          : externalWriters[index] === true ? "unknown" : lifecycleState,
      // A separate Codex client can report its thread idle before its rollout
      // writer has persisted the terminal event. While that external writer is
      // present, the rollout's start/terminal marker is the authoritative turn
      // state; a terminal marker still keeps a merely open idle task idle.
      // App Server's cold `notLoaded` rows also normalize to unknown. They are
      // historical catalogue entries, not a reason to scan every rollout. A
      // real external writer (or a Tethoq-owned turn) still opts into the
      // rollout observer, and opening a task does so through watchSession().
        observeUnknown: !isColdNotLoadedStatus(thread.status, externalWriters[index] === true, this.ownsActiveTurn(thread.id))
          && (externalWriters[index] === true || this.#ownedThreads.has(thread.id)),
      };
    })) ?? new Map<string, SessionState>();
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
      ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
      ...(message.canonicalUserMessage ? { canonicalUserMessage: true } : {}),
    };
    const imageAttachments = message.role === "user" ? observedImageAttachments(activities) : [];
    // A rollout response_item is already a complete persisted record. Replaying
    // it as started/delta/completed made the renderer briefly mark finished work
    // as live and the text-free completion could erase the answer until history
    // catch-up restored it. One completed event is both faster and truthful.
    await this.emit({
      type: "message.completed",
      providerSessionId,
      payload: {
        ...base,
        text: message.text,
        ...(imageAttachments.length > 0 ? { requiresHistoryRefresh: true, imageAttachments } : {}),
      },
    });
  }

  private async publishDiscoveredActiveThread(providerSessionId: string): Promise<void> {
    if (this.#disposed) return;
    const response = await this.request<ThreadResponse>("thread/read", {
      threadId: providerSessionId,
      includeTurns: false,
    });
    if (this.#disposed || response.thread.id !== providerSessionId) return;
    const session = (await this.normalizeThreads([response.thread]))[0];
    if (session === undefined || this.#disposed) return;
    // The lock filename only tells us which task may have a writer. The rollout
    // marker reconciler above decides whether that writer has a live turn. Send
    // the resulting state through the normal provider event path so Bridge can
    // update an existing row or materialize a genuinely active unknown task.
    await this.emit({
      type: "session.updated",
      providerSessionId,
      payload: {
        state: session.state,
        activityDiscovered: true,
        ...(normalizeCodexThreadName(response.thread.name) !== undefined ? { title: session.title } : {}),
        ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
        ...(session.reasoningEffort !== undefined ? { reasoningEffort: session.reasoningEffort } : {}),
      },
    });
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

function isCodexThreadNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bthread\b[^\r\n]{0,160}\b(?:not found|not loaded)\b/iu.test(message);
}

function isCodexThreadHistoryUnavailableBeforeFirstMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bthread\b[^\r\n]{0,160}\bis not materialized yet;\s*includeTurns is unavailable before first user message\b/iu.test(message);
}

function isRecoverableScheduledHistoryRead(error: unknown): boolean {
  if (error instanceof JsonRpcRemoteError) {
    return /\binvalid paginated history lineage\b|\bhistory lineage\b[^\r\n]{0,160}\bcycle detected\b/iu.test(error.rpcError.message);
  }
  return !(error instanceof ProviderAdapterError) || error.code === "INITIALIZE_FAILED" && error.retryable;
}

function isCodexActiveWriter(error: unknown): boolean {
  return error instanceof JsonRpcRemoteError
    && /\balready has an active writer\b/iu.test(error.rpcError.message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  if (method === "turn/completed") {
    const turn = jsonObject(source.turn);
    const status = typeof turn.status === "string" ? turn.status.trim().toLowerCase() : undefined;
    const type = status === "interrupted" || status === "cancelled" || status === "canceled" || status === "aborted" || status === "stopped"
      ? "agent.interrupted"
      : status === "failed" || status === "error"
        ? "agent.error"
        : "agent.completed";
    return { ...base, type, payload: { ...(turnId !== undefined ? { turnId } : {}), turn } };
  }
  if (method === "item/agentMessage/delta") return { ...base, type: "message.delta", payload: { text: typeof source.delta === "string" ? visibleCodexAssistantDelta(source.delta) : "", ...(typeof source.itemId === "string" ? { itemId: source.itemId } : {}) } };
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
    if (type === "agentMessage" || type === "plan") {
      const text = assistantItemText(item);
      return { ...base, type: "message.completed", payload: { item: jsonObject(item), ...(text ? { text } : {}) } };
    }
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

function assistantItemText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : [item.content ?? item.text];
  return visibleCodexAssistantText(content.flatMap((part) => {
    if (typeof part === "string") return [part];
    return isRecord(part) && typeof part.text === "string" ? [part.text] : [];
  }).join(""));
}

function isColdNotLoadedStatus(status: unknown, externalWriter: boolean, ownedActiveTurn: boolean): boolean {
  const type = typeof status === "string"
    ? status
    : isRecord(status) && typeof status.type === "string" ? status.type : undefined;
  return type === "notLoaded" && !externalWriter && !ownedActiveTurn;
}

const nativeGoalStatuses = new Set<SessionGoalStatus>(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isThreadId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isNativeTimestamp(value: unknown): value is number {
  return isPositiveSafeInteger(value);
}

function isGoalOrderingTimestamp(value: unknown): value is number | string {
  if (isNativeTimestamp(value)) return true;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateGoalOrderingFields(source: Record<string, unknown>, method: string): void {
  if (hasOwn(source, "revision") && !isNonNegativeSafeInteger(source.revision)) {
    throw invalidGoalResponse(method);
  }
  if (hasOwn(source, "updatedAt") && !isGoalOrderingTimestamp(source.updatedAt)) {
    throw invalidGoalResponse(method);
  }
}

function validateGoalEnvelope(source: Record<string, unknown>, expectedThreadId: string, method: string): void {
  if (hasOwn(source, "threadId") && (!isThreadId(source.threadId) || source.threadId !== expectedThreadId)) {
    throw invalidGoalResponse(method);
  }
  validateGoalOrderingFields(source, method);
}

function requireGoalNotificationThread(source: Record<string, unknown>, method: string): string {
  if (!isThreadId(source.threadId)) throw invalidGoalResponse(method);
  return source.threadId;
}

function normalizeNativeGoal(value: unknown, expectedThreadId?: string): ProviderSessionGoal | undefined {
  if (!isRecord(value)
    || !isThreadId(value.threadId)
    || (expectedThreadId !== undefined && value.threadId !== expectedThreadId)
    || typeof value.objective !== "string"
    || value.objective.trim().length === 0
    || value.objective.length > sessionGoalObjectiveMaxLength
    || !nativeGoalStatuses.has(value.status as SessionGoalStatus)
    || !hasOwn(value, "tokenBudget")
    || (value.tokenBudget !== null && !isPositiveSafeInteger(value.tokenBudget))
    || !isNonNegativeSafeInteger(value.tokensUsed)
    || !isNonNegativeSafeInteger(value.timeUsedSeconds)
    || !isNativeTimestamp(value.createdAt)
    || !isNativeTimestamp(value.updatedAt)
    || (hasOwn(value, "revision") && !isNonNegativeSafeInteger(value.revision))) return undefined;
  return {
    objective: value.objective,
    status: value.status as SessionGoalStatus,
    tokenBudget: value.tokenBudget as number | null,
    tokensUsed: value.tokensUsed,
    timeUsedSeconds: value.timeUsedSeconds,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(hasOwn(value, "revision") ? { revision: value.revision as number } : {}),
  };
}

function invalidGoalResponse(method: string): ProviderAdapterError {
  return new ProviderAdapterError("codex", "GOAL_RESPONSE_INVALID", `Codex returned an invalid ${method} response`, false);
}

function requireNativeGoal(value: unknown, method: string, expectedThreadId?: string): ProviderSessionGoal {
  const goal = normalizeNativeGoal(value, expectedThreadId);
  if (goal === undefined) throw invalidGoalResponse(method);
  return goal;
}

function isUnsupportedGoalError(error: unknown): boolean {
  return error instanceof JsonRpcRemoteError && error.rpcError.code === -32601;
}
