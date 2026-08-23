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
  capabilities: string[];
  supportsAttachments: boolean;
}

/** A provider-owned pause that is not reasoning and is not a failed turn. */
export interface ProviderStatus {
  kind: "retry";
  message: string;
  retryAt?: string;
}

export interface Session {
  id: string;
  /** Local unsent task. It becomes a provider session on the first send. */
  draft?: boolean;
  /** Side chats are real provider sessions, but remain nested under their task. */
  sessionKind?: "task" | "side_chat" | "internal";
  parentSessionId?: string;
  relationshipKind?: "handoff" | "branch" | "subagent" | "side_chat";
  agentNickname?: string;
  agentRole?: string;
  providerId: ProviderId;
  title: string;
  state: SessionState;
  project: string;
  workingDirectory: string;
  preview: string;
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
  /** Stable provider message identity, used to reveal complete recent messages instead of arbitrary content fragments. */
  messageId?: string;
  /** Stable provider content-part identity, used to reconcile several rows that share one message. */
  providerPartId?: string;
  kind: TimelineKind;
  /** Provider-supplied assistant phase when the harness distinguishes progress from its final answer. */
  phase?: "commentary" | "final_answer";
  title?: string;
  body: string;
  detail?: string;
  state?: "running" | "completed" | "failed";
  timestamp: string;
  images?: TimelineImage[];
  audio?: TimelineAudio[];
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

export interface TimelineOrigin {
  kind: "cross_session";
  envelopeId: string;
  sourceSessionId: string;
  sourceTitle: string;
}

export interface TimelineImage {
  name: string;
  mimeType?: string;
  /** Only renderer-safe data-image or HTTPS URLs are retained for display. */
  dataUrl?: string;
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
