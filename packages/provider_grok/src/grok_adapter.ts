import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type ProviderCapabilities,
  type RemoteMessage,
  type RemoteModel,
  type RemoteSession,
  type SessionTokenUsage,
} from "../../protocol/src/index.js";
import {
  JsonLineProcessTransport,
  JsonRpcPeer,
  ProviderAdapterError,
  ProviderEventHub,
  UnsupportedProviderCapabilityError,
  buildSpawnCommand,
  resolveCommand,
  type AgentProviderAdapter,
  type AuthRequest,
  type AuthResult,
  type AuthStatus,
  type CreateSessionOptions,
  type JsonRpcTransport,
  type ListSessionsOptions,
  type PaginatedSessions,
  type ProviderApprovalResponse,
  type ProviderDetection,
  type ProviderClientTooling,
  type ProviderEvent,
  type ProviderEventSink,
  type RpcId,
  type SessionMcpBinding,
  type SessionMcpServer,
  type SendMessageRequest,
  type SendMessageResult,
  type Subscription,
} from "../../provider_contract/src/index.js";
import {
  appendAcpContentChunk,
  appendAcpSubagentPart,
  acpSubagentChildSessionId,
  asJsonObject,
  completeAcpMessages,
  createMessageAccumulator,
  isRecord,
  normalizeAcpSubagentUpdate,
  normalizeAcpSession,
  type AcpProviderIdentity,
  type AcpMessageAccumulator,
} from "./normalize.js";

interface AcpInitializeResponse {
  readonly protocolVersion?: number;
  readonly agentCapabilities?: unknown;
  readonly authMethods?: unknown;
  readonly agentInfo?: unknown;
  readonly _meta?: unknown;
}

interface PendingPermission {
  readonly providerSessionId: string;
  readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind?: string }[];
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface SessionContext {
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
}

interface ReportedSessionContext {
  readonly modelId?: string;
  readonly usedTokens?: number;
  readonly contextWindowTokens?: number;
  readonly usedPercent?: number;
  readonly usage: SessionTokenUsage;
  readonly updatedAt: string;
}

interface AcpSessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly currentValue?: string;
  readonly values: readonly string[];
}

interface AppliedSessionSelections {
  readonly modelId?: string;
  readonly reasoningEffort?: string;
}

export interface AcpRuntimeOptions {
  readonly hostId: string;
  readonly cwd?: string;
  readonly transportFactory?: () => JsonRpcTransport;
  readonly requestTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface AcpProviderAdapterOptions extends AcpRuntimeOptions {
  readonly providerId: string;
  readonly displayName: string;
  readonly sessionLabel?: string;
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly capabilityNote?: string;
}

export interface GrokAdapterOptions extends AcpRuntimeOptions {
  readonly command?: string;
  readonly commandArgs?: readonly string[];
}

export interface PublicAcpAdapterOptions extends AcpRuntimeOptions {
  readonly command?: string;
  readonly commandArgs?: readonly string[];
}

export interface AcpProviderPreset {
  readonly providerId: string;
  readonly displayName: string;
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly capabilityNote: string;
}

export const PUBLIC_ACP_PROVIDER_PRESETS = {
  qwen: {
    providerId: "qwen",
    displayName: "Qwen Code",
    command: "qwen",
    commandArgs: ["--acp"],
    capabilityNote: "Uses the documented Agent Client Protocol mode exposed by Qwen Code.",
  },
  goose: {
    providerId: "goose",
    displayName: "Goose",
    command: "goose",
    commandArgs: ["acp"],
    capabilityNote: "Uses the documented Agent Client Protocol mode exposed by Goose.",
  },
  kimi: {
    providerId: "kimi",
    displayName: "Kimi Code",
    command: "kimi",
    commandArgs: ["acp"],
    capabilityNote: "Uses the documented Agent Client Protocol mode exposed by Kimi Code.",
  },
  hermes: {
    providerId: "hermes",
    displayName: "Hermes Agent",
    command: "hermes",
    commandArgs: ["acp"],
    capabilityNote: "Uses the documented Agent Client Protocol mode exposed by Hermes Agent.",
  },
  cline: {
    providerId: "cline",
    displayName: "Cline",
    command: "cline",
    commandArgs: ["--acp"],
    capabilityNote: "Uses the documented Agent Client Protocol mode exposed by Cline.",
  },
  copilot: {
    providerId: "copilot",
    displayName: "GitHub Copilot CLI",
    command: "copilot",
    commandArgs: ["--acp", "--stdio"],
    capabilityNote: "Uses the documented Agent Client Protocol mode exposed by GitHub Copilot CLI.",
  },
} as const satisfies Record<string, AcpProviderPreset>;

export type PublicAcpProviderId = keyof typeof PUBLIC_ACP_PROVIDER_PRESETS;

function execute(command: string, args: readonly string[], timeoutMs = 5_000): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const resolved = resolveCommand(command);
  const launch = buildSpawnCommand(resolved, args);
  return new Promise((resolve, reject) => {
    execFile(launch.command, [...launch.args], {
      timeout: timeoutMs,
      windowsHide: true,
      ...(launch.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    }, (error, stdout, stderr) => {
      if (error !== null) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function boolCapability(source: unknown, path: readonly string[]): boolean {
  let current: unknown = source;
  for (const segment of path) {
    if (!isRecord(current)) return false;
    current = current[segment];
  }
  return current === true || isRecord(current);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function historyMessageId(
  role: "user" | "assistant",
  params: Record<string, unknown>,
  update: Record<string, unknown>,
): string | undefined {
  const paramsMeta = isRecord(params._meta) ? params._meta : {};
  const updateMeta = isRecord(update._meta) ? update._meta : {};
  if (role === "assistant") {
    const promptId = [paramsMeta.promptId, paramsMeta.prompt_id, updateMeta.promptId, updateMeta.prompt_id]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    return promptId === undefined ? undefined : `assistant_prompt_${promptId}`;
  }
  const promptIndex = updateMeta.promptIndex ?? updateMeta.prompt_index ?? paramsMeta.promptIndex ?? paramsMeta.prompt_index;
  if ((typeof promptIndex === "number" && Number.isSafeInteger(promptIndex))
    || (typeof promptIndex === "string" && promptIndex.length > 0)) {
    return `user_prompt_${promptIndex}`;
  }
  return undefined;
}

type InputModality = "text" | "image" | "audio";

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = finiteNonNegative(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = finiteNonNegative(source[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function firstPositiveInteger(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = positiveInteger(source[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function normalizeModality(value: unknown): InputModality | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "text" || normalized.startsWith("text/")) return "text";
  if (normalized === "image" || normalized === "images" || normalized.startsWith("image/")) return "image";
  if (normalized === "audio" || normalized.startsWith("audio/")) return "audio";
  return undefined;
}

function modalitiesFrom(value: unknown): readonly InputModality[] {
  if (!Array.isArray(value)) return [];
  const result: InputModality[] = [];
  for (const entry of value) {
    const modality = normalizeModality(entry);
    if (modality !== undefined && !result.includes(modality)) result.push(modality);
  }
  return result;
}

function advertisedPromptModalities(capabilities: unknown): readonly InputModality[] | undefined {
  if (!isRecord(capabilities)) return undefined;
  const prompt = isRecord(capabilities.promptCapabilities)
    ? capabilities.promptCapabilities
    : isRecord(capabilities.prompt_capabilities)
      ? capabilities.prompt_capabilities
      : undefined;
  if (prompt === undefined) return undefined;
  const explicit = modalitiesFrom(prompt.inputModalities ?? prompt.input_modalities ?? prompt.modalities);
  if (explicit.length > 0) return explicit;
  const advertised: InputModality[] = ["text"];
  if (prompt.image === true || prompt.images === true || prompt.imageInput === true || prompt.image_input === true) advertised.push("image");
  if (prompt.audio === true || prompt.audioInput === true || prompt.audio_input === true) advertised.push("audio");
  return advertised.length > 1 ? advertised : undefined;
}

function modelInputModalities(entry: Record<string, unknown>, fallback: readonly InputModality[] | undefined): readonly InputModality[] | undefined {
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : {};
  const modalityObject = isRecord(entry.modalities) ? entry.modalities : {};
  const explicitCandidates = [
    entry.inputModalities,
    entry.input_modalities,
    entry.supportedInputModalities,
    entry.supported_input_modalities,
    entry.input,
    Array.isArray(entry.modalities) ? entry.modalities : undefined,
    modalityObject.input,
    capabilities.inputModalities,
    capabilities.input_modalities,
    capabilities.input,
  ];
  for (const candidate of explicitCandidates) {
    const modalities = modalitiesFrom(candidate);
    if (modalities.length > 0) return modalities;
  }
  const supportsImage = entry.supportsImages === true
    || entry.supportsImageInput === true
    || entry.supportsVision === true
    || entry.imageInput === true
    || entry.vision === true
    || capabilities.image === true
    || capabilities.images === true
    || capabilities.imageInput === true
    || capabilities.vision === true;
  const supportsAudio = entry.supportsAudio === true
    || entry.supportsAudioInput === true
    || entry.audioInput === true
    || capabilities.audio === true
    || capabilities.audioInput === true;
  if (supportsImage || supportsAudio) return ["text", ...(supportsImage ? ["image" as const] : []), ...(supportsAudio ? ["audio" as const] : [])];
  return fallback;
}

function modelContextWindow(entry: Record<string, unknown>): number | undefined {
  const limits = isRecord(entry.limits) ? entry.limits : {};
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : {};
  return firstPositiveInteger(entry, ["contextWindowTokens", "context_window_tokens", "contextWindow", "context_window", "maxContextTokens", "max_context_tokens", "maxInputTokens", "max_input_tokens"])
    ?? firstPositiveInteger(limits, ["context", "contextTokens", "context_tokens", "contextWindow", "context_window", "input", "inputTokens", "input_tokens"])
    ?? firstPositiveInteger(capabilities, ["contextWindowTokens", "context_window_tokens", "contextWindow", "context_window", "maxInputTokens", "max_input_tokens"]);
}

function modelState(response: AcpInitializeResponse): Record<string, unknown> | undefined {
  const meta = isRecord(response._meta) ? response._meta : undefined;
  if (meta === undefined) return undefined;
  return isRecord(meta.model_state)
    ? meta.model_state
    : isRecord(meta.modelState)
      ? meta.modelState
      : Array.isArray(meta.models)
        ? meta
        : undefined;
}

function currentModelId(response: AcpInitializeResponse): string | undefined {
  const state = modelState(response);
  if (state === undefined) return undefined;
  return [state.currentModelId, state.current_model_id, state.modelId, state.model_id]
    .find((value): value is string => typeof value === "string" && value.length > 0);
}

function modelEntries(response: AcpInitializeResponse, providerId: string): readonly RemoteModel[] {
  const state = modelState(response);
  if (state === undefined) return [];
  const current = currentModelId(response);
  const fallbackModalities = advertisedPromptModalities(response.agentCapabilities);
  const source = Array.isArray(state.availableModels)
    ? state.availableModels
    : Array.isArray(state.available_models)
      ? state.available_models
      : Array.isArray(state.models)
        ? state.models
        : [];
  return source.flatMap((entry): readonly RemoteModel[] => {
    if (typeof entry === "string") return [{
      id: entry,
      providerId,
      displayName: entry,
      isDefault: entry === current,
      ...(fallbackModalities !== undefined ? { inputModalities: fallbackModalities } : {}),
      nativeMetadata: {},
    }];
    if (!isRecord(entry)) return [];
    const id = [entry.id, entry.modelId, entry.model_id].find((value): value is string => typeof value === "string");
    if (id === undefined) return [];
    const inputModalities = modelInputModalities(entry, fallbackModalities);
    return [{
      id,
      providerId,
      displayName: typeof entry.name === "string" ? entry.name : id,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      isDefault: id === current || entry.default === true,
      ...(inputModalities !== undefined ? { inputModalities } : {}),
      nativeMetadata: asJsonObject(entry),
    }];
  });
}

interface ParsedReportedContext {
  readonly modelId?: string;
  readonly usedTokens?: number;
  readonly contextWindowTokens?: number;
  readonly usedPercent?: number;
  readonly usage?: SessionTokenUsage;
}

function firstStringValue(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function childRecord(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) return value;
  }
  return undefined;
}

function usageFromRecord(source: Record<string, unknown>): SessionTokenUsage | undefined {
  const inputTokens = firstNumber(source, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "input"]);
  const outputTokens = firstNumber(source, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens", "output"]);
  const cacheReadTokens = firstNumber(source, ["cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens"]);
  const cacheWriteTokens = firstNumber(source, ["cacheWriteTokens", "cache_write_tokens"]);
  const totalTokens = firstNumber(source, ["totalTokens", "total_tokens", "tokens"]);
  const costRecord = isRecord(source.cost) ? source.cost : undefined;
  const cost = firstNumber(source, ["cost", "totalCost", "total_cost"])
    ?? (costRecord === undefined ? undefined : firstNumber(costRecord, ["amount", "value", "total"]));
  const currency = firstStringValue(source, ["currency", "currencyCode", "currency_code"])
    ?? (costRecord === undefined ? undefined : firstStringValue(costRecord, ["currency", "currencyCode", "currency_code"]));
  if (inputTokens === undefined
    && outputTokens === undefined
    && cacheReadTokens === undefined
    && cacheWriteTokens === undefined
    && totalTokens === undefined
    && cost === undefined
    && currency === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
}

function parseReportedContext(value: unknown): ParsedReportedContext | null {
  if (!isRecord(value)) return null;
  const meta = isRecord(value._meta) ? value._meta : undefined;
  const roots = meta === undefined ? [value] : [value, meta];
  let usage: SessionTokenUsage | undefined;
  let context: Record<string, unknown> | undefined;
  for (const root of roots) {
    const usageRecord = childRecord(root, [
      "sessionUsage",
      "session_usage",
      "cumulativeUsage",
      "cumulative_usage",
      "totalUsage",
      "total_usage",
      "tokenUsage",
      "token_usage",
      "usage",
    ]);
    if (usage === undefined && usageRecord !== undefined) usage = usageFromRecord(usageRecord);
    context ??= childRecord(root, ["contextUsage", "context_usage", "context", "contextState", "context_state"])
      ?? (usageRecord === undefined ? undefined : childRecord(usageRecord, ["contextUsage", "context_usage", "context"]));
  }
  const directUsageKeys = [
    "inputTokens", "input_tokens", "promptTokens", "prompt_tokens",
    "outputTokens", "output_tokens", "completionTokens", "completion_tokens",
    "totalTokens", "total_tokens", "cacheReadTokens", "cache_read_tokens",
    "cost", "totalCost", "total_cost", "currency", "currencyCode", "currency_code",
  ];
  if (usage === undefined && directUsageKeys.some((key) => value[key] !== undefined)) usage = usageFromRecord(value);
  const contextSource = context ?? value;
  const usedTokens = firstNumber(contextSource, ["usedTokens", "used_tokens", "contextTokens", "context_tokens", "tokensUsed", "tokens_used", "tokens", "used"]);
  const contextWindowTokens = firstPositiveInteger(contextSource, [
    "contextWindowTokens",
    "context_window_tokens",
    "contextWindow",
    "context_window",
    "maxContextTokens",
    "max_context_tokens",
    "size",
  ]);
  const rawPercent = firstNumber(contextSource, ["usedPercent", "used_percent", "percent", "percentage"]);
  const usedPercent = rawPercent !== undefined && rawPercent <= 100 ? rawPercent : undefined;
  let modelId: string | undefined;
  for (const root of [value, ...(meta === undefined ? [] : [meta]), ...(context === undefined ? [] : [context])]) {
    modelId ??= firstStringValue(root, ["modelId", "model_id", "model"]);
  }
  if (modelId === undefined
    && usedTokens === undefined
    && contextWindowTokens === undefined
    && usedPercent === undefined
    && usage === undefined) return null;
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function mcpServerEntry(server: SessionMcpServer): Record<string, unknown> {
  return {
    name: server.name,
    command: server.command,
    args: server.args,
    env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
  };
}

function configOptionValues(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.value === "string") values.push(entry.value);
    for (const nested of configOptionValues(entry.options)) if (!values.includes(nested)) values.push(nested);
  }
  return values;
}

function sessionConfigOptions(value: unknown): readonly AcpSessionConfigOption[] | undefined {
  if (!isRecord(value)) return undefined;
  const source = Array.isArray(value.configOptions)
    ? value.configOptions
    : Array.isArray(value.config_options)
      ? value.config_options
      : undefined;
  if (source === undefined) return undefined;
  return source.flatMap((entry): readonly AcpSessionConfigOption[] => {
    if (!isRecord(entry) || typeof entry.id !== "string") return [];
    return [{
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      ...(typeof entry.category === "string" ? { category: entry.category } : {}),
      ...(typeof entry.currentValue === "string" ? { currentValue: entry.currentValue } : {}),
      values: configOptionValues(entry.options),
    }];
  });
}

function configOptionFor(
  options: readonly AcpSessionConfigOption[],
  category: "model" | "thought_level",
): AcpSessionConfigOption | undefined {
  const categorized = options.find((entry) => entry.category === category);
  if (categorized !== undefined) return categorized;
  const terms = category === "model" ? ["model"] : ["reason", "thinking", "thought", "effort"];
  return options.find((entry) => {
    const searchable = `${entry.id} ${entry.name}`.toLowerCase();
    return terms.some((term) => searchable.includes(term));
  });
}

export class AcpProviderAdapter implements AgentProviderAdapter {
  public readonly providerId: string;
  public readonly displayName: string;

  readonly #hostId: string;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #cwd: string | undefined;
  readonly #transportFactory: (() => JsonRpcTransport) | undefined;
  readonly #requestTimeoutMs: number;
  readonly #now: () => Date;
  readonly #identity: AcpProviderIdentity;
  readonly #capabilityNote: string;
  readonly #events = new ProviderEventHub();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #sessionContexts = new Map<string, SessionContext>();
  readonly #historyCapture = new Map<string, AcpMessageAccumulator>();
  readonly #liveMessages = new Map<string, AcpMessageAccumulator>();
  readonly #reportedContexts = new Map<string, ReportedSessionContext>();
  readonly #sessionConfigOptions = new Map<string, readonly AcpSessionConfigOption[]>();
  readonly #appliedSessionSelections = new Map<string, AppliedSessionSelections>();
  readonly #sessionMcpBindings = new Map<string, SessionMcpBinding>();
  readonly #sessionClientToolModes = new Map<string, "enabled" | "disabled">();
  readonly #openableSubagentSessions = new Map<string, string>();
  readonly #activeSessions = new Set<string>();
  #peer: JsonRpcPeer | null = null;
  #initializing: Promise<JsonRpcPeer> | null = null;
  #initializeResponse: AcpInitializeResponse | null = null;
  #eventCounter = 0;
  #clientTooling: ProviderClientTooling | undefined;

  public constructor(options: AcpProviderAdapterOptions) {
    this.providerId = options.providerId;
    this.displayName = options.displayName;
    this.#hostId = options.hostId;
    this.#command = options.command;
    this.#args = options.commandArgs;
    this.#cwd = options.cwd;
    this.#transportFactory = options.transportFactory;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.#now = options.now ?? (() => new Date());
    this.#identity = {
      providerId: options.providerId,
      displayName: options.displayName,
      ...(options.sessionLabel !== undefined ? { sessionLabel: options.sessionLabel } : {}),
    };
    this.#capabilityNote = options.capabilityNote ?? `Uses the documented Agent Client Protocol mode exposed by ${options.displayName}.`;
  }

  public configureClientTooling(tooling: ProviderClientTooling): void {
    this.#clientTooling = tooling;
  }

  public async detect(): Promise<ProviderDetection> {
    if (this.#transportFactory !== undefined) return { providerId: this.providerId, available: true, version: "injected", details: ["Injected ACP transport is configured"] };
    try {
      const result = await execute(this.#command, ["--version"]);
      const version = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/u)[0] ?? "unknown";
      return { providerId: this.providerId, available: true, version, executable: this.#command, details: [`${this.displayName} executable is available`] };
    } catch (error) {
      return { providerId: this.providerId, available: false, executable: this.#command, details: [error instanceof Error ? error.message : String(error)] };
    }
  }

  public async getAuthStatus(): Promise<AuthStatus> {
    const response = await this.ensureInitialized();
    const methods = this.authMethods(response);
    return {
      authenticated: methods.length === 0 ? true : null,
      ...(methods.length > 0 ? { method: methods.map((entry) => entry.id).join(", ") } : {}),
      canAuthenticate: methods.length > 0,
      details: methods.length === 0
        ? ["The ACP agent did not advertise an authentication requirement"]
        : [`Authentication methods are advertised by the local ${this.displayName} agent`, ...methods.map((entry) => `${entry.id}: ${entry.name}`)],
    };
  }

  public async authenticate(request: AuthRequest): Promise<AuthResult> {
    const response = await this.ensureInitialized();
    const methods = this.authMethods(response);
    const methodId = request.method ?? methods[0]?.id;
    if (methodId === undefined || !methods.some((entry) => entry.id === methodId)) {
      throw new ProviderAdapterError(this.providerId, "AUTH_METHOD_INVALID", `Select one of the authentication methods advertised by ${this.displayName}`, false);
    }
    await (await this.peer()).request("authenticate", { methodId });
    return { authenticated: true, pending: false, details: [`${this.displayName} authentication method ${methodId} completed`] };
  }

  public async getCapabilities(): Promise<ProviderCapabilities> {
    const response = await this.ensureInitialized();
    const native = response.agentCapabilities;
    const listSessions = boolCapability(native, ["sessionCapabilities", "list"]);
    const resumeSession = boolCapability(native, ["sessionCapabilities", "resume"]);
    const loadSession = boolCapability(native, ["loadSession"]);
    return {
      authentication: this.authMethods(response).length > 0,
      listSessions,
      paginatedSessions: listSessions,
      sessionHistory: loadSession,
      createSession: true,
      resumeSession: resumeSession || loadSession,
      sendMessage: true,
      steering: false,
      streamingText: true,
      toolEvents: true,
      commandEvents: true,
      fileChanges: true,
      approvals: true,
      userInput: false,
      interrupt: true,
      modelEnumeration: modelEntries(response, this.providerId).length > 0,
      projectAssociation: true,
      sessionRelationships: false,
      messageEditing: false,
      remoteConnectivity: "documented_remote",
      notes: [
        this.#capabilityNote,
        "Capabilities are read from initialize; session list/resume are not assumed when the agent does not advertise them.",
        "The bridge advertises no client filesystem or terminal capability, so ACP cannot silently delegate host execution to the phone or relay.",
      ],
    };
  }

  public async listModels(): Promise<readonly RemoteModel[]> {
    return modelEntries(await this.ensureInitialized(), this.providerId);
  }

  public async getSessionContext(providerSessionId: string): Promise<{
    readonly modelId?: string;
    readonly usedTokens: number | null;
    readonly contextWindowTokens: number | null;
    readonly usedPercent: number | null;
    readonly supportsManualCompaction: boolean;
    readonly updatedAt: string;
    readonly usage: SessionTokenUsage;
  }> {
    const response = await this.ensureInitialized();
    const reported = this.#reportedContexts.get(providerSessionId);
    const modelId = reported?.modelId ?? currentModelId(response);
    const model = modelId === undefined
      ? modelEntries(response, this.providerId).find((entry) => entry.isDefault)
      : modelEntries(response, this.providerId).find((entry) => entry.id === modelId);
    const contextWindowTokens = reported?.contextWindowTokens
      ?? (model === undefined ? undefined : modelContextWindow(model.nativeMetadata));
    const usedTokens = reported?.usedTokens;
    const usedPercent = reported?.usedPercent
      ?? (usedTokens !== undefined && contextWindowTokens !== undefined && contextWindowTokens > 0
        ? Math.max(0, Math.min(100, usedTokens / contextWindowTokens * 100))
        : undefined);
    return {
      ...(modelId !== undefined ? { modelId } : {}),
      usedTokens: usedTokens ?? null,
      contextWindowTokens: contextWindowTokens ?? null,
      usedPercent: usedPercent ?? null,
      supportsManualCompaction: false,
      updatedAt: reported?.updatedAt ?? this.#now().toISOString(),
      usage: reported?.usage ?? {},
    };
  }

  public async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.listSessions) throw new UnsupportedProviderCapabilityError(this.providerId, "session/list");
    const result = await (await this.peer()).request<unknown>("session/list", {
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.workingDirectory !== undefined ? { cwd: options.workingDirectory } : {}),
    });
    if (!isRecord(result) || !Array.isArray(result.sessions)) throw new ProviderAdapterError(this.providerId, "INVALID_SESSION_LIST", `${this.displayName} returned an invalid ACP session/list response`, true);
    const sessions = result.sessions.map((entry) => {
      const session = normalizeAcpSession(this.#hostId, entry, this.#now(), this.#identity);
      this.captureReportedContext(session.providerSessionId, entry);
      if (session.workingDirectory !== undefined) this.#sessionContexts.set(session.providerSessionId, { cwd: session.workingDirectory, additionalDirectories: additionalDirectories(entry) });
      return session;
    });
    return { sessions, nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null };
  }

  public async getSession(providerSessionId: string): Promise<RemoteSession> {
    let cursor: string | undefined;
    const visited = new Set<string>();
    for (let page = 0; page < 100; page += 1) {
      const response = await this.listSessions(cursor === undefined ? {} : { cursor });
      const match = response.sessions.find((session) => session.providerSessionId === providerSessionId);
      if (match !== undefined) return match;
      if (response.nextCursor === null) break;
      if (visited.has(response.nextCursor)) throw new ProviderAdapterError(this.providerId, "PAGINATION_LOOP", `${this.displayName} repeated an ACP session cursor`, false);
      visited.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new ProviderAdapterError(this.providerId, "SESSION_NOT_FOUND", `${this.displayName} session ${providerSessionId} was not found`, false);
  }

  public async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.sessionHistory) throw new UnsupportedProviderCapabilityError(this.providerId, "session/load history replay");
    const context = await this.contextFor(providerSessionId);
    const accumulator = createMessageAccumulator();
    this.#historyCapture.set(providerSessionId, accumulator);
    try {
      const result = await (await this.peer()).request("session/load", {
        sessionId: providerSessionId,
        cwd: context.cwd,
        additionalDirectories: context.additionalDirectories,
        mcpServers: this.mcpServers(providerSessionId),
      });
      this.captureReportedContext(providerSessionId, result);
      this.captureSessionConfigOptions(providerSessionId, result);
      this.#sessionClientToolModes.set(providerSessionId, this.#clientTooling === undefined ? "disabled" : "enabled");
      this.#activeSessions.add(providerSessionId);
      return await this.hydrateCapturedSubagentLinks(providerSessionId, completeAcpMessages(accumulator, this.#now()));
    } finally {
      this.#historyCapture.delete(providerSessionId);
    }
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    const clientToolsEnabled = options.mcpServers !== "none"
      && options.clientTools !== "none"
      && this.#clientTooling !== undefined;
    const binding = !clientToolsEnabled
      ? undefined
      : this.#clientTooling?.createSessionBinding?.(this.providerId);
    let response: unknown;
    try {
      response = await (await this.peer()).request<unknown>("session/new", {
        cwd: options.workingDirectory,
        additionalDirectories: stringArray(options.metadata?.additionalDirectories),
        mcpServers: binding === undefined ? [] : [mcpServerEntry(binding.server)],
      });
      if (!isRecord(response) || typeof response.sessionId !== "string") {
        throw new ProviderAdapterError(this.providerId, "INVALID_NEW_SESSION", `${this.displayName} returned an invalid session/new response`, true);
      }
      binding?.bind(response.sessionId);
      if (binding !== undefined) this.#sessionMcpBindings.set(response.sessionId, binding);
    } catch (error) {
      binding?.release();
      throw error;
    }
    if (!isRecord(response) || typeof response.sessionId !== "string") throw new ProviderAdapterError(this.providerId, "INVALID_NEW_SESSION", `${this.displayName} returned an invalid session/new response`, true);
    this.#sessionContexts.set(response.sessionId, { cwd: options.workingDirectory, additionalDirectories: stringArray(options.metadata?.additionalDirectories) });
    this.captureReportedContext(response.sessionId, response);
    this.captureSessionConfigOptions(response.sessionId, response);
    if (!clientToolsEnabled) this.#sessionClientToolModes.set(response.sessionId, "disabled");
    else if (binding !== undefined) this.#sessionClientToolModes.set(response.sessionId, "enabled");
    this.#activeSessions.add(response.sessionId);
    await this.applySessionSelections(response.sessionId, options.modelId, options.reasoningEffort);
    const session = normalizeAcpSession(this.#hostId, {
      sessionId: response.sessionId,
      cwd: options.workingDirectory,
      ...(options.title !== undefined ? { title: options.title } : {}),
      updatedAt: this.#now().toISOString(),
      _meta: response,
    }, this.#now(), this.#identity);
    await this.emit({ type: "session.created", providerSessionId: response.sessionId, payload: { session: session.nativeMetadata } });
    if (options.firstInstruction !== undefined && options.firstInstruction.trim().length > 0) {
      await this.sendMessage(response.sessionId, {
        requestId: randomUUID(),
        content: options.firstInstruction,
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });
    }
    return session;
  }

  public async resumeSession(providerSessionId: string): Promise<void> {
    const context = await this.contextFor(providerSessionId);
    const capabilities = await this.getCapabilities();
    if (capabilities.resumeSession && boolCapability((await this.ensureInitialized()).agentCapabilities, ["sessionCapabilities", "resume"])) {
      const result = await (await this.peer()).request("session/resume", {
        sessionId: providerSessionId,
        cwd: context.cwd,
        additionalDirectories: context.additionalDirectories,
        mcpServers: this.mcpServers(providerSessionId),
      });
      this.captureReportedContext(providerSessionId, result);
      this.captureSessionConfigOptions(providerSessionId, result);
      this.#sessionClientToolModes.set(providerSessionId, this.#clientTooling === undefined ? "disabled" : "enabled");
      this.#activeSessions.add(providerSessionId);
      return;
    }
    if (capabilities.sessionHistory) {
      const result = await (await this.peer()).request("session/load", {
        sessionId: providerSessionId,
        cwd: context.cwd,
        additionalDirectories: context.additionalDirectories,
        mcpServers: this.mcpServers(providerSessionId),
      });
      this.captureReportedContext(providerSessionId, result);
      this.captureSessionConfigOptions(providerSessionId, result);
      this.#sessionClientToolModes.set(providerSessionId, this.#clientTooling === undefined ? "disabled" : "enabled");
      this.#activeSessions.add(providerSessionId);
      return;
    }
    throw new UnsupportedProviderCapabilityError(this.providerId, "session resume");
  }

  public async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    const attachments = request.attachments ?? [];
    if (attachments.some((attachment) => !attachment.mimeType.toLowerCase().startsWith("image/"))) {
      throw new UnsupportedProviderCapabilityError(this.providerId, "non-image attachments");
    }
    if (!this.#activeSessions.has(providerSessionId)) {
      await this.resumeSession(providerSessionId);
    } else if (this.#clientTooling !== undefined && !this.#sessionClientToolModes.has(providerSessionId) && (await this.getCapabilities()).resumeSession) {
      // Re-enter sessions when supported so a per-session MCP gateway can be
      // supplied. ACP agents without load/resume can still prompt the session
      // returned by session/new instead of failing a basic first turn.
      await this.resumeSession(providerSessionId);
    }
    await this.applySessionSelections(providerSessionId, request.modelId, request.reasoningEffort);
    const peer = await this.peer();
    void peer.request<unknown>("session/prompt", {
      sessionId: providerSessionId,
      prompt: [
        { type: "text", text: request.content },
        ...attachments.map((attachment) => ({
          type: "image",
          data: attachment.dataBase64,
          mimeType: attachment.mimeType,
        })),
      ],
    }).then(async (result) => {
      this.captureReportedContext(providerSessionId, result);
      this.#liveMessages.delete(providerSessionId);
      await this.emit({ type: "agent.completed", providerSessionId, payload: { result: asJsonObject(result) } });
    }).catch(async (error: unknown) => {
      this.#liveMessages.delete(providerSessionId);
      await this.emit({ type: "agent.error", providerSessionId, payload: { message: error instanceof Error ? error.message : String(error) } });
    });
    return { accepted: true, providerTurnId: request.requestId, details: ["ACP session/prompt accepted; updates arrive through session/update notifications"] };
  }

  public async interrupt(providerSessionId: string): Promise<void> {
    await (await this.peer()).notify("session/cancel", { sessionId: providerSessionId });
    this.#liveMessages.delete(providerSessionId);
    for (const [requestId, pending] of this.#pendingPermissions) {
      if (pending.providerSessionId !== providerSessionId) continue;
      this.#pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    await this.emit({ type: "agent.interrupted", providerSessionId, payload: {} });
  }

  public async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    await this.peer();
    return this.#events.subscribe(providerSessionId, sink);
  }

  public async respondToApproval(response: ProviderApprovalResponse): Promise<void> {
    const pending = this.#pendingPermissions.get(response.providerRequestId);
    if (pending === undefined) throw new ProviderAdapterError(this.providerId, "APPROVAL_NOT_FOUND", `${this.displayName} permission request is stale or unknown`, false);
    const option = pending.options.find((entry) => entry.optionId === response.choiceId);
    if (option === undefined) throw new ProviderAdapterError(this.providerId, "APPROVAL_CHOICE_INVALID", `The selected ${this.displayName} permission option was not offered for this request`, false);
    this.#pendingPermissions.delete(response.providerRequestId);
    pending.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
    await this.emit({ type: "approval.resolved", providerSessionId: pending.providerSessionId, payload: { providerRequestId: response.providerRequestId, choiceId: response.choiceId } });
  }

  public async dispose(): Promise<void> {
    for (const pending of this.#pendingPermissions.values()) pending.reject(new Error(`${this.displayName} adapter disposed`));
    this.#pendingPermissions.clear();
    this.#historyCapture.clear();
    this.#liveMessages.clear();
    this.#reportedContexts.clear();
    this.#sessionConfigOptions.clear();
    this.#appliedSessionSelections.clear();
    this.#sessionClientToolModes.clear();
    for (const binding of this.#sessionMcpBindings.values()) binding.release();
    this.#sessionMcpBindings.clear();
    this.#openableSubagentSessions.clear();
    this.#activeSessions.clear();
    this.#events.clear();
    const peer = this.#peer;
    this.#peer = null;
    this.#initializeResponse = null;
    if (peer !== null) await peer.close();
  }

  private async ensureInitialized(): Promise<AcpInitializeResponse> {
    await this.peer();
    if (this.#initializeResponse === null) throw new ProviderAdapterError(this.providerId, "INITIALIZE_FAILED", `${this.displayName} ACP initialize response is unavailable`, true);
    return this.#initializeResponse;
  }

  private peer(): Promise<JsonRpcPeer> {
    if (this.#peer !== null) return Promise.resolve(this.#peer);
    if (this.#initializing !== null) return this.#initializing;
    this.#initializing = this.initialize().finally(() => {
      this.#initializing = null;
    });
    return this.#initializing;
  }

  private mcpServers(providerSessionId?: string): readonly unknown[] {
    if (this.#clientTooling === undefined || providerSessionId === undefined) return [];
    return [mcpServerEntry(this.#clientTooling.mcpServer(this.providerId, providerSessionId))];
  }

  private async initialize(): Promise<JsonRpcPeer> {
    const transport = this.#transportFactory?.() ?? new JsonLineProcessTransport({
      command: this.#command,
      args: this.#args,
      ...(this.#cwd !== undefined ? { cwd: this.#cwd } : {}),
    });
    const peer = new JsonRpcPeer(transport, {
      includeJsonRpc: true,
      timeoutMs: this.#requestTimeoutMs,
      idPrefix: this.providerId,
      onError: (error) => this.emit({
        type: "provider.disconnected",
        payload: { message: error.message, source: "json_rpc_callback" },
      }),
    });
    peer.onNotification((method, params) => this.handleNotification(method, params));
    peer.onRequest((method, params, id) => this.handleClientRequest(method, params, id));
    try {
      const response = await peer.request<AcpInitializeResponse>("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "tethoq", title: "Tethoq", version: "0.1.0" },
        _meta: { clientType: "tethoq", clientIdentifier: "tethoq" },
      });
      if (response.protocolVersion !== undefined && response.protocolVersion !== 1) throw new Error(`Unsupported negotiated ACP version ${response.protocolVersion}`);
      this.#initializeResponse = response;
      this.#peer = peer;
      return peer;
    } catch (error) {
      await peer.close();
      throw new ProviderAdapterError(this.providerId, "INITIALIZE_FAILED", `${this.displayName} ACP initialization failed: ${error instanceof Error ? error.message : String(error)}`, true, { cause: error });
    }
  }

  private authMethods(response: AcpInitializeResponse): readonly { readonly id: string; readonly name: string }[] {
    if (!Array.isArray(response.authMethods)) return [];
    return response.authMethods.flatMap((entry): readonly { readonly id: string; readonly name: string }[] => {
      if (!isRecord(entry)) return [];
      const id = [entry.id, entry.methodId].find((value): value is string => typeof value === "string");
      if (id === undefined) return [];
      return [{ id, name: typeof entry.name === "string" ? entry.name : typeof entry.title === "string" ? entry.title : id }];
    });
  }

  private async contextFor(providerSessionId: string): Promise<SessionContext> {
    const cached = this.#sessionContexts.get(providerSessionId);
    if (cached !== undefined) return cached;
    const session = await this.getSession(providerSessionId);
    if (session.workingDirectory === undefined) throw new ProviderAdapterError(this.providerId, "SESSION_CWD_MISSING", `ACP requires the session working directory to resume or load this ${this.displayName} session`, false);
    const context = { cwd: session.workingDirectory, additionalDirectories: additionalDirectories(session.nativeMetadata) };
    this.#sessionContexts.set(providerSessionId, context);
    return context;
  }

  private captureReportedContext(providerSessionId: string, source: unknown): void {
    const parsed = parseReportedContext(source);
    if (parsed === null) return;
    const prior = this.#reportedContexts.get(providerSessionId);
    const retainContextWindow = parsed.contextWindowTokens === undefined && parsed.modelId === undefined;
    const retainPercent = parsed.usedPercent === undefined
      && parsed.usedTokens === undefined
      && parsed.contextWindowTokens === undefined
      && parsed.modelId === undefined;
    this.#reportedContexts.set(providerSessionId, {
      ...(prior?.modelId !== undefined ? { modelId: prior.modelId } : {}),
      ...(prior?.usedTokens !== undefined ? { usedTokens: prior.usedTokens } : {}),
      ...(retainContextWindow && prior?.contextWindowTokens !== undefined ? { contextWindowTokens: prior.contextWindowTokens } : {}),
      ...(retainPercent && prior?.usedPercent !== undefined ? { usedPercent: prior.usedPercent } : {}),
      ...(parsed.modelId !== undefined ? { modelId: parsed.modelId } : {}),
      ...(parsed.usedTokens !== undefined ? { usedTokens: parsed.usedTokens } : {}),
      ...(parsed.contextWindowTokens !== undefined ? { contextWindowTokens: parsed.contextWindowTokens } : {}),
      ...(parsed.usedPercent !== undefined ? { usedPercent: parsed.usedPercent } : {}),
      usage: { ...(prior?.usage ?? {}), ...(parsed.usage ?? {}) },
      updatedAt: this.#now().toISOString(),
    });
  }

  private captureSessionConfigOptions(providerSessionId: string, source: unknown): void {
    const options = sessionConfigOptions(source);
    if (options === undefined) return;
    this.#sessionConfigOptions.set(providerSessionId, options);
    const prior = this.#appliedSessionSelections.get(providerSessionId);
    const modelId = configOptionFor(options, "model")?.currentValue;
    const reasoningEffort = configOptionFor(options, "thought_level")?.currentValue;
    this.#appliedSessionSelections.set(providerSessionId, {
      ...(prior?.modelId !== undefined ? { modelId: prior.modelId } : {}),
      ...(prior?.reasoningEffort !== undefined ? { reasoningEffort: prior.reasoningEffort } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
  }

  private async applySessionSelections(
    providerSessionId: string,
    requestedModelId: string | undefined,
    requestedReasoningEffort: string | undefined,
  ): Promise<void> {
    const modelId = requestedModelId?.trim();
    const reasoningEffort = requestedReasoningEffort?.trim();
    if (!modelId && !reasoningEffort) return;

    const applied = this.#appliedSessionSelections.get(providerSessionId);
    const changeModel = !!modelId && applied?.modelId !== modelId;
    const changeReasoning = !!reasoningEffort && applied?.reasoningEffort !== reasoningEffort;
    if (!changeModel && !changeReasoning) return;

    let options = this.#sessionConfigOptions.get(providerSessionId) ?? [];
    const modelOption = configOptionFor(options, "model");
    if (changeModel && modelId && modelOption !== undefined) {
      await this.setSessionConfigOption(providerSessionId, modelOption, modelId);
      options = this.#sessionConfigOptions.get(providerSessionId) ?? options;
      this.captureSelectedModel(providerSessionId, modelId);
      this.rememberSessionSelection(providerSessionId, { modelId });
    } else if (changeModel && modelId && this.providerId !== "grok") {
      const current = this.#reportedContexts.get(providerSessionId)?.modelId ?? currentModelId(await this.ensureInitialized());
      if (current !== modelId) throw new UnsupportedProviderCapabilityError(this.providerId, "model selection");
      this.rememberSessionSelection(providerSessionId, { modelId });
    }

    const reasoningOption = configOptionFor(options, "thought_level");
    const useGrokFallback = this.providerId === "grok"
      && ((changeModel && modelOption === undefined) || (changeReasoning && reasoningOption === undefined));
    if (useGrokFallback) {
      const fallbackModelId = modelId ?? this.#reportedContexts.get(providerSessionId)?.modelId ?? currentModelId(await this.ensureInitialized());
      if (fallbackModelId === undefined) {
        throw new UnsupportedProviderCapabilityError(this.providerId, "reasoning effort without a selected model");
      }
      const result = await (await this.peer()).request<unknown>("session/set_model", {
        sessionId: providerSessionId,
        modelId: fallbackModelId,
        ...(changeReasoning && reasoningEffort && reasoningOption === undefined ? { _meta: { reasoningEffort } } : {}),
      });
      this.captureReportedContext(providerSessionId, result);
      this.captureSelectedModel(providerSessionId, fallbackModelId);
      this.rememberSessionSelection(providerSessionId, {
        modelId: fallbackModelId,
        ...(changeReasoning && reasoningEffort && reasoningOption === undefined ? { reasoningEffort } : {}),
      });
    }

    if (changeReasoning && reasoningEffort && reasoningOption !== undefined) {
      await this.setSessionConfigOption(providerSessionId, reasoningOption, reasoningEffort);
      this.rememberSessionSelection(providerSessionId, { reasoningEffort });
    } else if (changeReasoning && this.providerId !== "grok") {
      throw new UnsupportedProviderCapabilityError(this.providerId, "reasoning effort selection");
    }
  }

  private async setSessionConfigOption(
    providerSessionId: string,
    option: AcpSessionConfigOption,
    value: string,
  ): Promise<void> {
    if (option.currentValue === value) return;
    if (option.values.length > 0 && !option.values.includes(value)) {
      throw new ProviderAdapterError(
        this.providerId,
        "SESSION_CONFIG_VALUE_INVALID",
        `${this.displayName} does not advertise ${value} for ${option.name}`,
        false,
      );
    }
    const result = await (await this.peer()).request<unknown>("session/set_config_option", {
      sessionId: providerSessionId,
      configId: option.id,
      value,
    });
    this.captureSessionConfigOptions(providerSessionId, result);
  }

  private rememberSessionSelection(providerSessionId: string, update: AppliedSessionSelections): void {
    const prior = this.#appliedSessionSelections.get(providerSessionId);
    this.#appliedSessionSelections.set(providerSessionId, {
      ...(prior?.modelId !== undefined ? { modelId: prior.modelId } : {}),
      ...(prior?.reasoningEffort !== undefined ? { reasoningEffort: prior.reasoningEffort } : {}),
      ...update,
    });
  }

  private captureSelectedModel(providerSessionId: string, modelId: string): void {
    const prior = this.#reportedContexts.get(providerSessionId);
    this.#reportedContexts.set(providerSessionId, {
      modelId,
      ...(prior?.usedTokens !== undefined ? { usedTokens: prior.usedTokens } : {}),
      ...(prior?.usedPercent !== undefined ? { usedPercent: prior.usedPercent } : {}),
      usage: prior?.usage ?? {},
      updatedAt: this.#now().toISOString(),
    });
  }

  private async handleClientRequest(method: string, params: unknown, id: RpcId): Promise<unknown> {
    if (method !== "session/request_permission") throw new ProviderAdapterError(this.providerId, "ACP_CLIENT_METHOD_UNSUPPORTED", `${this.displayName} requested unsupported ACP client method ${method}`, false);
    if (!isRecord(params) || typeof params.sessionId !== "string") throw new ProviderAdapterError(this.providerId, "INVALID_PERMISSION_REQUEST", `${this.displayName} permission request omitted sessionId`, false);
    const options = Array.isArray(params.options) ? params.options.flatMap((entry): readonly { readonly optionId: string; readonly name: string; readonly kind?: string }[] => {
      if (!isRecord(entry) || typeof entry.optionId !== "string") return [];
      return [{ optionId: entry.optionId, name: typeof entry.name === "string" ? entry.name : entry.optionId, ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}) }];
    }) : [];
    if (options.length === 0) throw new ProviderAdapterError(this.providerId, "INVALID_PERMISSION_OPTIONS", `${this.displayName} permission request did not offer a selectable option`, false);
    const requestId = String(id);
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const command = extractCommand(toolCall);
    const result = await new Promise<unknown>((resolve, reject) => {
      this.#pendingPermissions.set(requestId, { providerSessionId: params.sessionId as string, options, resolve, reject });
      void this.emit({
        type: "approval.requested",
        providerSessionId: params.sessionId as string,
        payload: { providerRequestId: requestId, toolCall: asJsonObject(toolCall) },
        approval: {
          providerRequestId: requestId,
          providerSessionId: params.sessionId as string,
          title: typeof toolCall.title === "string" ? toolCall.title : `Approve ${this.displayName} action`,
          ...(typeof toolCall.description === "string" ? { reason: toolCall.description } : {}),
          ...(command !== undefined ? { command } : {}),
          ...(typeof toolCall.cwd === "string" ? { workingDirectory: toolCall.cwd } : {}),
          affectedFiles: extractFiles(toolCall),
          networkDestinations: extractNetworkDestinations(toolCall),
          choices: options.map((entry) => ({ id: entry.optionId, label: entry.name, kind: permissionKind(entry.kind) })),
          riskMetadata: asJsonObject({ toolCall, options }),
        },
      });
    });
    return result;
  }

  private async handleNotification(method: string, params: unknown): Promise<void> {
    if (!["session/update", "_x.ai/session/update", "_x.ai/session_notification"].includes(method)
      || !isRecord(params)
      || typeof params.sessionId !== "string"
      || !isRecord(params.update)) return;
    const update = params.update;
    this.captureReportedContext(params.sessionId, update);
    this.captureReportedContext(params.sessionId, params);
    this.captureSessionConfigOptions(params.sessionId, update);
    const sessionUpdate = typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : typeof update.session_update === "string"
        ? update.session_update
        : "unknown";
    const capture = this.#historyCapture.get(params.sessionId);
    const live = this.#liveMessages.get(params.sessionId) ?? createMessageAccumulator();
    this.#liveMessages.set(params.sessionId, live);
    if (sessionUpdate === "user_message_chunk" || sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") {
      const role = sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      const partType = sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text";
      // History replay needs the fully coalesced message. Live rendering only
      // needs the current delta, so retaining and re-copying the whole answer
      // for every ACP chunk would turn long responses into quadratic work.
      const message = appendAcpContentChunk(
        this.#hostId,
        params.sessionId,
        role,
        update,
        capture ?? live,
        this.#now(),
        capture !== undefined,
        historyMessageId(role, params, update),
        partType,
        this.#identity,
      );
      if (capture === undefined && message !== null) {
        await this.emit({
          type: role === "assistant" ? "message.delta" : "message.started",
          providerSessionId: params.sessionId,
          payload: {
            messageId: message.providerMessageId,
            role,
            content: asJsonObject(update),
            ...(partType === "reasoning" ? { partType } : {}),
          },
          nativeEvent: asJsonObject({ method, params }),
        });
      }
      return;
    }
    const subagent = normalizeAcpSubagentUpdate(update);
    if (subagent !== null) {
      if (capture !== undefined) {
        appendAcpSubagentPart(this.#hostId, params.sessionId, update, subagent, capture, this.#now(), this.#identity);
        return;
      }
      const receiverSessionIds = await this.resolveOpenableSubagentSessionIds(params.sessionId, update);
      const linked = normalizeAcpSubagentUpdate(update, receiverSessionIds);
      if (linked !== null) {
        const terminal = linked.status === "completed" || linked.status === "failed";
        await this.emit({
          type: sessionUpdate === "subagent_spawned" ? "tool.started" : terminal ? "tool.completed" : "tool.output",
          providerSessionId: params.sessionId,
          payload: asJsonObject({ parts: [linked] }),
          nativeEvent: asJsonObject({ method, params }),
        });
      }
      return;
    }
    if (capture !== undefined) return;
    const normalized = normalizeUpdate(sessionUpdate, update);
    if (normalized !== null) await this.emit({ ...normalized, providerSessionId: params.sessionId, nativeEvent: asJsonObject({ method, params }) });
  }

  private async hydrateCapturedSubagentLinks(
    providerSessionId: string,
    messages: readonly RemoteMessage[],
  ): Promise<readonly RemoteMessage[]> {
    return await Promise.all(messages.map(async (message) => {
      if (!message.parts.some((part) => part.type === "subagent")) return message;
      const update = message.nativeMetadata;
      const receiverSessionIds = await this.resolveOpenableSubagentSessionIds(providerSessionId, update);
      const linked = normalizeAcpSubagentUpdate(update, receiverSessionIds);
      return linked === null ? message : { ...message, parts: [linked] };
    }));
  }

  private async resolveOpenableSubagentSessionIds(
    parentSessionId: string,
    update: Record<string, unknown>,
  ): Promise<readonly string[]> {
    const childSessionId = acpSubagentChildSessionId(update);
    if (childSessionId === undefined || childSessionId === parentSessionId) return [];
    const cached = this.#openableSubagentSessions.get(childSessionId);
    if (cached !== undefined) return [cached];
    try {
      const capabilities = await this.getCapabilities();
      if (!capabilities.listSessions || !capabilities.sessionHistory) return [];
      const child = await this.getSession(childSessionId);
      if (child.workingDirectory === undefined) return [];
      this.#openableSubagentSessions.set(childSessionId, child.id);
      return [child.id];
    } catch {
      return [];
    }
  }

  private async emit(input: Omit<ProviderEvent, "eventId" | "providerId" | "occurredAt">): Promise<void> {
    await this.#events.emit({
      eventId: `${this.providerId}_event_${++this.#eventCounter}`,
      providerId: this.providerId,
      occurredAt: this.#now().toISOString(),
      ...input,
    });
  }
}

export class GrokProviderAdapter extends AcpProviderAdapter {
  public constructor(options: GrokAdapterOptions) {
    super({
      ...options,
      providerId: "grok",
      displayName: "Grok Build",
      sessionLabel: "Grok",
      command: options.command ?? "grok",
      commandArgs: options.commandArgs ?? ["agent", "stdio"],
      capabilityNote: "Uses the documented Agent Client Protocol exposed by Grok Build agent mode.",
    });
  }
}

export function createPublicAcpProviderAdapter(
  providerId: PublicAcpProviderId,
  options: PublicAcpAdapterOptions,
): AcpProviderAdapter {
  const preset = PUBLIC_ACP_PROVIDER_PRESETS[providerId];
  return new AcpProviderAdapter({
    ...options,
    ...preset,
    command: options.command ?? preset.command,
    commandArgs: options.commandArgs ?? preset.commandArgs,
  });
}

function additionalDirectories(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  return stringArray(value.additionalDirectories);
}

function permissionKind(kind: string | undefined): "approve" | "reject" | "other" {
  if (kind === undefined) return "other";
  const normalized = kind.toLowerCase();
  if (normalized.includes("reject") || normalized.includes("deny")) return "reject";
  if (normalized.includes("allow") || normalized.includes("approve")) return "approve";
  return "other";
}

function extractCommand(value: Record<string, unknown>): string | undefined {
  if (typeof value.command === "string") return value.command;
  if (Array.isArray(value.command) && value.command.every((entry) => typeof entry === "string")) return value.command.join(" ");
  if (isRecord(value.rawInput) && typeof value.rawInput.command === "string") return value.rawInput.command;
  return undefined;
}

function extractFiles(value: Record<string, unknown>): readonly string[] {
  const files = new Set<string>();
  for (const key of ["files", "affectedFiles", "locations", "content"]) {
    const source = value[key];
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (typeof entry === "string") files.add(entry);
      else if (isRecord(entry)) {
        const path = [entry.path, entry.uri].find((item): item is string => typeof item === "string");
        if (path !== undefined) files.add(path);
      }
    }
  }
  return [...files];
}

function extractNetworkDestinations(value: Record<string, unknown>): readonly string[] {
  const destinations = new Set<string>();
  for (const key of ["url", "host", "hostname", "networkDestination"]) if (typeof value[key] === "string") destinations.add(value[key] as string);
  return [...destinations];
}

function normalizeUpdate(
  sessionUpdate: string,
  update: Record<string, unknown>,
): Omit<ProviderEvent, "eventId" | "providerId" | "providerSessionId" | "occurredAt"> | null {
  if (sessionUpdate === "tool_call") {
    const command = extractCommand(update);
    return command === undefined
      ? { type: "tool.started", payload: asJsonObject(update) }
      : { type: "command.started", payload: { command, toolCall: asJsonObject(update) } };
  }
  if (sessionUpdate === "tool_call_update") {
    const status = typeof update.status === "string" ? update.status.toLowerCase() : "";
    const command = extractCommand(update);
    if (status.includes("complete") || status.includes("success")) return command === undefined
      ? { type: "tool.completed", payload: asJsonObject(update) }
      : { type: "command.completed", payload: { command, toolCall: asJsonObject(update) } };
    if (status.includes("fail") || status.includes("error")) return { type: "agent.error", payload: asJsonObject(update) };
    return command === undefined
      ? { type: "tool.output", payload: asJsonObject(update) }
      : { type: "command.output", payload: { command, toolCall: asJsonObject(update) } };
  }
  if (sessionUpdate === "session_info_update") return { type: "session.updated", payload: asJsonObject(update) };
  if (sessionUpdate === "current_mode_update" || sessionUpdate === "config_option_update") return { type: "session.status_changed", payload: asJsonObject(update) };
  return null;
}
