import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  makeGlobalSessionId,
  makeProviderMessageId,
  type ContentPart,
  type JsonObject,
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
  ProviderAdapterError,
  ProviderEventHub,
  resolveCommand,
  type AgentProviderAdapter,
  type AuthStatus,
  type CreateSessionOptions,
  type JsonRpcTransport,
  type ListSessionsOptions,
  type PaginatedSessions,
  type ProviderApprovalResponse,
  type ProviderClientTooling,
  type ProviderDetection,
  type ProviderEvent,
  type ProviderEventSink,
  type ProviderUserInputResponse,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../provider_contract/src/index.js";

export interface PiHarnessPreset {
  readonly providerId: "pi" | "omp";
  readonly displayName: string;
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly supportsHostTools: boolean;
  readonly settledEvent: "agent_settled" | "agent_end";
}

export const piHarnessPresets: Readonly<Record<PiHarnessPreset["providerId"], PiHarnessPreset>> = {
  pi: {
    providerId: "pi",
    displayName: "Pi",
    command: "pi",
    commandArgs: ["--mode", "rpc"],
    supportsHostTools: false,
    settledEvent: "agent_settled",
  },
  omp: {
    providerId: "omp",
    displayName: "Oh My Pi",
    command: "omp",
    commandArgs: ["--mode", "rpc"],
    supportsHostTools: true,
    settledEvent: "agent_end",
  },
};

export interface PiRpcProviderAdapterOptions {
  readonly hostId: string;
  readonly preset: PiHarnessPreset;
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly extensionPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly transportFactory?: (cwd: string, args: readonly string[]) => JsonRpcTransport;
}

interface PendingCommand {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

class PiRpcClient {
  readonly #pending = new Map<string, PendingCommand>();
  readonly #unsubscribe: () => void;
  #counter = 0;
  #closed = false;

  public constructor(
    private readonly transport: JsonRpcTransport,
    private readonly onFrame: (frame: Record<string, unknown>) => void | Promise<void>,
    private readonly onFrameError: (error: Error) => void,
    private readonly timeoutMs: number,
    private readonly idPrefix: string,
  ) {
    this.#unsubscribe = transport.onMessage((message) => {
      void this.handle(message).catch((error: unknown) => {
        try {
          this.onFrameError(asError(error));
        } catch (sinkError) {
          process.emitWarning(asError(sinkError), { code: "TETHOQ_PI_RPC_ERROR_SINK_FAILED" });
        }
      });
    });
  }

  public async request<T>(type: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) throw new Error("Pi RPC process is closed");
    const id = `${this.idPrefix}_${++this.#counter}_${randomUUID()}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC command timed out: ${type}`));
      }, this.timeoutMs);
      this.#pending.set(id, { timer, resolve, reject });
    });
    try {
      await this.transport.send({ id, type, ...fields });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) clearTimeout(pending.timer);
      this.#pending.delete(id);
      throw error;
    }
    return await result as T;
  }

  public async send(frame: Record<string, unknown>): Promise<void> {
    await this.transport.send(frame);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi RPC process closed"));
    }
    this.#pending.clear();
    await this.transport.close();
  }

  private async handle(value: unknown): Promise<void> {
    if (!isRecord(value)) return;
    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.#pending.get(value.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(value.id);
      if (value.success === false) pending.reject(new Error(typeof value.error === "string" ? value.error : `Pi RPC ${String(value.command)} failed`));
      else pending.resolve(value.data);
      return;
    }
    await this.onFrame(value);
  }
}

interface PiRuntime {
  providerSessionId: string;
  readonly client: PiRpcClient;
  readonly cwd: string;
  title: string;
  state: SessionState;
  lastActivityAt: string;
  modelId?: string;
  reasoningEffort?: string;
  lastFrameError?: string;
}

interface PendingInteraction {
  readonly runtime: PiRuntime;
  readonly wireId: string;
  readonly kind: "confirm" | "value";
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
  userInput: true,
  interrupt: true,
  modelEnumeration: true,
  projectAssociation: true,
  sessionRelationships: false,
  messageEditing: false,
  remoteConnectivity: "local",
  notes: [
    "Uses the documented JSONL RPC mode and keeps model credentials inside the installed harness.",
    "Session enumeration is limited to RPC processes opened by this Tethoq runtime; no undocumented session database is read.",
  ],
};

export class PiRpcProviderAdapter implements AgentProviderAdapter {
  public readonly providerId: string;
  public readonly displayName: string;
  public readonly sessionCreationFeatures = {
    hiddenDeveloperInstructions: false,
    ephemeralSessions: true,
    selectableClientTools: true,
  } as const;
  readonly #hostId: string;
  readonly #preset: PiHarnessPreset;
  readonly #command: string;
  readonly #commandArgs: readonly string[];
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #transportFactory: ((cwd: string, args: readonly string[]) => JsonRpcTransport) | undefined;
  readonly #extensionPath: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #events = new ProviderEventHub();
  readonly #runtimes = new Map<string, PiRuntime>();
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  #eventCounter = 0;
  #clientTooling: ProviderClientTooling | undefined;

  public constructor(options: PiRpcProviderAdapterOptions) {
    this.providerId = options.preset.providerId;
    this.displayName = options.preset.displayName;
    this.#hostId = options.hostId;
    this.#preset = options.preset;
    this.#command = options.command ?? options.preset.command;
    this.#commandArgs = options.commandArgs ?? options.preset.commandArgs;
    this.#timeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#now = options.now ?? (() => new Date());
    this.#transportFactory = options.transportFactory;
    this.#extensionPath = options.extensionPath;
    this.#environment = options.environment ?? process.env;
  }

  public configureClientTooling(tooling: ProviderClientTooling): void {
    this.#clientTooling = tooling;
  }

  public async detect(): Promise<ProviderDetection> {
    if (this.#transportFactory !== undefined) return { providerId: this.providerId, available: true, version: "injected-transport", details: ["Transport supplied by caller."] };
    return await new Promise((resolve) => {
      const resolved = resolveCommand(this.#command);
      const launch = buildSpawnCommand(resolved, ["--version"]);
      execFile(launch.command, [...launch.args], {
        timeout: 5_000,
        windowsHide: true,
        env: this.#environment,
        ...(launch.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      }, (error, stdout, stderr) => {
        if (error !== null) {
          resolve({ providerId: this.providerId, available: false, executable: this.#command, details: [`${error.message} (resolved ${resolved.file})`] });
          return;
        }
        const version = `${stdout}${stderr}`.trim().split(/\r?\n/u)[0];
        resolve({ providerId: this.providerId, available: true, executable: resolved.file, ...(version ? { version } : {}), details: ["Documented RPC mode is available."] });
      });
    });
  }

  public async getAuthStatus(): Promise<AuthStatus> {
    return { authenticated: null, method: "host-managed", canAuthenticate: false, details: [`${this.displayName} manages model credentials on this host.`] };
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      ...capabilities,
      notes: [...capabilities.notes, this.#preset.supportsHostTools
        ? "This harness exposes Tethoq browser, visual-support, and mesh tools through its documented host-tool RPC surface."
        : "Tethoq tool exposure is version-gated to the harness extension surface."],
    };
  }

  public async listModels(): Promise<readonly RemoteModel[]> {
    const runtime = await this.startRuntime({ workingDirectory: process.cwd(), ephemeral: true }, false);
    try {
      const data = await runtime.client.request<unknown>("get_available_models");
      const models = isRecord(data) && Array.isArray(data.models) ? data.models : Array.isArray(data) ? data : [];
      return models.flatMap((value): readonly RemoteModel[] => {
        if (!isRecord(value) || typeof value.id !== "string") return [];
        const nativeProvider = typeof value.provider === "string" ? value.provider : undefined;
        const id = nativeProvider === undefined ? value.id : `${nativeProvider}/${value.id}`;
        const input = Array.isArray(value.input)
          ? value.input.filter((entry): entry is "text" | "image" | "audio" => entry === "text" || entry === "image" || entry === "audio")
          : undefined;
        return [{
          id,
          providerId: this.providerId,
          displayName: typeof value.name === "string" ? value.name : value.id,
          isDefault: runtime.modelId === id,
          ...(input !== undefined && input.length > 0 ? { inputModalities: input } : {}),
          nativeMetadata: jsonObject(value),
        }];
      });
    } finally {
      await this.releaseRuntime(runtime);
    }
  }

  public async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const sessions = await Promise.all([...this.#runtimes.values()]
      .filter((runtime) => options.workingDirectory === undefined || runtime.cwd === options.workingDirectory)
      .map((runtime) => this.sessionFromRuntime(runtime)));
    sessions.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
    const offset = options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Pi session cursor is invalid");
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const page = sessions.slice(offset, offset + limit);
    return { sessions: page, nextCursor: offset + page.length < sessions.length ? String(offset + page.length) : null };
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    const runtime = this.runtime(providerSessionId);
    await this.refreshState(runtime);
    return await this.sessionFromRuntime(runtime);
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const runtime = this.runtime(providerSessionId);
    const data = await runtime.client.request<unknown>("get_messages");
    const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
    return messages.map((message, index) => normalizePiMessage(this.#hostId, this.providerId, providerSessionId, message, index, this.#now()));
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    const runtime = await this.startRuntime(options, true);
    if (options.reasoningEffort !== undefined) {
      await runtime.client.request("set_thinking_level", { level: options.reasoningEffort });
      runtime.reasoningEffort = options.reasoningEffort;
    }
    if (options.firstInstruction !== undefined) {
      await this.sendMessage(runtime.providerSessionId, {
        requestId: `create_${randomUUID()}`,
        content: options.firstInstruction,
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });
    }
    return await this.sessionFromRuntime(runtime);
  }

  public async resumeSession(providerSessionId: string): Promise<void> {
    await this.refreshState(this.runtime(providerSessionId));
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const runtime = this.runtime(providerSessionId);
    await this.applyModelOptions(runtime, request);
    await runtime.client.request("prompt", {
      message: request.content,
      ...(request.attachments?.length ? { images: request.attachments.map((attachment) => ({ type: "image", data: attachment.dataBase64, mimeType: attachment.mimeType })) } : {}),
    });
    return { accepted: true, details: [`${this.displayName} accepted the RPC prompt.`] };
  }

  public async steerMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const runtime = this.runtime(providerSessionId);
    await runtime.client.request("steer", {
      message: request.content,
      ...(request.attachments?.length ? { images: request.attachments.map((attachment) => ({ type: "image", data: attachment.dataBase64, mimeType: attachment.mimeType })) } : {}),
    });
    return { accepted: true, details: [`${this.displayName} queued the steering message.`] };
  }

  public async interrupt(providerSessionId: string): Promise<void> {
    await this.runtime(providerSessionId).client.request("abort");
  }

  public async getSessionContext(providerSessionId: string): Promise<Omit<SessionContextState, "sessionId" | "compactionThresholdTokens" | "minimumThresholdTokens" | "supportsThreshold" | "isCompacting">> {
    const runtime = this.runtime(providerSessionId);
    const data = await runtime.client.request<unknown>("get_session_stats");
    const stats = isRecord(data) ? data : {};
    const tokens = isRecord(stats.tokens) ? stats.tokens : {};
    const context = isRecord(stats.contextUsage) ? stats.contextUsage : {};
    const input = finite(tokens.input);
    const output = finite(tokens.output);
    const cacheRead = finite(tokens.cacheRead);
    const cacheWrite = finite(tokens.cacheWrite);
    const cost = finite(stats.cost);
    const used = nullableFinite(context.tokens);
    const window = nullableFinite(context.contextWindow);
    const percent = nullableFinite(context.percent);
    return {
      ...(runtime.modelId !== undefined ? { modelId: runtime.modelId } : {}),
      usedTokens: used,
      contextWindowTokens: window,
      usedPercent: percent,
      supportsManualCompaction: true,
      updatedAt: this.#now().toISOString(),
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        totalTokens: finite(tokens.total) || input + output + cacheRead + cacheWrite,
        cost,
        currency: "USD",
      },
    };
  }

  public async compactSession(providerSessionId: string): Promise<void> {
    await this.runtime(providerSessionId).client.request("compact");
  }

  public async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    return this.#events.subscribe(providerSessionId, sink);
  }

  public async respondToApproval(response: ProviderApprovalResponse): Promise<void> {
    const pending = this.#pendingInteractions.get(response.providerRequestId);
    if (pending === undefined || pending.kind !== "confirm") throw new Error("Pi confirmation is stale or unknown");
    this.#pendingInteractions.delete(response.providerRequestId);
    await pending.runtime.client.send({ type: "extension_ui_response", id: pending.wireId, confirmed: response.choiceId === "approve" });
  }

  public async respondToUserInput(response: ProviderUserInputResponse): Promise<void> {
    const pending = this.#pendingInteractions.get(response.providerRequestId);
    if (pending === undefined || pending.kind !== "value") throw new Error("Pi input request is stale or unknown");
    this.#pendingInteractions.delete(response.providerRequestId);
    const value = firstAnswer(response.answers);
    await pending.runtime.client.send({ type: "extension_ui_response", id: pending.wireId, ...(value === undefined ? { cancelled: true } : { value }) });
  }

  public async dispose(): Promise<void> {
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    this.#pendingInteractions.clear();
    this.#events.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.client.close()));
  }

  private async startRuntime(options: Pick<CreateSessionOptions, "workingDirectory" | "title" | "modelId" | "ephemeral" | "clientTools">, retain: boolean): Promise<PiRuntime> {
    const args = [
      ...this.#commandArgs,
      ...(options.title !== undefined ? ["--name", options.title] : []),
      ...(options.modelId !== undefined ? ["--model", options.modelId] : []),
      ...(options.ephemeral === true ? ["--no-session"] : []),
      ...(this.#preset.providerId === "pi" && this.#extensionPath !== undefined && options.clientTools !== "none" ? ["--extension", this.#extensionPath] : []),
    ];
    let runtime!: PiRuntime;
    const transport = this.#transportFactory?.(options.workingDirectory, args) ?? new JsonLineProcessTransport({
      command: this.#command,
      args,
      cwd: options.workingDirectory,
      env: this.#environment,
    });
    const client = new PiRpcClient(
      transport,
      (frame) => this.handleFrame(runtime, frame),
      (error) => this.handleFrameError(runtime, error),
      this.#timeoutMs,
      this.providerId,
    );
    runtime = {
      providerSessionId: `starting_${randomUUID()}`,
      client,
      cwd: options.workingDirectory,
      title: options.title ?? `${this.displayName} session`,
      state: "idle",
      lastActivityAt: this.#now().toISOString(),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
    };
    try {
      await this.refreshState(runtime);
      if (retain) {
        const existing = this.#runtimes.get(runtime.providerSessionId);
        if (existing !== undefined) await existing.client.close();
        this.#runtimes.set(runtime.providerSessionId, runtime);
        await this.configureHostTools(runtime);
      }
      return runtime;
    } catch (error) {
      await client.close();
      throw new ProviderAdapterError(this.providerId, "RPC_INITIALIZE_FAILED", `${this.displayName} RPC initialization failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private async releaseRuntime(runtime: PiRuntime): Promise<void> {
    if (this.#runtimes.get(runtime.providerSessionId) === runtime) this.#runtimes.delete(runtime.providerSessionId);
    await runtime.client.close();
  }

  private async refreshState(runtime: PiRuntime): Promise<void> {
    const data = await runtime.client.request<unknown>("get_state");
    const state = isRecord(data) ? data : {};
    if (typeof state.sessionId === "string" && state.sessionId.length > 0) runtime.providerSessionId = state.sessionId;
    if (typeof state.sessionName === "string" && state.sessionName.trim()) runtime.title = state.sessionName;
    runtime.state = state.isStreaming === true ? "working" : "idle";
    const model = isRecord(state.model) ? state.model : {};
    if (typeof model.id === "string") runtime.modelId = typeof model.provider === "string" ? `${model.provider}/${model.id}` : model.id;
    if (typeof state.thinkingLevel === "string") runtime.reasoningEffort = state.thinkingLevel;
    runtime.lastActivityAt = this.#now().toISOString();
  }

  private async configureHostTools(runtime: PiRuntime): Promise<void> {
    if (!this.#preset.supportsHostTools || this.#clientTooling === undefined) return;
    await runtime.client.request("set_host_tools", {
      tools: this.#clientTooling.definitions.map((tool) => ({
        name: tool.name,
        label: tool.name.replaceAll("_", " "),
        description: tool.description,
        parameters: tool.inputSchema,
      })),
    });
  }

  private async applyModelOptions(runtime: PiRuntime, request: SendMessageRequest): Promise<void> {
    if (request.modelId !== undefined && request.modelId !== runtime.modelId) {
      const slash = request.modelId.indexOf("/");
      if (slash <= 0 || slash === request.modelId.length - 1) throw new Error("Pi model IDs must use provider/model format");
      await runtime.client.request("set_model", { provider: request.modelId.slice(0, slash), modelId: request.modelId.slice(slash + 1) });
      runtime.modelId = request.modelId;
    }
    if (request.reasoningEffort !== undefined && request.reasoningEffort !== runtime.reasoningEffort) {
      await runtime.client.request("set_thinking_level", { level: request.reasoningEffort });
      runtime.reasoningEffort = request.reasoningEffort;
    }
  }

  private runtime(providerSessionId: string): PiRuntime {
    const runtime = this.#runtimes.get(providerSessionId);
    if (runtime === undefined) throw new ProviderAdapterError(this.providerId, "SESSION_NOT_OPEN", `${this.displayName} session is not open in this Tethoq runtime`, false);
    return runtime;
  }

  private async sessionFromRuntime(runtime: PiRuntime): Promise<RemoteSession> {
    return {
      id: makeGlobalSessionId(this.#hostId, this.providerId, runtime.providerSessionId),
      hostId: this.#hostId,
      providerId: this.providerId,
      providerSessionId: runtime.providerSessionId,
      title: runtime.title,
      workingDirectory: runtime.cwd,
      project: basename(runtime.cwd) || runtime.cwd,
      state: runtime.state,
      lastActivityAt: runtime.lastActivityAt,
      preview: runtime.title,
      ...(runtime.modelId !== undefined ? { modelId: runtime.modelId } : {}),
      ...(runtime.reasoningEffort !== undefined ? { reasoningEffort: runtime.reasoningEffort } : {}),
      needsApproval: runtime.state === "needs_approval",
      stale: false,
      nativeMetadata: runtime.lastFrameError === undefined ? {} : { asyncFrameError: runtime.lastFrameError },
    };
  }

  private async handleFrame(runtime: PiRuntime, frame: Record<string, unknown>): Promise<void> {
    const type = typeof frame.type === "string" ? frame.type : "unknown";
    runtime.lastActivityAt = this.#now().toISOString();
    if (type === "ready" || type === "available_commands_update" || type === "queue_update") return;
    if (type === "host_tool_call") return await this.handleHostTool(runtime, frame);
    if (type === "extension_ui_request") return await this.handleUiRequest(runtime, frame);
    if (type === "agent_start" || type === "turn_start") runtime.state = "working";
    if (type === "agent_start") return await this.emit(runtime, "message.started", {});
    if (type === this.#preset.settledEvent && (type !== "agent_end" || frame.isTerminal !== false)) {
      runtime.state = "completed";
      return await this.emit(runtime, "agent.completed", {});
    }
    if (type === "message_start") return await this.emit(runtime, "message.started", jsonObject(frame));
    if (type === "message_update") {
      const update = isRecord(frame.assistantMessageEvent) ? frame.assistantMessageEvent : {};
      const delta = typeof update.delta === "string" ? update.delta : "";
      const partType = typeof update.type === "string" && update.type.startsWith("thinking") ? "reasoning" : "text";
      if (delta.length > 0) await this.emit(runtime, "message.delta", { text: delta, partType });
      return;
    }
    if (type === "message_end") return await this.emit(runtime, "message.completed", jsonObject(frame));
    if (type.startsWith("tool_execution_")) {
      const toolName = typeof frame.toolName === "string" ? frame.toolName : isRecord(frame.toolCall) && typeof frame.toolCall.name === "string" ? frame.toolCall.name : "tool";
      const phase = type.endsWith("start") ? "started" : type.endsWith("end") ? "completed" : "output";
      const eventType = toolName === "bash" ? `command.${phase}` : `tool.${phase}`;
      return await this.emit(runtime, eventType as ProviderEvent["type"], jsonObject(frame));
    }
    if (type.includes("compaction")) return await this.emit(runtime, "session.updated", { contextCompaction: type });
    if (type === "extension_error") return await this.emit(runtime, "agent.error", jsonObject(frame));
  }

  private handleFrameError(runtime: PiRuntime, error: Error): void {
    runtime.state = "failed";
    runtime.lastActivityAt = this.#now().toISOString();
    runtime.lastFrameError = error.message;
    void this.emit(runtime, "agent.error", { message: error.message, source: "rpc_frame" }).catch((sinkError: unknown) => {
      runtime.lastFrameError = `${error.message} (error reporting failed: ${asError(sinkError).message})`;
    });
  }

  private async handleHostTool(runtime: PiRuntime, frame: Record<string, unknown>): Promise<void> {
    if (typeof frame.id !== "string" || typeof frame.toolName !== "string") return;
    if (this.#clientTooling === undefined) {
      await runtime.client.send({ type: "host_tool_result", id: frame.id, isError: true, result: { content: [{ type: "text", text: "Tethoq client tools are unavailable" }] } });
      return;
    }
    try {
      const input = isRecord(frame.arguments) ? jsonObject(frame.arguments) : {};
      const result = await this.#clientTooling.execute(this.providerId, runtime.providerSessionId, frame.toolName, input);
      await runtime.client.send({ type: "host_tool_result", id: frame.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      await runtime.client.send({ type: "host_tool_result", id: frame.id, isError: true, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } });
    }
  }

  private async handleUiRequest(runtime: PiRuntime, frame: Record<string, unknown>): Promise<void> {
    if (typeof frame.id !== "string" || typeof frame.method !== "string") return;
    if (!["confirm", "select", "input", "editor"].includes(frame.method)) return;
    const providerRequestId = `${this.providerId}_ui_${frame.id}`;
    if (frame.method === "confirm") {
      this.#pendingInteractions.set(providerRequestId, { runtime, wireId: frame.id, kind: "confirm" });
      runtime.state = "needs_approval";
      await this.emit(runtime, "approval.requested", { providerRequestId, request: jsonObject(frame) }, {
        providerRequestId,
        providerSessionId: runtime.providerSessionId,
        title: typeof frame.title === "string" ? frame.title : `${this.displayName} confirmation`,
        ...(typeof frame.message === "string" ? { reason: frame.message } : {}),
        affectedFiles: [],
        networkDestinations: [],
        choices: [{ id: "approve", label: "Continue", kind: "approve" }, { id: "reject", label: "Cancel", kind: "reject" }],
        riskMetadata: jsonObject(frame),
      });
      return;
    }
    this.#pendingInteractions.set(providerRequestId, { runtime, wireId: frame.id, kind: "value" });
    runtime.state = "needs_input";
    await this.emit(runtime, "user_input.requested", {
      providerRequestId,
      title: typeof frame.title === "string" ? frame.title : `${this.displayName} input`,
      prompt: typeof frame.message === "string" ? frame.message : typeof frame.placeholder === "string" ? frame.placeholder : "Enter a value",
      request: jsonObject(frame),
    });
  }

  private async emit(runtime: PiRuntime, type: ProviderEvent["type"], payload: JsonObject, approval?: ProviderEvent["approval"]): Promise<void> {
    await this.#events.emit({
      eventId: `${this.providerId}_event_${++this.#eventCounter}`,
      providerId: this.providerId,
      providerSessionId: runtime.providerSessionId,
      type,
      occurredAt: this.#now().toISOString(),
      payload,
      ...(approval !== undefined ? { approval } : {}),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function jsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nullableFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function firstAnswer(answers: JsonObject): string | undefined {
  for (const value of Object.values(answers)) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const text = value.find((entry): entry is string => typeof entry === "string");
      if (text !== undefined) return text;
    }
    if (isRecord(value) && Array.isArray(value.answers)) {
      const text = value.answers.find((entry): entry is string => typeof entry === "string");
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function normalizePiMessage(hostId: string, providerId: string, providerSessionId: string, value: unknown, index: number, now: Date): RemoteMessage {
  const message = isRecord(value) ? value : {};
  const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "tool";
  const parts = piContentParts(message.content, role);
  const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : now.toISOString();
  const providerMessageId = typeof message.id === "string" ? message.id : `${role}_${message.timestamp ?? index}_${index}`;
  return {
    id: makeProviderMessageId(providerId, providerMessageId),
    sessionId: makeGlobalSessionId(hostId, providerId, providerSessionId),
    providerMessageId,
    role,
    createdAt: timestamp,
    completedAt: timestamp,
    parts,
    status: message.stopReason === "error" || message.isError === true ? "failed" : "completed",
    nativeMetadata: jsonObject(message),
  };
}

function piContentParts(content: unknown, role: "user" | "assistant" | "tool"): readonly ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry): readonly ContentPart[] => {
    if (!isRecord(entry)) return [];
    if (entry.type === "text" && typeof entry.text === "string") return [{ type: "text", text: entry.text }];
    if (entry.type === "thinking" && typeof entry.thinking === "string") return [{ type: "reasoning", text: entry.thinking, redacted: false }];
    if (entry.type === "image") return [{ type: "image", ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}) }];
    if (entry.type === "toolCall") return [{ type: "tool", name: typeof entry.name === "string" ? entry.name : "tool", ...(typeof entry.id === "string" ? { callId: entry.id } : {}), ...(isRecord(entry.arguments) ? { input: jsonObject(entry.arguments) } : {}), status: "completed" }];
    if (role === "tool" && typeof entry.text === "string") return [{ type: "tool", name: "tool", output: entry.text, status: "completed" }];
    return [];
  });
}
