import { matchReasoningEffort } from "../../../../../packages/protocol/src/reasoning";

export interface UploadableAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly dataBase64: string;
}

export interface UploadRequest {
  (type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface TranscriptionSource {
  readonly id: string;
  readonly label: string;
  readonly status: "ready" | "needs_credential";
  readonly setupEnvironmentVariable: string;
  readonly credential?: {
    readonly kind: "api_key";
    readonly label: string;
    readonly setupUrl: string;
  };
  readonly capabilities: {
    readonly batch: boolean;
    readonly maxAudioBytes: number;
  };
}

export const maximumMessageAttachmentBytes = 50 * 1024 * 1024;

export function parentSessionIdForBack(session: {
  readonly parentSessionId?: string | undefined;
  readonly relationshipKind?: string | undefined;
}): string | undefined {
  if (session.relationshipKind !== "subagent") return undefined;
  const parentSessionId = session.parentSessionId?.trim();
  return parentSessionId || undefined;
}

export interface ComposerSlashCommand {
  readonly id: string;
  readonly command: string;
  readonly description: string;
}

export const composerSlashCommands: readonly ComposerSlashCommand[] = [
  {
    id: "simplify",
    command: "/simplify",
    description: "Shorten the previous or upcoming answer",
  },
  {
    id: "mesh",
    command: "/mesh",
    description: "Send this turn to other coding tools together",
  },
  {
    id: "ears",
    command: "/ears",
    description: "Configure dictation preprocessing",
  },
  {
    id: "eyes",
    command: "/eyes",
    description: "Choose the model that reads images",
  },
];

export function slashCommandSuggestions(
  value: string,
  commands: readonly ComposerSlashCommand[] = composerSlashCommands,
): readonly ComposerSlashCommand[] | null {
  const match = /^\/([a-z0-9_-]*)$/iu.exec(value);
  if (!match) return null;
  const query = match[1]?.toLowerCase() ?? "";
  return commands.filter((item) => item.command.slice(1).toLowerCase().startsWith(query));
}

export function insertedSlashCommand(command: ComposerSlashCommand): string {
  return `${command.command} `;
}

export function appendAttachmentsWithinLimits<T extends { readonly path: string; readonly byteLength: number }>(
  current: readonly T[],
  incoming: readonly T[],
  maximumCount = 4,
  maximumBytes = maximumMessageAttachmentBytes,
): { readonly items: readonly T[]; readonly acceptedCount: number; readonly rejectedForCount: boolean; readonly rejectedForBytes: boolean } {
  const items = [...current];
  const paths = new Set(items.map((item) => item.path));
  let totalBytes = items.reduce((total, item) => total + item.byteLength, 0);
  let rejectedForCount = false;
  let rejectedForBytes = false;
  for (const item of incoming) {
    if (paths.has(item.path)) continue;
    if (items.length >= maximumCount) {
      rejectedForCount = true;
      continue;
    }
    if (totalBytes + item.byteLength > maximumBytes) {
      rejectedForBytes = true;
      continue;
    }
    items.push(item);
    paths.add(item.path);
    totalBytes += item.byteLength;
  }
  return { items, acceptedCount: items.length - current.length, rejectedForCount, rejectedForBytes };
}

export function resolveComposerModelId(
  models: readonly { readonly id: string; readonly name: string }[],
  sessionModel: string,
): string {
  return models.find((model) => model.id === sessionModel || model.name === sessionModel)?.id ?? "default";
}

export interface ModelCatalogRouteInput {
  readonly id: string;
  readonly name: string;
  readonly endpointName?: string;
  readonly sourceProviderId?: string;
  readonly sourceProviderName?: string;
}

export interface ModelCatalogRoute {
  readonly key: string;
  readonly label: string;
  readonly carriedBy?: string;
}

/** Use provider-reported route metadata; model names are never parsed for ownership. */
export function modelCatalogRoute(
  providerId: string,
  providerName: string,
  model: ModelCatalogRouteInput,
): ModelCatalogRoute {
  if (providerId !== "opencode") return { key: providerId, label: providerName };
  const sourceId = model.sourceProviderId?.trim();
  const sourceName = model.sourceProviderName?.trim();
  const label = sourceName || sourceId || providerName;
  const key = sourceId || sourceName?.toLocaleLowerCase() || providerId;
  const isOpenCodeNative = key.toLocaleLowerCase() === providerId.toLocaleLowerCase()
    || label.toLocaleLowerCase() === providerName.toLocaleLowerCase();
  return { key: `${providerId}:${key}`, label, ...(!isOpenCodeNative ? { carriedBy: providerName } : {}) };
}

export function modelMatchesCatalogQuery(
  query: string,
  providerId: string,
  providerName: string,
  model: ModelCatalogRouteInput,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    model.name,
    model.id,
    providerId,
    providerName,
    model.endpointName,
    model.sourceProviderId,
    model.sourceProviderName,
  ].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
}

const ambiguousSelectionValues = new Set(["", "auto", "default", "cli default", "session default"]);

export function isAmbiguousSelectionValue(value: string | null | undefined): boolean {
  return ambiguousSelectionValues.has(value?.trim().toLowerCase() ?? "");
}

/** Hold follow-up instructions in the queue while a turn is still live. */
export function sessionHoldsFollowUpQueue(
  session: { readonly state: string },
  timeline: readonly { readonly kind?: string; readonly state?: string; readonly phase?: string }[] = [],
): boolean {
  // A completed final answer is terminal evidence for the current turn. Some
  // providers leave the session or an earlier reasoning row marked working for
  // a short time after that answer lands; neither stale note can make Stop a
  // truthful action or hold the next instruction in a queue.
  let latestUser = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "user") { latestUser = index; break; }
  }
  const finalAnswerCompleted = timeline.slice(latestUser + 1).some((item) =>
    item.kind === "assistant" && item.phase === "final_answer" && item.state !== "running");
  if (finalAnswerCompleted) return false;
  if (session.state === "working" || session.state === "needs_approval" || session.state === "needs_input") return true;
  if (session.state === "idle" || session.state === "completed" || session.state === "failed" || session.state === "offline" || session.state === "disconnected") return false;
  return timeline.some((item) => item.state === "running" && item.kind !== "user");
}

/**
 * Whether persisted history can still be missing the latest turn's answer.
 * Task controls and transcript delivery deliberately use different rules: a
 * provider may finish a task before its final reply is visible in history.
 */
export function sessionNeedsTranscriptCatchUp(
  session: { readonly state: string },
  timeline: readonly { readonly kind?: string; readonly state?: string; readonly phase?: string }[] = [],
): boolean {
  let latestUser = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "user") { latestUser = index; break; }
  }
  const latestTurn = timeline.slice(latestUser + 1);
  if (latestTurnHasCompletedFinal(latestTurn)) return false;
  const failed = latestTurn.some((item) => item.kind === "error" || item.state === "failed");
  if (failed || session.state === "failed" || session.state === "offline" || session.state === "disconnected") return false;

  const unfinished = latestTurn.some((item) => item.kind !== "user" && item.state === "running");
  if (unfinished) return true;
  return session.state === "working" || session.state === "needs_approval" || session.state === "needs_input";
}

/** Only an explicitly completed final answer closes a persisted turn. */
export function latestTurnHasCompletedFinal(
  timeline: readonly { readonly kind?: string; readonly state?: string; readonly phase?: string }[],
): boolean {
  let latestUser = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "user") { latestUser = index; break; }
  }
  return timeline.slice(latestUser + 1).some((item) => item.kind === "assistant"
    && item.phase === "final_answer"
    && item.state !== "running");
}

/** Keep terminal-history recovery quick but finite. */
export const terminalTranscriptCatchUpMaxAttempts = 12;

export type ComposerMessageRequestType = "session.send_message" | "session.steer_message" | "message_queue.enqueue";

export function composerMessageRequestType(input: {
  readonly liveGuidance: boolean;
  readonly hasAttachments: boolean;
  readonly blockedByAttention: boolean;
  readonly queueingEnabled: boolean;
  readonly externalWriter: boolean;
  readonly externalWriterAttachmentsSupported?: boolean;
}): ComposerMessageRequestType {
  if (input.externalWriter && input.hasAttachments && input.externalWriterAttachmentsSupported === true) return "session.send_message";
  if (input.externalWriter) return "message_queue.enqueue";
  if (input.liveGuidance) return "session.steer_message";
  if (input.blockedByAttention && input.queueingEnabled) return "message_queue.enqueue";
  return "session.send_message";
}

/**
 * A real follow-up queue entry is pending intent, not transcript history.
 * The one exception is an idle external-writer handoff whose native queue is
 * only the transport used to perform an already-accepted send.
 */
export function composerSubmissionAppearsInTranscript(
  requestType: ComposerMessageRequestType,
  transportOnlySubmission: boolean,
): boolean {
  return requestType !== "message_queue.enqueue" || transportOnlySubmission;
}

export interface TransportQueueSuppression {
  readonly token: string;
  readonly content: string;
  readonly messageId?: string;
}

interface TransportQueueMessage {
  readonly id: string;
  readonly content: string;
}

/**
 * Hides the native queue record used only to cross an external-writer boundary.
 *
 * An idle Codex Desktop task still has to be written through its native queue,
 * but that transport detail is not a pending follow-up. The queue change event
 * can arrive before enqueue returns its id, so content is the temporary identity
 * until the acknowledgement supplies the authoritative message id.
 */
export function visibleTransportQueueMessages<T extends TransportQueueMessage>(
  messages: readonly T[],
  suppressions: readonly TransportQueueSuppression[],
): readonly T[] {
  return messages.filter((message) => !suppressions.some((suppression) => suppression.messageId !== undefined
    ? suppression.messageId === message.id
    : suppression.content === message.content));
}

export function acknowledgeTransportQueueSuppression(
  suppressions: readonly TransportQueueSuppression[],
  token: string,
  messageId: string,
): readonly TransportQueueSuppression[] {
  return suppressions.map((suppression) => suppression.token === token ? { ...suppression, messageId } : suppression);
}

/** A completed persisted Codex final is authoritative terminal evidence. */
export function isPersistedCodexFinalAnswer(event: {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): boolean {
  return event.type === "message.completed"
    && event.payload.source === "codex-local-rollout"
    && event.payload.role === "assistant"
    && event.payload.phase === "final_answer";
}

export interface ConcreteModelSelection {
  readonly modelId: string;
  readonly reasoningEffort?: string;
}

export function resolveConcreteModelSelection(
  models: readonly { readonly id: string; readonly name: string; readonly isDefault?: boolean; readonly efforts: readonly string[]; readonly defaultEffort?: string }[],
  current: { readonly modelId?: string; readonly reasoningEffort?: string } = {},
  preferred?: { readonly modelId: string; readonly reasoningEffort?: string },
): ConcreteModelSelection | null {
  const concreteModel = !isAmbiguousSelectionValue(current.modelId)
    ? models.find((model) => model.id === current.modelId || model.name === current.modelId)
    : undefined;
  const preferredModel = preferred && !isAmbiguousSelectionValue(preferred.modelId)
    ? models.find((model) => model.id === preferred.modelId || model.name === preferred.modelId)
    : undefined;
  const model = concreteModel ?? preferredModel ?? models.find((item) => item.isDefault) ?? models[0];
  if (!model) return null;
  const supportedEfforts = model.efforts.filter((effort) => !isAmbiguousSelectionValue(effort));
  const supported = (value: string | undefined): string | undefined => matchReasoningEffort(value, supportedEfforts);
  const currentEffort = supported(current.reasoningEffort);
  const preferredEffort = preferredModel?.id === model.id ? supported(preferred?.reasoningEffort) : undefined;
  const nativeDefault = supported(model.defaultEffort);
  const reasoningEffort = currentEffort ?? preferredEffort ?? nativeDefault ?? supportedEfforts[0];
  return { modelId: model.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export async function uploadAttachments(
  items: readonly UploadableAttachment[],
  request: UploadRequest,
  onUploadStarted: (uploadId: string) => void,
): Promise<readonly string[]> {
  const attachmentIds: string[] = [];
  for (const item of items) {
    const started = await request("attachment.upload.begin", {
      name: item.name,
      mimeType: item.mimeType,
      byteLength: item.byteLength,
    });
    const uploadId = typeof started.uploadId === "string" ? started.uploadId : "";
    if (!uploadId) throw new Error("The bridge did not start the attachment upload.");
    onUploadStarted(uploadId);
    const chunkBytes = typeof started.chunkBytes === "number"
      ? Math.min(192 * 1024, Math.max(32 * 1024, started.chunkBytes))
      : 192 * 1024;
    const binary = atob(item.dataBase64);
    for (let offset = 0; offset < binary.length; offset += chunkBytes) {
      const end = Math.min(binary.length, offset + chunkBytes);
      let chunk = "";
      for (let index = offset; index < end; index += 1) chunk += binary[index] ?? "";
      await request("attachment.upload.chunk", { uploadId, offset, dataBase64: btoa(chunk) });
    }
    const completed = await request("attachment.upload.complete", { uploadId });
    const attachmentId = typeof completed.attachmentId === "string" ? completed.attachmentId : "";
    if (!attachmentId) throw new Error("The bridge did not complete the attachment upload.");
    attachmentIds.push(attachmentId);
  }
  return attachmentIds;
}

export function chooseTranscriptionSource(
  sources: readonly TranscriptionSource[],
  preferredId?: string | null,
): TranscriptionSource | undefined {
  return sources.find((source) => source.id === preferredId && source.status === "ready")
    ?? sources.find((source) => source.status === "ready")
    ?? sources.find((source) => source.id === preferredId)
    ?? sources[0];
}

/** A missing or disconnected saved microphone always falls back to the system default. */
export function resolvedDictationDeviceId(
  devices: readonly Pick<MediaDeviceInfo, "deviceId" | "kind">[],
  preferredId?: string | null,
): string {
  if (!preferredId) return "";
  return devices.some((device) => device.kind === "audioinput" && device.deviceId === preferredId)
    ? preferredId
    : "";
}

export function dictationAudioConstraints(deviceId?: string | null): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
  };
}

export interface ComposerProviderGate {
  readonly state: string;
  readonly detected: boolean;
  readonly capabilities: readonly string[];
}

/**
 * Sending only needs a live-detected provider with the capability; the event
 * subscription governs live updates, not the ability to send. Requiring the
 * "online" subscription state here blocked the composer whenever a single
 * dropped probe or a not-yet-resubscribed provider left the snapshot stale,
 * even though the bridge would have dispatched the message directly.
 */
export function canSendToProvider(
  provider: ComposerProviderGate | undefined,
  options: { readonly draft: boolean; readonly canCreateDraft: boolean },
): boolean {
  if (provider?.detected !== true) return false;
  if (!provider.capabilities.includes("Send Message")) return false;
  if (options.draft && (!provider.capabilities.includes("Create Session") || !options.canCreateDraft)) return false;
  return true;
}

export const quietCatchUpIntervalMs = 15_000;
export const quietCatchUpSilenceMs = 10_000;

/**
 * How closely to follow a turn this app is not driving.
 *
 * A task started in another OpenCode window runs on that window's own server,
 * which keeps its live stream to itself. The only thing both apps can see is the
 * shared store, and that records a thought once it is finished rather than as it
 * is written. Fifteen seconds of calm polling therefore delivered a working
 * turn's thinking in one lump at the end; at this cadence each thought appears
 * about as soon as it exists. It applies only to the open task, only while that
 * task is working, and only while nothing is arriving live.
 */
export const unownedTurnFollowMs = 750;
export const unownedTurnSilenceMs = 600;

/**
 * Live events are the fast path, but a quiet feed must still heal: provider
 * subscriptions can break (a restarted server, a harness split across processes)
 * while history stays readable. A calm bounded poll re-reads only the selected
 * task, so the view updates itself instead of freezing until a relaunch.
 */
export function quietCatchUpDue(
  lastDeltaAt: number | null,
  now: number,
  silenceMs = quietCatchUpSilenceMs,
): boolean {
  return lastDeltaAt === null || now - lastDeltaAt >= silenceMs;
}

/**
 * A provider may briefly report idle between two slow chunks. Only idle-like
 * states wait for the live-stream quiet window; states that need to change the
 * controls immediately (working, attention, failure, or offline) pass through.
 */
export function shouldApplySessionState(state: string, streamQuiet: boolean): boolean {
  return streamQuiet || (state !== "idle" && state !== "completed" && state !== "unknown");
}

/**
 * Quietness is per session: a burst of live events on one task must not keep
 * the catch-up away from the task the user is actually watching. A session
 * with no recorded delta of its own counts as quiet from the start, no matter
 * how busy the rest of the feed is.
 */
export function selectedSessionLastDeltaAt(
  perSession: ReadonlyMap<string, number>,
  sessionId: string | null,
  fallback: number,
): number {
  if (sessionId === null) return fallback;
  return perSession.get(sessionId) ?? 0;
}

export function isDictationAudioAttachment(attachment: { readonly mimeType: string; readonly origin?: string; readonly kind?: string }): boolean {
  return attachment.origin === "dictation" && attachment.mimeType.toLowerCase().startsWith("audio/") && attachment.kind !== "file";
}

export function newEarsRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ears_${crypto.randomUUID()}`
    : `ears_${Date.now().toString(36)}`;
}

export function classifyDroppedFile(file: { readonly type: string; readonly name: string }): "image" | "file" {
  return file.type.toLowerCase().startsWith("image/") ? "image" : "file";
}

/** Keep dictation clips when EARS can still transcribe them for a text-only destination. */
export function filterAttachmentsForDestination<T extends { readonly mimeType: string; readonly origin?: string; readonly kind?: string }>(
  attachments: readonly T[],
  destinationAcceptsAudio: boolean,
  earsEnabled: boolean,
): readonly T[] {
  if (destinationAcceptsAudio) return attachments;
  return attachments.filter((attachment) => {
    if (!attachment.mimeType.toLowerCase().startsWith("audio/") || attachment.kind === "file") return true;
    return earsEnabled && isDictationAudioAttachment(attachment);
  });
}

/** Direct-audio MP3 is offered only when the selected model can actually hear it. */
export function modelAcceptsDirectAudio(
  model: { readonly id?: string; readonly name?: string; readonly inputModalities?: readonly string[] } | undefined,
): boolean {
  return (model?.inputModalities ?? []).includes("audio");
}

/**
 * Only routes that can deliver an audio attachment to the model may offer MP3.
 * OpenCode forwards file parts with their real mime type; Grok's queue rejects
 * anything that is not an image, so it reaches audio models through EARS instead.
 */
export function providerAcceptsDirectAudio(providerId: string): boolean {
  return providerId === "direct" || providerId === "codex" || providerId === "opencode";
}

export function appendTranscript(content: string, transcript: string): string {
  const clean = transcript.trim();
  if (!clean) return content;
  if (!content) return clean;
  return `${content}${/\s$/.test(content) ? "" : " "}${clean}`;
}

export function growTextarea(textarea: HTMLTextAreaElement, maxHeight = 184): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export async function blobToUploadable(blob: Blob, name = "tethoq-dictation.webm"): Promise<UploadableAttachment> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + step)));
  }
  return {
    name,
    mimeType: blob.type.split(";")[0] || "audio/webm",
    byteLength: bytes.byteLength,
    dataBase64: btoa(binary),
  };
}
