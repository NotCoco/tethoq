export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const CONNECTOR_MANIFEST_VERSION = 1 as const;
export const CONNECTOR_PROTOCOL_VERSION = 1 as const;

export interface ConnectorModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly isDefault: boolean;
  readonly reasoningEfforts?: readonly string[];
  readonly metadata?: JsonObject;
}

export interface ConnectorCapabilities {
  readonly authentication: boolean;
  readonly listSessions: boolean;
  readonly paginatedSessions: boolean;
  readonly sessionHistory: boolean;
  readonly createSession: boolean;
  readonly resumeSession: boolean;
  readonly sendMessage: boolean;
  readonly messageQueue: boolean;
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
  readonly attachments: boolean;
  readonly reasoningEfforts: boolean;
}

export type ConnectorCapability = keyof ConnectorCapabilities;

export interface ConnectorPermissionDeclaration {
  readonly filesystem: "none" | "workspace" | "unrestricted";
  readonly network: boolean;
  readonly spawnProcesses: boolean;
}

export interface ConnectorRuntimeV1 {
  readonly transport: "stdio-jsonl";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Environment variable names the host may explicitly pass. Values never belong in a manifest. */
  readonly env?: readonly string[];
}

export interface ConnectorManifestV1 {
  readonly manifestVersion: typeof CONNECTOR_MANIFEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly homepage?: string;
  readonly runtime: ConnectorRuntimeV1;
  readonly permissions: ConnectorPermissionDeclaration;
  readonly capabilities: ConnectorCapabilities;
  /** Static model descriptors provide an instant model-picker fallback while the connector starts. */
  readonly models?: readonly ConnectorModelDescriptor[];
}

export type ConnectorManifestInputV1 = Omit<ConnectorManifestV1, "capabilities"> & {
  readonly capabilities?: Partial<ConnectorCapabilities>;
};

export interface ConnectorHostDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly platform: "windows" | "macos" | "linux" | "unknown";
}

export interface ConnectorInitializeParams {
  readonly protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
  readonly host: ConnectorHostDescriptor;
  readonly workspaceRoots: readonly string[];
}

export interface ConnectorInitializeResult {
  readonly protocolVersion: typeof CONNECTOR_PROTOCOL_VERSION;
  readonly connector: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  };
  readonly capabilities: ConnectorCapabilities;
  readonly models?: readonly ConnectorModelDescriptor[];
}

export interface ConnectorDetection {
  readonly available: boolean;
  readonly version?: string;
  readonly executable?: string;
  readonly details: readonly string[];
}

export interface ConnectorAuthStatus {
  readonly authenticated: boolean | null;
  readonly method?: string;
  readonly accountLabel?: string;
  readonly canAuthenticate: boolean;
  readonly details: readonly string[];
}

export interface ConnectorAuthStartParams {
  readonly method?: string;
  readonly credential?: string;
  readonly metadata?: JsonObject;
}

export interface ConnectorAuthResult {
  readonly authenticated: boolean;
  readonly pending: boolean;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly details: readonly string[];
}

export type ConnectorSessionState = "idle" | "working" | "needs_input" | "needs_approval" | "completed" | "failed" | "disconnected" | "unknown";

export interface ConnectorSession {
  readonly id: string;
  readonly title: string;
  readonly workingDirectory?: string;
  readonly project?: string;
  readonly state: ConnectorSessionState;
  readonly createdAt?: string;
  readonly lastActivityAt: string;
  readonly preview?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly parentSessionId?: string;
  readonly needsApproval: boolean;
  readonly metadata?: JsonObject;
}

export type ConnectorContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string; readonly redacted: boolean }
  | { readonly type: "tool"; readonly name: string; readonly callId?: string; readonly input?: JsonValue; readonly output?: string; readonly status: "pending" | "running" | "completed" | "failed" }
  | { readonly type: "command"; readonly command: string; readonly cwd?: string; readonly output?: string; readonly exitCode?: number; readonly status: "pending" | "running" | "completed" | "failed" }
  | { readonly type: "file_change"; readonly path: string; readonly patch?: string; readonly change: "added" | "modified" | "deleted" | "unknown" }
  | { readonly type: "error"; readonly message: string; readonly code?: string }
  | { readonly type: "image"; readonly uri?: string; readonly mimeType?: string; readonly name?: string }
  | { readonly type: "file"; readonly name: string; readonly mimeType?: string };

export interface ConnectorMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly parts: readonly ConnectorContentPart[];
  readonly status: "streaming" | "completed" | "failed";
  readonly editable?: boolean;
  readonly metadata?: JsonObject;
}

export interface ConnectorListSessionsParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly workingDirectory?: string;
  readonly sortKey?: "created_at" | "updated_at";
  readonly sortDirection?: "asc" | "desc";
  readonly parentSessionId?: string;
}

export interface ConnectorListSessionsResult {
  readonly sessions: readonly ConnectorSession[];
  readonly nextCursor: string | null;
}

export interface ConnectorSessionIdParams {
  readonly sessionId: string;
}

/** Omit sessionId to list queued messages across the whole provider. */
export interface ConnectorListQueuedMessagesParams {
  readonly sessionId?: string;
}

export interface ConnectorCreateSessionParams {
  readonly workingDirectory: string;
  readonly title?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly firstInstruction?: string;
  readonly parentSessionId?: string;
  readonly metadata?: JsonObject;
  /** Internal helpers must not inherit host tools or harness MCP configuration. */
  readonly clientTools?: "all" | "none";
  readonly mcpServers?: "inherit" | "none";
}

export interface ConnectorClientToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ConnectorAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly dataBase64: string;
  readonly byteLength: number;
}

export interface ConnectorSendMessageParams {
  readonly sessionId: string;
  readonly requestId: string;
  readonly content: string;
  /** Replace the previous turn's host tools with this list; [] disables them. */
  readonly clientTools?: readonly ConnectorClientToolDefinition[];
  /**
   * Private per-turn guidance for the connector's provider.
   * Connectors must not persist or render this alongside visible message text.
   */
  readonly developerInstructions?: string;
  readonly modelId?: string;
  readonly reasoningEffort?: string;
  readonly attachments?: readonly ConnectorAttachment[];
  readonly metadata?: JsonObject;
}

export interface ConnectorSendMessageResult {
  readonly accepted: boolean;
  readonly turnId?: string;
  readonly details: readonly string[];
}

export interface ConnectorEditMessageParams extends ConnectorSendMessageParams {
  readonly messageId: string;
}

export interface ConnectorQueuedMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly content: string;
  readonly state: "queued" | "sending" | "failed";
  readonly createdAt: string;
  readonly error?: string;
}

export interface ConnectorQueueEnqueueParams extends ConnectorSendMessageParams {
  readonly workingDirectory: string;
}

export interface ConnectorQueueCancelParams {
  readonly sessionId: string;
  readonly messageId: string;
}

export interface ConnectorApprovalResponseParams {
  readonly requestId: string;
  readonly choiceId: string;
}

export interface ConnectorUserInputResponseParams {
  readonly requestId: string;
  readonly answers: JsonObject;
}

export interface ConnectorApprovalRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly reason?: string;
  readonly command?: string;
  readonly workingDirectory?: string;
  readonly affectedFiles: readonly string[];
  readonly networkDestinations: readonly string[];
  readonly choices: readonly { readonly id: string; readonly label: string; readonly kind: "approve" | "reject" | "other" }[];
  readonly riskMetadata?: JsonObject;
  readonly expiresAt?: string;
}

export type ConnectorEventType =
  | "session.created" | "session.updated" | "session.status_changed"
  | "message.started" | "message.delta" | "message.completed"
  | "message.queued" | "message.queue_updated" | "message.queue_removed"
  | "tool.started" | "tool.output" | "tool.completed"
  | "command.started" | "command.output" | "command.completed"
  | "file.changed" | "approval.requested" | "approval.resolved"
  | "user_input.requested" | "agent.error" | "agent.completed" | "agent.interrupted";

export interface ConnectorEvent {
  readonly id: string;
  readonly sessionId?: string;
  readonly type: ConnectorEventType;
  readonly occurredAt: string;
  readonly payload: JsonObject;
  readonly nativeEvent?: JsonObject;
  readonly approval?: ConnectorApprovalRequest;
}

export interface ConnectorSubscribeParams {
  readonly sessionId: string | null;
}

export interface ConnectorSubscribeResult {
  readonly subscriptionId: string;
}

export interface ConnectorUnsubscribeParams {
  readonly subscriptionId: string;
}

export interface ConnectorEventNotification {
  readonly subscriptionId: string;
  readonly event: ConnectorEvent;
}

export interface ConnectorHostToolParams {
  readonly sessionId: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface ConnectorLogNotification {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly metadata?: JsonObject;
}

export interface ConnectorHandlerContext {
  readonly manifest: ConnectorManifestV1;
  readonly host: ConnectorHostDescriptor;
  readonly workspaceRoots: readonly string[];
  readonly signal: AbortSignal;
  emitEvent(subscriptionId: string, event: ConnectorEvent): Promise<void>;
  executeHostTool(params: ConnectorHostToolParams): Promise<JsonValue>;
  log(level: ConnectorLogNotification["level"], message: string, metadata?: JsonObject): Promise<void>;
}

export type ConnectorHandler<P, R> = (params: P, context: ConnectorHandlerContext) => R | Promise<R>;

export interface ConnectorHandlers {
  readonly initialize?: ConnectorHandler<ConnectorInitializeParams, void>;
  readonly shutdown?: ConnectorHandler<Record<string, never>, void>;
  readonly detect?: ConnectorHandler<Record<string, never>, ConnectorDetection>;
  readonly getAuthStatus?: ConnectorHandler<Record<string, never>, ConnectorAuthStatus>;
  readonly authenticate?: ConnectorHandler<ConnectorAuthStartParams, ConnectorAuthResult>;
  readonly getCapabilities?: ConnectorHandler<Record<string, never>, ConnectorCapabilities>;
  readonly listModels?: ConnectorHandler<Record<string, never>, readonly ConnectorModelDescriptor[]>;
  readonly listSessions?: ConnectorHandler<ConnectorListSessionsParams, ConnectorListSessionsResult>;
  readonly getSession?: ConnectorHandler<ConnectorSessionIdParams, ConnectorSession>;
  readonly listMessages?: ConnectorHandler<ConnectorSessionIdParams, readonly ConnectorMessage[]>;
  readonly createSession?: ConnectorHandler<ConnectorCreateSessionParams, ConnectorSession>;
  readonly resumeSession?: ConnectorHandler<ConnectorSessionIdParams, void>;
  readonly sendMessage?: ConnectorHandler<ConnectorSendMessageParams, ConnectorSendMessageResult>;
  readonly steerMessage?: ConnectorHandler<ConnectorSendMessageParams, ConnectorSendMessageResult>;
  readonly editMessage?: ConnectorHandler<ConnectorEditMessageParams, ConnectorSendMessageResult>;
  readonly interrupt?: ConnectorHandler<ConnectorSessionIdParams, void>;
  readonly listQueuedMessages?: ConnectorHandler<ConnectorListQueuedMessagesParams, readonly ConnectorQueuedMessage[]>;
  readonly enqueueMessage?: ConnectorHandler<ConnectorQueueEnqueueParams, ConnectorQueuedMessage>;
  readonly cancelQueuedMessage?: ConnectorHandler<ConnectorQueueCancelParams, { readonly cancelled: boolean }>;
  readonly respondToApproval?: ConnectorHandler<ConnectorApprovalResponseParams, void>;
  readonly respondToUserInput?: ConnectorHandler<ConnectorUserInputResponseParams, void>;
  readonly subscribe?: ConnectorHandler<ConnectorSubscribeParams, ConnectorSubscribeResult>;
  readonly unsubscribe?: ConnectorHandler<ConnectorUnsubscribeParams, void>;
}

export interface ConnectorRpcRequestMap {
  "connector.initialize": { readonly params: ConnectorInitializeParams; readonly result: ConnectorInitializeResult };
  "connector.ping": { readonly params: Record<string, never>; readonly result: { readonly ok: true; readonly now: string } };
  "connector.shutdown": { readonly params: Record<string, never>; readonly result: Record<string, never> };
  "provider.detect": { readonly params: Record<string, never>; readonly result: ConnectorDetection };
  "provider.auth.status": { readonly params: Record<string, never>; readonly result: ConnectorAuthStatus };
  "provider.auth.start": { readonly params: ConnectorAuthStartParams; readonly result: ConnectorAuthResult };
  "provider.capabilities": { readonly params: Record<string, never>; readonly result: ConnectorCapabilities };
  "provider.models.list": { readonly params: Record<string, never>; readonly result: readonly ConnectorModelDescriptor[] };
  "session.list": { readonly params: ConnectorListSessionsParams; readonly result: ConnectorListSessionsResult };
  "session.get": { readonly params: ConnectorSessionIdParams; readonly result: ConnectorSession };
  "session.messages.list": { readonly params: ConnectorSessionIdParams; readonly result: readonly ConnectorMessage[] };
  "session.create": { readonly params: ConnectorCreateSessionParams; readonly result: ConnectorSession };
  "session.resume": { readonly params: ConnectorSessionIdParams; readonly result: void };
  "session.message.send": { readonly params: ConnectorSendMessageParams; readonly result: ConnectorSendMessageResult };
  "session.message.steer": { readonly params: ConnectorSendMessageParams; readonly result: ConnectorSendMessageResult };
  "session.message.edit": { readonly params: ConnectorEditMessageParams; readonly result: ConnectorSendMessageResult };
  "session.interrupt": { readonly params: ConnectorSessionIdParams; readonly result: void };
  "session.queue.list": { readonly params: ConnectorListQueuedMessagesParams; readonly result: readonly ConnectorQueuedMessage[] };
  "session.queue.enqueue": { readonly params: ConnectorQueueEnqueueParams; readonly result: ConnectorQueuedMessage };
  "session.queue.cancel": { readonly params: ConnectorQueueCancelParams; readonly result: { readonly cancelled: boolean } };
  "approval.respond": { readonly params: ConnectorApprovalResponseParams; readonly result: void };
  "userInput.respond": { readonly params: ConnectorUserInputResponseParams; readonly result: void };
  "events.subscribe": { readonly params: ConnectorSubscribeParams; readonly result: ConnectorSubscribeResult };
  "events.unsubscribe": { readonly params: ConnectorUnsubscribeParams; readonly result: void };
  "host.tool.execute": { readonly params: ConnectorHostToolParams; readonly result: JsonValue };
}

export type ConnectorRpcMethod = keyof ConnectorRpcRequestMap;

export const connectorRpcMethods = Object.freeze([
  "connector.initialize", "connector.ping", "connector.shutdown",
  "provider.detect", "provider.auth.status", "provider.auth.start", "provider.capabilities", "provider.models.list",
  "session.list", "session.get", "session.messages.list", "session.create", "session.resume",
  "session.message.send", "session.message.steer", "session.message.edit", "session.interrupt",
  "session.queue.list", "session.queue.enqueue", "session.queue.cancel",
  "approval.respond", "userInput.respond", "events.subscribe", "events.unsubscribe", "host.tool.execute",
] as const satisfies readonly ConnectorRpcMethod[]);
