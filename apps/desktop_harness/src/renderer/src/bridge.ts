import type {
  AgentEvent,
  ApprovalRequest as ProtocolApproval,
  ContentPart,
  JsonObject,
  ProviderConnection,
  RemoteMessage,
  RemoteSession,
  UserInputRequest as ProtocolInput,
} from "../../../../../packages/protocol/src/index";
import type {
  BrowserWorkspaceState,
  DesktopBootstrap,
  DesktopEventBatch,
  DesktopRuntimeState,
  SelectedFile,
  SelectedImage,
} from "@shared/desktop_api";
import { demoBootstrap, demoSnapshot } from "./demo";
import type {
  ApprovalRequest,
  DesktopSnapshot,
  InputRequest,
  ModelOption,
  Provider,
  Session,
  SessionContextState,
  SessionState,
  TimelineItem,
} from "./types";

export const isBrowserPreview = !window.tethoqDesktop;

export const demoBrowserState: BrowserWorkspaceState = {
  partition: "persist:tethoq-browser" as const,
  profile: { persistent: true as const, appOwned: true as const, importsSystemProfile: false as const, clearing: false },
  visible: false,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  activeTabId: "preview-browser-tab",
  tabs: [{ id: "preview-browser-tab", title: "New tab", url: "https://www.google.com/", faviconUrl: null, loading: false, canGoBack: false, canGoForward: false, crashed: false, error: null }],
  downloads: [
    { id: "preview-download-active", tabId: "preview-browser-tab", filename: "Tethoq-Bridge-0.1.0-win-x64.zip", url: "https://downloads.example.test/Tethoq-Bridge.zip", state: "progressing", savePath: "C:\\Users\\you\\Downloads\\Tethoq-Bridge-0.1.0-win-x64.zip", mimeType: "application/zip", receivedBytes: 24_379_392, totalBytes: 38_538_776, bytesPerSecond: 4_820_992, paused: false, startedAt: "2026-08-13T12:00:00.000Z", finishedAt: null },
    { id: "preview-download-complete", tabId: "preview-browser-tab", filename: "workflow-reference.pdf", url: "https://downloads.example.test/workflow-reference.pdf", state: "completed", savePath: "C:\\Users\\you\\Downloads\\workflow-reference.pdf", mimeType: "application/pdf", receivedBytes: 2_433_024, totalBytes: 2_433_024, bytesPerSecond: 0, paused: false, startedAt: "2026-08-13T11:58:00.000Z", finishedAt: "2026-08-13T11:58:03.000Z" },
  ], pendingPermissions: [], permissionDecisions: [],
};

const connectorMetadata = new Map<string, { name: string; supportsAttachments: boolean }>();
const builtInImageEntryProviders = new Set(["codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct"]);

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const boolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function demoContext(sessionId: string, thresholdTokens = 96_000): SessionContextState {
  return {
    sessionId,
    modelId: "gpt-5.6-sol",
    usedTokens: 42_800,
    contextWindowTokens: 128_000,
    usedPercent: 33.4375,
    compactionThresholdTokens: thresholdTokens,
    minimumThresholdTokens: 8_000,
    supportsManualCompaction: true,
    supportsThreshold: true,
    isCompacting: false,
    updatedAt: new Date().toISOString(),
    usage: { inputTokens: 39_100, outputTokens: 3_700, totalTokens: 42_800, cost: 0.42, currency: "USD" },
  };
}

function responsePayload(response: Awaited<ReturnType<Window["tethoqDesktop"]["request"]>>): Record<string, unknown> {
  if (!response.ok) throw new Error(response.error?.message ?? "The desktop bridge request failed.");
  return response.payload;
}

export async function request(type: string, payload: JsonObject = {}): Promise<Record<string, unknown>> {
  if (isBrowserPreview) {
    if (type === "session.vision.get") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      return { vision: { sessionId, primaryModelSupportsImageInput: sessionId === "auth-regression" ? false : true, configured: null } };
    }
    if (type === "vision.targets") return {
      targets: [{
        providerId: "codex",
        displayName: "OpenAI Codex",
        models: [{ id: "gpt-5.6-sol", providerId: "codex", displayName: "GPT-5.6 Sol", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: ["Low", "Medium", "High", "Ultra"] } }],
      }],
    };
    if (type === "session.vision.configure") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      return { vision: { sessionId, primaryModelSupportsImageInput: false, configured: payload.selection ?? null } };
    }
    if (type === "session.context.get") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      return { context: demoContext(sessionId) };
    }
    if (type === "session.context.set_threshold") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const thresholdTokens = finiteNumber(payload.thresholdTokens) ?? 96_000;
      return { context: demoContext(sessionId, thresholdTokens) };
    }
    if (type === "wallet.get") {
      const providerId = typeof payload.providerId === "string" ? payload.providerId : "codex";
      const endpointId = typeof payload.endpointId === "string" ? payload.endpointId : typeof payload.modelId === "string" && payload.modelId.includes("::") ? payload.modelId.split("::", 1)[0]! : "openai";
      return { wallet: providerId === "direct" ? { providerId, kind: "user_api", label: "Direct API wallet", detail: "Your API key and local spend budget", endpointId, endpointName: endpointId === "openai" ? "OpenAI API" : endpointId, currency: "USD", balance: 25, spent: 3.42, apiKeyConfigured: false, caution: "Add an API key before using direct models." } : { providerId, kind: providerId === "opencode" ? "harness" : "subscription", label: providerId === "opencode" ? "OpenCode wallet" : "Subscription usage", detail: providerId === "opencode" ? "OpenCode manages this billing route" : "The provider subscription is being used", currency: "USD", apiKeyConfigured: true } };
    }
    if (type === "wallet.configure") return { wallet: { providerId: "direct", kind: "user_api", label: "Direct API wallet", detail: "Your API key and local spend budget", endpointId: typeof payload.endpointId === "string" ? payload.endpointId : "openai", currency: "USD", balance: finiteNumber(payload.setBalance) ?? finiteNumber(payload.addBalance) ?? 25, spent: 3.42, apiKeyConfigured: payload.clearApiKey !== true, apiKeyLabel: payload.clearApiKey === true ? undefined : "Saved key" } };
    if (type === "session.create") {
      const now = new Date().toISOString();
      const providerId = typeof payload.providerId === "string" ? payload.providerId : "codex";
      const workingDirectory = typeof payload.workingDirectory === "string" ? payload.workingDirectory : "C:\\Projects\\new-project";
      const instruction = typeof payload.firstInstruction === "string" ? payload.firstInstruction : "";
      return { session: { id: `preview-created-${Date.now()}`, providerId, title: instruction.trim().split(/\r?\n/u)[0]?.slice(0, 72) || "New task", state: instruction ? "working" : "idle", project: workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "New project", workingDirectory, preview: instruction, lastActivityAt: now, ...(typeof payload.modelId === "string" ? { modelId: payload.modelId } : {}), ...(typeof payload.reasoningEffort === "string" ? { reasoningEffort: payload.reasoningEffort } : {}) } };
    }
    if (type === "session.send_message") return { accepted: true };
    return {};
  }
  return responsePayload(await window.tethoqDesktop.request(type, payload));
}

function mapSessionContext(value: unknown): SessionContextState {
  const context = object(value);
  const usage = object(context.usage);
  const optionalNumber = (candidate: unknown): number | null => finiteNumber(candidate) ?? null;
  const mappedUsage: SessionContextState["usage"] = {};
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost"] as const) {
    const candidate = finiteNumber(usage[key]);
    if (candidate !== undefined) mappedUsage[key] = candidate;
  }
  const currency = string(usage.currency);
  if (currency) mappedUsage.currency = currency;
  return {
    sessionId: string(context.sessionId),
    ...(string(context.modelId) ? { modelId: string(context.modelId) } : {}),
    usedTokens: optionalNumber(context.usedTokens),
    contextWindowTokens: optionalNumber(context.contextWindowTokens),
    usedPercent: optionalNumber(context.usedPercent),
    compactionThresholdTokens: optionalNumber(context.compactionThresholdTokens),
    minimumThresholdTokens: optionalNumber(context.minimumThresholdTokens),
    supportsManualCompaction: boolean(context.supportsManualCompaction),
    supportsThreshold: boolean(context.supportsThreshold),
    isCompacting: boolean(context.isCompacting),
    updatedAt: string(context.updatedAt, new Date(0).toISOString()),
    usage: mappedUsage,
  };
}

export async function loadSessionContext(sessionId: string): Promise<SessionContextState> {
  const payload = await request("session.context.get", { sessionId });
  return mapSessionContext(payload.context);
}

export async function setSessionContextThreshold(sessionId: string, thresholdTokens: number, compactNow: boolean): Promise<SessionContextState> {
  const payload = await request("session.context.set_threshold", { sessionId, thresholdTokens, compactNow });
  return mapSessionContext(payload.context);
}

function mapProvider(connection: ProviderConnection): Provider {
  const descriptor = object(connection);
  const metadata = object(descriptor.metadata);
  const candidateIconDataUrl = string(descriptor.iconDataUrl, string(metadata.iconDataUrl));
  const rawCapabilities = object(connection.capabilities);
  const connector = connectorMetadata.get(connection.providerId);
  return {
    id: connection.providerId,
    name: connector?.name || connection.displayName,
    ...(candidateIconDataUrl.startsWith("data:image/") ? { iconDataUrl: candidateIconDataUrl } : {}),
    ...(connection.nativeVersion ? { version: connection.nativeVersion } : {}),
    state: connection.state === "online" ? "online" : connection.state === "offline" || connection.state === "disconnected" ? "offline" : "error",
    detected: connection.detected,
    authenticated: connection.authenticated === true,
    capabilities: Object.entries(rawCapabilities)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase())),
    supportsAttachments: connector?.supportsAttachments
      ?? (rawCapabilities.attachments === true
        || rawCapabilities.imageAttachments === true
        || builtInImageEntryProviders.has(connection.providerId)),
  };
}

function sessionState(value: string): SessionState {
  return value === "disconnected" || value === "unknown" ? "offline" : value as SessionState;
}

function mapSession(value: RemoteSession): Session | null {
  if (value.parentSessionId) return null;
  const metadata = object(value.nativeMetadata);
  const contextSummary = string(value.contextHandoffSummary) || string(metadata.tethoqHandoffSummary);
  return {
    id: value.id,
    providerId: value.providerId,
    title: value.title,
    state: sessionState(value.state),
    project: value.project ?? value.workingDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Untitled project",
    workingDirectory: value.workingDirectory ?? "",
    preview: value.preview ?? "No recent output.",
    updatedAt: value.lastActivityAt,
    model: value.modelId ?? "CLI default",
    effort: value.reasoningEffort ?? "Default",
    ...(contextSummary ? { contextSummary } : {}),
  };
}

function providerConnections(values: unknown): ProviderConnection[] {
  return array(values).filter((value): value is ProviderConnection => {
    const item = object(value);
    return typeof item.providerId === "string" && typeof item.displayName === "string";
  });
}

function remoteSessions(values: unknown): RemoteSession[] {
  return array(values).filter((value): value is RemoteSession => {
    const item = object(value);
    return typeof item.id === "string" && typeof item.providerId === "string";
  });
}

function remoteMessages(values: unknown): RemoteMessage[] {
  return array(values).filter((value): value is RemoteMessage => typeof object(value).id === "string");
}

const maximumHistoryImageBytes = 25 * 1024 * 1024;

function base64ByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

async function retrieveHistoryImage(sessionId: string, retrievalId: string): Promise<{ readonly uri: string; readonly mimeType: string }> {
  let offset = 0;
  let totalBytes: number | undefined;
  let mimeType: string | undefined;
  const chunks: string[] = [];
  for (let index = 0; index < 64; index += 1) {
    const payload = await request("session.image.get", { sessionId, retrievalId, offset });
    const returnedId = string(payload.retrievalId);
    const returnedOffset = finiteNumber(payload.offset);
    const returnedTotal = finiteNumber(payload.totalBytes);
    const dataBase64 = string(payload.dataBase64);
    const returnedMimeType = string(payload.mimeType);
    const chunkBytes = base64ByteLength(dataBase64);
    if (returnedId !== retrievalId || returnedOffset !== offset || returnedTotal === undefined || !Number.isSafeInteger(returnedTotal)
      || returnedTotal <= 0 || returnedTotal > maximumHistoryImageBytes || chunkBytes === undefined
      || !/^image\/[a-z0-9.+-]+$/iu.test(returnedMimeType)) throw new Error("Bridge returned an invalid image chunk");
    if (totalBytes !== undefined && returnedTotal !== totalBytes) throw new Error("Bridge changed the image length while loading it");
    if (mimeType !== undefined && returnedMimeType !== mimeType) throw new Error("Bridge changed the image type while loading it");
    totalBytes = returnedTotal;
    mimeType = returnedMimeType;
    chunks.push(dataBase64);
    const consumed = offset + chunkBytes;
    const nextOffset = payload.nextOffset;
    if (nextOffset === null) {
      if (consumed !== totalBytes) throw new Error("Bridge ended the image before its declared length");
      return { uri: `data:${mimeType};base64,${chunks.join("")}`, mimeType };
    }
    if (typeof nextOffset !== "number" || !Number.isSafeInteger(nextOffset) || nextOffset !== consumed || nextOffset <= offset || nextOffset >= totalBytes) {
      throw new Error("Bridge returned an invalid next image offset");
    }
    offset = nextOffset;
  }
  throw new Error("Image requires too many chunks");
}

async function hydrateHistoryImages(sessionId: string, messages: readonly RemoteMessage[]): Promise<RemoteMessage[]> {
  const hydrated: RemoteMessage[] = [];
  for (const message of messages) {
    const parts: ContentPart[] = [];
    for (const part of message.parts) {
      if (part.type !== "image" || part.uri !== undefined || part.retrievalId === undefined) {
        parts.push(part);
        continue;
      }
      try {
        const image = await retrieveHistoryImage(sessionId, part.retrievalId);
        parts.push({ ...part, uri: image.uri, mimeType: part.mimeType ?? image.mimeType });
      } catch {
        parts.push(part);
      }
    }
    hydrated.push({ ...message, parts });
  }
  return hydrated;
}

function timelineMessagePhase(value: unknown): TimelineItem["phase"] | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

const compactSystemBoundary = /^(?:(?:context|conversation)\s+(?:was\s+|has\s+been\s+|automatically\s+)?compacted(?:\s+successfully)?|(?:automatic\s+|context\s+)?compaction\s+(?:complete|completed))[.!]?$/iu;

function conciseSystemBoundary(text: string): string | null {
  const value = text.trim();
  if (!value || value.length > 240) return null;
  if (compactSystemBoundary.test(value)) return value;
  if (/^\s*\[(?:system|notice)\]\s*\S/iu.test(value)) return value;
  return null;
}

function nativeMetadataText(message: RemoteMessage, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = message.nativeMetadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function mapPart(message: RemoteMessage, part: ContentPart, index: number): TimelineItem | null {
  const base = { id: `${message.id}-${index}`, messageId: message.providerMessageId || message.id, timestamp: message.createdAt };
  switch (part.type) {
    case "text": {
      if (message.role === "tool") {
        const title = nativeMetadataText(message, "toolName", "name", "title", "tool") ?? "Tool result";
        const detail = nativeMetadataText(message, "callId", "toolCallId", "tool_call_id");
        return { ...base, kind: "tool", title, body: part.text, ...(detail ? { detail } : {}), state: message.status === "streaming" ? "running" : message.status };
      }
      if (message.role === "system") {
        const boundary = conciseSystemBoundary(part.text);
        return boundary ? { ...base, kind: "reasoning", title: "System", body: boundary, state: "completed" } : null;
      }
      const phase = message.role === "assistant" ? timelineMessagePhase(message.nativeMetadata.phase) : undefined;
      return { ...base, kind: message.role, ...(phase ? { phase } : {}), body: part.text, state: message.status === "streaming" ? "running" : "completed" };
    }
    case "reasoning":
      return { ...base, kind: "reasoning", title: part.redacted ? "Protected reasoning" : "Working", body: part.text, state: message.status === "streaming" ? "running" : "completed" };
    case "tool":
      return { ...base, kind: "tool", title: part.name, body: part.output ?? JSON.stringify(part.input ?? {}, null, 2), ...(part.callId ? { detail: part.callId } : {}), state: part.status === "pending" ? "running" : part.status };
    case "command":
      return { ...base, kind: "command", title: part.command, body: part.output ?? "Command is running…", ...(part.cwd ? { detail: part.cwd } : {}), state: part.status === "pending" ? "running" : part.status };
    case "file_change":
      return { ...base, kind: "file", title: `${part.change} ${part.path}`, body: part.patch ?? part.path, state: "completed" };
    case "subagent":
      return { ...base, kind: "subagent", title: `${part.action} agent`, body: part.summary ?? part.prompt ?? "Delegated agent activity", detail: [part.modelId, part.reasoningEffort].filter(Boolean).join(" · "), state: part.status === "pending" || part.status === "unknown" ? "running" : part.status };
    case "error":
      return { ...base, kind: "error", title: part.code ?? "Agent error", body: part.message, state: "failed" };
    case "image": {
      const imageUrl = renderableImageUri(part.uri);
      return { ...base, kind: message.role === "user" ? "user" : "assistant", body: part.name ?? "Attached image", images: [{ name: part.name ?? "Attached image", ...(part.mimeType ? { mimeType: part.mimeType } : {}), ...(imageUrl ? { dataUrl: imageUrl } : {}) }], state: message.status === "streaming" ? "running" : "completed" };
    }
    case "file":
      return { ...base, kind: "file", title: part.name ?? "Attachment", body: part.mimeType ?? "Attached file", state: "completed" };
  }
}

export function renderableImageUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value) || /^https:\/\//iu.test(value)) return value;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return url.protocol === "http:" && loopback ? value : undefined;
  } catch {
    return undefined;
  }
}

function mapMessages(messages: RemoteMessage[]): TimelineItem[] {
  return messages.flatMap((message) => {
    const images = message.parts.flatMap((part, index) => {
      if (part.type !== "image") return [];
      return mapPart(message, part, index)?.images ?? [];
    });
    const items = message.parts.flatMap((part, index) => {
      if (part.type === "image") return [];
      const item = mapPart(message, part, index);
      return item ? [item] : [];
    });
    if (!images.length) return items;
    const messageIndex = items.findIndex((item) => item.kind === "user" || item.kind === "assistant");
    if (messageIndex >= 0) {
      return items.map((item, index) => index === messageIndex ? { ...item, images: [...(item.images ?? []), ...images] } : item);
    }
    const firstImageIndex = message.parts.findIndex((part) => part.type === "image");
    const imageItem = mapPart(message, message.parts[firstImageIndex]!, firstImageIndex);
    return imageItem ? [...items, { ...imageItem, images }] : items;
  });
}

function mapApproval(value: ProtocolApproval): ApprovalRequest {
  return {
    id: value.requestId,
    sessionId: value.sessionId,
    title: value.title,
    reason: value.reason ?? "This action needs your permission.",
    ...(value.command ? { command: value.command } : {}),
    ...(value.workingDirectory ? { directory: value.workingDirectory } : {}),
    ...(value.affectedFiles.length ? { files: [...value.affectedFiles] } : {}),
    choices: value.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      kind: choice.kind === "reject" ? "reject" : "approve",
    })),
  };
}

function mapInput(value: ProtocolInput): InputRequest {
  const requestObject = object(value.request);
  const firstQuestion = object(array(requestObject.questions)[0]);
  const optionSource = array(firstQuestion.options).length ? firstQuestion.options : requestObject.options;
  const options = array(optionSource).map((option) => string(typeof option === "string" ? option : object(option).label)).filter(Boolean);
  return {
    id: value.requestId,
    sessionId: value.sessionId,
    title: string(firstQuestion.header, value.title),
    prompt: string(firstQuestion.question, value.prompt ?? "The coding tool needs more information."),
    answerKey: string(firstQuestion.id || requestObject.questionId, "answer"),
    ...(options.length ? { options } : {}),
  };
}

function modelOptions(values: unknown): ModelOption[] {
  return array(values).map((value) => {
    const model = object(value);
    const metadata = object(model.nativeMetadata);
    const inputModalities = array(model.inputModalities).filter((item): item is "text" | "image" | "audio" => item === "text" || item === "image" || item === "audio");
    const efforts = array(metadata.supportedReasoningEfforts).map((effort) => {
      const item = object(effort);
      return string(item.reasoningEffort || item.id || effort);
    }).filter(Boolean);
    const endpointId = string(metadata.endpointId, string(metadata.sourceProviderId, string(model.endpointId)));
    const endpointName = string(metadata.endpointName, string(metadata.sourceProviderName, string(model.endpointName)));
    const source = string(metadata.source, endpointName ? "Direct API" : string(model.source));
    const walletKind = string(metadata.walletKind, string(metadata.wallet));
    const apiKeyConfigured = typeof metadata.apiKeyConfigured === "boolean" ? metadata.apiKeyConfigured : typeof model.apiKeyConfigured === "boolean" ? model.apiKeyConfigured : undefined;
    const caution = string(metadata.caution, string(model.caution));
    const option: ModelOption = {
      id: string(model.id),
      name: string(model.displayName, string(model.id, "CLI default")),
      ...(model.isDefault === true ? { isDefault: true } : {}),
      efforts: efforts.length ? efforts : ["Default"],
      ...(inputModalities.length ? { inputModalities } : {}),
      ...(endpointId ? { endpointId } : {}),
      ...(endpointName ? { endpointName } : {}),
      ...(source ? { source } : {}),
      ...(apiKeyConfigured !== undefined ? { apiKeyConfigured } : {}),
      ...(caution ? { caution } : {}),
    };
    if (walletKind === "user_api" || walletKind === "harness" || walletKind === "subscription") option.walletKind = walletKind;
    return option;
  }).filter((model) => model.id);
}

export async function loadProviderModels(providers: readonly Provider[]): Promise<Record<string, ModelOption[]>> {
  const models: Record<string, ModelOption[]> = {};
  await Promise.all(providers.filter((provider) => provider.detected).map(async (provider) => {
    try {
      models[provider.id] = modelOptions((await request("models.list", { providerId: provider.id })).models);
    } catch {
      models[provider.id] = [];
    }
  }));
  return models;
}

export async function loadInitialSnapshot(): Promise<{ snapshot: DesktopSnapshot; bootstrap?: DesktopBootstrap }> {
  if (isBrowserPreview) return { snapshot: structuredClone(demoSnapshot), bootstrap: structuredClone(demoBootstrap) };
  const bootstrap = await window.tethoqDesktop.bootstrap();
  const [sessionResponse, approvalsResponse, inputsResponse] = await Promise.all([
    request("sessions.refresh"),
    request("approval.list"),
    request("user_input.list"),
  ]);
  connectorMetadata.clear();
  for (const connector of bootstrap.connectors.loaded) {
    connectorMetadata.set(connector.id, { name: connector.name, supportsAttachments: connector.capabilities.attachments });
  }
  const providers = bootstrap.providers.map(mapProvider);
  const sessions = remoteSessions(sessionResponse.sessions).map(mapSession).filter((session): session is Session => session !== null);
  const models = await loadProviderModels(providers);
  return {
    bootstrap,
    snapshot: {
      connected: bootstrap.host.connectionState === "online",
      hostName: bootstrap.host.displayName,
      providers,
      sessions,
      timelines: {},
      approvals: array(approvalsResponse.approvals).map((value) => mapApproval(value as ProtocolApproval)),
      inputRequests: array(inputsResponse.requests).map((value) => mapInput(value as ProtocolInput)),
      models,
    },
  };
}

export interface SessionTimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
}

export async function loadSessionTimelinePage(sessionId: string, cursor?: string, limit = 40): Promise<SessionTimelinePage> {
  if (isBrowserPreview) return { items: demoSnapshot.timelines[sessionId] ?? [], nextCursor: null };
  const payload = await request("session.open", { sessionId, limit, ...(cursor ? { cursor } : {}) });
  return {
    items: mapMessages(await hydrateHistoryImages(sessionId, remoteMessages(payload.messages))),
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
  };
}

export async function loadSessionTimeline(sessionId: string): Promise<TimelineItem[]> {
  return (await loadSessionTimelinePage(sessionId)).items;
}

export async function refreshAttention(): Promise<{
  approvals: ApprovalRequest[];
  inputRequests: InputRequest[];
}> {
  if (isBrowserPreview) {
    return {
      approvals: demoSnapshot.approvals,
      inputRequests: demoSnapshot.inputRequests,
    };
  }
  const [approvalsResponse, inputsResponse] = await Promise.all([
    request("approval.list"),
    request("user_input.list"),
  ]);
  return {
    approvals: array(approvalsResponse.approvals).map((value) => mapApproval(value as ProtocolApproval)),
    inputRequests: array(inputsResponse.requests).map((value) => mapInput(value as ProtocolInput)),
  };
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function nativeProperties(event: AgentEvent): Record<string, unknown> {
  const native = object(event.nativeEvent);
  const nativePayload = object(native.payload);
  return object(nativePayload.properties ?? object(native.params).update ?? native.params);
}

function eventSources(event: AgentEvent): readonly Record<string, unknown>[] {
  const payload = object(event.payload);
  const native = nativeProperties(event);
  return [
    payload,
    object(payload.item),
    object(payload.part),
    object(payload.toolCall),
    object(payload.content),
    object(object(payload.content).content),
    object(payload.reasoning),
    native,
    object(native.item),
    object(native.part),
    object(native.toolCall),
    object(native.content),
    object(object(native.content).content),
  ];
}

function eventIdentity(event: AgentEvent, kind: "message" | "reasoning" | "tool" | "command" | "file" | "delegation"): string {
  const sources = eventSources(event);
  const keys = kind === "message" || kind === "reasoning"
    ? ["messageId", "messageID", "itemId", "id", "turnId"]
    : kind === "tool" || kind === "command"
      ? ["toolCallId", "tool_call_id", "callId", "callID", "itemId", "id"]
      : ["itemId", "id", "path"];
  for (const key of keys) {
    for (const source of sources) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  // OpenCode deliberately emits only the current text delta in its normalized
  // payload. One stream per content kind is active in a session, and the
  // authoritative history replaces this temporary row when the turn ends.
  return `${event.providerId ?? "provider"}-${kind}-stream`;
}

function eventText(event: AgentEvent, fallback = ""): string {
  const sources = eventSources(event);
  for (const source of sources) {
    const state = object(source.state);
    const result = object(source.result);
    const text = firstText(
      source.text,
      source.delta,
      source.output,
      source.aggregatedOutput,
      source.message,
      source.summary,
      source.description,
      state.output,
      result.text,
    );
    if (text) return text;
  }
  return fallback;
}

function messageKind(event: AgentEvent): "assistant" | "reasoning" {
  const payload = object(event.payload);
  const partType = firstText(payload.partType, object(nativeProperties(event).part).type);
  return partType === "reasoning" || Object.keys(object(payload.reasoning)).length > 0 ? "reasoning" : "assistant";
}

export function eventToTimeline(event: AgentEvent): TimelineItem | null {
  const sessionId = event.sessionId ?? "host";
  if (event.type.startsWith("tool.")) {
    const item = object(event.payload.item);
    const part = object(array(event.payload.parts)[0]);
    const id = eventIdentity(event, "tool");
    return { id: `${sessionId}:tool:${id}`, timestamp: event.occurredAt, kind: part.type === "subagent" ? "subagent" : "tool", title: firstText(event.payload.name, event.payload.tool, item.name, item.tool, event.payload.title, part.summary, "Tool activity"), body: eventText(event, firstText(part.summary, part.prompt, event.type.replaceAll(".", " "))), detail: id, state: event.type === "tool.completed" ? "completed" : "running" };
  }
  if (event.type.startsWith("command.")) {
    const item = object(event.payload.item);
    const toolCall = object(event.payload.toolCall);
    const id = eventIdentity(event, "command");
    return { id: `${sessionId}:command:${id}`, timestamp: event.occurredAt, kind: "command", title: firstText(event.payload.command, item.command, toolCall.command, "Command activity"), body: eventText(event, event.type.replaceAll(".", " ")), state: event.type === "command.completed" ? "completed" : "running" };
  }
  if (event.type === "file.changed") {
    const files = array(event.payload.files).filter((value): value is string => typeof value === "string");
    const path = firstText(event.payload.path, object(event.payload.item).path, files[0]);
    const id = eventIdentity(event, "file");
    return { id: `${sessionId}:file:${id}`, timestamp: event.occurredAt, kind: "file", title: path || "File changed", body: eventText(event, files.join("\n") || path || "File changed"), state: "completed" };
  }
  if (event.type.startsWith("delegation.")) {
    const id = eventIdentity(event, "delegation");
    return { id: `${sessionId}:delegation:${id}`, timestamp: event.occurredAt, kind: "subagent", title: "Delegated agent", body: eventText(event, event.type.replaceAll(".", " ")), state: event.type === "delegation.failed" ? "failed" : event.type === "delegation.completed" ? "completed" : "running" };
  }
  if (event.type === "agent.error") return { id: `${sessionId}:error:${event.eventId}`, timestamp: event.occurredAt, kind: "error", title: "Agent error", body: eventText(event, "Agent error"), state: "failed" };
  if (event.type === "message.delta" || event.type === "message.completed") {
    const kind = messageKind(event);
    const id = eventIdentity(event, kind === "reasoning" ? "reasoning" : "message");
    const phase = kind === "assistant" ? timelineMessagePhase(event.payload.phase) : undefined;
    return { id: `${sessionId}:${kind}:${id}`, messageId: id, timestamp: event.occurredAt, kind, ...(phase ? { phase } : {}), ...(kind === "reasoning" ? { title: "Working" } : {}), body: eventText(event), state: event.type === "message.delta" ? "running" : "completed" };
  }
  return null;
}

export function subscribeToDesktop(
  onBatch: (batch: DesktopEventBatch) => void,
  onRuntime: (state: DesktopRuntimeState) => void,
): () => void {
  if (isBrowserPreview) return () => undefined;
  const removeBatch = window.tethoqDesktop.onEventBatch(onBatch);
  const removeRuntime = window.tethoqDesktop.onRuntimeState(onRuntime);
  return () => { removeBatch(); removeRuntime(); };
}

export async function selectDirectory(defaultPath?: string): Promise<string | null> {
  return isBrowserPreview ? "C:\\Projects\\new-project" : window.tethoqDesktop.selectDirectory(defaultPath);
}

export async function selectImages(): Promise<readonly SelectedImage[]> {
  return isBrowserPreview ? [] : window.tethoqDesktop.selectImages();
}

export function supportsGenericFileAttachments(providerId: string): boolean {
  return providerId === "opencode";
}

export async function selectFiles(providerId: string): Promise<readonly SelectedFile[]> {
  if (!supportsGenericFileAttachments(providerId)) throw new Error("Generic file attachments are available only for OpenCode");
  return isBrowserPreview ? [] : window.tethoqDesktop.selectFiles(providerId);
}

export async function reconnectProvider(providerId: string): Promise<void> {
  if (isBrowserPreview) return;
  await request("provider.reconnect", { providerId });
}

export async function refreshProviders(): Promise<Provider[]> {
  if (isBrowserPreview) return demoSnapshot.providers;
  const payload = await request("provider.list");
  return providerConnections(payload.providers).map(mapProvider);
}

export async function refreshSessions(): Promise<Session[]> {
  if (isBrowserPreview) return demoSnapshot.sessions;
  const payload = await request("sessions.refresh");
  return remoteSessions(payload.sessions).map(mapSession).filter((session): session is Session => session !== null);
}

export { boolean, object, string };
