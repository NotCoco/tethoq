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
  WorkflowReference,
} from "../../protocol/src/index.js";

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
}

export interface CreateSessionOptions {
  readonly workingDirectory: string;
  readonly title?: string;
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

export interface ProviderClientTooling {
  readonly definitions: readonly ClientToolDefinition[];
  execute(providerId: string, providerSessionId: string, tool: string, input: JsonObject): Promise<JsonValue>;
  mcpServer(providerId: string, providerSessionId: string): SessionMcpServer;
  /** Creates an MCP endpoint before an ACP session/new response reveals its session ID. */
  createSessionBinding?(providerId: string): SessionMcpBinding;
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
  /** Requests provider-native context compaction without sending a user message. */
  compactSession?(providerSessionId: string): Promise<void>;
  /** Returns the funding/authentication source without exposing credentials. */
  getWalletStatus?(modelId?: string, endpointId?: string): Promise<ProviderWalletStatus>;
  /** Configures a direct-API wallet. Harness/subscription adapters omit this. */
  configureWallet?(request: ConfigureWalletRequest): Promise<ProviderWalletStatus>;

  listSessions(options?: ListSessionsOptions): Promise<PaginatedSessions>;
  getSession(providerSessionId: string): Promise<RemoteSession>;
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
  /** Provider-native session ids that currently have a model turn in flight. */
  activeSessionIds?(): readonly string[];
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
  /** Keeps the provider transport attached so live session/update notifications continue. */
  watchSession?(providerSessionId: string): Promise<void>;
  unwatchSession?(providerSessionId: string): void;
  /** Releases a restartable provider transport while preserving cached session and event state. */
  releaseIdleResources?(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProviderFailure {
  readonly error: ProviderError;
  readonly nativeData?: JsonValue;
}
