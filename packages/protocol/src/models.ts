export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const sessionStates = [
  "idle",
  "working",
  "needs_input",
  "needs_approval",
  "completed",
  "failed",
  "disconnected",
  "unknown",
] as const;
export type SessionState = (typeof sessionStates)[number];

export const connectionStates = [
  "connecting",
  "online",
  "degraded",
  "offline",
  "disconnected",
] as const;
export type ConnectionState = (typeof connectionStates)[number];

export interface Host {
  readonly id: string;
  readonly displayName: string;
  readonly platform: "macos" | "windows" | "linux" | "unknown";
  readonly connectionState: ConnectionState;
  readonly protocolVersion: number;
  readonly lastSeenAt?: string;
  readonly relayConnected: boolean;
}

export interface ProviderCapabilities {
  readonly authentication: boolean;
  readonly listSessions: boolean;
  readonly paginatedSessions: boolean;
  readonly sessionHistory: boolean;
  readonly createSession: boolean;
  readonly resumeSession: boolean;
  readonly sendMessage: boolean;
  readonly steering: boolean;
  readonly streamingText: boolean;
  readonly toolEvents: boolean;
  readonly commandEvents: boolean;
  readonly fileChanges: boolean;
  readonly approvals: boolean;
  readonly userInput: boolean;
  readonly interrupt: boolean;
  readonly modelEnumeration: boolean;
  readonly projectAssociation: boolean;
  readonly sessionRelationships: boolean;
  readonly messageEditing: boolean;
  readonly remoteConnectivity: "none" | "local" | "documented_remote" | "experimental_remote";
  readonly notes: readonly string[];
}

export interface ProviderConnection {
  readonly providerId: string;
  readonly displayName: string;
  readonly state: ConnectionState;
  readonly detected: boolean;
  readonly authenticated: boolean | null;
  readonly capabilities: ProviderCapabilities;
  readonly lastError?: ProviderError;
  readonly nativeVersion?: string;
}

export type TranscriptionSourceStatus = "ready" | "needs_credential";

export interface TranscriptionSourceDescriptor {
  readonly id: string;
  readonly label: string;
  readonly status: TranscriptionSourceStatus;
  readonly setupEnvironmentVariable: string;
  readonly credential?: {
    readonly kind: "api_key";
    readonly label: string;
    readonly setupUrl: string;
  };
  readonly capabilities: {
    readonly batch: boolean;
    readonly maxAudioBytes: number;
  };
}

export const sessionRelationshipKinds = ["handoff", "branch", "subagent", "side_chat"] as const;
export type SessionRelationshipKind = (typeof sessionRelationshipKinds)[number];

export const sessionKinds = ["task", "side_chat", "internal"] as const;
export type SessionKind = (typeof sessionKinds)[number];

export const sessionRelationshipStrategies = ["summary_bootstrap", "native", "transcript_bootstrap"] as const;
export type SessionRelationshipStrategy = (typeof sessionRelationshipStrategies)[number];

/** How a newly created session relates to the session that supplied its context. */
export interface SessionRelationship {
  readonly kind: SessionRelationshipKind;
  readonly sourceSessionId: string;
  readonly strategy: SessionRelationshipStrategy;
}

export interface RemoteSessionProviderStatus {
  readonly kind: "retry";
  readonly message: string;
  readonly retryAt?: string;
}

export interface RemoteSession {
  readonly id: string;
  readonly hostId: string;
  readonly providerId: string;
  readonly providerSessionId: string;
  readonly title: string;
  readonly project?: string;
  readonly workingDirectory?: string;
  readonly state: SessionState;
  readonly providerStatus?: RemoteSessionProviderStatus;
  readonly createdAt?: string;
  readonly lastActivityAt: string;
  readonly preview?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly variantId?: string;
  readonly parentSessionId?: string;
  /** Omitted by older providers and clients; omission is equivalent to `task`. */
  readonly sessionKind?: SessionKind;
  readonly relationship?: SessionRelationship;
  readonly contextHandoffSummary?: string;
  readonly agentNickname?: string;
  readonly agentRole?: string;
  readonly needsApproval: boolean;
  readonly stale: boolean;
  /** Another local client owns the provider session writer, independently of turn activity. */
  readonly externalWriter?: boolean;
  readonly nativeMetadata: JsonObject;
}

export interface SessionTransferRequest {
  readonly sessionId: string;
  readonly prompt?: string;
}

export interface ContextHandoffResult {
  readonly summary: string;
  readonly session: RemoteSession;
  readonly prompt?: string;
}

export interface BranchSessionResult {
  readonly session: RemoteSession;
  readonly strategy: Extract<SessionRelationshipStrategy, "native" | "transcript_bootstrap">;
  readonly copiedMessageCount: number;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

/** A local Tethoq workflow attached to a user turn. */
export interface WorkflowReference {
  readonly id: string;
  readonly name: string;
  readonly eventCount: number;
  readonly screenshotCount: number;
  readonly applications?: readonly string[];
  /** Private local guidance for the coding tool. Clients should not render it as message text. */
  readonly promptReference?: string;
}

export type ContentPart =
  | { readonly type: "text"; readonly text: string; readonly providerPartId?: string }
  | { readonly type: "reasoning"; readonly text: string; readonly redacted: boolean; readonly providerPartId?: string }
  | { readonly type: "tool"; readonly name: string; readonly callId?: string; readonly input?: JsonValue; readonly output?: string; readonly status: "pending" | "running" | "completed" | "failed" }
  | { readonly type: "command"; readonly command: string; readonly cwd?: string; readonly output?: string; readonly exitCode?: number; readonly status: "pending" | "running" | "completed" | "failed" }
  | { readonly type: "file_change"; readonly path: string; readonly patch?: string; readonly change: "added" | "modified" | "deleted" | "unknown" }
  | { readonly type: "error"; readonly message: string; readonly code?: string }
  | { readonly type: "image"; readonly uri?: string; readonly mimeType?: string; readonly name?: string; readonly retrievalId?: string }
  | { readonly type: "audio"; readonly uri: string; readonly mimeType: string; readonly name: string; readonly durationSeconds?: number }
  | { readonly type: "file"; readonly name: string; readonly mimeType?: string }
  | { readonly type: "workflow"; readonly workflow: WorkflowReference }
  | {
      readonly type: "subagent";
      readonly tool: string;
      readonly action: "spawn" | "message" | "wait" | "interrupt" | "list" | "unknown";
      readonly status: "pending" | "running" | "completed" | "failed" | "unknown";
      readonly receiverSessionIds: readonly string[];
      readonly modelId?: string;
      readonly reasoningEffort?: string;
      readonly prompt?: string;
      readonly summary?: string;
    };

export interface RemoteMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly providerMessageId: string;
  readonly role: MessageRole;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly parts: readonly ContentPart[];
  readonly status: "streaming" | "completed" | "failed";
  readonly editable?: boolean;
  readonly origin?: RemoteMessageOrigin;
  readonly nativeMetadata: JsonObject;
}

export interface RemoteMessageOrigin {
  readonly kind: "cross_session";
  readonly envelopeId: string;
  readonly sourceSessionId: string;
  readonly sourceTitle: string;
}

export interface CrossSessionMessageEnvelope {
  readonly version: 1;
  readonly id: string;
  readonly requestId: string;
  readonly sourceSessionId: string;
  readonly sourceTitle: string;
  readonly targetSessionId: string;
  readonly content: string;
  readonly createdAt: string;
}

export type CrossSessionMessageState = "pending" | "sending" | "delivered" | "failed";

export interface CrossSessionMessage {
  readonly envelope: CrossSessionMessageEnvelope;
  readonly state: CrossSessionMessageState;
  readonly attemptCount: number;
  readonly updatedAt: string;
  readonly deliveredAt?: string;
  readonly providerMessageIds?: readonly string[];
  readonly error?: string;
}

export type MessageDeliveryMode = "queue" | "steer";
export type QueuedMessageState = "queued" | "sending" | "failed";

export interface QueuedMessageAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  /** Bounded image/audio preview retained by a provider-owned queue. */
  readonly dataUrl?: string;
  readonly durationSeconds?: number;
}

export interface QueuedMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly content: string;
  readonly mode: "queue";
  readonly state: QueuedMessageState;
  readonly createdAt: string;
  readonly attachments: readonly QueuedMessageAttachment[];
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly error?: string;
}

export const agentEventTypes = [
  "session.created",
  "session.updated",
  "session.status_changed",
  "message.started",
  "message.delta",
  "message.completed",
  "message.queued",
  "message.queue_updated",
  "message.queue_removed",
  "message.remote_received",
  "context.compaction_started",
  "context.compaction_completed",
  "side_chat.created",
  "side_chat.updated",
  "side_chat.promoted",
  "tool.started",
  "tool.output",
  "tool.completed",
  "command.started",
  "command.output",
  "command.completed",
  "file.changed",
  "approval.requested",
  "approval.resolved",
  "user_input.requested",
  "agent.error",
  "agent.completed",
  "agent.interrupted",
  "host.connected",
  "host.disconnected",
  "provider.connected",
  "provider.disconnected",
  "delegation.started",
  "delegation.updated",
  "delegation.completed",
  "delegation.failed",
] as const;
export type AgentEventType = (typeof agentEventTypes)[number];

export interface AgentEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: AgentEventType;
  readonly hostId: string;
  readonly providerId?: string;
  readonly sessionId?: string;
  readonly occurredAt: string;
  readonly payload: JsonObject;
  readonly nativeEvent?: JsonObject;
}

export type ApprovalChoiceId = "approve" | "reject" | string;

export interface ApprovalChoice {
  readonly id: ApprovalChoiceId;
  readonly label: string;
  readonly kind: "approve" | "reject" | "other";
}

export interface ApprovalRequest {
  readonly requestId: string;
  readonly hostId: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly providerRequestId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly title: string;
  readonly reason?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly affectedFiles: readonly string[];
  readonly networkDestinations: readonly string[];
  readonly riskMetadata: JsonObject;
  readonly choices: readonly ApprovalChoice[];
}

export interface ApprovalResponse {
  readonly requestId: string;
  readonly choiceId: ApprovalChoiceId;
  readonly respondedAt: string;
}

export interface UserInputRequest {
  readonly requestId: string;
  readonly hostId: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly providerRequestId: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly title: string;
  readonly prompt?: string;
  readonly request: JsonObject;
}

export interface UserInputResponse {
  readonly requestId: string;
  readonly answers: JsonObject;
  readonly respondedAt: string;
}

export interface RemoteModel {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly isDefault: boolean;
  readonly inputModalities?: readonly ("text" | "image" | "audio")[];
  readonly nativeMetadata: JsonObject;
}

/** Provider-reported lifetime usage for one conversation. Missing fields are unknown, never zero. */
export interface SessionTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
  readonly currency?: string;
}

/** Normalized context and compaction state shown by desktop and mobile clients. */
export interface SessionContextState {
  readonly sessionId: string;
  readonly modelId?: string;
  readonly usedTokens: number | null;
  readonly contextWindowTokens: number | null;
  readonly usedPercent: number | null;
  readonly compactionThresholdTokens: number | null;
  readonly minimumThresholdTokens: number | null;
  readonly supportsManualCompaction: boolean;
  readonly supportsThreshold: boolean;
  readonly isCompacting: boolean;
  readonly compactionKind: "automatic" | "manual" | null;
  readonly updatedAt: string;
  readonly usage: SessionTokenUsage;
}

export type WalletKind = "user_api" | "harness" | "subscription";

export interface ProviderWalletEndpoint {
  readonly id: string;
  readonly name: string;
  readonly apiKeyLabel?: string;
}

/** Payment source shown to clients. User API balances are local spend budgets, never stored value. */
export interface ProviderWalletStatus {
  readonly providerId: string;
  readonly kind: WalletKind;
  readonly label: string;
  readonly detail: string;
  readonly endpointId?: string;
  readonly endpointName?: string;
  readonly currency: string;
  readonly balance?: number;
  readonly spent?: number;
  readonly apiKeyConfigured: boolean;
  readonly apiKeyLabel?: string;
  readonly caution?: string;
  readonly availableEndpoints?: readonly ProviderWalletEndpoint[];
}

export interface DirectApiEndpointInput {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly protocol: "responses" | "chat_completions";
  readonly modelIds?: readonly string[];
}

export interface ConfigureWalletRequest {
  readonly endpointId: string;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly setBalance?: number;
  readonly addBalance?: number;
  readonly customEndpoint?: DirectApiEndpointInput;
}

export interface VisionProxySelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningEffort?: string;
}

export interface VisionProxyTarget {
  readonly providerId: string;
  readonly displayName: string;
  readonly models: readonly RemoteModel[];
}

export interface VisionProxyStatus {
  readonly sessionId: string;
  readonly primaryModelId?: string;
  readonly primaryModelSupportsImageInput: boolean | null;
  readonly configured: VisionProxySelection | null;
  readonly helperSessionId?: string;
}

export const delegationStates = [
  "spawning",
  "working",
  "needs_attention",
  "synthesizing",
  "completed",
  "failed",
] as const;
export type DelegationState = (typeof delegationStates)[number];

export interface DelegationTarget {
  readonly providerId: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
}

export interface DelegationChild {
  readonly id: string;
  readonly providerId: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly state: SessionState;
  readonly error?: string;
}

export interface DelegationTask {
  readonly id: string;
  readonly parentSessionId: string;
  readonly prompt: string;
  readonly state: DelegationState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly children: readonly DelegationChild[];
  readonly error?: string;
}

export interface ProviderError {
  readonly providerId: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly occurredAt: string;
  readonly nativeData?: JsonValue;
}

export interface RefreshProviderResult {
  readonly providerId: string;
  readonly status: "success" | "failed" | "skipped";
  readonly fetched: number;
  readonly pages: number;
  readonly newlyDiscovered: number;
  readonly error?: ProviderError;
}

export interface RefreshResult {
  readonly refreshId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sessions: readonly RemoteSession[];
  readonly providers: readonly RefreshProviderResult[];
  readonly lastSuccessfulRefreshAt?: string;
}
