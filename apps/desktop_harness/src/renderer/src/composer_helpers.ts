import { matchReasoningEffort } from "../../../../../packages/protocol/src/reasoning";
import AttachmentEncodingWorker from "./attachment_encoding.worker.ts?worker&inline";
import type { SessionState } from "./types";

export { encodeAttachmentBytesToBase64 } from "./attachment_base64";

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
    id: "goal",
    command: "/goal",
    description: "Set or manage this task's goal",
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
  {
    id: "schedule",
    command: "/schedule",
    description: "Run a new task at a later time",
  },
];

export function slashCommandSuggestions(
  value: string,
  commands: readonly ComposerSlashCommand[] = composerSlashCommands,
): readonly ComposerSlashCommand[] | null {
  // A slash query belongs to the draft token at the caret/end, not only to an
  // otherwise empty draft. Requiring whitespace (or the start) before the slash
  // keeps URL paths and embedded text such as `tool/mesh` out of the palette.
  const match = /(?:^|\s)\/([a-z0-9_-]*)$/iu.exec(value);
  if (!match) return null;
  const query = match[1]?.toLowerCase() ?? "";
  return commands.filter((item) => item.command.slice(1).toLowerCase().startsWith(query));
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function slashCommandTokenMatch(value: string, command: string): RegExpExecArray | null {
  return new RegExp(`(^|[\\s\\uE000-\\uF8FF])${escapedRegExp(command)}(?=$|\\s)`, "iu").exec(value);
}

export function hasSlashCommandToken(value: string, command: string): boolean {
  return slashCommandTokenMatch(value, command) !== null;
}

export function removeSlashCommandToken(value: string, command: string): string {
  const match = slashCommandTokenMatch(value, command);
  if (!match) return value;
  const tokenStart = match.index + (match[1]?.length ?? 0);
  const tokenEnd = tokenStart + command.length;
  let before = value.slice(0, tokenStart);
  let after = value.slice(tokenEnd);
  if (!before.trim()) after = after.replace(/^\s/u, "");
  else if (!after.trim()) before = before.replace(/\s$/u, "");
  else if (/\s$/u.test(before) && /^\s/u.test(after)) after = after.replace(/^\s/u, "");
  return `${before}${after}`;
}

export function insertedSlashCommand(command: ComposerSlashCommand, value = "", caret = value.length): string {
  const prefix = value.slice(0, caret);
  const match = /(^|[\s\uE000-\uF8FF])\/[a-z0-9_-]*$/iu.exec(prefix);
  if (!match) return `${command.command} `;
  const queryStart = match.index + (match[1]?.length ?? 0);
  return `${value.slice(0, queryStart)}${command.command} ${value.slice(caret)}`;
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
  const resolved = models.find((model) => model.id === sessionModel || model.name === sessionModel)?.id;
  if (resolved) return resolved;
  return isAmbiguousSelectionValue(sessionModel) ? "default" : sessionModel.trim();
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

type SessionPresentationItem = {
  readonly id?: string;
  readonly presentationId?: string;
  readonly messageId?: string;
  readonly providerPartId?: string;
  readonly turnId?: string;
  readonly kind?: string;
  readonly state?: string;
  readonly phase?: string;
  readonly notice?: string;
  readonly title?: string;
  readonly body?: string;
};

const turnContinuationKinds = new Set(["reasoning", "tool", "command", "file", "subagent"]);
const compactionBoundaryText = /(?:\b(?:context|conversation|session)\s+(?:was\s+|has\s+been\s+|automatically\s+)?compacted\b|\b(?:automatic\s+|context\s+|session\s+)?compaction\s+(?:complete|completed)\b)/iu;

function isTurnContinuationAfterFinal(item: SessionPresentationItem): boolean {
  if (item.state === "running") return true;
  if (turnContinuationKinds.has(item.kind ?? "")) return true;
  if (item.kind !== "assistant") return false;
  if (compactionBoundaryText.test(`${item.title ?? ""} ${item.body ?? ""}`.trim())) return true;
  return item.phase !== "final_answer";
}

/** The visible ending which existed immediately before a newer live turn event. */
export interface SessionWorkingBoundary {
  readonly visibleEndingIdentity: string | null;
}

function timelineItemIdentity(item: SessionPresentationItem): string | null {
  const identity = item.providerPartId ?? item.messageId ?? item.turnId ?? item.presentationId ?? item.id;
  return identity?.trim() ? identity : null;
}

/** Stable identity of the newest final reply, interruption, or failure on screen. */
export function latestVisibleEndingIdentity(timeline: readonly SessionPresentationItem[]): string | null {
  let ending: string | null = null;
  for (const item of timeline) {
    const endingKind = item.kind === "error"
      ? "error"
      : item.kind === "assistant" && item.phase === "final_answer" && item.state !== "running" ? "final" : null;
    if (endingKind === null) continue;
    const identity = timelineItemIdentity(item);
    if (identity !== null) ending = `${endingKind}:${identity}`;
  }
  return ending;
}

export function captureSessionWorkingBoundary(timeline: readonly SessionPresentationItem[]): SessionWorkingBoundary {
  return { visibleEndingIdentity: latestVisibleEndingIdentity(timeline) };
}

/** The newer turn has not yet painted its own final reply, interruption, or failure. */
export function sessionBoundaryNeedsVisibleEnding(
  timeline: readonly SessionPresentationItem[],
  workingBoundary: SessionWorkingBoundary | undefined,
): boolean {
  return workingBoundary !== undefined
    && workingBoundary.visibleEndingIdentity === latestVisibleEndingIdentity(timeline);
}

/** Reconcile a boundary against a canonical history page without inventing a second turn. */
export function canonicalSessionWorkingBoundary(
  session: { readonly state: string },
  timeline: readonly SessionPresentationItem[],
  current: SessionWorkingBoundary | undefined,
): SessionWorkingBoundary | undefined {
  if (current !== undefined) {
    return sessionBoundaryNeedsVisibleEnding(timeline, current) ? current : undefined;
  }
  return session.state === "working" ? captureSessionWorkingBoundary(timeline) : undefined;
}

function hasFreshProviderWorkingState(
  session: { readonly state: string },
  timeline: readonly SessionPresentationItem[],
  workingBoundary: SessionWorkingBoundary | undefined,
): boolean {
  return session.state === "working"
    && sessionBoundaryNeedsVisibleEnding(timeline, workingBoundary);
}

/** EYES owns its lifecycle while the parent provider is waiting for its result. */
function hasRunningEyesInspection(session: { readonly state: string }, timeline: readonly SessionPresentationItem[]): boolean {
  if (session.state !== "working" && session.state !== "idle") return false;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]!;
    if (item.kind === "user" || item.kind === "error" || item.state === "failed" || item.notice === "eyes_failure"
      || item.kind === "assistant" && item.phase === "final_answer"
      || (item.kind === "assistant" || item.title === "System") && compactionBoundaryText.test(`${item.title ?? ""} ${item.body ?? ""}`)) return false;
    if (item.kind === "tool" && item.notice === "eyes_inspection" && item.state === "running") return true;
  }
  return false;
}

/** Hold follow-up instructions in the queue while a turn is still live. */
export function sessionHoldsFollowUpQueue(
  session: { readonly state: string },
  timeline: readonly SessionPresentationItem[] = [],
  workingBoundary?: SessionWorkingBoundary,
): boolean {
  // Approval and input are explicit provider-owned blockers, not a generic
  // working scalar. They can be the first evidence of a new turn after a
  // restart, before its user echo or running row reaches history, so the prior
  // turn's final answer must never hide them.
  if (session.state === "needs_approval" || session.state === "needs_input") return true;
  if (hasRunningEyesInspection(session, timeline)) return true;
  // A working event is newer than the ending that was visible when it arrived.
  // Paint that next turn immediately instead of waiting for its first transcript
  // row; a newly visible final/error changes the identity and closes the override.
  if (hasFreshProviderWorkingState(session, timeline, workingBoundary)) return true;
  // A completed final answer is terminal evidence for the current turn only
  // when no newer row shows that work continued. Some providers leave the
  // session or an earlier reasoning row marked working for a short time after
  // the answer lands; neither stale note can make Stop a truthful action or
  // hold the next instruction in a queue.
  if (latestTurnHasCompletedFinal(timeline)) return false;
  if (session.state === "working") return true;
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
  timeline: readonly SessionPresentationItem[] = [],
  workingBoundary?: SessionWorkingBoundary,
): boolean {
  // A newly restored attention request may precede every transcript row for
  // its turn. Keep following history even when the currently painted ending is
  // the previous turn's final answer.
  if (session.state === "needs_approval" || session.state === "needs_input") return true;
  if (hasRunningEyesInspection(session, timeline)) return true;
  // A newer provider-owned turn may start before its user echo or first output
  // reaches persisted history. The previous turn's final must not stop the
  // selected transcript from following that new work. Keep this boundary after
  // task-complete as well: transport completion retires Stop/queue immediately,
  // but only the newer visible final/interruption/error completes transcript
  // delivery. Offline/disconnected cannot heal history, so they remain terminal.
  if (sessionBoundaryNeedsVisibleEnding(timeline, workingBoundary)
    && session.state !== "offline" && session.state !== "disconnected") return true;
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
  if (session.state === "working") return true;
  // A terminal state and transcript completeness are separate facts. If the
  // newest persisted user turn has no final/error terminal item yet, keep the
  // selected history healing quietly until the provider supplies one.
  return latestUser >= 0 && (session.state === "idle" || session.state === "completed");
}

/**
 * Live presentation is the task-control fact, not the transcript-recovery fact.
 * A provider may finish before its final answer reaches persisted history. That
 * missing answer must keep healing, but an old Reasoning row must not keep a
 * spinner/shimmer and make the completed task look stuck while it catches up.
 */
export function sessionPresentsLiveTurn(
  session: { readonly state: string },
  timeline: readonly SessionPresentationItem[] = [],
  workingBoundary?: SessionWorkingBoundary,
): boolean {
  return sessionHoldsFollowUpQueue(session, timeline, workingBoundary);
}

/** A terminal task flag without a visible ending must force canonical history. */
export function terminalSessionNeedsCanonicalHistory(
  session: { readonly state: string },
  timeline: readonly SessionPresentationItem[] = [],
  workingBoundary?: SessionWorkingBoundary,
): boolean {
  return (session.state === "idle" || session.state === "completed")
    && sessionNeedsTranscriptCatchUp(session, timeline, workingBoundary);
}

/** Only the latest explicitly completed final, with no newer continuation, closes a persisted turn. */
export function latestTurnHasCompletedFinal(
  timeline: readonly SessionPresentationItem[],
): boolean {
  let latestUser = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "user") { latestUser = index; break; }
  }
  let completedFinal = -1;
  let continuation = -1;
  for (let index = latestUser + 1; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item?.kind === "assistant" && item.phase === "final_answer" && item.state !== "running"
      && !compactionBoundaryText.test(`${item.title ?? ""} ${item.body ?? ""}`.trim())) completedFinal = index;
    else if (item && isTurnContinuationAfterFinal(item)) continuation = index;
  }
  return completedFinal > continuation;
}

/**
 * The provider's task state describes transport availability; the status the
 * reader sees describes the latest visible turn. An idle listing may follow a
 * successful OpenCode turn, while a task-complete event may arrive before its
 * final answer is present in history, so neither scalar can stand in for the
 * painted outcome.
 */
export function presentedSessionState(
  session: { readonly state: SessionState },
  timeline: readonly SessionPresentationItem[],
  workingBoundary?: SessionWorkingBoundary,
): SessionState {
  // Unlike an unqualified `working` scalar, an unresolved approval/input state
  // is concrete provider evidence. It must remain visible even when history
  // still ends at the previous turn's final answer after startup/reconnect.
  if (session.state === "needs_approval" || session.state === "needs_input") return session.state;
  const boundaryNeedsVisibleEnding = sessionBoundaryNeedsVisibleEnding(timeline, workingBoundary);
  let latestUser = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "user") { latestUser = index; break; }
  }

  let finalIndex = -1;
  let errorIndex = -1;
  let continuationIndex = -1;
  for (let index = latestUser + 1; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item?.kind === "assistant" && item.phase === "final_answer" && item.state !== "running"
      && !compactionBoundaryText.test(`${item.title ?? ""} ${item.body ?? ""}`.trim())) finalIndex = index;
    if (item?.kind === "error") errorIndex = index;
    if (item && isTurnContinuationAfterFinal(item)) continuationIndex = index;
  }

  // A provider can begin the next turn before its user echo reaches history.
  // A newer running row is stronger evidence than the previous turn's final;
  // an old standalone `working` scalar remains too weak to revive that final.
  if (hasFreshProviderWorkingState(session, timeline, workingBoundary)
    || session.state === "working" && continuationIndex > Math.max(finalIndex, errorIndex)) return "working";
  // While a newer turn is still waiting for its visible ending, the ending at
  // the boundary belongs to the preceding turn. A task-complete transport flag
  // therefore retires live controls but must not label that old final as the
  // outcome of the newer turn.
  if (!boundaryNeedsVisibleEnding && finalIndex > errorIndex) return "completed";
  if (!boundaryNeedsVisibleEnding && errorIndex >= 0) return session.state === "failed" ? "failed" : "idle";
  // `completed` without a visible final is only task-complete transport
  // evidence. Transcript catch-up keeps running, but the UI must not claim the
  // reply is complete until the reader can actually see it.
  return session.state === "completed" ? "idle" : session.state;
}

export type ComposerMessageRequestType = "session.send_message" | "session.steer_message" | "message_queue.enqueue";

export function composerMessageRequestType(input: {
  readonly liveGuidance: boolean;
  readonly hasAttachments: boolean;
  readonly blockedByAttention: boolean;
  readonly queueingEnabled: boolean;
  readonly externalWriter: boolean;
}): ComposerMessageRequestType {
  // External ownership matters only while another Codex client is actively
  // writing the turn. Once the task is idle, Tethoq's App Server can resume it
  // directly; forcing every idle follow-up through the Desktop queue made Send
  // silently depend on that task being open in Codex Desktop.
  if (input.externalWriter && input.blockedByAttention) return "message_queue.enqueue";
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

/**
 * Resolve what the provider says an existing task is actually running.
 *
 * A concrete reported id remains authoritative even before its catalogue row
 * arrives. Falling through to the user's default in that gap paints a perfectly
 * valid but entirely different model. Provider-reported effort receives the
 * same treatment; a later catalogue may normalize its spelling, never replace
 * it merely because the initial list was partial.
 */
export function resolveReportedSessionSelection(
  models: readonly { readonly id: string; readonly name: string; readonly isDefault?: boolean; readonly efforts: readonly string[]; readonly defaultEffort?: string }[],
  current: { readonly modelId?: string; readonly reasoningEffort?: string },
  preferred?: { readonly modelId: string; readonly reasoningEffort?: string },
): ConcreteModelSelection | null {
  const reportedModelId = current.modelId?.trim();
  if (isAmbiguousSelectionValue(reportedModelId)) {
    return resolveConcreteModelSelection(models, current, preferred);
  }
  const reportedModel = models.find((model) => model.id === reportedModelId || model.name === reportedModelId);
  const modelId = reportedModel?.id ?? reportedModelId!;
  const reportedEffort = isAmbiguousSelectionValue(current.reasoningEffort) ? undefined : current.reasoningEffort!.trim();
  if (reportedEffort !== undefined) {
    const normalizedEffort = reportedModel === undefined
      ? undefined
      : matchReasoningEffort(reportedEffort, reportedModel.efforts.filter((effort) => !isAmbiguousSelectionValue(effort)));
    return { modelId, reasoningEffort: normalizedEffort ?? reportedEffort };
  }
  if (reportedModel === undefined) return { modelId };
  return resolveConcreteModelSelection(models, { modelId }) ?? { modelId };
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
    // The attachment is already base64. Decoding the whole file and rebuilding
    // every chunk briefly multiplied a large paste in renderer memory and froze
    // the composer again when Send was pressed. Align byte boundaries to three
    // and slice the existing encoding directly instead.
    const alignedChunkBytes = Math.max(3, chunkBytes - (chunkBytes % 3));
    for (let offset = 0; offset < item.byteLength; offset += alignedChunkBytes) {
      const byteLength = Math.min(alignedChunkBytes, item.byteLength - offset);
      const base64Offset = (offset / 3) * 4;
      const base64Length = Math.ceil(byteLength / 3) * 4;
      await request("attachment.upload.chunk", {
        uploadId,
        offset,
        dataBase64: item.dataBase64.slice(base64Offset, base64Offset + base64Length),
      });
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

export type TerminalStateEventAction = "apply" | "ignore";

/**
 * A terminal report that is immediately followed by newer live work is stale.
 * Otherwise it retires task controls immediately. Transcript catch-up is a
 * separate decision and may keep reading until the final/error is visible.
 */
export function terminalStateEventAction(
  _state: "idle" | "completed",
  _streamQuiet: boolean,
  hasLaterLiveEvent: boolean,
  authoritative = false,
): TerminalStateEventAction {
  if (!authoritative && hasLaterLiveEvent) return "ignore";
  return "apply";
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

export function growTextarea(textarea: HTMLTextAreaElement | HTMLDivElement, maxHeight = 184): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

interface AttachmentEncodingResult {
  readonly id: number;
  readonly dataBase64?: string;
  readonly error?: string;
}

let attachmentEncodingWorker: Worker | null = null;
let attachmentEncodingJobId = 0;
const attachmentEncodingJobs = new Map<number, {
  readonly resolve: (value: string) => void;
  readonly reject: (reason: Error) => void;
}>();

function failAttachmentEncodingWorker(error: Error): void {
  const jobs = [...attachmentEncodingJobs.values()];
  attachmentEncodingJobs.clear();
  attachmentEncodingWorker?.terminate();
  attachmentEncodingWorker = null;
  for (const job of jobs) job.reject(error);
}

function encodingWorker(): Worker {
  if (attachmentEncodingWorker !== null) return attachmentEncodingWorker;
  const worker = new AttachmentEncodingWorker({ name: "tethoq-attachment-encoding" });
  worker.addEventListener("message", (event: MessageEvent<AttachmentEncodingResult>) => {
    const job = attachmentEncodingJobs.get(event.data.id);
    if (job === undefined) return;
    attachmentEncodingJobs.delete(event.data.id);
    if (typeof event.data.dataBase64 === "string") job.resolve(event.data.dataBase64);
    else job.reject(new Error(event.data.error || "Attachment encoding failed"));
  });
  worker.addEventListener("error", () => failAttachmentEncodingWorker(new Error("Attachment encoding worker failed")));
  attachmentEncodingWorker = worker;
  return worker;
}

/**
 * Pay the worker-start cost after the Composer's first paint, rather than in
 * the same interaction that accepts a pasted image. The renderer owns this
 * worker for its lifetime; repeatedly stopping and rebuilding it made the
 * first paste after every short idle period hitch again.
 */
export function prewarmAttachmentEncodingWorker(): void {
  if (typeof Worker === "undefined") return;
  try {
    encodingWorker();
  } catch {
    // A real preparation will retry and report the concrete worker failure on
    // the attachment. Prewarming itself should never disrupt the composer.
  }
}

function encodeBlobInWorker(blob: Blob): Promise<string> {
  if (typeof Worker === "undefined") return Promise.reject(new Error("Attachment encoding worker is unavailable"));
  const id = ++attachmentEncodingJobId;
  return new Promise<string>((resolve, reject) => {
    attachmentEncodingJobs.set(id, { resolve, reject });
    try {
      encodingWorker().postMessage({ id, blob });
    } catch (error) {
      attachmentEncodingJobs.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function blobToUploadable(blob: Blob, name = "tethoq-dictation.webm"): Promise<UploadableAttachment> {
  // Electron always supplies Worker. If the worker cannot start, fail this
  // attachment instead of silently moving a multi-megabyte encode onto the UI
  // thread and making the message field unusable again.
  const dataBase64 = await encodeBlobInWorker(blob);
  return {
    name,
    mimeType: blob.type.split(";")[0] || "audio/webm",
    byteLength: blob.size,
    dataBase64,
  };
}
