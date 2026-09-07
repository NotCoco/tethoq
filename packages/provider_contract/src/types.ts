import type {
  AgentEventType,
  ApprovalChoice,
  JsonObject,
  JsonValue,
  ProviderCapabilities,
  ProviderError,
  RemoteMessage,
  RemoteModel,
  RemoteSession,
  ConfigureWalletRequest,
  ProviderWalletStatus,
  SessionContextState,
  SessionGoalStatus,
  WorkflowReference,
} from "../../protocol/src/index.js";

export interface ProviderSessionGoal {
  readonly objective: string;
  readonly status: SessionGoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  /** Native providers may expose epoch seconds/milliseconds or an ISO string. */
  readonly createdAt: number | string;
  readonly updatedAt: number | string;
  /** Optional provider-owned ordering token used to reject reordered updates. */
  readonly revision?: number;
}

export interface ProviderSessionGoalUpdate {
  readonly objective?: string;
  readonly status?: SessionGoalStatus;
  readonly tokenBudget?: number | null;
}

export interface ProviderDetection {
  readonly providerId: string;
  readonly available: boolean;
  readonly version?: string;
  readonly executable?: string;
  readonly details: readonly string[];
}

export interface AuthStatus {
  readonly authenticated: boolean | null;
  readonly method?: string;
  readonly accountLabel?: string;
  readonly canAuthenticate: boolean;
  readonly details: readonly string[];
}

export interface AuthRequest {
  readonly method?: string;
  readonly credential?: string;
  readonly metadata?: JsonObject;
}

export interface AuthResult {
  readonly authenticated: boolean;
  readonly pending: boolean;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly details: readonly string[];
}

export interface ListSessionsOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly workingDirectory?: string;
  readonly sortKey?: "created_at" | "updated_at";
  readonly sortDirection?: "asc" | "desc";
  readonly parentProviderSessionId?: string;
}

export interface PaginatedSessions {
  readonly sessions: readonly RemoteSession[];
  readonly nextCursor: string | null;
  /**
   * False means the provider returned a useful bounded window rather than its
   * complete inventory. Clients may merge it, but must not delete older known
   * sessions merely because they are absent from this window.
   */
  readonly authoritative?: boolean;
}

export interface CreateSessionOptions {
  readonly workingDirectory: string;
  readonly title?: string;
  /** Local display fallback; leave the native title unset so the harness can generate it. */
  readonly provisionalTitle?: boolean;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly firstInstruction?: string;
  /** Hidden, session-scoped role guidance. Never synthesize this as a user message. */
  readonly developerInstructions?: string;
  /** Guidance applied only while dispatching firstInstruction, never installed on the session. */
  readonly firstInstructionDeveloperInstructions?: string;
  /** Provider-native non-persistent session when supported. */
  readonly ephemeral?: boolean;
  /** Internal helpers omit bridge client tools so they cannot recurse. */
  readonly clientTools?: "all" | "none";
  /** Start without configured MCP servers when the provider supports per-session config. */
  readonly mcpServers?: "inherit" | "none";
  readonly metadata?: JsonObject;
}

export interface SessionCreationFeatures {
  /** Enforces tool isolation for sessions marked internalPurpose=vision_proxy. */
  readonly visionToolIsolation?: boolean;
  readonly hiddenDeveloperInstructions: boolean;
  readonly ephemeralSessions: boolean;
  readonly selectableClientTools: boolean;
}

export interface MessageAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly dataBase64: string;
  readonly byteLength: number;
}

export interface SendMessageRequest {
  readonly requestId: string;
  readonly content: string;
  /** Per-turn response guidance. Providers should keep this out of user-visible transcript text when their API permits it. */
  readonly developerInstructions?: string;
  /** Turn-scoped availability overrides for app-owned client tools. */
  readonly clientToolOverrides?: Readonly<Record<string, boolean>>;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly attachments?: readonly MessageAttachment[];
  readonly workflows?: readonly WorkflowReference[];
  readonly metadata?: JsonObject;
}

export interface SendMessageResult {
  readonly accepted: boolean;
  readonly providerTurnId?: string;
  readonly details: readonly string[];
}

export interface ClientToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface SessionMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface SessionMcpBinding {
  readonly server: SessionMcpServer;
  bind(providerSessionId: string): void;
  release(): void;
}

export type ClientToolLifecycleOwner = "bridge" | "provider";

export interface ClientToolExecutionContext {
  /** Stable provider-side identity for this one tool call. */
  readonly callId?: string;
  /** Provider means its adapter publishes the visible tool lifecycle itself; omission is Bridge-owned. */
  readonly lifecycleOwner?: ClientToolLifecycleOwner;
}

export interface ProviderClientTooling {
  readonly definitions: readonly ClientToolDefinition[];
  execute(providerId: string, providerSessionId: string, tool: string, input: JsonObject, context?: ClientToolExecutionContext): Promise<JsonValue>;
  mcpServer(providerId: string, providerSessionId: string, lifecycleOwner?: ClientToolLifecycleOwner): SessionMcpServer;
  /** Creates an MCP endpoint before an ACP session/new response reveals its session ID. */
  createSessionBinding?(providerId: string, lifecycleOwner?: ClientToolLifecycleOwner): SessionMcpBinding;
}

export interface ProviderQueuedMessage {
  readonly id: string;
  readonly providerSessionId: string;
  readonly content: string;
  readonly state: "queued" | "sending" | "failed";
  readonly createdAt: string;
  /** Safe display metadata retained from a provider-owned composer queue. */
  readonly attachments?: readonly ProviderQueuedMessageAttachment[];
  /** Private response guidance retained with a provider-owned queue item. */
  readonly developerInstructions?: string;
  readonly error?: string;
}

export interface ProviderQueuedMessageAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  /** Bounded image/audio data URL suitable for a queue preview. */
  readonly dataUrl?: string;
  readonly durationSeconds?: number;
}

export interface EnqueueProviderMessageRequest extends SendMessageRequest {
  readonly workingDirectory: string;
}

/** Restores a provider-owned queue item after a failed manual dispatch. */
export interface RestoreProviderMessageRequest extends EnqueueProviderMessageRequest {
  readonly originalMessage: ProviderQueuedMessage;
  /** Provider-native ID of the sibling that originally followed this item. */
  readonly beforeMessageId?: string;
}

export interface EditMessageRequest {
  readonly requestId: string;
  readonly providerMessageId: string;
  readonly content: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
}

export interface ProviderApprovalResponse {
  readonly providerRequestId: string;
  readonly choiceId: string;
}

export interface ProviderUserInputResponse {
  readonly providerRequestId: string;
  readonly answers: JsonObject;
}

export interface ProviderPermissionControl {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string; readonly description?: string; readonly disabled?: boolean }[];
}

export interface ProviderSessionPermissions {
  readonly controls: readonly ProviderPermissionControl[];
  readonly note?: string;
}

export interface ProviderApprovalRequest {
  readonly providerRequestId: string;
  readonly providerSessionId: string;
  readonly title: string;
  readonly reason?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly affectedFiles: readonly string[];
  readonly networkDestinations: readonly string[];
  readonly choices: readonly ApprovalChoice[];
  readonly riskMetadata: JsonObject;
  readonly expiresAt?: string;
}

export interface ProviderEvent {
  readonly eventId: string;
  readonly providerId: string;
  readonly providerSessionId?: string;
  readonly type: AgentEventType;
  readonly occurredAt: string;
  readonly payload: JsonObject;
  readonly nativeEvent?: JsonObject;
  readonly approval?: ProviderApprovalRequest;
}

/**
 * A provider-owned task launch observed in another provider's durable activity.
 * This is evidence, not a relationship by itself: the bridge still requires an
 * unambiguous target-session match before nesting anything in the UI.
 */
export interface ObservedExternalSessionLaunch {
  readonly targetProviderId: string;
  readonly title: string;
  readonly observedAt: string;
  readonly workingDirectory?: string;
  readonly modelId?: string;
}

export type ProviderEventSink = (event: ProviderEvent) => void | Promise<void>;

export interface Subscription {
  readonly id: string;
  unsubscribe(): Promise<void>;
}

export interface RecentProviderMessages {
  readonly messages: readonly RemoteMessage[];
  /** True when this bounded read already contains the provider's whole transcript. */
  readonly complete: boolean;
  /** Opaque provider cursor for expanding this snapshot toward older history. */
  readonly olderCursor?: string;
  /** True when an older-history response contains only the newly read page. */
  readonly pageOnly?: true;
}

export interface AgentProviderAdapter {
  readonly providerId: string;
  readonly displayName: string;
  readonly sessionCreationFeatures?: SessionCreationFeatures;

  detect(): Promise<ProviderDetection>;
  getAuthStatus(): Promise<AuthStatus>;
  authenticate?(request: AuthRequest): Promise<AuthResult>;

  getCapabilities(): Promise<ProviderCapabilities>;
  configureClientTooling?(tooling: ProviderClientTooling): void;
  listModels?(): Promise<readonly RemoteModel[]>;

  /** Returns provider-native usage/context data without starting an LLM turn. */
  getSessionContext?(providerSessionId: string): Promise<Omit<SessionContextState, "sessionId" | "compactionThresholdTokens" | "minimumThresholdTokens" | "supportsThreshold" | "isCompacting" | "compactionKind">>;
  /**
   * Compacts context without sending a user message. Resolves only after the
   * compacted context is ready for the next turn, not on request acceptance.
   * Rejects on failure, cancellation, or loss of completion confirmation.
   */
  compactSession?(providerSessionId: string): Promise<void>;
  /** Undefined result means this provider/version has no native goal API. */
  getGoal?(providerSessionId: string): Promise<ProviderSessionGoal | null | undefined>;
  /** Undefined result means this provider/version has no native goal API. */
  setGoal?(providerSessionId: string, update: ProviderSessionGoalUpdate): Promise<ProviderSessionGoal | undefined>;
  /** Undefined means this provider/version has no native goal API. */
  clearGoal?(providerSessionId: string): Promise<boolean | undefined>;
  /** Returns the funding/authentication source without exposing credentials. */
  getWalletStatus?(modelId?: string, endpointId?: string): Promise<ProviderWalletStatus>;
  /** Configures a direct-API wallet. Harness/subscription adapters omit this. */
  configureWallet?(request: ConfigureWalletRequest): Promise<ProviderWalletStatus>;

  listSessions(options?: ListSessionsOptions): Promise<PaginatedSessions>;
  getSession(providerSessionId: string): Promise<RemoteSession>;
  /** Optional fast bounded tail for rendering before complete history is needed. */
  getRecentMessages?(providerSessionId: string): Promise<RecentProviderMessages>;
  /** Returns an expanded snapshot, or a pageOnly older delta for the client to prepend. */
  getOlderMessages?(providerSessionId: string, cursor: string): Promise<RecentProviderMessages>;
  getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]>;
  /** Reads durable provider activity for explicit launches of another provider. */
  getExternalSessionLaunches?(providerSessionId: string, since: string): Promise<readonly ObservedExternalSessionLaunch[]>;

  createSession(options: CreateSessionOptions): Promise<RemoteSession>;
  /** Copies provider-native conversation history into a new session without starting a model turn. */
  branchSession?(providerSessionId: string): Promise<RemoteSession>;
  resumeSession(providerSessionId: string): Promise<void>;
  sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult>;
  /** Sends through the process that currently owns an externally-written task. */
  sendMessageToExternalOwner?(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult>;
  /** True while a model turn is still in flight, even if listed session status is stale. */
  hasActiveTurn?(providerSessionId: string): boolean;
  /** True only when this adapter, rather than an external peer, owns the active writer. */
  ownsActiveTurn?(providerSessionId: string): boolean;
  /** Include unresolved disconnected turns when deciding whether a server can be stopped. */
  activeSessionIds?(options?: { readonly includeDisconnected?: boolean }): readonly string[];
  /** True while any session streams through the adapter's secondary server feed. */
  isSecondaryBusy?(): boolean;
  /** Attaches (url) or detaches (undefined) the secondary server feed. */
  setSecondaryBaseUrl?(url: string | undefined): void;
  listQueuedMessages?(): Promise<readonly ProviderQueuedMessage[]>;
  enqueueQueuedMessage?(providerSessionId: string, request: EnqueueProviderMessageRequest): Promise<ProviderQueuedMessage>;
  /** Restores the original identity, time, and position after a failed move out of the provider queue. */
  restoreQueuedMessage?(providerSessionId: string, request: RestoreProviderMessageRequest): Promise<ProviderQueuedMessage>;
  /** Replaces one queued message in place without changing its order or identity. */
  updateQueuedMessage?(providerSessionId: string, messageId: string, content: string): Promise<ProviderQueuedMessage | null>;
  cancelQueuedMessage?(providerSessionId: string, messageId: string): Promise<boolean>;
  /** Atomically removes and steers a provider-owned queue item through its external owner. */
  steerQueuedMessage?(providerSessionId: string, messageId: string, request: SendMessageRequest): Promise<SendMessageResult>;
  steerMessage?(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult>;
  editMessage?(providerSessionId: string, request: EditMessageRequest): Promise<SendMessageResult>;
  interrupt?(providerSessionId: string): Promise<void>;

  subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription>;
  respondToApproval?(response: ProviderApprovalResponse): Promise<void>;
  respondToUserInput?(response: ProviderUserInputResponse): Promise<void>;
  /** Native permission choices for this task, without changing harness-wide defaults. */
  getSessionPermissions?(providerSessionId: string): Promise<ProviderSessionPermissions>;
  setSessionPermission?(providerSessionId: string, controlId: string, value: string): Promise<ProviderSessionPermissions>;
  /**
   * Keeps live session/update notifications flowing without reloading complete
   * history. Returning false asks the client to retain its bounded history-poll
   * fallback because this adapter has no incremental watch path available.
   */
  watchSession?(providerSessionId: string): Promise<boolean | void>;
  unwatchSession?(providerSessionId: string): void;
  /** Unload a private helper's runtime without deleting its transcript or stopping other sessions. */
  releaseSession?(providerSessionId: string): Promise<void>;
  /** Releases a restartable provider transport while preserving cached session and event state. */
  releaseIdleResources?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProviderFailure {
  readonly error: ProviderError;
  readonly nativeData?: JsonValue;
}
