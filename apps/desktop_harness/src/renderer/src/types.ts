import type { DelegationPresentationSegment, DelegationTarget } from "../../../../../packages/protocol/src/models";

export type ProviderId = string;
export type ProviderFilter = "all" | ProviderId;
export type ProviderFilterSelection = ProviderFilter | readonly ProviderId[];
export type SessionState =
  | "working"
  | "needs_approval"
  | "needs_input"
  | "idle"
  | "completed"
  | "failed"
  | "offline";

export interface Provider {
  id: ProviderId;
  name: string;
  iconDataUrl?: string;
  version?: string;
  state: "online" | "offline" | "error";
  detected: boolean;
  authenticated: boolean;
  executable?: string;
  connectionError?: string;
  capabilities: string[];
  supportsAttachments: boolean;
}

/** A provider-owned pause that is not reasoning and is not a failed turn. */
export interface ProviderStatus {
  kind: "retry";
  message: string;
  retryAt?: string;
}

/** Durable local launch state for a task whose first provider turn is scheduled. */
export interface SessionSchedule {
  id: string;
  runAt: string;
  status: "pending" | "dispatching" | "failed";
  /** Authoritative first instruction retained outside the bounded event replay. */
  content: string;
  failure?: string;
}

export interface Session {
  id: string;
  /** Local unsent task. It becomes a provider session on the first send. */
  draft?: boolean;
  /** Ephemeral cold-start draft that keeps the composer usable while providers hydrate. */
  provisional?: boolean;
  /** Side chats are real provider sessions, but remain nested under their task. */
  sessionKind?: "task" | "side_chat" | "internal";
  parentSessionId?: string;
  relationshipKind?: "handoff" | "branch" | "subagent" | "side_chat";
  relationshipSourceSessionId?: string;
  agentNickname?: string;
  agentRole?: string;
  providerId: ProviderId;
  title: string;
  state: SessionState;
  project: string;
  workingDirectory: string;
  preview: string;
  /** Semantic source for a provider preview whose transport markup was removed. */
  previewKind?: "realtime_voice";
  updatedAt: string;
  model: string;
  effort: string;
  providerStatus?: ProviderStatus;
  unread?: number;
  childCount?: number;
  childProviderIds?: ProviderId[];
  contextSummary?: string;
  /** True when `title` is the user's own local name rather than the provider's. */
  renamed?: boolean;
  /** Local task organisation. Neither flag is sent to a provider. */
  pinned?: boolean;
  archived?: boolean;
  /** Codex Desktop owns this task even when its current turn is idle. */
  externalWriter?: boolean;
  /** Present only until the scheduled first turn starts or is cancelled. */
  schedule?: SessionSchedule;
}

export interface SessionUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  currency?: string;
}

export interface SessionContextState {
  sessionId: string;
  modelId?: string;
  usedTokens: number | null;
  contextWindowTokens: number | null;
  usedPercent: number | null;
  compactionThresholdTokens: number | null;
  minimumThresholdTokens: number | null;
  supportsManualCompaction: boolean;
  supportsThreshold: boolean;
  isCompacting: boolean;
  compactionKind: "automatic" | "manual" | null;
  updatedAt: string;
  usage: SessionUsageTotals;
}

export type SessionGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export interface SessionGoal {
  sessionId: string;
  objective: string;
  status: SessionGoalStatus;
  source: "native" | "tethoq";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export type TimelineKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "command"
  | "file"
  | "subagent"
  | "error";

export interface TimelineItem {
  id: string;
  /** Renderer identity retained while an optimistic row adopts its provider identity. */
  presentationId?: string;
  /** Ordered Mesh references retained across optimistic, live, and persisted messages. */
  mesh?: {
    readonly targets: readonly (DelegationTarget & { readonly modelName?: string })[];
    readonly segments: readonly DelegationPresentationSegment[];
  };
  /** Durable schedule identity retained until the first canonical provider user echo adopts this row. */
  scheduledTaskId?: string;
  /** Stable Bridge delivery used to retry a queued instruction in the same newly created task. */
  queuedNewTaskDeliveryId?: string;
  /** Local-only delivery state retained until the provider's canonical user echo adopts this row. */
  queuedNewTaskDeliveryState?: "pending" | "sending" | "failed";
  /** Calm inline failure detail; never restored into or allowed to overwrite the composer. */
  queuedNewTaskDeliveryError?: string;
  /** Stable provider message identity, used to reveal complete recent messages instead of arbitrary content fragments. */
  messageId?: string;
  /** Stable provider content-part identity, used to reconcile several rows that share one message. */
  providerPartId?: string;
  /** Provider turn identity used to join alternate persisted forms of one user action. */
  turnId?: string;
  /** Marks the provider's canonical persisted representation of a user action. */
  canonicalUserMessage?: boolean;
  kind: TimelineKind;
  /** Provider-supplied assistant phase when the harness distinguishes progress from its final answer. */
  phase?: "commentary" | "final_answer";
  title?: string;
  body: string;
  detail?: string;
  /** App-owned notice presentation for a non-terminal event such as a failed EYES tool call. */
  notice?: "eyes_failure" | "eyes_inspection";
  state?: "running" | "completed" | "failed";
  /** Stable Mesh delegation identity for one materialized child task. */
  delegationId?: string;
  /** Exact child task opened by a top-level spawned-sub-agent row. */
  childSessionId?: string;
  childProviderId?: string;
  childModelId?: string;
  childReasoningEffort?: string;
  timestamp: string;
  images?: TimelineImage[];
  audio?: TimelineAudio[];
  files?: TimelineFile[];
  workflows?: TimelineWorkflow[];
  /** Product-rendered response comments parsed from the provider's text envelope. */
  annotations?: readonly TimelineAnnotation[];
  origin?: TimelineOrigin;
  /** True for a new chunk, false for an authoritative whole-body replacement, omitted for legacy rows. */
  streamDelta?: boolean;
  /** Identity of the event that produced this body, so a replayed batch cannot append twice. */
  sourceEventId?: string;
}

export interface TimelineAnnotation {
  id: string;
  text: string;
  annotation: string;
  audioAttachmentIndex?: number;
  audio?: TimelineAudio;
}

export interface TimelineWorkflow {
  id: string;
  name: string;
  eventCount: number;
  screenshotCount: number;
  applications?: readonly string[];
}

export type TimelineOrigin =
  | { kind: "cross_session"; envelopeId: string; sourceSessionId: string; sourceTitle: string }
  | { kind: "delegation"; sender: "codex" | "tethoq" };

export interface TimelineImage {
  name: string;
  mimeType?: string;
  /** Only renderer-safe data-image or HTTPS URLs are retained for display. */
  dataUrl?: string;
  /** The readable message is visible while its deferred preview is transferring. */
  loading?: boolean;
}

export interface TimelineAudio {
  name: string;
  mimeType: string;
  /** Renderer-safe data-audio URL retained for playback. */
  dataUrl: string;
  durationSeconds?: number;
  /** True for a clip the user spoke, as opposed to an audio file they attached. */
  dictation?: boolean;
}

export interface TimelineFile {
  name: string;
  mimeType?: string;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  title: string;
  reason: string;
  command?: string;
  directory?: string;
  files?: string[];
  choices: Array<{ id: string; label: string; kind: "approve" | "reject" }>;
}

export interface InputRequest {
  id: string;
  sessionId: string;
  title: string;
  prompt: string;
  answerKey: string;
  options?: string[];
}

export interface ModelOption {
  id: string;
  name: string;
  isDefault?: boolean;
  efforts: string[];
  defaultEffort?: string;
  inputModalities?: Array<"text" | "image" | "audio">;
  endpointId?: string;
  endpointName?: string;
  /** Upstream model host reported by a routing provider such as OpenCode. */
  sourceProviderId?: string;
  sourceProviderName?: string;
  source?: string;
  walletKind?: "user_api" | "harness" | "subscription";
  apiKeyConfigured?: boolean;
  /** True only after the provider accepted a live credential-backed probe. */
  apiKeyVerified?: boolean;
  caution?: string;
  /** Provider-reported model facts for the settings catalogue. Absent means unknown. */
  contextWindowTokens?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}

export interface DesktopSnapshot {
  connected: boolean;
  loading?: boolean;
  error?: string;
  hostName: string;
  providers: Provider[];
  sessions: Session[];
  timelines: Record<string, TimelineItem[]>;
  approvals: ApprovalRequest[];
  inputRequests: InputRequest[];
  models: Record<string, ModelOption[]>;
  goals: Record<string, SessionGoal>;
  /** Latest confirmed clear revision per task, used to reject reordered updates. */
  goalClearRevisions: Record<string, number>;
}

export interface NewSessionInput {
  providerId: ProviderId;
  workingDirectory: string;
  instruction: string;
  model?: string;
  effort?: string;
}

export interface SendInput {
  sessionId: string;
  content: string;
  deliveryMode: "queue" | "steer";
  model?: string;
  effort?: string;
  attachments?: string[];
  delegateProviders?: ProviderId[];
}
