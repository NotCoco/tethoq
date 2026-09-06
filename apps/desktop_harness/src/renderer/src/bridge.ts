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
import { isPromoPreview, promoChildren, promoSessions, promoSnapshot, promoTimeline, startPromoMesh, subscribePromoPreview } from "./promo";
import type {
  ApprovalRequest,
  DesktopSnapshot,
  InputRequest,
  ModelOption,
  Provider,
  ProviderStatus,
  Session,
  SessionSchedule,
  SessionContextState,
  SessionGoal,
  SessionGoalStatus,
  SessionState,
  TimelineItem,
} from "./types";
import { associateResponseAnnotationAudio, parseResponseAnnotations, visibleResponseAnnotationBody } from "./response_annotations";
import { isLocalImagePath, localMediaPathFromReference, localMediaUrl } from "@shared/local_media";

export const isBrowserPreview = !window.tethoqDesktop;
export const isUserEchoRacePreview = isBrowserPreview && location.hash === "#user-echo-race";

function browserPreviewSubagentCount(): number | undefined {
  if (!isBrowserPreview || (location.hash !== "#subagents-hover" && location.hash !== "#subagents-hover-project")) return undefined;
  const raw = new URLSearchParams(location.search).get("qaSubagentCount");
  if (raw === null || !/^\d+$/u.test(raw)) return undefined;
  const count = Number(raw);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

function withBrowserPreviewSubagentCount(sessions: Session[]): Session[] {
  const count = browserPreviewSubagentCount();
  const projectCohort = isBrowserPreview && location.hash === "#subagents-hover-project";
  if (count === undefined && !projectCohort) return sessions;
  const projectSource = sessions[0];
  return sessions.map((session, index) => ({
    ...session,
    ...(index === 0 && count !== undefined ? { childCount: count } : {}),
    // Project-row QA must contain real adjacent siblings inside one folder.
    // One task per folder cannot expose a group-shell selector leak.
    ...(projectCohort && projectSource && index < 5
      ? { project: projectSource.project, workingDirectory: projectSource.workingDirectory }
      : {}),
  }));
}

function dashboardPreviewSessions(): Session[] {
  return demoSnapshot.sessions.map((session) => session.state === "needs_approval" || session.state === "needs_input" || session.state === "failed"
    ? { ...session, state: "completed" as const }
    : session);
}

let previewOpenCodeSteerQueue: { readonly id: string; readonly sessionId: string; readonly content: string; readonly state: "queued"; readonly attachments: readonly [] } | null = null;
let previewSubagentRequestCount = 0;
let previewUserEchoBatch: ((batch: DesktopEventBatch) => void) | null = null;
const previewGoals = new Map<string, SessionGoal>();
const previewEyesApiKeys = new Set<string>();
const previewContextThresholds = new Map<string, number>();
let previewGoalRevision = 0;

export const demoBrowserState: BrowserWorkspaceState = {
  partition: "persist:tethoq-browser" as const,
  profile: { persistent: true as const, appOwned: true as const, importsSystemProfile: false as const, clearing: false },
  visible: false,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  activeTabId: "preview-browser-tab",
  tabs: [{ id: "preview-browser-tab", title: "Research tab", url: "https://www.google.com/", faviconUrl: null, loading: false, canGoBack: false, canGoForward: false, crashed: false, error: null, muted: false, audible: true }],
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

export class DesktopBridgeRequestError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;

  public constructor(error: { readonly code?: string; readonly message?: string; readonly retryable?: boolean } | undefined) {
    super(error?.message ?? "The desktop bridge request failed.");
    this.name = "DesktopBridgeRequestError";
    this.code = error?.code ?? "DESKTOP_BRIDGE_FAILURE";
    this.retryable = error?.retryable ?? true;
  }
}

export function isDeliveryUnknownError(error: unknown): error is DesktopBridgeRequestError {
  return error instanceof DesktopBridgeRequestError && error.code === "DELIVERY_UNKNOWN" && !error.retryable;
}

function responsePayload(response: Awaited<ReturnType<Window["tethoqDesktop"]["request"]>>): Record<string, unknown> {
  if (!response.ok) throw new DesktopBridgeRequestError(response.error);
  return response.payload;
}

export async function request(type: string, payload: JsonObject = {}, requestId?: string): Promise<Record<string, unknown>> {
  if (isBrowserPreview) {
    if (location.hash === "#mesh-details" && type === "models.list") {
      const providerId = typeof payload.providerId === "string" ? payload.providerId : "";
      const models = demoSnapshot.models[providerId] ?? [];
      return { models: models.map((model) => ({
        id: model.id,
        providerId,
        displayName: model.name,
        ...(model.isDefault ? { isDefault: true } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
        nativeMetadata: {
          supportedReasoningEfforts: model.efforts,
          ...(model.defaultEffort ? { defaultReasoningEffort: model.defaultEffort } : {}),
        },
      })) };
    }
    if (isPromoPreview && type === "models.list") {
      const providerId = typeof payload.providerId === "string" ? payload.providerId : "";
      const models = promoSnapshot()?.models[providerId] ?? [];
      return { models: models.map((model) => ({
        id: model.id,
        providerId,
        displayName: model.name,
        ...(model.isDefault ? { isDefault: true } : {}),
        ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
        nativeMetadata: {
          supportedReasoningEfforts: model.efforts,
          ...(model.defaultEffort ? { defaultReasoningEffort: model.defaultEffort } : {}),
        },
      })) };
    }
    if (isPromoPreview && (type === "delegation.prepare" || type === "delegation.start")) return startPromoMesh(payload);
    if (isPromoPreview && type === "session.children") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      return { sessions: (promoChildren(sessionId) ?? []).map((session) => ({
        id: session.id,
        hostId: "desktop-preview",
        providerId: session.providerId,
        providerSessionId: session.id,
        title: session.title,
        project: session.project,
        workingDirectory: session.workingDirectory,
        state: session.state,
        createdAt: session.updatedAt,
        lastActivityAt: session.updatedAt,
        preview: session.preview,
        modelId: session.model,
        reasoningEffort: session.effort,
        parentSessionId: session.parentSessionId ?? sessionId,
        relationship: { kind: "subagent", sourceSessionId: session.relationshipSourceSessionId ?? sessionId, strategy: "native" },
        ...(session.agentNickname ? { agentNickname: session.agentNickname } : {}),
        ...(session.agentRole ? { agentRole: session.agentRole } : {}),
        needsApproval: false,
        stale: false,
        nativeMetadata: {},
      })) };
    }
    if (type === "session.goal.get") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      return { goal: previewGoals.get(sessionId) ?? null };
    }
    if (type === "session.goal.set") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const previous = previewGoals.get(sessionId);
      const now = new Date().toISOString();
      const goal: SessionGoal = {
        sessionId,
        objective: typeof payload.objective === "string" ? payload.objective : previous?.objective ?? "Finish the task reliably",
        status: goalStatus(payload.status) ?? previous?.status ?? "active",
        source: sessionId === "desktop-harness" ? "native" : "tethoq",
        tokenBudget: payload.tokenBudget === null ? null : finiteNumber(payload.tokenBudget) ?? previous?.tokenBudget ?? null,
        tokensUsed: previous?.tokensUsed ?? 0,
        timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        revision: ++previewGoalRevision,
      };
      previewGoals.set(sessionId, goal);
      return { goal };
    }
    if (type === "session.goal.clear") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const cleared = previewGoals.delete(sessionId);
      return { cleared, revision: cleared ? ++previewGoalRevision : previewGoalRevision };
    }
    if (type === "session.vision.get") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      return { vision: { sessionId, primaryModelSupportsImageInput: sessionId === "auth-regression" ? false : true, configured: null } };
    }
    if (type === "vision.targets") return {
      targets: [{
        providerId: "codex",
        displayName: "OpenAI Codex",
        models: [{ id: "gpt-5.6-sol", providerId: "codex", displayName: "GPT-5.6 Sol", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: ["Low", "Medium", "High", "Ultra"], defaultReasoningEffort: "Medium" } }],
      }, ...(previewEyesApiKeys.size ? [{
        providerId: "direct",
        displayName: "Direct API",
        models: [...previewEyesApiKeys].map((endpointId) => endpointId === "xai"
          ? { id: "xai::grok-4.6", providerId: "direct", displayName: "Grok 4.6", inputModalities: ["text", "image"], nativeMetadata: { sourceProviderId: "xai", walletKind: "user_api", apiKeyConfigured: true, apiKeyVerified: true } }
          : { id: "google::gemini-3.6-flash", providerId: "direct", displayName: "Gemini 3.6 Flash", inputModalities: ["text", "image", "audio"], nativeMetadata: { sourceProviderId: "google", walletKind: "user_api", apiKeyConfigured: true, apiKeyVerified: true } }),
      }] : [])],
      incomplete: false,
    };
    if (type === "session.vision.configure") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      return { vision: { sessionId, primaryModelSupportsImageInput: false, configured: payload.selection ?? null } };
    }
    if (type === "session.context.get") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const context = demoContext(sessionId, previewContextThresholds.get(sessionId) ?? 96_000);
      if (location.hash === "#trace-compacting") {
        context.isCompacting = true;
        context.compactionKind = "automatic";
      }
      return { context };
    }
    if (type === "session.context.set_threshold") {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const thresholdTokens = finiteNumber(payload.thresholdTokens) ?? 96_000;
      previewContextThresholds.set(sessionId, thresholdTokens);
      return { context: demoContext(sessionId, thresholdTokens) };
    }
    if (type === "dictation.source.list" || type === "dictation.source.configure") return {
      sources: [
        {
          id: "openai-stt",
          label: "OpenAI speech-to-text",
          status: location.hash === "#dictation-saved-key" || location.hash === "#dictation-recording" ? "ready" : "needs_credential",
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
      const configured = previewEyesApiKeys.has(endpointId);
      return { wallet: providerId === "direct" ? { providerId, kind: "user_api", label: "Direct API wallet", detail: "Your API key and local spend budget", endpointId, endpointName: endpointId === "openai" ? "OpenAI API" : endpointId, currency: "USD", balance: 25, spent: 3.42, apiKeyConfigured: configured, apiKeyLabel: endpointId === "xai" ? "XAI_API_KEY / GROK_API_KEY" : endpointId === "google" ? "GOOGLE_API_KEY / GEMINI_API_KEY" : "API key", ...(configured ? {} : { caution: "Add an API key before using direct models." }) } : { providerId, kind: providerId === "opencode" ? "harness" : "subscription", label: providerId === "opencode" ? "OpenCode wallet" : "Subscription usage", detail: providerId === "opencode" ? "OpenCode manages this billing route" : "The provider subscription is being used", currency: "USD", apiKeyConfigured: true } };
    }
    if (type === "wallet.configure") {
      const endpointId = typeof payload.endpointId === "string" ? payload.endpointId : "openai";
      if (payload.clearApiKey === true) previewEyesApiKeys.delete(endpointId);
      else previewEyesApiKeys.add(endpointId);
      return { wallet: { providerId: "direct", kind: "user_api", label: "Direct API wallet", detail: "Your API key and local spend budget", endpointId, currency: "USD", ...(payload.clearBalance === true ? {} : { balance: finiteNumber(payload.setBalance) ?? finiteNumber(payload.addBalance) ?? 25 }), spent: 3.42, apiKeyConfigured: payload.clearApiKey !== true, apiKeyLabel: payload.clearApiKey === true ? undefined : "Saved key" } };
    }
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
      const sessionId = `preview-queued-task-${Date.now()}`;
      return {
        session: { ...source, id: sessionId, providerId: typeof payload.providerId === "string" ? payload.providerId : source.providerId, title: "Review the latest desktop layout", preview: "Review the latest desktop layout", state: "working", lastActivityAt: new Date().toISOString(), ...(typeof payload.modelId === "string" ? { modelId: payload.modelId } : {}), ...(typeof payload.reasoningEffort === "string" ? { reasoningEffort: payload.reasoningEffort } : {}) },
        delivery: { id: `${sessionId}:delivery`, sessionId, state: "pending" },
      };
    }
    if (type === "message_queue.deliver_new_task") {
      const deliveryId = typeof payload.deliveryId === "string" ? payload.deliveryId : "preview-queued-task:delivery";
      return { delivery: { id: deliveryId, sessionId: deliveryId.replace(/:delivery$/u, ""), state: "sent" } };
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
  return responsePayload(await window.tethoqDesktop.request(type, payload, requestId));
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

function goalStatus(value: unknown): SessionGoalStatus | undefined {
  return value === "active" || value === "paused" || value === "blocked" || value === "usageLimited" || value === "budgetLimited" || value === "complete" ? value : undefined;
}

export function mapSessionGoal(value: unknown): SessionGoal | null {
  const source = object(value);
  const status = goalStatus(source.status);
  const sessionId = string(source.sessionId);
  const objective = string(source.objective);
  const revision = finiteNumber(source.revision);
  const tokenBudget = source.tokenBudget === null ? null : finiteNumber(source.tokenBudget);
  const tokensUsed = finiteNumber(source.tokensUsed);
  const timeUsedSeconds = finiteNumber(source.timeUsedSeconds);
  const createdAt = string(source.createdAt);
  const updatedAt = string(source.updatedAt);
  if (!sessionId || !objective.trim() || objective.length > 4_000 || status === undefined
    || (source.source !== "native" && source.source !== "tethoq")
    || revision === undefined || !Number.isSafeInteger(revision) || revision < 0
    || (tokenBudget !== null && (tokenBudget === undefined || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
    || tokensUsed === undefined || !Number.isSafeInteger(tokensUsed) || tokensUsed < 0
    || timeUsedSeconds === undefined || !Number.isSafeInteger(timeUsedSeconds) || timeUsedSeconds < 0
    || !createdAt || Number.isNaN(Date.parse(createdAt)) || !updatedAt || Number.isNaN(Date.parse(updatedAt))) return null;
  return {
    sessionId,
    objective: objective.trim(),
    status,
    source: source.source,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
    revision,
  };
}

export async function loadSessionGoal(sessionId: string): Promise<SessionGoal | null> {
  const value = (await request("session.goal.get", { sessionId })).goal;
  if (value === null || value === undefined) return null;
  const goal = mapSessionGoal(value);
  if (goal === null || goal.sessionId !== sessionId) throw new Error("The bridge returned an invalid goal");
  return goal;
}

export async function setSessionGoal(sessionId: string, update: { objective?: string; status?: SessionGoalStatus; tokenBudget?: number | null }): Promise<SessionGoal> {
  const goal = mapSessionGoal((await request("session.goal.set", { sessionId, ...update })).goal);
  if (goal === null || goal.sessionId !== sessionId) throw new Error("The bridge returned an invalid goal");
  return goal;
}

export async function clearSessionGoal(sessionId: string): Promise<{ cleared: boolean; revision: number }> {
  const payload = await request("session.goal.clear", { sessionId });
  if (typeof payload.cleared !== "boolean" || typeof payload.revision !== "number" || !Number.isSafeInteger(payload.revision) || payload.revision < 0) {
    throw new Error("The bridge returned an invalid goal clear result");
  }
  return { cleared: payload.cleared, revision: payload.revision };
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
    ...(connection.lastError?.message ? { connectionError: connection.lastError.message } : {}),
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

export function mapSession(value: RemoteSession, includeDerived = false): Session | null {
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
    ...(value.relationship ? {
      relationshipKind: value.relationship.kind,
      relationshipSourceSessionId: value.relationship.sourceSessionId,
    } : {}),
    ...(value.agentNickname ? { agentNickname: value.agentNickname } : {}),
    ...(value.agentRole ? { agentRole: value.agentRole } : {}),
    providerId: value.providerId,
    title: value.title,
    state: sessionState(value.state),
    ...(value.state === "idle" && typeof metadata.tethoqInterruptedAt === "string" ? { interruptedAt: metadata.tethoqInterruptedAt } : {}),
    project: value.project ?? value.workingDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ?? "Untitled project",
    workingDirectory: value.workingDirectory ?? "",
    preview: visibleResponseAnnotationBody(value.preview ?? "No recent output."),
    ...(metadata.tethoqRealtimeVoice === true ? { previewKind: "realtime_voice" as const } : {}),
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

export interface ActiveScheduledTask {
  readonly sessionId: string;
  readonly schedule: SessionSchedule;
  readonly preview: string;
  readonly session: Session;
}

export interface ScheduledTaskPresentation {
  readonly sessionId: string;
  readonly status: "dispatching" | "started" | "failed";
  readonly presentationId: string;
  readonly item: TimelineItem;
}

export const scheduledTaskPlaceholderPrefix = "scheduled-task:";

export function isScheduledTaskPlaceholderId(sessionId: string): boolean {
  return sessionId.startsWith(scheduledTaskPlaceholderPrefix);
}

export function mapActiveScheduledTask(value: unknown): ActiveScheduledTask | null {
  const task = object(value);
  const requestId = string(task.requestId);
  const sessionId = string(task.targetSessionId);
  const providerId = string(task.providerId);
  const title = string(task.title).trim();
  const workingDirectory = string(task.workingDirectory).trim();
  const createdAt = string(task.createdAt);
  const runAt = string(task.runAt);
  const status = task.status;
  if (!requestId || !sessionId || !providerId || !title || !workingDirectory
    || !runAt || Number.isNaN(Date.parse(runAt)) || !createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  if (status !== "pending" && status !== "dispatching" && status !== "failed") return null;
  const content = string(task.content).trim();
  if (!content) return null;
  const preview = content.length > 180 ? `${content.slice(0, 177).trimEnd()}…` : content;
  const failure = string(task.failureMessage).trim();
  const dispatchingAt = string(task.dispatchingAt);
  const failedAt = string(task.failedAt);
  const updatedAt = status === "dispatching" && !Number.isNaN(Date.parse(dispatchingAt))
    ? dispatchingAt
    : status === "failed" && !Number.isNaN(Date.parse(failedAt)) ? failedAt : createdAt;
  const schedule: SessionSchedule = {
    id: requestId,
    runAt,
    status,
    content,
    ...(failure ? { failure } : {}),
  };
  return {
    sessionId,
    schedule,
    preview,
    session: {
      id: sessionId,
      providerId,
      title,
      state: status === "dispatching" ? "working" : status === "failed" ? "failed" : "idle",
      project: workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "New project",
      workingDirectory,
      preview,
      updatedAt,
      model: string(task.modelId) || "CLI default",
      effort: string(task.reasoningEffort) || "Default",
      schedule,
    },
  };
}

/** Paint the scheduled instruction at dispatch, before a provider can echo it. */
export function mapScheduledTaskPresentation(value: unknown, authoritativeContent?: string): ScheduledTaskPresentation | null {
  const task = object(value);
  const scheduledTaskId = string(task.requestId);
  const sessionId = string(task.targetSessionId);
  const content = string(task.content).trim();
  const dispatchingAt = string(task.dispatchingAt);
  const dispatchingMilliseconds = Date.parse(dispatchingAt);
  const status = task.status;
  if (!scheduledTaskId || !sessionId || !content || !Number.isFinite(dispatchingMilliseconds)) return null;
  if (status !== "dispatching" && status !== "started" && status !== "failed") return null;
  const presentationId = `local-${dispatchingMilliseconds}`;
  return {
    sessionId,
    status,
    presentationId,
    item: {
      id: presentationId,
      presentationId,
      scheduledTaskId,
      kind: "user",
      body: authoritativeContent?.trim() || content,
      timestamp: dispatchingAt,
      state: "completed",
    },
  };
}

export function applyActiveScheduledTasks(sessions: Session[], values: unknown): Session[] {
  const schedules = new Map(array(values).flatMap((value) => {
    const mapped = mapActiveScheduledTask(value);
    return mapped === null ? [] : [[mapped.sessionId, mapped] as const];
  }));
  const hydrated = sessions.map((session) => {
    const scheduled = schedules.get(session.id);
    if (scheduled === undefined) return session;
    schedules.delete(session.id);
    if (scheduled.schedule.status === "failed" && (session.state === "completed"
      || session.state === "failed"
      || session.state === "needs_approval"
      || session.state === "needs_input")) return session;
    const noProviderPreview = !session.preview.trim() || session.preview === "No recent output.";
    return {
      ...session,
      schedule: scheduled.schedule,
      ...(noProviderPreview && scheduled.preview ? { preview: scheduled.preview } : {}),
    };
  });
  return [...schedules.values()].map((scheduled) => scheduled.session).concat(hydrated);
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
const maximumHistoryImageCacheBytes = 64 * 1024 * 1024;
const maximumHistoryImageCacheEntries = 128;
const maximumConcurrentHistoryImageLoads = 4;

interface CachedHistoryImage {
  readonly uri: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

const historyImageCache = new Map<string, CachedHistoryImage>();
const historyImageLoads = new Map<string, Promise<CachedHistoryImage>>();
let historyImageCacheBytes = 0;

function base64ByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function historyImageCacheKey(sessionId: string, retrievalId: string): string {
  return `${sessionId}\u0000${retrievalId}`;
}

function rememberHistoryImage(key: string, image: CachedHistoryImage): void {
  const previous = historyImageCache.get(key);
  if (previous !== undefined) historyImageCacheBytes -= previous.byteLength;
  historyImageCache.delete(key);
  historyImageCache.set(key, image);
  historyImageCacheBytes += image.byteLength;
  while (historyImageCacheBytes > maximumHistoryImageCacheBytes || historyImageCache.size > maximumHistoryImageCacheEntries) {
    const oldestKey = historyImageCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = historyImageCache.get(oldestKey);
    historyImageCache.delete(oldestKey);
    historyImageCacheBytes -= oldest?.byteLength ?? 0;
  }
}

async function retrieveUncachedHistoryImage(sessionId: string, retrievalId: string): Promise<CachedHistoryImage> {
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
      return { uri: `data:${mimeType};base64,${chunks.join("")}`, mimeType, byteLength: totalBytes };
    }
    if (typeof nextOffset !== "number" || !Number.isSafeInteger(nextOffset) || nextOffset !== consumed || nextOffset <= offset || nextOffset >= totalBytes) {
      throw new Error("Bridge returned an invalid next image offset");
    }
    offset = nextOffset;
  }
  throw new Error("Image requires too many chunks");
}

async function retrieveHistoryImage(sessionId: string, retrievalId: string): Promise<CachedHistoryImage> {
  const key = historyImageCacheKey(sessionId, retrievalId);
  const cached = historyImageCache.get(key);
  if (cached !== undefined) {
    historyImageCache.delete(key);
    historyImageCache.set(key, cached);
    return cached;
  }
  const existingLoad = historyImageLoads.get(key);
  if (existingLoad !== undefined) return await existingLoad;
  const load = retrieveUncachedHistoryImage(sessionId, retrievalId);
  historyImageLoads.set(key, load);
  try {
    const image = await load;
    rememberHistoryImage(key, image);
    return image;
  } finally {
    if (historyImageLoads.get(key) === load) historyImageLoads.delete(key);
  }
}

async function hydrateHistoryImages(sessionId: string, messages: readonly RemoteMessage[]): Promise<RemoteMessage[]> {
  const partsByMessage = messages.map((message) => [...message.parts]);
  const pending: Array<{ messageIndex: number; partIndex: number; part: Extract<ContentPart, { type: "image" }> }> = [];
  for (const [messageIndex, message] of messages.entries()) {
    for (const [partIndex, part] of message.parts.entries()) {
      if (part.type === "image" && part.uri === undefined && part.retrievalId !== undefined) {
        pending.push({ messageIndex, partIndex, part });
      }
    }
  }
  let next = 0;
  const worker = async () => {
    for (;;) {
      const job = pending[next++];
      if (job === undefined) return;
      try {
        const image = await retrieveHistoryImage(sessionId, job.part.retrievalId!);
        partsByMessage[job.messageIndex]![job.partIndex] = { ...job.part, uri: image.uri, mimeType: job.part.mimeType ?? image.mimeType };
      } catch {
        // The placeholder remains usable, but stops claiming it is still loading.
        const { retrievalId: _expiredRetrievalId, ...unavailable } = job.part;
        partsByMessage[job.messageIndex]![job.partIndex] = unavailable;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(maximumConcurrentHistoryImageLoads, pending.length) }, worker));
  return messages.map((message, index) => ({ ...message, parts: partsByMessage[index]! }));
}

function historyImagesNeedHydration(messages: readonly RemoteMessage[]): boolean {
  return messages.some((message) => message.parts.some((part) =>
    part.type === "image" && part.uri === undefined && part.retrievalId !== undefined));
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

function timelineOrigin(value: unknown): TimelineItem["origin"] | undefined {
  const origin = object(value);
  if (origin.kind === "delegation") return origin.sender === "codex" || origin.sender === "tethoq" ? { kind: "delegation", sender: origin.sender } : undefined;
  if (origin.kind !== "cross_session" || typeof origin.envelopeId !== "string" || typeof origin.sourceSessionId !== "string" || typeof origin.sourceTitle !== "string") return undefined;
  return {
    kind: "cross_session",
    envelopeId: origin.envelopeId,
    sourceSessionId: origin.sourceSessionId,
    sourceTitle: origin.sourceTitle,
  };
}

function timelineUserRecordMetadata(message: RemoteMessage): Pick<TimelineItem, "turnId" | "canonicalUserMessage"> {
  if (message.role !== "user") return {};
  const turnId = nativeMetadataText(message, "turnId", "turn_id");
  return {
    ...(turnId ? { turnId } : {}),
    ...(message.nativeMetadata.canonicalUserMessage === true ? { canonicalUserMessage: true } : {}),
  };
}

function isEyesToolName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return normalized === "ask_eyes" || normalized.endsWith("_ask_eyes")
    || normalized === "tethoq_turn_support" || normalized.endsWith("_tethoq_turn_support")
    || normalized === "ask_visual_support";
}

/** EYES failures stay useful without trusting a provider or parent-model paraphrase. */
function safeEyesFailureNotice(value: string): string {
  const normalized = value.toLowerCase().slice(0, 24_000);
  // A quota response can mention the credential it applies to. The explicit
  // usage signal owns that mixed case so the notice recommends the right fix.
  if (/\b(?:429|quota|rate[_ -]?limit|usage[_ -]?limit|resource[_ -]?exhausted|insufficient (?:balance|credit)|billing)\b/u.test(normalized)) {
    return "EYES could not use the selected model because its usage limit was reached or it is temporarily rate-limited. Check the provider account or choose another EYES model.";
  }
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|api[_ -]?key|credential|auth(?:entication|ori[sz]ation)?)\b/u.test(normalized)) {
    return "EYES could not use the selected model because its API key is missing, invalid, or no longer accepted. Update the key in EYES settings and try again.";
  }
  if (/\b(?:timed? out|timeout|deadline)\b/u.test(normalized)) return "EYES did not finish inspecting the image. Try again or choose another EYES model.";
  if (/\b(?:abort(?:ed)?|cancel(?:led|ed)?|interrupt(?:ed)?)\b/u.test(normalized)) return "EYES was interrupted before it finished inspecting the image. Try again when you are ready.";
  if (/\b(?:econnrefused|econnreset|enotfound|network|socket|connect(?:ion)?|unavailable|provider stopped|http[_ -]?5\d\d)\b/u.test(normalized)) {
    return "EYES could not reach the selected model. Try again or choose another EYES model.";
  }
  return "EYES could not inspect the image. Try again or choose another EYES model.";
}

function mapPart(message: RemoteMessage, part: ContentPart, index: number): TimelineItem | null {
  const origin = timelineOrigin(message.origin);
  const mesh = message.role === "user" ? object(message.nativeMetadata.tethoqMesh) : {};
  const meshId = string(mesh.delegationId);
  const providerPartId = "providerPartId" in part && typeof part.providerPartId === "string" && part.providerPartId.length > 0
    ? part.providerPartId
    : undefined;
  const base = {
    id: `${message.id}-${index}`,
    messageId: message.providerMessageId || message.id,
    ...(providerPartId ? { providerPartId } : {}),
    ...timelineUserRecordMetadata(message),
    ...(meshId && Array.isArray(mesh.targets) && Array.isArray(mesh.segments) ? {
      delegationId: meshId,
      presentationId: meshId,
      mesh: { targets: mesh.targets, segments: mesh.segments } as NonNullable<TimelineItem["mesh"]>,
    } : {}),
    timestamp: message.createdAt,
    ...(origin ? { origin } : {}),
  };
  switch (part.type) {
    case "text": {
      if (!part.text.trim() && !base.mesh) return null;
      if (message.role === "tool") {
        const title = nativeMetadataText(message, "toolName", "name", "title", "tool") ?? "Tool result";
        const detail = nativeMetadataText(message, "callId", "toolCallId", "tool_call_id");
        if (message.status === "failed" && isEyesToolName(title)) {
          return { ...base, kind: "tool", title: "EYES", body: safeEyesFailureNotice(part.text), ...(detail ? { detail } : {}), notice: "eyes_failure", state: "completed" };
        }
        return { ...base, kind: "tool", title, body: part.text, ...(detail ? { detail } : {}), ...(isEyesToolName(title) ? { notice: "eyes_inspection" } : {}), state: message.status === "streaming" ? "running" : message.status };
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
    case "tool": {
      const body = part.output ?? JSON.stringify(part.input ?? {}, null, 2);
      if (part.status === "failed" && isEyesToolName(part.name)) {
        return { ...base, kind: "tool", title: "EYES", body: safeEyesFailureNotice(body), ...(part.callId ? { detail: part.callId } : {}), notice: "eyes_failure", state: "completed" };
      }
      return { ...base, kind: "tool", title: part.name, body, ...(part.callId ? { detail: part.callId } : {}), ...(isEyesToolName(part.name) ? { notice: "eyes_inspection" } : {}), state: part.status === "pending" ? "running" : part.status };
    }
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
      return { ...base, kind: message.role === "user" ? "user" : "assistant", body: "", images: [{ name: part.name ?? "Attached image", ...(part.mimeType ? { mimeType: part.mimeType } : {}), ...(imageUrl ? { dataUrl: imageUrl } : part.retrievalId ? { loading: true } : {}) }], state: message.status === "streaming" ? "running" : "completed" };
    }
    case "audio": {
      const audioUrl = renderableAudioUri(part.uri);
      return { ...base, kind: message.role === "user" ? "user" : "assistant", body: "", audio: [{ name: part.name, mimeType: part.mimeType, dataUrl: audioUrl, ...(part.durationSeconds !== undefined ? { durationSeconds: part.durationSeconds } : {}) }], state: message.status === "streaming" ? "running" : "completed" };
    }
    case "file":
      return { ...base, kind: message.role === "user" ? "user" : "assistant", body: "", files: [{ name: part.name, ...(part.mimeType ? { mimeType: part.mimeType } : {}) }], state: "completed" };
    case "workflow":
      return null;
  }
}

export function renderableImageUri(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const localPath = localMediaPathFromReference(value);
  if (localPath && isLocalImagePath(localPath)) return localMediaUrl(localPath);
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

export function mapMessages(messages: RemoteMessage[]): TimelineItem[] {
  return messages.flatMap((message) => {
    const userRecordMetadata = timelineUserRecordMetadata(message);
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
    const files = message.parts.flatMap((part, index) => {
      if (part.type !== "file") return [];
      return mapPart(message, part, index)?.files ?? [];
    });
    const items = message.parts.flatMap((part, index) => {
      if (part.type === "image" || part.type === "audio" || part.type === "file") return [];
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
    if (files.length) {
      const messageIndex = mappedItems.findIndex((item) => item.kind === "user" || item.kind === "assistant");
      if (messageIndex >= 0) {
        mappedItems = mappedItems.map((item, index) => index === messageIndex ? { ...item, files: [...(item.files ?? []), ...files] } : item);
      } else {
        mappedItems = [{
          id: `${message.id}-files`,
          messageId: message.providerMessageId || message.id,
          ...userRecordMetadata,
          timestamp: message.createdAt,
          kind: message.role === "assistant" ? "assistant" : "user",
          body: "",
          files,
          state: message.status === "streaming" ? "running" : "completed",
        }, ...mappedItems];
      }
    }
    if (workflows.length) {
      const messageIndex = mappedItems.findIndex((item) => item.kind === "user" || item.kind === "assistant");
      if (messageIndex >= 0) mappedItems = mappedItems.map((item, index) => index === messageIndex ? { ...item, workflows } : item);
      else mappedItems = [{ id: `${message.id}-workflow`, messageId: message.providerMessageId || message.id, ...userRecordMetadata, timestamp: message.createdAt, kind: message.role === "assistant" ? "assistant" : "user", body: "", workflows, state: "completed" }, ...mappedItems];
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

export function mapInput(value: ProtocolInput): InputRequest {
  const requestObject = object(value.request);
  const firstQuestion = object(array(requestObject.questions)[0]);
  const optionSource = array(firstQuestion.options).length ? firstQuestion.options : requestObject.options;
  const options = array(optionSource).map((option) => string(typeof option === "string" ? option : object(option).label)).filter(Boolean);
  const sourceQuestions = array(requestObject.questions);
  const questions = (sourceQuestions.length ? sourceQuestions : [requestObject]).map((source, index) => {
    const question = object(source);
    const choices = array(question.options).flatMap((sourceOption) => {
      const option = object(sourceOption);
      const label = typeof sourceOption === "string" ? sourceOption : string(option.label, string(option.name));
      return label ? [{ value: string(option.value, label), label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
        ...(typeof option.preview === "string" ? { preview: option.preview } : {}),
      }] : [];
    });
    return {
      id: string(question.id, sourceQuestions.length ? `question_${index}` : string(requestObject.questionId, "answer")),
      title: string(question.header, value.title),
      prompt: string(question.question, string(question.prompt, value.prompt ?? "The coding tool needs more information.")),
      options: choices,
      multiple: question.multiple === true || question.multiSelect === true || question.multi_select === true,
      allowCustom: !choices.length || (question.custom !== false && question.isOther !== false),
      secret: question.isSecret === true,
    };
  });
  return {
    id: value.requestId,
    sessionId: value.sessionId,
    title: string(firstQuestion.header, value.title),
    prompt: string(firstQuestion.question, value.prompt ?? "The coding tool needs more information."),
    answerKey: string(firstQuestion.id || requestObject.questionId, "answer"),
    ...(options.length ? { options } : {}),
    questions,
    ...(requestObject.kind === "elicitation" ? { elicitation: requestObject } : {}),
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
    const apiKeyVerified = typeof metadata.apiKeyVerified === "boolean" ? metadata.apiKeyVerified : typeof model.apiKeyVerified === "boolean" ? model.apiKeyVerified : undefined;
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
      ...(apiKeyVerified !== undefined ? { apiKeyVerified } : {}),
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

type ModelCatalogueRequest = (type: string, payload?: JsonObject) => Promise<Record<string, unknown>>;

/** Load and normalize one provider catalogue without mutating renderer state. */
export async function loadProviderModelCatalogue(
  providerId: string,
  catalogueRequest: ModelCatalogueRequest = request,
): Promise<ModelOption[]> {
  const payload = await withTimeout(catalogueRequest("models.list", { providerId }), 12_000);
  return modelOptions(payload.models);
}

export async function loadProviderModels(providers: readonly Provider[]): Promise<Record<string, ModelOption[]>> {
  const models: Record<string, ModelOption[]> = {};
  // Load every provider's catalogue, not only the ones detected right now: the
  // supervised OpenCode server connects asynchronously, and a refresh that
  // skips it would wipe the picker's OpenCode group and the composer's
  // reasoning choice. Each request is capped so one slow or unresponsive
  // enumeration can never block the boot or a refresh.
  let nextProvider = 0;
  const worker = async () => {
    while (nextProvider < providers.length) {
      const provider = providers[nextProvider++];
      if (provider === undefined) continue;
      try {
        models[provider.id] = await loadProviderModelCatalogue(provider.id);
      } catch {
        // Omission means the probe failed. A successful provider is still
        // allowed to return an empty catalogue, but a timeout must never erase
        // the renderer's last known good choices.
      }
    }
  };
  // Model catalogues hydrate after first paint and are independent. Two at a
  // time preserves every provider while preventing twelve CLI/model responses
  // from competing for the main process and the user's machine at once.
  await Promise.all(Array.from({ length: Math.min(2, providers.length) }, worker));
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

export async function loadInitialSnapshot(): Promise<{
  snapshot: DesktopSnapshot;
  bootstrap?: DesktopBootstrap;
  attentionHydration?: Promise<{ approvals: ApprovalRequest[]; inputRequests: InputRequest[] }>;
}> {
  if (isBrowserPreview) {
    const promo = promoSnapshot();
    if (promo) return { snapshot: promo, bootstrap: structuredClone(demoBootstrap) };
    const snapshot = structuredClone(demoSnapshot);
    if (location.hash === "#dashboard") snapshot.sessions = dashboardPreviewSessions();
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
    snapshot.sessions = withBrowserPreviewSubagentCount(snapshot.sessions);
    return { snapshot, bootstrap: structuredClone(demoBootstrap) };
  }
  const [bootstrap, sessionResponse, scheduleResponse] = await Promise.all([
    window.tethoqDesktop.bootstrap(),
    // The Bridge may already hold a sanitized last-known catalogue. Read that
    // cheap cache for first paint; App starts provider reconciliation only
    // after this snapshot exists, so a slow Codex listing cannot blank Tethoq.
    request("sessions.list"),
    request("scheduled_task.list"),
  ]);
  const attentionHydration = Promise.all([
    request("approval.list"),
    request("user_input.list"),
  ]).then(([approvalsResponse, inputsResponse]) => ({
    approvals: array(approvalsResponse.approvals).map((value) => mapApproval(value as ProtocolApproval)),
    inputRequests: array(inputsResponse.requests).map((value) => mapInput(value as ProtocolInput)),
  }));
  connectorMetadata.clear();
  for (const connector of bootstrap.connectors.loaded) {
    connectorMetadata.set(connector.id, { name: connector.name, supportsAttachments: connector.capabilities.attachments });
  }
  const providers = bootstrap.providers.map(mapProvider);
  const sessions = applyActiveScheduledTasks(mapSessionCollection(sessionResponse.sessions), scheduleResponse.tasks);
  return {
    bootstrap,
    attentionHydration,
    snapshot: {
      connected: bootstrap.host.connectionState === "online",
      hostName: bootstrap.host.displayName,
      providers,
      sessions,
      timelines: {},
      approvals: [],
      inputRequests: [],
      // Model catalogues can take their full provider timeout even after the
      // first task page is ready. Paint the task shell now; App hydrates these
      // provider-by-provider in the background without blocking startup.
      models: {},
      goals: {},
      goalClearRevisions: {},
    },
  };
}

export interface SessionTimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
  session?: Session;
  /** Resolves after deferred image previews load; text and placeholders are already in `items`. */
  imageHydration?: Promise<TimelineItem[]>;
}

function timelineWithDelegations(items: TimelineItem[], payload: unknown): TimelineItem[] {
  const combined = [...items, ...delegationTimelineItems(payload)];
  return combined
    .map((item, order) => ({ item, order }))
    .sort((left, right) => {
      const time = (Date.parse(left.item.timestamp) || 0) - (Date.parse(right.item.timestamp) || 0);
      return time || left.order - right.order;
    })
    .map(({ item }) => item);
}

export async function loadSessionTimelinePage(sessionId: string, cursor?: string, limit = 40, refresh = false): Promise<SessionTimelinePage> {
  if (isBrowserPreview) {
    const promoItems = promoTimeline(sessionId);
    if (promoItems) return { items: promoItems, nextCursor: null };
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
    const localModelImagePath = location.hash === "#local-model-image" ? new URLSearchParams(location.search).get("localImage") : null;
    const fixtureItems = localModelImagePath && sessionId === "desktop-harness"
      ? [...items, { id: `${sessionId}:local-model-image`, messageId: "local-model-image-turn", timestamp: new Date().toISOString(), kind: "assistant" as const, phase: "final_answer" as const, body: `Here is the model-created preview:\n\n![Model-created UI preview](<${localModelImagePath}>)`, state: "completed" as const }]
      : items;
    const imageOnlyFixtureItems = location.hash === "#user-image-only" && sessionId === "desktop-harness"
      ? [{
          id: `${sessionId}:image-only-single`, messageId: "image-only-single", timestamp: "2026-08-28T08:00:00.000Z", kind: "user" as const, body: "", state: "completed" as const,
          images: [{ name: "single.png", mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
        }, {
          id: `${sessionId}:image-only-answer`, messageId: "image-only-answer", timestamp: "2026-08-28T08:00:01.000Z", kind: "assistant" as const, phase: "final_answer" as const, body: "The single image stays compact.", state: "completed" as const,
        }, {
          id: `${sessionId}:image-only-many`, messageId: "image-only-many", timestamp: "2026-08-28T08:00:02.000Z", kind: "user" as const, body: "", state: "completed" as const,
          images: Array.from({ length: 5 }, (_, index) => index === 4
            ? { name: `gallery-${index + 1}.png`, mimeType: "image/png", loading: true }
            : { name: `gallery-${index + 1}.png`, mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }),
        }]
      : fixtureItems;
    const settledTraceItems = location.hash === "#trace-collapsed"
      ? settledTracePreview(imageOnlyFixtureItems)
      : imageOnlyFixtureItems;
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
  const [payload, delegationPayload] = await Promise.all([
    request("session.open", { sessionId, limit, ...(cursor ? { cursor } : {}), ...(refresh ? { refresh: true } : {}) }),
    cursor
      ? Promise.resolve(null)
      : request("delegation.list", { parentSessionId: sessionId }).catch(() => null),
  ]);
  const openedSession = payload.session && typeof payload.session === "object" && !Array.isArray(payload.session)
    ? mapSession(payload.session as unknown as RemoteSession, true) ?? undefined
    : undefined;
  const messages = remoteMessages(payload.messages);
  const imageHydration = historyImagesNeedHydration(messages)
    ? hydrateHistoryImages(sessionId, messages).then((hydrated) => mapMessages(hydrated))
    : undefined;
  return {
    items: timelineWithDelegations(mapMessages(messages), delegationPayload),
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null,
    ...(openedSession ? { session: openedSession } : {}),
    ...(imageHydration ? { imageHydration } : {}),
  };
}

export async function loadSessionTimeline(sessionId: string): Promise<TimelineItem[]> {
  return (await loadSessionTimelinePage(sessionId)).items;
}

/** Attach to an already-open task and report whether its watcher is incremental. */
export async function watchSession(sessionId: string): Promise<boolean> {
  if (isBrowserPreview) return true;
  const payload = await request("session.watch", { sessionId });
  return payload.incremental === true;
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
    const promo = promoSnapshot();
    return {
      approvals: promo?.approvals ?? demoSnapshot.approvals,
      inputRequests: promo?.inputRequests ?? demoSnapshot.inputRequests,
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

function eventUserRecordMetadata(event: AgentEvent): Pick<TimelineItem, "turnId" | "canonicalUserMessage"> {
  for (const source of eventSources(event)) {
    const turnId = firstText(source.turnId, source.turn_id);
    if (turnId) {
      return {
        turnId,
        ...(eventSources(event).some((candidate) => candidate.canonicalUserMessage === true)
          ? { canonicalUserMessage: true }
          : {}),
      };
    }
  }
  return eventSources(event).some((source) => source.canonicalUserMessage === true)
    ? { canonicalUserMessage: true }
    : {};
}

function completedUserImageAttachments(event: AgentEvent): NonNullable<TimelineItem["images"]> {
  if (event.type !== "message.completed" || eventRole(event) !== "user") return [];
  return array(event.payload.imageAttachments).flatMap((value) => {
    const descriptor = object(value);
    const rawName = string(descriptor.name).trim();
    const observedName = rawName.replaceAll("\\", "/").split("/").at(-1)?.trim().slice(0, 255) ?? "";
    const name = !observedName || observedName === "." || observedName === ".."
      || /^(?:data|file|https?):/iu.test(rawName) || /[\u0000-\u001f]|;base64,/iu.test(observedName)
      ? "Attached image"
      : observedName;
    const mimeType = string(descriptor.mimeType).trim();
    return [{
      name,
      ...(mimeType.toLowerCase().startsWith("image/") ? { mimeType } : {}),
      loading: true,
    }];
  });
}

function delegationTimelineState(taskState: string, childState: string): NonNullable<TimelineItem["state"]> {
  if (childState === "working" || childState === "needs_approval" || childState === "needs_input") return "running";
  if (childState === "failed") return "failed";
  if (childState === "completed" || childState === "idle" || taskState === "completed") return "completed";
  if (taskState === "failed") return "failed";
  return "running";
}

function delegationCreatedAt(value: unknown, fallback: string): string {
  const candidate = string(value).trim();
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : fallback;
}

/** One persistent, directly navigable transcript row for every materialized child task. */
export function delegationTimelineItems(value: unknown, fallbackTimestamp = new Date().toISOString()): TimelineItem[] {
  const values = Array.isArray(value) ? value : array(object(value).delegations);
  return values.flatMap((candidate): TimelineItem[] => {
    const task = object(candidate);
    const delegationId = string(task.id).trim();
    const parentSessionId = string(task.parentSessionId).trim();
    if (!delegationId || !parentSessionId) return [];
    const taskState = string(task.state).trim();
    const timestamp = delegationCreatedAt(task.createdAt, fallbackTimestamp);
    return array(task.children).flatMap((childValue): TimelineItem[] => {
      const child = object(childValue);
      const childSessionId = string(child.sessionId).trim();
      if (!childSessionId) return [];
      const childId = string(child.id).trim() || childSessionId;
      const childProviderId = string(child.providerId).trim();
      const childModelId = string(child.modelId).trim();
      const childReasoningEffort = string(child.reasoningEffort).trim();
      const childInterruptedAt = string(child.state) === "idle" ? string(child.interruptedAt).trim() : "";
      const body = [childProviderId, childModelId, childReasoningEffort].filter(Boolean).join(" · ");
      return [{
        id: `${parentSessionId}:delegation:${delegationId}:child:${childId}`,
        timestamp,
        kind: "subagent",
        title: "Spawned sub-agent",
        body,
        state: delegationTimelineState(taskState, string(child.state).trim()),
        delegationId,
        childSessionId,
        ...(childProviderId ? { childProviderId } : {}),
        ...(childModelId ? { childModelId } : {}),
        ...(childReasoningEffort ? { childReasoningEffort } : {}),
        ...(childInterruptedAt ? { childInterruptedAt } : {}),
        childStatusUpdatedAt: delegationCreatedAt(task.updatedAt, timestamp),
      }];
    });
  });
}

/** A child session owns its status, independently of the parent turn. */
export function reconcileSubagentTimeline(parentSessionId: string, timeline: readonly TimelineItem[], sessions: readonly Session[]): TimelineItem[] {
  const children = new Map(sessions.filter((session) => session.relationshipKind === "subagent"
    && session.relationshipSourceSessionId === parentSessionId).map((session) => [session.id, session]));
  let changed = false;
  const reconciled = timeline.map((item) => {
    if (item.kind !== "subagent" || !item.childSessionId) return item;
    const child = children.get(item.childSessionId);
    if (!child) return item;
    const state = delegationTimelineState("working", child.state);
    // An older cached session cannot replace a newer settled child row.
    const childUpdatedAt = Date.parse(child.updatedAt);
    const recordedAt = Date.parse(item.childStatusUpdatedAt ?? item.timestamp);
    if (item.state !== "running" && (!Number.isFinite(childUpdatedAt) || childUpdatedAt <= recordedAt)) return item;
    const interruptedAt = child.state === "idle" ? child.interruptedAt : undefined;
    if (state === item.state && interruptedAt === item.childInterruptedAt) return item;
    changed = true;
    const { childInterruptedAt: _previous, ...rest } = item;
    return { ...rest, state, ...(interruptedAt ? { childInterruptedAt: interruptedAt } : {}), childStatusUpdatedAt: child.updatedAt };
  });
  return changed ? reconciled : timeline as TimelineItem[];
}

export function eventToTimeline(event: AgentEvent): TimelineItem | null {
  const sessionId = event.sessionId ?? "host";
  if (event.type === "context.compaction_failed") {
    return { id: `${sessionId}:compaction:${event.eventId}`, timestamp: event.occurredAt, kind: "assistant", title: "System", body: "Compaction could not be completed. You can try again.", state: "completed" };
  }
  if (event.type === "context.compaction_completed") {
    return { id: `${sessionId}:compaction:${event.eventId}`, timestamp: event.occurredAt, kind: "assistant", title: "System", body: "Session compacted", state: "completed" };
  }
  if (event.type.startsWith("tool.")) {
    const item = object(event.payload.item);
    const part = object(array(event.payload.parts)[0]);
    const openCodeSnapshot = event.providerId === "opencode";
    const providerPartId = openCodeSnapshot ? providerPartIdentity(event) : undefined;
    const activityId = eventIdentity(event, "tool");
    const rowId = providerPartId ?? activityId;
    const messageId = openCodeSnapshot ? messageIdentity(event, rowId) : undefined;
    const status = firstText(event.payload.status, object(event.payload.state).status);
    const state = status === "failed" || status === "error"
      ? "failed"
      : event.type === "tool.completed" ? "completed" : "running";
    const title = firstText(event.payload.name, event.payload.tool, item.name, item.tool, event.payload.title, part.summary, "Tool activity");
    const eyesTool = [event.payload.name, event.payload.tool, item.name, item.tool, event.payload.title].some(isEyesToolName);
    const normalBody = eventText(event, firstText(part.summary, part.prompt, event.type.replaceAll(".", " ")));
    const body = eyesTool ? firstText(event.payload.error, item.error, part.error, normalBody) : normalBody;
    const eyesFailure = state === "failed" && eyesTool;
    return {
      id: `${sessionId}:tool:${rowId}`,
      ...(messageId ? { messageId } : {}),
      ...(providerPartId ? { providerPartId } : {}),
      timestamp: event.occurredAt,
      kind: part.type === "subagent" ? "subagent" : "tool",
      title: eyesFailure ? "EYES" : title,
      body: eyesFailure ? safeEyesFailureNotice(body) : body,
      // Disclosure state is keyed from detail. Keep it on the native part id so
      // a late call id enriches the open row without collapsing/remounting it.
      detail: providerPartId ?? activityId,
      ...(eyesTool ? { notice: eyesFailure ? "eyes_failure" as const : "eyes_inspection" as const } : {}),
      state: eyesFailure ? "completed" : state,
      // OpenCode republishes the entire tool part on every update. Treating
      // those snapshots as chunks glues Running..., input, and output together.
      ...(openCodeSnapshot ? { streamDelta: false } : {}),
    };
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
    return delegationTimelineItems([event.payload], event.occurredAt)[0] ?? null;
  }
  if (event.type === "agent.interrupted") {
    const id = eventIdentity(event, "message");
    return { id: `${sessionId}:interrupted:${id}`, messageId: id, timestamp: event.occurredAt, kind: "error", title: "Task interrupted", body: "Task interrupted", state: "failed" };
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
    const origin = timelineOrigin(event.payload.origin);
    return {
      id: `${sessionId}:user:${id}`,
      messageId: id,
      ...eventUserRecordMetadata(event),
      timestamp: event.occurredAt,
      kind: "user",
      ...(origin ? { origin } : {}),
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
    const origin = timelineOrigin(event.payload.origin);
    const body = eventText(event);
    const images = kind === "user" ? completedUserImageAttachments(event) : [];
    // Codex rollout imports arrive as completed user messages rather than the
    // live message.started echo used by other providers. Normalize both routes
    // so a transport envelope can never bypass the annotation UI.
    const responseAnnotations = kind === "user" ? parseResponseAnnotations(body) : null;
    // A provider that rewrites a part rather than extending it marks the payload
    // as a replacement, and its whole text overwrites the row instead of piling
    // a second copy onto what is already shown.
    const streaming = event.type === "message.delta" && event.payload.replace !== true;
    const replacing = event.type === "message.delta" && event.payload.replace === true;
    return { id: `${sessionId}:${kind}:${id}`, messageId: messageIdentity(event, id), ...(providerPartId ? { providerPartId } : {}), ...(kind === "user" ? eventUserRecordMetadata(event) : {}), timestamp: event.occurredAt, kind, ...(phase ? { phase } : {}), ...(origin ? { origin } : {}), ...(kind === "reasoning" ? { title: "Reasoning" } : {}), body: responseAnnotations?.body ?? body, ...(images.length ? { images } : {}), ...(responseAnnotations ? { annotations: responseAnnotations.annotations } : {}), state: event.type === "message.delta" ? "running" : "completed", ...(streaming ? { streamDelta: true, sourceEventId: event.eventId } : replacing ? { streamDelta: false } : {}) };
  }
  return null;
}

/** Most events paint one row; delegation snapshots can materialize several children at once. */
export function eventToTimelineItems(event: AgentEvent): TimelineItem[] {
  if (event.type.startsWith("delegation.")) return delegationTimelineItems([event.payload], event.occurredAt);
  const item = eventToTimeline(event);
  return item ? [item] : [];
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
    if (isPromoPreview) return subscribePromoPreview(onBatch);
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
  if (!isBrowserPreview) return window.tethoqDesktop.selectImages();
  if (location.hash !== "#dictation-recording") return [];
  const dataBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  return Array.from({ length: 4 }, (_, index) => ({
    name: `dense-composer-${index + 1}.png`,
    path: `preview:dense-composer-${index + 1}.png`,
    mimeType: "image/png",
    byteLength: 68,
    dataBase64,
    origin: "file-picker" as const,
  }));
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
  if (isPromoPreview) return promoSessions() ?? [];
  if (isBrowserPreview) return location.hash === "#trace-collapsed"
    ? demoSnapshot.sessions.map((session, index) => index === 0
      ? { ...session, state: "working" as const, childCount: 0, childProviderIds: [] }
      : { ...session, state: "completed" as const })
    : withBrowserPreviewSubagentCount(location.hash === "#dashboard" ? dashboardPreviewSessions() : demoSnapshot.sessions);
  const [payload, schedules] = await Promise.all([
    request("sessions.refresh"),
    request("scheduled_task.list"),
  ]);
  return applyActiveScheduledTasks(mapSessionCollection(payload.sessions), schedules.tasks);
}

/** Read the bridge's live session index without reconnecting or refreshing providers. */
export async function listSessions(): Promise<Session[]> {
  if (isUserEchoRacePreview) return demoSnapshot.sessions.map((session, index) => index === 0 ? { ...session, state: "idle" } : session);
  if (isPromoPreview) return promoSessions() ?? [];
  if (isBrowserPreview) return location.hash === "#trace-collapsed"
    ? demoSnapshot.sessions.map((session, index) => index === 0
      ? { ...session, state: "working" as const, childCount: 0, childProviderIds: [] }
      : { ...session, state: "completed" as const })
    : withBrowserPreviewSubagentCount(location.hash === "#dashboard" ? dashboardPreviewSessions() : demoSnapshot.sessions);
  const [payload, schedules] = await Promise.all([
    request("sessions.list"),
    request("scheduled_task.list"),
  ]);
  return applyActiveScheduledTasks(mapSessionCollection(payload.sessions), schedules.tasks);
}

/** Load real child tasks on demand without exposing hidden helpers in the main task list. */
export async function listChildSessions(sessionId: string): Promise<Session[]> {
  const payload = await request("session.children", { sessionId });
  return remoteSessions(payload.sessions)
    .map((session) => mapSession(session, true))
    .filter((session): session is Session => session !== null && session.relationshipKind === "subagent");
}

export { boolean, object, string };
