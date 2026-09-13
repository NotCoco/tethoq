import { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ComposerMessageInput, type ComposerTextInput } from "./ComposerMessageInput";
import { PermissionSettings } from "./PermissionSettings";
import { anchorMeshTargets, meshDraftParts, meshEditorValue, meshMentionAtCaret, meshTargetRoute, moveMeshTargets, readMeshEditorValue } from "./mesh_composer";
import {
  defaultSimplifyMaxWords,
  maximumSimplifyMaxWords,
  normalizeSimplifySettings,
  parseSimplifyCommand,
  type SimplifySettings,
} from "../../../../../packages/protocol/src/simplify";
import type { JsonObject, ProviderWalletStatus } from "../../../../../packages/protocol/src/index";
import type { DesktopPreferencesState, EarsSettings, ScreenCaptureSource, SelectedFile, SelectedImage, VisionProxySelection, VisionProxyStatus, VisionProxyTarget, WorkflowAttachment, WorkflowDescriptor } from "@shared/desktop_api";
import {
  composeEarsDestinationText,
  defaultEarsSettings,
  earsCancelledMessage,
  earsConfigurationError,
  isEarsCancelledError,
  lowestReasoningEffort,
  reasoningLabelForNote,
  routeAcceptsEarsAudio,
  type EarsAudioRoute,
} from "../../../../../packages/protocol/src/ears";
import { matchReasoningEffort, reasoningDisplayLabel, resolveModelReasoningProfile, type ReasoningLabelContext } from "../../../../../packages/protocol/src/reasoning";
import { IconButton, LoadingState, ProviderLogo } from "./components";
import { clearSessionGoal, isDeliveryUnknownError, loadSessionGoal, refreshProviders, setSessionGoal } from "./bridge";
import { ChatTimeline } from "./ChatTimeline";
import { AudioPlaybackChip, AudioTraceCanvas, liveTraceLevels, MicrophoneLevelMonitor, Mp3DictationRecorder, type SelectedAudio } from "./audio_dictation";
import {
  AgentIcon,
  AlertIcon,
  AnnotationIcon,
  ArrowLeftIcon,
  BrowserIcon,
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  EditIcon,
  EyeIcon,
  ExternalLinkIcon,
  FileIcon,
  GoalIcon,
  InfoIcon,
  MoreIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  ScreenshotIcon,
  SendIcon,
  SettingsIcon,
  SlashCommandIcon,
  SlidersIcon,
  StopIcon,
  WorkflowIcon,
  XIcon,
} from "./icons";
import type { DesktopSnapshot, ModelOption, Provider, Session, SessionGoal, SessionGoalStatus, TimelineItem } from "./types";
import {
  appendAttachmentsWithinLimits,
  acknowledgeTransportQueueSuppression,
  appendTranscript,
  blobToUploadable,
  canSendToProvider,
  chooseTranscriptionSource,
  classifyDroppedFile,
  filterAttachmentsForDestination,
  growTextarea,
  dictationAudioConstraints,
  hasSlashCommandToken,
  insertedSlashCommand,
  isDictationAudioAttachment,
  maximumMessageAttachmentBytes,
  maximumMessageAttachments,
  isAmbiguousSelectionValue,
  modelCatalogRoute,
  modelMatchesCatalogQuery,
  modelAcceptsDirectAudio,
  newEarsRequestId,
  prewarmAttachmentEncodingWorker,
  providerAcceptsDirectAudio,
  resolveConcreteModelSelection,
  resolveReportedSessionSelection,
  removeSlashCommandToken,
  resolvedDictationDeviceId,
  resolveComposerModelId,
  sessionHoldsFollowUpQueue,
  composerMessageRequestType,
  composerSubmissionAppearsInTranscript,
  slashCommandSuggestions,
  uploadAttachments,
  visibleTransportQueueMessages,
  type ComposerSlashCommand,
  type ModelCatalogRouteInput,
  type SessionWorkingBoundary,
  type TransportQueueSuppression,
  type TranscriptionSource,
  type UploadableAttachment,
} from "./composer_helpers";
import "./composer.css";
import { serializeResponseAnnotations, type ResponseAnnotation } from "./response_annotations";
import { readQueuedComposerDraft } from "./queued_draft";
import { mergeAcceptedComposerRow, rollbackOptimisticComposerRow } from "./timeline_merge";

type Request = (type: string, payload?: JsonObject, requestId?: string) => Promise<Record<string, unknown>>;

export interface DraftSessionSendInput {
  /** Draft or source task, replaced atomically after creating the destination. */
  draftSessionId: string;
  requestId?: string;
  providerId: Session["providerId"];
  workingDirectory: string;
  content: string;
  modelId: string;
  effort: string;
  /** Attachments have already been uploaded; App owns their one-time consumption. */
  attachmentIds: readonly string[];
  workflowIds: readonly string[];
  /** Complete local presentation retained while the provider creates and echoes the first turn. */
  optimisticItem: TimelineItem;
  simplify?: JsonObject;
  goalObjective?: string;
}

export interface QueuedNewTaskPresentation {
  readonly deliveryId: string;
  readonly optimisticItem: TimelineItem;
}

export type ComposerTaskAction = "handoff" | "branch" | "browser" | "side_chat" | "delegate" | "goal" | "permission" | "eyes" | "mesh" | "mesh_send" | "model_switch_send" | "instant";

export interface DraftSessionMaterializeInput {
  /** Draft or source session id that App replaces with the destination task. */
  draftSessionId: string;
  requestId?: string;
  providerId: Session["providerId"];
  workingDirectory: string;
  modelId: string;
  effort: string;
}

export interface PendingComposerAction {
  readonly requestId: string;
  readonly sessionId: string;
  readonly action: ComposerTaskAction;
}

export interface DraftSessionScheduleInput {
  /** Local-only session id; App uses this to associate the durable schedule with the draft. */
  draftSessionId: string;
  /** Stable across retries so a lost acknowledgement cannot create a duplicate provider task. */
  requestId: string;
  providerId: Session["providerId"];
  workingDirectory: string;
  /** Exact Composer text captured at submit time, before trim, for retaining edits made while persistence is pending. */
  scheduledComposerContent: string;
  content: string;
  /** Exact explicit Mesh targets captured with this schedule attempt. */
  meshTargets: readonly MeshTarget[];
  modelId: string;
  effort: string;
  runAt: string;
  title: string;
  preview: string;
}

export interface DraftSessionScheduleAttemptState {
  input: DraftSessionScheduleInput;
  inFlight: boolean;
  failure: string | null;
}

export const minimumDraftScheduleLeadMs = 60_000;

export function draftScheduleLocalValue(value: Date): string {
  const part = (number: number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${part(value.getMonth() + 1)}-${part(value.getDate())}T${part(value.getHours())}:${part(value.getMinutes())}`;
}

export function defaultDraftScheduleLocalValue(now = new Date()): string {
  const earliest = now.getTime() + 5 * 60_000;
  const value = new Date(earliest);
  value.setSeconds(0, 0);
  if (value.getTime() < earliest) value.setMinutes(value.getMinutes() + 1);
  return draftScheduleLocalValue(value);
}

export function parseDraftScheduleLocalValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute) return null;
  return date;
}

export function validateDraftScheduleLocalValue(
  value: string,
  now = new Date(),
  minimumLeadMs = minimumDraftScheduleLeadMs,
): { readonly date: Date | null; readonly error: string | null } {
  const date = parseDraftScheduleLocalValue(value);
  if (!date) return { date: null, error: "Choose a valid local date and time." };
  const lead = date.getTime() - now.getTime();
  if (lead <= 0) return { date, error: "Choose a time in the future." };
  if (lead < minimumLeadMs) return { date, error: "Choose a time at least one minute from now." };
  return { date, error: null };
}

export function draftScheduleLocalValueForOpen(value: string, now = new Date()): string {
  return validateDraftScheduleLocalValue(value, now).error === null
    ? value
    : defaultDraftScheduleLocalValue(now);
}

export function formatDraftScheduleLocalTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function draftSchedulePresentation(content: string): { readonly title: string; readonly preview: string } {
  const normalized = content.trim();
  const firstLine = normalized.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "Scheduled task";
  const preview = normalized.length > 180 ? `${normalized.slice(0, 177).trimEnd()}…` : normalized;
  return { title: firstLine.slice(0, 96), preview };
}

/** Clears only the snapshot which was scheduled, retaining text added while the write was in flight. */
export function clearScheduledDraftContent(current: string, scheduled: string): string {
  if (current === scheduled) return "";
  if (!scheduled || !current.startsWith(scheduled)) return current;
  return current.slice(scheduled.length).replace(/^[ \t]*(?:\r?\n)?/u, "");
}

export interface DraftModelSelection {
  providerId: Session["providerId"];
  modelId: string;
  effort: string;
}

/**
 * A local, unsent attachment. The parent keeps these values in per-session refs
 * so switching tasks does not discard the draft or put base64 bytes on the App
 * render path. Never persist the base64 payload to localStorage.
 */
type ReadyComposerAttachment = (SelectedImage | SelectedFile | SelectedAudio) & {
  /** Keep pasted/dropped image paint on its cheap Blob URL until send/removal. */
  readonly previewUrl?: string;
};

interface PreparingComposerAttachment {
  readonly preparing: true;
  readonly attachmentKind: "image" | "file";
  readonly name: string;
  readonly path: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly origin: "drag-drop" | "clipboard";
  readonly previewUrl?: string;
  readonly preparation: () => Promise<UploadableAttachment>;
}

export type ComposerAttachment = ReadyComposerAttachment | PreparingComposerAttachment;

export interface ComposerDraftSnapshot {
  readonly content: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly workflowAttachments: readonly WorkflowAttachment[];
  readonly annotations: readonly ResponseAnnotation[];
}

function mergeDraftItems<T>(
  submitted: readonly T[],
  current: readonly T[],
  identity: (item: T) => string,
): readonly T[] {
  if (!submitted.length) return current;
  if (!current.length) return submitted;
  const submittedIds = new Set(submitted.map(identity));
  return [...submitted, ...current.filter((item) => !submittedIds.has(identity(item)))];
}

/** Restores a failed composition without overwriting work typed while it sent. */
export function mergeFailedComposerDraft(
  submitted: ComposerDraftSnapshot,
  current: ComposerDraftSnapshot,
): ComposerDraftSnapshot {
  const content = !submitted.content
    ? current.content
    : !current.content || current.content === submitted.content
      ? submitted.content
      : `${submitted.content}\n\n${current.content}`;
  return {
    content,
    attachments: mergeDraftItems(submitted.attachments, current.attachments, (item) => item.path),
    workflowAttachments: mergeDraftItems(submitted.workflowAttachments, current.workflowAttachments, (item) => item.id),
    annotations: mergeDraftItems(submitted.annotations, current.annotations, (item) => item.id),
  };
}

function isPreparingAttachment(attachment: ComposerAttachment): attachment is PreparingComposerAttachment {
  return "preparing" in attachment && attachment.preparing === true;
}

export function isSelectedAudio(attachment: ComposerAttachment): attachment is SelectedAudio {
  return !isPreparingAttachment(attachment)
    && !("kind" in attachment && attachment.kind === "file")
    && attachment.mimeType.toLowerCase().startsWith("audio/");
}

export interface SideChatDraft {
  readonly content: string;
  readonly attachments: readonly SelectedImage[];
}

/** Restores a failed side-chat send without overwriting work added meanwhile. */
export function mergeFailedSideChatDraft(
  submitted: SideChatDraft,
  current: SideChatDraft,
): SideChatDraft {
  const content = !submitted.content
    ? current.content
    : !current.content || current.content === submitted.content
      ? submitted.content
      : `${submitted.content}\n\n${current.content}`;
  return {
    content,
    attachments: mergeDraftItems(submitted.attachments, current.attachments, (item) => item.path),
  };
}

export interface ComposerProps {
  snapshot: DesktopSnapshot;
  session: Session;
  workingBoundary?: SessionWorkingBoundary | undefined;
  /** Suppresses stale same-turn live affordances after the user presses Stop. */
  stopPresentationActive?: boolean;
  request: Request;
  selectImages: () => Promise<readonly SelectedImage[]>;
  preview: boolean;
  notify: (message: string, tone?: "normal" | "error") => void;
  updateSnapshot: (value: DesktopSnapshot | ((current: DesktopSnapshot | null) => DesktopSnapshot | null) | null) => void;
  onHydrateProviderModels: (providerId: Session["providerId"]) => Promise<void>;
  /** Samples the transcript before clearing the submitted composition. */
  onBeforeSubmit?: () => void;
  onBrowser: () => void;
  onManageWorkflow: (id?: string) => void;
  initialDraft: string;
  onDraftChange: (value: string) => void;
  initialAttachments?: readonly ComposerAttachment[];
  onAttachmentsChange?: (value: readonly ComposerAttachment[]) => void;
  /** Per-task workflow draft state, parallel to ordinary attachment drafts. */
  initialWorkflowAttachments?: readonly WorkflowAttachment[];
  onWorkflowAttachmentsChange?: (value: readonly WorkflowAttachment[]) => void;
  initialAnnotations?: readonly ResponseAnnotation[];
  onAnnotationsChange?: (value: readonly ResponseAnnotation[]) => void;
  initialMode?: "queue" | "steer" | "goal";
  onModeChange?: (value: "queue" | "steer" | "goal") => void;
  initialMeshTargets?: readonly MeshTarget[];
  onMeshTargetsChange?: (value: readonly MeshTarget[]) => void;
  initialDelegationDraft?: DelegationDraft | undefined;
  onDelegationDraftChange?: (value: DelegationDraft | null) => void;
  /** Changes only when App atomically restores a failed in-flight composition. */
  draftRestoreRevision?: number;
  onRestoreFailedSubmission?: (submitted: ComposerDraftSnapshot) => ComposerDraftSnapshot;
  onDerivedSession: (value: Record<string, unknown>, summary?: string, draft?: string, queuedNewTask?: QueuedNewTaskPresentation) => void;
  /** Mirrors local selection into Session.draft so surrounding UI stays accurate. */
  onDraftSelectionChange?: (selection: DraftModelSelection) => void;
  /** Must perform the sole create/send path and replace the local draft atomically. */
  onCreateDraftSend?: (input: DraftSessionSendInput) => Promise<void>;
  /** Materializes a local draft before opening a task-backed Tethoq action. */
  onMaterializeDraft?: (input: DraftSessionMaterializeInput, action: ComposerTaskAction) => Promise<void>;
  /** One-shot action retained across the draft-id-to-provider-id remount. */
  pendingAction?: PendingComposerAction | null;
  onPendingActionConsumed?: (requestId: string) => void;
  /** Persists a text-only local draft for later provider creation and dispatch. */
  onCreateDraftSchedule?: (input: DraftSessionScheduleInput) => Promise<void>;
  /** App-owned attempt state survives this keyed Composer being remounted. */
  draftScheduleAttempt?: DraftSessionScheduleAttemptState | null;
  /** Publishes a fresh attempt synchronously and returns the canonical retained attempt. */
  onRetainDraftScheduleAttempt?: (input: DraftSessionScheduleInput) => DraftSessionScheduleInput;
  /** Instant sessions are experimental; the entry point is only rendered when true. */
  experimental?: boolean;
  onInstantSession?: () => void;
  /** Creates a hidden context-sharing side chat and opens its compact panel. */
  onCreateSideChat?: (parentSessionId: string, prompt?: string, queuedMessageId?: string) => Promise<void>;
  /** Prepares a handoff pickup prompt in a side chat with the same model; the main chat stays untouched. */
  onContextHandoff?: (parentSessionId: string, customNote: string) => Promise<void>;
  /** Incremented only when a queue event arrives; avoids polling the queue. */
  queueRevision?: number;
  /** Per-task preference owned by App so Composer remounts do not reset it. */
  queueingEnabled: boolean;
  onQueueingEnabledChange: (enabled: boolean) => void;
  /** Persisted concrete defaults keyed only by provider ID. */
  agentDefaults?: DesktopPreferencesState["agentDefaults"];
  ears?: EarsSettings;
  onEarsChange?: (value: EarsSettings) => Promise<void> | void;
  goal?: SessionGoal | null;
  goalClearRevision?: number;
  onGoal?: (goal: SessionGoal | null, clearRevision?: number, expectedRevision?: number) => void;
  /** Latest provider-backed EYES status received by the app event stream. */
  visionStatus?: VisionProxyStatus | undefined;
  /** Synchronous provider-backed EYES status, used to reject stale RPC replies before React rerenders. */
  readVisionStatus?: ((sessionId: string) => VisionProxyStatus | undefined) | undefined;
  /** Stops the active task while the composer is empty; typing restores send. */
  onInterrupt?: () => Promise<void>;
}

interface PopoverProps {
  label: string;
  className: string;
  children: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  trigger: React.ReactNode;
}

function Popover({ label, className, children, open, onOpen, trigger }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef(open);
  const id = useId();
  useLayoutEffect(() => {
    if (previousOpen.current && !open) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== triggerRef.current && ref.current?.contains(active)) {
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    }
    previousOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { onOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); } };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [onOpen, open]);
  return <div className={`composer-popover-root ${className}`} ref={ref}>
    <button ref={triggerRef} type="button" aria-label={label} title={label} aria-expanded={open} aria-controls={id} aria-haspopup="menu" onClick={() => { if (open) requestAnimationFrame(() => triggerRef.current?.focus()); onOpen(!open); }}>{trigger}</button>
    {open ? <div id={id} className="composer-popover" role="menu" aria-label={label}>{children}</div> : null}
  </div>;
}

const simplifySettingsKey = "tethoq:simplify-settings:v1";

export function storedSimplifySettings(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): SimplifySettings {
  try {
    const value = storage?.getItem(simplifySettingsKey);
    return normalizeSimplifySettings(value ? JSON.parse(value) : undefined);
  } catch {
    return { maxWords: defaultSimplifyMaxWords };
  }
}

export function simplifySubmission(content: string, settings: SimplifySettings): {
  readonly content: string;
  readonly simplify?: JsonObject;
} {
  const parsed = parseSimplifyCommand(content);
  const normalized = normalizeSimplifySettings(settings);
  return parsed.active
    ? { content: parsed.content, simplify: { maxWords: normalized.maxWords, ...(normalized.guidance !== undefined ? { guidance: normalized.guidance } : {}), target: parsed.target } }
    : { content: parsed.content };
}

function SimplifyIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" /></svg>;
}

function ChoiceMenu({ value, label, options, onChange, className = "", triggerDescription, placeholder }: {
  value: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string; description?: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  className?: string;
  triggerDescription?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? (placeholder ? { label: placeholder } : options[0]);
  if (!selected) return null;
  return <div className={`composer-choice composer-setting ${className}`}>
    {triggerDescription ? <span className="composer-setting-label">{triggerDescription}</span> : null}
    <Popover label={label} className="composer-setting-control" open={open} onOpen={setOpen} trigger={<span className="composer-setting-value choice-setting-value"><strong>{selected.label}</strong><ChevronDownIcon /></span>}>
      {options.map((option) => <button type="button" role="menuitemradio" aria-checked={option.value === value} key={option.value} disabled={option.disabled} onClick={() => { onChange(option.value); setOpen(false); }}><span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>{option.value === value ? <CheckIcon /> : null}</button>)}
    </Popover>
  </div>;
}

export function reasoningLabel(value: string, context: ReasoningLabelContext = {}): string {
  return reasoningDisplayLabel(value, context);
}

export function compactComposerModelLabel(value: string, providerId: string): string {
  if (providerId !== "codex") return value;
  const match = value.trim().match(/^GPT[- ]?(\d+(?:\.\d+)*)(?:[- ]+(.+))?$/iu);
  if (!match) return value;
  const suffix = match[2]?.replaceAll("-", " ").replace(/\s+/gu, " ").trim();
  return suffix ? `${match[1]} ${suffix}` : match[1]!;
}

interface CatalogModel {
  readonly key: string;
  readonly provider: Provider;
  readonly model: ModelOption;
}

const RECENT_USED_MODELS_KEY = "tethoq:recent-used-models:v1";
const RECENT_MODEL_VISIBLE_LIMIT = 5;
const RECENT_MODEL_HISTORY_LIMIT = 20;

export interface RecentModelUse {
  readonly key: string;
  readonly usedAt: number;
}

interface RecentProviderModelIndex {
  readonly byId: ReadonlyMap<string, string>;
  readonly uniqueByName: ReadonlyMap<string, string | null>;
}

function recentProviderModelIndex(modelsByProvider: DesktopSnapshot["models"]): ReadonlyMap<string, RecentProviderModelIndex> {
  return new Map(Object.entries(modelsByProvider).map(([providerId, models]) => {
    const byId = new Map<string, string>();
    const uniqueByName = new Map<string, string | null>();
    for (const model of models) {
      byId.set(model.id.trim().toLocaleLowerCase(), model.id);
      const name = model.name.trim().toLocaleLowerCase();
      uniqueByName.set(name, uniqueByName.has(name) ? null : model.id);
    }
    return [providerId, { byId, uniqueByName }];
  }));
}

function concreteSessionModelKey(session: Session, catalogue: ReadonlyMap<string, RecentProviderModelIndex>): string | undefined {
  if (session.draft === true || session.provisional === true || session.sessionKind === "internal" || isAmbiguousSelectionValue(session.model)) return undefined;
  const reportedModel = session.model.trim().toLocaleLowerCase();
  const providerModels = catalogue.get(session.providerId);
  const modelId = providerModels?.byId.get(reportedModel) ?? providerModels?.uniqueByName.get(reportedModel) ?? undefined;
  return modelId ? `${session.providerId}:${modelId}` : undefined;
}

export function recentModelUsesFromSessions(
  sessions: readonly Session[],
  modelsByProvider: DesktopSnapshot["models"],
): readonly RecentModelUse[] {
  const catalogue = recentProviderModelIndex(modelsByProvider);
  const newestUseByKey = new Map<string, number>();
  for (const session of sessions) {
    const key = concreteSessionModelKey(session, catalogue);
    const usedAt = Date.parse(session.updatedAt);
    if (!key || !Number.isFinite(usedAt)) continue;
    newestUseByKey.set(key, Math.max(newestUseByKey.get(key) ?? Number.NEGATIVE_INFINITY, usedAt));
  }
  return [...newestUseByKey.entries()]
    .map(([key, usedAt]) => ({ key, usedAt }))
    .sort((left, right) => right.usedAt - left.usedAt);
}

export function mergeRecentModelUses(
  stored: readonly RecentModelUse[],
  observed: readonly RecentModelUse[],
  limit = RECENT_MODEL_HISTORY_LIMIT,
): readonly RecentModelUse[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const newestUseByKey = new Map<string, number>();
  for (const item of [...stored, ...observed]) {
    if (typeof item.key !== "string" || !item.key.includes(":") || !Number.isFinite(item.usedAt)) continue;
    newestUseByKey.set(item.key, Math.max(newestUseByKey.get(item.key) ?? Number.NEGATIVE_INFINITY, item.usedAt));
  }
  return [...newestUseByKey.entries()]
    .map(([key, usedAt]) => ({ key, usedAt }))
    .sort((left, right) => right.usedAt - left.usedAt)
    .slice(0, limit);
}

function storedRecentModelUses(): readonly RecentModelUse[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_USED_MODELS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const candidate = item as Record<string, unknown>;
      return typeof candidate.key === "string" && typeof candidate.usedAt === "number" && Number.isFinite(candidate.usedAt)
        ? [{ key: candidate.key, usedAt: candidate.usedAt }]
        : [];
    });
  } catch {
    return [];
  }
}

/** Persist only provider-backed session activity. Picker clicks never call this. */
export function persistRecentModelUsesFromSessions(
  sessions: readonly Session[],
  modelsByProvider: DesktopSnapshot["models"],
): void {
  try {
    const next = mergeRecentModelUses(storedRecentModelUses(), recentModelUsesFromSessions(sessions, modelsByProvider));
    const serialized = JSON.stringify(next);
    if (localStorage.getItem(RECENT_USED_MODELS_KEY) !== serialized) localStorage.setItem(RECENT_USED_MODELS_KEY, serialized);
  } catch {
    // Recent models are convenience state; restricted previews may not persist it.
  }
}

export function recentModelKeysFromUsage(
  sessions: readonly Session[],
  modelsByProvider: DesktopSnapshot["models"],
  stored: readonly RecentModelUse[],
  limit = RECENT_MODEL_VISIBLE_LIMIT,
): readonly string[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const available = new Set(Object.entries(modelsByProvider).flatMap(([providerId, models]) => models.map((model) => `${providerId}:${model.id}`)));
  return mergeRecentModelUses(stored, recentModelUsesFromSessions(sessions, modelsByProvider))
    .filter((item) => available.has(item.key))
    .slice(0, limit)
    .map((item) => item.key);
}

/**
 * "Recent" is provider truth, not picker history. A model only belongs here
 * after a real task reports that it used it; browsing or changing an unsent
 * draft must never reorder the list.
 */
export function recentModelKeysFromSessions(
  sessions: readonly Session[],
  modelsByProvider: DesktopSnapshot["models"],
  limit = 5,
): readonly string[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  return recentModelUsesFromSessions(sessions, modelsByProvider).slice(0, limit).map((item) => item.key);
}

function ModelCatalogResults({ entries, recentKeys, query, activeProviderId, selectedKey, allowProviderChange, currentTaskProviderId, onChoose }: {
  entries: readonly CatalogModel[];
  recentKeys: readonly string[];
  query: string;
  activeProviderId: string;
  selectedKey: string | undefined;
  allowProviderChange: boolean;
  currentTaskProviderId?: string | undefined;
  onChoose: (entry: CatalogModel) => void;
}) {
  const visible = entries.filter((entry) => modelMatchesCatalogQuery(query, entry.provider.id, entry.provider.name, entry.model));
  const recents = query.trim() ? [] : recentKeys.map((key) => entries.find((entry) => entry.key === key)).filter((entry): entry is CatalogModel => entry !== undefined);
  const groups = visible.reduce<Array<{ provider: Provider; route: ReturnType<typeof modelCatalogRoute>; models: CatalogModel[] }>>((current, entry) => {
    const route = modelCatalogRoute(entry.provider.id, entry.provider.name, entry.model);
    const found = current.find((group) => group.provider.id === entry.provider.id && group.route.key === route.key);
    if (found) found.models.push(entry);
    else current.push({ provider: entry.provider, route, models: [entry] });
    return current;
  }, []).sort((left, right) => {
    if (left.provider.id !== right.provider.id) return left.provider.id === activeProviderId ? -1 : right.provider.id === activeProviderId ? 1 : left.provider.name.localeCompare(right.provider.name);
    return left.route.label.localeCompare(right.route.label);
  });
  const button = (entry: CatalogModel, recent = false) => {
    const providerReady = entry.provider.state === "online" && entry.provider.capabilities.includes("Create Session") && entry.provider.capabilities.includes("Send Message");
    const selectable = entry.provider.id === currentTaskProviderId || (allowProviderChange ? providerReady : entry.provider.id === activeProviderId);
    const selected = entry.key === selectedKey;
    const canonicalSelected = selected && !recent;
    const needsApiKey = entry.model.walletKind === "user_api" && entry.model.apiKeyConfigured === false;
    const caution = entry.model.caution ?? `API key required for ${entry.model.endpointName ?? "this endpoint"}`;
    const route = modelCatalogRoute(entry.provider.id, entry.provider.name, entry.model);
    const providerName = route.label;
    const routeLabel = recent && entry.provider.id === "opencode" ? route.carriedBy ? `${route.label} via ${route.carriedBy}` : route.label : undefined;
    const unavailableTitle = allowProviderChange ? `${entry.provider.name} is not ready` : `Start or hand off to ${entry.provider.name} to use this model`;
    return <button type="button" className={[needsApiKey ? "needs-api-key" : "", canonicalSelected ? "selected" : ""].filter(Boolean).join(" ") || undefined} aria-current={canonicalSelected ? "true" : undefined} key={`${recent ? "recent:" : ""}${entry.key}`} disabled={!selectable} title={selectable ? needsApiKey ? caution : `${entry.model.name} · ${providerName}` : unavailableTitle} onClick={() => onChoose(entry)}>
      <ProviderLogo providerId={entry.provider.id} provider={entry.provider} size={18}/>
      <span><strong>{entry.model.name}</strong>{needsApiKey ? <small className="model-api-caution">{caution}</small> : routeLabel ? <small className="model-route-label">{routeLabel}</small> : null}</span>
      <span className="model-row-meta">{recent ? <time>Recent</time> : !selectable && !allowProviderChange ? <small>New task</small> : null}{canonicalSelected ? <CheckIcon /> : null}</span>
    </button>;
  };
  return <div className="model-catalog-results">
    {recents.length ? <section><h4>Recent</h4>{recents.map((entry) => button(entry, true))}</section> : null}
    {groups.map((group) => <section key={`${group.provider.id}:${group.route.key}`} data-provider-group={group.provider.id} data-route-group={group.route.key}><h4><ProviderLogo providerId={group.provider.id} provider={group.provider} size={18}/><span>{group.route.label}{group.route.carriedBy ? <small> via {group.route.carriedBy}</small> : null}</span></h4>{group.models.map((entry) => button(entry))}</section>)}
    {!groups.length ? <div className="model-catalog-empty"><SearchIcon /><strong>No matching models</strong><small>Try a model, provider, or endpoint name.</small></div> : null}
  </div>;
}

function usableQueueTaskEntries(snapshot: DesktopSnapshot): readonly CatalogModel[] {
  return snapshot.providers.flatMap((provider) => {
    const ready = provider.state === "online"
      && provider.capabilities.includes("Create Session")
      && provider.capabilities.includes("Send Message");
    if (!ready) return [];
    return (snapshot.models[provider.id] ?? [])
      .filter((model) => model.walletKind !== "user_api" || model.apiKeyConfigured !== false)
      .map((model) => ({ key: `${provider.id}:${model.id}`, provider, model }));
  });
}

export function mostRecentReasoningForModel(
  sessions: readonly Session[],
  providerId: string,
  model: ModelOption,
): string | undefined {
  const supported = new Set(model.efforts.filter((effort) => !isAmbiguousSelectionValue(effort)));
  if (supported.size === 0) return undefined;
  return [...sessions]
    .filter((session) => session.providerId === providerId && (session.model === model.id || session.model === model.name))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((session) => session.effort)
    .find((effort) => !isAmbiguousSelectionValue(effort) && supported.has(effort));
}

function queuedTaskModelSelection(
  snapshot: DesktopSnapshot,
  providerId: string,
  modelId: string | undefined,
  agentDefaults: DesktopPreferencesState["agentDefaults"],
): DraftModelSelection | null {
  const models = snapshot.models[providerId] ?? [];
  const requested = models.find((model) => model.id === modelId || model.name === modelId)
    ?? models.find((model) => model.id === agentDefaults[providerId]?.modelId)
    ?? models.find((model) => model.isDefault)
    ?? models[0];
  if (!requested) return null;
  const recentEffort = mostRecentReasoningForModel(snapshot.sessions, providerId, requested);
  const resolved = resolveConcreteModelSelection(
    models,
    { modelId: requested.id, ...(recentEffort !== undefined ? { reasoningEffort: recentEffort } : {}) },
    agentDefaults[providerId],
  );
  return resolved === null ? null : {
    providerId,
    modelId: resolved.modelId,
    effort: resolved.reasoningEffort ?? "",
  };
}

function ModelPicker({ snapshot, providerId, sessionModel, value, allowProviderChange = false, currentTaskProviderId, onChange }: {
  snapshot: DesktopSnapshot;
  providerId: Session["providerId"];
  sessionModel: string;
  value: string;
  allowProviderChange?: boolean;
  currentTaskProviderId?: string | undefined;
  onChange: (providerId: Session["providerId"], modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const modelScroll = useRef<HTMLDivElement>(null);
  const modelLibrary = useRef<HTMLElement>(null);
  const [modelScrollHeight, setModelScrollHeight] = useState<number | null>(null);
  const dropupId = useId();
  const libraryId = useId();
  const entries = useMemo(() => snapshot.providers.flatMap((provider) => (snapshot.models[provider.id] ?? []).map((model) => ({ key: `${provider.id}:${model.id}`, provider, model }))), [snapshot.models, snapshot.providers]);
  const recentKeys = useMemo(() => recentModelKeysFromUsage(snapshot.sessions, snapshot.models, storedRecentModelUses()), [snapshot.models, snapshot.sessions]);
  const providerEntries = entries.filter((entry) => entry.provider.id === providerId);
  const defaultEntry = providerEntries.find((entry) => entry.model.isDefault) ?? providerEntries[0];
  // A concrete provider-reported id can arrive before its catalogue row. Do not
  // visually replace that truth with a valid-but-different default model.
  const selected = value === "default" ? defaultEntry : providerEntries.find((entry) => entry.model.id === value);
  const selectedNeedsApiKey = selected?.model.walletKind === "user_api" && selected.model.apiKeyConfigured === false;
  const pendingModel = value !== "default" && !isAmbiguousSelectionValue(value) ? value : "";
  const fallbackModel = sessionModel && sessionModel.toLowerCase() !== "cli default" ? sessionModel : "";
  const label = selected?.model.name ?? (pendingModel || fallbackModel || "Current model");
  const displayLabel = compactComposerModelLabel(label, selected?.provider.id ?? providerId);
  const selectedProvider = selected?.provider ?? snapshot.providers.find((provider) => provider.id === providerId);
  const closePicker = (restoreFocus = true) => {
    setOpen(false);
    setExpanded(false);
    if (restoreFocus) requestAnimationFrame(() => modelTrigger.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) closePicker(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closePicker(); };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closePicker(); };
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = [...(modelLibrary.current?.querySelectorAll<HTMLElement>("a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])" ) ?? [])];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("keydown", trap);
    requestAnimationFrame(() => modelLibrary.current?.querySelector<HTMLElement>("input, button:not([disabled])")?.focus());
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("keydown", trap); };
  }, [expanded]);
  useLayoutEffect(() => {
    if (!open) {
      setModelScrollHeight(null);
      return;
    }
    const viewport = modelScroll.current;
    const panel = viewport?.closest<HTMLElement>(".model-picker-dropup");
    const resultsElement = viewport?.querySelector<HTMLElement>(":scope > .model-catalog-results");
    if (!viewport || !panel || !resultsElement) return;
    let frame = 0;
    const measure = () => {
      const panelBounds = panel.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      const viewportStyle = getComputedStyle(viewport);
      const panelMaxHeight = Number.parseFloat(getComputedStyle(panel).maxHeight);
      if (!Number.isFinite(panelMaxHeight)) return;
      const paddingTop = Number.parseFloat(viewportStyle.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(viewportStyle.paddingBottom) || 0;
      const available = Math.max(0, Math.floor(panelMaxHeight - (viewportBounds.top - panelBounds.top) - 1));
      const contentHeight = resultsElement.getBoundingClientRect().height + paddingTop + paddingBottom;
      if (contentHeight <= available + .5) {
        setModelScrollHeight((current) => current === null ? current : null);
        return;
      }
      const completeRows = [...viewport.querySelectorAll<HTMLElement>(":scope > .model-catalog-results > section > button, :scope > .model-catalog-results > .model-catalog-empty")];
      const completeBottom = completeRows.reduce((furthest, row) => {
        const bottom = row.getBoundingClientRect().bottom - viewportBounds.top + viewport.scrollTop;
        return bottom <= available - paddingBottom + .5 ? Math.max(furthest, bottom) : furthest;
      }, 0);
      const next = Math.max(0, Math.min(available, Math.floor((completeBottom || Math.min(contentHeight, available - paddingBottom)) + paddingBottom)));
      setModelScrollHeight((current) => current === next ? current : next);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(panel);
    observer?.observe(resultsElement);
    window.addEventListener("resize", measure);
    frame = requestAnimationFrame(measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [entries, open, query, recentKeys]);
  const choose = (entry: CatalogModel) => {
    const providerReady = entry.provider.state === "online" && entry.provider.capabilities.includes("Create Session") && entry.provider.capabilities.includes("Send Message");
    if (entry.provider.id !== providerId && (!allowProviderChange || !providerReady)) return;
    onChange(entry.provider.id, entry.model.id);
    closePicker();
  };
  const search = <label className="model-catalog-search"><SearchIcon /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models and providers" aria-label="Search models"/><kbd>Esc</kbd></label>;
  const results = <ModelCatalogResults entries={entries} recentKeys={recentKeys} query={query} activeProviderId={providerId} selectedKey={selected?.key} allowProviderChange={allowProviderChange} currentTaskProviderId={currentTaskProviderId} onChoose={choose}/>;
  return <div className="model-picker-root composer-setting" ref={root}>
    <span className="composer-setting-label">Model</span>
    <button ref={modelTrigger} className={`model-picker-trigger ${selectedNeedsApiKey ? "needs-api-key" : ""}`} type="button" aria-label={`Choose model. Current model: ${label}${selectedNeedsApiKey ? ". API key required" : ""}`} aria-haspopup="dialog" aria-expanded={open || expanded} aria-controls={open ? dropupId : expanded ? libraryId : undefined} onClick={() => { if (open || expanded) closePicker(); else setOpen(true); }}><span className="composer-setting-value model-setting-value"><ProviderLogo providerId={providerId} provider={selectedProvider} size={24}/><strong>{displayLabel}</strong>{selectedNeedsApiKey ? <AlertIcon className="model-setting-caution" title="API key required"/> : null}<ChevronDownIcon /></span></button>
    {open ? <section id={dropupId} className="model-picker-dropup" role="dialog" aria-modal="false" aria-label="Choose model"><header><strong>Models</strong><button type="button" aria-label="Open full model browser" title="Open full model browser" onClick={() => { setOpen(false); setExpanded(true); }}><ExternalLinkIcon /></button></header>{search}<div ref={modelScroll} className="model-picker-scroll" data-complete-row-viewport="true" style={modelScrollHeight === null ? undefined : { height: modelScrollHeight }}>{results}</div></section> : null}
    {expanded ? createPortal(<div className="model-library-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePicker(); }}><section ref={modelLibrary} id={libraryId} className="model-library" role="dialog" aria-modal="true" aria-label="Model browser"><header><strong>Model browser</strong><button type="button" aria-label="Close model browser" onClick={() => closePicker()}><XIcon /></button></header>{search}<div className="model-library-scroll">{results}</div></section></div>, document.body) : null}
  </div>;
}

function uploadRequest(request: Request) {
  return (type: string, payload: Record<string, unknown> = {}) => request(type, payload as JsonObject);
}

function toSource(value: unknown): TranscriptionSource | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const capabilities = item.capabilities as Record<string, unknown> | undefined;
  const credential = item.credential as Record<string, unknown> | undefined;
  if (typeof item.id !== "string" || typeof item.label !== "string" || (item.status !== "ready" && item.status !== "needs_credential") || typeof item.setupEnvironmentVariable !== "string" || typeof capabilities?.maxAudioBytes !== "number") return null;
  return {
    id: item.id,
    label: item.label,
    status: item.status,
    setupEnvironmentVariable: item.setupEnvironmentVariable,
    ...(credential?.kind === "api_key" && typeof credential.label === "string" && typeof credential.setupUrl === "string" ? { credential: { kind: "api_key" as const, label: credential.label, setupUrl: credential.setupUrl } } : {}),
    capabilities: { batch: capabilities.batch === true, maxAudioBytes: capabilities.maxAudioBytes },
  };
}

function preferredDictationKey(providerId: string): string {
  return `tethoq:dictation-source:${providerId}`;
}

function safeStoredSource(providerId: string): string {
  try { return localStorage.getItem(preferredDictationKey(providerId)) ?? ""; }
  catch { return ""; }
}

function storeSource(providerId: string, sourceId: string): void {
  try { localStorage.setItem(preferredDictationKey(providerId), sourceId); }
  catch { /* Preferences may be unavailable in a restricted preview. */ }
}

const preferredMicrophoneKey = "tethoq:dictation-microphone-device";

function safeStoredMicrophone(): string {
  try { return localStorage.getItem(preferredMicrophoneKey) ?? ""; }
  catch { return ""; }
}

function storeMicrophone(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(preferredMicrophoneKey, deviceId);
    else localStorage.removeItem(preferredMicrophoneKey);
  } catch { /* Preferences may be unavailable in a restricted preview. */ }
}

function unavailableMicrophoneError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotFoundError" || error.name === "OverconstrainedError");
}

function providerDictationSource(providerId: string): string {
  if (providerId === "grok") return "xai-stt";
  if (providerId === "codex" || providerId === "direct") return "openai-stt";
  return "";
}

export interface DictationControlHandle {
  stop: () => void;
}

export const DictationControl = forwardRef<DictationControlHandle, {
  providerId: string;
  request: Request;
  notify: ComposerProps["notify"];
  onTranscript: (value: string) => void;
  /** When provided, a recorded clip can be attached to the outgoing message. */
  onAudio?: (audio: SelectedAudio) => void;
  audioDictationAvailable?: boolean;
  /** False when EARS transcribes the clip on the way instead of the model hearing it. */
  directToModel?: boolean;
  liveStripHost?: RefObject<HTMLDivElement | null>;
  onPhaseChange?: (phase: "idle" | "recording" | "transcribing" | "audio-recording") => void;
  onCommit?: () => void;
  onSettled?: (committed: boolean) => void;
}>(({
  providerId,
  request,
  notify,
  onTranscript,
  onAudio,
  audioDictationAvailable,
  directToModel = true,
  liveStripHost,
  onPhaseChange,
  onCommit,
  onSettled,
}, ref) => {
  const [sources, setSources] = useState<readonly TranscriptionSource[]>([]);
  const [selectedId, setSelectedId] = useState(() => safeStoredSource(providerId));
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [microphoneSettingsOpen, setMicrophoneSettingsOpen] = useState(false);
  const [microphones, setMicrophones] = useState<readonly MediaDeviceInfo[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState(safeStoredMicrophone);
  const [microphoneBusy, setMicrophoneBusy] = useState(false);
  const [setupSourceId, setSetupSourceId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [phase, setPhaseState] = useState<"idle" | "recording" | "transcribing" | "audio-recording">("idle");
  const alive = useRef(true);
  const onAudioRef = useRef(onAudio);
  const onCommitRef = useRef(onCommit);
  const onSettledRef = useRef(onSettled);
  const notifyRef = useRef(notify);
  onAudioRef.current = onAudio;
  onCommitRef.current = onCommit;
  onSettledRef.current = onSettled;
  notifyRef.current = notify;
  const setPhase = useCallback((next: "idle" | "recording" | "transcribing" | "audio-recording") => {
    if (alive.current) setPhaseState(next);
  }, []);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRecorderRef = useRef<Mp3DictationRecorder | null>(null);
  const levelMonitorRef = useRef<MicrophoneLevelMonitor | null>(null);
  const [audioElapsed, setAudioElapsed] = useState(0);
  const [audioFinalizing, setAudioFinalizing] = useState(false);
  const audioTimerRef = useRef<number | null>(null);
  const directAudioId = "direct-audio";
  const directAudioEnabled = audioDictationAvailable === true && onAudio !== undefined;

  useEffect(() => { onPhaseChange?.(phase); }, [onPhaseChange, phase]);

  const refreshMicrophones = useCallback(async (requestLabels: boolean) => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) throw new Error("Microphone selection is unavailable on this computer.");
    let devices = await mediaDevices.enumerateDevices();
    const labelsUnavailable = devices.some((device) => device.kind === "audioinput" && !device.label);
    if (requestLabels && labelsUnavailable && mediaDevices.getUserMedia) {
      const permissionStream = await mediaDevices.getUserMedia({ audio: true, video: false });
      permissionStream.getTracks().forEach((track) => track.stop());
      devices = await mediaDevices.enumerateDevices();
    }
    const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId !== "default");
    setMicrophones(inputs);
    setSelectedMicrophoneId((current) => {
      const resolved = resolvedDictationDeviceId(inputs, current);
      if (current && !resolved) storeMicrophone("");
      return resolved;
    });
    return inputs;
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    const refresh = () => { void refreshMicrophones(false).catch(() => undefined); };
    refresh();
    mediaDevices.addEventListener?.("devicechange", refresh);
    return () => mediaDevices.removeEventListener?.("devicechange", refresh);
  }, [refreshMicrophones]);

  const openMicrophoneSettings = () => {
    setMicrophoneSettingsOpen(true);
    setMicrophoneBusy(true);
    void refreshMicrophones(true)
      .catch((error) => notify(error instanceof Error ? error.message : String(error), "error"))
      .finally(() => setMicrophoneBusy(false));
  };

  const requestMicrophoneStream = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone recording is unavailable on this computer.");
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: dictationAudioConstraints(selectedMicrophoneId), video: false });
    } catch (error) {
      if (!selectedMicrophoneId || !unavailableMicrophoneError(error)) throw error;
      setSelectedMicrophoneId("");
      storeMicrophone("");
      return await navigator.mediaDevices.getUserMedia({ audio: dictationAudioConstraints(), video: false });
    }
  }, [selectedMicrophoneId]);

  useEffect(() => {
    let active = true;
    void request("dictation.source.list").then((payload) => {
      if (!active) return;
      const next = Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : [];
      const stored = safeStoredSource(providerId);
      const chosen = chooseTranscriptionSource(next, stored || providerDictationSource(providerId));
      setSources(next);
      // An explicit earlier choice wins; otherwise recording is the friendlier
      // default whenever the clip has somewhere to go.
      setSelectedId(stored || (directAudioEnabled ? directAudioId : chosen?.id ?? ""));
    }).catch(() => { if (active) setSources([]); });
    return () => { active = false; };
  }, [directAudioEnabled, directAudioId, providerId, request]);

  // Source/provider refreshes must not destroy a recording. On an actual task
  // switch, finish the clip into that task's persisted draft instead of silently
  // throwing away what the user already spoke.
  useEffect(() => () => {
    alive.current = false;
    if (audioTimerRef.current !== null) window.clearInterval(audioTimerRef.current);
    audioTimerRef.current = null;
    levelMonitorRef.current?.stop();
    levelMonitorRef.current = null;
    const audioRecorder = audioRecorderRef.current;
    audioRecorderRef.current = null;
    if (audioRecorder) {
      void audioRecorder.stop().then((audio) => {
        if (audio.byteLength > 25 * 1024 * 1024) throw new Error("Audio recordings can be up to 25 MiB.");
        onAudioRef.current?.(audio);
        onCommitRef.current?.();
        onSettledRef.current?.(true);
      }).catch((error: unknown) => {
        onSettledRef.current?.(false);
        notifyRef.current(error instanceof Error ? error.message : String(error), "error");
      });
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  // MP3 stays visible in the menu whether or not the current model can hear it,
  // so the free route is always discoverable; directAudioEnabled is what gates
  // actually recording through it.
  const directAudioSource: TranscriptionSource | undefined = onAudio !== undefined ? {
    id: directAudioId,
    label: "MP3",
    status: "ready",
    setupEnvironmentVariable: "",
    capabilities: { batch: false, maxAudioBytes: 24 * 1024 * 1024 },
  } : undefined;
  const allSources = directAudioSource ? [...sources, directAudioSource] : sources;
  const selected = allSources.find((source) => source.id === selectedId) ?? (directAudioSource ?? chooseTranscriptionSource(sources, providerDictationSource(providerId)));
  const hasReadySource = directAudioEnabled || sources.some((source) => source.status === "ready");
  const stopTracks = () => {
    levelMonitorRef.current?.stop();
    levelMonitorRef.current = null;
    if (audioTimerRef.current !== null) window.clearInterval(audioTimerRef.current);
    audioTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };
  const finish = useCallback(async (blob: Blob, source: TranscriptionSource) => {
    setPhase("transcribing");
    let uploadId = "";
    let committed = false;
    try {
      const audio = await blobToUploadable(blob);
      if (audio.byteLength > source.capabilities.maxAudioBytes) throw new Error(`${source.label} accepts recordings up to ${Math.round(source.capabilities.maxAudioBytes / 1024 / 1024)} MB.`);
      const [attachmentId] = await uploadAttachments([audio], uploadRequest(request), (id) => { uploadId = id; });
      if (!attachmentId) throw new Error("The dictation recording could not be uploaded.");
      const result = await request("dictation.transcribe", { attachmentId, dictionary: [], sourceId: source.id });
      const transcript = typeof result.text === "string" ? result.text.trim() : "";
      if (!transcript) throw new Error("No speech was detected.");
      onTranscript(transcript);
      onCommit?.();
      committed = true;
      notify("Dictation added to your message");
      uploadId = "";
    } catch (error) {
      if (uploadId) await request("attachment.upload.cancel", { uploadId }).catch(() => undefined);
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      onSettled?.(committed);
      setPhase("idle");
    }
  }, [notify, onCommit, onSettled, onTranscript, request]);

  const clearAudioTimer = () => {
    if (audioTimerRef.current !== null) window.clearInterval(audioTimerRef.current);
    audioTimerRef.current = null;
  };

  const stopAudio = useCallback(async () => {
    const recorder = audioRecorderRef.current;
    if (!recorder) return;
    audioRecorderRef.current = null;
    clearAudioTimer();
    // Encoding can take long enough to paint. Keep the live strip's footprint
    // until its clip is committed so the composer and followed transcript do not
    // collapse for one frame before an immediate send clears them together.
    setAudioFinalizing(true);
    setPhase("transcribing");
    let committed = false;
    try {
      const audio = await recorder.stop();
      if (onAudio === undefined) return;
      if (audio.byteLength > 25 * 1024 * 1024) throw new Error("Audio recordings can be up to 25 MiB.");
      onAudio(audio);
      onCommit?.();
      committed = true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      onSettled?.(committed);
      setAudioFinalizing(false);
      setPhase("idle");
    }
  }, [notify, onAudio, onCommit, onSettled]);

  const startAudio = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { notify("Microphone dictation is unavailable on this computer.", "error"); return; }
    let stream: MediaStream | undefined;
    try {
      stream = await requestMicrophoneStream();
      const recorder = new Mp3DictationRecorder((level) => liveTraceLevels.push(level));
      await recorder.start(stream);
      audioRecorderRef.current = recorder;
      setAudioElapsed(0);
      setPhase("audio-recording");
      audioTimerRef.current = window.setInterval(() => {
        setAudioElapsed((current) => {
          if (current + 1 >= 600) void stopAudio();
          return current + 1;
        });
      }, 1000);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      notify(error instanceof Error ? error.message : "Microphone permission was not granted.", "error");
      setPhase("idle");
    }
  };

  const start = async () => {
    if (!selected || selected.status !== "ready") {
      setSetupSourceId("");
      setSourceMenuOpen(true);
      return;
    }
    if (selected.id === directAudioId) {
      if (!directAudioEnabled) { notify("This model cannot hear a recording, so MP3 dictation is unavailable.", "error"); return; }
      await startAudio();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { notify("Microphone dictation is unavailable on this computer.", "error"); return; }
    try {
      const stream = await requestMicrophoneStream();
      const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => { stopTracks(); onSettled?.(false); setPhase("idle"); notify("Dictation recording failed.", "error"); };
      recorder.onstop = () => {
        stopTracks();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length) void finish(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), selected);
        else { onSettled?.(false); setPhase("idle"); notify("No audio was recorded.", "error"); }
      };
      const levelMonitor = new MicrophoneLevelMonitor((level) => liveTraceLevels.push(level));
      try {
        await levelMonitor.start(stream);
        levelMonitorRef.current = levelMonitor;
      } catch {
        // A visualizer failure must not turn a working MediaRecorder into a
        // failed dictation. Capture continues and still settles normally.
        levelMonitor.stop();
      }
      recorder.start(500);
      setAudioElapsed(0);
      if (audioTimerRef.current !== null) window.clearInterval(audioTimerRef.current);
      audioTimerRef.current = window.setInterval(() => setAudioElapsed((current) => current + 1), 1000);
      setPhase("recording");
    } catch (error) { stopTracks(); notify(error instanceof Error ? error.message : "Microphone permission was not granted.", "error"); }
  };
  const stop = () => {
    if (phase === "audio-recording") { void stopAudio(); return; }
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };
  useImperativeHandle(ref, () => ({ stop }), [phase]);
  const select = (source: TranscriptionSource) => {
    if (source.status !== "ready") {
      setSetupSourceId(source.id);
      setApiKey("");
      return;
    }
    setSelectedId(source.id);
    storeSource(providerId, source.id);
    setSourceMenuOpen(false);
  };
  const selectMicrophone = (deviceId: string) => {
    setSelectedMicrophoneId(deviceId);
    storeMicrophone(deviceId);
    setMicrophoneSettingsOpen(false);
  };
  const setupSource = sources.find((source) => source.id === setupSourceId);
  const configureCredential = async () => {
    if (!setupSource?.credential || credentialBusy) return;
    setCredentialBusy(true);
    try {
      const payload = await request("dictation.source.configure", { sourceId: setupSource.id, apiKey: apiKey.trim() });
      const next = Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : [];
      const configured = next.find((source) => source.id === setupSource.id && source.status === "ready");
      if (!configured) throw new Error(`${setupSource.label} did not become ready.`);
      setSources(next);
      setSelectedId(configured.id);
      storeSource(providerId, configured.id);
      setApiKey("");
      setSetupSourceId("");
      setSourceMenuOpen(false);
      notify(`${configured.label} is ready`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setCredentialBusy(false);
    }
  };
  const clearCredential = async () => {
    if (!setupSource?.credential || credentialBusy) return;
    setCredentialBusy(true);
    try {
      const payload = await request("dictation.source.configure", { sourceId: setupSource.id, clear: true });
      const next = Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : [];
      setSources(next);
      setSelectedId(chooseTranscriptionSource(next, providerDictationSource(providerId))?.id ?? "");
      setApiKey("");
      setSetupSourceId("");
      notify(`${setupSource.label} key removed`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setCredentialBusy(false);
    }
  };

  const recording = phase === "recording" || phase === "audio-recording";
  const liveStrip = (recording || audioFinalizing) && liveStripHost?.current
    ? createPortal(<div className="dictation-audio-strip" role="status" aria-live="polite">
      <AudioTraceCanvas live/>
      <span className="dictation-audio-elapsed">{Math.floor(audioElapsed / 60)}:{String(audioElapsed % 60).padStart(2, "0")}</span>
    </div>, liveStripHost.current)
    : null;

  return <div className={`dictation-control dictation-${phase}`}>
    {liveStrip}
    <button className="dictation-main" type="button" aria-label={recording ? "Stop dictation" : phase === "transcribing" ? "Transcribing dictation" : "Start dictation"} title={recording ? "Stop dictation" : phase === "transcribing" ? "Transcribing dictation" : "Dictate"} disabled={phase === "transcribing"} onClick={() => recording ? stop() : void start()}>{phase === "transcribing" ? <span className="spinner" /> : recording ? <StopIcon /> : <MicrophoneIcon />}</button>
    {recording || audioFinalizing ? null : <Popover label="Choose dictation source" className="dictation-source-menu" open={sourceMenuOpen} onOpen={(open) => { setSourceMenuOpen(open); if (!open) setMicrophoneSettingsOpen(false); }} trigger={<DictationCrescentIcon />}>
      {microphoneSettingsOpen ? <section className="dictation-device-picker">
        <header><button type="button" aria-label="Back to dictation sources" onClick={() => setMicrophoneSettingsOpen(false)}><ChevronRightIcon /></button><span><strong>Microphone</strong><small>Used for MP3 and transcription recording</small></span></header>
        <div role="radiogroup" aria-label="Recording microphone">
          <button type="button" role="radio" aria-checked={!selectedMicrophoneId} onClick={() => selectMicrophone("")}><MicrophoneIcon /><span><strong>Default microphone</strong><small>Follows the current Windows default</small></span>{!selectedMicrophoneId ? <CheckIcon /> : null}</button>
          {microphones.map((device, index) => <button type="button" role="radio" aria-checked={selectedMicrophoneId === device.deviceId} key={device.deviceId} onClick={() => selectMicrophone(device.deviceId)}><MicrophoneIcon /><span><strong>{device.label || `Microphone ${index + 1}`}</strong><small>{selectedMicrophoneId === device.deviceId ? "Selected" : "Audio input"}</small></span>{selectedMicrophoneId === device.deviceId ? <CheckIcon /> : null}</button>)}
        </div>
        {microphoneBusy ? <p><span className="spinner" /> Checking microphones…</p> : null}
      </section> : setupSource?.credential ? <form className="dictation-credential-setup" onSubmit={(event) => { event.preventDefault(); void configureCredential(); }}>
        <header><button type="button" aria-label="Back to dictation sources" onClick={() => { setSetupSourceId(""); setApiKey(""); }}><ChevronRightIcon /></button><span><strong>{setupSource.label}</strong><small>Uses your {setupSource.credential.label}; this is separate from a consumer subscription.</small></span></header>
        <p>The key is checked with {setupSource.id === "xai-stt" ? "xAI" : "OpenAI"}, encrypted, and stored only on this computer.</p>
        <label><span>{setupSource.credential.label}</span><input autoFocus type="password" value={apiKey} minLength={8} maxLength={512} autoComplete="off" spellCheck={false} placeholder="Paste API key" onChange={(event) => setApiKey(event.target.value)} /></label>
        <div className="dictation-credential-actions"><button type="button" onClick={() => { if (typeof window.tethoqDesktop?.openDictationSetupPage === "function") void window.tethoqDesktop.openDictationSetupPage(setupSource.id === "xai-stt" ? "xai-stt" : "openai-stt"); }}><ExternalLinkIcon />Get API key</button>{setupSource.status === "ready" ? <button type="button" disabled={credentialBusy} onClick={() => void clearCredential()}>Remove saved key</button> : null}<button type="submit" disabled={credentialBusy || apiKey.trim().length < 8}>{credentialBusy ? "Checking…" : "Save and use"}</button></div>
      </form> : <>
        <header className={hasReadySource ? undefined : "dictation-source-empty"}><span><strong>{hasReadySource ? "Dictation source" : "No dictation source is enabled"}</strong><small>{hasReadySource ? `Saved separately for ${providerId}` : sources.length ? "Choose a provider below to set one up." : "No compatible source is available on this computer."}</small></span><button type="button" className="dictation-device-settings" aria-label="Choose microphone" title="Choose microphone" onClick={openMicrophoneSettings}><SettingsIcon /></button></header>
        {directAudioSource ? <div className="dictation-unlimited-group">
          <div className="dictation-section-label"><h5>unlimited</h5><button type="button" className="dictation-info-button" aria-label="About MP3 dictation" data-tooltip-align="end" data-tooltip={directAudioEnabled ? "This model allows audio input, so a recording can be used as a dictation alternative." : "This model does not accept audio input. Recording becomes available with an audio-capable model or EARS transcription."}><InfoIcon /></button></div>
          <button type="button" role="menuitemradio" aria-checked={selected?.id === directAudioId} disabled={!directAudioEnabled} className={`dictation-direct-audio-option${directAudioEnabled ? "" : " dictation-source-unavailable"}`} key={directAudioId} onClick={() => select(directAudioSource)}><span className="dictation-direct-audio-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M2 12h2.5M6 8.5v7M9.5 5v14M13 8.5v7M16.5 5v14M20 9.5v5M22.5 12H22" /></svg></span><span><strong>{directAudioSource.label}</strong><small>{directAudioEnabled ? (directToModel ? "The model hears your recording" : "EARS turns your recording into text") : "This model cannot hear a recording"}</small></span>{selected?.id === directAudioId ? <CheckIcon /> : null}</button>
        </div> : null}
        <div className="dictation-api-heading"><strong>API transcription</strong><small>Uses your provider API key</small></div>
        <div className="dictation-sources-scroll" role="group" aria-label="API transcription sources">
          {sources.length ? sources.map((source) => {
            const active = source.status === "ready" && source.id === selected?.id;
            return <button type="button" role="menuitemradio" aria-checked={active} key={source.id} onClick={() => select(source)}><ProviderLogo providerId={source.id.startsWith("xai") ? "grok" : "codex"} size={25}/><span><strong>{source.label}</strong><small>{source.status === "ready" ? "API key saved" : `${source.credential?.label ?? "API key"} required · Set up`}</small></span>{active ? <CheckIcon /> : null}</button>;
          }) : null}
        </div>
        {selected?.status === "ready" && selected.id !== directAudioId && selected.credential ? <button type="button" className="dictation-manage-source" onClick={() => { setSetupSourceId(selected.id); setApiKey(""); }}><span><strong>Manage API key</strong><small>Replace or remove the saved key</small></span><ChevronRightIcon /></button> : null}
      </>}
    </Popover>}
  </div>;
});

export function ResponseAnnotationEditor({ selectedText, initial, anchor, providerId, request, notify, directAudioAvailable, earsEnabled, onSave, onClose }: {
  selectedText: string;
  initial?: ResponseAnnotation | undefined;
  anchor: { x: number; y: number };
  providerId: string;
  request: Request;
  notify: ComposerProps["notify"];
  directAudioAvailable: boolean;
  earsEnabled: boolean;
  onSave: (annotation: ResponseAnnotation) => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState(initial?.annotation ?? "");
  const [audio, setAudio] = useState<SelectedAudio | undefined>(initial?.audio);
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing" | "audio-recording">("idle");
  const [commitRevision, setCommitRevision] = useState(0);
  const submitAfterRecordingRevision = useRef<number | null>(null);
  const dictation = useRef<DictationControlHandle>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const save = useCallback(() => {
    if (!comment.trim() && !audio) return;
    onSave({
      id: initial?.id ?? `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: selectedText.trim(),
      annotation: comment.trim(),
      ...(audio ? { audio } : {}),
    });
  }, [audio, comment, initial?.id, onSave, selectedText]);
  useEffect(() => {
    const expectedRevision = submitAfterRecordingRevision.current;
    if (expectedRevision === null || phase !== "idle" || commitRevision < expectedRevision) return;
    submitAfterRecordingRevision.current = null;
    save();
  }, [commitRevision, phase, save]);
  useEffect(() => {
    textarea.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const recording = phase === "recording" || phase === "audio-recording";
  const add = () => {
    if (recording) {
      submitAfterRecordingRevision.current = commitRevision + 1;
      dictation.current?.stop();
      return;
    }
    save();
  };
  const left = Math.max(12, Math.min(anchor.x, window.innerWidth - 380));
  const top = Math.max(72, Math.min(anchor.y + 8, window.innerHeight - 310));
  return createPortal(<div className="annotation-editor-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="annotation-editor" role="dialog" aria-label={initial ? "Edit response annotation" : "Annotate selected response"} style={{ left, top }}>
      <header><span><AnnotationIcon /><strong>{initial ? "Edit annotation" : "Annotate response"}</strong></span><button type="button" aria-label="Close annotation editor" onClick={onClose}><XIcon /></button></header>
      <blockquote>{selectedText}</blockquote>
      {audio ? <AudioPlaybackChip name={audio.name} dataUrl={`data:${audio.mimeType};base64,${audio.dataBase64}`} dictation durationSeconds={audio.durationSeconds} onRemove={() => setAudio(undefined)} /> : null}
      <div className="annotation-editor-entry">
        <textarea ref={textarea} value={comment} rows={3} placeholder="Add your comment…" aria-label="Annotation comment" onChange={(event) => setComment(event.target.value)} />
        <div className="annotation-editor-actions">
          <DictationControl
            ref={dictation}
            providerId={providerId}
            request={request}
            notify={notify}
            onTranscript={(value) => setComment((current) => appendTranscript(current, value))}
            onAudio={setAudio}
            audioDictationAvailable={directAudioAvailable || earsEnabled}
            directToModel={directAudioAvailable}
            onPhaseChange={setPhase}
            onCommit={() => setCommitRevision((current) => current + 1)}
            onSettled={(committed) => { if (!committed) submitAfterRecordingRevision.current = null; }}
          />
          <button type="button" className="annotation-editor-send" aria-label={recording ? "Stop recording and add annotation" : "Add annotation to message"} disabled={phase === "transcribing" || (!comment.trim() && !audio && !recording)} onClick={add}><SendIcon /></button>
        </div>
      </div>
    </section>
  </div>, document.body);
}

function ComposerAnnotationChip({ annotation, index, onEdit, onRemove }: {
  annotation: ResponseAnnotation;
  index: number;
  onEdit: (anchor: { x: number; y: number }) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("pointerdown", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("pointerdown", dismiss);
    };
  }, [open]);
  return <span ref={root} className="composer-annotation-chip">
    <button type="button" className="composer-annotation-main" aria-expanded={open} aria-label={`View annotation ${index + 1}`} onClick={() => setOpen((current) => !current)}><AnnotationIcon /><strong>{index + 1}</strong><span>{annotation.text}</span></button>
    <button type="button" className="composer-annotation-edit" aria-label={`Edit annotation ${index + 1}`} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setOpen(false); onEdit({ x: bounds.left, y: bounds.top }); }}><EditIcon /></button>
    <button type="button" className="composer-annotation-remove" aria-label={`Remove annotation ${index + 1}`} onClick={onRemove}><XIcon /></button>
    {open ? <span className="composer-annotation-detail" role="note"><small>Selected response</small><blockquote>{annotation.text}</blockquote><small>Your annotation</small>{annotation.annotation ? <p>{annotation.annotation}</p> : null}{annotation.audio ? <AudioPlaybackChip name={annotation.audio.name} dataUrl={`data:${annotation.audio.mimeType};base64,${annotation.audio.dataBase64}`} dictation durationSeconds={annotation.audio.durationSeconds}/> : null}</span> : null}
  </span>;
}

export function DictationSettings({ request, notify }: {
  request: Request;
  notify: ComposerProps["notify"];
}) {
  const [sources, setSources] = useState<readonly TranscriptionSource[]>([]);
  const [editingId, setEditingId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void request("dictation.source.list").then((payload) => {
      if (!active) return;
      setSources(Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : []);
    }).catch(() => { if (active) setSources([]); });
    return () => { active = false; };
  }, [request]);
  const editing = sources.find((source) => source.id === editingId);
  const save = async () => {
    if (!editing?.credential || busy) return;
    setBusy(true);
    try {
      const payload = await request("dictation.source.configure", { sourceId: editing.id, apiKey: apiKey.trim() });
      setSources(Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : []);
      setEditingId("");
      setApiKey("");
      notify(`${editing.label} is ready`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(false); }
  };
  const remove = async (source: TranscriptionSource) => {
    if (!source.credential || busy) return;
    setBusy(true);
    try {
      const payload = await request("dictation.source.configure", { sourceId: source.id, clear: true });
      setSources(Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((item): item is TranscriptionSource => item !== null) : []);
      setEditingId("");
      setApiKey("");
      notify(`${source.label} key removed`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(false); }
  };
  return <section className="settings-block dictation-settings-block" id="dictation-settings">
    <header><h2>Dictation</h2><small>Provider speech-to-text, configured on this computer</small></header>
    <div className="settings-list">{sources.map((source) => <article key={source.id}>
      <ProviderLogo providerId={source.id === "xai-stt" ? "grok" : "codex"} size={31}/>
      <span><strong>{source.label}</strong><small>{source.status === "ready" ? `${source.credential?.label ?? "API key"} saved` : `${source.credential?.label ?? "API key"} required`}</small></span>
      <button type="button" disabled={!source.credential || busy} onClick={() => { setEditingId(source.id); setApiKey(""); }}>{source.status === "ready" ? "Manage" : "Set up"}</button>
    </article>)}</div>
    {editing?.credential ? <form className="dictation-settings-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div><strong>{editing.label}</strong><small>A subscription does not supply this API key. Tethoq encrypts it locally.</small></div>
      <label><span>{editing.credential.label}</span><input autoFocus type="password" value={apiKey} minLength={8} maxLength={512} autoComplete="off" spellCheck={false} placeholder="Paste API key" onChange={(event) => setApiKey(event.target.value)}/></label>
      <div><button type="button" onClick={() => { if (typeof window.tethoqDesktop?.openDictationSetupPage === "function") void window.tethoqDesktop.openDictationSetupPage(editing.id === "xai-stt" ? "xai-stt" : "openai-stt"); }}><ExternalLinkIcon />Get API key</button>{editing.status === "ready" ? <button type="button" disabled={busy} onClick={() => void remove(editing)}>Remove saved key</button> : null}<button type="button" onClick={() => { setEditingId(""); setApiKey(""); }}>Cancel</button><button type="submit" disabled={busy || apiKey.trim().length < 8}>{busy ? "Checking…" : "Save and use"}</button></div>
    </form> : null}
  </section>;
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></svg>;
}

function DictationCrescentIcon() {
  return <svg viewBox="0 0 24 12" aria-hidden="true"><path d="m7 3.25 5 4.25 5-4.25" /></svg>;
}

export function buildContextHandoffInstruction(customNote: string): string {
  const trimmed = customNote.trim();
  return [
    "Create a context handoff prompt so another model can pick up where this task left off smoothly.",
    "",
    "Include the current goal, key decisions and constraints, what is already done, what is still open or unverified, relevant files or workspace state, and concrete next steps.",
    "Be factual and grounded in the conversation above. Do not invent results and do not claim unverified work is complete.",
    ...(trimmed ? ["", `Custom focus from the user:\n${trimmed}`, ""] : [""]),
    "Output only the self-contained handoff prompt, ready to paste into a new task. Do not add preamble about side chats.",
  ].join("\n");
}

function ContextHandoffPicker({ session, request, notify, onClose, onSubmit }: {
  session: Session;
  request: Request;
  notify: ComposerProps["notify"];
  onClose: (restoreFocus?: boolean) => void;
  onSubmit: (customNote: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      active.current = false;
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const customNote = prompt.trim();
      await onSubmit(customNote);
      if (!active.current) return;
      onClose(false);
    } catch (error) {
      if (!active.current) return;
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return <section ref={panel} className="chat-picker handoff-chat-picker" role="dialog" aria-label="Context Handoff">
    <header><span><strong>Context Handoff</strong><small>Stay here — the same model prepares a pickup prompt in a side chat</small></span><button type="button" aria-label="Close context handoff" onClick={() => onClose()}><XIcon /></button></header>
    <div className="handoff-copy"><ChatIcon /><span><strong>What should the handoff emphasize?</strong><small>Optional. The side chat already carries this task's context, so the main conversation stays untouched.</small></span></div>
    <div className="handoff-composer"><textarea ref={textarea} autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder="Optional focus for the handoff prompt…" rows={3}/><DictationControl providerId={session.providerId} request={request} notify={notify} onTranscript={(transcript) => { setPrompt((current) => appendTranscript(current, transcript)); requestAnimationFrame(() => textarea.current?.focus()); }}/><button type="button" className="handoff-send" aria-label="Prepare context handoff" disabled={busy} onClick={() => void submit()}>{busy ? <span className="spinner" /> : <SendIcon />}</button></div>
    <footer><button type="button" onClick={() => onClose()}>Cancel</button><button className="primary" type="button" disabled={busy} onClick={() => void submit()}>{busy ? <span className="spinner" /> : <ChatIcon />} Prepare handoff</button></footer>
  </section>;
}

interface NormalizedCrop { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

function normalizedPoint(event: ReactPointerEvent, element: HTMLElement): { x: number; y: number } {
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
  };
}

async function cropScreenSource(source: ScreenCaptureSource, crop: NormalizedCrop): Promise<SelectedImage> {
  const image = new Image();
  image.src = source.dataUrl;
  await image.decode();
  const x = Math.max(0, Math.min(image.naturalWidth - 1, Math.round(crop.x * image.naturalWidth)));
  const y = Math.max(0, Math.min(image.naturalHeight - 1, Math.round(crop.y * image.naturalHeight)));
  const width = Math.max(1, Math.min(image.naturalWidth - x, Math.round(crop.width * image.naturalWidth)));
  const height = Math.max(1, Math.min(image.naturalHeight - y, Math.round(crop.height * image.naturalHeight)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Screen capture could not be prepared.");
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Screen capture could not be encoded.")), "image/png"));
  const uploadable = await blobToUploadable(blob, `screen-region-${Date.now()}.png`);
  return { ...uploadable, path: `screen-capture:${source.id}:${Date.now()}` };
}

function ScreenRegionPicker({ notify, onClose, onChoose }: { notify: ComposerProps["notify"]; onClose: () => void; onChoose: (image: SelectedImage) => boolean }) {
  const [sources, setSources] = useState<readonly ScreenCaptureSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [selection, setSelection] = useState<NormalizedCrop | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    void window.tethoqDesktop.captureScreens().then((items) => {
      if (!active) return;
      setSources(items);
      setSourceId(items[0]?.id ?? "");
    }).catch((error: unknown) => { if (active) notify(error instanceof Error ? error.message : String(error), "error"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notify]);
  const source = sources.find((item) => item.id === sourceId) ?? sources[0];
  const updateSelection = (point: { x: number; y: number }) => {
    if (!start.current) return;
    const left = Math.min(start.current.x, point.x);
    const top = Math.min(start.current.y, point.y);
    setSelection({ x: left, y: top, width: Math.abs(point.x - start.current.x), height: Math.abs(point.y - start.current.y) });
  };
  const finish = async () => {
    if (!source || !selection || selection.width < .005 || selection.height < .005 || preparing) return;
    setPreparing(true);
    try {
      const image = await cropScreenSource(source, selection);
      if (image.byteLength > 25 * 1024 * 1024) throw new Error("The selected screen region is larger than 25 MiB.");
      if (onChoose(image)) notify("Screen region attached");
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setPreparing(false);
    }
  };
  return <div className="screen-capture-backdrop" role="presentation"><section className="screen-capture-picker" role="dialog" aria-modal="true" aria-label="Capture a screen region">
    <header><span><strong>Capture screen region</strong><small>Drag over the exact area to attach. Nothing is sent until you submit the message.</small></span><button type="button" aria-label="Close screen capture" onClick={onClose}><XIcon /></button></header>
    {sources.length > 1 ? <label className="screen-source-select"><span>Screen</span><select value={sourceId} onChange={(event) => { setSourceId(event.target.value); setSelection(null); }}>{sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
    <div className="screen-capture-stage">{loading ? <LoadingState label="Capturing screens" /> : source ? <div className="screen-capture-frame" ref={frame} onPointerDown={(event) => { const point = normalizedPoint(event, event.currentTarget); start.current = point; setSelection({ ...point, width: 0, height: 0 }); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => updateSelection(normalizedPoint(event, event.currentTarget))} onPointerUp={(event) => { updateSelection(normalizedPoint(event, event.currentTarget)); start.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}><img src={source.dataUrl} alt={source.name} draggable={false}/>{selection ? <i className="screen-capture-selection" style={{ left: `${selection.x * 100}%`, top: `${selection.y * 100}%`, width: `${selection.width * 100}%`, height: `${selection.height * 100}%` }} /> : null}</div> : <div className="chat-picker-empty"><strong>No screen is available</strong><small>Desktop capture may be blocked by your operating-system privacy settings.</small></div>}</div>
    <footer><small>{selection ? `${Math.round(selection.width * (source?.width ?? 0))} × ${Math.round(selection.height * (source?.height ?? 0))} px` : "Drag to select a region"}</small><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={!selection || selection.width < .005 || selection.height < .005 || preparing} onClick={() => void finish()}>{preparing ? <span className="spinner" /> : <ScreenshotIcon />} Attach region</button></footer>
  </section></div>;
}

function WorkflowPicker({ selected, preview, onClose, onChoose, onManageWorkflow }: {
  selected: readonly string[];
  preview: boolean;
  onClose: (restoreFocus?: boolean) => void;
  onChoose: (attachment: WorkflowAttachment) => void;
  onManageWorkflow: (id?: string) => void;
}) {
  const [items, setItems] = useState<readonly WorkflowDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [listRevision, setListRevision] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [choosingId, setChoosingId] = useState<string | null>(null);
  const [chooseError, setChooseError] = useState<{ readonly item: WorkflowDescriptor; readonly message: string } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const active = useRef(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    active.current = true;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onCloseRef.current(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); } };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      active.current = false;
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    if (preview) { setLoading(false); return; }
    setLoading(true);
    setListError(null);
    void window.tethoqDesktop.recorderAction({ type: "list" }).then((value) => {
      if (!active.current) return;
      if (!Array.isArray(value)) throw new Error("The workflow list was unavailable.");
      setItems(value as WorkflowDescriptor[]);
    }).catch((error: unknown) => {
      if (active.current) setListError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (active.current) setLoading(false); });
  }, [listRevision, preview]);
  useEffect(() => {
    if (loading || listError) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('button[data-workflow-id]:not(:disabled)')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [items, listError, loading, selected]);
  const choose = async (item: WorkflowDescriptor) => {
    if (choosingId !== null) return;
    setChoosingId(item.id);
    setChooseError(null);
    try {
      const value = await window.tethoqDesktop.recorderAction({ type: "attachment", id: item.id });
      if (!value || Array.isArray(value) || !("promptReference" in value)) throw new Error("The workflow attachment was unavailable.");
      if (active.current) onChoose(value as WorkflowAttachment);
    } catch (error) {
      if (active.current) setChooseError({ item, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (active.current) setChoosingId(null);
    }
  };
  return <section ref={panel} className="chat-picker workflow-chat-picker" role="dialog" aria-label="Choose a recorded workflow">
    <header><span><strong>Recorded workflows</strong><small>Attach local visual and action context</small></span><button type="button" aria-label="Close workflows" onClick={() => onClose()}><XIcon /></button></header>
    {listError ? <div className="delegation-catalogue-error workflow-picker-error" role="alert" title={listError}><span>Couldn’t load recorded workflows.</span><button type="button" onClick={() => setListRevision((current) => current + 1)}>Try again</button></div> : null}
    <div>{loading ? <LoadingState label="Loading workflows" /> : items.length ? items.map((item) => <button type="button" data-workflow-id={item.id} key={item.id} disabled={selected.includes(item.id) || choosingId !== null} onClick={() => void choose(item)}><WorkflowIcon /><span><strong>{item.name ?? "Unnamed workflow"}</strong><small>{item.summary.eventCount} events · {item.summary.screenshotCount} frames</small></span>{choosingId === item.id ? <span className="spinner" /> : selected.includes(item.id) ? <CheckIcon /> : <ChevronRightIcon />}</button>) : listError ? null : <div className="chat-picker-empty"><strong>No workflows saved</strong><small>Record and inspect workflows in Settings.</small></div>}</div>
    {chooseError ? <div className="delegation-catalogue-error workflow-picker-error" role="alert" title={chooseError.message}><span>Couldn’t attach {chooseError.item.name ?? "that workflow"}.</span><button type="button" disabled={choosingId !== null} onClick={() => void choose(chooseError.item)}>Try again</button></div> : null}
    <footer><button type="button" onClick={() => onManageWorkflow()}>Manage workflows <ChevronRightIcon /></button></footer>
  </section>;
}

export interface MeshTarget {
  readonly composerToken?: string;
  readonly offset?: number;
  readonly providerId: Session["providerId"];
  readonly modelId?: string;
  readonly reasoningEffort?: string;
}

function meshPresentationSegments(prompt: string, targets: readonly MeshTarget[] | number): Array<NonNullable<TimelineItem["mesh"]>["segments"][number]> {
  const positioned = typeof targets === "number" ? Array.from({ length: targets }, () => ({ providerId: "" })) : targets;
  return meshDraftParts(prompt, positioned).map((part) => "text" in part
    ? { type: "text", text: part.text }
    : { type: "mesh", targetIndex: part.targetIndex });
}

function sameMeshTarget(left: MeshTarget, right: MeshTarget): boolean {
  return left.providerId === right.providerId
    && left.modelId === right.modelId
    && left.reasoningEffort === right.reasoningEffort;
}

/** Consumes only targets actually submitted, retaining later edits and additions. */
export function remainingMeshTargetsAfterSchedule(
  current: readonly MeshTarget[],
  submitted: readonly MeshTarget[],
): readonly MeshTarget[] {
  if (!submitted.length) return current;
  const remaining = [...current];
  for (const target of submitted) {
    const index = remaining.findIndex((candidate) => target.composerToken
      ? candidate.composerToken === target.composerToken && sameMeshTarget(target, candidate)
      : sameMeshTarget(target, candidate));
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

interface StoredMeshRecentTargets {
  readonly updatedAt: number;
  readonly targets: readonly MeshTarget[];
}

export interface DelegationDraft {
  readonly providerId: Session["providerId"] | null;
  readonly modelId: string;
  readonly effort: string;
  readonly prompt: string;
}

// The bridge refuses more than four targets in one delegation, so the panel
// caps additions before a request is ever sent.
const maximumMeshTargets = 4;
const MESH_RECENT_TARGETS_KEY = "tethoq:mesh-recent-targets:v1";
const MESH_RECENT_MODELS_KEY = "tethoq:mesh-recent-models:v1";
const maximumMeshRecentSessions = 60;
const maximumMeshRecentModels = 5;

function safeMeshTarget(value: unknown): MeshTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.providerId !== "string" || !candidate.providerId.trim()) return null;
  const modelId = typeof candidate.modelId === "string" && !isAmbiguousSelectionValue(candidate.modelId)
    ? candidate.modelId.trim()
    : undefined;
  const reasoningEffort = typeof candidate.reasoningEffort === "string" && !isAmbiguousSelectionValue(candidate.reasoningEffort)
    ? candidate.reasoningEffort.trim()
    : undefined;
  return {
    providerId: candidate.providerId,
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function storedMeshRecentTargetMap(): Readonly<Record<string, StoredMeshRecentTargets>> {
  try {
    const value = JSON.parse(localStorage.getItem(MESH_RECENT_TARGETS_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([sessionId, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const candidate = entry as Record<string, unknown>;
      if (!Number.isFinite(candidate.updatedAt) || !Array.isArray(candidate.targets)) return [];
      const targets = candidate.targets.map(safeMeshTarget).filter((target): target is MeshTarget => target !== null);
      return [[sessionId, { updatedAt: candidate.updatedAt as number, targets }]];
    }));
  } catch {
    return {};
  }
}

/** Per-parent recency is written only after delegation.prepare was accepted. */
export function meshRecentTargetsForSession(sessionId: string): readonly MeshTarget[] {
  return storedMeshRecentTargetMap()[sessionId]?.targets ?? [];
}

function uniqueRecentMeshModels(values: readonly unknown[]): readonly MeshTarget[] {
  const seen = new Set<string>();
  return values.map(safeMeshTarget).filter((target): target is MeshTarget => {
    if (!target?.modelId) return false;
    const key = JSON.stringify([target.providerId, target.modelId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, maximumMeshRecentModels);
}

/** Model recency spans tasks and never falls back to ordinary model usage. */
export function recentMeshModels(): readonly MeshTarget[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MESH_RECENT_MODELS_KEY) ?? "null");
    if (Array.isArray(value)) return uniqueRecentMeshModels(value);
  } catch { /* Older accepted Mesh history remains available below. */ }
  return uniqueRecentMeshModels(Object.values(storedMeshRecentTargetMap())
    .sort((left, right) => right.updatedAt - left.updatedAt).flatMap((entry) => entry.targets));
}

export function persistMeshRecentTargetsForSession(sessionId: string, targets: readonly MeshTarget[], usedAt = Date.now()): void {
  try {
    const safeTargets = targets.map(safeMeshTarget).filter((target): target is MeshTarget => target !== null).slice(0, maximumMeshTargets);
    const recentModels = uniqueRecentMeshModels([...safeTargets, ...recentMeshModels()]);
    const entries = Object.entries({
      ...storedMeshRecentTargetMap(),
      [sessionId]: { updatedAt: usedAt, targets: safeTargets },
    }).sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, maximumMeshRecentSessions);
    localStorage.setItem(MESH_RECENT_TARGETS_KEY, JSON.stringify(Object.fromEntries(entries)));
    localStorage.setItem(MESH_RECENT_MODELS_KEY, JSON.stringify(recentModels));
  } catch {
    // A restricted preview can still use provider-backed snapshot recency.
  }
}

export function mostRecentMeshTargetFromSessions(
  sessions: readonly Session[],
  modelsByProvider: DesktopSnapshot["models"],
  providerId: Session["providerId"],
): MeshTarget | null {
  const catalogue = recentProviderModelIndex(modelsByProvider);
  const recent = sessions
    .map((session) => ({ session, key: concreteSessionModelKey(session, catalogue), usedAt: Date.parse(session.updatedAt) }))
    .filter((item) => item.session.providerId === providerId && item.key !== undefined && Number.isFinite(item.usedAt))
    .sort((left, right) => right.usedAt - left.usedAt)[0];
  if (!recent?.key) return null;
  const modelId = recent.key.slice(`${providerId}:`.length);
  return {
    providerId,
    modelId,
    ...(!isAmbiguousSelectionValue(recent.session.effort) ? { reasoningEffort: recent.session.effort.trim() } : {}),
  };
}

/**
 * Resolve the small Mesh row without inventing a selection. The parent task's
 * last accepted Mesh choice wins, followed by real provider session activity,
 * the configured Agent preference, and finally the provider catalogue default.
 */
export function resolveMeshTargetSelection(
  snapshot: DesktopSnapshot,
  providerId: Session["providerId"],
  sessionRecent: MeshTarget | undefined,
  agentDefaults: DesktopPreferencesState["agentDefaults"] = {},
): MeshTarget {
  const models = snapshot.models[providerId] ?? [];
  const validSessionRecent = sessionRecent?.providerId === providerId
    && (sessionRecent.modelId === undefined || models.length === 0 || models.some((model) => model.id === sessionRecent.modelId || model.name === sessionRecent.modelId))
    ? sessionRecent
    : undefined;
  const recent = validSessionRecent ?? mostRecentMeshTargetFromSessions(snapshot.sessions, snapshot.models, providerId) ?? undefined;
  if (!models.length) {
    const pending = recent ?? (agentDefaults[providerId]
      ? {
        providerId,
        modelId: agentDefaults[providerId]!.modelId,
        ...(agentDefaults[providerId]!.reasoningEffort ? { reasoningEffort: agentDefaults[providerId]!.reasoningEffort } : {}),
      }
      : undefined);
    return pending ?? { providerId };
  }
  const resolved = resolveConcreteModelSelection(models, recent ?? {}, agentDefaults[providerId]);
  return {
    providerId,
    ...(resolved?.modelId ? { modelId: resolved.modelId } : {}),
    ...(resolved?.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
  };
}

export function availableMeshProviders(snapshot: DesktopSnapshot, targets: readonly MeshTarget[]): readonly Provider[] {
  if (targets.length >= maximumMeshTargets) return [];
  return snapshot.providers.filter((provider) => provider.state === "online"
    && provider.capabilities.includes("Create Session")
    && provider.capabilities.includes("Send Message"));
}

function meshTargetModelLabel(snapshot: DesktopSnapshot, target: MeshTarget): string {
  return snapshot.models[target.providerId]?.find((model) => model.id === target.modelId)?.name ?? target.modelId ?? "Harness default";
}

export function matchingRecentMeshModels(snapshot: DesktopSnapshot, recent: readonly MeshTarget[], query: string): readonly MeshTarget[] {
  const prefix = query.toLocaleLowerCase();
  const providers = availableMeshProviders(snapshot, []);
  return recent.slice(0, maximumMeshRecentModels).filter((target) => {
    if (!providers.some((provider) => provider.id === target.providerId)) return false;
    const models = snapshot.models[target.providerId] ?? [];
    if (models.length && !models.some((model) => model.id === target.modelId)) return false;
    const label = meshTargetModelLabel(snapshot, target);
    return [label, label.replace(/^[^:]+:\s*/u, ""), target.modelId ?? "", target.modelId?.split("/").at(-1) ?? ""]
      .some((name) => name.toLocaleLowerCase().startsWith(prefix));
  });
}

function MeshModelPicker({ snapshot, provider, existing, initial, onHydrateProviderModels, onCommit, onBack, onClose }: {
  snapshot: DesktopSnapshot;
  provider: Provider;
  existing?: MeshTarget;
  initial?: MeshTarget;
  onHydrateProviderModels: ComposerProps["onHydrateProviderModels"];
  onCommit: (target: MeshTarget) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const models = snapshot.models[provider.id] ?? [];
  const visibleModels = models.filter((model) => modelMatchesCatalogQuery(query, provider.id, provider.name, model));
  const startingTarget = existing ?? initial;
  const currentSelection = startingTarget
    ? { ...(startingTarget.modelId ? { modelId: startingTarget.modelId } : {}), ...(startingTarget.reasoningEffort ? { reasoningEffort: startingTarget.reasoningEffort } : {}) }
    : {};
  const resolved = resolveConcreteModelSelection(models, currentSelection);
  // Preserve an explicit existing choice while an uncached provider catalogue
  // is loading. Once models arrive, the reconciliation effect below either
  // keeps that choice or adopts the provider's current default.
  const [modelId, setModelId] = useState(startingTarget?.modelId ?? resolved?.modelId ?? "");
  const [effort, setEffort] = useState(startingTarget?.reasoningEffort ?? resolved?.reasoningEffort ?? "");
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [catalogueLoading, setCatalogueLoading] = useState(false);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const chosenModel = models.find((model) => model.id === modelId) ?? models.find((model) => model.isDefault) ?? models[0];
  const efforts = (chosenModel?.efforts ?? []).filter((item) => !isAmbiguousSelectionValue(item));
  const chooseModel = (nextModelId: string) => {
    setModelId(nextModelId);
    // The effort must always belong to the model it will be sent with.
    setEffort(resolveConcreteModelSelection(models, { modelId: nextModelId })?.reasoningEffort ?? "");
  };
  const commit = () => {
    onCommit({ providerId: provider.id, ...(modelId ? { modelId } : {}), ...(effort ? { reasoningEffort: effort } : {}) });
  };
  useEffect(() => {
    let active = true;
    setCatalogueLoading(true);
    setCatalogueError(null);
    void onHydrateProviderModels(provider.id).catch((error: unknown) => {
      if (active) setCatalogueError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setCatalogueLoading(false);
    });
    return () => { active = false; };
  }, [catalogueRevision, onHydrateProviderModels, provider.id]);
  useEffect(() => {
    if (!chosenModel) return;
    if (modelId !== chosenModel.id) {
      setModelId(chosenModel.id);
      setEffort(resolveConcreteModelSelection(models, { modelId: chosenModel.id })?.reasoningEffort ?? "");
      return;
    }
    if (effort && !efforts.includes(effort)) setEffort(chosenModel.defaultEffort ?? efforts[0] ?? "");
  }, [chosenModel, effort, efforts, modelId, models]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const list = panel.current?.querySelector<HTMLElement>(".mesh-model-picker-scroll");
    if (list) list.scrollTop = 0;
  }, [query]);
  const navigateRadios = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target === search.current) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const modelButtons = panel.current?.querySelectorAll<HTMLButtonElement>('.mesh-model-picker-scroll button[role="radio"]');
      const next = event.key === "ArrowDown" ? modelButtons?.[0] : modelButtons?.[modelButtons.length - 1];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.click();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const radios = [...(panel.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)') ?? [])];
    if (!radios.length) return;
    event.preventDefault();
    const current = Math.max(0, radios.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? radios.length - 1
        : (current + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + radios.length) % radios.length;
    radios[next]!.focus();
    radios[next]!.click();
  };
  return <div ref={panel} className="mesh-model-picker" role="dialog" aria-label={`Choose model for ${provider.name}`} onKeyDown={navigateRadios}>
    <header><button type="button" aria-label="Back to mesh targets" onClick={onBack}><ChevronRightIcon /></button><span className="mesh-model-picker-title"><ProviderLogo providerId={provider.id} provider={provider} size={24}/><span><strong>{provider.name}</strong><small>Model and reasoning</small></span></span><button type="button" aria-label="Close model picker" onClick={onClose}><XIcon /></button></header>
    <label className="model-catalog-search mesh-model-picker-search"><SearchIcon /><input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label={`Search models for ${provider.name}`} /></label>
    <div className="mesh-model-picker-scroll">
      {catalogueLoading ? <p className="mesh-catalogue-status" role="status"><span className="spinner" />Refreshing models…</p> : null}
      {catalogueError ? <div className="mesh-catalogue-error" role="alert" title={catalogueError}><span>Couldn’t refresh models. Showing the last loaded choices.</span><button type="button" onClick={() => setCatalogueRevision((current) => current + 1)}>Try again</button></div> : null}
      {visibleModels.length ? <section><h4>Model</h4>{visibleModels.map((model) => {
        const source = model.sourceProviderName || model.endpointName || model.sourceProviderId || provider.name;
        return <button type="button" role="radio" aria-checked={model.id === modelId} key={model.id} className={model.id === modelId ? "selected" : ""} title={`${model.name} · ${source}`} aria-label={`${model.name} · ${source}`} onClick={() => chooseModel(model.id)}><span><strong>{model.name}</strong><small className="mesh-model-source">{source}</small></span><span className="mesh-row-meta">{model.id === modelId ? <CheckIcon /> : null}</span></button>;
      })}</section> : models.length ? <div className="mesh-model-empty" role="status"><strong>No matching models</strong><small>Try another model name.</small></div> : <div className="mesh-model-empty"><strong>Harness default model</strong><small>This coding tool does not expose model choices.</small></div>}
    </div>
    {efforts.length ? <section className="mesh-model-picker-reasoning" aria-label={`Reasoning for ${chosenModel?.name ?? provider.name}`}><span className="mesh-model-picker-reasoning-title"><strong>Reasoning</strong><small>{chosenModel?.name}</small></span><div className="mesh-model-picker-reasoning-options" role="radiogroup" aria-label="Reasoning effort">{efforts.map((value) => <button type="button" role="radio" aria-checked={value === effort} key={value} className={value === effort ? "selected" : ""} onClick={() => setEffort(value)}><span>{reasoningLabel(value, { providerId: provider.id, modelId, displayName: chosenModel?.name })}</span>{value === effort ? <CheckIcon /> : null}</button>)}</div></section> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={catalogueLoading || (models.length > 0 && !modelId)} onClick={commit}>{existing ? "Save target" : "Add to mesh"}</button></footer>
  </div>;
}

function MeshPanel({ snapshot, options, targets, selections, activeIndex, listId, onHighlight, onSelect, onDetails, onClose }: {
  snapshot: DesktopSnapshot;
  options: readonly Provider[];
  targets: readonly MeshTarget[];
  selections: ReadonlyMap<Session["providerId"], MeshTarget>;
  activeIndex: number;
  listId: string;
  onHighlight: (index: number) => void;
  onSelect: (target: MeshTarget) => void;
  onDetails: (providerId: Session["providerId"]) => void;
  onClose: () => void;
}) {
  const room = targets.length < maximumMeshTargets;
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rows.current?.querySelector<HTMLElement>(`[data-mesh-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  return <section className="mesh-panel" role="dialog" aria-label="Mesh delegation">
    {/* One row, not two. The command palette already named /mesh and described it
        while the user typed, so the panel carries only its list heading and the
        close control; the dialog keeps its accessible name from aria-label. */}
    <header className="mesh-panel-header">
      <span className="mesh-add-label">Reference coding tool</span>
      <button type="button" aria-label="Close mesh panel" onClick={onClose}><XIcon /></button>
    </header>
    {options.length && room ? <div ref={rows} className="mesh-add" id={listId} role="listbox" aria-label="Available coding tools">
      {options.map((provider, index) => {
        const target = selections.get(provider.id) ?? { providerId: provider.id };
        const modelLabel = meshTargetModelLabel(snapshot, target);
        const effortLabel = reasoningLabel(target.reasoningEffort ?? "", { providerId: provider.id, modelId: target.modelId, displayName: modelLabel }) || "No reasoning control";
        return <div id={`${listId}-${index}`} data-mesh-index={index} className={`mesh-add-row ${index === activeIndex ? "selected" : ""}`} role="option" aria-selected={index === activeIndex} key={provider.id} onPointerMove={() => onHighlight(index)}>
          <button type="button" className="mesh-add-select" aria-label={`Select ${provider.name} with ${modelLabel}, ${effortLabel}`} onFocus={() => onHighlight(index)} onClick={() => onSelect(target)}><ProviderLogo providerId={provider.id} provider={provider} size={25}/><span><strong>{provider.name}</strong><small>{modelLabel} · {effortLabel}</small></span></button>
          <button type="button" className="mesh-add-details" aria-label={`Choose model and reasoning for ${provider.name}`} title="Choose model and reasoning" onFocus={() => onHighlight(index)} onClick={() => onDetails(provider.id)}><ChevronRightIcon /></button>
        </div>;
      })}
    </div> : null}
    {!options.length || !room ? <div className="mesh-panel-empty">
      <strong>{!room ? "Four subagents are already referenced" : "No other coding tool is ready"}</strong>
      <small>{targets.length ? "Write the instruction below and send it to them." : "Connect another tool before meshing."}</small>
    </div> : null}
  </section>;
}

function MeshMentionPanel({ snapshot, options, emptyMessage, activeIndex, listId, onHighlight, onSelect, onClose }: {
  snapshot: DesktopSnapshot;
  options: readonly MeshTarget[];
  emptyMessage: string;
  activeIndex: number;
  listId: string;
  onHighlight: (index: number) => void;
  onSelect: (target: MeshTarget) => void;
  onClose: () => void;
}) {
  const rows = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rows.current?.querySelector<HTMLElement>(`[data-mesh-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, options]);
  return <section className="mesh-panel mesh-mention-panel" role="dialog" aria-label="Recent mesh models">
    <header className="mesh-panel-header"><span className="mesh-add-label">Recent mesh models</span><button type="button" aria-label="Close recent models" onClick={onClose}><XIcon /></button></header>
    <div ref={rows} className="mesh-add" id={listId} role="listbox" aria-label="Recent mesh models">
      {options.map((target, index) => {
        const provider = providerFor(snapshot.providers, target.providerId)!;
        const modelLabel = meshTargetModelLabel(snapshot, target);
        const effort = reasoningLabel(target.reasoningEffort ?? "", { providerId: target.providerId, modelId: target.modelId, displayName: modelLabel });
        return <div id={`${listId}-${index}`} data-mesh-index={index} className={`mesh-add-row mesh-mention-row ${index === activeIndex ? "selected" : ""}`} role="option" aria-selected={index === activeIndex} key={`${target.providerId}:${target.modelId}`} onPointerMove={() => onHighlight(index)}>
          <button type="button" className="mesh-add-select" aria-label={`Tag ${modelLabel} via ${provider.name}${effort ? `, ${effort}` : ""}`} onMouseDown={(event) => event.preventDefault()} onFocus={() => onHighlight(index)} onClick={() => onSelect(target)}><ProviderLogo providerId={provider.id} provider={provider} size={25}/><span><strong>{modelLabel}</strong><small>{provider.name}{effort ? ` · ${effort}` : ""}</small></span></button>
        </div>;
      })}
    </div>
    {!options.length ? <div className="mesh-panel-empty" role="status"><strong>{emptyMessage}</strong></div> : null}
  </section>;
}

function DelegationPicker({ snapshot, session, parentModelId, parentReasoningEffort, request, onHydrateProviderModels, initialDraft, onDraftChange, onClose, notify }: {
  snapshot: DesktopSnapshot;
  session: Session;
  parentModelId: string;
  parentReasoningEffort: string;
  request: Request;
  onHydrateProviderModels: ComposerProps["onHydrateProviderModels"];
  initialDraft?: DelegationDraft | undefined;
  onDraftChange?: (draft: DelegationDraft | null) => void;
  onClose: (restoreFocus?: boolean) => void;
  notify: ComposerProps["notify"];
}) {
  const root = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      const focusOwner = event.target instanceof Element
        ? event.target.closest('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])')
        : null;
      closeRef.current(focusOwner === null);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("mousedown", closeOutside, true);
    document.addEventListener("keydown", closeEscape, true);
    return () => {
      document.removeEventListener("mousedown", closeOutside, true);
      document.removeEventListener("keydown", closeEscape, true);
    };
  }, []);
  const options = snapshot.providers.filter((provider) => provider.id !== session.providerId && provider.state === "online" && provider.capabilities.includes("Create Session") && provider.capabilities.includes("Send Message"));
  // One delegate, not a set. Multi-select read as "fan this out", which is not what
  // the surrounding copy promises and not what a reader expects from one dialog.
  const initialProviderId = initialDraft?.providerId && options.some((provider) => provider.id === initialDraft.providerId)
    ? initialDraft.providerId
    : options[0]?.id ?? null;
  const [selected, setSelected] = useState<Session["providerId"] | null>(initialProviderId);
  const models = selected ? snapshot.models[selected] ?? [] : [];
  const [modelId, setModelId] = useState<string>(initialDraft?.modelId ?? "");
  const [effort, setEffort] = useState<string>(initialDraft?.effort ?? "");
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [loadingProviderId, setLoadingProviderId] = useState<Session["providerId"] | null>(null);
  const [catalogueError, setCatalogueError] = useState<{ providerId: Session["providerId"]; message: string } | null>(null);
  const activeModel = models.find((model) => model.id === modelId) ?? models.find((model) => model.isDefault) ?? models[0];
  const efforts = activeModel?.efforts ?? [];
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onDraftChange?.({ providerId: selected, modelId, effort, prompt });
  }, [effort, modelId, onDraftChange, prompt, selected]);
  const choose = (providerId: Session["providerId"]) => {
    setSelected(providerId);
    setModelId("");
    setEffort("");
  };
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const providerId = selected;
    setLoadingProviderId(providerId);
    setCatalogueError(null);
    void onHydrateProviderModels(providerId).then(() => {
      if (active) setLoadingProviderId(null);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoadingProviderId(null);
      setCatalogueError({ providerId, message: error instanceof Error ? error.message : String(error) });
    });
    return () => { active = false; };
  }, [catalogueRevision, onHydrateProviderModels, selected]);
  const selectedProvider = selected ? options.find((provider) => provider.id === selected) : undefined;
  const catalogueLoading = loadingProviderId === selected;
  const selectedCatalogueError = catalogueError?.providerId === selected ? catalogueError : null;
  useEffect(() => {
    if (!activeModel) return;
    // Keep a still-valid explicit choice. If a refreshed catalogue removed it,
    // adopt the provider's current default instead of sending a stale id/effort.
    if (modelId !== activeModel.id) setModelId(activeModel.id);
    if (effort && !activeModel.efforts.includes(effort)) {
      setEffort(activeModel.defaultEffort ?? activeModel.efforts[0] ?? "");
    }
  }, [activeModel, effort, modelId]);
  return <section ref={root} className="chat-picker delegation-chat-picker" role="dialog" aria-label="Delegate task">
    <header><span><strong>Delegate a task</strong><small>Create a grouped child task with another coding tool</small></span><button type="button" aria-label="Close delegation" onClick={() => onClose()}><XIcon /></button></header>
    <div className="delegation-cli-options" role="radiogroup" aria-label="Coding tool">{options.map((provider) => <button type="button" role="radio" key={provider.id} className={selected === provider.id ? "selected" : ""} aria-checked={selected === provider.id} onClick={() => choose(provider.id)}><ProviderLogo providerId={provider.id} provider={provider} size={27}/><span><strong>{provider.name}</strong><small>New child task</small></span>{selected === provider.id ? <CheckIcon /> : null}</button>)}</div>
    {selected && (models.length || efforts.length) ? <div className="delegation-tuning">
      {models.length ? <label><span>Model</span><select aria-label="Delegation model" value={activeModel?.id ?? ""} onChange={(event) => { setModelId(event.target.value); setEffort(""); }}>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label> : null}
      {efforts.length ? <label><span>Reasoning</span><select aria-label="Delegation reasoning" value={effort || activeModel?.defaultEffort || efforts[0] || ""} onChange={(event) => setEffort(event.target.value)}>{efforts.map((value) => <option key={value} value={value}>{reasoningLabel(value, { providerId: selected ?? undefined, modelId: activeModel?.id, displayName: activeModel?.name })}</option>)}</select></label> : null}
    </div> : null}
    {catalogueLoading ? <p className="delegation-catalogue-status" role="status"><span className="spinner" />Refreshing {selectedProvider?.name ?? "coding tool"} models…</p> : null}
    {selectedCatalogueError ? <div className="delegation-catalogue-error" role="alert" title={selectedCatalogueError.message}><span>Couldn’t refresh {selectedProvider?.name ?? "coding tool"} models. Showing the last loaded choices.</span><button type="button" onClick={() => setCatalogueRevision((current) => current + 1)}>Try again</button></div> : null}
    {options.length ? <textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Give it an instruction…" rows={3}/> : <div className="chat-picker-empty"><strong>No other coding tool is ready</strong><small>Connect another tool before delegating.</small></div>}
    <footer><button type="button" onClick={() => onClose()}>Cancel</button><button className="primary" type="button" disabled={!prompt.trim() || !selected || busy} onClick={async () => { setBusy(true); try { const submittedPrompt = prompt.trim(); const chosenEffort = effort || activeModel?.defaultEffort || ""; await request("delegation.prepare", { parentSessionId: session.id, prompt: submittedPrompt, targets: [{ providerId: selected, ...(activeModel ? { modelId: activeModel.id } : {}), ...(chosenEffort ? { reasoningEffort: chosenEffort } : {}) }], presentationSegments: meshPresentationSegments(submittedPrompt, 1), ...(parentModelId ? { modelId: parentModelId } : {}), ...(parentReasoningEffort ? { reasoningEffort: parentReasoningEffort } : {}) }); onDraftChange?.(null); notify("Delegated task started"); onClose(); } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } }}><AgentIcon /> Delegate</button></footer>
  </section>;
}

function providerFor(providers: readonly Provider[], id: string): Provider | undefined {
  return providers.find((provider) => provider.id === id);
}

function isSelectedFile(attachment: ComposerAttachment): attachment is SelectedFile {
  return !isPreparingAttachment(attachment) && "kind" in attachment && attachment.kind === "file";
}

function isComposerFileAttachment(attachment: ComposerAttachment): boolean {
  return isPreparingAttachment(attachment) ? attachment.attachmentKind === "file" : isSelectedFile(attachment);
}

/** Builds the stable user presentation before attachment work or provider IPC. */
function optimisticComposerTimelineItem(
  id: string,
  timestamp: string,
  content: string,
  submitted: ComposerDraftSnapshot,
): TimelineItem {
  const images: NonNullable<TimelineItem["images"]> = [];
  const audio: NonNullable<TimelineItem["audio"]> = [];
  const files: NonNullable<TimelineItem["files"]> = [];
  for (const attachment of submitted.attachments) {
    if (isPreparingAttachment(attachment)) {
      if (attachment.attachmentKind === "file") files.push({ name: attachment.name, mimeType: attachment.mimeType });
      else images.push({ name: attachment.name, mimeType: attachment.mimeType, loading: true });
      continue;
    }
    if (isSelectedFile(attachment)) {
      files.push({ name: attachment.name, mimeType: attachment.mimeType });
      continue;
    }
    if (isSelectedAudio(attachment)) {
      audio.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
        durationSeconds: attachment.durationSeconds,
        dictation: isDictationAudioAttachment(attachment),
      });
      continue;
    }
    images.push({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}` });
  }
  const annotations = submitted.annotations.map(({ id: annotationId, text, annotation, audio: annotationAudio }) => ({
    id: annotationId,
    text,
    annotation,
    ...(annotationAudio ? { audio: {
      name: annotationAudio.name,
      mimeType: annotationAudio.mimeType,
      dataUrl: `data:${annotationAudio.mimeType};base64,${annotationAudio.dataBase64}`,
      durationSeconds: annotationAudio.durationSeconds,
      dictation: true,
    } } : {}),
  }));
  const annotationAudioPaths = new Set(submitted.annotations.flatMap((annotation) => annotation.audio ? [annotation.audio.path] : []));
  const visibleAudio = audio.filter((item) => !submitted.attachments.some((attachment) => isSelectedAudio(attachment)
    && attachment.name === item.name && annotationAudioPaths.has(attachment.path)));
  const workflows = submitted.workflowAttachments.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    eventCount: workflow.summary.eventCount,
    screenshotCount: workflow.summary.screenshotCount,
    ...(workflow.summary.apps.length ? { applications: [...workflow.summary.apps] } : {}),
  }));
  return {
    id,
    presentationId: id,
    kind: "user",
    body: content,
    ...(annotations.length ? { annotations } : {}),
    ...(images.length ? { images } : {}),
    ...(visibleAudio.length ? { audio: visibleAudio } : {}),
    ...(files.length ? { files } : {}),
    ...(workflows.length ? { workflows } : {}),
    timestamp,
    state: "completed",
  };
}

let preparingAttachmentSequence = 0;

function prepareDroppedAttachment(
  file: File,
  attachmentKind: PreparingComposerAttachment["attachmentKind"],
  origin: PreparingComposerAttachment["origin"],
  fallbackName: string,
): PreparingComposerAttachment {
  const name = file.name || fallbackName;
  const path = `${origin}:${Date.now()}:${++preparingAttachmentSequence}:${name}`;
  let preparation: Promise<UploadableAttachment> | undefined;
  return {
    preparing: true,
    attachmentKind,
    name,
    path,
    mimeType: file.type.split(";")[0] || (attachmentKind === "image" ? "image/png" : "application/octet-stream"),
    byteLength: file.size,
    origin,
    ...(attachmentKind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
    // Rejected fifth/over-budget items never enter the draft, so they must not
    // start a worker job. The first accepted-draft consumer starts one shared
    // preparation promise; task switching can safely attach to that same job.
    preparation: () => preparation ??= blobToUploadable(file, name),
  };
}

function finishPreparingAttachment(
  attachment: PreparingComposerAttachment,
  uploadable: UploadableAttachment,
): ReadyComposerAttachment {
  const base = {
    ...uploadable,
    path: attachment.path,
    origin: attachment.origin,
    ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
  };
  return attachment.attachmentKind === "file" ? { ...base, kind: "file" } : base;
}

async function resolveComposerAttachments(attachments: readonly ComposerAttachment[]): Promise<readonly ReadyComposerAttachment[]> {
  return await Promise.all(attachments.map(async (attachment) => isPreparingAttachment(attachment)
    ? finishPreparingAttachment(attachment, await attachment.preparation())
    : attachment));
}

/**
 * Attachment bytes are deliberately outside the composer's keystroke render.
 * Building a data URL concatenates the complete base64 payload; doing that from
 * the inline attachment map rebuilt a multi-megabyte string for every typed
 * character. Pasted/dropped images keep their Blob URL, while this memoized
 * leaf builds a data URL only once for picker attachments that have no Blob.
 */
const ComposerAttachmentChip = memo(function ComposerAttachmentChip({ attachment, onPreview, onRemove }: {
  attachment: ComposerAttachment;
  onPreview: (attachment: { readonly name: string; readonly dataUrl: string }) => void;
  onRemove: (path: string) => void;
}) {
  const dataUrl = useMemo(() => {
    if (isPreparingAttachment(attachment)) return attachment.previewUrl ?? null;
    if (isSelectedFile(attachment)) return null;
    return attachment.previewUrl ?? `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
  }, [attachment]);
  if (isPreparingAttachment(attachment)) {
    if (attachment.attachmentKind === "file") {
      return <span className="file-attachment-chip"><FileIcon /><span><strong>{attachment.name}</strong><small>Preparing…</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.path)}><XIcon /></button></span>;
    }
    return <span className="image-attachment-chip"><button type="button" className="attachment-thumbnail" title={`Preview ${attachment.name}`} aria-label={`Preview ${attachment.name}`} onClick={() => { if (dataUrl) onPreview({ name: attachment.name, dataUrl }); }}><img src={dataUrl ?? ""} alt=""/></button><span><strong>{attachment.name}</strong><small>Preparing…</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.path)}><XIcon /></button></span>;
  }
  if (isSelectedAudio(attachment)) {
    return <AudioPlaybackChip name={attachment.name} dataUrl={dataUrl ?? ""} dictation={isDictationAudioAttachment(attachment)} durationSeconds={attachment.durationSeconds} onRemove={() => onRemove(attachment.path)} />;
  }
  if (isSelectedFile(attachment)) {
    return <span className="file-attachment-chip"><FileIcon /><span><strong>{attachment.name}</strong><small>{Math.ceil(attachment.byteLength / 1024)} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.path)}><XIcon /></button></span>;
  }
  return <span className="image-attachment-chip"><button type="button" className="attachment-thumbnail" title={`Preview ${attachment.name}`} aria-label={`Preview ${attachment.name}`} onClick={() => { if (dataUrl) onPreview({ name: attachment.name, dataUrl }); }}><img src={dataUrl ?? ""} alt=""/></button><span><strong>{attachment.name}</strong><small>{Math.ceil(attachment.byteLength / 1024)} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.path)}><XIcon /></button></span>;
});

export function supportsGenericFileAttachments(providerId: string): boolean {
  return providerId === "opencode";
}

const PROMPT_HISTORY_KEY = "tethoq:prompt-history";
const MAX_PROMPT_HISTORY_ITEMS = 50;
const MAX_PROMPT_HISTORY_ENTRY_CHARS = 20_000;
const MAX_PROMPT_HISTORY_TOTAL_CHARS = 100_000;

export function boundedPromptHistory(values: readonly unknown[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  for (const value of values) {
    if (typeof value !== "string" || !value || value.length > MAX_PROMPT_HISTORY_ENTRY_CHARS || seen.has(value)) continue;
    if (result.length >= MAX_PROMPT_HISTORY_ITEMS || totalChars + value.length > MAX_PROMPT_HISTORY_TOTAL_CHARS) break;
    result.push(value);
    seen.add(value);
    totalChars += value.length;
  }
  return result;
}

function storedPromptHistory(): readonly string[] {
  try {
    if (typeof globalThis.localStorage === "undefined") return [];
    const value = JSON.parse(globalThis.localStorage.getItem(PROMPT_HISTORY_KEY) ?? "[]") as unknown;
    return boundedPromptHistory(Array.isArray(value) ? value : []);
  } catch {
    return [];
  }
}

function rememberPrompt(prompt: string, current: readonly string[]): readonly string[] {
  const next = boundedPromptHistory([prompt, ...current]);
  try { globalThis.localStorage?.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next)); }
  catch { /* Prompt history is optional in restricted renderer contexts. */ }
  return next;
}

export interface QueuedMessageView {
  readonly id: string;
  readonly content: string;
  readonly state: "queued" | "sending" | "failed";
  readonly attachmentCount: number;
  readonly attachments: readonly QueuedAttachmentView[];
  readonly retryable?: boolean;
  readonly error?: string;
}

export interface QueuedAttachmentView {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly dataUrl?: string;
  readonly durationSeconds?: number;
}

// Keep local thumbnails in renderer memory only. Queue history intentionally
// exposes metadata without large attachment bytes, so a remount can reuse a
// preview only when this renderer actually selected the image or audio source.
const queuedAttachmentPreviewCache = new Map<string, readonly QueuedAttachmentView[]>();
const queuedAttachmentPreviewOwners = new Map<string, string>();

function queuedAttachment(value: unknown): QueuedAttachmentView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attachment = value as Record<string, unknown>;
  const name = typeof attachment.name === "string" && attachment.name.trim() ? attachment.name.trim() : "Attachment";
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream";
  const byteLength = typeof attachment.byteLength === "number" && Number.isFinite(attachment.byteLength) ? Math.max(0, attachment.byteLength) : 0;
  const previewable = /^(?:image|audio)\/[a-z0-9.+-]+$/iu.test(mimeType);
  const inlineData = typeof attachment.dataBase64 === "string" && previewable && /^[a-z0-9+/]*={0,2}$/iu.test(attachment.dataBase64)
    ? `data:${mimeType};base64,${attachment.dataBase64}`
    : undefined;
  const retainedData = typeof attachment.dataUrl === "string" && previewable && new RegExp(`^data:${mimeType.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")};base64,[a-z0-9+/]*={0,2}$`, "iu").test(attachment.dataUrl)
    ? attachment.dataUrl
    : undefined;
  const dataUrl = inlineData ?? retainedData;
  const durationSeconds = typeof attachment.durationSeconds === "number" && Number.isFinite(attachment.durationSeconds) && attachment.durationSeconds > 0
    ? attachment.durationSeconds
    : undefined;
  return {
    name,
    mimeType,
    byteLength,
    ...(dataUrl ? { dataUrl } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

function mergeQueuedAttachmentPreviews(message: QueuedMessageView): QueuedMessageView {
  const cached = queuedAttachmentPreviewCache.get(message.id);
  if (!cached?.length) return message;
  return {
    ...message,
    attachments: message.attachments.map((attachment, index) => {
      const preview = cached[index];
      if (!preview || preview.name !== attachment.name || preview.mimeType !== attachment.mimeType) return attachment;
      return {
        ...attachment,
        ...(attachment.dataUrl === undefined && preview.dataUrl !== undefined ? { dataUrl: preview.dataUrl } : {}),
        ...(attachment.durationSeconds === undefined && preview.durationSeconds !== undefined ? { durationSeconds: preview.durationSeconds } : {}),
      };
    }),
  };
}

function rememberQueuedAttachmentPreviews(message: QueuedMessageView, sources: readonly ReadyComposerAttachment[], sessionId: string): void {
  if (!sources.length || !message.attachments.length) return;
  const unused = [...sources];
  const attachments = message.attachments.map((attachment) => {
    const index = unused.findIndex((source) => source.name === attachment.name && source.mimeType === attachment.mimeType && source.byteLength === attachment.byteLength);
    if (index < 0) return attachment;
    const [source] = unused.splice(index, 1);
    const previewable = source!.mimeType.toLowerCase().startsWith("image/") || source!.mimeType.toLowerCase().startsWith("audio/");
    return {
      ...attachment,
      ...(previewable ? { dataUrl: `data:${source!.mimeType};base64,${source!.dataBase64}` } : {}),
      ...("durationSeconds" in source! && typeof source!.durationSeconds === "number" ? { durationSeconds: source!.durationSeconds } : {}),
    };
  });
  if (!attachments.some((attachment, index) => attachment !== message.attachments[index])) return;
  queuedAttachmentPreviewCache.set(message.id, attachments);
  queuedAttachmentPreviewOwners.set(message.id, sessionId);
}

function forgetMissingQueuedAttachmentPreviews(sessionId: string, messages: readonly QueuedMessageView[]): void {
  const retained = new Set(messages.map((message) => message.id));
  for (const [messageId, owner] of queuedAttachmentPreviewOwners) {
    if (owner !== sessionId || retained.has(messageId)) continue;
    queuedAttachmentPreviewOwners.delete(messageId);
    queuedAttachmentPreviewCache.delete(messageId);
  }
}

export function queuedMessagesForSession(value: unknown, sessionId: string): readonly QueuedMessageView[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const message = candidate as Record<string, unknown>;
    if (typeof message.id !== "string" || message.sessionId !== sessionId || typeof message.content !== "string") return [];
    if (message.state !== "queued" && message.state !== "sending" && message.state !== "failed") return [];
    const attachments = Array.isArray(message.attachments) ? message.attachments.flatMap((attachment) => {
      const parsed = queuedAttachment(attachment);
      return parsed ? [parsed] : [];
    }) : [];
    const view: QueuedMessageView = {
      id: message.id,
      content: message.content,
      state: message.state,
      attachmentCount: attachments.length,
      attachments,
      retryable: message.retryable !== false,
      ...(typeof message.error === "string" && message.error.trim() ? { error: message.error } : {}),
    };
    if (attachments.some((attachment) => attachment.dataUrl)) {
      queuedAttachmentPreviewCache.set(view.id, attachments);
      queuedAttachmentPreviewOwners.set(view.id, sessionId);
    }
    return [mergeQueuedAttachmentPreviews(view)];
  });
}

export function queuedMessagePreview(content: string): string {
  const preview = content.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
  if (!preview) return "Queued instruction";
  return preview.length > 180 ? `${preview.slice(0, 177).trimEnd()}…` : preview;
}

/** Moves one queued instruction into the transcript without waiting for steer acknowledgement. */
function optimisticQueuedSteerTimelineItem(message: QueuedMessageView, id: string, timestamp: string): TimelineItem {
  // An upload acknowledgement contains metadata only. Steer can be clicked
  // before the background queue refresh merges the locally retained preview.
  message = mergeQueuedAttachmentPreviews(message);
  const images = message.attachments
    .filter((attachment) => attachment.mimeType.toLowerCase().startsWith("image/"))
    .map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
    }));
  const audio = message.attachments
    .filter((attachment) => attachment.mimeType.toLowerCase().startsWith("audio/") && attachment.dataUrl)
    .map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      dataUrl: attachment.dataUrl!,
      ...(attachment.durationSeconds !== undefined ? { durationSeconds: attachment.durationSeconds } : {}),
    }));
  const files = message.attachments
    .filter((attachment) => !attachment.mimeType.toLowerCase().startsWith("image/")
      && (!attachment.mimeType.toLowerCase().startsWith("audio/") || !attachment.dataUrl))
    .map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType }));
  return {
    id,
    presentationId: id,
    kind: "user",
    body: message.content,
    ...(images.length ? { images } : {}),
    ...(audio.length ? { audio } : {}),
    ...(files.length ? { files } : {}),
    timestamp,
    state: "completed",
  };
}

function hasCanonicalComposerEcho(timeline: readonly TimelineItem[], presentationId: string): boolean {
  return timeline.some((item) => item.kind === "user"
    && item.presentationId === presentationId
    && item.id !== presentationId);
}

function QueueGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h11M5 12h8M5 17h5"/><path d="m15 14 4 3-4 3"/></svg>;
}

function QueuedAttachmentWidget({ attachment }: { attachment: QueuedAttachmentView }) {
  const image = attachment.mimeType.toLowerCase().startsWith("image/");
  const audio = attachment.mimeType.toLowerCase().startsWith("audio/");
  if (image && attachment.dataUrl) {
    return <span className="queued-attachment-widget queued-attachment-image" title={attachment.name}><img src={attachment.dataUrl} alt={attachment.name}/></span>;
  }
  if (audio && attachment.dataUrl) {
    return <AudioPlaybackChip className="queued-attachment-audio" name={attachment.name} dataUrl={attachment.dataUrl} durationSeconds={attachment.durationSeconds}/>;
  }
  return <span className={`queued-attachment-widget queued-attachment-${image ? "image-fallback" : audio ? "audio-fallback" : "file"}`} title={attachment.name}>
    {image ? <ScreenshotIcon/> : <FileIcon/>}<span>{attachment.name}</span>
  </span>;
}

function ComposerSurfaceOutline() {
  const ref = useRef<SVGSVGElement>(null);
  const [geometry, setGeometry] = useState({ width: 1, height: 1, shelfHeight: 39, shelfWidth: 340 });
  useLayoutEffect(() => {
    const svg = ref.current;
    const box = svg?.parentElement;
    const shelf = box?.querySelector<HTMLElement>(".composer-footer");
    if (!svg || !box || !shelf || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const boxBounds = box.getBoundingClientRect();
      const shelfBounds = shelf.getBoundingClientRect();
      setGeometry({
        width: Math.max(1, Math.round(boxBounds.width)),
        height: Math.max(1, Math.round(boxBounds.height)),
        shelfHeight: Math.max(1, Math.round(shelfBounds.height)),
        shelfWidth: Math.max(1, Math.min(Math.round(shelfBounds.width), Math.round(boxBounds.width - 42))),
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(shelf);
    measure();
    return () => observer.disconnect();
  }, []);
  const { width, height, shelfHeight, shelfWidth } = geometry;
  const totalHeight = height + shelfHeight;
  const shelfLeft = Math.max(42, width - shelfWidth);
  const curveStart = Math.max(18, shelfLeft - 18);
  const curveControl = 7;
  const radius = Math.min(15, height / 2);
  const path = [
    `M ${radius} ${shelfHeight}`,
    `H ${curveStart}`,
    `C ${curveStart + curveControl} ${shelfHeight} ${shelfLeft - curveControl} 0 ${shelfLeft} 0`,
    `H ${width - radius}`,
    `Q ${width} 0 ${width} ${radius}`,
    `V ${totalHeight - radius}`,
    `Q ${width} ${totalHeight} ${width - radius} ${totalHeight}`,
    `H ${radius}`,
    `Q 0 ${totalHeight} 0 ${totalHeight - radius}`,
    `V ${shelfHeight + radius}`,
    `Q 0 ${shelfHeight} ${radius} ${shelfHeight}`,
    "Z",
  ].join(" ");
  return <svg ref={ref} className="composer-surface-outline" viewBox={`0 0 ${width} ${totalHeight}`} preserveAspectRatio="none" style={{ top: -shelfHeight, height: totalHeight }} aria-hidden="true"><path d={path} vectorEffect="non-scaling-stroke"/></svg>;
}

function QueuedMessageRow({ message, busy, canSteer, queueingEnabled, onSteer, onRemove, onEdit, onSideChat, onNewTask, onToggleQueueing }: {
  message: QueuedMessageView;
  busy: boolean;
  canSteer: boolean;
  queueingEnabled: boolean;
  onSteer: () => Promise<void>;
  onRemove: () => Promise<void>;
  onEdit: () => Promise<void>;
  onSideChat: () => Promise<void>;
  onNewTask: () => void;
  onToggleQueueing: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const deliveryUnresolved = message.retryable === false;
  return <article className={`queued-message-row queued-message-${message.state}`} aria-label={`${deliveryUnresolved ? "Delivery unconfirmed" : "Queued instruction"}: ${queuedMessagePreview(message.content)}`} onContextMenu={(event) => {
    event.preventDefault();
    setMenuOpen(true);
  }}>
    <span className="queued-state" aria-hidden="true">{message.state === "sending" ? <span className="spinner"/> : deliveryUnresolved ? <InfoIcon/> : <QueueGlyph/>}</span>
    <div className="queued-message-content">{message.attachments.length ? <div className="queued-attachment-widgets">{message.attachments.map((attachment, index) => <QueuedAttachmentWidget key={`${attachment.name}-${attachment.mimeType}-${index}`} attachment={attachment}/>)}</div> : null}<strong>{queuedMessagePreview(message.content)}</strong>{deliveryUnresolved ? <small className="queued-delivery-status">Delivery unconfirmed</small> : null}</div>
    <div className="queued-message-actions">
      {canSteer ? <button type="button" className="queued-steer" disabled={busy || message.state === "sending" || deliveryUnresolved} aria-label="Steer with this queued instruction" data-tooltip="Steer" onClick={() => void onSteer()}><SendIcon/><span>Steer</span></button> : null}
      <button type="button" disabled={busy || message.state === "sending"} aria-label={deliveryUnresolved ? "Dismiss delivery notice" : "Remove queued instruction"} data-tooltip={deliveryUnresolved ? "Dismiss notice" : "Remove"} onClick={() => void onRemove()}><XIcon/></button>
      <Popover label="Queued instruction actions" className="queued-message-menu" open={menuOpen} onOpen={setMenuOpen} trigger={<MoreIcon/>}>
        <button type="button" role="menuitem" disabled={busy || message.state === "sending" || deliveryUnresolved} onClick={() => { setMenuOpen(false); void onEdit(); }}><SlidersIcon/><span><strong>Edit message</strong></span></button>
        <button type="button" role="menuitem" disabled={busy || deliveryUnresolved} onClick={() => { setMenuOpen(false); void onSideChat(); }}><ChatIcon/><span><strong>Open in side chat</strong></span></button>
        <button type="button" role="menuitem" disabled={busy || deliveryUnresolved} onClick={() => { setMenuOpen(false); onNewTask(); }}><BranchIcon/><span><strong>Send to new task</strong></span></button>
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onToggleQueueing(); }}><QueueGlyph/><span><strong>{queueingEnabled ? "Turn off queuing" : "Turn on queuing"}</strong></span></button>
      </Popover>
    </div>
  </article>;
}

function QueuedNewTaskPicker({ snapshot, sourceSession, message, agentDefaults, onClose, onSubmit }: {
  snapshot: DesktopSnapshot;
  sourceSession: Session;
  message: QueuedMessageView;
  agentDefaults: DesktopPreferencesState["agentDefaults"];
  onClose: () => void;
  onSubmit: (selection: DraftModelSelection) => Promise<boolean>;
}) {
  const entries = useMemo(() => usableQueueTaskEntries(snapshot), [snapshot]);
  const providers = useMemo(() => snapshot.providers.filter((provider) => entries.some((entry) => entry.provider.id === provider.id)), [entries, snapshot.providers]);
  const initialProvider = providers.find((provider) => provider.id === sourceSession.providerId) ?? providers[0];
  const initialSelection = initialProvider
    ? queuedTaskModelSelection(snapshot, initialProvider.id, sourceSession.model, agentDefaults)
    : null;
  const [providerFilter, setProviderFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState(initialSelection?.providerId ?? "");
  const [modelId, setModelId] = useState(initialSelection?.modelId ?? "");
  const [effort, setEffort] = useState(initialSelection?.effort ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);
  const visibleEntries = providerFilter === "all" ? entries : entries.filter((entry) => entry.provider.id === providerFilter);
  const selectedEntry = entries.find((entry) => entry.provider.id === providerId && entry.model.id === modelId);
  const efforts = selectedEntry?.model.efforts.filter((item) => !isAmbiguousSelectionValue(item)) ?? [];
  const choose = (entry: CatalogModel) => {
    const selection = queuedTaskModelSelection(snapshot, entry.provider.id, entry.model.id, agentDefaults);
    if (!selection) return;
    setProviderId(selection.providerId);
    setModelId(selection.modelId);
    setEffort(selection.effort);
  };
  const start = async () => {
    if (!providerId || !modelId || saving) return;
    setSaving(true);
    const completed = await onSubmit({ providerId, modelId, effort });
    if (completed) onClose();
    else setSaving(false);
  };
  return <div className="queue-new-task-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="queue-new-task-picker" role="dialog" aria-modal="true" aria-label="Send queued instruction to a new task">
      <header><span><strong>Send to new task</strong><small>{queuedMessagePreview(message.content)}</small></span><button type="button" aria-label="Close new task selection" disabled={saving} onClick={onClose}><XIcon/></button></header>
      {entries.length ? <>
        <div className="queue-new-task-tools">
          <label className="model-catalog-search"><SearchIcon/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models for new task"/></label>
          <label><span>Agent</span><select aria-label="Filter models by Agent" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">All Agents</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label>
        </div>
        <div className="queue-new-task-models"><ModelCatalogResults entries={visibleEntries} recentKeys={recentModelKeysFromUsage(snapshot.sessions, snapshot.models, storedRecentModelUses())} query={query} activeProviderId={providerId} selectedKey={selectedEntry?.key} allowProviderChange onChoose={choose}/></div>
        <div className="queue-new-task-selection">
          <span><small>Model</small><strong>{selectedEntry?.model.name ?? "Choose a model"}</strong></span>
          {efforts.length ? <label><small>Reasoning</small><select aria-label="Reasoning for new task" value={effort} onChange={(event) => setEffort(event.target.value)}>{efforts.map((item) => <option value={item} key={item}>{reasoningLabel(item, { providerId, modelId, displayName: selectedEntry?.model.name })}</option>)}</select></label> : null}
        </div>
      </> : <div className="chat-picker-empty"><strong>No Agent is ready to start a task</strong><small>Connect an Agent in Settings, then try again.</small></div>}
      <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={!selectedEntry || saving} onClick={() => void start()}>{saving ? <span className="spinner"/> : <BranchIcon/>} Start task</button></footer>
    </section>
  </div>;
}

// Side chats are seeded by copying the parent transcript so the provider has
// the task's context; the bridge marks those copies with a `:copied:` id. The
// panel keeps that context out of sight so the chat reads as fresh.
export function visibleSideChatTimeline(timeline: readonly TimelineItem[]): readonly TimelineItem[] {
  return timeline.filter((item) => !item.id.includes(":copied:") && item.messageId?.startsWith("copied:") !== true);
}

const SideChatAttachmentChip = memo(function SideChatAttachmentChip({ attachment, onRemove }: {
  attachment: SelectedImage;
  onRemove: (path: string) => void;
}) {
  const dataUrl = useMemo(() => `data:${attachment.mimeType};base64,${attachment.dataBase64}`, [attachment]);
  return <span><img src={dataUrl} alt=""/><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.path)}><XIcon/></button></span>;
});

// Below these sizes the composer and transcript stop being usable.
const sideChatMinimumWidth = 260;
const sideChatMinimumHeight = 180;

interface SideChatBounds { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

// The panel position is owned by the user, but the viewport is not: dragging
// or resizing can never push the panel off-screen.
function clampSideChatBounds(bounds: SideChatBounds): SideChatBounds {
  const width = Math.min(window.innerWidth, Math.max(bounds.width, sideChatMinimumWidth));
  const height = Math.min(window.innerHeight, Math.max(bounds.height, sideChatMinimumHeight));
  const left = Math.max(0, Math.min(bounds.left, Math.max(0, window.innerWidth - width)));
  const top = Math.max(0, Math.min(bounds.top, Math.max(0, window.innerHeight - height)));
  return { left, top, width, height };
}

interface SideChatTether {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly path: string | null;
  readonly mask: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}

export function SideChatPanel({ session, provider, timeline, request, selectImages, notify, draft, sending, onDraftChange, onDiscardDraft, onSendStarted, onSendSettled, onSent, onSendFailed, onClose, onPromote }: {
  session: Session;
  provider?: Provider | undefined;
  timeline: readonly TimelineItem[] | undefined;
  request: Request;
  selectImages: () => Promise<readonly SelectedImage[]>;
  notify: ComposerProps["notify"];
  draft: SideChatDraft;
  sending: boolean;
  onDraftChange: (update: SideChatDraft | ((current: SideChatDraft) => SideChatDraft)) => void;
  onDiscardDraft: () => void;
  onSendStarted: () => boolean;
  onSendSettled: () => void;
  onSent: (item: TimelineItem, userRowIdsBeforeDelivery: ReadonlySet<string>) => void;
  onSendFailed: (presentationId: string, optimisticTimestamp: string, submittedDraft: SideChatDraft) => boolean;
  onClose: () => void;
  onPromote: () => Promise<void>;
}) {
  const [localDraft, setLocalDraft] = useState<SideChatDraft>(draft);
  const localDraftRef = useRef(localDraft);
  const draftChangeRef = useRef(onDraftChange);
  const discardDraftRef = useRef(onDiscardDraft);
  localDraftRef.current = localDraft;
  draftChangeRef.current = onDraftChange;
  discardDraftRef.current = onDiscardDraft;
  useEffect(() => {
    if (draft === localDraftRef.current) return;
    localDraftRef.current = draft;
    setLocalDraft(draft);
  }, [draft]);
  const commitDraft = useCallback((update: SideChatDraft | ((current: SideChatDraft) => SideChatDraft)) => {
    const previous = localDraftRef.current;
    const next = typeof update === "function" ? update(previous) : update;
    if (previous.content === next.content && previous.attachments === next.attachments) return;
    localDraftRef.current = next;
    setLocalDraft(next);
    draftChangeRef.current(next);
  }, []);
  const discardDraft = useCallback(() => {
    const next: SideChatDraft = { content: "", attachments: [] };
    localDraftRef.current = next;
    setLocalDraft(next);
    discardDraftRef.current();
  }, []);
  const removeAttachment = useCallback((path: string) => {
    commitDraft((current) => ({ ...current, attachments: current.attachments.filter((item) => item.path !== path) }));
  }, [commitDraft]);
  const { content, attachments } = localDraft;
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [bounds, setBounds] = useState<SideChatBounds | null>(null);
  const [tether, setTether] = useState<SideChatTether>(() => ({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, path: null, mask: null }));
  const textarea = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followTranscriptBottom = useRef(true);
  const root = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const resizeState = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number; startWidth: number; startHeight: number } | null>(null);
  const tetherMaskId = useId().replaceAll(":", "");
  const visible = timeline === undefined ? undefined : visibleSideChatTimeline(timeline);
  const activeTurn = sessionHoldsFollowUpQueue(session, visible ?? []);
  const visibleTail = visible?.at(-1);
  const visibleTailKey = visibleTail ? `${visibleTail.id}:${visibleTail.body.length}:${visibleTail.state}` : String(visible?.length ?? -1);
  useLayoutEffect(() => {
    const element = transcript.current;
    if (!element || !followTranscriptBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [visibleTailKey]);
  const canPromote = Boolean(visible?.length);
  const hasDraft = Boolean(content.trim() || attachments.length);
  const hasHeaderActions = canPromote || hasDraft;
  const restoreFocus = useCallback(() => {
    const target = opener.current;
    if (!target || !target.isConnected) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) target.focus();
    });
  }, []);
  const closePanel = useCallback(() => {
    onClose();
    restoreFocus();
  }, [onClose, restoreFocus]);
  const promote = async () => {
    try { await onPromote(); }
    finally { restoreFocus(); }
  };

  // Take over the placement App measured for this session, then own it: later
  // anchor updates from the task list are ignored so scrolling never moves
  // the panel again.
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wrapper = root.current?.parentElement;
    const rect = wrapper?.getBoundingClientRect();
    const width = Math.max(sideChatMinimumWidth, Math.min(window.innerWidth - 12, rect && rect.width > 0 ? rect.width : Math.min(430, window.innerWidth - 24)));
    const height = Math.max(sideChatMinimumHeight, Math.min(window.innerHeight - 12, rect && rect.height > 0 ? rect.height : Math.min(350, window.innerHeight - 84)));
    setBounds(clampSideChatBounds({ left: rect && rect.width > 0 ? rect.left : 12, top: rect && rect.height > 0 ? rect.top : 66, width, height }));
  }, []);

  const positioned = bounds !== null;
  useEffect(() => {
    if (!positioned) return;
    textarea.current?.focus({ preventScroll: true });
  }, [positioned]);

  useEffect(() => {
    if (!positioned) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closePanel();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [closePanel, positioned]);

  const measureTether = useCallback(() => {
    setTether((current) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const parentSessionId = session.parentSessionId;
      if (!parentSessionId) return { ...current, viewportWidth, viewportHeight, path: null, mask: null };
      const panel = root.current;
      const list = document.querySelector<HTMLElement>(".session-list-scroll");
      if (!panel || !list) return { ...current, viewportWidth, viewportHeight, path: null, mask: null };
      const listBounds = list.getBoundingClientRect();
      // A collapsed list has no visible boundary to tether to.
      if (listBounds.width <= 0 || listBounds.height <= 0) return { ...current, viewportWidth, viewportHeight, path: null, mask: null };
      const rowBounds = list.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(parentSessionId)}"]`)?.getBoundingClientRect();
      const panelBounds = panel.getBoundingClientRect();
      // The origin stays pinned inside the visible list: when its row scrolls
      // out of view the line stops at the boundary instead of chasing it.
      const anchorX = listBounds.right;
      const rowCenterY = rowBounds && rowBounds.height > 0 ? rowBounds.top + rowBounds.height / 2 : listBounds.top + listBounds.height / 2;
      const anchorY = Math.max(listBounds.top + 4, Math.min(listBounds.bottom - 4, rowCenterY));
      const attachY = Math.max(panelBounds.top + 10, Math.min(panelBounds.bottom - 10, panelBounds.top + panelBounds.height / 2));
      const attachX = panelBounds.left + panelBounds.width / 2 > anchorX ? panelBounds.left : panelBounds.right;
      const midX = (anchorX + attachX) / 2;
      // Orthogonal elbow routing only: horizontal, vertical, horizontal.
      const path = `M ${anchorX} ${anchorY} H ${midX} V ${attachY} H ${attachX}`;
      const conversationBounds = document.querySelector<HTMLElement>(".conversation-scroll")?.getBoundingClientRect();
      const mask = conversationBounds && conversationBounds.width > 0 && conversationBounds.height > 0
        ? { x: conversationBounds.left - 6, y: conversationBounds.top - 6, width: conversationBounds.width + 12, height: conversationBounds.height + 12 }
        : null;
      return { viewportWidth, viewportHeight, path, mask };
    });
  }, [session.parentSessionId]);

  // Re-route whenever the panel lands somewhere new, and keep the line honest
  // while anything scrolls: capture-phase listening sees the task list scroll
  // without attaching to a particular container.
  useEffect(() => {
    measureTether();
  }, [bounds, measureTether]);
  useEffect(() => {
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measureTether); };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const list = document.querySelector<HTMLElement>(".session-list-scroll");
    const parentSessionId = session.parentSessionId;
    const parentRow = parentSessionId && list
      ? list.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(parentSessionId)}"]`)
      : null;
    for (const element of [root.current, list, parentRow, document.querySelector<HTMLElement>(".conversation-scroll")]) {
      if (element) resizeObserver?.observe(element);
    }
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); resizeObserver?.disconnect(); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
  }, [measureTether, session.parentSessionId]);
  useEffect(() => {
    const clamp = () => setBounds((current) => current === null ? current : clampSideChatBounds(current));
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (bounds === null || event.button !== 0) return;
    // Header controls stay clickable; only the empty header starts a drag.
    if ((event.target as Element).closest("button")) return;
    event.preventDefault();
    dragState.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: bounds.left, startTop: bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const state = dragState.current;
    if (state === null) return;
    const left = state.startLeft + event.clientX - state.startX;
    const top = state.startTop + event.clientY - state.startY;
    setBounds((current) => current === null ? current : clampSideChatBounds({ ...current, left, top }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const pointerId = dragState.current?.pointerId;
    if (pointerId === undefined) return;
    if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
    dragState.current = null;
    setDragging(false);
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (bounds === null || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: bounds.left, startTop: bounds.top, startWidth: bounds.width, startHeight: bounds.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = resizeState.current;
    if (state === null) return;
    const width = Math.max(sideChatMinimumWidth, Math.min(window.innerWidth - state.startLeft, state.startWidth + event.clientX - state.startX));
    const height = Math.max(sideChatMinimumHeight, Math.min(window.innerHeight - state.startTop, state.startHeight + event.clientY - state.startY));
    setBounds((current) => current === null ? current : { ...current, width, height });
  };
  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointerId = resizeState.current?.pointerId;
    if (pointerId === undefined) return;
    if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
    resizeState.current = null;
  };

  const add = async () => {
    try {
      const selected = await selectImages();
      const next = appendAttachmentsWithinLimits(localDraftRef.current.attachments, selected);
      commitDraft((current) => ({ ...current, attachments: next.items.filter((item): item is SelectedImage => !isSelectedFile(item)) }));
      if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
      else if (next.rejectedForCount) notify(`You can attach up to ${maximumMessageAttachments} items per message.`, "error");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const send = async () => {
    const submittedDraft = localDraftRef.current;
    const trimmed = submittedDraft.content.trim();
    if (!trimmed && submittedDraft.attachments.length === 0) return;
    if (activeTurn) {
      notify("Wait for this side chat to finish before sending another message.", "error");
      return;
    }
    if (!onSendStarted()) return;
    const pendingUploadIds: string[] = [];
    const userRowIdsBeforeDelivery = new Set((timeline ?? []).filter((item) => item.kind === "user").map((item) => item.id));
    const timestamp = new Date().toISOString();
    const acceptedId = `local-${Date.now()}`;
    const optimisticRow: TimelineItem = {
      id: acceptedId,
      presentationId: acceptedId,
      kind: "user",
      body: trimmed,
      timestamp,
      state: "completed",
      ...(submittedDraft.attachments.length ? {
        images: submittedDraft.attachments.map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
        })),
      } : {}),
    };
    let presentationPainted = false;
    try {
      // Move the exact submitted snapshot into the transcript before upload or
      // provider acknowledgement so a slow OpenCode acceptance never leaves a
      // blank side chat. A canonical echo adopts this presentation in place.
      onSent(optimisticRow, userRowIdsBeforeDelivery);
      presentationPainted = true;
      commitDraft({ content: "", attachments: [] });
      const attachmentIds = submittedDraft.attachments.length
        ? await uploadAttachments(submittedDraft.attachments, uploadRequest(request), (id) => pendingUploadIds.push(id))
        : [];
      await request("session.send_message", { sessionId: session.id, content: trimmed, ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}) });
      pendingUploadIds.length = 0;
    } catch (error) {
      if (isDeliveryUnknownError(error)) {
        pendingUploadIds.length = 0;
        notify(error.message, "error");
        return;
      }
      const definitelyFailed = presentationPainted
        ? onSendFailed(acceptedId, timestamp, submittedDraft)
        : true;
      if (definitelyFailed) {
        // App restored the submitted snapshot against the newest per-session
        // draft. Upload cancellation is cleanup and must not hold that repaint.
        void Promise.all(pendingUploadIds.map((uploadId) => request("attachment.upload.cancel", { uploadId }).catch(() => undefined)));
        notify(error instanceof Error ? error.message : String(error), "error");
      } else {
        // A canonical provider echo is stronger acceptance evidence than a late
        // rejected acknowledgement. Keep its attachment ownership intact.
        pendingUploadIds.length = 0;
      }
    } finally { onSendSettled(); textarea.current?.focus(); }
  };
  return <>
    {tether.path !== null ? <svg className="side-chat-connectors" width={tether.viewportWidth} height={tether.viewportHeight} viewBox={`0 0 ${tether.viewportWidth} ${tether.viewportHeight}`} aria-hidden="true">
      <defs>
        <filter id={`${tetherMaskId}-blur`} x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="9"/></filter>
        {/* The mask carves the transcript column out of the tether: fully
            invisible across the conversation, with a soft fade at each edge. */}
        <mask id={tetherMaskId} maskUnits="userSpaceOnUse">
          <rect width={tether.viewportWidth} height={tether.viewportHeight} fill="white"/>
          {tether.mask !== null ? <rect x={tether.mask.x} y={tether.mask.y} width={tether.mask.width} height={tether.mask.height} fill="black" filter={`url(#${tetherMaskId}-blur)`}/> : null}
        </mask>
      </defs>
      <path d={tether.path} mask={`url(#${tetherMaskId})`}/>
    </svg> : null}
    <section ref={root} className={`side-chat-panel ${dragging ? "dragging" : ""}`} role="dialog" aria-modal="false" aria-label="Side chat" onKeyDownCapture={(event) => { if (event.key === "Escape" && !menuOpen) { event.preventDefault(); closePanel(); } }} style={bounds === null ? { visibility: "hidden" } : { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}>
      <header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><span><ProviderLogo providerId={session.providerId} provider={provider} size={28}/><strong>Side chat</strong></span><div>{hasHeaderActions ? <Popover label="Side chat actions" className="side-chat-panel-menu" open={menuOpen} onOpen={setMenuOpen} trigger={<MoreIcon/>}>{canPromote ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void promote(); }}><BranchIcon/><span><strong>Copy to full task</strong></span></button> : null}{hasDraft ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); discardDraft(); }}><XIcon/><span><strong>Discard draft</strong></span></button> : null}</Popover> : null}{canPromote ? <button type="button" className="side-chat-promote" aria-label="Send findings to the parent task" data-tooltip="Send findings to the parent task" onClick={() => void promote()}><ArrowLeftIcon/></button> : null}<button type="button" aria-label="Close side chat" onClick={closePanel}><XIcon/></button></div></header>
      <div ref={transcript} className="side-chat-transcript" onScroll={(event) => { const element = event.currentTarget; followTranscriptBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 32; }}>{visible === undefined
        ? <div className="side-chat-transcript-skeleton" role="status" aria-label="Loading side chat" aria-busy="true"><i/><span><b/><b/></span><i/><span><b/><b/></span></div>
        : visible.length ? <ChatTimeline timeline={visible} providerId={session.providerId} provider={provider} active={activeTurn}/>
          : <p className="side-chat-context-note">This side chat already carries the parent task's context.</p>}</div>
      {attachments.length ? <div className="side-chat-attachments">{attachments.map((attachment) => <SideChatAttachmentChip key={attachment.path} attachment={attachment} onRemove={removeAttachment}/>)}</div> : null}
      <div className="side-chat-composer"><button type="button" aria-label="Attach image" data-tooltip="Attach image" onClick={() => void add()}><PlusIcon/></button><textarea ref={textarea} value={content} rows={1} placeholder="Ask about this task…" aria-label="Side chat message" onChange={(event) => commitDraft((current) => ({ ...current, content: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}/><DictationControl providerId={session.providerId} request={request} notify={notify} onTranscript={(value) => commitDraft((current) => ({ ...current, content: appendTranscript(current.content, value) }))}/><button className="side-chat-send" type="button" aria-label="Send side chat message" disabled={(!content.trim() && attachments.length === 0) || sending || activeTurn} onClick={() => void send()}>{sending ? <span className="spinner"/> : <SendIcon/>}</button></div>
      <button type="button" className="side-chat-resize" aria-label="Resize side chat" data-tooltip="Resize side chat" onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}/>
    </section>
  </>;
}

type VisualAction = "browser" | "workflow";
// "settings" is the standalone route: /eyes opens the same picker with no
// queued action behind it, so configuring is the whole point rather than a
// gate in front of the browser or a workflow.
type VisionPickerMode = VisualAction | "settings";

function visionReasoningEfforts(model: VisionProxyTarget["models"][number] | undefined): readonly string[] {
  return visionReasoningProfile(model).efforts;
}

function visionReasoningProfile(model: VisionProxyTarget["models"][number] | undefined) {
  return model ? resolveModelReasoningProfile({ providerId: model.providerId, modelId: model.id, displayName: model.displayName, advertised: model.nativeMetadata }) : { efforts: [] };
}

type EyesApiEndpoint = "google" | "xai";
type VisionHydrationState = "loading" | "ready" | "unavailable";

const eyesApiEndpoints: readonly { readonly id: EyesApiEndpoint; readonly label: string; readonly providerId: string }[] = [
  { id: "google", label: "Gemini API", providerId: "gemini" },
  { id: "xai", label: "Grok API", providerId: "grok" },
];

function directEyesEndpoint(model: VisionProxyTarget["models"][number] | undefined): string | undefined {
  const source = model?.nativeMetadata?.sourceProviderId;
  if (typeof source === "string" && source.trim()) return source;
  const separator = model?.id.indexOf("::") ?? -1;
  return separator > 0 ? model?.id.slice(0, separator) : undefined;
}

/**
 * Which API-key endpoint funds a saved EYES choice, if any. Direct-API models
 * live under the "direct" target with an endpoint prefix; harness-carried
 * models (OpenCode, Codex, ...) are funded elsewhere and match no row.
 */
function endpointForSelection(
  targets: readonly VisionProxyTarget[],
  selection: VisionProxySelection | null | undefined,
): EyesApiEndpoint | undefined {
  if (selection?.providerId !== "direct") return undefined;
  const model = targets
    .find((target) => target.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.id === selection.modelId);
  const raw = ((model ? directEyesEndpoint(model) : undefined) ?? selection.modelId.split("::")[0] ?? "").toLowerCase();
  return raw === "google" || raw === "xai" ? raw : undefined;
}

/**
 * The concrete model an API endpoint row stands for: the direct catalogue's
 * default image model for that endpoint. Row clicks choose the endpoint; this
 * resolves which model saving will actually persist.
 */
function endpointDefaultSelection(
  targets: readonly VisionProxyTarget[],
  endpoint: EyesApiEndpoint,
  saved?: VisionProxySelection | null,
): { readonly modelId: string; readonly effort: string } | null {
  const candidates = (targets.find((target) => target.providerId === "direct")?.models ?? [])
    .filter((candidate) => directEyesEndpoint(candidate) === endpoint);
  const savedModel = saved?.providerId === "direct" ? candidates.find((candidate) => candidate.id === saved.modelId) : undefined;
  const model = savedModel ?? candidates.find((candidate) => candidate.isDefault) ?? candidates[0];
  if (!model) return null;
  return { modelId: model.id, effort: savedModel ? saved?.reasoningEffort ?? "" : visionReasoningProfile(model).defaultEffort ?? "" };
}

function sameEyesSelection(
  left: { readonly providerId: string; readonly modelId: string; readonly reasoningEffort?: string } | null | undefined,
  right: { readonly providerId: string; readonly modelId: string; readonly reasoningEffort?: string } | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return left.providerId === right.providerId && left.modelId === right.modelId && (left.reasoningEffort || "") === (right.reasoningEffort || "");
}

/** Reads one string out of a model's native metadata without trusting its shape. */
function visionMetadataText(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function visionRouteInput(model: VisionProxyTarget["models"][number]): ModelCatalogRouteInput {
  const endpointName = visionMetadataText(model.nativeMetadata, "endpointName");
  const sourceProviderId = visionMetadataText(model.nativeMetadata, "sourceProviderId");
  const sourceProviderName = visionMetadataText(model.nativeMetadata, "sourceProviderName");
  return {
    id: model.id,
    name: model.displayName,
    ...(endpointName ? { endpointName } : {}),
    ...(sourceProviderId ? { sourceProviderId } : {}),
    ...(sourceProviderName ? { sourceProviderName } : {}),
  };
}

/**
 * The upstream provider the chosen harness routes a model through — OpenCode
 * carrying CrofAI, or a direct endpoint's own host. The adjacent Provider control
 * already names the harness, so a label that would only repeat it stays hidden,
 * and a raw route identifier is never shown in place of a real name.
 */
function visionSourceLabel(
  providerId: string,
  providerName: string,
  model: VisionProxyTarget["models"][number],
): string | undefined {
  const input = visionRouteInput(model);
  if (providerId === "opencode") {
    const route = modelCatalogRoute(providerId, providerName, input);
    return route.carriedBy ? route.label : undefined;
  }
  const label = input.sourceProviderName ?? input.endpointName;
  return label && label.toLocaleLowerCase() !== providerName.toLocaleLowerCase() ? label : undefined;
}

function readyVisionTargets(targets: readonly VisionProxyTarget[]): readonly VisionProxyTarget[] {
  return targets.flatMap((target) => {
    const models = target.models.filter((model) => model.nativeMetadata?.walletKind !== "user_api"
      || model.nativeMetadata?.apiKeyConfigured === true);
    return models.length ? [{ ...target, models }] : [];
  });
}

function mergeVisionTargets(
  previous: readonly VisionProxyTarget[],
  fresh: readonly VisionProxyTarget[],
): readonly VisionProxyTarget[] {
  const freshProviders = new Set(fresh.map((target) => target.providerId));
  return [...fresh, ...previous.filter((target) => !freshProviders.has(target.providerId))];
}

interface VisionPickerCacheEntry {
  readonly targets?: readonly VisionProxyTarget[];
  readonly status?: VisionProxyStatus;
  readonly wallets?: Partial<Record<EyesApiEndpoint, ProviderWalletStatus>>;
}

const visionPickerCache = new Map<string, VisionPickerCacheEntry>();
const maximumVisionPickerCacheEntries = 48;

function updateVisionPickerCache(sessionId: string, patch: VisionPickerCacheEntry): void {
  const previous = visionPickerCache.get(sessionId) ?? {};
  visionPickerCache.delete(sessionId);
  visionPickerCache.set(sessionId, { ...previous, ...patch });
  while (visionPickerCache.size > maximumVisionPickerCacheEntries) {
    const oldest = visionPickerCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    visionPickerCache.delete(oldest);
  }
}

function structuralVisionTargets(snapshot: DesktopSnapshot): readonly VisionProxyTarget[] {
  return snapshot.providers.flatMap((provider) => {
    const models: VisionProxyTarget["models"][number][] = (snapshot.models[provider.id] ?? []).filter((model) => model.inputModalities?.includes("image")).map((model) => ({
      id: model.id,
      providerId: provider.id,
      displayName: model.name,
      isDefault: model.isDefault === true,
      ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
      nativeMetadata: {
        ...(model.efforts.length ? { supportedReasoningEfforts: [...model.efforts] } : {}),
        ...(model.defaultEffort ? { defaultReasoningEffort: model.defaultEffort } : {}),
        ...(model.sourceProviderId ? { sourceProviderId: model.sourceProviderId } : {}),
        ...(model.sourceProviderName ? { sourceProviderName: model.sourceProviderName } : {}),
        ...(model.endpointName ? { endpointName: model.endpointName } : {}),
        ...(model.walletKind ? { walletKind: model.walletKind } : {}),
        ...(model.apiKeyConfigured !== undefined ? { apiKeyConfigured: model.apiKeyConfigured } : {}),
        ...(model.apiKeyVerified !== undefined ? { apiKeyVerified: model.apiKeyVerified } : {}),
      },
    }));
    return models.length ? [{ providerId: provider.id, displayName: provider.name, models }] : [];
  });
}

export function parsedVisionStatus(value: unknown, sessionId: string): VisionProxyStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.sessionId !== sessionId || (item.primaryModelSupportsImageInput !== null && typeof item.primaryModelSupportsImageInput !== "boolean")) return undefined;
  let configured: VisionProxyStatus["configured"];
  if (item.configured === null) configured = null;
  else {
    if (!item.configured || typeof item.configured !== "object" || Array.isArray(item.configured)) return undefined;
    const selection = item.configured as Record<string, unknown>;
    if (typeof selection.providerId !== "string" || !selection.providerId || typeof selection.modelId !== "string" || !selection.modelId) return undefined;
    configured = {
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(typeof selection.reasoningEffort === "string" && selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    };
  }
  return {
    sessionId,
    ...(typeof item.primaryModelId === "string" ? { primaryModelId: item.primaryModelId } : {}),
    primaryModelSupportsImageInput: item.primaryModelSupportsImageInput,
    configured,
  };
}

interface VisionPickerSelectionState {
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: string;
  readonly persistedUnavailable: boolean;
}

function resolvedVisionPickerSelection(
  targets: readonly VisionProxyTarget[],
  status: VisionProxyStatus | undefined,
  preferredEndpoint?: EyesApiEndpoint,
): VisionPickerSelectionState {
  if (status === undefined) return { providerId: "", modelId: "", effort: "", persistedUnavailable: false };
  const preferredTarget = preferredEndpoint === undefined ? undefined : targets.find((target) => target.providerId === "direct" && target.models.some((model) => directEyesEndpoint(model) === preferredEndpoint));
  const preferredModel = preferredTarget?.models.find((model) => directEyesEndpoint(model) === preferredEndpoint);
  if (preferredTarget && preferredModel) {
    return { providerId: preferredTarget.providerId, modelId: preferredModel.id, effort: visionReasoningProfile(preferredModel).defaultEffort ?? "", persistedUnavailable: false };
  }
  if (status.configured) {
    const configuredTarget = targets.find((target) => target.providerId === status.configured?.providerId);
    const configuredModel = configuredTarget?.models.find((model) => model.id === status.configured?.modelId);
    if (!configuredTarget || !configuredModel) return { providerId: "", modelId: "", effort: "", persistedUnavailable: true };
    const efforts = visionReasoningEfforts(configuredModel);
    return {
      providerId: configuredTarget.providerId,
      modelId: configuredModel.id,
      effort: matchReasoningEffort(status.configured.reasoningEffort, efforts) ?? status.configured.reasoningEffort ?? "",
      persistedUnavailable: false,
    };
  }
  // EYES is off for this task, so propose nothing. Prefilling the first usable
  // provider and model reads as a saved setting and as EYES being on by
  // default; the user enables EYES by choosing explicitly and confirming.
  return { providerId: "", modelId: "", effort: "", persistedUnavailable: false };
}

function walletFromPayload(payload: Record<string, unknown> | null): ProviderWalletStatus | undefined {
  const wallet = payload?.wallet;
  if (!wallet || typeof wallet !== "object" || Array.isArray(wallet)) return undefined;
  const value = wallet as Record<string, unknown>;
  if (value.providerId !== "direct" || typeof value.apiKeyConfigured !== "boolean") return undefined;
  return wallet as unknown as ProviderWalletStatus;
}

function VisionModelPicker({ target, providerId, modelId, disabled, loading, onChoose }: {
  target: VisionProxyTarget | undefined;
  providerId: string;
  modelId: string;
  disabled: boolean;
  loading: boolean;
  onChoose: (model: VisionProxyTarget["models"][number]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const models = target?.models ?? [];
  const providerName = target?.displayName ?? "";
  const selected = models.find((model) => model.id === modelId);
  const matches = models.filter((model) => modelMatchesCatalogQuery(query, providerId, providerName, visionRouteInput(model)));
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setHighlight(0);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  }, []);
  // The EYES body scrolls inside a clipped panel, so the list is measured against
  // the viewport rather than being cut off by its own container.
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const measure = () => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const inset = 12;
      const below = window.innerHeight - bounds.bottom - inset - 6;
      const above = bounds.top - inset - 6;
      const openUp = below < 180 && above > below;
      const maxHeight = Math.max(132, Math.min(316, openUp ? above : below));
      const width = Math.max(bounds.width, 236);
      const left = Math.min(Math.max(inset, bounds.left), Math.max(inset, window.innerWidth - width - inset));
      setAnchor({ left, top: openUp ? bounds.top - 6 - maxHeight : bounds.bottom + 6, width, maxHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, close]);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);
  const commit = (model: VisionProxyTarget["models"][number] | undefined) => {
    if (!model) return;
    onChoose(model);
    close(true);
  };
  return <div className="vision-model-picker" ref={root}>
    <button ref={trigger} type="button" className="vision-model-trigger" data-model-id={modelId} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={`Vision model${selected ? `. Current model: ${selected.displayName}` : ""}`} onClick={() => {
      if (open) close(true);
      else {
        setHighlight(Math.max(0, models.findIndex((model) => model.id === modelId)));
        setOpen(true);
      }
    }}><span>{selected?.displayName ?? (loading && !target ? "Checking visual models…" : "Choose model")}</span><ChevronDownIcon /></button>
    {open && anchor ? <div className="vision-model-dropdown" style={{ left: anchor.left, top: anchor.top, width: anchor.width }}>
      <div className="vision-model-search">
        <SearchIcon />
        <input
          ref={field}
          type="text"
          value={query}
          placeholder="Search models"
          aria-label={`Search visual models${providerName ? ` for ${providerName}` : ""}`}
          onChange={(event) => { setQuery(event.target.value); setHighlight(0); }}
          onKeyDown={(event) => {
            // Escape clears the query before it closes anything and never reaches the
            // panel's own handler, so one keypress cannot dismiss the whole surface.
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (query) setQuery("");
              else close(true);
              return;
            }
            if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((current) => Math.min(matches.length - 1, current + 1)); return; }
            if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((current) => Math.max(0, current - 1)); return; }
            if (event.key === "Enter") { event.preventDefault(); commit(matches[highlight]); }
          }}
        />
      </div>
      <div ref={list} className="vision-model-scroll" role="listbox" aria-label={`Visual models${providerName ? ` for ${providerName}` : ""}`} style={{ maxHeight: Math.max(90, anchor.maxHeight - 42) }}>
        {matches.length ? matches.map((model, index) => {
          const source = visionSourceLabel(providerId, providerName, model);
          return <button key={model.id} type="button" role="option" aria-selected={model.id === modelId} className="vision-model-option" {...(index === highlight ? { "data-highlighted": "true" } : {})} onPointerEnter={() => setHighlight(index)} onClick={() => commit(model)}>
            <span><strong>{model.displayName}</strong>{source ? <small>{source}</small> : null}</span>{model.id === modelId ? <CheckIcon /> : null}
          </button>;
        }) : <p className="vision-model-empty">{models.length ? "No visual model matches that search" : "No visual model is available here"}</p>}
      </div>
    </div> : null}
  </div>;
}

export function VisionEyesPicker({ snapshot, session, request, action, liveStatus, readLiveStatus, onClose, onReady }: {
  snapshot: DesktopSnapshot;
  session: Session;
  request: Request;
  action: VisionPickerMode;
  liveStatus?: VisionProxyStatus | undefined;
  readLiveStatus?: ((sessionId: string) => VisionProxyStatus | undefined) | undefined;
  onClose: (restoreFocus?: boolean) => void;
  onReady: (action: VisionPickerMode) => void;
}) {
  const cached = visionPickerCache.get(session.id);
  const initialStatus = liveStatus?.sessionId === session.id ? liveStatus : cached?.status;
  const initialTargets = readyVisionTargets(cached?.targets ?? structuralVisionTargets(snapshot));
  const initialSelection = resolvedVisionPickerSelection(initialTargets, initialStatus);
  const [targets, setTargets] = useState<readonly VisionProxyTarget[]>(initialTargets);
  const [status, setStatus] = useState<VisionProxyStatus | undefined>(initialStatus);
  const [providerId, setProviderId] = useState(initialSelection.providerId);
  const [modelId, setModelId] = useState(initialSelection.modelId);
  const [effort, setEffort] = useState(initialSelection.effort);
  const [targetDiscovery, setTargetDiscovery] = useState<VisionHydrationState>(cached?.targets ? "ready" : "loading");
  const [statusDiscovery, setStatusDiscovery] = useState<VisionHydrationState>(initialStatus ? "ready" : "loading");
  const [hydrating, setHydrating] = useState(true);
  const [saving, setSaving] = useState(false);
  const [wallets, setWallets] = useState<Partial<Record<EyesApiEndpoint, ProviderWalletStatus>>>(cached?.wallets ?? {});
  const [walletDiscovery, setWalletDiscovery] = useState<Record<EyesApiEndpoint, VisionHydrationState>>({
    google: cached?.wallets?.google ? "ready" : "loading",
    xai: cached?.wallets?.xai ? "ready" : "loading",
  });
  const [editingEndpoint, setEditingEndpoint] = useState<EyesApiEndpoint | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState("");
  const [confirmRemoveEndpoint, setConfirmRemoveEndpoint] = useState<EyesApiEndpoint | null>(null);
  const [rowRemovingEndpoint, setRowRemovingEndpoint] = useState<EyesApiEndpoint | null>(null);
  const [rowFeedback, setRowFeedback] = useState("");
  // An API row is a pending endpoint choice that collapses the harness boxes
  // into one. Null means the harness boxes own the draft.
  const [apiDraft, setApiDraft] = useState<EyesApiEndpoint | null>(() => endpointForSelection(initialTargets, initialStatus?.configured) ?? null);
  const apiTouched = useRef(false);
  const [catalogueError, setCatalogueError] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const panel = useRef<HTMLElement>(null);
  const active = useRef(true);
  const targetsRef = useRef(initialTargets);
  const statusRef = useRef(initialStatus);
  const selectionTouched = useRef(false);
  const hydrationGeneration = useRef(0);
  const configureGeneration = useRef(0);
  const saveInFlight = useRef(false);
  const credentialInFlight = useRef(false);

  useEffect(() => {
    active.current = true;
    const focusFirst = requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('select, button:not(:disabled)')?.focus());
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      active.current = false;
      cancelAnimationFrame(focusFirst);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  const applyAuthoritativeSelection = useCallback((nextTargets: readonly VisionProxyTarget[], nextStatus: VisionProxyStatus | undefined, preferredEndpoint?: EyesApiEndpoint, force = false) => {
    if (!force && (selectionTouched.current || apiTouched.current)) return;
    const next = resolvedVisionPickerSelection(nextTargets, nextStatus, preferredEndpoint);
    setProviderId(next.providerId);
    setModelId(next.modelId);
    setEffort(next.effort);
    setApiDraft(endpointForSelection(nextTargets, nextStatus?.configured) ?? null);
    if (force) {
      selectionTouched.current = false;
      apiTouched.current = false;
    }
  }, []);

  // Return the harness boxes to the saved choice (or empty when EYES is off)
  // after an endpoint draft is cleared or its key disappears.
  const showSavedInBoxes = (nextTargets: readonly VisionProxyTarget[], nextStatus: VisionProxyStatus | undefined) => {
    const next = resolvedVisionPickerSelection(nextTargets, nextStatus);
    setProviderId(next.providerId);
    setModelId(next.modelId);
    setEffort(next.effort);
    selectionTouched.current = false;
  };

  const hydrate = useCallback(async (preferredEndpoint?: EyesApiEndpoint) => {
    const generation = ++hydrationGeneration.current;
    const liveStatusAtStart = readLiveStatus?.(session.id);
    const isCurrent = () => active.current && hydrationGeneration.current === generation;
    setHydrating(true);
    setCatalogueError("");
    const targetsRequest = (async () => {
      try {
        const payload = await request("vision.targets", {});
        if (!Array.isArray(payload.targets)) throw new Error("invalid targets");
        const fresh = readyVisionTargets(payload.targets as unknown as VisionProxyTarget[])
          .filter((target) => typeof target.providerId === "string" && Array.isArray(target.models) && target.models.length > 0);
        const incomplete = payload.incomplete === true;
        const next = incomplete ? mergeVisionTargets(targetsRef.current, fresh) : fresh;
        if (!isCurrent()) return;
        if (incomplete && next.length === 0) {
          setTargetDiscovery("unavailable");
          setCatalogueError("Visual model discovery is temporarily unavailable. Retry here without closing the panel.");
          return;
        }
        targetsRef.current = next;
        setTargets(next);
        setTargetDiscovery("ready");
        updateVisionPickerCache(session.id, { targets: next });
        applyAuthoritativeSelection(next, statusRef.current, preferredEndpoint);
        setCatalogueError(incomplete ? "Some visual models could not be refreshed. Available choices are still shown." : "");
      } catch {
        if (!isCurrent()) return;
        setTargetDiscovery("unavailable");
        setCatalogueError(targetsRef.current.length ? "Visual models could not be refreshed. The last available list is still shown." : "Visual model discovery is unavailable right now.");
      }
    })();
    const statusRequest = (async () => {
      try {
        const payload = await request("session.vision.get", { sessionId: session.id });
        const received = parsedVisionStatus(payload.vision, session.id);
        if (!received) throw new Error("invalid status");
        if (!isCurrent()) return;
        const latestLive = readLiveStatus?.(session.id);
        const next = latestLive !== undefined && latestLive !== liveStatusAtStart ? latestLive : received;
        statusRef.current = next;
        setStatus(next);
        setStatusDiscovery("ready");
        updateVisionPickerCache(session.id, { status: next });
        applyAuthoritativeSelection(targetsRef.current, next, preferredEndpoint);
      } catch {
        if (!isCurrent()) return;
        setStatusDiscovery("unavailable");
      }
    })();
    const walletRequests = eyesApiEndpoints.map(async (endpoint) => {
      try {
        const payload = await request("wallet.get", { providerId: "direct", endpointId: endpoint.id });
        const wallet = walletFromPayload(payload);
        if (!wallet) throw new Error("invalid wallet");
        if (!isCurrent()) return;
        setWallets((current) => {
          const next = { ...current, [endpoint.id]: wallet };
          updateVisionPickerCache(session.id, { wallets: next });
          return next;
        });
        setWalletDiscovery((current) => ({ ...current, [endpoint.id]: "ready" }));
      } catch {
        if (isCurrent()) setWalletDiscovery((current) => ({ ...current, [endpoint.id]: "unavailable" }));
      }
    });
    // Target/status recovery owns the picker retry. Wallet rows hydrate on their
    // own schedule and must never keep an otherwise useful retry disabled.
    await Promise.allSettled([targetsRequest, statusRequest]);
    if (isCurrent()) setHydrating(false);
    void Promise.allSettled(walletRequests);
  }, [applyAuthoritativeSelection, readLiveStatus, request, session.id]);

  useEffect(() => {
    if (liveStatus === undefined || liveStatus.sessionId !== session.id) return;
    const changed = !sameEyesSelection(statusRef.current?.configured, liveStatus.configured);
    statusRef.current = liveStatus;
    setStatus(liveStatus);
    setStatusDiscovery("ready");
    updateVisionPickerCache(session.id, { status: liveStatus });
    // A pushed provider status is newer than any local picker draft. Reflect it
    // immediately so an already-open picker cannot keep showing a stale saved
    // choice after another client (or the host) changes EYES.
    applyAuthoritativeSelection(targetsRef.current, liveStatus, undefined, changed);
  }, [applyAuthoritativeSelection, liveStatus, session.id]);

  useEffect(() => {
    void hydrate();
    return () => { hydrationGeneration.current += 1; };
  }, [hydrate]);

  const savedSelection = status?.configured ?? undefined;
  const apiDraftResolved = apiDraft ? endpointDefaultSelection(targets, apiDraft, savedSelection) : null;
  const target = targets.find((item) => item.providerId === (apiDraft ? "direct" : providerId));
  const selectedModel = target?.models.find((item) => item.id === (apiDraft ? apiDraftResolved?.modelId : modelId));
  const efforts = visionReasoningEfforts(selectedModel);
  // Enabling and turning off share one authoritative re-read so neither can
  // leave the panel showing a state this task did not actually save.
  const readAuthoritativeStatus = async (generation: number): Promise<VisionProxyStatus | undefined> => {
    try {
      const payload = await request("session.vision.get", { sessionId: session.id });
      const next = parsedVisionStatus(payload.vision, session.id);
      if (!next) return undefined;
      if (!active.current || configureGeneration.current !== generation) return undefined;
      statusRef.current = next;
      setStatus(next);
      setStatusDiscovery("ready");
      updateVisionPickerCache(session.id, { status: next });
      applyAuthoritativeSelection(targetsRef.current, next, undefined, true);
      return next;
    } catch {
      if (active.current && configureGeneration.current === generation) setStatusDiscovery("unavailable");
      return undefined;
    }
  };
  const disable = async (keepOpen = false) => {
    if (savedSelection === undefined || saveInFlight.current) return;
    saveInFlight.current = true;
    const generation = ++configureGeneration.current;
    hydrationGeneration.current += 1;
    setHydrating(false);
    setSaving(true);
    setSelectionError("");
    try {
      await request("session.vision.configure", { sessionId: session.id, selection: null });
      const authoritative = await readAuthoritativeStatus(generation);
      if (!active.current || configureGeneration.current !== generation) return;
      if (authoritative !== undefined && !authoritative.configured) { if (!keepOpen) onClose(); return; }
      setSelectionError(authoritative
        ? "EYES is still on for this task. The latest saved choice is shown."
        : "Tethoq could not confirm that EYES was turned off. Retry before continuing.");
    } catch {
      const authoritative = await readAuthoritativeStatus(generation);
      if (!active.current || configureGeneration.current !== generation) return;
      if (authoritative !== undefined && !authoritative.configured) { if (!keepOpen) onClose(); }
      else setSelectionError("EYES could not be turned off. Try again in a moment.");
    } finally {
      if (active.current && configureGeneration.current === generation) {
        saveInFlight.current = false;
        setSaving(false);
      }
    }
  };
  // The choice Save will persist: either the endpoint row's resolved model or
  // the harness boxes, whichever surface was touched last.
  const draftSelection: { readonly providerId: string; readonly modelId: string; readonly reasoningEffort?: string } | null = apiDraft
    ? (apiDraftResolved ? { providerId: "direct", modelId: apiDraftResolved.modelId, ...(effort ? { reasoningEffort: effort } : {}) } : null)
    : (providerId && modelId && selectedModel ? { providerId, modelId, ...(effort ? { reasoningEffort: effort } : {}) } : null);
  const draftChanged = apiDraft && !apiDraftResolved
    ? endpointForSelection(targets, savedSelection) !== apiDraft
    : !sameEyesSelection(draftSelection, savedSelection ?? null);
  const configure = async (choice = draftSelection, keepOpen = false) => {
    if (saveInFlight.current) return;
    const choiceModel = targetsRef.current.find((item) => item.providerId === choice?.providerId)?.models.find((item) => item.id === choice?.modelId);
    const choiceEfforts = visionReasoningEfforts(choiceModel);
    if (choice && choiceEfforts.length && !matchReasoningEffort(choice.reasoningEffort, choiceEfforts)) {
      setSelectionError("Choose a reasoning level for EYES before saving.");
      return;
    }
    if (apiDraft && !choice) {
      setSelectionError("Visual models are still unavailable. Retry discovery, then apply your selection.");
      return;
    }
    if (!choice) { await disable(keepOpen); return; }
    if (sameEyesSelection(choice, statusRef.current?.configured ?? null)) return;
    saveInFlight.current = true;
    const generation = ++configureGeneration.current;
    hydrationGeneration.current += 1;
    setHydrating(false);
    setSaving(true);
    setSelectionError("");
    const selection: JsonObject = { providerId: choice.providerId, modelId: choice.modelId, ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) };
    const restore = async (): Promise<VisionProxyStatus | undefined> => await readAuthoritativeStatus(generation);
    try {
      await request("session.vision.configure", { sessionId: session.id, selection });
      const authoritative = await restore();
      if (!active.current || configureGeneration.current !== generation) return;
      if (!sameEyesSelection(authoritative?.configured ?? null, choice)) {
        setSelectionError(authoritative ? "The saved visual model changed elsewhere. The latest saved choice is shown." : "Tethoq could not confirm the saved visual model. Retry before continuing.");
        return;
      }
      if (!keepOpen) onReady(action);
    } catch {
      const authoritative = await restore();
      if (!active.current || configureGeneration.current !== generation) return;
      if (sameEyesSelection(authoritative?.configured ?? null, choice)) { if (!keepOpen) onReady(action); }
      else setSelectionError(authoritative ? "The visual model was not changed. Your saved choice is shown." : "The visual model could not be saved. Try again when its status is available.");
    } finally {
      if (active.current && configureGeneration.current === generation) {
        saveInFlight.current = false;
        setSaving(false);
      }
    }
  };

  const removalFailureCopy = "That API key could not be removed. If it is set as an environment variable, clear it there instead.";
  const clearSavedKey = async (endpoint: EyesApiEndpoint): Promise<boolean> => {
    if (credentialInFlight.current) return false;
    credentialInFlight.current = true;
    setCredentialBusy(true);
    try {
      const payload = await request("wallet.configure", { providerId: "direct", endpointId: endpoint, clearApiKey: true });
      const wallet = walletFromPayload(payload);
      if (wallet?.apiKeyConfigured === true) throw new Error("The API key is still saved.");
      if (!active.current) return false;
      if (wallet) {
        setWallets((current) => {
          const next = { ...current, [endpoint]: wallet };
          updateVisionPickerCache(session.id, { wallets: next });
          return next;
        });
      }
      selectionTouched.current = false;
      // A removed key retires every model it funded. Re-read the catalogue so a
      // saved choice that just became unreachable shows its neutral unavailable
      // state instead of a model this task can no longer use.
      void hydrate();
      return true;
    } catch {
      return false;
    } finally {
      if (active.current) {
        credentialInFlight.current = false;
        setCredentialBusy(false);
      }
    }
  };

  // A removed key retires the endpoint draft with it: choosing requires a key.
  const dropApiDraftForEndpoint = (endpoint: EyesApiEndpoint) => {
    setApiDraft((current) => {
      if (current !== endpoint) return current;
      showSavedInBoxes(targetsRef.current, statusRef.current);
      return null;
    });
    apiTouched.current = false;
  };

  // Rows edit the local choice; only Use as eyes changes the task. Discovery
  // must never turn a stored-key selection click into a key-management action.
  const chooseEndpointFromRow = (endpoint: EyesApiEndpoint) => {
    if (credentialBusy || saveInFlight.current) return;
    setConfirmRemoveEndpoint(null);
    setRowFeedback("");
    setSelectionError("");
    if (wallets[endpoint]?.apiKeyConfigured !== true) {
      setEditingEndpoint(endpoint);
      setApiKey("");
      setCredentialError("");
      return;
    }
    apiTouched.current = true;
    selectionTouched.current = true;
    setEditingEndpoint(null);
    setApiDraft(apiDraft === endpoint ? null : endpoint);
    setProviderId("");
    setModelId("");
    setEffort(endpointDefaultSelection(targets, endpoint, savedSelection)?.effort ?? "");
  };

  const chooseHarnessInstead = () => {
    setApiDraft(null);
    apiTouched.current = false;
    showSavedInBoxes(targetsRef.current, statusRef.current);
  };

  const removeCredential = async () => {
    if (editingEndpoint === null || credentialInFlight.current) return;
    const endpoint = editingEndpoint;
    setCredentialError("");
    if (await clearSavedKey(endpoint)) {
      if (!active.current) return;
      setEditingEndpoint(null);
      setApiKey("");
      setConfirmRemoveEndpoint(null);
      dropApiDraftForEndpoint(endpoint);
    } else if (active.current) {
      setCredentialError(removalFailureCopy);
    }
  };

  // Removing a key from its row is the same authoritative clearing without
  // opening the editor. The first tap arms an inline confirm so a slip cannot
  // silently retire every model that key funded.
  const removeKeyFromRow = async (endpoint: EyesApiEndpoint) => {
    if (credentialInFlight.current) return;
    if (confirmRemoveEndpoint !== endpoint) {
      setConfirmRemoveEndpoint(endpoint);
      setRowFeedback("");
      return;
    }
    setConfirmRemoveEndpoint(null);
    setRowRemovingEndpoint(endpoint);
    setRowFeedback("");
    try {
      if (await clearSavedKey(endpoint)) {
        if (!active.current) return;
        if (editingEndpoint === endpoint) {
          setEditingEndpoint(null);
          setApiKey("");
          setCredentialError("");
        }
        dropApiDraftForEndpoint(endpoint);
      } else if (active.current) {
        setRowFeedback(removalFailureCopy);
      }
    } finally {
      if (active.current) setRowRemovingEndpoint(null);
    }
  };

  const saveCredential = async (event: FormEvent) => {
    event.preventDefault();
    if (editingEndpoint === null || credentialInFlight.current || apiKey.trim().length < 8) return;
    const endpoint = editingEndpoint;
    credentialInFlight.current = true;
    setCredentialBusy(true);
    setCredentialError("");
    try {
      const payload = await request("wallet.configure", { providerId: "direct", endpointId: endpoint, apiKey: apiKey.trim(), validateApiKey: true });
      const wallet = walletFromPayload(payload);
      if (!wallet?.apiKeyConfigured) throw new Error("The API key was not accepted.");
      if (!active.current) return;
      setWallets((current) => {
        const next = { ...current, [endpoint]: wallet };
        updateVisionPickerCache(session.id, { wallets: next });
        return next;
      });
      setEditingEndpoint(null);
      setApiKey("");
      selectionTouched.current = false;
      // Re-read the catalogue first: the key may make this endpoint resolvable.
      await hydrate();
      if (!active.current) return;
      const resolved = endpointDefaultSelection(targetsRef.current, endpoint);
      if (resolved) {
        setApiDraft(endpoint);
        setEffort(resolved.effort);
        apiTouched.current = true;
        selectionTouched.current = true;
        await configure({ providerId: "direct", modelId: resolved.modelId, ...(resolved.effort ? { reasoningEffort: resolved.effort } : {}) }, action === "settings");
      }
    } catch {
      if (!active.current) return;
      try {
        const payload = await request("wallet.get", { providerId: "direct", endpointId: endpoint });
        const wallet = walletFromPayload(payload);
        if (!wallet) throw new Error("invalid wallet");
        if (!active.current) return;
        setWallets((current) => {
          const next = { ...current, [endpoint]: wallet };
          updateVisionPickerCache(session.id, { wallets: next });
          return next;
        });
        setWalletDiscovery((current) => ({ ...current, [endpoint]: "ready" }));
      } catch {
        if (active.current) setWalletDiscovery((current) => ({ ...current, [endpoint]: "unavailable" }));
      }
      if (active.current) setCredentialError("That API key could not be verified. Check it and try again.");
    } finally {
      if (active.current) {
        credentialInFlight.current = false;
        setCredentialBusy(false);
      }
    }
  };

  const apiDraftLabel = apiDraft ? (eyesApiEndpoints.find((item) => item.id === apiDraft)?.label ?? apiDraft) : "";
  const inEffectEndpoint = apiDraft ?? endpointForSelection(targets, draftSelection);
  return <section ref={panel} className="chat-picker vision-eyes-picker" role="dialog" aria-label="Choose a vision model">
    <header><span><strong>Choose a model as eyes</strong>{action !== "settings" ? <small>This text-only session needs visual support for {action === "browser" ? "the browser" : "recorded workflows"}.</small> : null}</span><button type="button" aria-label="Close vision model selection" onClick={() => onClose()}><XIcon /></button></header>
    <div className="vision-picker-body">
      {apiDraft ? <div className="vision-single-choice" aria-live="polite"><span><strong>{apiDraftLabel}</strong><small>{selectedModel?.displayName ?? "Checking visual model…"}</small></span><label><span>Reasoning</span><select aria-label="Vision reasoning effort" value={effort} disabled={saving || !selectedModel || efforts.length === 0} onChange={(event) => { selectionTouched.current = true; setEffort(event.target.value); }}><option value="">{efforts.length ? "Choose effort" : "Not available"}</option>{efforts.map((item) => <option key={item} value={item}>{reasoningLabel(item, { providerId: "direct", modelId: selectedModel?.id, displayName: selectedModel?.displayName })}</option>)}</select></label></div> : targets.length || targetDiscovery === "loading" ? <div className="vision-picker-fields" aria-busy={targetDiscovery === "loading" || statusDiscovery === "loading"}>
        <label><span>Provider</span><select aria-label="Vision provider" value={providerId} disabled={saving || targets.length === 0} onChange={(event) => { selectionTouched.current = true; const nextTarget = targets.find((item) => item.providerId === event.target.value); const nextModel = nextTarget?.models.find((item) => item.isDefault) ?? nextTarget?.models[0]; setProviderId(event.target.value); setModelId(nextModel?.id ?? ""); setEffort(visionReasoningProfile(nextModel).defaultEffort ?? ""); }}><option value="">{statusDiscovery === "loading" ? "Checking saved choice…" : "Choose provider"}</option>{targets.map((item) => <option key={item.providerId} value={item.providerId}>{item.displayName}</option>)}</select></label>
        <div className="vision-picker-field"><span>Model</span><VisionModelPicker target={target} providerId={providerId} modelId={modelId} disabled={saving || !providerId} loading={targetDiscovery === "loading"} onChoose={(model) => { selectionTouched.current = true; setModelId(model.id); setEffort(visionReasoningProfile(model).defaultEffort ?? ""); }} /></div>
        <label><span>Reasoning</span><select aria-label="Vision reasoning effort" value={effort} disabled={saving || !selectedModel || efforts.length === 0} onChange={(event) => { selectionTouched.current = true; setEffort(event.target.value); }}><option value="">{efforts.length ? "Choose effort" : "Not available"}</option>{efforts.map((item) => <option key={item} value={item}>{reasoningLabel(item, { providerId, modelId, displayName: selectedModel?.displayName })}</option>)}</select></label>
      </div> : targetDiscovery === "ready" ? <div className="chat-picker-empty"><strong>No image-capable model is ready</strong><small>Add a Gemini or Grok key below, or connect a visual model in an Agent.</small></div> : <div className="chat-picker-empty"><strong>Visual model discovery unavailable</strong><small>Retry here without closing the panel.</small></div>}
      {apiDraft ? <div className="vision-single-actions"><button type="button" onClick={() => { setEditingEndpoint(apiDraft); setApiKey(""); setCredentialError(""); }}>Replace key</button><button type="button" onClick={chooseHarnessInstead}>Use a harness model instead</button></div> : null}
      {resolvedVisionPickerSelection(targets, status).persistedUnavailable ? <p className="vision-picker-status" role="status">The saved visual model is currently unavailable. Choose another model or retry discovery.</p> : null}
      <div className="vision-picker-feedback">{catalogueError || statusDiscovery === "unavailable" ? <p className="vision-picker-status" role="status">{catalogueError || "The saved EYES choice could not be checked."}<button type="button" disabled={hydrating} onClick={() => void hydrate()}>{hydrating ? "Checking…" : "Retry"}</button></p> : null}</div>
      {selectionError ? <p className="vision-picker-status failure" role="alert">{selectionError}</p> : null}
      <section className="vision-api-setup" aria-label="EYES API keys">
        <header><span><strong>Use your own API key</strong><small>Keys are encrypted by the local Bridge and never returned to this screen.</small></span></header>
        <div className="vision-api-routes">{eyesApiEndpoints.map((endpoint) => {
          // A switch shows the editable choice. Enabled is reserved for the
          // applied value; Selected makes the pre-apply state explicit.
          const stored = wallets[endpoint.id]?.apiKeyConfigured === true;
          const discovery = walletDiscovery[endpoint.id];
          const inEffect = stored && inEffectEndpoint === endpoint.id;
          const sub = !stored
            ? (discovery === "loading" ? "Checking saved key…" : discovery === "unavailable" ? "Key status unavailable" : "Add API key")
            : (inEffect ? (draftChanged ? "Selected" : "Enabled") : "Off");
          return <div key={endpoint.id} className={`vision-api-route${inEffect ? " active" : stored ? " stored" : ""}`}>
            <button type="button" className="vision-api-main" disabled={credentialBusy || saving} role={stored ? "switch" : undefined} aria-busy={saving} aria-checked={stored ? inEffect : undefined} aria-label={`${endpoint.label}: ${sub}`} onClick={() => chooseEndpointFromRow(endpoint.id)}>
              <ProviderLogo providerId={endpoint.providerId} size={25}/><span><strong>{endpoint.label}</strong><small>{sub}</small></span>{stored ? <span className="vision-api-switch" aria-hidden="true"><span /></span> : <ChevronRightIcon />}
            </button>
            {stored ? <button type="button" className="vision-api-row-remove" disabled={credentialBusy} onClick={() => void removeKeyFromRow(endpoint.id)}>{rowRemovingEndpoint === endpoint.id ? "Removing…" : confirmRemoveEndpoint === endpoint.id ? "Confirm remove" : "Remove"}</button> : null}
          </div>;
        })}</div>
        {rowFeedback ? <p className="vision-picker-status failure" role="alert">{rowFeedback}</p> : null}
        {editingEndpoint ? <form className="vision-api-editor" onSubmit={(event) => void saveCredential(event)}>
          <label><span>{wallets[editingEndpoint]?.apiKeyLabel ?? (editingEndpoint === "xai" ? "XAI_API_KEY / GROK_API_KEY" : "GOOGLE_API_KEY / GEMINI_API_KEY")}</span><input autoFocus type="password" value={apiKey} minLength={8} maxLength={8192} autoComplete="new-password" spellCheck={false} placeholder="Paste API key" onChange={(event) => setApiKey(event.target.value)}/></label>
          {credentialError ? <p role="alert">{credentialError}</p> : null}
          <div><button type="button" disabled={credentialBusy} onClick={() => { setEditingEndpoint(null); setApiKey(""); setCredentialError(""); }}>Cancel</button>{wallets[editingEndpoint]?.apiKeyConfigured === true ? <button type="button" className="vision-api-remove" disabled={credentialBusy} onClick={() => void removeCredential()}>Remove key</button> : null}<button className="primary" type="submit" disabled={credentialBusy || apiKey.trim().length < 8}>{credentialBusy ? <><span className="spinner" /> Checking</> : "Save and use now"}</button></div>
        </form> : null}
      </section>
    </div>
    <footer><button type="button" disabled={saving} onClick={() => onClose()}>{action === "settings" ? "Cancel" : "Not now"}</button>{savedSelection !== undefined ? <button type="button" disabled={saving} onClick={() => void disable()}>Turn off</button> : null}<button className="primary" type="button" disabled={!draftChanged || saving || statusDiscovery !== "ready"} onClick={() => void configure()}>{saving ? <span className="spinner" /> : <CheckIcon />} Use as eyes</button></footer>
  </section>;
}

export function earsRoutesFromSnapshot(snapshot: DesktopSnapshot): readonly EarsAudioRoute[] {
  return snapshot.providers.flatMap((provider) => {
    if (provider.state !== "online" || !provider.detected || provider.authenticated === false) return [];
    return (snapshot.models[provider.id] ?? []).flatMap((model) => {
      if (model.walletKind === "user_api" && (model.apiKeyConfigured !== true || model.apiKeyVerified !== true)) return [];
      const route = {
        providerId: provider.id,
        modelId: model.id,
        displayName: model.name,
        inputModalities: model.inputModalities ?? [],
        efforts: model.efforts,
      };
      return routeAcceptsEarsAudio(route) ? [route] : [];
    });
  });
}

const goalLabels: Record<SessionGoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Stalled",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

function compactGoalTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toLocaleString();
}

function GoalSettingsPanel({ session, goal, goalClearRevision, notify, onGoal, onClose, panelRef }: {
  session: Session;
  goal: SessionGoal | null;
  goalClearRevision: number;
  notify: (message: string, tone?: "normal" | "error") => void;
  onGoal: (goal: SessionGoal | null, clearRevision?: number, expectedRevision?: number) => void;
  onClose: () => void;
  panelRef: RefObject<HTMLElement | null>;
}) {
  const [saving, setSaving] = useState(false);
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [budget, setBudget] = useState(goal?.tokenBudget?.toString() ?? "");
  const objectiveInput = useRef<HTMLTextAreaElement>(null);
  const mutationGeneration = useRef(0);
  const onGoalRef = useRef(onGoal);
  const latestGoal = useRef(goal);
  const latestClearRevision = useRef(goalClearRevision);
  const advisoryBudget = goal?.source === "tethoq" || (goal === null && session.providerId !== "codex");
  const markLocalEdit = () => { mutationGeneration.current += 1; };
  onGoalRef.current = onGoal;
  latestGoal.current = goal;
  latestClearRevision.current = goalClearRevision;

  useEffect(() => {
    let disposed = false;
    const requestGeneration = mutationGeneration.current;
    const expectedRevision = goal?.revision ?? -1;
    void loadSessionGoal(session.id).then((loaded) => {
      if (disposed || mutationGeneration.current !== requestGeneration) return;
      onGoalRef.current(loaded, undefined, expectedRevision);
      setObjective(loaded?.objective ?? "");
      setBudget(loaded?.tokenBudget?.toString() ?? "");
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [goal?.revision, session.id]);
  useLayoutEffect(() => {
    objectiveInput.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => objectiveInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [session.id]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!panelRef.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [onClose, panelRef]);

  const mutate = async (update: { objective?: string; status?: SessionGoalStatus; tokenBudget?: number | null }, success: string): Promise<boolean> => {
    mutationGeneration.current += 1;
    setSaving(true);
    try {
      const next = await setSessionGoal(session.id, update);
      if (next.revision <= latestClearRevision.current || (latestGoal.current !== null && next.revision < latestGoal.current.revision)) return false;
      onGoal(next);
      setObjective(next.objective);
      setBudget(next.tokenBudget?.toString() ?? "");
      notify(success);
      return true;
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); return false; }
    finally { setSaving(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = objective.trim();
    if (!trimmed) { notify("Enter a goal", "error"); return; }
    const parsedBudget = budget.trim() ? Number.parseInt(budget, 10) : null;
    if (parsedBudget !== null && (!Number.isSafeInteger(parsedBudget) || parsedBudget <= 0)) { notify("Token budget must be a positive whole number", "error"); return; }
    if (await mutate({ objective: trimmed, tokenBudget: parsedBudget, ...(goal ? {} : { status: "active" }) }, goal ? "Goal updated" : "Goal started")) onClose();
  };
  const clear = async () => {
    mutationGeneration.current += 1;
    setSaving(true);
    try {
      const result = await clearSessionGoal(session.id);
      const superseded = latestGoal.current !== null && latestGoal.current.revision > result.revision;
      if (result.cleared && !superseded) onGoal(null, result.revision);
      onClose();
      notify(superseded ? "Goal changed elsewhere" : result.cleared ? "Goal cleared" : "Goal was already clear");
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setSaving(false); }
  };
  const label = goal ? goalLabels[goal.status] : "Set goal";

  return <section className="goal-popover composer-goal-panel" role="dialog" aria-modal="false" aria-label="Task goal" ref={panelRef}>
    <header><div><strong>{goal ? "Task goal" : "Set a goal"}</strong>{goal ? <span className={`goal-state goal-state-${goal.status}`}>{label}</span> : null}</div><button type="button" aria-label="Close goal controls" onClick={onClose}><XIcon /></button></header>
    <form onSubmit={(event) => void save(event)}>
      <label><span>Objective</span><textarea ref={objectiveInput} value={objective} maxLength={4000} rows={3} onChange={(event) => { markLocalEdit(); setObjective(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="What should this task keep working toward?" /></label>
      <label className="goal-budget"><span>{advisoryBudget ? "Token target" : "Token budget"} <small>{advisoryBudget ? "advisory" : "optional"}</small></span><input type="number" min={1} step={1} value={budget} onChange={(event) => { markLocalEdit(); setBudget(event.target.value); }} placeholder="No limit" /></label>
      <div className="goal-primary-actions"><button className="button button-primary" type="submit" disabled={saving || !objective.trim()}>{goal ? "Save" : "Start goal"}</button></div>
    </form>
    {goal ? <div className="goal-lifecycle" aria-label="Goal lifecycle actions">
      {goal.status === "active" ? <button className="button button-ghost" type="button" disabled={saving} onClick={() => void mutate({ status: "paused" }, "Goal paused")}>Pause</button>
        : <button className="button button-ghost" type="button" disabled={saving} onClick={() => void mutate({ status: "active" }, goal.status === "complete" ? "Goal reopened" : "Goal resumed")}>{goal.status === "complete" ? "Reopen" : "Resume"}</button>}
      {goal.status !== "blocked" ? <button className="button button-ghost" type="button" disabled={saving} onClick={() => void mutate({ status: "blocked" }, "Goal marked stalled")}>Mark stalled</button> : null}
      {goal.status !== "complete" ? <button className="button button-ghost" type="button" disabled={saving} onClick={() => void mutate({ status: "complete" }, "Goal completed")}>Complete</button> : null}
      <button className="button button-danger" type="button" disabled={saving} onClick={() => void clear()}>Clear</button>
    </div> : null}
    {goal && (goal.tokenBudget !== null || goal.tokensUsed > 0 || goal.timeUsedSeconds > 0) ? <dl className="goal-usage">
      {goal.tokenBudget !== null ? <div><dt>{goal.source === "tethoq" ? "Advisory target" : "Budget"}</dt><dd>{compactGoalTokens(goal.tokenBudget)} tokens</dd></div> : null}
      {goal.tokensUsed > 0 ? <div><dt>Used</dt><dd>{compactGoalTokens(goal.tokensUsed)} tokens</dd></div> : null}
      {goal.timeUsedSeconds > 0 ? <div><dt>Elapsed</dt><dd>{Math.max(1, Math.round(goal.timeUsedSeconds / 60))} min</dd></div> : null}
    </dl> : null}
  </section>;
}

function EarsSettingsPanel({ settings, routes, onChange, onClose, panelRef }: {
  settings: EarsSettings;
  routes: readonly EarsAudioRoute[];
  onChange: (value: EarsSettings) => void;
  onClose: () => void;
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  const selected = routes.find((route) => route.providerId === settings.providerId && route.modelId === settings.modelId);
  const effort = selected ? lowestReasoningEffort(selected.efforts) : undefined;
  const effortNote = reasoningLabelForNote(effort, selected ? { providerId: selected.providerId, modelId: selected.modelId, displayName: selected.displayName } : {});
  return <div className="ears-settings" role="dialog" aria-label="EARS settings" ref={panelRef} onKeyDownCapture={(event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <header>
      <span><strong>EARS</strong><small>Dictation audio is sent to this model first. The destination agent receives only the resulting text.</small></span>
      <button type="button" aria-label="Close EARS settings" onClick={onClose}><XIcon /></button>
    </header>
    <label className="ears-toggle">
      <input autoFocus type="checkbox" checked={settings.enabled} onChange={(event) => onChange({ ...settings, enabled: event.target.checked })} />
      <span>Preprocess dictation before send</span>
    </label>
    <label>
      <span>Model</span>
      <select
        aria-label="EARS model"
        value={selected ? `${selected.providerId}:${selected.modelId}` : ""}
        disabled={routes.length === 0}
        onChange={(event) => {
          const [providerId, ...rest] = event.target.value.split(":");
          const modelId = rest.join(":");
          onChange({ ...settings, enabled: true, providerId: providerId || null, modelId: modelId || null });
        }}
      >
        <option value="">{routes.length ? "Choose an audio-capable model" : "No audio-capable model is available"}</option>
        {routes.map((route) => <option key={`${route.providerId}:${route.modelId}`} value={`${route.providerId}:${route.modelId}`}>{route.displayName}</option>)}
      </select>
    </label>
    <fieldset>
      <legend>Processing</legend>
      <label><input type="radio" name="ears-mode" checked={settings.mode === "cleaned"} onChange={() => onChange({ ...settings, mode: "cleaned" })} /><span><strong>Cleaned</strong><small>Turn the recording into a clear written prompt while keeping the speaker’s meaning.</small></span></label>
      <label><input type="radio" name="ears-mode" checked={settings.mode === "verbatim"} onChange={() => onChange({ ...settings, mode: "verbatim" })} /><span><strong>Verbatim</strong><small>Transcribe the recording as faithfully as possible.</small></span></label>
    </fieldset>
    {effortNote ? <p className="ears-reasoning-note">Uses {effortNote} reasoning automatically</p> : null}
  </div>;
}

const activeComposerDeliveries = new Map<string, symbol>();
const composerDeliveryListeners = new Map<string, Set<(active: boolean) => void>>();

function beginComposerDelivery(sessionId: string): symbol | null {
  if (activeComposerDeliveries.has(sessionId)) return null;
  const token = Symbol(sessionId);
  activeComposerDeliveries.set(sessionId, token);
  for (const listener of composerDeliveryListeners.get(sessionId) ?? []) listener(true);
  return token;
}

function finishComposerDelivery(sessionId: string, token: symbol): void {
  if (activeComposerDeliveries.get(sessionId) !== token) return;
  activeComposerDeliveries.delete(sessionId);
  for (const listener of composerDeliveryListeners.get(sessionId) ?? []) listener(false);
}

function subscribeToComposerDelivery(sessionId: string, listener: (active: boolean) => void): () => void {
  const listeners = composerDeliveryListeners.get(sessionId) ?? new Set<(active: boolean) => void>();
  listeners.add(listener);
  composerDeliveryListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) composerDeliveryListeners.delete(sessionId);
  };
}

export function Composer({ snapshot, session, workingBoundary, stopPresentationActive = false, request, selectImages, preview, notify, updateSnapshot, onHydrateProviderModels, onBeforeSubmit, onBrowser, onManageWorkflow, initialDraft, onDraftChange, initialAttachments = [], onAttachmentsChange, initialWorkflowAttachments = [], onWorkflowAttachmentsChange, initialAnnotations = [], onAnnotationsChange, initialMode = "queue", onModeChange, initialMeshTargets = [], onMeshTargetsChange, initialDelegationDraft, onDelegationDraftChange, draftRestoreRevision = 0, onRestoreFailedSubmission, onDerivedSession, onDraftSelectionChange, onCreateDraftSend, onMaterializeDraft, pendingAction = null, onPendingActionConsumed, onCreateDraftSchedule, draftScheduleAttempt = null, onRetainDraftScheduleAttempt, experimental, onInstantSession, onCreateSideChat, onContextHandoff, queueRevision = 0, queueingEnabled, onQueueingEnabledChange, agentDefaults = {}, ears = defaultEarsSettings, onEarsChange, goal = null, goalClearRevision = -1, onGoal, visionStatus, readVisionStatus, onInterrupt }: ComposerProps) {
  const activeSessionId = useRef(session.id);
  activeSessionId.current = session.id;
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => prewarmAttachmentEncodingWorker());
    return () => cancelAnimationFrame(frame);
  }, []);
  const [content, setContent] = useState(initialDraft);
  const contentRef = useRef(initialDraft);
  const draftChangeRef = useRef(onDraftChange);
  const attachmentsChangeRef = useRef(onAttachmentsChange);
  const workflowAttachmentsChangeRef = useRef(onWorkflowAttachmentsChange);
  const annotationsChangeRef = useRef(onAnnotationsChange);
  const restoreFailedSubmissionRef = useRef(onRestoreFailedSubmission);
  const draftSession = session.draft === true;
  const [mode, setModeState] = useState<"queue" | "steer" | "goal">(initialMode);
  const setMode = useCallback((next: "queue" | "steer" | "goal") => {
    setModeState(next);
    onModeChange?.(next);
  }, [onModeChange]);
  const goalArmed = mode === "goal";
  const goalIndicatorVisible = goalArmed || Boolean(goal);
  const onGoalRef = useRef(onGoal);
  onGoalRef.current = onGoal;
  useEffect(() => {
    if (draftSession || !onGoalRef.current) return;
    let disposed = false;
    const expectedRevision = goal?.revision ?? -1;
    void loadSessionGoal(session.id).then((loaded) => {
      if (!disposed) onGoalRef.current?.(loaded, undefined, expectedRevision);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [session.id, draftSession]);
  const [providerId, setProviderId] = useState(session.providerId);
  const switchingHarness = !draftSession && providerId !== session.providerId;
  const modelSwitchAttempt = useRef<{ key: string; requestId: string } | null>(null);
  const models = snapshot.models[providerId] ?? [];
  const initialSelection = draftSession
    ? resolveConcreteModelSelection(models, { modelId: session.model, reasoningEffort: session.effort }, agentDefaults[session.providerId])
    : resolveReportedSessionSelection(models, { modelId: session.model, reasoningEffort: session.effort }, agentDefaults[session.providerId]);
  const [model, setModel] = useState(initialSelection?.modelId ?? resolveComposerModelId(models, session.model));
  const [effort, setEffort] = useState(initialSelection?.reasoningEffort ?? "");
  const reportedSelectionKey = `${session.providerId}\u0000${session.model}\u0000${session.effort}`;
  const selectionEditedLocally = useRef(false);
  const selectionRevision = useRef(0);
  const [acceptedSelectionRevision, setAcceptedSelectionRevision] = useState(0);
  // The provider can correct a task's model after the Composer is already
  // mounted. Apply every genuinely new reported selection, and re-resolve it
  // when its catalogue arrives, while leaving an unsent local choice alone on
  // unrelated refreshes.
  useEffect(() => {
    if (draftSession) return;
    if (selectionEditedLocally.current) return;
    const reportedModels = snapshot.models[session.providerId] ?? [];
    const resolved = resolveReportedSessionSelection(
      reportedModels,
      { modelId: session.model, reasoningEffort: session.effort },
      agentDefaults[session.providerId],
    );
    const nextModel = resolved?.modelId ?? resolveComposerModelId(reportedModels, session.model);
    const nextEffort = resolved?.reasoningEffort
      ?? (isAmbiguousSelectionValue(session.effort) ? "" : session.effort);
    selectionEditedLocally.current = false;
    setProviderId(session.providerId);
    setModel(nextModel);
    setEffort(nextEffort);
  }, [acceptedSelectionRevision, agentDefaults, draftSession, reportedSelectionKey, session.effort, session.model, session.providerId, snapshot.models]);
  useEffect(() => {
    if (!draftSession || providerId === session.providerId) return;
    const reportedModels = snapshot.models[session.providerId] ?? [];
    const resolved = resolveConcreteModelSelection(
      reportedModels,
      { modelId: session.model, reasoningEffort: session.effort },
      agentDefaults[session.providerId],
    );
    setProviderId(session.providerId);
    setModel(resolved?.modelId ?? resolveComposerModelId(reportedModels, session.model));
    setEffort(resolved?.reasoningEffort ?? "");
  }, [agentDefaults, draftSession, providerId, session.effort, session.model, session.providerId, snapshot.models]);
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(() => initialAttachments);
  const attachmentsRef = useRef<readonly ComposerAttachment[]>(initialAttachments);
  const [annotations, setAnnotations] = useState<readonly ResponseAnnotation[]>(() => initialAnnotations);
  const annotationsRef = useRef<readonly ResponseAnnotation[]>(initialAnnotations);
  const commitAnnotations = useCallback((update: readonly ResponseAnnotation[] | ((current: readonly ResponseAnnotation[]) => readonly ResponseAnnotation[])) => {
    const next = typeof update === "function" ? update(annotationsRef.current) : update;
    annotationsRef.current = next;
    setAnnotations(next);
    // Removal must reach the per-task draft before another selection can open
    // the editor. A passive mirror leaves a frame where recreation appends to
    // the annotation the reader just removed, painting and sending two chips.
    annotationsChangeRef.current?.(next);
  }, []);
  const [annotationEditor, setAnnotationEditor] = useState<{ annotation: ResponseAnnotation; anchor: { x: number; y: number } } | null>(null);
  const dictationControl = useRef<DictationControlHandle>(null);
  const [dictationPhase, setDictationPhase] = useState<"idle" | "recording" | "transcribing" | "audio-recording">("idle");
  const sendAfterDictation = useRef(false);
  const [workflowAttachments, setWorkflowAttachments] = useState<readonly WorkflowAttachment[]>(() => initialWorkflowAttachments);
  const workflowAttachmentsRef = useRef<readonly WorkflowAttachment[]>(initialWorkflowAttachments);
  const [meshTargets, setMeshTargetsState] = useState<readonly MeshTarget[]>(() => anchorMeshTargets(initialMeshTargets));
  const meshTargetsRef = useRef<readonly MeshTarget[]>(meshTargets);
  const setMeshTargets = useCallback((update: readonly MeshTarget[] | ((current: readonly MeshTarget[]) => readonly MeshTarget[])) => {
    const next = anchorMeshTargets(typeof update === "function" ? update(meshTargetsRef.current) : update);
    meshTargetsRef.current = next;
    setMeshTargetsState(next);
    onMeshTargetsChange?.(next);
  }, [onMeshTargetsChange]);
  const meshKnownTargets = useRef<readonly MeshTarget[]>(meshTargets);
  for (const target of meshTargets) {
    meshKnownTargets.current = [...meshKnownTargets.current.filter((item) => item.composerToken !== target.composerToken), target];
  }
  const [meshEditingToken, setMeshEditingToken] = useState<string | null>(null);
  const commitContent = useCallback((update: string | ((current: string) => string), targets?: readonly MeshTarget[]) => {
    const next = typeof update === "function" ? update(contentRef.current) : update;
    setMeshTargets(targets ?? moveMeshTargets(contentRef.current, next, meshTargetsRef.current));
    contentRef.current = next;
    setContent(next);
    draftChangeRef.current(next);
    return next;
  }, [setMeshTargets]);
  const commitAttachments = useCallback((update: readonly ComposerAttachment[] | ((current: readonly ComposerAttachment[]) => readonly ComposerAttachment[])) => {
    const next = typeof update === "function" ? update(attachmentsRef.current) : update;
    attachmentsRef.current = next;
    setAttachments(next);
    attachmentsChangeRef.current?.(next);
    return next;
  }, []);
  const commitWorkflowAttachments = useCallback((update: readonly WorkflowAttachment[] | ((current: readonly WorkflowAttachment[]) => readonly WorkflowAttachment[])) => {
    const next = typeof update === "function" ? update(workflowAttachmentsRef.current) : update;
    workflowAttachmentsRef.current = next;
    setWorkflowAttachments(next);
    workflowAttachmentsChangeRef.current?.(next);
    return next;
  }, []);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [materializingAction, setMaterializingAction] = useState<ComposerTaskAction | null>(null);
  const materializingActionRef = useRef<ComposerTaskAction | null>(null);
  const [goalOpen, setGoalOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [earsOpen, setEarsOpen] = useState(false);
  const [earsBusy, setEarsBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const earsRequestId = useRef<string | null>(null);
  const earsCancelled = useRef(false);
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
  const [visionAction, setVisionAction] = useState<VisionPickerMode | null>(null);
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [delegationDraft, setDelegationDraft] = useState<DelegationDraft | undefined>(initialDelegationDraft);
  const commitDelegationDraft = useCallback((next: DelegationDraft | null) => {
    setDelegationDraft(next ?? undefined);
    onDelegationDraftChange?.(next);
  }, [onDelegationDraftChange]);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [meshOpen, setMeshOpen] = useState(false);
  const [meshModelPicker, setMeshModelPicker] = useState<Session["providerId"] | null>(null);
  const [meshSelection, setMeshSelection] = useState(0);
  const [meshRecentRevision, setMeshRecentRevision] = useState(0);
  const [meshMentionSelection, setMeshMentionSelection] = useState(0);
  const [meshMentionDismissed, setMeshMentionDismissed] = useState(false);
  const meshHydrationAttempted = useRef(new Set<Session["providerId"]>());
  const [attachmentPreview, setAttachmentPreview] = useState<{ readonly name: string; readonly dataUrl: string } | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<readonly QueuedMessageView[]>([]);
  const queuedMessagesGeneration = useRef(0);
  useEffect(() => () => { queuedMessagesGeneration.current += 1; }, []);
  const queuedSteerDeliveries = useRef(new Set<string>());
  const queuedDraftRestorations = useRef(new Set<string>());
  const transportQueueSuppressions = useRef<readonly TransportQueueSuppression[]>([]);
  const [queuedNewTaskMessage, setQueuedNewTaskMessage] = useState<QueuedMessageView | null>(null);
  const [cancellingQueuedId, setCancellingQueuedId] = useState<string | null>(null);
  const [updatingQueuedId, setUpdatingQueuedId] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [sending, setSending] = useState(() => activeComposerDeliveries.has(session.id));
  const sendingRef = useRef(activeComposerDeliveries.has(session.id));
  const appliedDraftRestoreRevision = useRef(draftRestoreRevision);
  const [interrupting, setInterrupting] = useState(false);
  const [simplifySettings, setSimplifySettings] = useState<SimplifySettings>(() => storedSimplifySettings());
  const [simplifyOpen, setSimplifyOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState(() => draftScheduleAttempt
    ? draftScheduleLocalValue(new Date(draftScheduleAttempt.input.runAt))
    : defaultDraftScheduleLocalValue());
  const [scheduleFailure, setScheduleFailure] = useState<string | null>(draftScheduleAttempt?.failure ?? null);
  const [scheduleBusy, setScheduleBusy] = useState(draftScheduleAttempt?.inFlight === true);
  const [scheduleRetryPending, setScheduleRetryPending] = useState(draftScheduleAttempt !== null && !draftScheduleAttempt.inFlight);
  const scheduleBusyRef = useRef(draftScheduleAttempt?.inFlight === true);
  const scheduleAttempt = useRef<DraftSessionScheduleInput | null>(draftScheduleAttempt?.input ?? null);
  const [slashSelection, setSlashSelection] = useState(0);
  const [slashPaletteDismissed, setSlashPaletteDismissed] = useState(false);
  const [composerCaret, setComposerCaret] = useState<number | null>(null);
  const slashListId = useId();
  const meshListId = useId();
  const meshMentionListId = useId();
  const scheduleFieldId = useId();
  const scheduleTitleId = useId();
  const textarea = useRef<ComposerTextInput>(null);
  const scheduleField = useRef<HTMLInputElement>(null);
  const schedulePanel = useRef<HTMLFormElement>(null);
  const goalPanel = useRef<HTMLElement>(null);
  const earsPanel = useRef<HTMLDivElement>(null);
  const meshPanel = useRef<HTMLDivElement>(null);
  const meshModelPanel = useRef<HTMLDivElement>(null);
  const composerBox = useRef<HTMLDivElement>(null);
  const composerEntryRow = useRef<HTMLDivElement>(null);
  const attachmentList = useRef<HTMLDivElement>(null);
  const audioStripHost = useRef<HTMLDivElement>(null);
  const interruptingRef = useRef(false);
  const promptHistory = useRef<readonly string[]>(storedPromptHistory());
  const historyIndex = useRef<number | null>(null);
  const unsentHistoryDraft = useRef(initialDraft);
  useEffect(() => {
    const attempt = draftScheduleAttempt?.input ?? null;
    const inFlight = draftScheduleAttempt?.inFlight === true;
    scheduleAttempt.current = attempt;
    scheduleBusyRef.current = inFlight;
    setScheduleBusy(inFlight);
    setScheduleRetryPending(attempt !== null && !inFlight);
    setScheduleFailure(draftScheduleAttempt?.failure ?? null);
    if (attempt) setScheduleValue(draftScheduleLocalValue(new Date(attempt.runAt)));
  }, [draftScheduleAttempt]);
  const chosenModel = models.find((item) => item.id === model);
  const efforts = [...new Set([...(chosenModel?.efforts ?? []).filter((item) => !isAmbiguousSelectionValue(item)), ...(!isAmbiguousSelectionValue(effort) ? [effort] : [])])];
  const provider = providerFor(snapshot.providers, providerId);
  const audioDictationAvailable = providerAcceptsDirectAudio(providerId) && modelAcceptsDirectAudio(chosenModel);
  // Recording an MP3 is offered wherever the clip can reach the model: either the
  // model hears it directly, or EARS transcribes it first. Gating the control on
  // direct audio alone hid the microphone from every text-only harness.
  const earsCanCarryAudio = ears.enabled && earsRoutesFromSnapshot(snapshot).length > 0;
  const audioRecordingAvailable = audioDictationAvailable || earsCanCarryAudio;
  const timeline = snapshot.timelines[session.id] ?? [];
  const holdsFollowUpQueue = !stopPresentationActive && sessionHoldsFollowUpQueue(session, timeline, workingBoundary);
  const turnInFlight = useRef(false);
  const canSend = canSendToProvider(provider, { draft: draftSession, canCreateDraft: onCreateDraftSend !== undefined });
  /**
   * Ask the harness itself, rather than trusting what we last wrote down.
   *
   * Whether a coding tool can take a message is read from a snapshot the window
   * holds, and that snapshot is only rebuilt on a few occasions. Any moment the
   * tool could not answer - a restart, a stalled read, a probe that lost a race
   * with the server this app starts - is written into it, and it stays written
   * until something happens to rebuild it. So a tool that is up and healthy could
   * sit there refusing to be written to, which no amount of waiting fixed. A
   * stale note is not allowed to be the last word on this: the tool is asked
   * again, and only its own answer can refuse the message.
   */
  const reverifyProvider = useCallback(async (): Promise<Provider | undefined> => {
    const providers = await refreshProviders();
    const fresh = providers.find((entry) => entry.id === providerId);
    // Only this provider is written back, so a connector the workspace has
    // deliberately hidden cannot reappear on the strength of a send.
    if (fresh) updateSnapshot((current) => current ? { ...current, providers: current.providers.map((entry) => entry.id === fresh.id ? fresh : entry) } : current);
    return fresh;
  }, [providerId, updateSnapshot]);
  // A composer that believes it cannot send checks that belief once, immediately,
  // so the control comes back on its own instead of waiting for a relaunch.
  useEffect(() => {
    if (canSend || preview) return;
    let abandoned = false;
    void reverifyProvider().catch(() => undefined).finally(() => { if (abandoned) return; });
    return () => { abandoned = true; };
  }, [canSend, preview, reverifyProvider]);
  const canSteer = !draftSession && !switchingHarness && canSend && holdsFollowUpQueue && session.state === "working" && provider?.capabilities.includes("Steering") === true;
  const canInterrupt = !draftSession && holdsFollowUpQueue && providerFor(snapshot.providers, session.providerId)?.capabilities.includes("Interrupt") === true && onInterrupt !== undefined;
  const canAttach = provider?.supportsAttachments === true && (canSend || session.provisional === true);
  const canAttachFiles = provider?.supportsAttachments === true && (canSend || session.provisional === true) && supportsGenericFileAttachments(providerId);
  const canDelegate = snapshot.providers.some((item) => item.id !== session.providerId && item.state === "online" && item.capabilities.includes("Create Session") && item.capabilities.includes("Send Message"));
  const meshProviderOptions = useMemo(() => availableMeshProviders(snapshot, meshTargets), [meshTargets, snapshot]);
  const sessionRecentMeshTargets = useMemo(() => meshRecentTargetsForSession(session.id), [meshRecentRevision, session.id]);
  const meshQuickTargets = useMemo(() => new Map(meshProviderOptions.map((candidate) => {
    const recent = sessionRecentMeshTargets.find((target) => target.providerId === candidate.id);
    return [candidate.id, resolveMeshTargetSelection(snapshot, candidate.id, recent, agentDefaults)] as const;
  })), [agentDefaults, meshProviderOptions, sessionRecentMeshTargets, snapshot]);
  const safeMeshSelection = meshProviderOptions.length ? Math.min(meshSelection, meshProviderOptions.length - 1) : 0;
  const activeMeshProvider = meshProviderOptions[safeMeshSelection];
  const meshPickerProvider = meshModelPicker === null ? null : providerFor(snapshot.providers, meshModelPicker);
  const meshEditingTarget = meshPickerProvider ? meshTargets.find((target) => target.composerToken === meshEditingToken) : undefined;
  const meshPickerInitialTarget = meshPickerProvider ? meshQuickTargets.get(meshPickerProvider.id) : undefined;
  const compositionHasContent = removeSlashCommandToken(removeSlashCommandToken(content, "/mesh"), "/schedule").trim().length > 0
    || annotations.length > 0
    || attachments.length > 0
    || workflowAttachments.length > 0
    || meshTargets.length > 0;
  const simplifyCommand = useMemo(() => parseSimplifyCommand(content), [content]);
  const editorContent = meshEditorValue(content, meshTargets);
  const meshMention = meshMentionAtCaret(editorContent, composerCaret ?? editorContent.length);
  const recentMentionModels = useMemo(() => recentMeshModels(), [meshRecentRevision, session.id, meshMention?.start]);
  const meshMentionOptions = useMemo(() => meshTargets.length >= maximumMeshTargets ? []
    : matchingRecentMeshModels(snapshot, recentMentionModels, meshMention?.query ?? ""), [meshTargets.length, snapshot, recentMentionModels, meshMention?.query]);
  const meshMentionVisible = meshMention !== null && !meshMentionDismissed && !meshOpen && meshModelPicker === null;
  const safeMeshMentionSelection = Math.min(meshMentionSelection, Math.max(0, meshMentionOptions.length - 1));
  const commandContent = editorContent.replace(/[\uE000-\uF8FF]/gu, " ");
  const slashPrefix = commandContent.slice(0, Math.max(0, composerCaret ?? commandContent.length));
  const slashSuggestions = useMemo(() => {
    const suggestions = slashCommandSuggestions(slashPrefix);
    return suggestions?.filter((command) => draftSession || command.id !== "schedule") ?? suggestions;
  }, [slashPrefix, draftSession]);
  // Once /mesh is a complete command, its compact chooser owns Arrow/Enter.
  // Keeping the partial-command palette open as well made those keys ambiguous.
  const slashPaletteVisible = !slashPaletteDismissed && (slashSuggestions?.length ?? 0) > 0 && !hasSlashCommandToken(commandContent, "/mesh");
  const simplifyPreset = [100, 200, 300].includes(simplifySettings.maxWords) ? String(simplifySettings.maxWords) : "custom";
  const scheduleTime = validateDraftScheduleLocalValue(scheduleValue);
  const scheduleError = scheduleFailure ?? (scheduleRetryPending ? null : scheduleTime.error);

  const loadQueuedMessages = useCallback(async (): Promise<boolean> => {
    const generation = ++queuedMessagesGeneration.current;
    if (draftSession) { setQueuedMessages([]); return true; }
    try {
      const result = await request("message_queue.list", { sessionId: session.id });
      if (generation !== queuedMessagesGeneration.current || activeSessionId.current !== session.id) return true;
      const messages = queuedMessagesForSession(result, session.id);
      const visible = visibleTransportQueueMessages(messages, transportQueueSuppressions.current)
        .filter((message) => !queuedSteerDeliveries.current.has(message.id));
      forgetMissingQueuedAttachmentPreviews(session.id, visible);
      setQueuedMessages(visible);
      return true;
    } catch {
      // Queue visibility is opportunistic; send failures still surface through the normal composer notice.
      return false;
    }
  }, [draftSession, request, session.id]);

  useEffect(() => { if (mode === "steer" && !canSteer) setMode("queue"); }, [canSteer, mode]);
  useEffect(() => {
    if (stopPresentationActive || !sessionHoldsFollowUpQueue(session, snapshot.timelines[session.id] ?? [], workingBoundary)) turnInFlight.current = false;
  }, [session, snapshot.timelines, stopPresentationActive, workingBoundary]);
  useEffect(() => {
    if (!draftSession || models.length === 0 || models.some((item) => item.id === model) && !isAmbiguousSelectionValue(effort)) return;
    const selection = resolveConcreteModelSelection(models, { modelId: model, reasoningEffort: effort }, agentDefaults[providerId]);
    if (!selection) return;
    const nextEffort = selection.reasoningEffort ?? "";
    if (selection.modelId === model && nextEffort === effort) return;
    setModel(selection.modelId);
    setEffort(nextEffort);
    if (draftSession) onDraftSelectionChange?.({ providerId, modelId: selection.modelId, effort: nextEffort });
  }, [agentDefaults, draftSession, effort, model, models, onDraftSelectionChange, providerId]);
  const resizeTextarea = useCallback(() => {
    const target = textarea.current;
    if (!target) return;
    const composerLimit = Math.max(112, Math.floor(window.innerHeight * 0.4));
    const attachmentHeight = attachmentList.current ? Math.min(attachmentList.current.scrollHeight, Math.floor(composerLimit * 0.42)) : 0;
    // Budget only the live recording row so a long draft keeps as much of the
    // remaining composer height as possible.
    const recordingStripHeight = audioStripHost.current?.clientHeight ?? 0;
    const availableHeight = Math.max(42, composerLimit - attachmentHeight - recordingStripHeight - 20);
    growTextarea(target, availableHeight);
    const box = composerBox.current;
    if (box) {
      // The SVG outline catches up through ResizeObserver. Its previous height
      // must not count as content overflow while a picker closes.
      // The row can shrink without shrinking the editor, so measure both.
      const inputBottom = Math.max(target.getBoundingClientRect().bottom, composerEntryRow.current?.getBoundingClientRect().bottom ?? 0);
      const overflow = Math.max(0, inputBottom + parseFloat(getComputedStyle(box).paddingBottom) - box.getBoundingClientRect().bottom);
      if (overflow > 0.5) growTextarea(target, Math.max(42, target.getBoundingClientRect().height - Math.ceil(overflow)));
    }
  }, []);
  const removeAttachment = useCallback((path: string) => {
    const removed = attachmentsRef.current.find((item) => item.path === path);
    if (removed?.previewUrl) {
      setAttachmentPreview((previewValue) => previewValue?.dataUrl === removed.previewUrl ? null : previewValue);
      URL.revokeObjectURL(removed.previewUrl);
    }
    commitAttachments((current) => current.filter((item) => item.path !== path));
  }, [commitAttachments]);
  const previewAttachment = useCallback((attachment: { readonly name: string; readonly dataUrl: string }) => {
    setAttachmentPreview(attachment);
  }, []);
  useEffect(() => {
    const preparing = attachments.filter(isPreparingAttachment);
    if (!preparing.length) return;
    let active = true;
    const frames: number[] = [];
    const tasks: number[] = [];
    for (const attachment of preparing) {
      frames.push(requestAnimationFrame(() => {
        tasks.push(window.setTimeout(() => {
          if (!active) return;
          void attachment.preparation().then((uploadable) => {
            if (!active) return;
            const ready = finishPreparingAttachment(attachment, uploadable);
            commitAttachments((current) => current.map((candidate) => candidate === attachment ? ready : candidate));
          }).catch((error: unknown) => {
            if (!active) return;
            commitAttachments((current) => current.filter((candidate) => candidate !== attachment));
            if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
            notify(error instanceof Error ? error.message : String(error), "error");
          });
        }, 0));
      }));
    }
    return () => {
      active = false;
      for (const frame of frames) cancelAnimationFrame(frame);
      for (const task of tasks) window.clearTimeout(task);
    };
  }, [attachments, commitAttachments, notify]);
  useLayoutEffect(() => { resizeTextarea(); }, [attachments, content, dictationPhase, goalIndicatorVisible, meshTargets, resizeTextarea, workflowAttachments]);
  useEffect(() => {
    window.addEventListener("resize", resizeTextarea);
    return () => window.removeEventListener("resize", resizeTextarea);
  }, [resizeTextarea]);
  useEffect(() => { draftChangeRef.current = onDraftChange; }, [onDraftChange]);
  useEffect(() => { attachmentsChangeRef.current = onAttachmentsChange; }, [onAttachmentsChange]);
  useEffect(() => { workflowAttachmentsChangeRef.current = onWorkflowAttachmentsChange; }, [onWorkflowAttachmentsChange]);
  useEffect(() => { annotationsChangeRef.current = onAnnotationsChange; }, [onAnnotationsChange]);
  useEffect(() => { restoreFailedSubmissionRef.current = onRestoreFailedSubmission; }, [onRestoreFailedSubmission]);
  useEffect(() => subscribeToComposerDelivery(session.id, (active) => {
    sendingRef.current = active;
    setSending(active);
  }), [session.id]);
  useLayoutEffect(() => {
    if (appliedDraftRestoreRevision.current === draftRestoreRevision) return;
    appliedDraftRestoreRevision.current = draftRestoreRevision;
    contentRef.current = initialDraft;
    attachmentsRef.current = initialAttachments;
    workflowAttachmentsRef.current = initialWorkflowAttachments;
    annotationsRef.current = initialAnnotations;
    meshTargetsRef.current = anchorMeshTargets(initialMeshTargets);
    setContent(initialDraft);
    setComposerCaret(null);
    setAttachments(initialAttachments);
    setWorkflowAttachments(initialWorkflowAttachments);
    setAnnotations(initialAnnotations);
    setModeState(initialMode);
    setMeshTargetsState(meshTargetsRef.current);
    unsentHistoryDraft.current = initialDraft;
  }, [draftRestoreRevision, initialAnnotations, initialAttachments, initialDraft, initialMeshTargets, initialMode, initialWorkflowAttachments]);
  useLayoutEffect(() => {
    if (annotationsRef.current === initialAnnotations) return;
    annotationsRef.current = initialAnnotations;
    setAnnotations(initialAnnotations);
  }, [initialAnnotations]);
  useEffect(() => { void loadQueuedMessages(); }, [loadQueuedMessages, queueRevision]);
  useEffect(() => {
    try { localStorage.setItem(simplifySettingsKey, JSON.stringify(simplifySettings)); } catch { /* Preferences remain usable for this window. */ }
  }, [simplifySettings]);
  useEffect(() => { if (!simplifyCommand.active) setSimplifyOpen(false); }, [simplifyCommand.active]);
  useEffect(() => { setSlashSelection(0); }, [slashPrefix]);
  useEffect(() => { setMeshMentionSelection(0); setMeshMentionDismissed(false); }, [meshMention?.start, meshMention?.query]);
  const requestDraftAction = useCallback(async (action: ComposerTaskAction): Promise<void> => {
    setActionsOpen(false);
    if (!draftSession && action !== "model_switch_send") return;
    if (materializingActionRef.current !== null) return;
    if (!onMaterializeDraft) {
      notify("This local draft cannot be created right now.", "error");
      return;
    }
    materializingActionRef.current = action;
    setMaterializingAction(action);
    try {
      if (action === "model_switch_send") {
        const key = `${session.id}\u0000${providerId}\u0000${model}\u0000${effort}`;
        if (modelSwitchAttempt.current?.key !== key) modelSwitchAttempt.current = { key, requestId: crypto.randomUUID() };
      }
      await onMaterializeDraft({
        draftSessionId: session.id,
        ...(action === "model_switch_send" ? { requestId: modelSwitchAttempt.current!.requestId } : {}),
        providerId,
        workingDirectory: session.workingDirectory,
        modelId: model,
        effort,
      }, action);
    } catch (error) {
      if (mounted.current && activeSessionId.current === session.id) notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (materializingActionRef.current === action) materializingActionRef.current = null;
      if (mounted.current && activeSessionId.current === session.id) setMaterializingAction(null);
    }
  }, [draftSession, effort, model, notify, onMaterializeDraft, providerId, session.id, session.workingDirectory]);
  useEffect(() => {
    if (!draftSession) return;
    const action = hasSlashCommandToken(content, "/permission") ? "permission"
      : hasSlashCommandToken(content, "/eyes") ? "eyes"
        : null;
    if (action !== null) void requestDraftAction(action);
  }, [content, draftSession, requestDraftAction]);
  const openDraftSchedule = useCallback(() => {
    if (!draftSession) {
      notify("Scheduling is currently available for new tasks only.", "error");
      return;
    }
    setActionsOpen(false);
    setAttachmentsOpen(false);
    setGoalOpen(false);
    setEarsOpen(false);
    setScheduleFailure(draftScheduleAttempt?.failure ?? null);
    setScheduleValue((current) => scheduleAttempt.current
      ? draftScheduleLocalValue(new Date(scheduleAttempt.current.runAt))
      : draftScheduleLocalValueForOpen(current));
    setScheduleOpen(true);
    requestAnimationFrame(() => scheduleField.current?.focus());
  }, [draftScheduleAttempt?.failure, draftSession, notify]);
  const closeDraftSchedule = useCallback((restoreFocus = true) => {
    setScheduleOpen(false);
    setScheduleFailure(null);
    setMeshOpen(false);
    setMeshModelPicker(null);
    if (restoreFocus) requestAnimationFrame(() => textarea.current?.focus());
  }, []);
  useEffect(() => {
    if (!hasSlashCommandToken(content, "/schedule")) return;
    const next = removeSlashCommandToken(content, "/schedule");
    commitContent(next);
    historyIndex.current = null;
    unsentHistoryDraft.current = next;
    if (draftSession) openDraftSchedule();
    else notify("Scheduling is currently available for new tasks only.", "error");
  }, [commitContent, content, draftSession, notify, openDraftSchedule]);
  useEffect(() => {
    if (!hasSlashCommandToken(content, "/goal")) return;
    setMode("goal");
    const next = removeSlashCommandToken(content, "/goal");
    commitContent(next);
    historyIndex.current = null;
    unsentHistoryDraft.current = next;
  }, [commitContent, content, draftSession]);
  useEffect(() => {
    if (!hasSlashCommandToken(content, "/ears")) return;
    setEarsOpen(true);
    const next = removeSlashCommandToken(content, "/ears");
    commitContent(next);
    historyIndex.current = null;
    unsentHistoryDraft.current = next;
  }, [commitContent, content]);
  useEffect(() => {
    // Same shape as /ears: a settings route, not a message. Unlike the reactive
    // prompt, this opens whatever the task's current visual support is, because
    // asking for it is the user's explicit intent.
    if (draftSession || !hasSlashCommandToken(content, "/eyes")) return;
    setVisionAction("settings");
    const next = removeSlashCommandToken(content, "/eyes");
    commitContent(next);
    historyIndex.current = null;
    unsentHistoryDraft.current = next;
  }, [commitContent, content, draftSession]);
  useLayoutEffect(() => {
    // Opening the panel must not consume what the user typed. The command stays
    // in the composer and the panel is bound to that whitespace-delimited token,
    // wherever it appears in the draft. Referenced tools are not discarded when
    // the token goes away; they live on the composer as inline widgets.
    const matchesMeshCommand = hasSlashCommandToken(commandContent, "/mesh");
    setMeshOpen(matchesMeshCommand);
    if (!matchesMeshCommand) setMeshModelPicker(null);
  }, [commandContent]);
  useEffect(() => {
    if (!meshOpen) {
      meshHydrationAttempted.current.clear();
      return;
    }
    setMeshSelection(0);
    requestAnimationFrame(() => textarea.current?.focus());
  }, [meshOpen]);
  useEffect(() => {
    setMeshSelection((current) => meshProviderOptions.length ? Math.min(current, meshProviderOptions.length - 1) : 0);
  }, [meshProviderOptions.length]);
  useEffect(() => {
    if (!meshOpen) return;
    for (const candidate of meshProviderOptions) {
      if ((snapshot.models[candidate.id] ?? []).length > 0 || meshHydrationAttempted.current.has(candidate.id)) continue;
      meshHydrationAttempted.current.add(candidate.id);
      void onHydrateProviderModels(candidate.id).catch(() => undefined);
    }
  }, [meshOpen, meshProviderOptions, onHydrateProviderModels, snapshot.models]);
  const closeGoal = useCallback((restoreFocus = true) => {
    setGoalOpen(false);
    if (restoreFocus) {
      // Successful goal writes are observable through the Bridge before the
      // next paint. Reclaim focus immediately when dismissing, then reaffirm it
      // after React removes the panel so both keyboard flow and external UI
      // observers see the composer as the terminal focus owner.
      textarea.current?.focus();
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }, []);
  const closePermission = useCallback((restoreFocus = true) => {
    setPermissionOpen(false);
    if (restoreFocus) requestAnimationFrame(() => textarea.current?.focus());
  }, []);
  useEffect(() => {
    if (draftSession || !hasSlashCommandToken(content, "/permission")) return;
    setActionsOpen(false);
    setGoalOpen(false);
    setEarsOpen(false);
    setPermissionOpen(true);
    const next = removeSlashCommandToken(content, "/permission");
    commitContent(next);
    historyIndex.current = null;
    unsentHistoryDraft.current = next;
  }, [commitContent, content, setMode]);
  const closeEars = useCallback((restoreFocus = true) => {
    setEarsOpen(false);
    if (restoreFocus) requestAnimationFrame(() => textarea.current?.focus());
  }, []);
  const closeVision = useCallback((restoreFocus = true) => {
    setVisionAction(null);
    if (restoreFocus) requestAnimationFrame(() => textarea.current?.focus());
  }, []);
  const closeHandoff = useCallback((restoreFocus = true) => {
    setHandoffOpen(false);
    if (restoreFocus) requestAnimationFrame(() => textarea.current?.focus());
  }, []);
  const closeWorkflowPicker = useCallback((restoreFocus = true) => {
    setWorkflowPickerOpen(false);
    if (restoreFocus) requestAnimationFrame(() => textarea.current?.focus());
  }, []);
  const closeDelegation = useCallback((restoreFocus = true) => {
    setDelegationOpen(false);
    if (restoreFocus) requestAnimationFrame(() => textarea.current?.focus());
  }, []);
  const closeMesh = useCallback((restoreFocus = true) => {
    // Closing the chooser is not the same as abandoning the mesh. The chips stay
    // on the composer so the user can write the instruction they are for; each
    // chip removes itself, and sending clears them.
    setMeshOpen(false);
    setMeshMentionDismissed(true);
    setMeshModelPicker(null);
    if (restoreFocus) requestAnimationFrame(() => textarea.current?.focus());
  }, []);
  useEffect(() => {
    if (!earsOpen) return;
    const outside = (event: PointerEvent) => {
      if (!earsPanel.current?.contains(event.target as Node)) closeEars(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeEars();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [closeEars, earsOpen]);
  useEffect(() => {
    if (!scheduleOpen) return;
    const outside = (event: PointerEvent) => {
      if (schedulePanel.current?.contains(event.target as Node)) return;
      if (meshPanel.current?.contains(event.target as Node)) return;
      if (meshModelPanel.current?.contains(event.target as Node)) return;
      const target = event.target instanceof Element ? event.target : null;
      const willOwnFocus = target?.closest('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])') !== null;
      closeDraftSchedule(!willOwnFocus);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDraftSchedule();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [closeDraftSchedule, scheduleOpen]);
  useEffect(() => {
    if (!meshOpen && meshModelPicker === null && !meshMentionVisible) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMesh();
    };
    const outside = (event: PointerEvent) => {
      if (meshPanel.current?.contains(event.target as Node)) return;
      if (meshModelPanel.current?.contains(event.target as Node)) return;
      if (meshMentionVisible && textarea.current?.contains(event.target as Node)) return;
      const target = event.target instanceof Element ? event.target : null;
      const willOwnFocus = target?.closest('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])') !== null;
      closeMesh(!willOwnFocus);
    };
    window.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [closeMesh, meshModelPicker, meshOpen, meshMentionVisible]);
  useEffect(() => {
    if (!attachmentPreview) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setAttachmentPreview(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [attachmentPreview]);

  const addAttachments = useCallback((incoming: readonly ComposerAttachment[]) => {
    const next = appendAttachmentsWithinLimits(attachmentsRef.current, incoming);
    commitAttachments(next.items);
    const acceptedPaths = new Set(next.items.map((attachment) => attachment.path));
    for (const attachment of incoming) {
      if (!acceptedPaths.has(attachment.path) && isPreparingAttachment(attachment) && attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
    if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
    else if (next.rejectedForCount) notify(`You can attach up to ${maximumMessageAttachments} items per message.`, "error");
    return next;
  }, [commitAttachments, notify]);

  const addImages = useCallback((images: readonly SelectedImage[]) => addAttachments(
    images.map((image) => ({ ...image, origin: image.origin ?? "file-picker" })),
  ), [addAttachments]);

  const addFiles = useCallback((files: readonly SelectedFile[]) => addAttachments(
    files.map((file) => ({ ...file, origin: file.origin ?? "file-picker" })),
  ), [addAttachments]);

  const addAudio = useCallback((audio: SelectedAudio) => {
    const next = appendAttachmentsWithinLimits(attachmentsRef.current, [audio]);
    commitAttachments(next.items);
    if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
    else if (next.rejectedForCount) notify(`You can attach up to ${maximumMessageAttachments} items per message.`, "error");
    return next.acceptedCount > 0;
  }, [commitAttachments, notify]);

  const cancelEarsTranscription = useCallback(() => {
    earsCancelled.current = true;
    const requestId = earsRequestId.current;
    if (!requestId) return;
    void request("ears.cancel", { requestId }).catch(() => undefined);
  }, [request]);

  const onComposerDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };

  const onComposerDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDropActive(false);
  };

  const onComposerDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    const dropped = [...event.dataTransfer.files];
    if (!dropped.length) return;
    const incoming: PreparingComposerAttachment[] = [];
    try {
      for (const file of dropped) {
        if (file.size <= 0 || file.size > 25 * 1024 * 1024) throw new Error("Dropped files must be between 1 byte and 25 MiB.");
        const kind = classifyDroppedFile(file);
        if (kind === "image") {
          if (!canAttach) throw new Error(`${provider?.name ?? "This coding tool"} does not support image attachments.`);
          incoming.push(prepareDroppedAttachment(file, "image", "drag-drop", "dropped-image.png"));
          continue;
        }
        if (canAttachFiles) {
          incoming.push(prepareDroppedAttachment(file, "file", "drag-drop", "dropped-file"));
          continue;
        }
        throw new Error("Drop an image, or switch to OpenCode to attach other files.");
      }
      const added = addAttachments(incoming);
      const acceptedPaths = new Set(added.items.map((attachment) => attachment.path));
      const acceptedFileCount = incoming.filter((attachment) => acceptedPaths.has(attachment.path) && attachment.attachmentKind === "file").length;
      if (acceptedFileCount > 0 && !added.rejectedForBytes && !added.rejectedForCount) notify(acceptedFileCount === 1 ? "File attached" : `${acceptedFileCount} files attached`);
    } catch (error) {
      for (const attachment of incoming) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const copyMeshSelection = (event: ReactClipboardEvent<ComposerTextInput>) => {
    const selected = event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd);
    if (!meshKnownTargets.current.some((target) => selected.includes(target.composerToken!))) return false;
    event.preventDefault();
    event.clipboardData.setData("text/plain", selected.replace(/[\uE000-\uF8FF]/gu, (token) => {
      const target = meshKnownTargets.current.find((item) => item.composerToken === token);
      return target ? `@${meshTargetModelLabel(snapshot, target)}` : token;
    }));
    return true;
  };
  const onPaste = (event: ReactClipboardEvent<ComposerTextInput>) => {
    // Chromium exposes copied files here when the source application/OS puts
    // their bytes on the clipboard. Treat them exactly like dropped files so a
    // video or document becomes a normal file widget for a destination that can
    // carry generic attachments, while image paste keeps its existing preview.
    const files = [...event.clipboardData.files];
    if (!files.length) return;
    event.preventDefault();
    const incoming: PreparingComposerAttachment[] = [];
    try {
      for (const [index, file] of files.entries()) {
        if (file.size <= 0 || file.size > 25 * 1024 * 1024) throw new Error("Pasted files must be between 1 byte and 25 MiB.");
        const kind = classifyDroppedFile(file);
        if (kind === "image") {
          if (!canAttach) throw new Error(`${provider?.name ?? "This coding tool"} does not support image attachments.`);
          incoming.push(prepareDroppedAttachment(file, "image", "clipboard", `pasted-image-${index + 1}.png`));
          continue;
        }
        if (canAttachFiles) {
          incoming.push(prepareDroppedAttachment(file, "file", "clipboard", `pasted-file-${index + 1}`));
          continue;
        }
        throw new Error("Paste an image, or switch to OpenCode to attach other files.");
      }
      const added = addAttachments(incoming);
      if (added.acceptedCount > 0 && !added.rejectedForBytes && !added.rejectedForCount) {
        const acceptedPaths = new Set(added.items.map((attachment) => attachment.path));
        const accepted = incoming.filter((attachment) => acceptedPaths.has(attachment.path));
        const images = accepted.filter((attachment) => attachment.attachmentKind === "image").length;
        const files = accepted.length - images;
        notify(images === accepted.length
          ? accepted.length === 1 ? "Pasted image attached" : `${accepted.length} pasted images attached`
          : files === accepted.length
            ? accepted.length === 1 ? "Pasted file attached" : `${accepted.length} pasted files attached`
            : `${accepted.length} pasted attachments added`);
      }
    } catch (error) {
      for (const attachment of incoming) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const submitDraftSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (scheduleBusyRef.current) return;
    setScheduleFailure(null);
    if (!draftSession) {
      setScheduleFailure("Scheduling is currently available for new tasks only.");
      return;
    }
    if (!onCreateDraftSchedule) {
      setScheduleFailure("Task scheduling is unavailable right now.");
      return;
    }
    let attempt = scheduleAttempt.current;
    if (attempt === null) {
      const validation = validateDraftScheduleLocalValue(scheduleValue);
      if (validation.error || !validation.date) {
        setScheduleFailure(validation.error ?? "Choose a valid local date and time.");
        return;
      }
      const scheduledComposerContent = contentRef.current;
      const submittedMeshTargets = meshTargetsRef.current.map((target) => ({ ...target }));
      const hasMeshCommand = hasSlashCommandToken(scheduledComposerContent, "/mesh");
      if (hasMeshCommand && submittedMeshTargets.length === 0) {
        setScheduleFailure("Choose at least one Mesh target before scheduling this task.");
        setMeshOpen(true);
        requestAnimationFrame(() => textarea.current?.focus());
        return;
      }
      let scheduledContentWithoutCommands = scheduledComposerContent;
      while (hasSlashCommandToken(scheduledContentWithoutCommands, "/schedule")) {
        scheduledContentWithoutCommands = removeSlashCommandToken(scheduledContentWithoutCommands, "/schedule");
      }
      while (hasSlashCommandToken(scheduledContentWithoutCommands, "/mesh")) {
        scheduledContentWithoutCommands = removeSlashCommandToken(scheduledContentWithoutCommands, "/mesh");
      }
      const scheduledContent = scheduledContentWithoutCommands.trim();
      if (!scheduledContent) {
        setScheduleFailure("Enter a task before scheduling it.");
        return;
      }
      if (scheduledContent.length > (submittedMeshTargets.length ? 32_000 : 100_000)) {
        setScheduleFailure(submittedMeshTargets.length
          ? "A scheduled Mesh task must contain at most 32,000 characters."
          : "A scheduled task must contain at most 100,000 characters.");
        return;
      }
      if (!session.workingDirectory.trim()) {
        setScheduleFailure("Choose a project folder before scheduling this task.");
        return;
      }
      if (dictationPhase !== "idle") {
        setScheduleFailure("Finish or cancel dictation before scheduling. Scheduled tasks are text-only.");
        return;
      }
      if (attachmentsRef.current.some((attachment) => attachment.mimeType.toLowerCase().startsWith("audio/"))) {
        setScheduleFailure("Scheduled tasks are text-only. Remove dictation or audio attachments first.");
        return;
      }
      if (attachmentsRef.current.length > 0) {
        setScheduleFailure("Scheduled tasks are text-only. Remove attachments first.");
        return;
      }
      if (workflowAttachmentsRef.current.length > 0) {
        setScheduleFailure("Scheduled tasks are text-only. Remove workflows first.");
        return;
      }
      if (annotationsRef.current.length > 0) {
        setScheduleFailure("Scheduled tasks are text-only. Remove response annotations first.");
        return;
      }
      const presentation = draftSchedulePresentation(scheduledContent);
      attempt = {
        draftSessionId: session.id,
        requestId: `schedule_${globalThis.crypto.randomUUID()}`,
        providerId,
        workingDirectory: session.workingDirectory,
        scheduledComposerContent,
        content: scheduledContent,
        meshTargets: submittedMeshTargets,
        modelId: model,
        effort,
        runAt: validation.date.toISOString(),
        title: presentation.title,
        preview: presentation.preview,
      };
      scheduleAttempt.current = attempt;
    }
    attempt = onRetainDraftScheduleAttempt?.(attempt) ?? attempt;
    scheduleAttempt.current = attempt;
    const requestedSessionId = session.id;
    scheduleBusyRef.current = true;
    setScheduleBusy(true);
    try {
      await onCreateDraftSchedule(attempt);
      scheduleAttempt.current = null;
      setScheduleRetryPending(false);
      if (!mounted.current || activeSessionId.current !== requestedSessionId) return;
      const previousContent = contentRef.current;
      const retainedContent = clearScheduledDraftContent(previousContent, attempt.scheduledComposerContent);
      const remainingTargets = remainingMeshTargetsAfterSchedule(meshTargetsRef.current, attempt.meshTargets);
      const retained = commitContent(retainedContent, moveMeshTargets(previousContent, retainedContent, remainingTargets));
      historyIndex.current = null;
      unsentHistoryDraft.current = retained;
      closeDraftSchedule();
    } catch (error) {
      if (mounted.current && activeSessionId.current === requestedSessionId) {
        setScheduleRetryPending(true);
        setScheduleFailure(error instanceof Error ? error.message : String(error));
      }
    } finally {
      scheduleBusyRef.current = false;
      if (mounted.current && activeSessionId.current === requestedSessionId) setScheduleBusy(false);
    }
  };

  const submit = async () => {
    if (scheduleBusyRef.current) return;
    if (switchingHarness && meshTargetsRef.current.length > 0) {
      if (compositionHasContent && !sendingRef.current && !earsBusy) await requestDraftAction("model_switch_send");
      return;
    }
    if (draftSession && meshTargetsRef.current.length > 0) {
      // A scheduled draft can retain committed Mesh targets after its Schedule
      // panel closes. Materialize the parent first, then replay this exact send
      // once on the provider-backed Composer; never address delegation.prepare to
      // a local draft id.
      await requestDraftAction("mesh_send");
      return;
    }
    const submittedDraft: ComposerDraftSnapshot = {
      content: contentRef.current,
      attachments: attachmentsRef.current,
      workflowAttachments: workflowAttachmentsRef.current,
      annotations: annotationsRef.current,
    };
    // /mesh stays visible while the panel is open, so strip it before it can be
    // mistaken for the instruction.
    const trimmed = removeSlashCommandToken(submittedDraft.content, "/mesh").trim();
    const submittedAsGoal = mode === "goal";
    if (submittedAsGoal && trimmed.length > 4000) { notify("Keep the goal under 4,000 characters.", "error"); return; }
    const submittedHasContent = trimmed.length > 0
      || submittedDraft.annotations.length > 0
      || submittedDraft.attachments.length > 0
      || submittedDraft.workflowAttachments.length > 0
      || meshTargets.length > 0;
    if (sendingRef.current || earsBusy || !submittedHasContent) return;
    const deliveryToken = beginComposerDelivery(session.id);
    if (deliveryToken === null) return;
    // Scroll consent belongs to the physical viewport at the instant the reader
    // sends. Sample it before clearing text/attachments changes composer height.
    onBeforeSubmit?.();
    const submittedSelectionRevision = selectionRevision.current;
    sendingRef.current = true;
    setSending(true);
    if (meshTargets.length > 0) {
      const submittedMeshTargets = [...meshTargetsRef.current];
      const acceptedId = `local-${Date.now()}`;
      const acceptedTimestamp = new Date().toISOString();
      const withoutCommand = removeSlashCommandToken(submittedDraft.content, "/mesh");
      const leadingWhitespace = withoutCommand.length - withoutCommand.trimStart().length;
      const positionedTargets = moveMeshTargets(submittedDraft.content, withoutCommand, submittedMeshTargets)
        .map((target) => ({ ...target, offset: Math.max(0, Math.min(trimmed.length, (target.offset ?? 0) - leadingWhitespace)) }));
      const presentationSegments = meshPresentationSegments(trimmed, positionedTargets);
      const optimisticRow: TimelineItem = {
        id: acceptedId, presentationId: acceptedId, delegationId: acceptedId,
        kind: "user", body: trimmed, timestamp: acceptedTimestamp, state: "completed",
        mesh: {
          targets: submittedMeshTargets.map((target) => ({ ...meshTargetRoute(target), modelName: meshTargetModelLabel(snapshot, target) })),
          segments: presentationSegments,
        },
      };
      setMeshTargets([]);
      setMeshModelPicker(null);
      setMeshOpen(false);
      commitContent("");
      updateSnapshot((current) => current ? {
        ...current,
        timelines: { ...current.timelines, [session.id]: [...(current.timelines[session.id] ?? []), optimisticRow] },
        sessions: current.sessions.map((item) => item.id === session.id
          ? { ...item, state: "working", preview: trimmed, updatedAt: acceptedTimestamp } : item),
      } : current);
      try {
        if (submittedAsGoal) {
          const nextGoal = await setSessionGoal(session.id, { objective: trimmed, status: "active", tokenBudget: null });
          onGoalRef.current?.(nextGoal);
        }
        // An empty prompt is a deliberate mesh send: the bridge and the parent
        // agent compose the instruction, so the send control stays enabled.
        await request("delegation.prepare", {
          parentSessionId: session.id,
          prompt: trimmed,
          targets: submittedMeshTargets.map(meshTargetRoute),
          presentationSegments,
          ...(model ? { modelId: model } : {}),
          ...(effort ? { reasoningEffort: effort } : {}),
        }, acceptedId);
        persistMeshRecentTargetsForSession(session.id, submittedMeshTargets);
        if (submittedAsGoal) setMode("queue");
        setMeshRecentRevision((current) => current + 1);
        notify("Mesh request sent");
      } catch (error) {
        if (isDeliveryUnknownError(error)) {
          updateSnapshot((current) => current ? {
            ...current,
            sessions: current.sessions.map((item) => item.id === session.id && item.state === "working" && item.updatedAt === acceptedTimestamp
              ? { ...item, state: session.state } : item),
          } : current);
          notify(error.message, "error");
          return;
        }
        updateSnapshot((current) => current ? {
          ...current,
          timelines: { ...current.timelines, [session.id]: rollbackOptimisticComposerRow(current.timelines[session.id] ?? [], acceptedId) },
          sessions: current.sessions.map((item) => item.id === session.id && item.updatedAt === acceptedTimestamp
            ? { ...item, state: session.state, preview: session.preview, updatedAt: session.updatedAt } : item),
        } : current);
        const restoredContent = mergeFailedComposerDraft(
          { content: submittedDraft.content, attachments: [], workflowAttachments: [], annotations: [] },
          { content: contentRef.current, attachments: [], workflowAttachments: [], annotations: [] },
        ).content;
        const restoredPrefixLength = restoredContent.length - contentRef.current.length;
        commitContent(restoredContent, meshTargetsRef.current.map((target) => ({ ...target, offset: (target.offset ?? 0) + restoredPrefixLength })));
        setMeshTargets((current) => {
          const submittedTokens = new Set(submittedMeshTargets.map((target) => target.composerToken));
          return [...submittedMeshTargets, ...current.filter((target) => !submittedTokens.has(target.composerToken))];
        });
        notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        sendingRef.current = false;
        finishComposerDelivery(session.id, deliveryToken);
        if (mounted.current) {
          setSending(false);
          textarea.current?.focus();
        }
      }
      return;
    }
    const simplified = simplifySubmission(trimmed, simplifySettings);
    const acceptedId = `local-${Date.now()}`;
    const acceptedTimestamp = new Date().toISOString();
    // EARS-owned recordings are private preprocessing inputs, not destination
    // attachments. Keep them out of the optimistic row as well as transport;
    // otherwise the accepted text-only row inherits a raw audio preview from
    // the presentation painted while transcription is still pending.
    const optimisticDraft = ears.enabled ? {
      ...submittedDraft,
      attachments: submittedDraft.attachments.filter((attachment) => !isDictationAudioAttachment(attachment)),
      annotations: submittedDraft.annotations.map(({ audio: _audio, ...annotation }) => annotation),
    } : submittedDraft;
    const optimisticRow = optimisticComposerTimelineItem(acceptedId, acceptedTimestamp, simplified.content, optimisticDraft);
    const blockedByAttention = holdsFollowUpQueue || turnInFlight.current || transportQueueSuppressions.current.length > 0;
    const liveGuidance = !submittedAsGoal && (mode === "steer" || (!queueingEnabled && canSteer));
    const requestType = composerMessageRequestType({
      liveGuidance,
      hasAttachments: submittedDraft.attachments.length > 0 || submittedDraft.annotations.some((annotation) => annotation.audio !== undefined),
      blockedByAttention,
      queueingEnabled: submittedAsGoal || queueingEnabled,
      externalWriter: session.externalWriter === true,
    });
    const queuedSubmission = requestType === "message_queue.enqueue";
    const transportOnlySubmission = queuedSubmission && session.externalWriter === true && !blockedByAttention;
    const appearsInTranscript = draftSession || switchingHarness || composerSubmissionAppearsInTranscript(requestType, transportOnlySubmission);
    // Submission owns this exact snapshot. Clear it and paint the matching user
    // row in the same boundary, before attachment work or provider IPC, so the
    // composition visibly moves instead of disappearing while delivery waits.
    commitContent("");
    commitAttachments([]);
    commitWorkflowAttachments([]);
    commitAnnotations([]);
    setAttachmentPreview(null);
    historyIndex.current = null;
    unsentHistoryDraft.current = "";
    const pendingUploadIds: string[] = [];
    const userRowIdsBeforeDelivery = new Set((snapshot.timelines[session.id] ?? [])
      .filter((item) => item.kind === "user")
      .map((item) => item.id));
    if (appearsInTranscript) {
      updateSnapshot((current) => {
        if (!current) return current;
        return {
          ...current,
          timelines: {
            ...current.timelines,
            [session.id]: [...(current.timelines[session.id] ?? []), optimisticRow],
          },
          sessions: current.sessions.map((item) => item.id === session.id ? {
            ...item,
            state: draftSession || !queuedSubmission ? "working" : item.state,
            preview: simplified.content,
            updatedAt: acceptedTimestamp,
            model,
            ...(effort ? { effort } : {}),
          } : item),
        };
      });
    }
    let restorableAttachments = submittedDraft.attachments;
    let transportSuppressionToken: string | null = null;
    let deliveryAccepted = false;
    try {
      if (!canSend) {
        const fresh = await reverifyProvider().catch(() => undefined);
        const usable = fresh?.detected === true
          && fresh.capabilities.includes("Send Message")
          && (!draftSession || fresh.capabilities.includes("Create Session"));
        if (!usable) throw new Error(`${fresh?.name ?? provider?.name ?? "This coding tool"} cannot accept messages right now.`);
      }
      const readyAttachments = await resolveComposerAttachments(submittedDraft.attachments);
      restorableAttachments = readyAttachments;
      const imageAttachments = readyAttachments.filter((attachment): attachment is SelectedImage => !isSelectedFile(attachment) && !isSelectedAudio(attachment));
      const fileAttachments = readyAttachments.filter(isSelectedFile);
      const messageDictationClips = readyAttachments.filter(isDictationAudioAttachment);
      const annotationClips = submittedDraft.annotations.flatMap((annotation) => annotation.audio ? [annotation.audio] : []);
      const dictationClips = [...messageDictationClips, ...annotationClips];
      const combinedAttachments = [...readyAttachments, ...annotationClips];
      // EARS is an explicit preprocessing choice, not merely a fallback for a
      // text-only destination. When enabled it owns dictation consistently,
      // including when the destination model could also receive raw audio.
      const shouldUseEars = ears.enabled && dictationClips.length > 0;
      const outgoingAttachments = shouldUseEars
        ? combinedAttachments.filter((attachment) => !isDictationAudioAttachment(attachment))
        : combinedAttachments;
      const outgoingAudio = outgoingAttachments.filter(isSelectedAudio);
      if (imageAttachments.length && !canAttach) throw new Error(`${provider?.name ?? "This coding tool"} does not support image attachments.`);
      if (fileAttachments.length && !canAttachFiles) throw new Error("Generic file attachments are available only for OpenCode.");
      if (outgoingAudio.length && !audioDictationAvailable) throw new Error(`${chosenModel?.name ?? "This model"} does not accept direct audio.`);
      if (!ears.enabled && dictationClips.length && !audioDictationAvailable) {
        throw new Error(`${chosenModel?.name ?? "This model"} does not accept direct audio. Enable EARS or choose an audio-capable model.`);
      }
      if (combinedAttachments.length > maximumMessageAttachments) throw new Error(`You can attach up to ${maximumMessageAttachments} items per message, including voice annotations.`);
      if (combinedAttachments.some((attachment) => attachment.byteLength <= 0 || attachment.byteLength > 25 * 1024 * 1024)) throw new Error("Attachments must be between 1 byte and 25 MiB each.");
      if (combinedAttachments.reduce((total, attachment) => total + attachment.byteLength, 0) > maximumMessageAttachmentBytes) throw new Error("Attachments can total up to 50 MiB per message.");
      let messageContent = simplified.content;
      let submissionAnnotations = submittedDraft.annotations;
      if (shouldUseEars) {
        const routes = earsRoutesFromSnapshot(snapshot);
        const configurationError = earsConfigurationError(ears, routes, dictationClips.map((clip) => ({
          id: clip.path,
          mimeType: clip.mimeType,
          origin: "dictation",
        })));
        if (configurationError) {
          setEarsOpen(true);
          throw new Error(configurationError);
        }
        setEarsBusy(true);
        earsCancelled.current = false;
        const requestId = newEarsRequestId();
        earsRequestId.current = requestId;
        try {
          const dictationIds = await uploadAttachments(dictationClips, uploadRequest(request), (id) => pendingUploadIds.push(id));
          if (earsCancelled.current) throw new Error(earsCancelledMessage);
          const processed = await request("ears.process", {
            providerId: ears.providerId ?? "",
            modelId: ears.modelId ?? "",
            mode: ears.mode,
            attachmentIds: [...dictationIds],
            requestId,
            ...(draftSession ? {} : { sessionId: session.id }),
          });
          const texts = Array.isArray(processed.texts) ? processed.texts.filter((item): item is string => typeof item === "string") : [];
          if (texts.length !== dictationClips.length) throw new Error("EARS did not return text for every dictation recording.");
          const messageTexts = texts.slice(0, messageDictationClips.length);
          const annotationTexts = texts.slice(messageDictationClips.length);
          messageContent = composeEarsDestinationText(simplified.content, messageTexts);
          let annotationIndex = 0;
          submissionAnnotations = submittedDraft.annotations.map((annotation) => annotation.audio
            ? { id: annotation.id, text: annotation.text, annotation: appendTranscript(annotation.annotation, annotationTexts[annotationIndex++] ?? "") }
            : annotation);
          if (!messageContent.trim() && !submissionAnnotations.some((annotation) => annotation.annotation.trim())) throw new Error("EARS did not hear any speech.");
          pendingUploadIds.length = 0;
        } finally {
          setEarsBusy(false);
          earsRequestId.current = null;
        }
      }
      const attachmentIds = outgoingAttachments.length ? await uploadAttachments(outgoingAttachments, uploadRequest(request), (id) => pendingUploadIds.push(id)) : [];
      const annotationAudioCount = submissionAnnotations.filter((annotation) => annotation.audio).length;
      const transportContent = serializeResponseAnnotations(messageContent, submissionAnnotations, outgoingAudio.length - annotationAudioCount);
      const goalObjective = submittedAsGoal ? messageContent.trim() : undefined;
      if (goalObjective !== undefined && (!goalObjective || goalObjective.length > 4000)) throw new Error("Enter a goal of 1–4,000 characters.");
      const workflowItems = submittedDraft.workflowAttachments.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        eventCount: workflow.summary.eventCount,
        screenshotCount: workflow.summary.screenshotCount,
        ...(workflow.summary.apps.length ? { applications: [...workflow.summary.apps] } : {}),
      }));
      // A plain send announces nothing. Your message appearing in the transcript is
      // already the confirmation, so a card saying so is one more thing to read and
      // dismiss for the most ordinary action there is. The cases below survive
      // because each one reports something the transcript does not show by itself.
      let sentLabel: string | null = null;
      const annotationAudioPaths = new Set(submissionAnnotations.flatMap((annotation) => annotation.audio ? [annotation.audio.path] : []));
      const visibleOutgoingAudio = outgoingAudio.filter((attachment) => !annotationAudioPaths.has(attachment.path));
      const acceptedAnnotations = submissionAnnotations.map(({ id, text, annotation, audio }) => ({
        id,
        text,
        annotation,
        ...(audio ? { audio: { name: audio.name, mimeType: audio.mimeType, dataUrl: `data:${audio.mimeType};base64,${audio.dataBase64}`, durationSeconds: audio.durationSeconds, dictation: true } } : {}),
      }));
      const acceptedRow: TimelineItem = {
        id: acceptedId,
        presentationId: acceptedId,
        kind: "user",
        body: messageContent,
        ...(acceptedAnnotations.length ? { annotations: acceptedAnnotations } : {}),
        ...(imageAttachments.length ? { images: imageAttachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}` })) } : {}),
        ...(visibleOutgoingAudio.length ? { audio: visibleOutgoingAudio.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`, durationSeconds: attachment.durationSeconds, dictation: isDictationAudioAttachment(attachment) })) } : {}),
        ...(fileAttachments.length ? { files: fileAttachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType })) } : {}),
        ...(workflowItems.length ? { workflows: workflowItems } : {}),
        timestamp: acceptedTimestamp,
        state: "completed",
      };
      if (draftSession || switchingHarness) {
        if (!onCreateDraftSend) throw new Error("This local draft cannot be created right now.");
        if (switchingHarness) {
          const key = `${session.id}\u0000${providerId}\u0000${model}\u0000${effort}`;
          if (modelSwitchAttempt.current?.key !== key) modelSwitchAttempt.current = { key, requestId: crypto.randomUUID() };
        }
        await onCreateDraftSend({
          draftSessionId: session.id,
          ...(switchingHarness ? { requestId: modelSwitchAttempt.current!.requestId } : {}),
          providerId,
          workingDirectory: session.workingDirectory,
          content: transportContent,
          modelId: model,
          effort,
          attachmentIds,
          workflowIds: submittedDraft.workflowAttachments.map((workflow) => workflow.id),
          optimisticItem: acceptedRow,
          ...(simplified.simplify !== undefined ? { simplify: simplified.simplify } : {}),
          ...(goalObjective !== undefined ? { goalObjective } : {}),
        });
        sentLabel = switchingHarness ? null : "Task started";
      } else {
        const payload: JsonObject = {
          sessionId: session.id,
          content: transportContent,
          ...(model !== "default" ? { modelId: model } : {}),
          ...(effort ? { reasoningEffort: effort.toLowerCase() } : {}),
          ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}),
          ...(submittedDraft.workflowAttachments.length ? { workflowIds: submittedDraft.workflowAttachments.map((workflow) => workflow.id) } : {}),
          ...(simplified.simplify !== undefined ? { simplify: simplified.simplify } : {}),
          ...(goalObjective !== undefined ? { goal: { objective: goalObjective } } : {}),
        };
        if (transportOnlySubmission) {
          transportSuppressionToken = `transport-${acceptedRow.id}`;
          transportQueueSuppressions.current = [...transportQueueSuppressions.current, {
            token: transportSuppressionToken,
            content: transportContent,
          }];
        }
        const response = await request(requestType, payload);
        // Crossing this line is the only point at which the provider owns the
        // composition. A canonical user echo may already be in `current`, so
        // reconcile the accepted local presentation with that row instead of
        // blindly appending a second copy.
        deliveryAccepted = true;
        pendingUploadIds.length = 0;
        // Completion can arrive before the saved-message receipt. An older
        // acknowledgement must not reopen that turn or force the next input to queue.
        if (!queuedSubmission) turnInFlight.current = latestSnapshot.current.sessions
          .find((item) => item.id === session.id)?.state === "working";
        if (appearsInTranscript) {
          updateSnapshot((current) => {
            if (!current) return current;
            return {
              ...current,
              timelines: {
                ...current.timelines,
                [session.id]: mergeAcceptedComposerRow(
                  current.timelines[session.id] ?? [],
                  acceptedRow,
                  userRowIdsBeforeDelivery,
                ),
              },
              sessions: current.sessions.map((item) => item.id === session.id ? {
                ...item,
                preview: simplified.content,
                model,
                ...(effort ? { effort } : {}),
                // An accepted direct send starts a Tethoq-owned turn. Do not let
                // a stale external-writer bit route its next follow-up elsewhere.
                ...(requestType === "session.send_message" && session.externalWriter === true ? { externalWriter: false } : {}),
              } : item),
            };
          });
        }
        if (queuedSubmission) {
          const queued = queuedMessagesForSession({ messages: [response.message] }, session.id)[0];
          if (queued) {
            rememberQueuedAttachmentPreviews(queued, outgoingAttachments, session.id);
            if (transportOnlySubmission && transportSuppressionToken) {
              // Queue list reads can resolve out of order. Keep acknowledged ids
              // for this mounted task instead of treating one stale empty read as
              // proof of consumption; native queue ids are unique and the bounded
              // set disappears when the task composer unmounts.
              transportQueueSuppressions.current = acknowledgeTransportQueueSuppression(transportQueueSuppressions.current, transportSuppressionToken, queued.id).slice(-32);
              setQueuedMessages((current) => visibleTransportQueueMessages(current, transportQueueSuppressions.current));
            } else {
              setQueuedMessages((current) => current.some((item) => item.id === queued.id) ? current : [...current, queued]);
            }
          }
          // The queue acknowledgement is already authoritative. Refresh its controls
          // in the background so neither the transcript row nor composer clearing waits
          // on a second Desktop IPC round trip.
          void loadQueuedMessages();
        }
        sentLabel = requestType === "session.steer_message" ? "Task steered" : null;
      }
      if (selectionEditedLocally.current && selectionRevision.current === submittedSelectionRevision) {
        selectionEditedLocally.current = false;
        setAcceptedSelectionRevision((current) => current + 1);
      }
      deliveryAccepted = true;
      if (submittedAsGoal) setMode("queue");
      pendingUploadIds.length = 0;
      promptHistory.current = rememberPrompt(trimmed, promptHistory.current);
      historyIndex.current = null;
      unsentHistoryDraft.current = "";
      for (const attachment of readyAttachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      if (sentLabel !== null) notify(sentLabel);
    } catch (error) {
      if (isDeliveryUnknownError(error)) {
        // The provider may own this exact submission. Keep its optimistic row,
        // consumed attachments, and cleared composer while the durable Bridge
        // tombstone reconciles; restoring any of them would expose a duplicate.
        // The delivery itself does not prove a running turn. Release only our
        // optimistic status; a newer provider status remains authoritative.
        if (appearsInTranscript && !queuedSubmission) updateSnapshot((current) => current ? {
          ...current,
          sessions: current.sessions.map((item) => item.id === session.id && item.state === "working" && item.updatedAt === acceptedTimestamp
            ? { ...item, state: session.state } : item),
        } : current);
        deliveryAccepted = true;
        if (submittedAsGoal) setMode("queue");
        pendingUploadIds.length = 0;
        void loadQueuedMessages();
        notify(error.message, "error");
        return;
      }
      if (!deliveryAccepted && transportSuppressionToken) {
        transportQueueSuppressions.current = transportQueueSuppressions.current.filter((suppression) => suppression.token !== transportSuppressionToken);
        void loadQueuedMessages();
      }
      if (!deliveryAccepted) {
        if (appearsInTranscript) {
          updateSnapshot((current) => {
            if (!current) return current;
            const timelines = { ...current.timelines };
            let timelineChanged = false;
            for (const [timelineSessionId, timeline] of Object.entries(current.timelines)) {
              const rolledBack = rollbackOptimisticComposerRow(timeline, acceptedId);
              if (rolledBack === timeline) continue;
              timelines[timelineSessionId] = rolledBack;
              timelineChanged = true;
            }
            let sessionChanged = false;
            const sessions = current.sessions.map((item) => {
              if (item.id !== session.id || item.updatedAt !== acceptedTimestamp) return item;
              sessionChanged = true;
              return {
                ...item,
                state: session.state,
                preview: session.preview,
                updatedAt: session.updatedAt,
                model: session.model,
                effort: session.effort,
              };
            });
            return timelineChanged || sessionChanged ? { ...current, timelines, sessions } : current;
          });
        }
        // Upload cancellation is cleanup, not part of making the composer usable
        // again. Restore first and let cleanup finish away from the input path.
        void Promise.all(pendingUploadIds.map((uploadId) => request("attachment.upload.cancel", { uploadId }).catch(() => undefined)));
        const failedSnapshot: ComposerDraftSnapshot = {
          ...submittedDraft,
          attachments: restorableAttachments,
        };
        const currentDraft: ComposerDraftSnapshot = {
          content: contentRef.current,
          attachments: attachmentsRef.current,
          workflowAttachments: workflowAttachmentsRef.current,
          annotations: annotationsRef.current,
        };
        const restoredByParent = restoreFailedSubmissionRef.current !== undefined;
        const restored = restoreFailedSubmissionRef.current?.(failedSnapshot)
          ?? mergeFailedComposerDraft(failedSnapshot, currentDraft);
        contentRef.current = restored.content;
        attachmentsRef.current = restored.attachments;
        workflowAttachmentsRef.current = restored.workflowAttachments;
        annotationsRef.current = restored.annotations;
        unsentHistoryDraft.current = restored.content;
        if (!restoredByParent) {
          draftChangeRef.current(restored.content);
          attachmentsChangeRef.current?.(restored.attachments);
          workflowAttachmentsChangeRef.current?.(restored.workflowAttachments);
          annotationsChangeRef.current?.(restored.annotations);
        }
        if (mounted.current) {
          setContent(restored.content);
          setAttachments(restored.attachments);
          setWorkflowAttachments(restored.workflowAttachments);
          setAnnotations(restored.annotations);
        }
      }
      if (isEarsCancelledError(error)) notify("Transcription cancelled");
      else notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      sendingRef.current = false;
      finishComposerDelivery(session.id, deliveryToken);
      if (mounted.current) {
        setSending(false);
        textarea.current?.focus();
      }
    }
  };
  const dictationRecording = dictationPhase === "recording" || dictationPhase === "audio-recording";
  const interrupt = async () => {
    if (onInterrupt === undefined || interruptingRef.current) return;
    interruptingRef.current = true;
    setInterrupting(true);
    try {
      await onInterrupt();
    } finally {
      interruptingRef.current = false;
      setInterrupting(false);
      textarea.current?.focus();
    }
  };
  const primaryAction = () => {
    if (dictationRecording) {
      sendAfterDictation.current = true;
      dictationControl.current?.stop();
      return;
    }
    const stopTask = canInterrupt && !compositionHasContent && content.trim().length === 0;
    if (stopTask) void interrupt();
    else void submit();
  };
  const cancelQueuedMessage = async (messageId: string) => {
    if (cancellingQueuedId) return;
    setCancellingQueuedId(messageId);
    try {
      const result = await request("message_queue.cancel", { messageId });
      if (result.cancelled !== true) notify("That queued instruction is already being sent.", "error");
      else {
        queuedAttachmentPreviewCache.delete(messageId);
        queuedAttachmentPreviewOwners.delete(messageId);
        if (mounted.current && activeSessionId.current === session.id) {
          // The cancellation is authoritative. A history refresh may be slow,
          // and a list started before this acknowledgement must not restore it.
          queuedMessagesGeneration.current += 1;
          setQueuedMessages(current => current.filter(message => message.id !== messageId));
        }
        notify(queuedMessages.find(message => message.id === messageId)?.retryable === false ? "Delivery notice dismissed" : "Queued instruction cancelled");
      }
      void loadQueuedMessages();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (mounted.current) setCancellingQueuedId(null);
    }
  };
  const editQueuedMessage = async (messageId: string) => {
    if (queuedDraftRestorations.current.has(messageId) || sendingRef.current) return;
    queuedDraftRestorations.current.add(messageId);
    setUpdatingQueuedId(messageId);
    try {
      const prepared = await readQueuedComposerDraft(request, messageId, session.id, async id => {
        const attachment = await window.tethoqDesktop.recorderAction({ type: "attachment", id });
        if (!attachment || Array.isArray(attachment) || !("promptReference" in attachment)) throw new Error("The queued workflow is unavailable");
        return attachment as WorkflowAttachment;
      });
      if (!mounted.current || activeSessionId.current !== session.id) return;
      const result = await request("message_queue.cancel", { messageId, draftVersion: prepared.version });
      if (result.cancelled !== true) throw new Error("That queued instruction changed or already started sending.");
      const restored = onRestoreFailedSubmission?.(prepared.draft) ?? mergeFailedComposerDraft(prepared.draft,
        { content: contentRef.current, attachments: attachmentsRef.current, workflowAttachments: workflowAttachmentsRef.current, annotations: annotationsRef.current });
      queuedAttachmentPreviewCache.delete(messageId);
      queuedAttachmentPreviewOwners.delete(messageId);
      if (mounted.current && activeSessionId.current === session.id) {
        queuedMessagesGeneration.current += 1;
        setQueuedMessages(current => current.filter(message => message.id !== messageId));
        commitContent(restored.content);
        commitAttachments(restored.attachments);
        commitWorkflowAttachments(restored.workflowAttachments);
        commitAnnotations(restored.annotations);
        if (prepared.goal) setMode("goal");
        requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(prepared.draft.content.length, prepared.draft.content.length); });
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      await loadQueuedMessages();
    } finally { queuedDraftRestorations.current.delete(messageId); if (mounted.current) setUpdatingQueuedId(null); }
  };
  const deliverQueuedMessage = async (messageId: string) => {
    if (queuedSteerDeliveries.current.has(messageId)) return;
    const queuedIndex = queuedMessages.findIndex((message) => message.id === messageId);
    const queuedMessage = queuedIndex >= 0 ? queuedMessages[queuedIndex] : undefined;
    if (!queuedMessage) return;
    const presentationId = `local-${Date.now()}`;
    const optimisticTimestamp = new Date().toISOString();
    const optimisticRow = optimisticQueuedSteerTimelineItem(queuedMessage, presentationId, optimisticTimestamp);
    const userRowIdsBeforeDelivery = new Set((snapshot.timelines[session.id] ?? [])
      .filter((item) => item.kind === "user")
      .map((item) => item.id));
    queuedSteerDeliveries.current.add(messageId);
    setUpdatingQueuedId(messageId);
    // The queue card and its transcript presentation change ownership in the
    // same React boundary. A slow provider acknowledgement therefore leaves the
    // instruction visible exactly once, and queue refreshes cannot resurrect its
    // old card while this delivery is still unresolved.
    setQueuedMessages((current) => current.filter((message) => message.id !== messageId));
    updateSnapshot((current) => current ? {
      ...current,
      timelines: {
        ...current.timelines,
        [session.id]: mergeAcceptedComposerRow(
          current.timelines[session.id] ?? [],
          optimisticRow,
          userRowIdsBeforeDelivery,
        ),
      },
    } : current);
    try {
      const result = await request("message_queue.deliver", { messageId, mode: "steer" });
      if (result.delivered !== true) throw new Error("That queued instruction could not be delivered.");
      queuedAttachmentPreviewCache.delete(messageId);
      queuedAttachmentPreviewOwners.delete(messageId);
      updateSnapshot((current) => current ? {
        ...current,
        timelines: {
          ...current.timelines,
          [session.id]: mergeAcceptedComposerRow(
            current.timelines[session.id] ?? [],
            optimisticRow,
            userRowIdsBeforeDelivery,
          ),
        },
      } : current);
      await loadQueuedMessages();
      notify("Task steered");
    } catch (error) {
      // A provider echo is stronger evidence than a late transport rejection.
      // Preserve the adopted canonical row and never restore a retryable duplicate.
      if (hasCanonicalComposerEcho(latestSnapshot.current.timelines[session.id] ?? [], presentationId)) {
        queuedAttachmentPreviewCache.delete(messageId);
        queuedAttachmentPreviewOwners.delete(messageId);
        await loadQueuedMessages();
        notify("Task steered");
      } else if (isDeliveryUnknownError(error)) {
        updateSnapshot((current) => current ? {
          ...current,
          timelines: {
            ...current.timelines,
            [session.id]: rollbackOptimisticComposerRow(current.timelines[session.id] ?? [], presentationId),
          },
        } : current);
        queuedSteerDeliveries.current.delete(messageId);
        await loadQueuedMessages();
        notify(error.message, "error");
      } else {
        updateSnapshot((current) => current ? {
          ...current,
          timelines: {
            ...current.timelines,
            [session.id]: rollbackOptimisticComposerRow(current.timelines[session.id] ?? [], presentationId),
          },
        } : current);
        // Let the authoritative recovery row become visible again. If that read
        // itself is unavailable (or briefly empty), retain the exact closed-over
        // row at its original sibling position so the instruction stays retryable.
        queuedSteerDeliveries.current.delete(messageId);
        const authoritativeQueueLoaded = await loadQueuedMessages();
        if (!authoritativeQueueLoaded) {
          setQueuedMessages((current) => {
            if (current.some((message) => message.id === messageId)) return current;
            const insertAt = Math.min(queuedIndex, current.length);
            return [...current.slice(0, insertAt), queuedMessage, ...current.slice(insertAt)];
          });
        }
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      queuedSteerDeliveries.current.delete(messageId);
      setUpdatingQueuedId(null);
    }
  };
  const openQueuedInSideChat = async (message: QueuedMessageView) => {
    if (!onCreateSideChat) return;
    setUpdatingQueuedId(message.id);
    try { await onCreateSideChat(session.id, undefined, message.id); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setUpdatingQueuedId(null); }
  };
  const moveQueuedToNewTask = async (message: QueuedMessageView, selection: DraftModelSelection): Promise<boolean> => {
    setUpdatingQueuedId(message.id);
    const presentationId = `local-${Date.now()}`;
    const optimisticTimestamp = new Date().toISOString();
    try {
      const result = await request("message_queue.move_to_new_task", {
        messageId: message.id,
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(selection.effort ? { reasoningEffort: selection.effort } : {}),
      });
      if (!result.session || typeof result.session !== "object" || Array.isArray(result.session)) {
        throw new Error("The bridge did not return the new task.");
      }
      if (!result.delivery || typeof result.delivery !== "object" || Array.isArray(result.delivery)) {
        throw new Error("The bridge did not prepare the queued instruction delivery.");
      }
      const delivery = result.delivery as Record<string, unknown>;
      if (typeof delivery.id !== "string" || !delivery.id || delivery.state !== "pending") {
        throw new Error("The bridge returned an invalid queued instruction delivery.");
      }
      const optimisticItem: TimelineItem = {
        ...optimisticQueuedSteerTimelineItem(message, presentationId, optimisticTimestamp),
        queuedNewTaskDeliveryId: delivery.id,
        queuedNewTaskDeliveryState: "pending",
      };
      queuedAttachmentPreviewCache.delete(message.id);
      queuedAttachmentPreviewOwners.delete(message.id);
      onDerivedSession(result.session as Record<string, unknown>, undefined, undefined, {
        deliveryId: delivery.id,
        optimisticItem,
      });
      void loadQueuedMessages();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      await loadQueuedMessages();
      return false;
    } finally { setUpdatingQueuedId(null); }
  };
  const showHistoryEntry = (value: string, caret: "start" | "end") => {
    commitContent(value);
    requestAnimationFrame(() => {
      const target = textarea.current;
      if (!target) return;
      const position = caret === "start" ? 0 : target.value.length;
      target.setSelectionRange(position, position);
    });
  };
  const insertComposerSlashCommand = (command: ComposerSlashCommand) => {
    const editor = meshEditorValue(contentRef.current, meshTargetsRef.current);
    const caret = Math.max(0, Math.min(editor.length, composerCaret ?? editor.length));
    const inserted = insertedSlashCommand(command, editor, caret);
    const commitEditor = (value: string) => {
      const draft = readMeshEditorValue(value, meshTargetsRef.current);
      commitContent(draft.content, draft.targets);
      historyIndex.current = null;
      unsentHistoryDraft.current = draft.content;
      setSlashPaletteDismissed(false);
    };
    if (command.id === "schedule") {
      commitEditor(removeSlashCommandToken(inserted, command.command));
      openDraftSchedule();
      return;
    }
    if (command.id === "goal") {
      setMode("goal");
      commitEditor(removeSlashCommandToken(inserted, command.command));
      return;
    }
    if (command.id === "permission" && !draftSession) {
      setActionsOpen(false);
      setGoalOpen(false);
      setEarsOpen(false);
      setPermissionOpen(true);
      commitEditor(removeSlashCommandToken(inserted, command.command));
      return;
    }
    if (command.id === "ears") {
      setEarsOpen(true);
      commitEditor(removeSlashCommandToken(inserted, command.command));
      return;
    }
    commitEditor(inserted);
    requestAnimationFrame(() => {
      const target = textarea.current;
      if (!target) return;
      target.focus();
      const nextCaret = inserted.length - (editor.length - caret);
      target.setSelectionRange(nextCaret, nextCaret);
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<ComposerTextInput>) => {
    if (event.nativeEvent.isComposing) return;
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && meshMentionVisible) {
      if (event.key === "Escape") { event.preventDefault(); closeMesh(); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (meshMentionOptions.length) {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setMeshMentionSelection((current) => (current + direction + meshMentionOptions.length) % meshMentionOptions.length);
        }
        return;
      }
      if (event.key === "Enter" || (event.key === "Tab" && meshMentionOptions.length)) {
        event.preventDefault();
        const selected = meshMentionOptions[safeMeshMentionSelection];
        if (selected && meshMention) commitMeshTarget(selected, meshMention);
        return;
      }
    }
    if (!event.nativeEvent.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && slashPaletteVisible) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashPaletteDismissed(true);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (slashSuggestions?.length) {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setSlashSelection((current) => (current + direction + slashSuggestions.length) % slashSuggestions.length);
        }
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const selected = slashSuggestions?.[Math.min(slashSelection, Math.max(0, slashSuggestions.length - 1))];
        if (selected) insertComposerSlashCommand(selected);
        return;
      }
    }
    if (!event.nativeEvent.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && meshOpen && meshModelPicker === null) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (meshProviderOptions.length) {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setMeshSelection((current) => (current + direction + meshProviderOptions.length) % meshProviderOptions.length);
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (activeMeshProvider) commitMeshTarget(meshQuickTargets.get(activeMeshProvider.id) ?? { providerId: activeMeshProvider.id });
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); return; }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
    const atEnd = event.currentTarget.selectionStart === event.currentTarget.value.length && event.currentTarget.selectionEnd === event.currentTarget.value.length;
    if (event.key === "ArrowUp" && atStart && promptHistory.current.length) {
      event.preventDefault();
      if (historyIndex.current === null) unsentHistoryDraft.current = content;
      const nextIndex = Math.min(promptHistory.current.length - 1, (historyIndex.current ?? -1) + 1);
      historyIndex.current = nextIndex;
      showHistoryEntry(promptHistory.current[nextIndex]!, "start");
    } else if (event.key === "ArrowDown" && atEnd && historyIndex.current !== null) {
      event.preventDefault();
      if (historyIndex.current === 0) {
        historyIndex.current = null;
        showHistoryEntry(unsentHistoryDraft.current, "end");
      } else {
        historyIndex.current -= 1;
        showHistoryEntry(promptHistory.current[historyIndex.current]!, "end");
      }
    }
  };
  const selectComposerModel = (nextProviderId: Session["providerId"], nextModelId: string) => {
    const nextModels = snapshot.models[nextProviderId] ?? [];
    const selection = resolveConcreteModelSelection(nextModels, { modelId: nextModelId }, agentDefaults[nextProviderId]);
    const resolvedModelId = selection?.modelId ?? nextModelId;
    const nextEffort = selection?.reasoningEffort ?? "";
    if (!supportsGenericFileAttachments(nextProviderId) && attachments.some(isComposerFileAttachment)) {
      commitAttachments((current) => {
        for (const attachment of current) {
          if (isComposerFileAttachment(attachment) && isPreparingAttachment(attachment) && attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        }
        return current.filter((attachment) => !isComposerFileAttachment(attachment));
      });
      notify("OpenCode file attachments were removed for this coding tool.");
    }
    const nextAudioAvailable = providerAcceptsDirectAudio(nextProviderId) && modelAcceptsDirectAudio(nextModels.find((item) => item.id === resolvedModelId));
    if (!nextAudioAvailable && attachments.some(isSelectedAudio)) {
      const nextAttachments = filterAttachmentsForDestination(attachments, false, ears.enabled);
      commitAttachments(nextAttachments);
      if (nextAttachments.length !== attachments.length) {
        notify(nextAttachments.some(isDictationAudioAttachment)
          ? "Audio that this model cannot hear was removed."
          : "Audio recordings were removed for this model.");
      }
    }
    selectionEditedLocally.current = true;
    selectionRevision.current += 1;
    setProviderId(nextProviderId);
    setModel(resolvedModelId);
    setEffort(nextEffort);
    if (draftSession) onDraftSelectionChange?.({ providerId: nextProviderId, modelId: resolvedModelId, effort: nextEffort });
  };
  const selectComposerEffort = (nextEffort: string) => {
    selectionEditedLocally.current = true;
    selectionRevision.current += 1;
    setEffort(nextEffort);
    if (draftSession) onDraftSelectionChange?.({ providerId, modelId: model, effort: nextEffort });
  };
  const openMeshModelPicker = (nextProviderId: Session["providerId"], token: string | null = null) => {
    if (!token && meshTargets.length >= maximumMeshTargets) return;
    setMeshEditingToken(token);
    setMeshModelPicker(nextProviderId);
  };
  const backToMesh = () => {
    setMeshModelPicker(null);
    setMeshEditingToken(null);
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const commitMeshTarget = (target: MeshTarget, mention?: NonNullable<ReturnType<typeof meshMentionAtCaret>>) => {
    const before = contentRef.current;
    const editing = !mention && meshEditingToken && meshModelPicker !== null;
    const editor = meshEditorValue(before, meshTargetsRef.current);
    const match = /(^|[\s\uE000-\uF8FF])\/mesh(?=$|\s)/iu.exec(editor);
    const editorStart = mention?.start ?? (match ? match.index + match[1]!.length : 0);
    const tokenStart = readMeshEditorValue(editor.slice(0, editorStart), meshTargetsRef.current).content.length;
    const tokenLength = mention ? mention.end - mention.start : match ? "/mesh".length : 0;
    const next = editing ? before : before.slice(0, tokenStart) + before.slice(tokenStart + tokenLength);
    let committed: MeshTarget | undefined;
    if (editing) {
      setMeshTargets((current) => current.map((item) => item.composerToken === meshEditingToken ? { ...item, ...target } : item));
    } else {
      if (meshTargetsRef.current.length >= maximumMeshTargets) return;
      const used = new Set(meshKnownTargets.current.map((item) => item.composerToken));
      let code = 0xE000;
      while (used.has(String.fromCharCode(code))) code += 1;
      committed = { ...target, composerToken: String.fromCharCode(code), offset: Math.min(tokenStart, next.length) };
      if (mention) {
        const draft = readMeshEditorValue(editor.slice(0, mention.start) + committed.composerToken + editor.slice(mention.end), [...meshTargetsRef.current, committed]);
        commitContent(draft.content, draft.targets);
      } else commitContent(next, [...moveMeshTargets(before, next, meshTargetsRef.current), committed]);
    }
    setMeshModelPicker(null);
    setMeshEditingToken(null);
    setMeshOpen(false);
    setScheduleFailure(null);
    historyIndex.current = null;
    unsentHistoryDraft.current = next;
    requestAnimationFrame(() => {
      textarea.current?.focus();
      if (committed && textarea.current) {
        const caret = textarea.current.value.indexOf(committed.composerToken!) + 1;
        textarea.current.setSelectionRange(caret, caret);
        setComposerCaret(caret);
      }
    });
  };
  const removeMeshTarget = (token: string) => {
    setMeshTargets((current) => current.filter((target) => target.composerToken !== token));
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const continueVisualAction = (action: VisionPickerMode) => {
    setVisionAction(null);
    // /eyes is a settings command: there is nothing queued to resume afterwards,
    // so saying the choice landed is the whole feedback the user needs.
    if (action === "settings") { notify("Vision model saved for this task"); return; }
    if (action === "workflow") setWorkflowPickerOpen(true);
    else onBrowser();
  };
  const openVisualAction = async (action: VisualAction) => {
    setActionsOpen(false);
    const requestedSessionId = session.id;
    try {
      const result = await request("session.vision.get", { sessionId: requestedSessionId });
      if (!mounted.current || activeSessionId.current !== requestedSessionId) return;
      const status = result.vision as unknown as VisionProxyStatus | undefined;
      if (!status || (status.primaryModelSupportsImageInput !== null && typeof status.primaryModelSupportsImageInput !== "boolean")) throw new Error("Bridge returned an invalid visual-support status.");
      if (status.primaryModelSupportsImageInput === false && status.configured === null) setVisionAction(action);
      else continueVisualAction(action);
    } catch (error) {
      if (mounted.current && activeSessionId.current === requestedSessionId) notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const branchSession = async () => {
    if (deriving) return;
    setActionsOpen(false);
    setDeriving(true);
    const requestedSessionId = session.id;
    try {
      const result = await request("session.branch", { sessionId: requestedSessionId });
      if (!mounted.current || activeSessionId.current !== requestedSessionId) return;
      if (!result.session || typeof result.session !== "object" || Array.isArray(result.session)) throw new Error("Bridge did not return the branched task.");
      onDerivedSession(result.session as Record<string, unknown>);
      notify(`Branched in a new task${typeof result.copiedMessageCount === "number" ? ` with ${result.copiedMessageCount} copied messages` : ""}`);
    } catch (error) {
      if (mounted.current && activeSessionId.current === requestedSessionId) notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (mounted.current && activeSessionId.current === requestedSessionId) setDeriving(false);
    }
  };
  useEffect(() => {
    if (draftSession || pendingAction === null || pendingAction.sessionId !== session.id) return;
    onPendingActionConsumed?.(pendingAction.requestId);
    if (pendingAction.action === "handoff") setHandoffOpen(true);
    else if (pendingAction.action === "branch") void branchSession();
    else if (pendingAction.action === "browser") void openVisualAction("browser");
    else if (pendingAction.action === "side_chat") {
      if (!onCreateSideChat) notify("Side chats are unavailable right now.", "error");
      else void onCreateSideChat(session.id).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
    } else if (pendingAction.action === "delegate") setDelegationOpen(true);
    else if (pendingAction.action === "goal") setMode("goal");
    else if (pendingAction.action === "permission") setPermissionOpen(true);
    else if (pendingAction.action === "eyes") setVisionAction("settings");
    else if (pendingAction.action === "mesh") setMeshOpen(true);
    else if (pendingAction.action === "mesh_send" || pendingAction.action === "model_switch_send") void submit();
    else if (pendingAction.action === "instant") onInstantSession?.();
  // The request id is the one-shot boundary. The action is consumed before any
  // asynchronous branch/browser work so a rerender cannot replay it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction?.requestId, session.id]);
  const attachmentActions = <>
    <button type="button" role="menuitem" disabled={!canAttach} onClick={async () => {
      setAttachmentsOpen(false);
      try {
        const selected = await selectImages();
        addImages(selected);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }}><PaperclipIcon /><span><strong>Attach image</strong><small>{canAttach ? `Choose up to ${maximumMessageAttachments} images` : "Unavailable for this coding tool"}</small></span></button>
    {supportsGenericFileAttachments(providerId) ? <button type="button" role="menuitem" disabled={!canAttachFiles || preview} onClick={async () => {
      setAttachmentsOpen(false);
      try {
        const selected = await window.tethoqDesktop.selectFiles(providerId);
        const added = addFiles(selected);
        if (added.acceptedCount > 0 && !added.rejectedForBytes && !added.rejectedForCount) notify(added.acceptedCount === 1 ? "File attached" : `${added.acceptedCount} files attached`);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }}><FileIcon /><span><strong>Attach file</strong><small>{canAttachFiles ? `${maximumMessageAttachments} attachments total · 25 MiB each` : "OpenCode is unavailable"}</small></span></button> : null}
    <button type="button" role="menuitem" disabled={!canAttach || preview} onClick={() => { setAttachmentsOpen(false); setCaptureOpen(true); }}><ScreenshotIcon /><span><strong>Capture screen region</strong><small>{canAttach ? "Drag, crop, and attach automatically" : "Unavailable for this coding tool"}</small></span></button>
    <button type="button" role="menuitem" onClick={() => { setAttachmentsOpen(false); if (draftSession) setWorkflowPickerOpen(true); else void openVisualAction("workflow"); }}><WorkflowIcon /><span><strong>Attach workflow</strong><small>Use recorded local context</small></span></button>
  </>;
  const actions = <>
    <button type="button" role="menuitem" disabled={materializingAction !== null} onClick={() => { if (draftSession) void requestDraftAction("permission"); else { setActionsOpen(false); setGoalOpen(false); setEarsOpen(false); setPermissionOpen(true); } }}><SlidersIcon /><span><strong>Permissions</strong><small>Choose this task’s harness permissions</small></span></button>
    {draftSession ? <button type="button" role="menuitem" onClick={openDraftSchedule}><ClockIcon /><span><strong>Schedule task</strong><small>Run this text-only task later</small></span></button> : null}
    <button type="button" role="menuitem" disabled={deriving || materializingAction !== null} onClick={() => { if (draftSession) void requestDraftAction("handoff"); else { setActionsOpen(false); setHandoffOpen(true); } }}><ChatIcon /><span><strong>Context Handoff</strong><small>Same model drafts a pickup prompt in a side chat</small></span></button>
    <button type="button" role="menuitem" disabled={deriving || materializingAction !== null} onClick={() => { if (draftSession) void requestDraftAction("branch"); else void branchSession(); }}><BranchIcon /><span><strong>Branch in New Task</strong><small>Copy this conversation into a paused task</small></span>{deriving || materializingAction === "branch" ? <span className="spinner" /> : null}</button>
    <button type="button" role="menuitem" disabled={materializingAction !== null} onClick={() => { if (draftSession) void requestDraftAction("browser"); else void openVisualAction("browser"); }}><BrowserIcon /><span><strong>Open session browser</strong><small>Persistent, app-owned Chromium</small></span></button>
    <button type="button" role="menuitem" disabled={!onCreateSideChat || materializingAction !== null} onClick={() => { if (draftSession) void requestDraftAction("side_chat"); else { setActionsOpen(false); void onCreateSideChat?.(session.id).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error")); } }}><ChatIcon /><span><strong>Open side chat</strong><small>Ask with this task's current context</small></span></button>
    <button type="button" role="menuitem" disabled={!canDelegate || materializingAction !== null} onClick={() => { if (draftSession) void requestDraftAction("delegate"); else { setActionsOpen(false); setDelegationOpen(true); } }}><AgentIcon /><span><strong>Delegate task</strong><small>Start grouped child sessions</small></span></button>
    <button type="button" role="menuitem" onClick={() => { setMode(mode === "queue" && canSteer ? "steer" : "queue"); setActionsOpen(false); }}><SendIcon /><span><strong>Send behavior: {mode === "steer" ? "Steer" : "Queue"}</strong><small>{canSteer ? "Switch between next-up and live guidance" : "Instructions run next"}</small></span><CheckIcon /></button>
    <button type="button" role="menuitemcheckbox" aria-checked={goalArmed} disabled={sending || materializingAction !== null} onClick={() => { setActionsOpen(false); setGoalOpen(false); setMode(goalArmed ? "queue" : "goal"); requestAnimationFrame(() => textarea.current?.focus()); }}><GoalIcon /><span><strong>Goal</strong><small>Send the next message as this task’s goal</small></span>{goalArmed ? <CheckIcon /> : null}</button>
    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setEarsOpen(true); }}><MicrophoneIcon /><span><strong>EARS settings</strong><small>Preprocess dictation before the destination agent</small></span></button>
    <button type="button" role="menuitem" disabled={materializingAction !== null} onClick={() => { if (draftSession) void requestDraftAction("eyes"); else { setActionsOpen(false); setVisionAction("settings"); } }}><EyeIcon /><span><strong>EYES settings</strong><small>Choose the model that reads images</small></span></button>
    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onManageWorkflow(); }}><SlidersIcon /><span><strong>Manage workflows</strong><small>Review recordings in Settings</small></span></button>
    {experimental && onInstantSession ? <button type="button" role="menuitem" disabled={materializingAction !== null} onClick={() => { if (draftSession) void requestDraftAction("instant"); else { setActionsOpen(false); onInstantSession(); } }}><MicrophoneIcon /><span><strong>Instant session</strong><small>Speak with synchronized screen and pointer evidence</small></span></button> : null}
  </>;
  const stopTaskAvailable = canInterrupt && !dictationRecording && !compositionHasContent && content.trim().length === 0;
  const nothingToSend = !compositionHasContent;

  return <div className="composer-wrap">
    {queuedNewTaskMessage ? createPortal(<QueuedNewTaskPicker
      snapshot={snapshot}
      sourceSession={session}
      message={queuedNewTaskMessage}
      agentDefaults={agentDefaults}
      onClose={() => setQueuedNewTaskMessage(null)}
      onSubmit={(selection) => moveQueuedToNewTask(queuedNewTaskMessage, selection)}
    />, document.body) : null}
    {annotationEditor ? <ResponseAnnotationEditor
      selectedText={annotationEditor.annotation.text}
      initial={annotationEditor.annotation}
      anchor={annotationEditor.anchor}
      providerId={providerId}
      request={request}
      notify={notify}
      directAudioAvailable={audioDictationAvailable}
      earsEnabled={ears.enabled}
      onClose={() => setAnnotationEditor(null)}
      onSave={(next) => { commitAnnotations((current) => current.map((item) => item.id === next.id ? next : item)); setAnnotationEditor(null); }}
    /> : null}
    {workflowPickerOpen ? <WorkflowPicker selected={workflowAttachments.map((item) => item.id)} preview={preview} onClose={closeWorkflowPicker} onChoose={(attachment) => { commitWorkflowAttachments((current) => [...current.filter((item) => item.id !== attachment.id), attachment]); closeWorkflowPicker(); }} onManageWorkflow={onManageWorkflow} /> : null}
    {visionAction ? <VisionEyesPicker key={`${session.id}:${visionAction}`} snapshot={snapshot} session={session} request={request} action={visionAction} liveStatus={visionStatus} readLiveStatus={readVisionStatus} onClose={closeVision} onReady={continueVisualAction} /> : null}
    {delegationOpen ? <DelegationPicker snapshot={snapshot} session={session} parentModelId={model} parentReasoningEffort={effort} request={request} onHydrateProviderModels={onHydrateProviderModels} initialDraft={delegationDraft} onDraftChange={commitDelegationDraft} notify={notify} onClose={closeDelegation} /> : null}
    {handoffOpen ? <ContextHandoffPicker session={session} request={request} notify={notify} onClose={closeHandoff} onSubmit={(customNote) => {
      if (onContextHandoff) return onContextHandoff(session.id, customNote);
      notify("Context handoff is unavailable right now.", "error");
      return Promise.resolve();
    }} /> : null}
    {captureOpen && !preview ? <ScreenRegionPicker notify={notify} onClose={() => setCaptureOpen(false)} onChoose={(image) => addImages([image]).acceptedCount > 0} /> : null}
    {attachmentPreview ? <div className="image-lightbox composer-image-lightbox" role="dialog" aria-modal="true" aria-label={`Preview ${attachmentPreview.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setAttachmentPreview(null); }}><button type="button" aria-label="Close attachment preview" onClick={() => setAttachmentPreview(null)}><XIcon /></button><figure><img src={attachmentPreview.dataUrl} alt={attachmentPreview.name} referrerPolicy="no-referrer"/><figcaption>{attachmentPreview.name}</figcaption></figure></div> : null}
    {queuedMessages.length ? <div className="queued-strip" role="list" aria-label="Queued instructions">{queuedMessages.map((message) => <QueuedMessageRow
      key={message.id}
      message={message}
      busy={cancellingQueuedId === message.id || updatingQueuedId === message.id}
      canSteer={canSteer}
      queueingEnabled={queueingEnabled}
      onSteer={() => deliverQueuedMessage(message.id)}
      onRemove={() => cancelQueuedMessage(message.id)}
      onEdit={() => editQueuedMessage(message.id)}
      onSideChat={() => openQueuedInSideChat(message)}
      onNewTask={() => setQueuedNewTaskMessage(message)}
      onToggleQueueing={() => {
        const next = !queueingEnabled;
        setMode(next ? "queue" : canSteer ? "steer" : "queue");
        onQueueingEnabledChange(next);
        notify(next ? "Queuing enabled" : "Queuing turned off");
      }}
    />)}</div> : null}
    <div className={`composer-box${dropActive ? " composer-drop-active" : ""}${dictationRecording ? " composer-recording" : ""}`} ref={composerBox} onDragEnter={onComposerDragOver} onDragOver={onComposerDragOver} onDragLeave={onComposerDragLeave} onDrop={(event) => void onComposerDrop(event)}>
      <ComposerSurfaceOutline />
      <div className="composer-footer" aria-label="Message options">
        <ModelPicker snapshot={snapshot} providerId={providerId} sessionModel={providerId === session.providerId ? session.model : ""} value={model} allowProviderChange={draftSession || onMaterializeDraft !== undefined} currentTaskProviderId={draftSession ? undefined : session.providerId} onChange={selectComposerModel} />
        {switchingHarness ? <span className="model-switch-notice" role="img" tabIndex={0} aria-label="Switching coding tools uses a private context summary; some earlier details may be lost" title="Your next message will switch coding tools using a private context summary. Some earlier details may be lost."><InfoIcon /></span> : null}
        {efforts.length ? <ChoiceMenu value={effort} options={efforts.map((item) => ({ value: item, label: reasoningLabel(item, { providerId, modelId: model, displayName: chosenModel?.name }) }))} onChange={selectComposerEffort} label="Choose reasoning effort" className="effort-choice" triggerDescription="Reasoning" placeholder={reasoningLabel(effort, { providerId, modelId: model, displayName: chosenModel?.name }) || "Choose"} /> : null}
      </div>
      {slashPaletteVisible ? <div className="slash-command-palette" id={slashListId} role="listbox" aria-label="Commands">
        {slashSuggestions?.map((command, index) => <button
          key={command.id}
          id={`${slashListId}-${command.id}`}
          type="button"
          role="option"
          aria-selected={index === slashSelection}
          onMouseDown={(event) => event.preventDefault()}
          onPointerMove={() => setSlashSelection(index)}
          onClick={() => insertComposerSlashCommand(command)}
        ><SlashCommandIcon /><span><strong>{command.command}</strong><small>{command.description}</small></span><kbd>Enter</kbd></button>)}
      </div> : null}
      {scheduleOpen && draftSession && !meshOpen && meshPickerProvider === null ? <form className="composer-schedule-panel" ref={schedulePanel} role="dialog" aria-modal="false" aria-labelledby={scheduleTitleId} onSubmit={(event) => void submitDraftSchedule(event)}>
        <header><span><ClockIcon /><span><strong id={scheduleTitleId}>Schedule task</strong><small>Keep Tethoq running and this computer awake. Missed tasks start when Tethoq resumes.</small></span></span><button type="button" aria-label="Close task scheduling" onClick={() => closeDraftSchedule()}><XIcon /></button></header>
        <label htmlFor={scheduleFieldId}><span>Run at</span><input ref={scheduleField} id={scheduleFieldId} type="datetime-local" value={scheduleValue} readOnly={scheduleBusy || scheduleRetryPending} aria-invalid={scheduleError ? true : undefined} aria-describedby={`${scheduleFieldId}-resolved${scheduleError ? ` ${scheduleFieldId}-error` : ""}${scheduleRetryPending ? ` ${scheduleFieldId}-retry` : ""}`} onChange={(event) => { setScheduleValue(event.target.value); setScheduleFailure(null); }}/></label>
        <p id={`${scheduleFieldId}-resolved`} className="composer-schedule-resolved">{scheduleTime.date ? `Runs ${formatDraftScheduleLocalTime(scheduleTime.date)}` : "Uses this computer's local time."}</p>
        {scheduleRetryPending ? <p id={`${scheduleFieldId}-retry`} className="composer-schedule-resolved">Retrying resubmits the original task. Newer edits stay in this draft.</p> : null}
        {scheduleError ? <p id={`${scheduleFieldId}-error`} className="composer-schedule-error" role="alert">{scheduleError}</p> : null}
        <footer><button type="submit" className="primary" disabled={scheduleBusy}>{scheduleBusy ? <span className="spinner" /> : null}<span>{scheduleRetryPending ? "Retry original task" : "Schedule task"}</span></button></footer>
      </form> : null}
      {meshOpen && meshModelPicker === null ? <div className="mesh-panel-anchor" ref={meshPanel}>
        <MeshPanel snapshot={snapshot} options={meshProviderOptions} targets={meshTargets} selections={meshQuickTargets} activeIndex={safeMeshSelection} listId={meshListId} onHighlight={setMeshSelection} onSelect={commitMeshTarget} onDetails={openMeshModelPicker} onClose={closeMesh} />
      </div> : null}
      {meshMentionVisible ? <div className="mesh-panel-anchor" ref={meshPanel}>
        <MeshMentionPanel snapshot={snapshot} options={meshMentionOptions} emptyMessage={meshTargets.length >= maximumMeshTargets ? "Four subagents are already referenced" : !recentMentionModels.length ? "Use /mesh to choose your first models." : meshMention.query ? `No recent models match @${meshMention.query}. Use /mesh to choose another model.` : "Recent models are unavailable. Use /mesh to choose a model."} activeIndex={safeMeshMentionSelection} listId={meshMentionListId} onHighlight={setMeshMentionSelection} onSelect={(target) => commitMeshTarget(target, meshMention)} onClose={closeMesh} />
      </div> : null}
      {meshPickerProvider ? <div className="mesh-panel-anchor" ref={meshModelPanel}>
        <MeshModelPicker key={`${meshPickerProvider.id}:${meshEditingTarget?.modelId ?? meshPickerInitialTarget?.modelId ?? ""}:${meshEditingTarget?.reasoningEffort ?? meshPickerInitialTarget?.reasoningEffort ?? ""}`} snapshot={snapshot} provider={meshPickerProvider} {...(meshEditingTarget ? { existing: meshEditingTarget } : {})} {...(!meshEditingTarget && meshPickerInitialTarget ? { initial: meshPickerInitialTarget } : {})} onHydrateProviderModels={onHydrateProviderModels} onCommit={commitMeshTarget} onBack={backToMesh} onClose={closeMesh} />
      </div> : null}
      {simplifyCommand.active && !slashPaletteVisible ? <div className="simplify-command-row">
        <Popover
          label="Simplify settings"
          className="simplify-command"
          open={simplifyOpen}
          onOpen={setSimplifyOpen}
          trigger={<><SimplifyIcon /><span>{simplifyCommand.target === "previous" ? "Simplify previous answer" : "Simplify next answer"}</span><ChevronDownIcon /></>}
        >
          <div className="simplify-settings" role="group" aria-label="Simplify response settings">
            <p>Simplify controls this response only, while preserving details the model judges important.</p>
            <span className="simplify-settings-label">Maximum words</span>
            <div className="simplify-presets" aria-label="Maximum words">
              {[100, 200, 300].map((words) => <button key={words} type="button" className={simplifyPreset === String(words) ? "selected" : ""} aria-pressed={simplifyPreset === String(words)} onClick={() => setSimplifySettings((current) => ({ ...current, maxWords: words }))}>{words}</button>)}
              <button type="button" className={simplifyPreset === "custom" ? "selected" : ""} aria-pressed={simplifyPreset === "custom"} onClick={() => setSimplifySettings((current) => ({ ...current, maxWords: simplifyPreset === "custom" ? current.maxWords : 150 }))}>Custom</button>
            </div>
            {simplifyPreset === "custom" ? <label><span>Maximum words</span><input type="number" min={1} max={maximumSimplifyMaxWords} value={simplifySettings.maxWords} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setSimplifySettings((current) => ({ ...current, maxWords: Math.max(1, Math.min(maximumSimplifyMaxWords, Math.trunc(value))) })); }}/></label> : null}
            <label><span>Custom guidance <small>Optional</small></span><textarea value={simplifySettings.guidance ?? ""} maxLength={600} rows={3} placeholder="For example: keep the concrete example." onChange={(event) => setSimplifySettings(normalizeSimplifySettings({ ...simplifySettings, guidance: event.target.value }))}/></label>
          </div>
        </Popover>
      </div> : null}
      {goalIndicatorVisible ? <div className={`composer-goal-indicator${goalArmed ? " is-armed" : ""}`}>
        {goalArmed ? <><span role="status"><GoalIcon /><strong>Goal</strong><span>{sending ? "Sending…" : "Next message"}</span></span><button type="button" aria-label="Cancel goal for next message" disabled={sending} onClick={() => setMode("queue")}><XIcon /></button></>
          : <button type="button" className="composer-current-goal" title={goal!.objective} aria-label={`Manage goal: ${goal!.objective}`} onClick={() => setGoalOpen(true)}><GoalIcon /><strong>Goal {goalLabels[goal!.status].toLowerCase()}</strong><span>{goal!.objective}</span><ChevronDownIcon /></button>}
      </div> : null}
      {annotations.length ? <div className="composer-annotation-chips" role="list" aria-label="Response annotations">{annotations.map((annotation, index) => <ComposerAnnotationChip
        key={annotation.id}
        annotation={annotation}
        index={index}
        onEdit={(anchor) => setAnnotationEditor({ annotation, anchor })}
        onRemove={() => commitAnnotations((current) => current.filter((item) => item.id !== annotation.id))}
      />)}</div> : null}
      {attachments.length || workflowAttachments.length ? <div className="attachment-chips" ref={attachmentList} aria-label="Draft attachments">
        {attachments.map((attachment) => <ComposerAttachmentChip key={attachment.path} attachment={attachment} onPreview={previewAttachment} onRemove={removeAttachment} />)}
        {workflowAttachments.map((attachment) => <span className="workflow-attachment-chip" key={attachment.id}><button type="button" className="workflow-chip-link" title="View workflow details" onClick={() => onManageWorkflow(attachment.id)}><WorkflowIcon /><span><strong>{attachment.name}</strong><small>Recorded workflow</small></span></button><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => commitWorkflowAttachments((current) => current.filter((item) => item.id !== attachment.id))}><XIcon /></button></span>)}
      </div> : null}
      {goalOpen && !draftSession && onGoal ? <GoalSettingsPanel session={session} goal={goal} goalClearRevision={goalClearRevision} notify={notify} onGoal={onGoal} onClose={closeGoal} panelRef={goalPanel} /> : null}
      {permissionOpen && !draftSession ? <PermissionSettings key={session.id} sessionId={session.id} request={request} onClose={closePermission} /> : null}
      {earsOpen ? <EarsSettingsPanel settings={ears} routes={earsRoutesFromSnapshot(snapshot)} onChange={(value) => { void onEarsChange?.(value); }} onClose={() => closeEars()} panelRef={earsPanel} /> : null}
      {earsBusy ? <div className="ears-progress" role="status" aria-live="polite">
        <span>Transcribing dictation…</span>
        <button type="button" className="ears-cancel" onClick={cancelEarsTranscription}>Cancel transcription</button>
      </div> : null}
      <div className="dictation-audio-strip-host" ref={audioStripHost} />
        <div className="composer-entry-row" ref={composerEntryRow}>
          <Popover label="Add attachment" className="composer-attachment-menu" open={attachmentsOpen} onOpen={(open) => { setAttachmentsOpen(open); if (open) setActionsOpen(false); }} trigger={<PlusIcon />}>{attachmentActions}</Popover>
          <div className="composer-input-flow">
            <ComposerMessageInput ref={textarea} value={meshEditorValue(content, meshTargets)} badges={meshTargets.map((target) => {
              const targetProvider = snapshot.providers.find((candidate) => candidate.id === target.providerId);
              const modelLabel = meshTargetModelLabel(snapshot, target);
              return {
                token: target.composerToken!, providerId: target.providerId, name: targetProvider?.name ?? target.providerId, model: modelLabel,
                reasoning: reasoningLabel(target.reasoningEffort ?? "", { providerId: target.providerId, modelId: target.modelId, displayName: modelLabel }),
              };
            })} onChange={(value) => {
              const draft = readMeshEditorValue(value, meshKnownTargets.current);
              historyIndex.current = null;
              unsentHistoryDraft.current = draft.content;
              setSlashPaletteDismissed(false);
              setMeshMentionDismissed(false);
              commitContent(draft.content, draft.targets);
            }} onSelectionChange={(start, end) => setComposerCaret(start === end ? start : -1)} onCopy={copyMeshSelection} onCut={(event) => {
              if (copyMeshSelection(event)) document.execCommand("delete");
            }} onPaste={onPaste} onKeyDown={onKeyDown}
              onEdit={(token) => { const target = meshTargets.find((item) => item.composerToken === token); if (target) openMeshModelPicker(target.providerId, token); }}
              onRemove={removeMeshTarget}
              placeholder={goalArmed ? "Describe the goal…" : draftSession ? "Describe the task…" : meshOpen ? "Optional instruction for the mesh…" : holdsFollowUpQueue ? "Add an instruction…" : "Continue this task…"}
              expanded={slashPaletteVisible || meshOpen || meshMentionVisible} controls={slashPaletteVisible ? slashListId : meshOpen ? meshListId : meshMentionVisible ? meshMentionListId : undefined}
              activeDescendant={slashPaletteVisible && slashSuggestions?.length ? `${slashListId}-${slashSuggestions[Math.min(slashSelection, slashSuggestions.length - 1)]!.id}` : meshOpen && meshProviderOptions.length ? `${meshListId}-${safeMeshSelection}` : meshMentionVisible && meshMentionOptions.length ? `${meshMentionListId}-${safeMeshMentionSelection}` : undefined} />
          </div>
        <div className="composer-primary-actions">
          <Popover label="More message actions" className="composer-actions-menu" open={actionsOpen} onOpen={(open) => { setActionsOpen(open); if (open) setAttachmentsOpen(false); }} trigger={<MoreIcon />}>{actions}</Popover>
          <DictationControl providerId={providerId} ref={dictationControl} request={request} notify={notify} onTranscript={(transcript) => { const sending = sendAfterDictation.current; commitContent((current) => appendTranscript(current, transcript)); if (!sending) requestAnimationFrame(() => textarea.current?.focus()); }} onAudio={(audio) => { const sending = sendAfterDictation.current; addAudio(audio); if (!sending) requestAnimationFrame(() => textarea.current?.focus()); }} audioDictationAvailable={audioRecordingAvailable} directToModel={audioDictationAvailable} liveStripHost={audioStripHost} onPhaseChange={setDictationPhase} onSettled={(committed) => { const sending = sendAfterDictation.current; sendAfterDictation.current = false; if (committed && sending && mounted.current) void submit(); }}/>
          <IconButton
            label={dictationRecording ? "Stop dictation and send" : meshTargets.length ? "Send mesh delegation" : stopTaskAvailable ? "Stop task" : goalArmed ? "Send as goal" : draftSession ? "Start task" : mode === "steer" ? "Steer task" : "Send instruction"}
            className={`send-button ${stopTaskAvailable ? "stop-button" : ""}`}
            /* Never disabled by what we last wrote down about the harness. That note
               can be wrong - it is rebuilt on a handful of occasions and any moment the
               tool could not answer gets written into it - and a disabled control gives
               a person nothing to press and no reason why, so a message simply vanished
               on the way out. Pressing send now always attempts it, and the attempt asks
               the harness itself; a real refusal comes back in the harness's own words. */
            disabled={sending || materializingAction !== null || scheduleBusy || interrupting || dictationPhase === "transcribing" || (meshTargets.length ? false : !dictationRecording && !stopTaskAvailable && nothingToSend)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.click(); } }}
            onClick={primaryAction}
          >{sending || materializingAction !== null ? <span className="spinner" /> : stopTaskAvailable ? <StopIcon /> : mode === "steer" && !dictationRecording ? <SlidersIcon /> : <SendIcon className="send-arrow-icon" />}</IconButton>
        </div>
      </div>
    </div>
  </div>;
}
