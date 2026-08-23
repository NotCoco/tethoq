import { payloadLooksLikeReasoning, resolveModelReasoningProfile } from "../../../../../packages/protocol/src/reasoning";
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
  ProviderStatus,
  Session,
  SessionContextState,
  SessionState,
  TimelineItem,
} from "./types";
import { associateResponseAnnotationAudio, parseResponseAnnotations, visibleResponseAnnotationBody } from "./response_annotations";

export const isBrowserPreview = !window.tethoqDesktop;
export const isUserEchoRacePreview = isBrowserPreview && location.hash === "#user-echo-race";

let previewOpenCodeSteerQueue: { readonly id: string; readonly sessionId: string; readonly content: string; readonly state: "queued"; readonly attachments: readonly [] } | null = null;
let previewSubagentRequestCount = 0;
let previewUserEchoBatch: ((batch: DesktopEventBatch) => void) | null = null;

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
    compactionKind: null,
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
        models: [{ id: "gpt-5.6-sol", providerId: "codex", displayName: "GPT-5.6 Sol", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: ["Low", "Medium", "High", "Ultra"], defaultReasoningEffort: "Medium" } }],
      }],
    };
    if (type === "session.vision.configure") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      return { vision: { sessionId, primaryModelSupportsImageInput: false, configured: payload.selection ?? null } };
    }
    if (type === "session.context.get") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const context = demoContext(sessionId);
      if (location.hash === "#trace-compacting") {
        context.isCompacting = true;
        context.compactionKind = "automatic";
      }
      return { context };
    }
    if (type === "session.context.set_threshold") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const thresholdTokens = finiteNumber(payload.thresholdTokens) ?? 96_000;
      return { context: demoContext(sessionId, thresholdTokens) };
    }
    if (type === "dictation.source.list" || type === "dictation.source.configure") return {
      sources: [
        {
          id: "openai-stt",
          label: "OpenAI speech-to-text",
          status: "needs_credential",
          setupEnvironmentVariable: "TETHOQ_OPENAI_API_KEY",
          credential: { kind: "api_key", label: "OpenAI API key", setupUrl: "https://platform.openai.com/api-keys" },
          capabilities: { batch: true, maxAudioBytes: 4 * 1024 * 1024 },
        },
        {
          id: "xai-stt",
          label: "xAI speech-to-text",
          status: "needs_credential",
          setupEnvironmentVariable: "XAI_API_KEY",
          credential: { kind: "api_key", label: "xAI API key", setupUrl: "https://console.x.ai/" },
          capabilities: { batch: true, maxAudioBytes: 25 * 1024 * 1024 },
        },
      ],
    };
    if (type === "session.children") {
      const parentSessionId = typeof payload.sessionId === "string" ? payload.sessionId : "desktop-harness";
      const parent = demoSnapshot.sessions.find((session) => session.id === parentSessionId) ?? demoSnapshot.sessions[0];
      const livePreviewState = location.hash === "#subagents"
        ? (["idle", "working", "completed"] as const)[Math.min(previewSubagentRequestCount++, 2)]!
        : "working";
      const children: RemoteSession[] = parent ? [{
        id: "preview-subagent-layout",
        hostId: "desktop-preview",
        providerId: "codex",
        providerSessionId: "preview-subagent-layout",
        title: "Review the desktop layout",
        project: parent.project,
        workingDirectory: parent.workingDirectory,
        state: livePreviewState,
        createdAt: parent.updatedAt,
        lastActivityAt: parent.updatedAt,
        preview: "Checking the current spacing and interaction details.",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
        parentSessionId,
        relationship: { kind: "subagent", sourceSessionId: parentSessionId, strategy: "native" },
        agentNickname: "Layout review",
        agentRole: "UI review",
        needsApproval: false,
        stale: false,
        nativeMetadata: {},
      }] : [];
      if (parent && location.hash === "#subagents") children.push({
        id: "preview-subagent-research",
        hostId: "desktop-preview",
        providerId: "opencode",
        providerSessionId: "preview-subagent-research",
        title: "Research the provider boundary",
        project: parent.project,
        workingDirectory: parent.workingDirectory,
        state: "completed",
        createdAt: parent.updatedAt,
        lastActivityAt: parent.updatedAt,
        preview: "Confirmed the external provider relationship.",
        modelId: "deepseek/deepseek-v4-pro",
        reasoningEffort: "max",
        parentSessionId,
        relationship: { kind: "subagent", sourceSessionId: parentSessionId, strategy: "native" },
        agentNickname: "Provider research",
        agentRole: "Research",
        needsApproval: false,
        stale: false,
        nativeMetadata: {},
      });
      return { sessions: children };
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
    if (type === "side_chat.list") return { sessions: [] };
    if (type === "side_chat.create") {
      const parentSessionId = typeof payload.parentSessionId === "string" ? payload.parentSessionId : "";
      const parent = demoSnapshot.sessions.find((session) => session.id === parentSessionId) ?? demoSnapshot.sessions[0];
      if (!parent) throw new Error("Preview task is unavailable");
      const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      return { session: { ...parent, id: `preview-side-chat-${Date.now()}`, sessionKind: "side_chat", parentSessionId, title: `Side chat: ${parent.title}`, preview: prompt || "Ask about this task without leaving it.", lastActivityAt: new Date().toISOString() } };
    }
    if (type === "side_chat.promote") {
      const source = demoSnapshot.sessions[0];
      if (!source) throw new Error("Preview task is unavailable");
      return { session: { ...source, id: `preview-promoted-${Date.now()}`, sessionKind: "task", title: "Promoted side chat", lastActivityAt: new Date().toISOString() } };
    }
    if (location.hash === "#opencode-queue-steer" && type === "message_queue.enqueue") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const content = typeof payload.content === "string" ? payload.content : "";
      previewOpenCodeSteerQueue = { id: "preview-opencode-steer", sessionId, content, state: "queued", attachments: [] };
      return { message: previewOpenCodeSteerQueue };
    }
    if (location.hash === "#opencode-queue-steer" && type === "message_queue.list") {
      return { messages: previewOpenCodeSteerQueue ? [previewOpenCodeSteerQueue] : [] };
    }
    if (location.hash === "#opencode-queue-steer" && type === "message_queue.deliver") {
      if (payload.messageId !== previewOpenCodeSteerQueue?.id) throw new Error("The preview queued instruction is unavailable.");
      if (payload.mode !== "steer") throw new Error("The active OpenCode turn must use live steering.");
      previewOpenCodeSteerQueue = null;
      return { delivered: true };
    }
    if (type === "message_queue.list" && (location.hash === "#queue-strip" || location.hash === "#queue-new-task")) return { messages: [
      { id: "preview-queued-image", sessionId: payload.sessionId, content: "Review the latest desktop layout\nKeep the controls quiet until hover.", state: "queued", attachments: [
        { name: "desktop-layout.png", mimeType: "image/png", byteLength: 68, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" },
        { name: "reference-without-preview.jpg", mimeType: "image/jpeg", byteLength: 1280 },
        { name: "spoken-note.wav", mimeType: "audio/wav", byteLength: 52, dataUrl: "data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==", durationSeconds: 0.4 },
        { name: "review-notes.md", mimeType: "text/markdown", byteLength: 420 },
      ] },
      { id: "preview-queued-text", sessionId: payload.sessionId, content: "Update the release notes after the review", state: "queued", attachments: [] },
    ] };
    if (type === "message_queue.list") return { messages: [] };
    if (type === "message_queue.edit") return { message: { id: payload.messageId, content: payload.content } };
    if (type === "message_queue.deliver") return { delivered: true };
    if (type === "message_queue.move_to_new_task") {
      const source = demoSnapshot.sessions[0];
      if (!source) throw new Error("Preview task is unavailable");
      return { session: { ...source, id: `preview-queued-task-${Date.now()}`, providerId: typeof payload.providerId === "string" ? payload.providerId : source.providerId, title: "Review the latest desktop layout", preview: "Review the latest desktop layout", state: "working", lastActivityAt: new Date().toISOString(), ...(typeof payload.modelId === "string" ? { modelId: payload.modelId } : {}), ...(typeof payload.reasoningEffort === "string" ? { reasoningEffort: payload.reasoningEffort } : {}) } };
    }
    if (type === "session.send_message") {
      if (location.hash === "#user-echo-race") {
        const content = typeof payload.content === "string" ? payload.content : "";
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "desktop-harness";
        window.setTimeout(() => previewUserEchoBatch?.({
          latestSequence: 1,
          replayGap: false,
          events: [{
            sequence: 1,
            eventId: "user-echo-race-completed",
            type: "message.completed",
            hostId: "desktop-preview",
            providerId: "codex",
            sessionId,
            occurredAt: new Date().toISOString(),
            payload: { messageId: "user-echo-race-message", role: "user", text: content },
          }],
        }), 0);
      }
      return { accepted: true };
    }
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
    compactionKind: context.compactionKind === "automatic" || context.compactionKind === "manual" ? context.compactionKind : null,
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
  if (value === "disconnected") return "offline";
  // Unknown is not offline. ACP listings often omit status; treat that as idle
  // so live working/reasoning is not immediately completed by a refresh.
  if (value === "unknown") return "idle";
  return value as SessionState;
}

/** Accept only the small, display-safe provider status contract. */
export function providerStatusValue(value: unknown): ProviderStatus | undefined {
  const status = object(value);
  if (status.kind !== "retry") return undefined;
  const message = string(status.message).trim();
  if (!message) return undefined;
  const retryAt = string(status.retryAt).trim();
  return {
    kind: "retry",
    message,
    ...(retryAt ? { retryAt } : {}),
  };
}

function mapSession(value: RemoteSession, includeDerived = false): Session | null {
  const sessionKind = value.sessionKind ?? "task";
  const hiddenHelper = !includeDerived && sessionKind !== "side_chat" && value.relationship?.kind === "subagent";
  if (sessionKind === "internal" || hiddenHelper) return null;
  const metadata = object(value.nativeMetadata);
  const contextSummary = string(value.contextHandoffSummary) || string(metadata.tethoqHandoffSummary);
  const providerStatus = providerStatusValue(value.providerStatus);
  return {
    id: value.id,
    sessionKind,
    ...(value.parentSessionId ? { parentSessionId: value.parentSessionId } : {}),
    ...(value.relationship ? { relationshipKind: value.relationship.kind } : {}),
    ...(value.agentNickname ? { agentNickname: value.agentNickname } : {}),
    ...(value.agentRole ? { agentRole: value.agentRole } : {}),
    providerId: value.providerId,
    title: value.title,
    state: sessionState(value.state),
    project: value.project ?? value.workingDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Untitled project",
    workingDirectory: value.workingDirectory ?? "",
    preview: visibleResponseAnnotationBody(value.preview ?? "No recent output."),
    updatedAt: value.lastActivityAt,
    model: value.modelId ?? "CLI default",
    // OpenCode names its reasoning level "variant" (max, high, low, …); native
    // session reasoningEffort wins wherever a harness reports one directly.
    effort: value.reasoningEffort ?? value.variantId ?? "Default",
    ...(providerStatus ? { providerStatus } : {}),
    ...(contextSummary ? { contextSummary } : {}),
    ...(value.externalWriter === true ? { externalWriter: true } : {}),
  };
}

function mapSessionCollection(values: unknown): Session[] {
  const remotes = remoteSessions(values);
  const childProviders = new Map<string, Set<string>>();
  const childCounts = new Map<string, number>();
  for (const session of remotes) {
    if (session.relationship?.kind !== "subagent") continue;
    childCounts.set(session.relationship.sourceSessionId, (childCounts.get(session.relationship.sourceSessionId) ?? 0) + 1);
    const providers = childProviders.get(session.relationship.sourceSessionId) ?? new Set<string>();
    providers.add(session.providerId);
    childProviders.set(session.relationship.sourceSessionId, providers);
  }
  return remotes.map((remote) => {
    const session = mapSession(remote);
    if (session === null) return null;
    const providers = childProviders.get(remote.id);
    return providers === undefined ? session : { ...session, childCount: childCounts.get(remote.id) ?? 0, childProviderIds: [...providers] };
  }).filter((session): session is Session => session !== null);
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

const compactSystemBoundary = /^(?:(?:context|conversation|session)\s+(?:was\s+|has\s+been\s+|automatically\s+)?compacted(?:\s+successfully)?|(?:automatic\s+|context\s+|session\s+)?compaction\s+(?:complete|completed))[.!]?$/iu;
const codexCompactionSummary = /^another language model started to solve this problem and produced a summary of its thinking process\./iu;

function conciseSystemBoundary(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (compactSystemBoundary.test(value) || codexCompactionSummary.test(value)) return value;
  if (value.length > 240) return null;
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

function timelineOrigin(message: RemoteMessage): TimelineItem["origin"] | undefined {
  const origin = message.origin;
  if (!origin || origin.kind !== "cross_session" || typeof origin.envelopeId !== "string" || typeof origin.sourceSessionId !== "string" || typeof origin.sourceTitle !== "string") return undefined;
  return {
    kind: "cross_session",
    envelopeId: origin.envelopeId,
    sourceSessionId: origin.sourceSessionId,
    sourceTitle: origin.sourceTitle,
  };
}

function mapPart(message: RemoteMessage, part: ContentPart, index: number): TimelineItem | null {
  const origin = timelineOrigin(message);
  const providerPartId = "providerPartId" in part && typeof part.providerPartId === "string" && part.providerPartId.length > 0
    ? part.providerPartId
    : undefined;
  const base = {
    id: `${message.id}-${index}`,
    messageId: message.providerMessageId || message.id,
    ...(providerPartId ? { providerPartId } : {}),
    timestamp: message.createdAt,
    ...(origin ? { origin } : {}),
  };
  switch (part.type) {
    case "text": {
      if (!part.text.trim()) return null;
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
      const responseAnnotations = message.role === "user" ? parseResponseAnnotations(part.text) : null;
      return {
        ...base,
        kind: message.role,
        ...(phase ? { phase } : {}),
        body: responseAnnotations?.body ?? part.text,
        ...(responseAnnotations ? { annotations: responseAnnotations.annotations } : {}),
        state: message.status === "streaming" ? "running" : "completed",
      };
    }
    case "reasoning":
      return { ...base, kind: "reasoning", title: part.redacted ? "Protected reasoning" : "Reasoning", body: part.text, state: message.status === "streaming" ? "running" : "completed" };
    case "tool":
      return { ...base, kind: "tool", title: part.name, body: part.output ?? JSON.stringify(part.input ?? {}, null, 2), ...(part.callId ? { detail: part.callId } : {}), state: part.status === "pending" ? "running" : part.status };
    case "command":
      return { ...base, kind: "command", title: part.command, body: part.output ?? part.command, ...(part.cwd ? { detail: part.cwd } : {}), state: part.status === "pending" ? "running" : part.status };
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
    case "audio": {
      const audioUrl = renderableAudioUri(part.uri);
      return { ...base, kind: message.role === "user" ? "user" : "assistant", body: "", audio: [{ name: part.name, mimeType: part.mimeType, dataUrl: audioUrl, ...(part.durationSeconds !== undefined ? { durationSeconds: part.durationSeconds } : {}) }], state: message.status === "streaming" ? "running" : "completed" };
    }
    case "file":
      return { ...base, kind: "file", title: part.name ?? "Attachment", body: part.mimeType ?? "Attached file", state: "completed" };
    case "workflow":
      return null;
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

function renderableAudioUri(value: unknown): string {
  if (typeof value === "string" && /^data:audio\/[a-z0-9.+-]+;base64,/iu.test(value)) return value;
  return "";
}

function mapMessages(messages: RemoteMessage[]): TimelineItem[] {
  return messages.flatMap((message) => {
    const workflows = message.parts.flatMap((part) => part.type === "workflow" ? [{
      id: part.workflow.id,
      name: part.workflow.name,
      eventCount: part.workflow.eventCount,
      screenshotCount: part.workflow.screenshotCount,
      ...(part.workflow.applications?.length ? { applications: part.workflow.applications } : {}),
    }] : []);
    const images = message.parts.flatMap((part, index) => {
      if (part.type !== "image") return [];
      return mapPart(message, part, index)?.images ?? [];
    });
    const audio = message.parts.flatMap((part, index) => {
      if (part.type !== "audio") return [];
      return mapPart(message, part, index)?.audio ?? [];
    });
    const items = message.parts.flatMap((part, index) => {
      if (part.type === "image" || part.type === "audio") return [];
      const item = mapPart(message, part, index);
      return item ? [item] : [];
    });
    let mappedItems = items;
    if (!images.length) {
      mappedItems = items;
    } else {
      const messageIndex = items.findIndex((item) => item.kind === "user" || item.kind === "assistant");
      if (messageIndex >= 0) {
        mappedItems = items.map((item, index) => index === messageIndex ? { ...item, images: [...(item.images ?? []), ...images] } : item);
      } else {
        const firstImageIndex = message.parts.findIndex((part) => part.type === "image");
        const imageItem = mapPart(message, message.parts[firstImageIndex]!, firstImageIndex);
        mappedItems = imageItem ? [...items, { ...imageItem, images }] : items;
      }
    }
    let visibleAudio = audio;
    const annotatedMessageIndex = mappedItems.findIndex((item) => item.annotations?.length);
    if (annotatedMessageIndex >= 0) {
      const annotated = mappedItems[annotatedMessageIndex]!;
      const associated = associateResponseAnnotationAudio(annotated.annotations ?? [], audio);
      mappedItems = mappedItems.map((item, index) => index === annotatedMessageIndex ? { ...item, annotations: associated.annotations } : item);
      visibleAudio = [...associated.remainingAudio];
    }
    if (visibleAudio.length) {
      const messageIndex = mappedItems.findIndex((item) => item.kind === "user" || item.kind === "assistant");
      if (messageIndex >= 0) {
        mappedItems = mappedItems.map((item, index) => index === messageIndex ? { ...item, audio: [...(item.audio ?? []), ...visibleAudio] } : item);
      } else {
        const firstAudioIndex = message.parts.findIndex((part) => part.type === "audio");
        const audioItem = mapPart(message, message.parts[firstAudioIndex]!, firstAudioIndex);
        mappedItems = audioItem ? [...items, { ...audioItem, audio: visibleAudio }] : items;
      }
    }
    if (workflows.length) {
      const messageIndex = mappedItems.findIndex((item) => item.kind === "user" || item.kind === "assistant");
      if (messageIndex >= 0) mappedItems = mappedItems.map((item, index) => index === messageIndex ? { ...item, workflows } : item);
      else mappedItems = [{ id: `${message.id}-workflow`, messageId: message.providerMessageId || message.id, timestamp: message.createdAt, kind: message.role === "assistant" ? "assistant" : "user", body: "", workflows, state: "completed" }, ...mappedItems];
    }

    let originShown = false;
    return mappedItems.map((item) => {
      if (!item.origin) return item;
      if (!originShown) {
        originShown = true;
        return item;
      }
      const rest = { ...item };
      delete rest.origin;
      return rest;
    });
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
    const resolvedEfforts = resolveModelReasoningProfile({
      providerId: string(model.providerId),
      modelId: string(model.id),
      displayName: string(model.displayName, string(model.id)),
      // The whole native blob carries every advertised spelling, including
      // OpenCode's variants object, whose keys name the reasoning levels.
      advertised: metadata,
    });
    const efforts = [...resolvedEfforts.efforts];
    const defaultEffort = string(metadata.defaultReasoningEffort, string(metadata.default_reasoning_effort, resolvedEfforts.defaultEffort ?? ""));
    const endpointId = string(metadata.endpointId, string(metadata.sourceProviderId, string(model.endpointId)));
    const endpointName = string(metadata.endpointName, string(metadata.sourceProviderName, string(model.endpointName)));
    const sourceProviderId = string(metadata.sourceProviderId);
    const sourceProviderName = string(metadata.sourceProviderName);
    const source = string(metadata.source, endpointName ? "Direct API" : string(model.source));
    const walletKind = string(metadata.walletKind, string(metadata.wallet));
    const apiKeyConfigured = typeof metadata.apiKeyConfigured === "boolean" ? metadata.apiKeyConfigured : typeof model.apiKeyConfigured === "boolean" ? model.apiKeyConfigured : undefined;
    const caution = string(metadata.caution, string(model.caution));
    // Providers report these under several native key spellings; each is optional.
    const contextWindowTokens = finiteNumber(metadata.contextWindow) ?? finiteNumber(metadata.contextWindowTokens) ?? finiteNumber(metadata.context_window) ?? finiteNumber(metadata.context_window_tokens);
    const pricing = object(metadata.pricing);
    const inputPricePerToken = finiteNumber(pricing.input);
    const outputPricePerToken = finiteNumber(pricing.output);
    const option: ModelOption = {
      id: string(model.id),
      name: string(model.displayName, string(model.id, "CLI default")),
      ...(model.isDefault === true ? { isDefault: true } : {}),
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(inputModalities.length ? { inputModalities } : {}),
      ...(endpointId ? { endpointId } : {}),
      ...(endpointName ? { endpointName } : {}),
      ...(sourceProviderId ? { sourceProviderId } : {}),
      ...(sourceProviderName ? { sourceProviderName } : {}),
      ...(source ? { source } : {}),
      ...(apiKeyConfigured !== undefined ? { apiKeyConfigured } : {}),
      ...(caution ? { caution } : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(inputPricePerToken !== undefined ? { inputPricePerMillion: inputPricePerToken * 1_000_000 } : {}),
      ...(outputPricePerToken !== undefined ? { outputPricePerMillion: outputPricePerToken * 1_000_000 } : {}),
    };
    if (walletKind === "user_api" || walletKind === "harness" || walletKind === "subscription") option.walletKind = walletKind;
    return option;
  }).filter((model) => model.id);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The request timed out.")), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function loadProviderModels(providers: readonly Provider[]): Promise<Record<string, ModelOption[]>> {
  const models: Record<string, ModelOption[]> = {};
  // Load every provider's catalogue, not only the ones detected right now: the
  // supervised OpenCode server connects asynchronously, and a refresh that
  // skips it would wipe the picker's OpenCode group and the composer's
  // reasoning choice. Each request is capped so one slow or unresponsive
  // enumeration can never block the boot or a refresh.
  await Promise.all(providers.map(async (provider) => {
    try {
      models[provider.id] = modelOptions((await withTimeout(request("models.list", { providerId: provider.id }), 12_000)).models);
    } catch {
      models[provider.id] = [];
    }
  }));
  return models;
}

function settledTracePreview(items: readonly TimelineItem[]): TimelineItem[] {
  let lastAssistant = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  return items.map((item, index) => {
    const settled = item.state === "running" ? { ...item, state: "completed" as const } : item;
    return index === lastAssistant && settled.kind === "assistant" ? { ...settled, phase: "final_answer" as const } : settled;
  });
}

export async function loadInitialSnapshot(): Promise<{ snapshot: DesktopSnapshot; bootstrap?: DesktopBootstrap }> {
  if (isBrowserPreview) {
    const snapshot = structuredClone(demoSnapshot);
    if (isUserEchoRacePreview && snapshot.sessions[0]) {
      snapshot.sessions[0].state = "idle";
      snapshot.sessions[0].title = "User echo race fixture";
      snapshot.timelines[snapshot.sessions[0].id] = [];
    }
    if (location.hash === "#opencode-queue-steer") {
      const openCode = snapshot.sessions.find((session) => session.id === "checkout");
      if (openCode) openCode.state = "working";
    }
    if (location.hash === "#trace-thinking-expanded" && snapshot.sessions[0]) {
      snapshot.timelines[snapshot.sessions[0].id] = (snapshot.timelines[snapshot.sessions[0].id] ?? []).filter((item) => item.id !== "a1");
    }
    const traceSession = snapshot.sessions[0];
    if (location.hash === "#trace-collapsed" && traceSession) {
      // This viewport is the settled compact transcript. Keep the desktop task
      // first in the deterministic picker without leaving a live spinner in the
      // sidebar (or allowing an attention task to steal the initial selection).
      snapshot.sessions = snapshot.sessions.map((session) => ({ ...session, state: "completed" as const }));
      snapshot.sessions[0] = { ...traceSession, state: "working", childCount: 0, childProviderIds: [], preview: "Building a polished desktop workspace, connecting provider-native controls, and validating the complete compact navigation experience across the current task list." };
      snapshot.timelines[traceSession.id] = settledTracePreview(snapshot.timelines[traceSession.id] ?? []);
    }
    return { snapshot, bootstrap: structuredClone(demoBootstrap) };
  }
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
  const sessions = mapSessionCollection(sessionResponse.sessions);
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
  session?: Session;
}

export async function loadSessionTimelinePage(sessionId: string, cursor?: string, limit = 40, refresh = false): Promise<SessionTimelinePage> {
  if (isBrowserPreview) {
    const openCodeToolItems: TimelineItem[] = location.hash === "#opencode-tool-activity" && sessionId === "checkout" ? [{
      id: "tool-qa-user",
      kind: "user",
      body: "Show concrete OpenCode activity details.",
      timestamp: "2026-08-22T00:00:00.000Z",
      state: "completed",
    }, {
      id: "tool-qa-edit",
      messageId: "tool-qa-turn",
      kind: "tool",
      title: "Edit C:\\work\\src\\app.ts",
      body: "File: C:\\work\\src\\app.ts\n\nReplaced:\nconst old = true;\n\nWith:\nconst ready = true;",
      timestamp: "2026-08-22T00:00:01.000Z",
      state: "completed",
    }, {
      id: "tool-qa-write",
      messageId: "tool-qa-turn",
      kind: "tool",
      title: "Write C:\\work\\notes.md",
      body: "File: C:\\work\\notes.md\n\nWritten content:\n# Release notes\n\nReady for review.",
      timestamp: "2026-08-22T00:00:02.000Z",
      state: "completed",
    }, {
      id: "tool-qa-run",
      messageId: "tool-qa-turn",
      kind: "tool",
      title: "Run npm test",
      body: "Command: npm test\n\nWorking directory: C:\\work\n\nResult:\n12 tests passed",
      timestamp: "2026-08-22T00:00:03.000Z",
      state: "completed",
    }, {
      id: "tool-qa-answer",
      messageId: "tool-qa-turn",
      kind: "assistant",
      phase: "final_answer",
      body: "The edit, write, and test run completed.",
      timestamp: "2026-08-22T00:00:04.000Z",
      state: "completed",
    }] : [];
    const baseItems = isUserEchoRacePreview && sessionId === "desktop-harness"
      ? []
      : openCodeToolItems.length
      ? openCodeToolItems
      : demoSnapshot.timelines[sessionId] ?? [];
    const liveReasoningItems = location.hash === "#trace-thinking-expanded" && sessionId === "desktop-harness"
      ? baseItems.filter((item) => item.id !== "a1")
      : baseItems;
    const items = location.hash === "#workflow-message" && sessionId === "desktop-harness"
      ? liveReasoningItems.map((item, index) => index === 0 ? { ...item, workflows: [{ id: "preview-workflow-capture", name: "Test sending comment", eventCount: 442, screenshotCount: 18, applications: ["Codex", "Tethoq"] }] } : item)
      : liveReasoningItems;
    const settledTraceItems = location.hash === "#trace-collapsed"
      ? settledTracePreview(items)
      : items;
    const duplicateCompactionSummary = "## Current task progress\n\nKeep the single formatted summary inside Reasoning.\n\n## Next steps\n\nVerify that no nested duplicate disclosure appears.";
    const previewItems = location.hash === "#trace-compacted-duplicate"
      ? [...items,
          { id: `${sessionId}:duplicate-compaction-user`, messageId: "duplicate-compaction-turn", timestamp: "2026-08-21T12:10:00.000Z", kind: "user" as const, body: "Continue after compaction.", state: "completed" as const },
          { id: `${sessionId}:duplicate-compaction-reasoning`, messageId: "duplicate-compaction-turn", timestamp: "2026-08-21T12:10:01.000Z", kind: "reasoning" as const, title: "Reasoning", body: duplicateCompactionSummary, state: "completed" as const },
          { id: `${sessionId}:duplicate-compaction-record`, messageId: "duplicate-compaction-turn", timestamp: "2026-08-21T12:10:02.000Z", kind: "assistant" as const, phase: "commentary" as const, body: `Another language model started to solve this problem and produced a summary of its thinking process.\n\n${duplicateCompactionSummary}`, state: "completed" as const },
          { id: `${sessionId}:duplicate-compaction-final`, messageId: "duplicate-compaction-turn", timestamp: "2026-08-21T12:10:03.000Z", kind: "assistant" as const, phase: "final_answer" as const, body: "The task continued.", state: "completed" as const }]
      : location.hash.startsWith("#trace-compacted")
        ? [...items, { id: `${sessionId}:automatic-compaction`, timestamp: new Date().toISOString(), kind: "assistant" as const, title: "System", body: "Session compacted", state: "completed" as const }]
        : settledTraceItems;
    return {
      items: previewItems,
      nextCursor: null,
    };
  }
  const payload = await request("session.open", { sessionId, limit, ...(cursor ? { cursor } : {}), ...(refresh ? { refresh: true } : {}) });
  const openedSession = payload.session && typeof payload.session === "object" && !Array.isArray(payload.session)
    ? mapSession(payload.session as unknown as RemoteSession, true) ?? undefined
    : undefined;
  return {
    items: mapMessages(await hydrateHistoryImages(sessionId, remoteMessages(payload.messages))),
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
    ...(openedSession ? { session: openedSession } : {}),
  };
}

export async function loadSessionTimeline(sessionId: string): Promise<TimelineItem[]> {
  return (await loadSessionTimelinePage(sessionId)).items;
}

/** Attach to an already-open task so live deltas keep arriving. Does not reload history. */
export async function watchSession(sessionId: string): Promise<void> {
  if (isBrowserPreview) return;
  await request("session.watch", { sessionId });
}

export async function unwatchSession(sessionId: string): Promise<void> {
  if (isBrowserPreview) return;
  await request("session.unwatch", { sessionId });
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
    object(payload.info),
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

const messageIdentityKeys = ["messageId", "messageID", "itemId", "id", "turnId"] as const;

/**
 * The provider message a row belongs to, which is coarser than the row itself:
 * several parts of one answer share it. Turn grouping and history reveal depend
 * on that coarser identity, so it must not collapse onto a single part.
 */
function messageIdentity(event: AgentEvent, fallback: string): string {
  const sources = eventSources(event);
  for (const key of messageIdentityKeys) {
    for (const source of sources) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return fallback;
}

/** The content part within a provider message; deliberately excludes generic ids. */
function providerPartIdentity(event: AgentEvent): string | undefined {
  const payload = object(event.payload);
  const native = nativeProperties(event);
  for (const source of [payload, native]) {
    const direct = firstText(source.partId, source.partID);
    if (direct) return direct;
    const nestedId = object(source.part).id;
    if (typeof nestedId === "string" && nestedId.length > 0) return nestedId;
  }
  return undefined;
}

function eventIdentity(event: AgentEvent, kind: "message" | "reasoning" | "tool" | "command" | "file" | "delegation"): string {
  const sources = eventSources(event);
  if (kind === "message" || kind === "reasoning") {
    // A nested part.id is just as authoritative as a top-level partId. Resolve it
    // before the coarser message id so sibling parts never share a renderer row.
    const providerPartId = providerPartIdentity(event);
    if (providerPartId) return providerPartId;
  }
  const keys = kind === "message" || kind === "reasoning"
    ? [...messageIdentityKeys]
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
      source.thought,
      source.thinking,
      source.reasoning,
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

function messageKind(event: AgentEvent): "user" | "assistant" | "reasoning" {
  // Persisted provider echoes are not always emitted as message.started. Codex
  // local rollouts arrive as message.completed with role=user; defaulting that
  // record to assistant briefly painted the user's own text with the Codex icon.
  if (eventRole(event) === "user") return "user";
  return payloadLooksLikeReasoning(event.payload) || payloadLooksLikeReasoning(nativeProperties(event))
    ? "reasoning"
    : "assistant";
}

export function eventToTimeline(event: AgentEvent): TimelineItem | null {
  const sessionId = event.sessionId ?? "host";
  if (event.type === "context.compaction_completed") {
    return { id: `${sessionId}:compaction:${event.eventId}`, timestamp: event.occurredAt, kind: "assistant", title: "System", body: "Session compacted", state: "completed" };
  }
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
    const command = firstText(event.payload.command, item.command, toolCall.command, "Command activity");
    const suppliedBody = eventText(event).trim();
    const body = suppliedBody && !/^command(?:\s+is)?\s+(?:running|started|activity)(?:[.…]+)?$/iu.test(suppliedBody)
      ? suppliedBody
      : command;
    return { id: `${sessionId}:command:${id}`, messageId: id, timestamp: event.occurredAt, kind: "command", title: command, body, state: event.type === "command.completed" ? "completed" : "running" };
  }
  if (event.type === "file.changed") {
    const files = array(event.payload.files).flatMap((value) => {
      if (typeof value === "string" && value.trim()) return [value.trim()];
      const path = object(value).path;
      return typeof path === "string" && path.trim() ? [path.trim()] : [];
    });
    const path = firstText(event.payload.path, object(event.payload.item).path, files[0]);
    const suppliedBody = eventText(event).trim();
    const meaningfulBody = suppliedBody && !/^files?\s+(?:changed|updated|modified)[.!]?$/iu.test(suppliedBody)
      ? suppliedBody
      : "";
    if (!path && files.length === 0) return null;
    const id = eventIdentity(event, "file");
    return { id: `${sessionId}:file:${id}`, timestamp: event.occurredAt, kind: "file", title: path, body: meaningfulBody || files.join("\n") || path, state: "completed" };
  }
  if (event.type.startsWith("delegation.")) {
    const id = eventIdentity(event, "delegation");
    return { id: `${sessionId}:delegation:${id}`, timestamp: event.occurredAt, kind: "subagent", title: "Delegated agent", body: eventText(event, event.type.replaceAll(".", " ")), state: event.type === "delegation.failed" ? "failed" : event.type === "delegation.completed" ? "completed" : "running" };
  }
  if (event.type === "agent.error") return { id: `${sessionId}:error:${event.eventId}`, timestamp: event.occurredAt, kind: "error", title: "Agent error", body: eventText(event, "Agent error"), state: "failed" };
  // ACP harnesses echo the prompt back as a user chunk on message.started. Without
  // this the message you just sent stays invisible until the whole turn finishes
  // and history reloads, which reads as the chat being frozen.
  if (event.type === "message.started" && eventRole(event) === "user") {
    const body = eventText(event);
    if (!body) return null;
    const responseAnnotations = parseResponseAnnotations(body);
    const id = eventIdentity(event, "message");
    return {
      id: `${sessionId}:user:${id}`,
      messageId: id,
      timestamp: event.occurredAt,
      kind: "user",
      body: responseAnnotations?.body ?? body,
      ...(responseAnnotations ? { annotations: responseAnnotations.annotations } : {}),
      state: "completed",
      streamDelta: true,
      sourceEventId: event.eventId,
    };
  }
  if (event.type === "message.delta" || event.type === "message.completed") {
    const kind = messageKind(event);
    const id = eventIdentity(event, kind === "reasoning" ? "reasoning" : "message");
    const providerPartId = providerPartIdentity(event);
    const phase = kind === "assistant" ? timelineMessagePhase(event.payload.phase) : undefined;
    // A provider that rewrites a part rather than extending it marks the payload
    // as a replacement, and its whole text overwrites the row instead of piling
    // a second copy onto what is already shown.
    const streaming = event.type === "message.delta" && event.payload.replace !== true;
    const replacing = event.type === "message.delta" && event.payload.replace === true;
    return { id: `${sessionId}:${kind}:${id}`, messageId: messageIdentity(event, id), ...(providerPartId ? { providerPartId } : {}), timestamp: event.occurredAt, kind, ...(phase ? { phase } : {}), ...(kind === "reasoning" ? { title: "Reasoning" } : {}), body: eventText(event), state: event.type === "message.delta" ? "running" : "completed", ...(streaming ? { streamDelta: true, sourceEventId: event.eventId } : replacing ? { streamDelta: false } : {}) };
  }
  return null;
}

function eventRole(event: AgentEvent): string {
  for (const source of eventSources(event)) {
    if (typeof source.role === "string" && source.role.length > 0) return source.role;
  }
  return "";
}

/** Mirrors the Bridge rule so a delayed user echo cannot hide an active retry. */
export function eventClearsProviderStatus(event: AgentEvent): boolean {
  if (event.type === "message.started") return eventRole(event) === "assistant";
  if (event.type === "message.delta") return typeof event.payload.text === "string" && event.payload.text.length > 0;
  if (event.type === "message.completed") return true;
  return event.type === "tool.started" || event.type === "tool.output" || event.type === "tool.completed"
    || event.type === "command.started" || event.type === "command.output" || event.type === "command.completed"
    || event.type === "agent.completed" || event.type === "agent.interrupted" || event.type === "agent.error";
}

export function subscribeToDesktop(
  onBatch: (batch: DesktopEventBatch) => void,
  onRuntime: (state: DesktopRuntimeState) => void,
): () => void {
  if (isBrowserPreview) {
    if (location.hash === "#user-echo-race") {
      previewUserEchoBatch = onBatch;
      return () => {
        if (previewUserEchoBatch === onBatch) previewUserEchoBatch = null;
      };
    }
    if (location.hash === "#message-error") {
      const error = window.setTimeout(() => onBatch({
        latestSequence: 1,
        replayGap: false,
        events: [{
          sequence: 1,
          eventId: "visual-agent-error",
          type: "agent.error",
          hostId: "desktop-preview",
          providerId: "codex",
          sessionId: "desktop-harness",
          occurredAt: new Date().toISOString(),
          payload: { message: "exceeded retry limit, last status: 429 Too Many Requests, request id: visual-request-secret" },
        }],
      }), 60);
      return () => window.clearTimeout(error);
    }
    if (location.hash !== "#composer-stream-follow") return () => undefined;
    const streamPart = (start: number, count: number) => Array.from({ length: count }, (_, index) => `Streaming layout line ${start + index + 1}: keeping the current answer readable above the composer.\n`).join("");
    const emit = (sequence: number, delta: string) => onBatch({
      latestSequence: sequence,
      replayGap: false,
      events: [{
        sequence,
        eventId: `visual-stream-${sequence}`,
        type: "message.delta",
        hostId: "desktop-preview",
        providerId: "codex",
        sessionId: "desktop-harness",
        occurredAt: new Date(Date.now() + sequence).toISOString(),
        payload: { messageId: "visual-stream", delta },
      }],
    });
    const first = window.setTimeout(() => emit(1, `QA_STREAM_START\n${streamPart(0, 20)}`), 40);
    const second = window.setTimeout(() => emit(2, `${streamPart(20, 20)}QA_STREAM_END`), 100);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }
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
  if (isUserEchoRacePreview) return demoSnapshot.sessions.map((session, index) => index === 0 ? { ...session, state: "idle" } : session);
  if (isBrowserPreview) return location.hash === "#trace-collapsed"
    ? demoSnapshot.sessions.map((session, index) => index === 0
      ? { ...session, state: "working" as const, childCount: 0, childProviderIds: [] }
      : { ...session, state: "completed" as const })
    : demoSnapshot.sessions;
  const payload = await request("sessions.refresh");
  return mapSessionCollection(payload.sessions);
}

/** Read the bridge's live session index without reconnecting or refreshing providers. */
export async function listSessions(): Promise<Session[]> {
  if (isUserEchoRacePreview) return demoSnapshot.sessions.map((session, index) => index === 0 ? { ...session, state: "idle" } : session);
  if (isBrowserPreview) return location.hash === "#trace-collapsed"
    ? demoSnapshot.sessions.map((session, index) => index === 0
      ? { ...session, state: "working" as const, childCount: 0, childProviderIds: [] }
      : { ...session, state: "completed" as const })
    : demoSnapshot.sessions;
  const payload = await request("sessions.list");
  return mapSessionCollection(payload.sessions);
}

/** Load real child tasks on demand without exposing hidden helpers in the main task list. */
export async function listChildSessions(sessionId: string): Promise<Session[]> {
  const payload = await request("session.children", { sessionId });
  return remoteSessions(payload.sessions)
    .map((session) => mapSession(session, true))
    .filter((session): session is Session => session !== null && session.relationshipKind === "subagent");
}

export { boolean, object, string };
