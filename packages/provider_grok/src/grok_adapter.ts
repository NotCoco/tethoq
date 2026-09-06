import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  type ProviderCapabilities,
  type RemoteMessage,
  type RemoteModel,
  type RemoteSession,
  type SessionTokenUsage,
  matchReasoningEffort,
  resolveModelReasoningProfile,
} from "../../protocol/src/index.js";
import {
  JsonLineProcessTransport,
  JsonRpcPeer,
  ProviderAdapterError,
  ProviderEventHub,
  UnsupportedProviderCapabilityError,
  providerPromptContent,
  stripProviderPromptGuidance,
  buildSpawnCommand,
  resolveCommand,
  type AgentProviderAdapter,
  type EnqueueProviderMessageRequest,
  type ProviderQueuedMessage,
  type RestoreProviderMessageRequest,
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
  acpUpdateLooksLikeThought,
  asJsonObject,
  completeAcpMessages,
  createMessageAccumulator,
  isRecord,
  normalizeAcpSubagentUpdate,
  normalizeAcpSession,
  type AcpProviderIdentity,
  type AcpMessageAccumulator,
} from "./normalize.js";
import {
  grokQueueEditParams,
  grokQueueInterjectParams,
  grokQueueRemoveParams,
  isGrokQueueChangedMethod,
  parseGrokQueueChanged,
  type GrokNativeQueuedMessage,
} from "./queue.js";

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

interface LocallyCreatedSession {
  readonly session: RemoteSession;
  readonly requestedTitle?: string;
  readonly preserveRequestedTitle?: boolean;
  readonly nativeConfirmed?: boolean;
}

interface ReportedSessionContext {
  readonly modelId?: string;
  readonly usedTokens?: number;
  readonly contextWindowTokens?: number;
  readonly usageUpdateSizeTokens?: number;
  readonly modelContextWindowTokens?: number;
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

interface NativeQueueInterjectionWaiter {
  readonly sessionId: string;
  readonly messageId: string;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface NativeQueueEntryWaiter {
  readonly sessionId: string;
  readonly nativeText: string;
  readonly visibleText: string;
  readonly fallbackId: string;
  readonly developerInstructions?: string;
  readonly excludedMessageIds: ReadonlySet<string>;
  readonly resolve: (message: ProviderQueuedMessage) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface DeferredPromptTerminal {
  readonly outcome: "completed" | "failed";
  readonly payload: Record<string, unknown>;
}

export interface AcpRuntimeOptions {
  readonly hostId: string;
  readonly cwd?: string;
  readonly transportFactory?: () => JsonRpcTransport;
  readonly requestTimeoutMs?: number;
  /** Grace period before a bridge-approved idle transport is closed. */
  readonly idleReleaseMs?: number;
  readonly now?: () => Date;
}

const defaultIdleReleaseMs = 3_000;

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

interface ScheduledPromptAcceptance {
  readonly requestId: string;
  readonly expectedPrompt: string;
  readonly accept: () => void;
}

function isScheduledMessageRequest(request: SendMessageRequest): boolean {
  const scheduledTaskId = request.metadata?.tethoqScheduledTaskId;
  return typeof scheduledTaskId === "string" && scheduledTaskId.trim().length > 0;
}

function normalizedScheduledPrompt(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function acpPromptText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string") return value.text;
  if (value.content !== value) return acpPromptText(value.content);
  return undefined;
}

function remoteMessagePromptText(message: RemoteMessage): string | undefined {
  const text = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
  return text.length > 0 ? text : undefined;
}

function remoteMessageMatchesScheduledPrompt(message: RemoteMessage, expectedPrompt: string): boolean {
  const nativeText = acpPromptText(message.nativeMetadata);
  const visibleText = remoteMessagePromptText(message);
  return [nativeText, visibleText].some((text) =>
    text !== undefined && normalizedScheduledPrompt(text) === expectedPrompt);
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
    if (promptId === undefined) return undefined;
    // Grok reuses a prompt ID for model streams separated by tool calls. Its
    // stream start is the stable boundary that keeps pre-tool narration from
    // swallowing the later final answer during session/load replay.
    const streamStart = [paramsMeta.streamStartMs, paramsMeta.stream_start_ms, updateMeta.streamStartMs, updateMeta.stream_start_ms]
      .find((value): value is string | number => (typeof value === "string" && value.length > 0)
        || (typeof value === "number" && Number.isFinite(value)));
    return streamStart === undefined
      ? `assistant_prompt_${promptId}`
      : `assistant_prompt_${promptId}_stream_${streamStart}`;
  }
  const promptIndex = updateMeta.promptIndex ?? updateMeta.prompt_index ?? paramsMeta.promptIndex ?? paramsMeta.prompt_index;
  if ((typeof promptIndex === "number" && Number.isSafeInteger(promptIndex))
    || (typeof promptIndex === "string" && promptIndex.length > 0)) {
    return `user_prompt_${promptIndex}`;
  }
  return undefined;
}

function historyMessageCreatedAt(
  params: Record<string, unknown>,
  update: Record<string, unknown>,
  fallback: Date,
): Date {
  const paramsMeta = isRecord(params._meta) ? params._meta : {};
  const updateMeta = isRecord(update._meta) ? update._meta : {};
  for (const timestampMs of [
    paramsMeta.agentTimestampMs,
    paramsMeta.agent_timestamp_ms,
    updateMeta.agentTimestampMs,
    updateMeta.agent_timestamp_ms,
  ]) {
    if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || timestampMs < 0) continue;
    const createdAt = new Date(timestampMs);
    if (Number.isFinite(createdAt.getTime())) return createdAt;
  }
  return fallback;
}

type InputModality = "text" | "image" | "audio";

function latestAcpChunkText(message: RemoteMessage): string | undefined {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if ((part?.type === "text" || part?.type === "reasoning") && part.text.trim().length > 0) return part.text;
  }
  return undefined;
}

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
  const meta = isRecord(entry._meta) ? entry._meta : {};
  return firstPositiveInteger(entry, ["contextWindowTokens", "context_window_tokens", "contextWindow", "context_window", "maxContextTokens", "max_context_tokens", "maxInputTokens", "max_input_tokens"])
    ?? firstPositiveInteger(limits, ["context", "contextTokens", "context_tokens", "contextWindow", "context_window", "input", "inputTokens", "input_tokens"])
    ?? firstPositiveInteger(capabilities, ["contextWindowTokens", "context_window_tokens", "contextWindow", "context_window", "maxInputTokens", "max_input_tokens"])
    ?? firstPositiveInteger(meta, ["totalContextTokens", "total_context_tokens", "contextWindowTokens", "context_window_tokens"]);
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
  const sharedReasoning = initializeReasoningProfile(response);
  const source = Array.isArray(state.availableModels)
    ? state.availableModels
    : Array.isArray(state.available_models)
      ? state.available_models
      : Array.isArray(state.models)
        ? state.models
        : [];
  return source.flatMap((entry): readonly RemoteModel[] => {
    if (typeof entry === "string") {
      return [modelRecord(providerId, entry, entry, entry === current, fallbackModalities, {}, sharedReasoning)];
    }
    if (!isRecord(entry)) return [];
    const id = [entry.id, entry.modelId, entry.model_id].find((value): value is string => typeof value === "string");
    if (id === undefined) return [];
    const displayName = typeof entry.name === "string" ? entry.name : id;
    const inputModalities = modelInputModalities(entry, fallbackModalities);
    return [modelRecord(
      providerId,
      id,
      displayName,
      id === current || entry.default === true,
      inputModalities,
      { ...entry, ...(typeof entry.description === "string" ? { description: entry.description } : {}) },
      sharedReasoning,
    )];
  });
}

function initializeReasoningProfile(response: AcpInitializeResponse): { readonly efforts: readonly string[]; readonly defaultEffort?: string } {
  const options = sessionConfigOptions(response) ?? sessionConfigOptions(response._meta) ?? [];
  const thought = configOptionFor(options, "thought_level");
  const efforts = thought?.values ?? [];
  return {
    efforts,
    ...(thought?.currentValue ? { defaultEffort: thought.currentValue } : {}),
  };
}

function modelRecord(
  providerId: string,
  id: string,
  displayName: string,
  isDefault: boolean,
  inputModalities: readonly InputModality[] | undefined,
  native: Record<string, unknown>,
  sharedReasoning: { readonly efforts: readonly string[]; readonly defaultEffort?: string },
): RemoteModel {
  const resolved = resolveModelReasoningProfile({
    providerId,
    modelId: id,
    displayName,
    advertised: native.supportedReasoningEfforts
      ?? native.reasoningEfforts
      ?? native.thoughtLevels
      ?? native.thought_levels
      ?? (sharedReasoning.efforts.length ? sharedReasoning.efforts : undefined),
  });
  const defaultEffort = resolved.defaultEffort ?? sharedReasoning.defaultEffort;
  return {
    id,
    providerId,
    displayName,
    ...(typeof native.description === "string" ? { description: native.description } : {}),
    isDefault,
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    nativeMetadata: {
      ...asJsonObject(native),
      ...(resolved.efforts.length ? { supportedReasoningEfforts: [...resolved.efforts] } : {}),
      ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    },
  };
}

interface ParsedReportedContext {
  readonly modelId?: string;
  readonly usedTokens?: number;
  readonly contextWindowTokens?: number;
  readonly usageUpdateSizeTokens?: number;
  readonly modelContextWindowTokens?: number;
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
  const occupancyKeys = ["usedTokens", "used_tokens", "contextTokens", "context_tokens", "tokensUsed", "tokens_used"] as const;
  const occupancy = firstNumber(contextSource, occupancyKeys);
  const usageUpdateUsed = firstPositiveInteger(contextSource, [
    "size",
    "contextWindowTokens",
    "context_window_tokens",
    "contextWindow",
    "context_window",
  ]) !== undefined
    ? firstNumber(contextSource, ["used"])
    : undefined;
  const metaUsedTokens = meta === undefined
    ? undefined
    : firstNumber(meta, ["totalTokens", "total_tokens", "contextTokens", "context_tokens"]);
  const usedTokens = occupancy ?? usageUpdateUsed ?? metaUsedTokens;
  const contextWindowTokens = firstPositiveInteger(contextSource, [
    "contextWindowTokens",
    "context_window_tokens",
    "contextWindow",
    "context_window",
    "maxContextTokens",
    "max_context_tokens",
  ]);
  const usageUpdateSizeTokens = firstPositiveInteger(contextSource, ["size"]);
  const rawPercent = firstNumber(contextSource, ["usedPercent", "used_percent", "percent", "percentage"]);
  const usedPercent = rawPercent !== undefined && rawPercent <= 100 ? rawPercent : undefined;
  let modelId: string | undefined;
  for (const root of [value, ...(meta === undefined ? [] : [meta]), ...(context === undefined ? [] : [context])]) {
    modelId ??= firstStringValue(root, ["modelId", "model_id", "model"]);
  }
  const reportedModel = reportedModelContext(value);
  modelId ??= reportedModel.modelId;
  if (modelId === undefined
    && usedTokens === undefined
    && contextWindowTokens === undefined
    && usageUpdateSizeTokens === undefined
    && reportedModel.contextWindowTokens === undefined
    && usedPercent === undefined
    && usage === undefined) return null;
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(usageUpdateSizeTokens !== undefined ? { usageUpdateSizeTokens } : {}),
    ...(reportedModel.contextWindowTokens !== undefined ? { modelContextWindowTokens: reportedModel.contextWindowTokens } : {}),
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

/** Harnesses spell the same field several ways; take the first that is present. */
function firstUpdateString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function reportedSessionTitle(source: unknown): string | undefined {
  return isRecord(source)
    ? firstUpdateString(source, ["title", "name", "sessionTitle", "session_title", "threadName", "thread_name"])
    : undefined;
}

function acpUpdatePromptId(
  params: Record<string, unknown>,
  update: Record<string, unknown>,
): string | undefined {
  const records = [
    update,
    ...(isRecord(update._meta) ? [update._meta] : []),
    params,
    ...(isRecord(params._meta) ? [params._meta] : []),
  ];
  for (const record of records) {
    const promptId = firstUpdateString(record, ["promptId", "prompt_id"]);
    if (promptId !== undefined) return promptId;
  }
  return undefined;
}

/**
 * The model block a harness returns from session/new, session/load and
 * session/resume. Grok states the level the session is running here, on the
 * currently selected model, and this is the only place a cold start can learn it:
 * its session listing carries no reasoning level at all.
 */
export function reportedModelSelection(value: unknown): { readonly modelId?: string; readonly reasoningEffort?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const models = isRecord(value.models) ? value.models : value;
  const available = Array.isArray(models.availableModels)
    ? models.availableModels
    : Array.isArray(models.available_models) ? models.available_models : undefined;
  if (available === undefined) return undefined;
  const modelId = firstUpdateString(models, ["currentModelId", "current_model_id", "modelId", "model_id"]);
  const current = available.find((entry) => isRecord(entry) && firstUpdateString(entry, ["modelId", "model_id", "id"]) === modelId)
    ?? available.find((entry) => isRecord(entry));
  const meta = isRecord(current) && isRecord(current._meta) ? current._meta : {};
  const reasoningEffort = firstUpdateString(meta, ["reasoningEffort", "reasoning_effort", "thoughtLevel", "thought_level"]);
  if (modelId === undefined && reasoningEffort === undefined) return undefined;
  return { ...(modelId !== undefined ? { modelId } : {}), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) };
}

function reportedModelContext(value: unknown): { readonly modelId?: string; readonly contextWindowTokens?: number } {
  if (!isRecord(value)) return {};
  const meta = isRecord(value._meta) ? value._meta : undefined;
  const models = isRecord(value.models)
    ? value.models
    : isRecord(value.modelState)
      ? value.modelState
      : isRecord(value.model_state)
        ? value.model_state
        : meta !== undefined && isRecord(meta.modelState)
          ? meta.modelState
          : meta !== undefined && isRecord(meta.model_state)
            ? meta.model_state
            : undefined;
  if (models === undefined) return {};
  const modelId = firstUpdateString(models, ["currentModelId", "current_model_id", "modelId", "model_id"]);
  const available = Array.isArray(models.availableModels)
    ? models.availableModels
    : Array.isArray(models.available_models)
      ? models.available_models
      : Array.isArray(models.models)
        ? models.models
        : [];
  const selected = available.find((entry) => isRecord(entry)
    && firstUpdateString(entry, ["modelId", "model_id", "id"]) === modelId);
  const contextWindowTokens = isRecord(selected) ? modelContextWindow(selected) : undefined;
  return {
    ...(modelId !== undefined ? { modelId } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

export function isAcpSessionsChangedMethod(method: string): boolean {
  return method === "_x.ai/sessions/changed" || method === "session/list_changed" || method === "sessions/changed";
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
  public readonly listQueuedMessages?: () => Promise<readonly ProviderQueuedMessage[]>;
  public readonly enqueueQueuedMessage?: (providerSessionId: string, request: EnqueueProviderMessageRequest) => Promise<ProviderQueuedMessage>;
  public readonly restoreQueuedMessage?: (providerSessionId: string, request: RestoreProviderMessageRequest) => Promise<ProviderQueuedMessage>;
  public readonly updateQueuedMessage?: (providerSessionId: string, messageId: string, content: string) => Promise<ProviderQueuedMessage | null>;
  public readonly cancelQueuedMessage?: (providerSessionId: string, messageId: string) => Promise<boolean>;
  public readonly steerQueuedMessage?: (providerSessionId: string, messageId: string, request: SendMessageRequest) => Promise<SendMessageResult>;
  public readonly steerMessage?: (providerSessionId: string, request: SendMessageRequest) => Promise<SendMessageResult>;

  readonly #hostId: string;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #cwd: string | undefined;
  readonly #transportFactory: (() => JsonRpcTransport) | undefined;
  readonly #requestTimeoutMs: number;
  readonly #idleReleaseMs: number;
  readonly #now: () => Date;
  readonly #identity: AcpProviderIdentity;
  readonly #capabilityNote: string;
  readonly #events = new ProviderEventHub();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #sessionContexts = new Map<string, SessionContext>();
  readonly #historyCapture = new Map<string, AcpMessageAccumulator>();
  readonly #historyReportedContexts = new Map<string, ReportedSessionContext>();
  readonly #historyLoads = new Map<string, Promise<readonly RemoteMessage[]>>();
  readonly #liveMessages = new Map<string, AcpMessageAccumulator>();
  readonly #lastLoadedMessages = new Map<string, readonly RemoteMessage[]>();
  readonly #lastLiveUpdateAt = new Map<string, number>();
  readonly #reportedContexts = new Map<string, ReportedSessionContext>();
  readonly #contextHydratedSessions = new Set<string>();
  readonly #sessionConfigOptions = new Map<string, readonly AcpSessionConfigOption[]>();
  readonly #appliedSessionSelections = new Map<string, AppliedSessionSelections>();
  readonly #sessionMcpBindings = new Map<string, SessionMcpBinding>();
  readonly #sessionClientToolModes = new Map<string, "enabled" | "disabled">();
  readonly #openableSubagentSessions = new Map<string, string>();
  readonly #eyesToolCallIds = new Map<string, Set<string>>();
  readonly #activeToolCallIds = new Map<string, Map<string, string | undefined>>();
  readonly #activeSessions = new Set<string>();
  readonly #locallyCreatedSessions = new Map<string, LocallyCreatedSession>();
  readonly #reportedSessionTitles = new Map<string, string>();
  readonly #watchedSessions = new Set<string>();
  readonly #activePrompts = new Set<string>();
  readonly #promptEpochs = new Map<string, number>();
  readonly #inFlightPromptCounts = new Map<string, number>();
  readonly #deferredPromptTerminals = new Map<string, DeferredPromptTerminal>();
  readonly #scheduledPromptAcceptances = new Map<string, Set<ScheduledPromptAcceptance>>();
  readonly #nativeQueues = new Map<string, readonly GrokNativeQueuedMessage[]>();
  readonly #runningPromptIds = new Map<string, string>();
  readonly #queueWaiters: NativeQueueEntryWaiter[] = [];
  readonly #nativeQueueContents = new Map<string, ReadonlyMap<string, string>>();
  readonly #claimedNativeQueueEntries = new Map<string, Set<string>>();
  readonly #nativeQueueInterjectionWaiters: NativeQueueInterjectionWaiter[] = [];
  #peer: JsonRpcPeer | null = null;
  #startingPeer: JsonRpcPeer | null = null;
  #initializing: Promise<JsonRpcPeer> | null = null;
  #closing: Promise<void> | null = null;
  #idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  #resourceGeneration = 0;
  #disposed = false;
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
    this.#idleReleaseMs = options.idleReleaseMs ?? defaultIdleReleaseMs;
    this.#now = options.now ?? (() => new Date());
    this.#identity = {
      providerId: options.providerId,
      displayName: options.displayName,
      ...(options.sessionLabel !== undefined ? { sessionLabel: options.sessionLabel } : {}),
    };
    this.#capabilityNote = options.capabilityNote ?? `Uses the documented Agent Client Protocol mode exposed by ${options.displayName}.`;
    if (options.providerId === "grok") {
      this.listQueuedMessages = async () => this.listNativeQueuedMessages();
      this.enqueueQueuedMessage = async (providerSessionId, request) => await this.enqueueNativeQueuedMessage(providerSessionId, request);
      this.restoreQueuedMessage = async (providerSessionId, request) => await this.enqueueNativeQueuedMessage(providerSessionId, request);
      this.updateQueuedMessage = async (providerSessionId, messageId, content) => await this.updateNativeQueuedMessage(providerSessionId, messageId, content);
      this.cancelQueuedMessage = async (providerSessionId, messageId) => await this.cancelNativeQueuedMessage(providerSessionId, messageId);
      this.steerQueuedMessage = async (providerSessionId, messageId, request) => await this.interjectNativeQueuedMessage(providerSessionId, messageId, request);
      this.steerMessage = async (providerSessionId, request) => await this.interjectMessage(providerSessionId, request);
    }
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
      steering: this.providerId === "grok",
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
        ...(this.providerId === "grok"
          ? ["Grok steering uses its native ACP interjection extensions; queued steering is versioned and atomically removed from the shared queue."]
          : []),
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
    const initial = this.#reportedContexts.get(providerSessionId);
    const initialModelId = initial?.modelId
      ?? this.#appliedSessionSelections.get(providerSessionId)?.modelId
      ?? currentModelId(response);
    const initialModel = initialModelId === undefined
      ? modelEntries(response, this.providerId).find((entry) => entry.isDefault)
      : modelEntries(response, this.providerId).find((entry) => entry.id === initialModelId);
    const hasContextWindow = initial?.contextWindowTokens !== undefined
      || initial?.modelContextWindowTokens !== undefined
      || initial?.usageUpdateSizeTokens !== undefined
      || (initialModel !== undefined && modelContextWindow(initialModel.nativeMetadata) !== undefined);
    if (!this.#contextHydratedSessions.has(providerSessionId)
      && (!hasContextWindow || initial?.usedTokens === undefined)) {
      await this.getMessages(providerSessionId).catch(() => this.listSessions().catch(() => undefined));
    } else if (initial?.usedTokens === undefined) {
      await this.listSessions().catch(() => undefined);
    }
    const reported = this.#reportedContexts.get(providerSessionId);
    const modelId = reported?.modelId
      ?? this.#appliedSessionSelections.get(providerSessionId)?.modelId
      ?? currentModelId(response);
    const model = modelId === undefined
      ? modelEntries(response, this.providerId).find((entry) => entry.isDefault)
      : modelEntries(response, this.providerId).find((entry) => entry.id === modelId);
    const contextWindowTokens = reported?.contextWindowTokens
      ?? reported?.modelContextWindowTokens
      ?? (model === undefined ? undefined : modelContextWindow(model.nativeMetadata))
      ?? reported?.usageUpdateSizeTokens;
    // Occupancy (context_usage) is the authoritative "used" figure when the
    // harness reports it; otherwise the latest request's total is the closest
    // truthful proxy for the context actually in use, so the panel reconciles
    // with the reported Input / Output figures instead of showing Unavailable.
    const usedTokens = reported?.usedTokens
      ?? (reported?.usage?.totalTokens !== undefined ? reported.usage.totalTokens : undefined);
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
      let session = normalizeAcpSession(this.#hostId, entry, this.#now(), this.#identity);
      const providerTitle = reportedSessionTitle(entry);
      if (providerTitle !== undefined) this.#reportedSessionTitles.set(session.providerSessionId, providerTitle);
      this.captureReportedContext(session.providerSessionId, entry);
      this.captureSessionConfigOptions(session.providerSessionId, entry);
      if (session.workingDirectory !== undefined) this.#sessionContexts.set(session.providerSessionId, { cwd: session.workingDirectory, additionalDirectories: additionalDirectories(entry) });
      const local = this.#locallyCreatedSessions.get(session.providerSessionId);
      if (local?.preserveRequestedTitle === true && local.requestedTitle !== undefined) {
        session = { ...session, title: local.requestedTitle };
      }
      const decorated = this.decorateSessionSelections(session);
      if (local !== undefined) this.#locallyCreatedSessions.set(session.providerSessionId, { ...local, session: decorated, nativeConfirmed: true });
      return decorated;
    });
    const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
    if (nextCursor === null) {
      const listedIds = new Set(sessions.map((session) => session.providerSessionId));
      const missing = [...this.#locallyCreatedSessions.values()]
        .filter(({ session, nativeConfirmed }) => nativeConfirmed !== true
          && !listedIds.has(session.providerSessionId)
          && (options.workingDirectory === undefined || session.workingDirectory === options.workingDirectory))
        .map(({ session }) => this.decorateSessionSelections(session))
        .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
      sessions.unshift(...missing);
    }
    const hasUnconfirmedLocalSession = [...this.#locallyCreatedSessions.values()].some(({ session, nativeConfirmed }) =>
      nativeConfirmed !== true
      && (options.workingDirectory === undefined || session.workingDirectory === options.workingDirectory));
    return {
      sessions,
      nextCursor,
      ...(nextCursor !== null && hasUnconfirmedLocalSession ? { authoritative: false } : {}),
    };
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
    const inflight = this.#historyLoads.get(providerSessionId);
    if (inflight !== undefined) return await inflight;
    // Only skip a history reload while live chunks are actually arriving.
    // An attached-but-quiet session must still be able to catch up — otherwise
    // a Grok CLI turn that never pushed session/update stays frozen forever.
    if (this.shouldKeepLiveTail(providerSessionId)) return this.historyWithLiveTail(providerSessionId);
    const load = this.loadSessionHistory(providerSessionId);
    this.#historyLoads.set(providerSessionId, load);
    try {
      return await load;
    } finally {
      if (this.#historyLoads.get(providerSessionId) === load) this.#historyLoads.delete(providerSessionId);
    }
  }

  private shouldKeepLiveTail(providerSessionId: string): boolean {
    // Reloading history mid-turn swallows session/update notifications into the
    // load accumulator, so the open chat freezes and reasoning never shimmers.
    return this.hasActiveTurn(providerSessionId);
  }

  private async loadSessionHistory(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const capabilities = await this.getCapabilities();
    if (!capabilities.sessionHistory) throw new UnsupportedProviderCapabilityError(this.providerId, "session/load history replay");
    const context = await this.contextFor(providerSessionId);
    const accumulator = createMessageAccumulator();
    this.#historyCapture.set(providerSessionId, accumulator);
    const priorContext = this.#reportedContexts.get(providerSessionId);
    if (priorContext !== undefined) this.#historyReportedContexts.set(providerSessionId, priorContext);
    try {
      const result = await (await this.peer()).request("session/load", {
        sessionId: providerSessionId,
        cwd: context.cwd,
        additionalDirectories: context.additionalDirectories,
        mcpServers: this.mcpServers(providerSessionId),
      });
      const replayedContext = this.#historyReportedContexts.get(providerSessionId);
      if (replayedContext !== undefined) this.#reportedContexts.set(providerSessionId, replayedContext);
      this.captureReportedContext(providerSessionId, result);
      this.#contextHydratedSessions.add(providerSessionId);
      this.captureSessionConfigOptions(providerSessionId, result);
      this.captureReportedModels(providerSessionId, result);
      this.#sessionClientToolModes.set(providerSessionId, this.#clientTooling === undefined ? "disabled" : "enabled");
      this.#activeSessions.add(providerSessionId);
      const messages = await this.hydrateCapturedSubagentLinks(providerSessionId, completeAcpMessages(accumulator, this.#now()));
      this.#lastLoadedMessages.set(providerSessionId, messages);
      return messages;
    } finally {
      this.#historyCapture.delete(providerSessionId);
      this.#historyReportedContexts.delete(providerSessionId);
    }
  }

  public async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    const clientToolsEnabled = options.mcpServers !== "none"
      && options.clientTools !== "none"
      && this.#clientTooling !== undefined;
    const binding = !clientToolsEnabled
      ? undefined
      : this.#clientTooling?.createSessionBinding?.(this.providerId, "provider");
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
    this.captureReportedModels(response.sessionId, response);
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
    const decorated = this.decorateSessionSelections(session);
    this.#locallyCreatedSessions.set(response.sessionId, {
      session: decorated,
      ...(options.title !== undefined && options.title.trim().length > 0 ? { requestedTitle: decorated.title } : {}),
    });
    await this.emit({ type: "session.created", providerSessionId: response.sessionId, payload: { session: session.nativeMetadata } });
    if (options.firstInstruction !== undefined && options.firstInstruction.trim().length > 0) {
      await this.sendMessage(response.sessionId, {
        requestId: randomUUID(),
        content: options.firstInstruction,
        ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      });
    }
    return decorated;
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
      this.captureReportedModels(providerSessionId, result);
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
      this.captureReportedModels(providerSessionId, result);
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
    const scheduled = isScheduledMessageRequest(request);
    if (scheduled) {
      const local = this.#locallyCreatedSessions.get(providerSessionId);
      if (local?.requestedTitle !== undefined) {
        this.#locallyCreatedSessions.set(providerSessionId, { ...local, preserveRequestedTitle: true });
      }
      const existing = await this.acceptedScheduledMessage(providerSessionId, request);
      if (existing !== null) return existing;
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
    await this.dispatchNativePrompt(providerSessionId, request, scheduled);
    return {
      accepted: true,
      providerTurnId: request.requestId,
      details: [scheduled
        ? "ACP session/prompt was accepted."
        : "ACP session/prompt accepted; updates arrive through session/update notifications"],
    };
  }

  private async acceptedScheduledMessage(
    providerSessionId: string,
    request: SendMessageRequest,
  ): Promise<SendMessageResult | null> {
    const messages = await this.getMessages(providerSessionId);
    const expectedPrompt = normalizedScheduledPrompt(providerPromptContent(request));
    if (!messages.some((message) =>
      message.role === "user" && remoteMessageMatchesScheduledPrompt(message, expectedPrompt))) return null;
    return {
      accepted: true,
      providerTurnId: request.requestId,
      details: [`${this.displayName} already accepted this scheduled prompt.`],
    };
  }

  public hasActiveTurn(providerSessionId: string): boolean {
    const lastLive = this.#lastLiveUpdateAt.get(providerSessionId);
    return this.#activePrompts.has(providerSessionId)
      || (this.#nativeQueues.get(providerSessionId)?.length ?? 0) > 0
      || this.#runningPromptIds.has(providerSessionId)
      || (this.#activeToolCallIds.get(providerSessionId)?.size ?? 0) > 0
      || (lastLive !== undefined && this.#now().getTime() - lastLive < 15_000);
  }

  public async watchSession(providerSessionId: string): Promise<void> {
    this.#watchedSessions.add(providerSessionId);
    this.cancelIdleRelease();
    if (this.#peer !== null && this.#activeSessions.has(providerSessionId) && this.#lastLoadedMessages.has(providerSessionId)) {
      return;
    }
    await this.getMessages(providerSessionId);
  }

  public unwatchSession(providerSessionId: string): void {
    this.#watchedSessions.delete(providerSessionId);
  }

  private historyWithLiveTail(providerSessionId: string): readonly RemoteMessage[] {
    const loaded = this.#lastLoadedMessages.get(providerSessionId) ?? [];
    const live = this.#liveMessages.get(providerSessionId);
    if (live === undefined) return loaded;
    const liveMessages = live.orderedIds.flatMap((id) => {
      const message = live.messages.get(id);
      return message === undefined ? [] : [message];
    });
    if (liveMessages.length === 0) return loaded;
    const byId = new Map(loaded.map((message) => [message.providerMessageId, message]));
    for (const message of liveMessages) byId.set(message.providerMessageId, message);
    const extras = liveMessages.filter((message) => !loaded.some((entry) => entry.providerMessageId === message.providerMessageId));
    return [...loaded.map((message) => byId.get(message.providerMessageId) ?? message), ...extras];
  }

  private markLiveTurn(providerSessionId: string): void {
    this.#lastLiveUpdateAt.set(providerSessionId, this.#now().getTime());
  }

  private listNativeQueuedMessages(): readonly ProviderQueuedMessage[] {
    return [...this.#nativeQueues.values()].flat();
  }

  private async enqueueNativeQueuedMessage(
    providerSessionId: string,
    request: EnqueueProviderMessageRequest,
  ): Promise<ProviderQueuedMessage> {
    const attachments = request.attachments ?? [];
    if (attachments.some((attachment) => !attachment.mimeType.toLowerCase().startsWith("image/"))) {
      throw new UnsupportedProviderCapabilityError(this.providerId, "non-image attachments");
    }
    if (!this.#activeSessions.has(providerSessionId)) await this.resumeSession(providerSessionId);
    await this.applySessionSelections(providerSessionId, request.modelId, request.reasoningEffort);
    const visibleContent = stripProviderPromptGuidance(request.content);
    const nativeContent = providerPromptContent({ ...request, content: visibleContent });
    const pending = this.waitForNativeQueueEntry(
      providerSessionId,
      nativeContent,
      visibleContent,
      request.requestId,
      request.developerInstructions,
    );
    // Do not fabricate a queued fallback when the ACP transport never accepted
    // the prompt. Owning the send promise also prevents a rejected peer/start
    // operation from escaping as an unhandled rejection.
    try {
      await this.dispatchNativePrompt(providerSessionId, { ...request, content: visibleContent });
    } catch (error) {
      pending.cancel();
      throw error;
    }
    return await pending.promise;
  }

  private async updateNativeQueuedMessage(
    providerSessionId: string,
    messageId: string,
    content: string,
  ): Promise<ProviderQueuedMessage | null> {
    const trimmed = content.trim();
    if (!trimmed) return null;
    const current = this.#nativeQueues.get(providerSessionId)?.find((entry) => entry.id === messageId);
    if (current === undefined) return null;
    await (await this.peer()).notify("_x.ai/queue/edit", grokQueueEditParams(providerSessionId, messageId, trimmed));
    const updated = { ...current, content: trimmed };
    this.#nativeQueues.set(providerSessionId, (this.#nativeQueues.get(providerSessionId) ?? []).map((entry) => (
      entry.id === messageId ? updated : entry
    )));
    const nativeContents = new Map(this.#nativeQueueContents.get(providerSessionId) ?? []);
    nativeContents.set(messageId, trimmed);
    this.#nativeQueueContents.set(providerSessionId, nativeContents);
    await this.publishNativeQueue();
    return updated;
  }

  private async cancelNativeQueuedMessage(providerSessionId: string, messageId: string): Promise<boolean> {
    const current = this.#nativeQueues.get(providerSessionId) ?? [];
    if (!current.some((entry) => entry.id === messageId)) return false;
    await (await this.peer()).notify("_x.ai/queue/remove", grokQueueRemoveParams(providerSessionId, messageId));
    this.#nativeQueues.set(providerSessionId, current.filter((entry) => entry.id !== messageId));
    const nativeContents = new Map(this.#nativeQueueContents.get(providerSessionId) ?? []);
    nativeContents.delete(messageId);
    this.#nativeQueueContents.set(providerSessionId, nativeContents);
    this.#claimedNativeQueueEntries.get(providerSessionId)?.delete(messageId);
    await this.publishNativeQueue();
    await this.flushDeferredPromptTerminal(providerSessionId);
    return true;
  }

  private async interjectNativeQueuedMessage(
    providerSessionId: string,
    messageId: string,
    request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    const current = this.#nativeQueues.get(providerSessionId)?.find((entry) => entry.id === messageId);
    if (current === undefined) {
      throw new ProviderAdapterError(
        this.providerId,
        "QUEUE_MESSAGE_NOT_FOUND",
        "That Grok queued instruction is no longer available to steer",
        false,
      );
    }
    const visibleText = stripProviderPromptGuidance(request.content);
    const text = providerPromptContent({ ...request, content: visibleText });
    const nativeText = this.#nativeQueueContents.get(providerSessionId)?.get(messageId) ?? current.content;
    const confirmation = this.waitForNativeQueueInterjection(providerSessionId, messageId);
    // Own a possible short confirmation timeout while the transport write is
    // still pending. The caller awaits the same promise immediately after it.
    void confirmation.promise.catch(() => undefined);
    try {
      await (await this.peer()).notify("_x.ai/queue/interject", grokQueueInterjectParams(
        providerSessionId,
        messageId,
        current.version,
        text === nativeText ? undefined : text,
      ));
    } catch (error) {
      confirmation.cancel();
      throw error;
    }
    await confirmation.promise;
    return {
      accepted: true,
      providerTurnId: request.requestId,
      details: ["Grok atomically removed the queued instruction and accepted it as a native ACP interjection."],
    };
  }

  private async interjectMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    // Grok 1.0.13 exposes atomic queue interjection but not the newer direct
    // x.ai/interject request. Put the instruction under Grok's durable queue
    // ownership first, then promote that exact versioned row. If promotion is
    // not confirmed, the row remains visible and retryable instead of being
    // silently downgraded to an ordinary follow-up or lost after cancellation.
    const context = await this.contextFor(providerSessionId);
    const queued = await this.enqueueNativeQueuedMessage(providerSessionId, {
      ...request,
      workingDirectory: context.cwd,
    });
    return await this.interjectNativeQueuedMessage(providerSessionId, queued.id, request);
  }

  private waitForNativeQueueInterjection(
    providerSessionId: string,
    messageId: string,
  ): { readonly promise: Promise<void>; cancel(): void } {
    let waiter: NativeQueueInterjectionWaiter;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#nativeQueueInterjectionWaiters.indexOf(waiter);
        if (index >= 0) this.#nativeQueueInterjectionWaiters.splice(index, 1);
        reject(new ProviderAdapterError(
          this.providerId,
          "QUEUE_INTERJECTION_UNCONFIRMED",
          "Grok did not confirm the queued instruction as an interjection; it remains available to retry",
          true,
        ));
      }, Math.max(1, Math.min(this.#requestTimeoutMs, 5_000)));
      waiter = { sessionId: providerSessionId, messageId, resolve, reject, timer };
      this.#nativeQueueInterjectionWaiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        const index = this.#nativeQueueInterjectionWaiters.indexOf(waiter);
        if (index < 0) return;
        this.#nativeQueueInterjectionWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve();
      },
    };
  }

  private confirmNativeQueueInterjection(providerSessionId: string, messageId: string): void {
    const remaining = [...this.#nativeQueueInterjectionWaiters];
    this.#nativeQueueInterjectionWaiters.length = 0;
    for (const waiter of remaining) {
      if (waiter.sessionId === providerSessionId && waiter.messageId === messageId) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        this.#nativeQueueInterjectionWaiters.push(waiter);
      }
    }
  }

  private waitForNativeQueueEntry(
    providerSessionId: string,
    nativeText: string,
    visibleText: string,
    fallbackId: string,
    developerInstructions: string | undefined,
  ): { readonly promise: Promise<ProviderQueuedMessage>; cancel(): void } {
    const excludedMessageIds = new Set((this.#nativeQueues.get(providerSessionId) ?? []).map((entry) => entry.id));
    let waiter!: NativeQueueEntryWaiter;
    const promise = new Promise<ProviderQueuedMessage>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#queueWaiters.indexOf(waiter);
        if (index >= 0) this.#queueWaiters.splice(index, 1);
        const late = this.claimNativeQueueEntry(waiter);
        resolve(late ?? {
          id: fallbackId,
          providerSessionId,
          content: visibleText,
          state: "queued",
          createdAt: this.#now().toISOString(),
          ...(developerInstructions !== undefined ? { developerInstructions } : {}),
        });
      }, 1_500);
      waiter = {
        sessionId: providerSessionId,
        nativeText,
        visibleText,
        fallbackId,
        ...(developerInstructions !== undefined ? { developerInstructions } : {}),
        excludedMessageIds,
        resolve,
        timer,
      };
      this.#queueWaiters.push(waiter);
    });
    return {
      promise,
      cancel: () => {
        const index = this.#queueWaiters.indexOf(waiter);
        if (index < 0) return;
        this.#queueWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
      },
    };
  }

  private claimNativeQueueEntry(waiter: NativeQueueEntryWaiter): ProviderQueuedMessage | undefined {
    const claimed = this.#claimedNativeQueueEntries.get(waiter.sessionId) ?? new Set<string>();
    const nativeContents = this.#nativeQueueContents.get(waiter.sessionId);
    const match = this.#nativeQueues.get(waiter.sessionId)?.find((entry) =>
      !waiter.excludedMessageIds.has(entry.id)
      && !claimed.has(entry.id)
      && nativeContents?.get(entry.id) === waiter.nativeText);
    if (match === undefined) return undefined;
    claimed.add(match.id);
    this.#claimedNativeQueueEntries.set(waiter.sessionId, claimed);
    return {
      ...match,
      content: waiter.visibleText,
      ...(waiter.developerInstructions !== undefined ? { developerInstructions: waiter.developerInstructions } : {}),
    };
  }

  private async dispatchNativePrompt(
    providerSessionId: string,
    request: SendMessageRequest,
    awaitRemoteResult = false,
  ): Promise<void> {
    const attachments = request.attachments ?? [];
    const peer = await this.peer();
    const prompt = providerPromptContent(request);
    const scheduledAcceptance = awaitRemoteResult
      ? this.waitForScheduledPromptAcceptance(providerSessionId, request.requestId, prompt)
      : undefined;
    // The waiter starts before the frame is sent so a synchronous echo cannot
    // be missed. Own its rejection while transport delivery is still pending.
    if (scheduledAcceptance !== undefined) void scheduledAcceptance.promise.catch(() => undefined);
    let started: ReturnType<JsonRpcPeer["startRequest"]>;
    try {
      started = peer.startRequest<unknown>("session/prompt", {
        sessionId: providerSessionId,
        prompt: [
          { type: "text", text: prompt },
          ...attachments.map((attachment) => ({
            type: "image",
            data: attachment.dataBase64,
            mimeType: attachment.mimeType,
          })),
        ],
      }, { timeoutMs: null });
    } catch (error) {
      scheduledAcceptance?.dispose();
      throw error;
    }
    void this.emit({ type: "session.status_changed", providerSessionId, payload: { state: "working" } });
    this.#inFlightPromptCounts.set(providerSessionId, (this.#inFlightPromptCounts.get(providerSessionId) ?? 0) + 1);
    this.#activePrompts.add(providerSessionId);
    const promptEpoch = this.#promptEpochs.get(providerSessionId) ?? 0;
    const promptIsCurrent = (): boolean => !this.#disposed
      && (this.#promptEpochs.get(providerSessionId) ?? 0) === promptEpoch;
    const completion = started.result.then(async (result) => {
      if (!promptIsCurrent()) return;
      this.captureReportedContext(providerSessionId, result);
      await this.settleNativePrompt(providerSessionId, "completed", { result: asJsonObject(result) });
    }).catch(async (error: unknown) => {
      if (!promptIsCurrent()) return;
      await this.settleNativePrompt(providerSessionId, "failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    // Ordinary interactive sends retain their frame-accepted behavior. Own the
    // eventual result rejection even when no caller waits for it.
    void completion.catch(() => undefined);
    try {
      try {
        await started.sent;
      } catch (error) {
        await completion.catch(() => undefined);
        throw error;
      }
      // For a scheduled task, the provider's valid echoed user chunk is durable
      // acceptance. Do not wait for the whole model/tool turn (or its request
      // timeout) before allowing the scheduler to settle the task as started.
      if (awaitRemoteResult) await Promise.race([completion, scheduledAcceptance!.promise]);
    } finally {
      scheduledAcceptance?.dispose();
    }
  }

  private waitForScheduledPromptAcceptance(providerSessionId: string, requestId: string, expectedPrompt: string): {
    readonly promise: Promise<void>;
    readonly dispose: () => void;
  } {
    let active = true;
    let acceptance!: ScheduledPromptAcceptance;
    const acceptances = this.#scheduledPromptAcceptances.get(providerSessionId) ?? new Set<ScheduledPromptAcceptance>();
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<void>((resolve, reject) => {
      acceptance = {
        requestId,
        expectedPrompt: normalizedScheduledPrompt(expectedPrompt),
        accept: () => {
          if (!active) return;
          active = false;
          clearTimeout(timer);
          acceptances.delete(acceptance);
          if (acceptances.size === 0) this.#scheduledPromptAcceptances.delete(providerSessionId);
          resolve();
        },
      };
      timer = setTimeout(() => {
        if (!active) return;
        active = false;
        acceptances.delete(acceptance);
        if (acceptances.size === 0) this.#scheduledPromptAcceptances.delete(providerSessionId);
        reject(new ProviderAdapterError(
          this.providerId,
          "SCHEDULED_PROMPT_OUTCOME_UNCERTAIN",
          "The scheduled prompt was sent, but ACP did not confirm acceptance before the timeout, so its outcome is uncertain. Retry explicitly if needed.",
          false,
        ));
      }, this.#requestTimeoutMs);
    });
    acceptances.add(acceptance);
    this.#scheduledPromptAcceptances.set(providerSessionId, acceptances);
    return {
      promise,
      dispose: () => {
        active = false;
        clearTimeout(timer);
        acceptances.delete(acceptance);
        if (acceptances.size === 0) this.#scheduledPromptAcceptances.delete(providerSessionId);
      },
    };
  }

  private acceptScheduledPrompt(providerSessionId: string, echoedPrompt: string): void {
    const acceptances = this.#scheduledPromptAcceptances.get(providerSessionId);
    if (acceptances === undefined) return;
    const normalizedPrompt = normalizedScheduledPrompt(echoedPrompt);
    for (const acceptance of [...acceptances]) {
      if (acceptance.expectedPrompt === normalizedPrompt) acceptance.accept();
    }
  }

  private async settleNativePrompt(
    providerSessionId: string,
    outcome: "completed" | "failed",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const remaining = (this.#inFlightPromptCounts.get(providerSessionId) ?? 1) - 1;
    if (remaining > 0) {
      this.#inFlightPromptCounts.set(providerSessionId, remaining);
      return;
    }
    this.#inFlightPromptCounts.delete(providerSessionId);
    this.#activePrompts.delete(providerSessionId);
    // A real queued entry still owns future work, so do not paint the session
    // complete until that durable row is removed or promoted. A running-prompt
    // ID alone is not a terminal veto here: Grok can leave the promoted ID in
    // its last queue snapshot after the corresponding session/prompt RPC has
    // resolved. That RPC result is authoritative for Tethoq-owned work.
    if ((this.#nativeQueues.get(providerSessionId)?.length ?? 0) > 0
      || (this.#activeToolCallIds.get(providerSessionId)?.size ?? 0) > 0) {
      this.#deferredPromptTerminals.set(providerSessionId, { outcome, payload });
      return;
    }
    await this.emitPromptTerminal(providerSessionId, outcome, payload);
  }

  private async emitPromptTerminal(
    providerSessionId: string,
    outcome: "completed" | "failed" | "interrupted",
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.#deferredPromptTerminals.delete(providerSessionId);
    this.#runningPromptIds.delete(providerSessionId);
    // Recent chunks used to suppress this event. They are the wrong signal: the
    // prompt has resolved, so the turn is over however recently it streamed.
    // Without the terminal event the task stayed "working" and its rows kept
    // shimmering until the user clicked away.
    this.#lastLiveUpdateAt.delete(providerSessionId);
    this.#liveMessages.delete(providerSessionId);
    await this.emit({
      type: outcome === "completed" ? "agent.completed" : outcome === "interrupted" ? "agent.interrupted" : "agent.error",
      providerSessionId,
      payload: asJsonObject(payload),
    });
  }

  private async flushDeferredPromptTerminal(providerSessionId: string): Promise<void> {
    const terminal = this.#deferredPromptTerminals.get(providerSessionId);
    if (terminal === undefined
      || this.#activePrompts.has(providerSessionId)
      || this.#inFlightPromptCounts.has(providerSessionId)
      || this.#runningPromptIds.has(providerSessionId)
      || (this.#activeToolCallIds.get(providerSessionId)?.size ?? 0) > 0
      || (this.#nativeQueues.get(providerSessionId)?.length ?? 0) > 0) return;
    await this.emitPromptTerminal(providerSessionId, terminal.outcome, terminal.payload);
  }

  private applyReportedSessionList(params: unknown): void {
    if (!isRecord(params)) return;
    if (Array.isArray(params.upserted)) {
      for (const entry of params.upserted) {
        if (!isRecord(entry)) continue;
        const sessionId = firstUpdateString(entry, ["sessionId", "session_id", "id"]);
        if (sessionId === undefined) continue;
        this.captureReportedTitle(sessionId, entry);
        this.captureReportedSelection(
          sessionId,
          firstUpdateString(entry, ["modelId", "model_id", "model"]),
          firstUpdateString(entry, ["reasoningEffort", "reasoning_effort", "thoughtLevel", "thought_level"]),
        );
      }
    }
    if (Array.isArray(params.removed)) {
      for (const entry of params.removed) {
        const sessionId = typeof entry === "string"
          ? entry
          : isRecord(entry) ? firstUpdateString(entry, ["sessionId", "session_id", "id"]) : undefined;
        if (sessionId !== undefined) {
          this.#locallyCreatedSessions.delete(sessionId);
          this.#reportedSessionTitles.delete(sessionId);
        }
      }
    }
  }

  private async applyNativeQueueChanged(params: unknown): Promise<void> {
    const snapshot = parseGrokQueueChanged(params, this.#now());
    if (snapshot === undefined) return;
    const previous = new Map((this.#nativeQueues.get(snapshot.sessionId) ?? []).map((entry) => [entry.id, entry]));
    this.#nativeQueueContents.set(snapshot.sessionId, new Map(snapshot.entries.map((entry) => [entry.id, entry.content])));
    this.#nativeQueues.set(snapshot.sessionId, snapshot.entries.map((entry) => ({
      ...entry,
      content: stripProviderPromptGuidance(entry.content),
      createdAt: previous.get(entry.id)?.createdAt ?? entry.createdAt,
    })));
    const currentIds = new Set(snapshot.entries.map((entry) => entry.id));
    const claimed = this.#claimedNativeQueueEntries.get(snapshot.sessionId);
    if (claimed !== undefined) {
      for (const id of claimed) {
        if (!currentIds.has(id)) claimed.delete(id);
      }
      if (claimed.size === 0) this.#claimedNativeQueueEntries.delete(snapshot.sessionId);
    }
    if (snapshot.runningPromptId !== undefined) {
      this.#runningPromptIds.set(snapshot.sessionId, snapshot.runningPromptId);
      this.confirmNativeQueueInterjection(snapshot.sessionId, snapshot.runningPromptId);
    }
    else this.#runningPromptIds.delete(snapshot.sessionId);
    const remaining = [...this.#queueWaiters];
    this.#queueWaiters.length = 0;
    for (const waiter of remaining) {
      const match = snapshot.sessionId === waiter.sessionId ? this.claimNativeQueueEntry(waiter) : undefined;
      if (match !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(match);
        continue;
      }
      this.#queueWaiters.push(waiter);
    }
    await this.publishNativeQueue();
    await this.flushDeferredPromptTerminal(snapshot.sessionId);
  }

  private async publishNativeQueue(): Promise<void> {
    await this.emit({
      type: "message.queue_updated",
      payload: asJsonObject({ messages: this.listNativeQueuedMessages() }),
    });
  }

  public async interrupt(providerSessionId: string): Promise<void> {
    await (await this.peer()).notify("session/cancel", { sessionId: providerSessionId });
    this.#promptEpochs.set(providerSessionId, (this.#promptEpochs.get(providerSessionId) ?? 0) + 1);
    this.#inFlightPromptCounts.delete(providerSessionId);
    this.#deferredPromptTerminals.delete(providerSessionId);
    this.#activePrompts.delete(providerSessionId);
    this.#activeToolCallIds.delete(providerSessionId);
    for (const [requestId, pending] of this.#pendingPermissions) {
      if (pending.providerSessionId !== providerSessionId) continue;
      this.#pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    await this.emitPromptTerminal(providerSessionId, "interrupted", {});
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
    for (const pending of this.#pendingPermissions.values()) pending.reject(new Error(`${this.displayName} adapter disposed`));
    this.#pendingPermissions.clear();
    this.#historyCapture.clear();
    this.#historyReportedContexts.clear();
    this.#liveMessages.clear();
    this.#lastLoadedMessages.clear();
    this.#lastLiveUpdateAt.clear();
    this.#watchedSessions.clear();
    this.#activePrompts.clear();
    this.#promptEpochs.clear();
    this.#inFlightPromptCounts.clear();
    this.#deferredPromptTerminals.clear();
    this.#nativeQueues.clear();
    this.#nativeQueueContents.clear();
    this.#claimedNativeQueueEntries.clear();
    this.#runningPromptIds.clear();
    for (const waiter of this.#queueWaiters) clearTimeout(waiter.timer);
    this.#queueWaiters.length = 0;
    for (const waiter of this.#nativeQueueInterjectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`${this.displayName} adapter disposed`));
    }
    this.#nativeQueueInterjectionWaiters.length = 0;
    this.#reportedContexts.clear();
    this.#contextHydratedSessions.clear();
    this.#sessionConfigOptions.clear();
    this.#appliedSessionSelections.clear();
    this.#sessionClientToolModes.clear();
    for (const binding of this.#sessionMcpBindings.values()) binding.release();
    this.#sessionMcpBindings.clear();
    this.#openableSubagentSessions.clear();
    this.#eyesToolCallIds.clear();
    this.#activeToolCallIds.clear();
    this.#activeSessions.clear();
    this.#locallyCreatedSessions.clear();
    this.#reportedSessionTitles.clear();
    this.#events.clear();
    const startingPeer = this.#startingPeer;
    if (startingPeer !== null) await startingPeer.close().catch(() => undefined);
    const initializing = this.#initializing;
    if (initializing !== null) await initializing.catch(() => undefined);
    const closing = this.#closing;
    if (closing !== null) await closing.catch(() => undefined);
    const peer = this.#peer;
    this.#peer = null;
    this.#initializeResponse = null;
    if (peer !== null) await peer.close().catch(() => undefined);
  }

  private async ensureInitialized(): Promise<AcpInitializeResponse> {
    await this.peer();
    if (this.#initializeResponse === null) throw new ProviderAdapterError(this.providerId, "INITIALIZE_FAILED", `${this.displayName} ACP initialize response is unavailable`, true);
    return this.#initializeResponse;
  }

  private async peer(): Promise<JsonRpcPeer> {
    if (this.#disposed) throw new ProviderAdapterError(this.providerId, "ADAPTER_DISPOSED", `${this.displayName} adapter has been disposed`, false);
    this.#resourceGeneration += 1;
    this.cancelIdleRelease();
    const closing = this.#closing;
    if (closing !== null) await closing;
    if (this.#disposed) throw new ProviderAdapterError(this.providerId, "ADAPTER_DISPOSED", `${this.displayName} adapter has been disposed`, false);
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

  private mcpServers(providerSessionId?: string): readonly unknown[] {
    if (this.#clientTooling === undefined || providerSessionId === undefined) return [];
    return [mcpServerEntry(this.#clientTooling.mcpServer(this.providerId, providerSessionId, "provider"))];
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
    this.#startingPeer = peer;
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
      if (this.#disposed) throw new Error(`${this.displayName} adapter disposed during initialization`);
      this.#initializeResponse = response;
      this.#peer = peer;
      return peer;
    } catch (error) {
      await peer.close();
      throw new ProviderAdapterError(this.providerId, "INITIALIZE_FAILED", `${this.displayName} ACP initialization failed: ${error instanceof Error ? error.message : String(error)}`, true, { cause: error });
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
    if (this.#watchedSessions.size > 0) return;
    if (this.#activePrompts.size > 0 || this.#pendingPermissions.size > 0) return;
    if (this.#activeSessions.size > 0 && !this.canRestoreActiveSessions()) return;
    this.#peer = null;
    this.resetProcessState();
    const closing = peer.close();
    this.#closing = closing;
    try {
      await closing;
    } finally {
      if (this.#closing === closing) this.#closing = null;
    }
  }

  private resetProcessState(): void {
    this.#initializeResponse = null;
    this.#activeSessions.clear();
    this.#contextHydratedSessions.clear();
    this.#sessionClientToolModes.clear();
    this.#sessionConfigOptions.clear();
    this.#appliedSessionSelections.clear();
  }

  private canRestoreActiveSessions(): boolean {
    const native = this.#initializeResponse?.agentCapabilities;
    return boolCapability(native, ["sessionCapabilities", "resume"]) || boolCapability(native, ["loadSession"]);
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

  private captureReportedContext(
    providerSessionId: string,
    source: unknown,
    contexts: Map<string, ReportedSessionContext> = this.#reportedContexts,
  ): void {
    const parsed = parseReportedContext(source);
    if (parsed === null) return;
    const prior = contexts.get(providerSessionId);
    const modelChanged = prior?.modelId !== undefined
      && parsed.modelId !== undefined
      && prior.modelId !== parsed.modelId;
    const retainContextWindow = parsed.contextWindowTokens === undefined && !modelChanged;
    const retainUsageUpdateSize = parsed.usageUpdateSizeTokens === undefined && !modelChanged;
    const retainModelContextWindow = parsed.modelContextWindowTokens === undefined && !modelChanged;
    const retainPercent = parsed.usedPercent === undefined
      && parsed.usedTokens === undefined
      && parsed.contextWindowTokens === undefined
      && parsed.usageUpdateSizeTokens === undefined
      && parsed.modelContextWindowTokens === undefined
      && !modelChanged;
    contexts.set(providerSessionId, {
      ...(prior?.modelId !== undefined ? { modelId: prior.modelId } : {}),
      ...(prior?.usedTokens !== undefined ? { usedTokens: prior.usedTokens } : {}),
      ...(retainContextWindow && prior?.contextWindowTokens !== undefined ? { contextWindowTokens: prior.contextWindowTokens } : {}),
      ...(retainUsageUpdateSize && prior?.usageUpdateSizeTokens !== undefined ? { usageUpdateSizeTokens: prior.usageUpdateSizeTokens } : {}),
      ...(retainModelContextWindow && prior?.modelContextWindowTokens !== undefined ? { modelContextWindowTokens: prior.modelContextWindowTokens } : {}),
      ...(retainPercent && prior?.usedPercent !== undefined ? { usedPercent: prior.usedPercent } : {}),
      ...(parsed.modelId !== undefined ? { modelId: parsed.modelId } : {}),
      ...(parsed.usedTokens !== undefined ? { usedTokens: parsed.usedTokens } : {}),
      ...(parsed.contextWindowTokens !== undefined ? { contextWindowTokens: parsed.contextWindowTokens } : {}),
      ...(parsed.usageUpdateSizeTokens !== undefined ? { usageUpdateSizeTokens: parsed.usageUpdateSizeTokens } : {}),
      ...(parsed.modelContextWindowTokens !== undefined ? { modelContextWindowTokens: parsed.modelContextWindowTokens } : {}),
      ...(parsed.usedPercent !== undefined ? { usedPercent: parsed.usedPercent } : {}),
      usage: { ...(prior?.usage ?? {}), ...(parsed.usage ?? {}) },
      updatedAt: this.#now().toISOString(),
    });
  }

  /** Reads the running model and reasoning level out of a harness reply. */
  private captureReportedModels(providerSessionId: string, source: unknown): void {
    const reported = reportedModelSelection(source);
    if (reported === undefined) return;
    this.captureReportedSelection(providerSessionId, reported.modelId, reported.reasoningEffort);
  }

  private captureSessionConfigOptions(providerSessionId: string, source: unknown): void {
    const options = sessionConfigOptions(source);
    if (options === undefined) return;
    this.#sessionConfigOptions.set(providerSessionId, options);
    // Harnesses that expose reasoning as an ACP config option report the current
    // level here; Grok instead announces it through its own session updates.
    this.captureReportedSelection(
      providerSessionId,
      configOptionFor(options, "model")?.currentValue,
      configOptionFor(options, "thought_level")?.currentValue,
    );
  }

  /**
   * Records what the harness says a session is currently running, and tells
   * clients when that differs from what they were shown. This is the only
   * trustworthy source: the level a turn actually used belongs to the harness,
   * not to anything Tethoq remembers, so it stays correct across restarts and
   * after the user changes the level in the harness's own interface.
   */
  private captureReportedSelection(
    providerSessionId: string,
    modelId: string | undefined,
    reasoningEffort: string | undefined,
  ): void {
    if (modelId === undefined && reasoningEffort === undefined) return;
    const prior = this.#appliedSessionSelections.get(providerSessionId);
    const learnedEffort = reasoningEffort !== undefined && reasoningEffort !== prior?.reasoningEffort;
    const learnedModel = modelId !== undefined && modelId !== prior?.modelId;
    if (!learnedEffort && !learnedModel) return;
    this.#appliedSessionSelections.set(providerSessionId, {
      ...(prior?.modelId !== undefined ? { modelId: prior.modelId } : {}),
      ...(prior?.reasoningEffort !== undefined ? { reasoningEffort: prior.reasoningEffort } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    });
    void this.emit({
      type: "session.updated",
      providerSessionId,
      payload: {
        ...(learnedModel ? { modelId } : {}),
        ...(learnedEffort ? { reasoningEffort } : {}),
      },
    });
  }

  private captureReportedTitle(providerSessionId: string, source: unknown): void {
    const title = reportedSessionTitle(source);
    if (title === undefined) return;
    const previous = this.#reportedSessionTitles.get(providerSessionId);
    this.#reportedSessionTitles.set(providerSessionId, title);
    const local = this.#locallyCreatedSessions.get(providerSessionId);
    if (local?.preserveRequestedTitle === true || (previous === title && local?.session.title === title)) return;
    if (local !== undefined) {
      this.#locallyCreatedSessions.set(providerSessionId, { ...local, session: { ...local.session, title } });
    }
    void this.emit({ type: "session.updated", providerSessionId, payload: { title } });
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
    const sameReasoning = !!reasoningEffort
      && applied?.reasoningEffort !== undefined
      && matchReasoningEffort(reasoningEffort, [applied.reasoningEffort]) === applied.reasoningEffort;
    const changeReasoning = !!reasoningEffort && !sameReasoning;
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
    const matched = matchReasoningEffort(value, option.values) ?? value;
    if (option.currentValue === matched) return;
    if (option.values.length > 0 && !option.values.includes(matched)) {
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
      value: matched,
    });
    this.captureSessionConfigOptions(providerSessionId, result);
    this.captureReportedModels(providerSessionId, result);
  }

  private decorateSessionSelections(session: RemoteSession): RemoteSession {
    const applied = this.#appliedSessionSelections.get(session.providerSessionId);
    if (applied === undefined) return session;
    return {
      ...session,
      ...(applied.modelId !== undefined ? { modelId: applied.modelId } : {}),
      ...(applied.reasoningEffort !== undefined ? { reasoningEffort: applied.reasoningEffort } : {}),
    };
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
    const modelChanged = prior?.modelId !== undefined && prior.modelId !== modelId;
    this.#reportedContexts.set(providerSessionId, {
      modelId,
      ...(prior?.usedTokens !== undefined ? { usedTokens: prior.usedTokens } : {}),
      ...(!modelChanged && prior?.contextWindowTokens !== undefined ? { contextWindowTokens: prior.contextWindowTokens } : {}),
      ...(!modelChanged && prior?.usageUpdateSizeTokens !== undefined ? { usageUpdateSizeTokens: prior.usageUpdateSizeTokens } : {}),
      ...(!modelChanged && prior?.modelContextWindowTokens !== undefined ? { modelContextWindowTokens: prior.modelContextWindowTokens } : {}),
      ...(!modelChanged && prior?.usedPercent !== undefined ? { usedPercent: prior.usedPercent } : {}),
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
    if (this.providerId === "grok" && isGrokQueueChangedMethod(method)) {
      await this.applyNativeQueueChanged(params);
      return;
    }
    if (this.providerId === "grok" && isGrokSessionInterjectionMethod(method)) {
      const interjection = parseGrokSessionInterjection(params);
      if (interjection === undefined) return;
      if (interjection.interjectionId !== undefined) {
        this.confirmNativeQueueInterjection(interjection.sessionId, interjection.interjectionId);
      }
      this.markLiveTurn(interjection.sessionId);
      const visibleText = stripProviderPromptGuidance(interjection.text);
      const visibleParams = asJsonObject({
        ...asJsonObject(params),
        ...(isRecord(params) && "text" in params ? { text: visibleText } : {}),
        ...(isRecord(params) && "content" in params ? { content: visibleText } : {}),
      });
      await this.emit({
        type: "message.started",
        providerSessionId: interjection.sessionId,
        payload: {
          messageId: interjection.interjectionId ?? `grok_interjection_${randomUUID()}`,
          role: "user",
          content: visibleParams,
          text: visibleText,
        },
        nativeEvent: asJsonObject({ method, params: visibleParams }),
      });
      return;
    }
    // Grok pushes the authoritative model and reasoning level for every session
    // it knows about, including on connect. Reading it is what keeps the composer
    // showing the level a task is really running rather than the model default.
    if (isAcpSessionsChangedMethod(method)) {
      this.applyReportedSessionList(params);
      return;
    }
    if (!["session/update", "_x.ai/session/update", "_x.ai/session_notification"].includes(method)
      || !isRecord(params)
      || typeof params.sessionId !== "string"
      || !isRecord(params.update)) return;
    const update = params.update;
    const contextStore = this.#historyCapture.has(params.sessionId)
      ? this.#historyReportedContexts
      : this.#reportedContexts;
    this.captureReportedContext(params.sessionId, update, contextStore);
    this.captureReportedContext(params.sessionId, params, contextStore);
    this.captureSessionConfigOptions(params.sessionId, update);
    const sessionUpdate = typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : typeof update.session_update === "string"
        ? update.session_update
        : "unknown";
    const privateEyesUpdate = (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update")
      && this.trackEyesToolUpdate(params.sessionId, sessionUpdate, update);
    // The harness announces a level change the moment it happens, including one
    // the user made in the harness's own interface rather than through Tethoq.
    if (sessionUpdate === "model_changed") {
      this.captureReportedSelection(
        params.sessionId,
        firstUpdateString(update, ["model_id", "modelId", "model"]),
        firstUpdateString(update, ["reasoning_effort", "reasoningEffort", "thought_level", "thoughtLevel"]),
      );
      return;
    }
    const capture = this.#historyCapture.get(params.sessionId);
    const live = this.#liveMessages.get(params.sessionId) ?? createMessageAccumulator();
    this.#liveMessages.set(params.sessionId, live);
    if (sessionUpdate === "user_message_chunk" || sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk"
      || sessionUpdate === "agent_thinking_chunk" || sessionUpdate === "thought_chunk" || sessionUpdate === "thinking_chunk") {
      // The echoed prompt is the first sign a turn has begun. Leaving it out let
      // a routine history reload start in that gap, and session/load then
      // swallowed the whole answer into the capture accumulator instead of
      // streaming it, so nothing moved until the turn was already over.
      if (capture === undefined) this.markLiveTurn(params.sessionId);
      const role = sessionUpdate === "user_message_chunk" ? "user" : "assistant";
      const partType = role === "assistant" && acpUpdateLooksLikeThought(update, sessionUpdate) ? "reasoning" : "text";
      // History replay needs the fully coalesced message. Live rendering only
      // needs the current delta, so retaining and re-copying the whole answer
      // for every ACP chunk would turn long responses into quadratic work.
      const message = appendAcpContentChunk(
        this.#hostId,
        params.sessionId,
        role,
        update,
        capture ?? live,
        historyMessageCreatedAt(params, update, this.#now()),
        capture !== undefined,
        historyMessageId(role, params, update),
        partType,
        this.#identity,
      );
      if (role === "user" && message !== null) {
        const nativeText = acpPromptText(update);
        const visibleText = remoteMessagePromptText(message);
        if (nativeText !== undefined) this.acceptScheduledPrompt(params.sessionId, nativeText);
        if (visibleText !== undefined && visibleText !== nativeText) this.acceptScheduledPrompt(params.sessionId, visibleText);
      }
      if (capture === undefined && message !== null) {
        const text = latestAcpChunkText(message);
        await this.emit({
          type: role === "assistant" ? "message.delta" : "message.started",
          providerSessionId: params.sessionId,
          payload: {
            messageId: message.providerMessageId,
            role,
            content: asJsonObject(update),
            ...(text !== undefined ? { text } : {}),
            ...(partType === "reasoning" ? { partType } : {}),
          },
          nativeEvent: asJsonObject({ method, params }),
        });
      }
      return;
    }
    const subagent = normalizeAcpSubagentUpdate(update);
    if (subagent !== null) {
      this.markLiveTurn(params.sessionId);
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
    if (sessionUpdate === "turn_completed") {
      await this.handleTurnCompleted(params.sessionId, params, update);
      return;
    }
    const toolCallTerminated = this.trackActiveToolCall(params.sessionId, sessionUpdate, params, update);
    const normalized = normalizeUpdate(sessionUpdate, update, privateEyesUpdate);
    if (normalized !== null) {
      // ACP can attach raw provider diagnostics and internal tool metadata to
      // EYES updates. The model still receives its native tool result; client
      // events get only the normalized safe state.
      await this.emit({
        ...normalized,
        providerSessionId: params.sessionId,
        ...(!privateEyesUpdate ? { nativeEvent: asJsonObject({ method, params }) } : {}),
      });
    }
    if (toolCallTerminated) await this.flushDeferredPromptTerminal(params.sessionId);
  }

  private trackActiveToolCall(
    providerSessionId: string,
    sessionUpdate: string,
    params: Record<string, unknown>,
    update: Record<string, unknown>,
  ): boolean {
    if (this.providerId !== "grok" || (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update")) return false;
    const callId = acpToolCallId(update);
    if (callId === undefined) return false;
    const active = this.#activeToolCallIds.get(providerSessionId) ?? new Map<string, string | undefined>();
    if (sessionUpdate === "tool_call_update" && toolUpdateIsTerminal(update)) {
      const removed = active.delete(callId);
      if (active.size === 0) this.#activeToolCallIds.delete(providerSessionId);
      else this.#activeToolCallIds.set(providerSessionId, active);
      return removed;
    }
    const promptId = acpUpdatePromptId(params, update);
    // Interim updates can omit metadata. Preserve the owner learned from the
    // initial tool_call rather than turning a scoped call into an unscoped one.
    if (promptId !== undefined || !active.has(callId)) active.set(callId, promptId);
    this.#activeToolCallIds.set(providerSessionId, active);
    return false;
  }

  private async handleTurnCompleted(
    providerSessionId: string,
    params: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<void> {
    if (this.providerId !== "grok") return;
    const promptId = acpUpdatePromptId(params, update);
    this.retireActiveToolCallsForTurn(providerSessionId, promptId);
    const runningPromptId = this.#runningPromptIds.get(providerSessionId);
    if (promptId === undefined || runningPromptId === promptId) this.#runningPromptIds.delete(providerSessionId);

    // An owned prompt RPC remains authoritative. Flush its deferred result
    // first; that cleanup removes the live marker and suppresses a second
    // terminal from this notification.
    await this.flushDeferredPromptTerminal(providerSessionId);
    if (!this.#lastLiveUpdateAt.has(providerSessionId)
      || this.#activePrompts.has(providerSessionId)
      || this.#inFlightPromptCounts.has(providerSessionId)
      || this.#runningPromptIds.has(providerSessionId)
      || (this.#activeToolCallIds.get(providerSessionId)?.size ?? 0) > 0
      || (this.#nativeQueues.get(providerSessionId)?.length ?? 0) > 0) return;

    const stopReason = firstUpdateString(update, ["stopReason", "stop_reason", "reason"])?.toLowerCase();
    const interrupted = stopReason !== undefined
      && ["cancel", "interrupt", "abort"].some((term) => stopReason.includes(term));
    await this.emitPromptTerminal(providerSessionId, interrupted ? "interrupted" : "completed", {
      result: asJsonObject(update),
    });
  }

  private retireActiveToolCallsForTurn(providerSessionId: string, promptId: string | undefined): void {
    const active = this.#activeToolCallIds.get(providerSessionId);
    if (active === undefined) return;
    if (promptId === undefined) {
      this.#activeToolCallIds.delete(providerSessionId);
      return;
    }
    // Old Grok builds omit prompt metadata from some tool updates. Such calls
    // still belong to the completed turn barrier and must not remain immortal.
    for (const [callId, ownerPromptId] of active) {
      if (ownerPromptId === undefined || ownerPromptId === promptId) active.delete(callId);
    }
    if (active.size === 0) this.#activeToolCallIds.delete(providerSessionId);
  }

  private trackEyesToolUpdate(
    providerSessionId: string,
    sessionUpdate: string,
    update: Record<string, unknown>,
  ): boolean {
    const callId = acpToolCallId(update);
    const ids = this.#eyesToolCallIds.get(providerSessionId);
    const directMatch = isEyesToolUpdate(update);
    const matches = directMatch || (callId !== undefined && ids?.has(callId) === true);
    if (!matches) return false;
    if (sessionUpdate === "tool_call" && callId !== undefined) {
      const next = ids ?? new Set<string>();
      next.add(callId);
      this.#eyesToolCallIds.set(providerSessionId, next);
    }
    if (sessionUpdate === "tool_call_update" && toolUpdateIsTerminal(update) && callId !== undefined && ids !== undefined) {
      ids.delete(callId);
      if (ids.size === 0) this.#eyesToolCallIds.delete(providerSessionId);
    }
    return true;
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

function isGrokSessionInterjectionMethod(method: string): boolean {
  const normalized = method.toLowerCase();
  return normalized === "x.ai/session/interjection" || normalized === "_x.ai/session/interjection";
}

function parseGrokSessionInterjection(value: unknown): {
  readonly sessionId: string;
  readonly text: string;
  readonly interjectionId?: string;
} | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = firstUpdateString(value, ["sessionId", "session_id"]);
  const text = firstUpdateString(value, ["text", "content"]);
  if (sessionId === undefined || text === undefined) return undefined;
  const interjectionId = firstUpdateString(value, ["interjectionId", "interjection_id"]);
  return {
    sessionId,
    text,
    ...(interjectionId !== undefined ? { interjectionId } : {}),
  };
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
  eyesToolUpdate = isEyesToolUpdate(update),
): Omit<ProviderEvent, "eventId" | "providerId" | "providerSessionId" | "occurredAt"> | null {
  if (sessionUpdate === "tool_call") {
    if (eyesToolUpdate) {
      return { type: "tool.started", payload: { name: "Ask visual support", tool: "ask_eyes", status: "running" } };
    }
    const command = extractCommand(update);
    return command === undefined
      ? { type: "tool.started", payload: asJsonObject(update) }
      : { type: "command.started", payload: { command, toolCall: asJsonObject(update) } };
  }
  if (sessionUpdate === "tool_call_update") {
    const status = typeof update.status === "string" ? update.status.toLowerCase() : "";
    if (eyesToolUpdate) {
      if (status.includes("fail") || status.includes("error")) {
        return {
          type: "tool.completed",
          payload: {
            name: "Ask visual support",
            tool: "ask_eyes",
            status: "failed",
            error: safeEyesToolUpdateError(update),
          },
        };
      }
      return {
        type: status.includes("complete") || status.includes("success") ? "tool.completed" : "tool.output",
        payload: {
          name: "Ask visual support",
          tool: "ask_eyes",
          status: status.includes("complete") || status.includes("success") ? "completed" : "running",
        },
      };
    }
    const command = extractCommand(update);
    if (status.includes("complete") || status.includes("success")) return command === undefined
      ? { type: "tool.completed", payload: asJsonObject(update) }
      : { type: "command.completed", payload: { command, toolCall: asJsonObject(update) } };
    if (status.includes("fail") || status.includes("error")) return { type: "agent.error", payload: asJsonObject(update) };
    return command === undefined
      ? { type: "tool.output", payload: asJsonObject(update) }
      : { type: "command.output", payload: { command, toolCall: asJsonObject(update) } };
  }
  if (sessionUpdate === "session_info_update") {
    const title = reportedSessionTitle(update);
    return { type: "session.updated", payload: { ...asJsonObject(update), ...(title !== undefined ? { title } : {}) } };
  }
  if (sessionUpdate === "current_mode_update" || sessionUpdate === "config_option_update") return { type: "session.status_changed", payload: asJsonObject(update) };
  return null;
}

function acpToolCallId(update: Record<string, unknown>): string | undefined {
  const records = [update, update.toolCall, update.tool_call]
    .filter((value): value is Record<string, unknown> => isRecord(value));
  for (const record of records) {
    for (const key of ["toolCallId", "tool_call_id", "callId", "call_id", "id"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

function toolUpdateIsTerminal(update: Record<string, unknown>): boolean {
  const status = typeof update.status === "string" ? update.status.toLowerCase() : "";
  return status.includes("complete") || status.includes("success") || status.includes("fail") || status.includes("error");
}

function isEyesToolUpdate(update: Record<string, unknown>): boolean {
  const nested = [update.toolCall, update.tool_call, update.rawInput, update.raw_input]
    .filter((value): value is Record<string, unknown> => isRecord(value));
  const candidates = [update, ...nested].flatMap((value) => [
    value.tool,
    value.toolName,
    value.tool_name,
    value.name,
    value.title,
  ]);
  return candidates.some((value) => {
    if (typeof value !== "string") return false;
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
    return normalized === "ask_eyes" || normalized.endsWith("_ask_eyes")
      || normalized === "tethoq_turn_support" || normalized.endsWith("_tethoq_turn_support")
      || normalized === "ask_visual_support";
  });
}

function safeEyesToolUpdateError(update: Record<string, unknown>): string {
  let normalized = "";
  try {
    normalized = JSON.stringify(update).slice(0, 24_000).toLowerCase();
  } catch {
    // A malformed ACP diagnostic is still an unknown EYES failure, never a
    // reason to forward its raw representation to a client.
  }
  if (/\b(?:429|quota|rate[_ -]?limit|usage[_ -]?limit|resource[_ -]?exhausted|insufficient (?:balance|credit)|billing)\b/u.test(normalized)) {
    return "EYES could not use the selected model because its usage limit was reached or it is temporarily rate-limited. Check the provider account or choose another EYES model.";
  }
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|api[_ -]?key|credential|auth(?:entication|ori[sz]ation)?)\b/u.test(normalized)) {
    return "EYES could not use the selected model because its API key is missing, invalid, or no longer accepted. Update the key in EYES settings and try again.";
  }
  if (/\b(?:timed? out|timeout|deadline)\b/u.test(normalized)) {
    return "EYES did not finish inspecting the image. Try again or choose another EYES model.";
  }
  if (/\b(?:abort(?:ed)?|cancel(?:led|ed)?|interrupt(?:ed)?)\b/u.test(normalized)) {
    return "EYES was interrupted before it finished inspecting the image. Try again when you are ready.";
  }
  return "EYES could not inspect the image. Try again or choose another EYES model.";
}
