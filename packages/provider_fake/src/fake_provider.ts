import { randomUUID } from "node:crypto";
import {
  makeGlobalSessionId,
  type ProviderCapabilities,
  type RemoteMessage,
  type RemoteModel,
  type RemoteSession,
  type SessionState,
} from "../../protocol/src/index.js";
import {
  ProviderAdapterError,
  ProviderEventHub,
  type AgentProviderAdapter,
  type AuthStatus,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type PaginatedSessions,
  type ProviderApprovalResponse,
  type ProviderUserInputResponse,
  type ProviderDetection,
  type ProviderEvent,
  type ProviderEventSink,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../provider_contract/src/index.js";

interface NativeSession {
  readonly id: string;
  title: string;
  workingDirectory: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  preview: string;
  needsApproval: boolean;
}

interface PendingApproval {
  readonly providerSessionId: string;
  readonly resolve: (choice: string) => void;
}

interface PendingUserInput {
  readonly providerSessionId: string;
  readonly resolve: (answers: Record<string, unknown>) => void;
}

export interface FakeProviderOptions {
  readonly hostId: string;
  readonly sessionCount?: number;
  readonly pageSize?: number;
  readonly providerId?: string;
  readonly displayName?: string;
  readonly now?: () => Date;
}

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
  sessionRelationships: false,
  messageEditing: false,
  remoteConnectivity: "documented_remote",
  notes: ["Deterministic test adapter; never enable in production configuration."],
};

export class FakeProviderAdapter implements AgentProviderAdapter {
  public readonly providerId: string;
  public readonly displayName: string;
  readonly #hostId: string;
  readonly #pageSize: number;
  readonly #now: () => Date;
  readonly #events = new ProviderEventHub();
  readonly #sessions = new Map<string, NativeSession>();
  readonly #messages = new Map<string, RemoteMessage[]>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #pendingUserInputs = new Map<string, PendingUserInput>();
  readonly #requestResults = new Map<string, SendMessageResult>();
  #eventCounter = 0;
  #online = true;
  #failListing = false;
  #disposed = false;

  public constructor(options: FakeProviderOptions) {
    this.providerId = options.providerId ?? "fake";
    this.displayName = options.displayName ?? "Fake Provider";
    this.#hostId = options.hostId;
    this.#pageSize = options.pageSize ?? 50;
    this.#now = options.now ?? (() => new Date());
    this.seed(options.sessionCount ?? 175);
  }

  public async detect(): Promise<ProviderDetection> {
    return {
      providerId: this.providerId,
      available: !this.#disposed,
      version: "1.0.0-test",
      executable: "in-process",
      details: ["Purpose-built lifecycle simulator with pagination, streaming, failures, duplicates, and approvals."],
    };
  }

  public async getAuthStatus(): Promise<AuthStatus> {
    return { authenticated: true, method: "test", accountLabel: "fixture", canAuthenticate: false, details: ["No real credential is used."] };
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    return capabilities;
  }

  public async listModels(): Promise<readonly RemoteModel[]> {
    this.assertOnline();
    return [
      { id: "fake-fast", providerId: this.providerId, displayName: "Fake Fast", isDefault: true, nativeMetadata: {} },
      { id: "fake-careful", providerId: this.providerId, displayName: "Fake Careful", isDefault: false, nativeMetadata: {} },
    ];
  }

  public async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    this.assertOnline();
    if (this.#failListing) throw new ProviderAdapterError(this.providerId, "SIMULATED_LIST_FAILURE", "Simulated provider refresh failure", true);
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) throw new ProviderAdapterError(this.providerId, "BAD_CURSOR", `Invalid fake cursor ${String(options.cursor)}`, false);
    const limit = Math.min(Math.max(options.limit ?? this.#pageSize, 1), this.#pageSize);
    const native = [...this.#sessions.values()]
      .filter((session) => options.workingDirectory === undefined || session.workingDirectory === options.workingDirectory)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const page = native.slice(offset, offset + limit).map((session) => this.normalizeSession(session));
    const nextOffset = offset + page.length;
    return { sessions: page, nextCursor: nextOffset < native.length ? String(nextOffset) : null };
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    this.assertOnline();
    const session = this.requireSession(providerSessionId);
    return this.normalizeSession(session);
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    this.assertOnline();
    this.requireSession(providerSessionId);
    return [...(this.#messages.get(providerSessionId) ?? [])];
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    this.assertOnline();
    const id = `fake_session_${randomUUID()}`;
    const now = this.#now().toISOString();
    const session: NativeSession = {
      id,
      title: options.title ?? options.firstInstruction?.slice(0, 72) ?? "New fake session",
      workingDirectory: options.workingDirectory,
      state: "idle",
      createdAt: now,
      updatedAt: now,
      preview: options.firstInstruction ?? "",
      needsApproval: false,
    };
    this.#sessions.set(id, session);
    this.#messages.set(id, []);
    await this.emit({ type: "session.created", providerSessionId: id, payload: { title: session.title } });
    if (options.firstInstruction !== undefined) {
      await this.sendMessage(id, {
        requestId: `create_${randomUUID()}`,
        content: options.firstInstruction,
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });
    }
    return this.normalizeSession(session);
  }

  public async resumeSession(providerSessionId: string): Promise<void> {
    this.assertOnline();
    const session = this.requireSession(providerSessionId);
    session.state = "idle";
    session.updatedAt = this.#now().toISOString();
    await this.emit({ type: "session.status_changed", providerSessionId, payload: { state: "idle" } });
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.assertOnline();
    const prior = this.#requestResults.get(request.requestId);
    if (prior !== undefined) return prior;
    const session = this.requireSession(providerSessionId);
    const now = this.#now().toISOString();
    const userMessage: RemoteMessage = {
      id: `${this.providerId}/${request.requestId}`,
      sessionId: makeGlobalSessionId(this.#hostId, this.providerId, providerSessionId),
      providerMessageId: request.requestId,
      role: "user",
      createdAt: now,
      completedAt: now,
      parts: [{ type: "text", text: request.content }],
      status: "completed",
      nativeMetadata: {},
    };
    this.#messages.get(providerSessionId)?.push(userMessage);
    session.state = "working";
    session.preview = request.content;
    session.updatedAt = now;
    const result: SendMessageResult = { accepted: true, providerTurnId: `turn_${randomUUID()}`, details: [] };
    this.#requestResults.set(request.requestId, result);
    void this.runApprovalScenario(session, request).catch(async (error: unknown) => {
      await this.emit({
        type: "agent.error",
        providerSessionId,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    });
    return result;
  }

  public async steerMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    return await this.sendMessage(providerSessionId, request);
  }

  public async interrupt(providerSessionId: string): Promise<void> {
    const session = this.requireSession(providerSessionId);
    session.state = "idle";
    session.needsApproval = false;
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.providerSessionId === providerSessionId) {
        pending.resolve("reject");
        this.#pendingApprovals.delete(requestId);
      }
    }
    await this.emit({ type: "agent.interrupted", providerSessionId, payload: {} });
  }

  public async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    return this.#events.subscribe(providerSessionId, sink);
  }

  public async respondToApproval(response: ProviderApprovalResponse): Promise<void> {
    this.assertOnline();
    const pending = this.#pendingApprovals.get(response.providerRequestId);
    if (pending === undefined) throw new ProviderAdapterError(this.providerId, "APPROVAL_NOT_FOUND", "Approval request is stale or unknown", false);
    if (response.choiceId !== "approve" && response.choiceId !== "reject") throw new ProviderAdapterError(this.providerId, "APPROVAL_CHOICE_INVALID", `Unsupported choice ${response.choiceId}`, false);
    this.#pendingApprovals.delete(response.providerRequestId);
    pending.resolve(response.choiceId);
  }

  public async respondToUserInput(response: ProviderUserInputResponse): Promise<void> {
    this.assertOnline();
    const pending = this.#pendingUserInputs.get(response.providerRequestId);
    if (pending === undefined) throw new ProviderAdapterError(this.providerId, "INPUT_NOT_FOUND", "User-input request is stale or unknown", false);
    this.#pendingUserInputs.delete(response.providerRequestId);
    pending.resolve(response.answers);
  }

  public async requestUserInput(providerSessionId: string, prompt = "Which fixture path should continue?"): Promise<Record<string, unknown>> {
    this.assertOnline();
    this.requireSession(providerSessionId);
    const providerRequestId = `input_${randomUUID()}`;
    return await new Promise<Record<string, unknown>>((resolve) => {
      this.#pendingUserInputs.set(providerRequestId, { providerSessionId, resolve });
      void this.emit({
        type: "user_input.requested",
        providerSessionId,
        payload: { providerRequestId, request: { title: "Fixture input", prompt, schema: { type: "object" } } },
      });
    });
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    for (const pending of this.#pendingApprovals.values()) pending.resolve("reject");
    this.#pendingApprovals.clear();
    for (const pending of this.#pendingUserInputs.values()) pending.resolve({ cancelled: true });
    this.#pendingUserInputs.clear();
    this.#events.clear();
  }

  public setOnline(online: boolean): void {
    this.#online = online;
  }

  public setFailListing(fail: boolean): void {
    this.#failListing = fail;
  }

  public async emitDuplicateAndOutOfOrder(providerSessionId: string): Promise<void> {
    const duplicateId = `duplicate_${randomUUID()}`;
    const future = this.makeEvent({ type: "message.delta", providerSessionId, payload: { text: "second" }, eventId: `event_${this.#eventCounter + 2}` });
    const earlier = this.makeEvent({ type: "message.delta", providerSessionId, payload: { text: "first" }, eventId: duplicateId });
    await this.#events.emit(future);
    await this.#events.emit(earlier);
    await this.#events.emit(earlier);
  }

  private seed(count: number): void {
    const base = this.#now().getTime();
    for (let index = 0; index < count; index += 1) {
      const id = `fake_session_${String(index + 1).padStart(4, "0")}`;
      const createdAt = new Date(base - (count - index) * 60_000).toISOString();
      const updatedAt = new Date(base - index * 60_000).toISOString();
      this.#sessions.set(id, {
        id,
        title: `Fixture session ${index + 1}`,
        workingDirectory: `/workspaces/project-${(index % 7) + 1}`,
        state: index % 11 === 0 ? "working" : "idle",
        createdAt,
        updatedAt,
        preview: `Synthetic conversation ${index + 1}`,
        needsApproval: false,
      });
      this.#messages.set(id, [{
        id: `${this.providerId}/seed_${index}`,
        sessionId: makeGlobalSessionId(this.#hostId, this.providerId, id),
        providerMessageId: `seed_${index}`,
        role: "assistant",
        createdAt,
        completedAt: createdAt,
        parts: [{ type: "text", text: `Seed message for fixture ${index + 1}` }],
        status: "completed",
        nativeMetadata: {},
      }]);
    }
  }

  private normalizeSession(session: NativeSession): RemoteSession {
    return {
      id: makeGlobalSessionId(this.#hostId, this.providerId, session.id),
      hostId: this.#hostId,
      providerId: this.providerId,
      providerSessionId: session.id,
      title: session.title,
      ...(session.workingDirectory.split("/").filter(Boolean).at(-1) !== undefined
        ? { project: session.workingDirectory.split("/").filter(Boolean).at(-1) as string }
        : {}),
      workingDirectory: session.workingDirectory,
      state: this.#online ? session.state : "disconnected",
      createdAt: session.createdAt,
      lastActivityAt: session.updatedAt,
      preview: session.preview,
      modelId: "fake-fast",
      needsApproval: session.needsApproval,
      stale: !this.#online,
      nativeMetadata: {},
    };
  }

  private requireSession(providerSessionId: string): NativeSession {
    const session = this.#sessions.get(providerSessionId);
    if (session === undefined) throw new ProviderAdapterError(this.providerId, "SESSION_NOT_FOUND", `Unknown fake session ${providerSessionId}`, false);
    return session;
  }

  private assertOnline(): void {
    if (this.#disposed) throw new ProviderAdapterError(this.providerId, "DISPOSED", "Fake provider has been disposed", false);
    if (!this.#online) throw new ProviderAdapterError(this.providerId, "OFFLINE", "Fake provider is offline", true);
  }

  private makeEvent(input: Omit<ProviderEvent, "eventId" | "providerId" | "occurredAt"> & { readonly eventId?: string }): ProviderEvent {
    return {
      eventId: input.eventId ?? `fake_event_${++this.#eventCounter}`,
      providerId: this.providerId,
      occurredAt: this.#now().toISOString(),
      payload: input.payload,
      type: input.type,
      ...(input.providerSessionId !== undefined ? { providerSessionId: input.providerSessionId } : {}),
      ...(input.nativeEvent !== undefined ? { nativeEvent: input.nativeEvent } : {}),
      ...(input.approval !== undefined ? { approval: input.approval } : {}),
    };
  }

  private async emit(input: Omit<ProviderEvent, "eventId" | "providerId" | "occurredAt">): Promise<void> {
    await this.#events.emit(this.makeEvent(input));
  }

  private async runApprovalScenario(session: NativeSession, request: SendMessageRequest): Promise<void> {
    const providerSessionId = session.id;
    const assistantId = `assistant_${randomUUID()}`;
    await this.emit({ type: "message.started", providerSessionId, payload: { messageId: assistantId } });
    await this.emit({ type: "message.delta", providerSessionId, payload: { messageId: assistantId, text: "I inspected the repository. " } });
    await this.emit({ type: "tool.started", providerSessionId, payload: { tool: "shell", command: "npm test" } });
    await this.emit({ type: "tool.output", providerSessionId, payload: { output: "Preparing command…" } });
    await this.emit({ type: "command.started", providerSessionId, payload: { command: "npm test", cwd: session.workingDirectory } });
    await this.emit({ type: "command.output", providerSessionId, payload: { output: "Preparing command…" } });
    const providerRequestId = `approval_${randomUUID()}`;
    session.state = "needs_approval";
    session.needsApproval = true;
    const choice = await new Promise<string>((resolve) => {
      this.#pendingApprovals.set(providerRequestId, { providerSessionId, resolve });
      void this.emit({
        type: "approval.requested",
        providerSessionId,
        payload: { providerRequestId },
        approval: {
          providerRequestId,
          providerSessionId,
          title: "Run test suite",
          reason: `The fake provider needs permission to validate: ${request.content}`,
          command: "npm test",
          workingDirectory: session.workingDirectory,
          affectedFiles: [],
          networkDestinations: [],
          riskMetadata: { fixture: true },
          choices: [
            { id: "approve", label: "Approve", kind: "approve" },
            { id: "reject", label: "Reject", kind: "reject" },
          ],
        },
      });
    });
    session.needsApproval = false;
    await this.emit({ type: "approval.resolved", providerSessionId, payload: { providerRequestId, choice } });
    if (choice === "reject") {
      session.state = "idle";
      await this.emit({ type: "agent.interrupted", providerSessionId, payload: { reason: "approval rejected" } });
      return;
    }
    session.state = "working";
    await this.emit({ type: "tool.completed", providerSessionId, payload: { tool: "shell", output: "All fixture tests passed." } });
    await this.emit({ type: "command.completed", providerSessionId, payload: { command: "npm test", output: "All fixture tests passed.", exitCode: 0 } });
    await this.emit({ type: "message.delta", providerSessionId, payload: { messageId: assistantId, text: "The requested work is complete." } });
    const completedAt = this.#now().toISOString();
    this.#messages.get(providerSessionId)?.push({
      id: `${this.providerId}/${assistantId}`,
      sessionId: makeGlobalSessionId(this.#hostId, this.providerId, providerSessionId),
      providerMessageId: assistantId,
      role: "assistant",
      createdAt: completedAt,
      completedAt,
      parts: [{ type: "text", text: "I inspected the repository. The requested work is complete." }],
      status: "completed",
      nativeMetadata: {},
    });
    session.state = "completed";
    session.updatedAt = completedAt;
    await this.emit({ type: "message.completed", providerSessionId, payload: { messageId: assistantId } });
    await this.emit({ type: "agent.completed", providerSessionId, payload: {} });
  }
}
