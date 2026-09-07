import { QuestionCard } from "./QuestionCard";
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { meshTargetRoute, moveMeshTargets } from "./mesh_composer";
import type { BrowserDownloadState, BrowserWorkspaceState, DesktopBootstrap, DesktopConnectorDescriptor, DesktopEventBatch, DesktopPreferencesState, DesktopRuntimeState, LocalOpenState, PendingDesktopConnectorDescriptor, PreferencesAction, RecorderState, TaskOverride, VisionProxyStatus, VisionProxyTarget, WorkflowAttachment, WorkflowDescriptor, WorkflowScreenshot, WorkflowScreenshotImage } from "@shared/desktop_api";
import { normalizeProjectDirectory, normalizeSavedProjectDirectories } from "@shared/project_directories";
import { savedProjectDirectories as demoProjectDirectories } from "./demo";
import type { JsonObject } from "../../../../../packages/protocol/src/index";
import {
  eventToTimelineItems,
  eventClearsProviderStatus,
  demoBrowserState,
  isBrowserPreview,
  isDeliveryUnknownError,
  loadInitialSnapshot,
  listChildSessions,
  listSessions,
  loadProviderModels,
  loadSessionContext,
  isScheduledTaskPlaceholderId,
  mapActiveScheduledTask,
  mapScheduledTaskPresentation,
  mapSessionGoal,
  loadSessionTimelinePage,
  providerStatusValue,
  reconcileSubagentTimeline,
  watchSession,
  unwatchSession,
  reconnectProvider,
  refreshAttention,
  refreshProviders,
  refreshSessions,
  request,
  setSessionContextThreshold,
  selectDirectory,
  selectImages,
  subscribeToDesktop,
} from "./bridge";
import { ChatTimeline, renderedTimelineAnchorIds } from "./ChatTimeline";
import { AgentDefaultsSettings } from "./AgentDefaultsSettings";
import { HarnessConnections } from "./HarnessConnections";
import { Composer, DictationSettings, ResponseAnnotationEditor, SideChatPanel, buildContextHandoffInstruction, clearScheduledDraftContent, formatDraftScheduleLocalTime, mergeFailedComposerDraft, mergeFailedSideChatDraft, parsedVisionStatus, persistRecentModelUsesFromSessions, remainingMeshTargetsAfterSchedule, type ComposerAttachment, type ComposerDraftSnapshot, type ComposerTaskAction, type DelegationDraft, type DraftModelSelection, type DraftSessionMaterializeInput, type DraftSessionScheduleAttemptState, type DraftSessionScheduleInput, type DraftSessionSendInput, type MeshTarget, type PendingComposerAction, type QueuedNewTaskPresentation, type SideChatDraft } from "./Composer";
import { canonicalSessionWorkingBoundary, captureSessionWorkingBoundary, isAmbiguousSelectionValue, isPersistedCodexFinalAnswer, latestTurnHasCompletedFinal, modelAcceptsDirectAudio, parentSessionIdForBack, presentedSessionState, providerAcceptsDirectAudio, quietCatchUpDue, quietCatchUpIntervalMs, resolveConcreteModelSelection, selectedSessionLastDeltaAt, sessionBoundaryNeedsVisibleEnding, sessionHoldsFollowUpQueue, sessionNeedsTranscriptCatchUp, sessionPresentsLiveTurn, shouldApplySessionState, terminalSessionNeedsCanonicalHistory, terminalStateEventAction, type SessionWorkingBoundary, type TerminalStateEventAction, unownedTurnFollowMs, unownedTurnSilenceMs } from "./composer_helpers";
import { anchoredTimelineRevealStart, mergeAcceptedComposerRow, mergeTimeline, mergeTimelineImageHydration, reconcileTimelinePage, rollbackOptimisticComposerRow, settleRunningTimeline, settleTimelineImagePlaceholders, timelineRevealAnchorKey } from "./timeline_merge";
import { mergeAuthoritativeOpenedSession, mergeRefreshedSessions, sameSessionContext, scheduledTaskEventSchedule, scheduledTaskFailureCanRetractPresentation, scheduledTaskPresentationState, scheduledTaskScheduleAfterProviderEvidence, withoutRetiredScheduledSessions } from "./session_refresh";
import { parseResponseAnnotations, visibleResponseAnnotationBody, type ResponseAnnotation } from "./response_annotations";
import { visibleToastFeedback } from "./toast_feedback";
import { LiveSessionPanel } from "./LiveSession";
import { Sidebar, type NavigationView as View, type SessionFilter, type SideChatAnchor } from "./NavigationPanels";
import { WorkflowSettings } from "./WorkflowSettings";
import { MobileConnectionDialog } from "./MobileConnectionDialog";
import { AppTooltipLayer } from "./TooltipLayer";
import { LocalOpenHandlerGlyph, LocalOpenProvider, WorkspaceLocalOpenControl, previewLocalOpenState, useLocalOpen, type LocalOpenLocation } from "./LocalOpen";
import { maximumUiSearchCharacters, normalizeUiSearchQuery } from "./search_helpers";
import { compareOrganizedSessions, isHiddenByArchive, matchesProviderFilters, organizeSessions } from "./task_organization";
import { beginModelHydration, mergeLatestModelCatalogues } from "./model_hydration";
import { isSideChatSession, sessionsForTaskListMode, sideChatParentSessionId } from "./session_projects";
import { HISTORY_PAGE_LIMIT, anchoredScrollTop, clampScrollTop, distanceFromEnd, firstScrollMemberToken, historyPageNeedsRebase, isAtPhysicalBottom, isHistoryPageExpired, movedOffEnd, readerReturnedToEnd, retainedHistoryCursor, scrollAnchorMatches, shouldRequestOlder } from "./conversation_scroll";
import { timelinePresentationSignature } from "./timeline_presentation";
import { presentedNavigationView, presentedRuntimeConnectionState, progressiveStartupDraftId, progressiveStartupSnapshot, resolvedStartupDraftTimelines, retainedStartupDraftSessions, selectedSessionAfterStartupHydration, type RuntimeConnectionPresentation } from "./progressive_startup";
import { composerDraftSnapshot, rebindComposerDraftState, type ComposerDraftStores } from "./composer_draft_store";
import {
  Button,
  EmptyState,
  ErrorBanner,
  IconButton,
  Modal,
  ProviderLabel,
  ProviderLogo,
  providerDisplayName,
  Status,
  Toast,
  relativeTime,
} from "./components";
import {
  AlertIcon,
  ArrowLeftIcon,
  BranchIcon,
  BrowserIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  FolderIcon,
  GlobeIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  StopIcon,
  DownloadIcon,
  HomeIcon,
  InfoIcon,
  KeyboardIcon,
  LockIcon,
  MouseIcon,
  MutedIcon,
  ScreenshotIcon,
  TrashIcon,
  TerminalIcon,
  XIcon,
  WorkflowIcon,
  WalletIcon,
  VolumeIcon,
} from "./icons";
import type {
  ApprovalRequest,
  DesktopSnapshot,
  InputRequest,
  ModelOption,
  Provider,
  ProviderFilterSelection,
  ProviderId,
  ProviderStatus,
  Session,
  SessionContextState,
  SessionGoal,
  SessionSchedule,
  SessionState,
  TimelineItem,
} from "./types";

export function reconcileVisionStatusEvents(
  current: Readonly<Record<string, VisionProxyStatus>>,
  events: DesktopEventBatch["events"],
): Readonly<Record<string, VisionProxyStatus>> {
  let next: Record<string, VisionProxyStatus> | undefined;
  for (const event of events) {
    if (event.type !== "session.vision_updated" || !event.sessionId) continue;
    const status = parsedVisionStatus(event.payload.vision, event.sessionId);
    if (status === undefined) continue;
    next ??= { ...current };
    next[event.sessionId] = status;
  }
  return next ?? current;
}
import tethoqIconUrl from "../../../assets/tethoq-icon.png";

const emptyResponseAnnotations: readonly ResponseAnnotation[] = Object.freeze([]);

function eventInvalidatesHiddenTimeline(event: DesktopEventBatch["events"][number]): boolean {
  return ((event.type === "session.updated" || event.type === "session.status_changed") && event.payload.state === "working")
    || event.type === "context.compaction_completed"
    || event.type === "context.compaction_failed"
    || event.type === "file.changed"
    || event.type === "agent.interrupted"
    || event.type === "agent.error"
    || event.type === "message.started"
    || event.type === "message.delta"
    || event.type === "message.completed"
    || event.type.startsWith("tool.")
    || event.type.startsWith("command.")
    || event.type.startsWith("delegation.");
}

export function hiddenTimelineRequestIsCurrent(
  requestedSessionId: string,
  loadedSessionId: string | undefined,
  requestedLiveGeneration: number,
  currentLiveGeneration: number,
  requestedRequestGeneration: number,
  currentRequestGeneration: number,
): boolean {
  return (loadedSessionId === undefined || loadedSessionId === requestedSessionId)
    && requestedLiveGeneration === currentLiveGeneration
    && requestedRequestGeneration === currentRequestGeneration;
}

export function attentionResponseIsCurrent(requestedRevision: number, currentRevision: number): boolean {
  return requestedRevision === currentRevision;
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

const navigationPanelStorageKey = "tethoq.navigation-panel-width";
const minimumNavigationPanelWidth = 210;
const maximumNavigationPanelWidth = 440;
function defaultNavigationPanelWidth(viewportWidth: number): number {
  if (viewportWidth >= 1_800) return 270;
  if (viewportWidth <= 1_180) return 232;
  return 248;
}

function clampNavigationPanelWidth(width: number, viewportWidth: number): number {
  const responsiveMaximum = Math.max(minimumNavigationPanelWidth, Math.min(maximumNavigationPanelWidth, viewportWidth - 560));
  return Math.round(Math.min(responsiveMaximum, Math.max(minimumNavigationPanelWidth, width)));
}

function initialNavigationPanelWidth(): number {
  const fallback = defaultNavigationPanelWidth(window.innerWidth);
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(navigationPanelStorageKey) ?? "");
    return clampNavigationPanelWidth(Number.isFinite(stored) ? stored : fallback, window.innerWidth);
  } catch {
    return clampNavigationPanelWidth(fallback, window.innerWidth);
  }
}

function cloneSnapshot(snapshot: DesktopSnapshot): DesktopSnapshot {
  return { ...snapshot, providers: [...snapshot.providers], sessions: [...snapshot.sessions], timelines: { ...snapshot.timelines }, approvals: [...snapshot.approvals], inputRequests: [...snapshot.inputRequests], models: { ...snapshot.models }, goals: { ...snapshot.goals }, goalClearRevisions: { ...snapshot.goalClearRevisions } };
}

function reconcileGoalResult(snapshot: DesktopSnapshot, sessionId: string, goal: SessionGoal | null, clearRevision?: number, expectedRevision?: number): DesktopSnapshot {
  const currentGoal = snapshot.goals[sessionId];
  const clearedThrough = snapshot.goalClearRevisions[sessionId] ?? -1;
  if (goal !== null) {
    if (goal.sessionId !== sessionId || goal.revision <= clearedThrough || (currentGoal !== undefined && goal.revision < currentGoal.revision)) return snapshot;
  } else if (clearRevision === undefined && expectedRevision !== undefined && currentGoal !== undefined && currentGoal.revision > expectedRevision) {
    return snapshot;
  }
  const clearIsOlder = clearRevision !== undefined && currentGoal !== undefined && clearRevision < currentGoal.revision;
  return {
    ...snapshot,
    goals: goal === null && !clearIsOlder
      ? Object.fromEntries(Object.entries(snapshot.goals).filter(([id]) => id !== sessionId))
      : goal === null ? snapshot.goals : { ...snapshot.goals, [sessionId]: goal },
    goalClearRevisions: clearRevision === undefined
      ? snapshot.goalClearRevisions
      : { ...snapshot.goalClearRevisions, [sessionId]: Math.max(clearedThrough, clearRevision) },
  };
}

type SessionUpdate = Omit<Partial<Session>, "providerStatus" | "schedule"> & {
  providerStatus?: ProviderStatus | null;
  schedule?: SessionSchedule | null;
};

interface DraftScheduleAttemptRecord {
  input: DraftSessionScheduleInput;
  inFlight: Promise<void> | null;
  failure: string | null;
}

function replaceSession(sessions: Session[], sessionId: string, update: SessionUpdate): Session[] {
  return sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const { providerStatus, schedule, ...rest } = update;
    const merged = { ...session, ...rest };
    if (rest.state !== undefined && rest.state !== "idle") delete merged.interruptedAt;
    const withSchedule = schedule === null
      ? (() => { const { schedule: _removed, ...withoutSchedule } = merged; return withoutSchedule; })()
      : schedule ? { ...merged, schedule } : merged;
    if (providerStatus) return { ...withSchedule, providerStatus };
    if (providerStatus === null) {
      const { providerStatus: _removed, ...withoutProviderStatus } = withSchedule;
      return withoutProviderStatus;
    }
    return withSchedule;
  });
}

function applyOpenedSessionPreview(sessions: Session[], opened: Session | undefined): Session[] {
  if (opened === undefined) return sessions;
  const current = sessions.find((session) => session.id === opened.id);
  if (current === undefined || current.preview === opened.preview) return sessions;
  return sessions.map((session) => session.id === opened.id ? { ...session, preview: opened.preview } : session);
}

/**
 * A forced session.open has already re-read provider truth. Adopt that task's
 * provider-owned fields while retaining local organisation and renamed titles.
 * Callers must still reject a response when a newer live event advanced the
 * task after the request began.
 */
function applyOpenedSessionRefresh(sessions: Session[], opened: Session | undefined): Session[] {
  if (opened === undefined) return sessions;
  const current = sessions.find((session) => session.id === opened.id);
  if (current === undefined) return sessions;
  const reconciled = mergeAuthoritativeOpenedSession(current, opened);
  if (reconciled === current) return sessions;
  return sessions.map((session) => session.id === opened.id ? reconciled : session);
}

type ChildSessionLoader = (parentSessionId: string) => Promise<Session[]>;

function isExactSubagentChild(session: Session, parentSessionId: string, childSessionId: string): boolean {
  return session.id === childSessionId
    && session.relationshipKind === "subagent"
    && session.relationshipSourceSessionId === parentSessionId;
}

/** Resolve only the complete child task named by a structured Mesh timeline row. */
export async function resolveTimelineSubagentSession(
  parentSessionId: string,
  childSessionId: string,
  cachedSessions: readonly Session[],
  loadChildren: ChildSessionLoader = listChildSessions,
): Promise<Session | null> {
  const exactChildSessionId = childSessionId.trim();
  if (!parentSessionId || !exactChildSessionId) return null;
  const cached = cachedSessions.find((candidate) => isExactSubagentChild(candidate, parentSessionId, exactChildSessionId));
  if (cached) return cached;
  const children = await loadChildren(parentSessionId);
  return children.find((candidate) => isExactSubagentChild(candidate, parentSessionId, exactChildSessionId)) ?? null;
}

function derivedSession(value: Record<string, unknown>, source: Session): Session {
  if (typeof value.id !== "string" || !value.id) throw new Error("Bridge returned an invalid derived task.");
  const providerId = typeof value.providerId === "string" ? value.providerId : source.providerId;
  const workingDirectory = typeof value.workingDirectory === "string" ? value.workingDirectory : source.workingDirectory;
  const state = value.state === "disconnected" ? "offline" : value.state === "unknown" ? "idle" : typeof value.state === "string" && ["working", "needs_approval", "needs_input", "idle", "completed", "failed", "offline"].includes(value.state) ? value.state as SessionState : "working";
  const metadata = value.nativeMetadata && typeof value.nativeMetadata === "object" && !Array.isArray(value.nativeMetadata) ? value.nativeMetadata as Record<string, unknown> : {};
  const sessionKind = value.sessionKind === "side_chat" || value.sessionKind === "internal" ? value.sessionKind : "task";
  const parentSessionId = typeof value.parentSessionId === "string" && value.parentSessionId ? value.parentSessionId : undefined;
  const contextSummary = typeof value.contextHandoffSummary === "string" && value.contextHandoffSummary
    ? value.contextHandoffSummary
    : typeof metadata.tethoqHandoffSummary === "string" && metadata.tethoqHandoffSummary
      ? metadata.tethoqHandoffSummary
      : undefined;
  const relationship = value.relationship && typeof value.relationship === "object" && !Array.isArray(value.relationship)
    ? value.relationship as Record<string, unknown>
    : undefined;
  const relationshipKind = relationship && typeof relationship.kind === "string" && ["handoff", "branch", "subagent", "side_chat", "model_switch"].includes(relationship.kind)
    ? relationship.kind as Session["relationshipKind"]
    : undefined;
  const relationshipSourceSessionId = relationship && typeof relationship.sourceSessionId === "string" && relationship.sourceSessionId
    ? relationship.sourceSessionId
    : undefined;
  const providerStatus = providerStatusValue(value.providerStatus);
  return {
    id: value.id,
    sessionKind,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(relationshipKind ? { relationshipKind } : {}),
    ...(relationshipSourceSessionId ? { relationshipSourceSessionId } : {}),
    providerId,
    title: typeof value.title === "string" && value.title ? value.title : `${source.title} · continuation`,
    state,
    project: typeof value.project === "string" && value.project ? value.project : workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? source.project,
    workingDirectory,
    preview: typeof value.preview === "string" ? value.preview : "Context transferred from the previous task.",
    updatedAt: typeof value.lastActivityAt === "string" ? value.lastActivityAt : new Date().toISOString(),
    model: typeof value.modelId === "string" ? value.modelId : source.model,
    effort: typeof value.reasoningEffort === "string"
      ? value.reasoningEffort
      : typeof value.variantId === "string" ? value.variantId : source.effort,
    ...(providerStatus ? { providerStatus } : {}),
    ...(contextSummary !== undefined ? { contextSummary } : {}),
  };
}

function withoutQueuedNewTaskDelivery(item: TimelineItem): TimelineItem {
  const {
    queuedNewTaskDeliveryId: _deliveryId,
    queuedNewTaskDeliveryState: _deliveryState,
    queuedNewTaskDeliveryError: _deliveryError,
    ...settled
  } = item;
  return settled;
}

function sideChatEventSession(value: unknown, sessions: readonly Session[], occurredAt: string): Session | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const parentSessionId = typeof raw.parentSessionId === "string" ? raw.parentSessionId : undefined;
  const existing = sessions.find((session) => session.id === raw.id);
  const parent = parentSessionId ? sessions.find((session) => session.id === parentSessionId) : undefined;
  const fallbackProviderId = typeof raw.providerId === "string" ? raw.providerId : existing?.providerId ?? parent?.providerId;
  if (!fallbackProviderId) return null;
  const workingDirectory = typeof raw.workingDirectory === "string" ? raw.workingDirectory : existing?.workingDirectory ?? parent?.workingDirectory ?? "";
  const source: Session = existing ?? parent ?? {
    id: raw.id,
    providerId: fallbackProviderId,
    title: typeof raw.title === "string" && raw.title ? raw.title : "Side chat",
    state: "idle",
    project: workingDirectory.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Task",
    workingDirectory,
    preview: typeof raw.preview === "string" ? raw.preview : "",
    updatedAt: occurredAt,
    model: typeof raw.modelId === "string" ? raw.modelId : "",
    effort: typeof raw.reasoningEffort === "string"
      ? raw.reasoningEffort
      : typeof raw.variantId === "string" ? raw.variantId : "Default",
  };
  try { return derivedSession(raw, source); }
  catch { return null; }
}

function materializedDraftSession(value: unknown, input: DraftSessionMaterializeInput, source: Session, title: string, state: SessionState, preview: string): Session {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridge returned an invalid new task.");
  const raw = value as Record<string, unknown>;
  const selectedSource: Session = {
    ...source,
    providerId: input.providerId,
    title,
    state,
    project: input.workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "New project",
    workingDirectory: input.workingDirectory,
    preview,
    model: input.modelId,
    effort: input.effort,
  };
  const mapped = derivedSession(raw, selectedSource);
  return {
    ...mapped,
    title,
    state,
    preview,
    model: typeof raw.modelId === "string" ? raw.modelId : input.modelId,
    effort: typeof raw.reasoningEffort === "string"
      ? raw.reasoningEffort
      : typeof raw.variantId === "string" ? raw.variantId : input.effort,
  };
}

function createdScheduledSession(taskValue: unknown, input: DraftSessionScheduleInput): Session {
  const scheduled = mapActiveScheduledTask(taskValue);
  if (scheduled === null || scheduled.session.providerId !== input.providerId) {
    throw new Error("Bridge returned an invalid scheduled task.");
  }
  return {
    ...scheduled.session,
    title: input.title,
    state: "idle",
    preview: input.preview,
    model: input.modelId,
    effort: input.effort,
    schedule: scheduled.schedule,
  };
}

function isLiveTurnEvent(event: DesktopEventBatch["events"][number]): boolean {
  if (event.type === "message.started" || event.type === "message.delta" || event.type === "tool.started" || event.type === "command.started") return true;
  return (event.type === "session.updated" || event.type === "session.status_changed") && event.payload.state === "working";
}

function eventProvesScheduledProviderActivity(event: DesktopEventBatch["events"][number]): boolean {
  if (event.type === "message.started" || event.type === "message.delta" || event.type === "message.completed") return true;
  if (event.type.startsWith("tool.") || event.type.startsWith("command.")) return true;
  if (event.type === "agent.completed" || event.type === "agent.interrupted" || event.type === "agent.error") return true;
  if (event.type !== "session.updated" && event.type !== "session.status_changed") return false;
  return event.payload.state === "working"
    || event.payload.state === "needs_approval"
    || event.payload.state === "needs_input"
    || event.payload.state === "completed"
    || event.payload.state === "failed";
}

export function eventRequiresCanonicalTranscriptRefresh(event: DesktopEventBatch["events"][number]): boolean {
  return event.type === "message.completed" && event.payload.requiresHistoryRefresh === true;
}

/**
 * Only an explicit marker may bypass the quiet debounce. Raw provider event
 * metadata is not part of the desktop stream, so its absence proves nothing.
 */
function isAuthoritativeOpenCodeGuardCompletion(event: DesktopEventBatch["events"][number]): boolean {
  return event.type === "agent.completed" && event.providerId === "opencode" && event.payload.completionReason === "runaway_guard";
}

interface TimelineWindowState {
  nextCursor: string | null;
  revealStart: number;
  revealAnchorKey: string | null;
  loadingOlder: boolean;
}

/** One scroll gesture may cross sparse provider pages, but never without a cap. */
const maximumInvisibleHistoryPages = 4;

function initialTimelineRevealStart(items: readonly TimelineItem[], assistantCount = 3): number {
  const selectedMessages = new Set<string>();
  let firstAssistant = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== "assistant") continue;
    const messageId = item.messageId ?? item.id;
    if (!selectedMessages.has(messageId)) {
      if (selectedMessages.size >= assistantCount) break;
      selectedMessages.add(messageId);
    }
    firstAssistant = index;
  }
  if (firstAssistant < 0) return Math.max(0, items.length - 12);
  if (firstAssistant === 0) return 0;
  let revealStart = firstAssistant;
  for (let index = firstAssistant - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "user") return index;
    if (item.kind === "assistant" && !selectedMessages.has(item.messageId ?? item.id)) break;
    revealStart = index;
  }
  return revealStart;
}

function initialTimelineWindow(items: readonly TimelineItem[], nextCursor: string | null): TimelineWindowState {
  const revealStart = initialTimelineRevealStart(items);
  return {
    nextCursor,
    revealStart,
    revealAnchorKey: items[revealStart] ? timelineRevealAnchorKey(items[revealStart]!) : null,
    loadingOlder: false,
  };
}

function prependTimelinePage(existing: readonly TimelineItem[], older: readonly TimelineItem[]): TimelineItem[] {
  const seen = new Set(older.map((item) => item.id));
  return [...older, ...existing.filter((item) => !seen.has(item.id))];
}


const providerFor = (providers: Provider[], providerId: ProviderId): Provider | undefined =>
  providers.find((provider) => provider.id === providerId);

const emptySideChatDraft: SideChatDraft = { content: "", attachments: [] };
const initialDesktopPreferences: DesktopPreferencesState = {
  version: 1,
  experimentalFeatures: false,
  reasoningDisplay: "compact",
  taskListMode: "recent",
  savedProjectDirectories: isBrowserPreview ? demoProjectDirectories : [],
  localOpenHandlerId: "system",
  closeAction: "tray",
  launchAtLogin: "off",
  alerts: "all",
  agentDefaults: {},
  globalAgentsPath: null,
  taskOverrides: {},
  allowForeignSubagents: false,
  foreignSubagentOverrides: {},
  ears: { enabled: false, providerId: null, modelId: null, mode: "cleaned" },
};

const previewWorkflowId = "preview-workflow-capture";
const previewWorkflowScreenshots: readonly WorkflowScreenshot[] = Object.freeze([
  { frameId: "frame-000001", name: "frame-000001.jpg" },
  { frameId: "frame-000002", name: "frame-000002.jpg" },
  { frameId: "frame-000003", name: "frame-000003.jpg" },
  { frameId: "frame-000004", name: "frame-000004.jpg" },
]);
const previewWorkflow = Object.freeze<WorkflowDescriptor>({
  id: previewWorkflowId,
  name: "Import footage into CapCut",
  status: "saved",
  path: "C:\\Tethoq\\workflows\\preview-workflow-capture",
  manifestPath: "C:\\Tethoq\\workflows\\preview-workflow-capture\\manifest.json",
  eventsPath: "C:\\Tethoq\\workflows\\preview-workflow-capture\\events.jsonl",
  startedAt: "2026-08-16T11:08:00.000Z",
  stoppedAt: "2026-08-16T11:09:34.000Z",
  durationMs: 94_000,
  stopReason: "user",
  summary: { apps: ["CapCut", "File Explorer"], eventCount: 46, screenshotCount: previewWorkflowScreenshots.length, clickCount: 9, dragCount: 2, keyEventCount: 14, droppedFrames: 0, contextErrors: 0, bytesWritten: 1_284_000 },
  privacy: { localOnly: true, neverUploadedAutomatically: true, capturesScreen: true, capturesGlobalInput: true, capturesKeyCodesNotText: true, sensitiveDataPossible: true, warning: "Recording may capture sensitive screen and input context.", limitations: [] },
});

function previewWorkflowScreenshot(frameId: string): WorkflowScreenshotImage {
  const index = Math.max(0, previewWorkflowScreenshots.findIndex((item) => item.frameId === frameId));
  const labels = ["Select footage", "Open import", "Choose folder", "Confirm media"];
  const accents = ["#8e9bff", "#85d6bc", "#d7a977", "#b89bda"];
  const label = labels[index] ?? "Captured step";
  const accent = accents[index] ?? "#8e9bff";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#111211"/><rect x="24" y="24" width="1232" height="62" rx="12" fill="#242523"/><circle cx="57" cy="55" r="10" fill="${accent}"/><text x="82" y="64" fill="#f5f6f3" font-family="Segoe UI,Arial" font-size="25" font-weight="600">${label}</text><rect x="24" y="110" width="250" height="586" rx="12" fill="#1b1c1a"/><rect x="298" y="110" width="958" height="586" rx="12" fill="#191a18"/><rect x="328" y="148" width="380" height="26" rx="7" fill="#31332f"/><rect x="328" y="194" width="786" height="18" rx="5" fill="#292a27"/><rect x="328" y="226" width="680" height="18" rx="5" fill="#292a27"/><rect x="328" y="284" width="898" height="340" rx="10" fill="#222320"/><rect x="352" y="310" width="212" height="154" rx="8" fill="${accent}" fill-opacity=".26"/><path d="M760 380 L760 455 L783 437 L801 478 L821 468 L803 428 L831 426 Z" fill="#090a09" stroke="#f5f6f3" stroke-width="7" stroke-linejoin="round"/><text x="328" y="666" fill="#aeb3ad" font-family="Segoe UI,Arial" font-size="20">Pointer location is captured with this frame</text></svg>`;
  const screenshot = previewWorkflowScreenshots[index] ?? previewWorkflowScreenshots[0]!;
  return { ...screenshot, dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width: 1280, height: 720 };
}
type SideChatDraftUpdate = SideChatDraft | ((current: SideChatDraft) => SideChatDraft);

interface DraftMaterializationResult {
  readonly session: Session;
  readonly firstInstructionIncluded: boolean;
  readonly timeline?: readonly TimelineItem[];
}

interface DraftMaterializationRecord {
  readonly promise: Promise<DraftMaterializationResult>;
}

function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(() => progressiveStartupSnapshot());
  const snapshotRef = useRef<DesktopSnapshot | null>(snapshot);
  snapshotRef.current = snapshot;
  useEffect(() => {
    if (snapshot) persistRecentModelUsesFromSessions(snapshot.sessions, snapshot.models);
  }, [snapshot?.models, snapshot?.sessions]);
  const [bootstrap, setBootstrap] = useState<DesktopBootstrap | undefined>();
  const [runtime, setRuntime] = useState<DesktopRuntimeState>({ state: "starting" });
  const [visionBySession, setVisionBySession] = useState<Readonly<Record<string, VisionProxyStatus>>>({});
  const visionBySessionRef = useRef<Readonly<Record<string, VisionProxyStatus>>>({});
  const readVisionStatus = useCallback((sessionId: string) => visionBySessionRef.current[sessionId], []);
  const [view, setView] = useState<View>("dashboard");
  const [directApiSetupRevision, setDirectApiSetupRevision] = useState(0);
  const viewRef = useRef<View>(view);
  viewRef.current = view;
  const settingsReturnView = useRef<Exclude<View, "settings">>("dashboard");
  const settingsOpener = useRef<HTMLElement | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderFilterSelection>("all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const lastLiveDeltaAt = useRef(0);
  const lastLiveDeltaBySession = useRef(new Map<string, number>());
  // A latest-history request may begin while the stream is quiet, then resolve
  // after the next chunk arrives. Keep a per-task generation so that late page
  // cannot replace or split the live tail it predates.
  const liveTimelineGenerationBySession = useRef(new Map<string, number>());
  // Reopening the same dirty task can start a second canonical read before the
  // first returns. Keep only the newest request for that task, even when no live
  // event arrived between the two reads.
  const hiddenTimelineRequestGenerationBySession = useRef(new Map<string, number>());
  // Session listings are asynchronous. A per-task live revision prevents an
  // older response from restoring state (especially a retry notice) that a
  // newer event already cleared.
  const liveSessionRevisionBySession = useRef(new Map<string, number>());
  const attentionRevision = useRef(0);
  // A provider can report a newly running turn before its first transcript row
  // exists. Remember the final/error that was visible at that transition so the
  // previous turn cannot suppress the task-list spinner, reasoning shimmer, or
  // Stop/queue controls for the newer work.
  const workingBoundaryBySession = useRef(new Map<string, SessionWorkingBoundary>());
  // Confirmed interruptions suppress stale same-turn presentation. An in-flight
  // Stop request must keep displaying provider state until it is acknowledged.
  const stopPresentationSessionIdsRef = useRef(new Set<string>());
  const [stopPresentationSessionIds, setStopPresentationSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const setStopPresentation = useCallback((sessionId: string, active: boolean) => {
    const current = stopPresentationSessionIdsRef.current;
    if (current.has(sessionId) === active) return;
    const next = new Set(current);
    if (active) next.add(sessionId);
    else next.delete(sessionId);
    stopPresentationSessionIdsRef.current = next;
    setStopPresentationSessionIds(next);
  }, []);
  const seedWorkingBoundary = useCallback((session: Session | undefined, timeline: readonly TimelineItem[]) => {
    if (!session) return;
    const next = canonicalSessionWorkingBoundary(session, timeline, workingBoundaryBySession.current.get(session.id));
    if (next) workingBoundaryBySession.current.set(session.id, next);
    else workingBoundaryBySession.current.delete(session.id);
  }, []);
  const captureResumedTurnBoundary = useCallback((sessionId: string, boundary: SessionWorkingBoundary) => {
    const timeline = snapshotRef.current?.timelines[sessionId] ?? [];
    // The provider may publish the resumed turn while the response RPC is in
    // flight. Do not replace that newer ending with the older captured one.
    if (!sessionBoundaryNeedsVisibleEnding(timeline, boundary)) return;
    workingBoundaryBySession.current.set(sessionId, boundary);
  }, []);
  const prepareResumedTurnBoundary = useCallback((sessionId: string): (() => void) => {
    const boundary = captureSessionWorkingBoundary(snapshotRef.current?.timelines[sessionId] ?? []);
    return () => captureResumedTurnBoundary(sessionId, boundary);
  }, [captureResumedTurnBoundary]);
  const lastEventSequence = useRef(0);
  const seenEventSequences = useRef(new Set<number>());
  const startupReplaySequence = useRef<number | null>(null);
  const startupReplayStarted = useRef(false);
  const watchedSessionIds = useRef(new Set<string>());
  const hiddenTimelineDirtySessionIds = useRef(new Set<string>());
  const selectedViewRefreshInFlight = useRef(new Set<string>());
  const selectedViewForcedRefreshQueued = useRef(new Set<string>());
  const canonicalHistoryGenerationBySession = useRef(new Map<string, number>());
  const imageHydrationGenerations = useRef(new Map<string, number>());
  const catalogueRefreshPending = useRef(false);
  const wasDocumentHidden = useRef(typeof document !== "undefined" ? document.hidden : false);
  const selectedLastDelta = useCallback((sessionId: string | null): number =>
    selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, sessionId, lastLiveDeltaAt.current), []);
  useEffect(() => {
    if (!snapshot) return;
    const retained = new Set(snapshot.sessions.map((session) => session.id));
    for (const sessionId of workingBoundaryBySession.current.keys()) {
      if (!retained.has(sessionId)) workingBoundaryBySession.current.delete(sessionId);
    }
    for (const sessionId of stopPresentationSessionIdsRef.current) {
      if (!retained.has(sessionId)) setStopPresentation(sessionId, false);
    }
  }, [setStopPresentation, snapshot?.sessions]);
  const modelHealAttempts = useRef(new Map<string, number>());
  const modelHydrationGenerations = useRef(new Map<string, number>());
  const hydrateProviderModels = useCallback(async (providers: readonly Provider[]): Promise<Record<string, ModelOption[]>> => {
    const uniqueProviders = [...new Map(providers.map((provider) => [provider.id, provider])).values()];
    const generations = beginModelHydration(modelHydrationGenerations.current, uniqueProviders.map((provider) => provider.id));
    const loaded = await loadProviderModels(uniqueProviders);
    setSnapshot((current) => {
      if (!current) return current;
      const availableProviderIds = new Set(current.providers.map((provider) => provider.id));
      const nextModels = mergeLatestModelCatalogues(current.models, availableProviderIds, loaded, generations, modelHydrationGenerations.current);
      return nextModels === current.models ? current : { ...current, models: nextModels };
    });
    return loaded;
  }, []);
  const hydrateProviderModel = useCallback(async (providerId: Session["providerId"]): Promise<void> => {
    const provider = snapshotRef.current?.providers.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error("That coding tool is no longer available.");
    const loaded = await hydrateProviderModels([provider]);
    if (!Object.hasOwn(loaded, providerId)) throw new Error(`Could not refresh ${provider.name} models.`);
  }, [hydrateProviderModels]);
  // A provider can connect after the initial catalogue load (the supervised
  // OpenCode server starts asynchronously), leaving its models - and therefore
  // the model picker and the composer's reasoning choice - empty. The periodic
  // catch-up heals the selected task's provider once, bounded by a cooldown so
  // a genuinely unresponsive provider is not hammered. Detection state is not
  // consulted: it may itself be stale in the snapshot, while the catalogue
  // request either succeeds or fails cleanly.
  const healMissingModels = useCallback(() => {
    const current = snapshotRef.current;
    const selected = selectedSessionIdRef.current;
    if (!current || !selected) return;
    const session = current.sessions.find((candidate) => candidate.id === selected);
    const provider = session ? current.providers.find((candidate) => candidate.id === session.providerId) : undefined;
    if (!provider) return;
    if ((current.models[provider.id] ?? []).length > 0) return;
    const now = Date.now();
    if (now - (modelHealAttempts.current.get(provider.id) ?? 0) < 120_000) return;
    modelHealAttempts.current.set(provider.id, now);
    void hydrateProviderModels([provider]).catch(() => undefined);
  }, [hydrateProviderModels]);
  const ingestEventBatch = useRef<(batch: DesktopEventBatch) => void>(() => undefined);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<SessionFilter>("all");
  const [listCollapsed, setListCollapsed] = useState(false);
  const [navigationPanelWidth, setNavigationPanelWidth] = useState(initialNavigationPanelWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [mobileConnectionOpen, setMobileConnectionOpen] = useState(false);
  const [queueRevision, setQueueRevision] = useState(0);
  const [showSideChats, setShowSideChats] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [openSideChats, setOpenSideChats] = useState<readonly { id: string; anchor: SideChatAnchor }[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone?: "normal" | "error" } | null>(null);
  const [browser, setBrowser] = useState<BrowserWorkspaceState | null>(isBrowserPreview ? demoBrowserState : null);
  const [browserAddressFocusToken, setBrowserAddressFocusToken] = useState(0);
  const [recorder, setRecorder] = useState<RecorderState>({ phase: "idle", supported: true, privacy: { localOnly: true, neverUploadedAutomatically: true, capturesScreen: true, capturesGlobalInput: true, capturesKeyCodesNotText: true, sensitiveDataPossible: true, warning: "Recording may capture sensitive screen and input context.", limitations: [] } });
  const [workflows, setWorkflows] = useState<readonly WorkflowDescriptor[]>(isBrowserPreview ? [previewWorkflow] : []);
  const [saveWorkflowOpen, setSaveWorkflowOpen] = useState(false);
  const [preferences, setPreferences] = useState<DesktopPreferencesState>(initialDesktopPreferences);
  const [localOpenState, setLocalOpenState] = useState<LocalOpenState>(isBrowserPreview ? previewLocalOpenState : { defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] });
  const [liveSessionTarget, setLiveSessionTarget] = useState<Session | null>(null);
  const [pendingComposerAction, setPendingComposerAction] = useState<PendingComposerAction | null>(null);
  // Draft payloads are owned locally by Composer and retained here only so a
  // task switch can restore them. They must not be root React state: mirroring
  // every keystroke through App re-executes the full task rail, workspace, and
  // large transcript, while image drafts also keep multi-megabyte base64 values
  // on that hot path. Ref writes preserve per-task drafts without scheduling a
  // renderer-wide commit.
  const composerDrafts = useRef<Record<string, string>>({});
  const composerAttachments = useRef<Record<string, readonly ComposerAttachment[]>>({});
  const composerWorkflowAttachments = useRef<Record<string, readonly WorkflowAttachment[]>>({});
  const composerAnnotations = useRef<Record<string, readonly ResponseAnnotation[]>>({});
  const composerModes = useRef<Record<string, "queue" | "steer" | "goal">>({});
  const composerMeshTargets = useRef<Record<string, readonly MeshTarget[]>>({});
  const composerDelegationDrafts = useRef<Record<string, DelegationDraft>>({});
  const composerScheduleAttempts = useRef<Record<string, DraftScheduleAttemptRecord>>({});
  const [composerScheduleAttemptRevision, setComposerScheduleAttemptRevision] = useState(0);
  const latentComposerDraftSessions = useRef<Record<string, { session: Session; scheduledSessionId: string }>>({});
  // A provider-created task replaces its local draft id. Async pickers that
  // started on the draft can still resolve afterwards, so every late write
  // follows this alias instead of resurrecting a dead composition bucket.
  const composerDraftSessionAliases = useRef<Record<string, string>>({});
  const composerDraftMaterializations = useRef(new Map<string, DraftMaterializationRecord>());
  const resolveComposerDraftSessionId = useCallback((sessionId: string) => {
    let resolved = sessionId;
    const visited = new Set<string>();
    while (composerDraftSessionAliases.current[resolved] && !visited.has(resolved)) {
      visited.add(resolved);
      resolved = composerDraftSessionAliases.current[resolved]!;
    }
    return resolved;
  }, []);
  const composerDraftStore: ComposerDraftStores = {
    content: composerDrafts.current,
    attachments: composerAttachments.current,
    workflows: composerWorkflowAttachments.current,
    annotations: composerAnnotations.current,
    modes: composerModes.current,
    meshTargets: composerMeshTargets.current,
  };
  // Creating a provider task can succeed before its attachment-bearing first
  // message fails. In that case the local draft id is replaced by the real task
  // id, and the eventual Composer rollback must follow that replacement.
  const composerDraftRestoreTargets = useRef<Record<string, string>>({});
  // Live draft values stay in refs so typing remains local to Composer. This
  // revision changes only on a failed delivery, when a mounted or remounted
  // Composer must repaint one atomically restored text-and-widget bundle.
  const [composerDraftRestoreRevisions, setComposerDraftRestoreRevisions] = useState<Record<string, number>>({});
  const publishAliasedComposerWrite = useCallback((sourceSessionId: string, resolvedSessionId: string) => {
    if (sourceSessionId === resolvedSessionId) return;
    setComposerDraftRestoreRevisions((current) => ({
      ...current,
      [resolvedSessionId]: (current[resolvedSessionId] ?? 0) + 1,
    }));
  }, []);
  const restoreFailedComposerSubmission = useCallback((sessionId: string, submitted: ComposerDraftSnapshot): ComposerDraftSnapshot => {
    const restoreSessionId = composerDraftRestoreTargets.current[sessionId] ?? resolveComposerDraftSessionId(sessionId);
    delete composerDraftRestoreTargets.current[sessionId];
    const restored = mergeFailedComposerDraft(submitted, {
      content: composerDrafts.current[restoreSessionId] ?? "",
      attachments: composerAttachments.current[restoreSessionId] ?? [],
      workflowAttachments: composerWorkflowAttachments.current[restoreSessionId] ?? [],
      annotations: composerAnnotations.current[restoreSessionId] ?? emptyResponseAnnotations,
    });
    if (restored.content) composerDrafts.current[restoreSessionId] = restored.content;
    else delete composerDrafts.current[restoreSessionId];
    if (restored.attachments.length) composerAttachments.current[restoreSessionId] = restored.attachments;
    else delete composerAttachments.current[restoreSessionId];
    if (restored.workflowAttachments.length) composerWorkflowAttachments.current[restoreSessionId] = restored.workflowAttachments;
    else delete composerWorkflowAttachments.current[restoreSessionId];
    if (restored.annotations.length) composerAnnotations.current[restoreSessionId] = restored.annotations;
    else delete composerAnnotations.current[restoreSessionId];
    setComposerDraftRestoreRevisions((current) => ({
      ...current,
      [restoreSessionId]: (current[restoreSessionId] ?? 0) + 1,
    }));
    return restored;
  }, [resolveComposerDraftSessionId]);
  // Side-chat fields own their live value. This ref only restores a draft after
  // dismissal, so one key never rerenders the App, task rail, and transcript.
  const sideChatDrafts = useRef<Record<string, SideChatDraft>>({});
  // Sending survives panel dismissal and remount. The ref is the synchronous
  // lock; the state set gives a reopened panel the matching disabled/spinner UI.
  const sideChatSendLocks = useRef(new Set<string>());
  const [sideChatSendingSessions, setSideChatSendingSessions] = useState<ReadonlySet<string>>(new Set());
  const [, setSideChatDraftRestoreRevision] = useState(0);
  const [queueingBySession, setQueueingBySession] = useState<Record<string, boolean>>({});
  const [compactionsBySession, setCompactionsBySession] = useState<Record<string, { isCompacting: boolean; kind: "automatic" | "manual" | null }>>({});
  const [timelineWindows, setTimelineWindows] = useState<Record<string, TimelineWindowState>>({});
  const narrow = useMedia("(max-width: 780px)");
  const selectedSessionIdRef = useRef<string | null>(null);
  // Provider-wide events keep every task's lightweight working/idle state
  // current. Transcript rows are retained only where somebody can see them;
  // reopening any other task reloads its bounded canonical tail.
  const visibleTimelineSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const visibleRefreshInFlight = useRef(false);
  const visibleRefreshQueued = useRef(false);
  const visibleRefreshQueuedTimeline = useRef(false);
  const retiredScheduledSessionIdsRef = useRef(new Set<string>());
  const openingSessionIdsRef = useRef(new Set<string>());
  const revokedConnectorIdsRef = useRef(new Set<string>());
  const sideChatsHydratedRef = useRef(false);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);

  selectedSessionIdRef.current = selectedSessionId;
  visibleTimelineSessionIdsRef.current = new Set([
    ...(selectedSessionId ? [selectedSessionId] : []),
    ...openSideChats.map((item) => item.id),
  ]);

  const resolveComposerDraftWriteSessionId = useCallback((sourceSessionId: string, materialize: boolean): string => {
    const resolvedSessionId = resolveComposerDraftSessionId(sourceSessionId);
    const latent = latentComposerDraftSessions.current[resolvedSessionId];
    if (!materialize || latent === undefined) return resolvedSessionId;
    delete latentComposerDraftSessions.current[resolvedSessionId];
    setSnapshot((current) => {
      if (!current || current.sessions.some((session) => session.id === resolvedSessionId)) return current;
      return {
        ...current,
        sessions: [latent.session, ...current.sessions],
        timelines: { ...current.timelines, [resolvedSessionId]: [] },
      };
    });
    setTimelineWindows((current) => current[resolvedSessionId] === undefined
      ? { ...current, [resolvedSessionId]: initialTimelineWindow([], null) }
      : current);
    if (selectedSessionIdRef.current === latent.scheduledSessionId && viewRef.current === "workspace") {
      selectedSessionIdRef.current = resolvedSessionId;
      setSelectedSessionId(resolvedSessionId);
    }
    return resolvedSessionId;
  }, [resolveComposerDraftSessionId]);

  // Opening a task on a narrow window deliberately hides the task list. Once
  // the window becomes wide again that compact-only state has no visible back
  // control, so retaining it strands the full sidebar off screen.
  useEffect(() => { if (!narrow) setListCollapsed(false); }, [narrow]);

  useEffect(() => {
    if (narrow) return;
    try { window.localStorage.setItem(navigationPanelStorageKey, String(navigationPanelWidth)); }
    catch { /* A blocked preference store must not prevent resizing for this window. */ }
  }, [narrow, navigationPanelWidth]);

  useEffect(() => {
    const clampToViewport = () => setNavigationPanelWidth((current) => clampNavigationPanelWidth(current, window.innerWidth));
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, []);

  useEffect(() => () => sidebarResizeCleanupRef.current?.(), []);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (narrow || event.button !== 0) return;
    event.preventDefault();
    sidebarResizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = navigationPanelWidth;
    const resize = (moveEvent: PointerEvent) => {
      setNavigationPanelWidth(clampNavigationPanelWidth(startWidth + moveEvent.clientX - startX, window.innerWidth));
    };
    const finish = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      sidebarResizeCleanupRef.current = null;
      setSidebarResizing(false);
    };
    sidebarResizeCleanupRef.current = finish;
    setSidebarResizing(true);
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }, [narrow, navigationPanelWidth]);

  const resizeSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const maximum = clampNavigationPanelWidth(maximumNavigationPanelWidth, window.innerWidth);
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = navigationPanelWidth - (event.shiftKey ? 24 : 8);
    if (event.key === "ArrowRight") next = navigationPanelWidth + (event.shiftKey ? 24 : 8);
    if (event.key === "Home") next = minimumNavigationPanelWidth;
    if (event.key === "End") next = maximum;
    if (next === null) return;
    event.preventDefault();
    setNavigationPanelWidth(clampNavigationPanelWidth(next, window.innerWidth));
  }, [navigationPanelWidth]);

  const notify = useCallback((message: string, tone?: "normal" | "error") => {
    const feedback = visibleToastFeedback(message, tone);
    if (feedback === null) return;
    setToast(feedback);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const moveTaskOverride = useCallback((fromSessionId: string, toSessionId: string) => {
    if (fromSessionId === toSessionId) return;
    setPreferences((current) => {
      const source = current.taskOverrides[fromSessionId];
      if (!source) return current;
      const taskOverrides = { ...current.taskOverrides };
      const moved = { ...taskOverrides[toSessionId], ...source };
      delete taskOverrides[fromSessionId];
      delete taskOverrides[toSessionId];
      taskOverrides[toSessionId] = moved;
      return { ...current, taskOverrides };
    });
    if (isBrowserPreview) return;
    void window.tethoqDesktop.preferencesAction({ type: "move-task-override", fromSessionId, toSessionId })
      .then(setPreferences)
      .catch((error: unknown) => {
        void window.tethoqDesktop.preferencesState().then(setPreferences).catch(() => undefined);
        notify(error instanceof Error ? error.message : String(error), "error");
      });
  }, [notify]);

  const loadTimelinePage = useCallback(async (
    sessionId: string,
    cursor?: string,
    limit = HISTORY_PAGE_LIMIT,
    refresh = false,
  ) => {
    const page = await loadSessionTimelinePage(sessionId, cursor, limit, refresh);
    if (page.imageHydration) {
      const hydrationKey = `${sessionId}\u0000${cursor ?? "latest"}`;
      const hydrationGeneration = (imageHydrationGenerations.current.get(hydrationKey) ?? 0) + 1;
      imageHydrationGenerations.current.set(hydrationKey, hydrationGeneration);
      void page.imageHydration.then((hydratedItems) => {
        // Let the caller commit the immediate text/placeholder page first. The
        // later pass changes image detail only, so live transcript state wins.
        window.setTimeout(() => {
          if (imageHydrationGenerations.current.get(hydrationKey) !== hydrationGeneration) return;
          imageHydrationGenerations.current.delete(hydrationKey);
          setSnapshot((current) => {
            if (!current) return current;
            const timeline = current.timelines[sessionId];
            if (!timeline) return current;
            const hydrated = mergeTimelineImageHydration(timeline, hydratedItems);
            return hydrated === timeline
              ? current
              : { ...current, timelines: { ...current.timelines, [sessionId]: hydrated } };
          });
        }, 0);
      }).catch(() => undefined);
    }
    return page;
  }, []);

  const reconcileHiddenTimeline = useCallback(async (sessionId: string) => {
    const requestedSessionId = sessionId;
    const liveGeneration = liveTimelineGenerationBySession.current.get(requestedSessionId) ?? 0;
    const requestGeneration = (hiddenTimelineRequestGenerationBySession.current.get(requestedSessionId) ?? 0) + 1;
    hiddenTimelineRequestGenerationBySession.current.set(requestedSessionId, requestGeneration);
    const page = await loadTimelinePage(requestedSessionId, undefined, 40, true);
    const isCurrent = () => hiddenTimelineRequestIsCurrent(
      requestedSessionId,
      page.session?.id,
      liveGeneration,
      liveTimelineGenerationBySession.current.get(requestedSessionId) ?? 0,
      requestGeneration,
      hiddenTimelineRequestGenerationBySession.current.get(requestedSessionId) ?? 0,
    );
    if (!isCurrent()) return;
    const current = snapshotRef.current;
    if (!current?.sessions.some((session) => session.id === requestedSessionId)) return;
    const currentTimeline = current.timelines[requestedSessionId] ?? [];
    seedWorkingBoundary(page.session ?? current.sessions.find((session) => session.id === requestedSessionId), reconcileTimelinePage(page.items, currentTimeline));
    setSnapshot((current) => {
      if (!current || !isCurrent() || !current.sessions.some((session) => session.id === requestedSessionId)) return current;
      hiddenTimelineDirtySessionIds.current.delete(requestedSessionId);
      return {
        ...current,
        sessions: applyOpenedSessionRefresh(current.sessions, page.session),
        timelines: { ...current.timelines, [requestedSessionId]: reconcileTimelinePage(page.items, current.timelines[requestedSessionId] ?? []) },
      };
    });
    setTimelineWindows((current) => {
      if (!isCurrent()) return current;
      const existing = current[requestedSessionId];
      return { ...current, [requestedSessionId]: existing
        ? { ...existing, nextCursor: retainedHistoryCursor(existing.nextCursor, page.nextCursor) }
        : initialTimelineWindow(page.items, page.nextCursor) };
    });
  }, [loadTimelinePage, seedWorkingBoundary]);

  const openSessionDirectory = useCallback((path: string) => {
    if (isBrowserPreview) return;
    void window.tethoqDesktop.openLocalTarget({ path, handlerId: "system" }).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
  }, [notify]);

  const openLocalTarget = useCallback(async (location: LocalOpenLocation, handlerId?: LocalOpenState["defaultHandlerId"], rememberAsDefault?: boolean) => {
    if (isBrowserPreview) return;
    try {
      const result = await window.tethoqDesktop.openLocalTarget({ ...location, ...(handlerId ? { handlerId } : {}), ...(rememberAsDefault ? { rememberAsDefault: true } : {}) });
      setLocalOpenState(result.state);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [notify]);

  const initialize = useCallback(async () => {
    setLoadError(null);
    const attentionRevisionAtStart = attentionRevision.current;
    try {
      const [result, persistedPreferences] = await Promise.all([
        loadInitialSnapshot(),
        isBrowserPreview ? Promise.resolve(initialDesktopPreferences) : window.tethoqDesktop.preferencesState().catch(() => initialDesktopPreferences),
      ]);
      const tasks = result.snapshot.sessions.filter((session) => !isSideChatSession(session) && session.sessionKind !== "internal" && session.relationshipKind !== "subagent");
      const firstAttention = tasks.find((session) => session.state === "needs_approval" || session.state === "needs_input");
      const first = tasks.find((session) => session.state === "working") ?? firstAttention ?? tasks[0];
      const shellSnapshot = snapshotRef.current;
      const hasDraftPayload = (sessionId: string) => Boolean(
        composerDrafts.current[sessionId]
        || composerAttachments.current[sessionId]?.length
        || composerWorkflowAttachments.current[sessionId]?.length
        || composerAnnotations.current[sessionId]?.length
        || composerModes.current[sessionId] !== undefined
        || composerMeshTargets.current[sessionId]?.length,
      );
      const hydratedDrafts = retainedStartupDraftSessions(shellSnapshot?.sessions ?? [], result.snapshot, first, hasDraftPayload);
      const retainedIds = new Set(hydratedDrafts.map((draft) => draft.id));
      const currentSelection = selectedSessionIdRef.current;
      const selectedAfterHydration = selectedSessionAfterStartupHydration(currentSelection, hydratedDrafts, result.snapshot.sessions);
      const selectedHydratedSession = selectedAfterHydration
        ? result.snapshot.sessions.find((session) => session.id === selectedAfterHydration)
        : undefined;
      for (const session of result.snapshot.sessions) {
        const timeline = result.snapshot.timelines[session.id];
        if (timeline !== undefined) seedWorkingBoundary(session, timeline);
      }
      setPreferences(persistedPreferences);
      setSnapshot({
        ...result.snapshot,
        loading: false,
        sessions: [...hydratedDrafts, ...result.snapshot.sessions.filter((session) => !retainedIds.has(session.id))],
        timelines: resolvedStartupDraftTimelines(result.snapshot.timelines, hydratedDrafts),
      });
      setBootstrap(result.bootstrap);
      if (typeof result.bootstrap?.latestSequence === "number") {
        lastEventSequence.current = result.bootstrap.latestSequence;
        startupReplaySequence.current = result.bootstrap.latestSequence;
      }
      setRuntime({ state: "ready" });
      setSelectedSessionId(selectedAfterHydration);
      setTimelineWindows((current) => {
        if (!hydratedDrafts.length) return current;
        const next = { ...current };
        for (const draft of hydratedDrafts) next[draft.id] ??= { nextCursor: null, revealStart: 0, revealAnchorKey: null, loadingOlder: false };
        return next;
      });
      if (!retainedIds.has(progressiveStartupDraftId)) {
        delete composerDrafts.current[progressiveStartupDraftId];
        delete composerAttachments.current[progressiveStartupDraftId];
        delete composerWorkflowAttachments.current[progressiveStartupDraftId];
        delete composerAnnotations.current[progressiveStartupDraftId];
        delete composerModes.current[progressiveStartupDraftId];
        delete composerMeshTargets.current[progressiveStartupDraftId];
      }

      void result.attentionHydration?.then((attention) => {
        if (!attentionResponseIsCurrent(attentionRevisionAtStart, attentionRevision.current)) return;
        setSnapshot((current) => current ? { ...current, approvals: attention.approvals, inputRequests: attention.inputRequests } : current);
      }).catch(() => undefined);

      // The task shell now owns startup, not provider enumeration. Reconcile
      // every provider in the background; each settled first page publishes a
      // catalogue event, which the cheap sessions.list path merges into view.
      if (!isBrowserPreview) void request("sessions.bootstrap").catch(() => undefined);

      // Both catalogues are useful, but neither owns first paint. Provider
      // model probes and the selected transcript hydrate independently after
      // the task rail is already usable.
      if (!isBrowserPreview) {
        void hydrateProviderModels(result.snapshot.providers).catch(() => undefined);
      }
      if (selectedHydratedSession) {
        void loadTimelinePage(selectedHydratedSession.id).then((page) => {
          const current = snapshotRef.current;
          if (!current) return;
          const session = current.sessions.find((candidate) => candidate.id === selectedHydratedSession.id) ?? selectedHydratedSession;
          const reconciled = reconcileTimelinePage(page.items, current.timelines[selectedHydratedSession.id] ?? []);
          const openedSession = session;
          seedWorkingBoundary(openedSession, reconciled);
          const workingBoundary = workingBoundaryBySession.current.get(selectedHydratedSession.id);
          const items = sessionHoldsFollowUpQueue(openedSession, reconciled, workingBoundary)
            ? reconciled
            : settleRunningTimeline(reconciled, session.state === "failed" ? "failed" : "completed");
          setTimelineWindows((windows) => ({
            ...windows,
            [selectedHydratedSession.id]: initialTimelineWindow(items, page.nextCursor),
          }));
          setSnapshot((current) => {
            if (!current) return current;
            const latestSession = current.sessions.find((candidate) => candidate.id === selectedHydratedSession.id) ?? selectedHydratedSession;
            const latestReconciled = reconcileTimelinePage(page.items, current.timelines[selectedHydratedSession.id] ?? []);
            // A restored terminal task must not repaint old reasoning as live;
            // a genuinely active restored task keeps its running treatment.
            const latestItems = sessionHoldsFollowUpQueue(latestSession, latestReconciled, workingBoundaryBySession.current.get(selectedHydratedSession.id))
              ? latestReconciled
              : settleRunningTimeline(latestReconciled, latestSession.state === "failed" ? "failed" : "completed");
            return {
              ...current,
              sessions: applyOpenedSessionPreview(current.sessions, page.session),
              timelines: { ...current.timelines, [selectedHydratedSession.id]: latestItems },
            };
          });
        }).catch(() => undefined);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setRuntime({ state: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      // Reported on failure too: a window held back forever is worse than one showing
      // why it could not load, and the shell has no other way to learn the difference.
      if (!isBrowserPreview) window.tethoqDesktop.notifyReady();
    }
  }, [hydrateProviderModels, loadTimelinePage, seedWorkingBoundary]);

  useEffect(() => { void initialize(); }, [initialize]);

  useEffect(() => {
    if (!snapshot || snapshot.loading || sideChatsHydratedRef.current) return;
    sideChatsHydratedRef.current = true;
    void request("side_chat.list", {}).then((response) => {
      if (!Array.isArray(response.sessions)) return;
      const sessions = response.sessions;
      setSnapshot((current) => {
        if (!current) return current;
        const mapped: Session[] = sessions.flatMap((value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const raw = value as Record<string, unknown>;
          const parentSessionId = typeof raw.parentSessionId === "string" ? raw.parentSessionId : "";
          const parent = current.sessions.find((session) => session.id === parentSessionId && !isSideChatSession(session));
          if (!parent) return [];
          try { return [{ ...derivedSession(raw, parent), sessionKind: "side_chat" as const, parentSessionId }]; }
          catch { return []; }
        });
        if (!mapped.length) return current;
        const ids = new Set(mapped.map((session: Session) => session.id));
        return { ...current, sessions: [...mapped, ...current.sessions.filter((session) => !ids.has(session.id))] };
      });
    }).catch(() => undefined);
  }, [snapshot?.loading]);

  useEffect(() => {
    if (isBrowserPreview) return;
    void window.tethoqDesktop.browserState().then(setBrowser).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
    void window.tethoqDesktop.recorderState().then(setRecorder).catch(() => undefined);
    void window.tethoqDesktop.recorderAction({ type: "list" }).then((value) => { if (Array.isArray(value)) setWorkflows(value as unknown as WorkflowDescriptor[]); }).catch(() => undefined);
    void window.tethoqDesktop.preferencesState().then(setPreferences).catch(() => undefined);
    void window.tethoqDesktop.localOpenHandlers().then(setLocalOpenState).catch(() => undefined);
    const removePreferences = window.tethoqDesktop.onPreferencesState(setPreferences);
    const removeBrowser = window.tethoqDesktop.onBrowserState(setBrowser);
    const removeBrowserNotice = window.tethoqDesktop.onBrowserNotice((notice) => {
      if (notice.action === "focus-address") {
        setBrowserAddressFocusToken((current) => current + 1);
        return;
      }
      notify(notice.message, notice.tone === "error" ? "error" : undefined);
    });
    const removeRecorder = window.tethoqDesktop.onRecorderState((state) => { setRecorder(state); if (state.phase === "staged") setSaveWorkflowOpen(true); });
    const removeRecorderEvent = window.tethoqDesktop.onRecorderEvent((event) => {
      if (event.type === "progress") {
        setRecorder((current) => ({ ...current, phase: "recording", active: event.recording }));
      } else if (event.type === "state") {
        setRecorder(event.state);
      } else if (event.type === "panic-stop") {
        notify("Recording stopped with Ctrl Shift F12");
      } else if (event.type === "warning") {
        notify(event.message, "error");
      }
    });
    return () => { removeBrowser(); removeBrowserNotice(); removeRecorder(); removeRecorderEvent(); removePreferences(); };
  }, [notify]);

  useEffect(() => {
    if (isBrowserPreview || snapshot?.loading) return;
    void window.tethoqDesktop.browserAction({ type: "set-visible", visible: view === "browser", ...(selectedSessionId ? { sessionId: selectedSessionId } : {}) }).then(setBrowser).catch(() => undefined);
  }, [selectedSessionId, snapshot?.loading, view]);

  const openTimelineLink = useCallback(async (url: string) => {
    try {
      setView("browser");
      let next = await window.tethoqDesktop.browserAction({ type: "set-visible", visible: true, ...(selectedSessionId ? { sessionId: selectedSessionId } : {}) });
      const active = next.tabs.find((tab) => tab.id === next.activeTabId);
      next = active
        ? await window.tethoqDesktop.browserAction({ type: "navigate", tabId: active.id, input: url })
        : await window.tethoqDesktop.browserAction({ type: "create-tab", input: url, activate: true });
      setBrowser(next);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [notify, selectedSessionId]);

  const refreshAll = useCallback(async (showToast = true) => {
    if (refreshInFlight.current) {
      // Provider/session events that arrive during a catalogue refresh are new
      // information, not duplicate work. Coalesce them into one follow-up pass
      // so a newly created task cannot disappear until some unrelated refresh.
      refreshQueued.current = true;
      return;
    }
    refreshInFlight.current = true;
    const sessionRevisionsAtStart = new Map(liveSessionRevisionBySession.current);
    const attentionRevisionAtStart = attentionRevision.current;
    try {
      const [sessions, providers, attention] = await Promise.all([
        refreshSessions(),
        refreshProviders(),
        refreshAttention(),
      ]);
      const visibleProviders = providers.filter((provider) => !revokedConnectorIdsRef.current.has(provider.id));
      const selected = selectedSessionIdRef.current;
      const selectedIsScheduled = selected !== null
        && snapshotRef.current?.sessions.some((session) => session.id === selected && session.schedule !== undefined) === true;
      const incrementallyObserved = selected && !selectedIsScheduled
        ? await watchSession(selected).catch(() => false)
        : false;
      // Catalogue refreshes do not own transcript recovery. Incremental
      // providers already append live bytes; only a non-incremental provider
      // needs a quiet selected-page refresh here.
      const timelinePageGeneration = selected
        ? liveTimelineGenerationBySession.current.get(selected) ?? 0
        : null;
      const timelinePage = selected && !selectedIsScheduled && !incrementallyObserved
        && quietCatchUpDue(selectedLastDelta(selected), Date.now(), 3_000)
        ? await loadTimelinePage(selected).catch(() => null)
        : null;
      const quiet = (sessionId: string): boolean => quietCatchUpDue(selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, sessionId, lastLiveDeltaAt.current), Date.now(), 2_000);
      const changedSinceRefresh = (sessionId: string): boolean =>
        (liveSessionRevisionBySession.current.get(sessionId) ?? 0) !== (sessionRevisionsAtStart.get(sessionId) ?? 0);
      if (selected && timelinePage
        && (liveTimelineGenerationBySession.current.get(selected) ?? 0) === timelinePageGeneration) {
        const observed = snapshotRef.current;
        const reconciled = reconcileTimelinePage(timelinePage.items, observed?.timelines[selected] ?? []);
        seedWorkingBoundary(observed?.sessions.find((session) => session.id === selected) ?? timelinePage.session, reconciled);
      }
      setSnapshot((current) => {
        if (!current) return current;
        const visibleSessions = withoutRetiredScheduledSessions(sessions, retiredScheduledSessionIdsRef.current);
        const refreshedIds = new Set(visibleSessions.map((session) => session.id));
        // Refresh responses deliberately omit derived sessions (side chats and
        // delegated children), so keep locally tracked ones. Dropping an open
        // child here empties its workspace the moment any refresh lands.
        const incomingProviders = new Set(visibleSessions.map((session) => session.providerId));
        const localOnly = current.sessions.filter((session) => (session.draft || isSideChatSession(session) || session.parentSessionId !== undefined || !incomingProviders.has(session.providerId) || changedSinceRefresh(session.id)) && !refreshedIds.has(session.id));
        return {
          ...current,
          sessions: applyOpenedSessionPreview([...localOnly, ...mergeRefreshedSessions(current.sessions, visibleSessions, quiet, changedSinceRefresh)], timelinePage?.session),
          providers: visibleProviders,
          approvals: attentionResponseIsCurrent(attentionRevisionAtStart, attentionRevision.current) ? attention.approvals : current.approvals,
          inputRequests: attentionResponseIsCurrent(attentionRevisionAtStart, attentionRevision.current) ? attention.inputRequests : current.inputRequests,
          timelines: selected && timelinePage
            && (liveTimelineGenerationBySession.current.get(selected) ?? 0) === timelinePageGeneration
            ? { ...current.timelines, [selected]: reconcileTimelinePage(timelinePage.items, current.timelines[selected] ?? []) }
            : current.timelines,
        };
      });
      await hydrateProviderModels(visibleProviders);
      if (selected && timelinePage) {
        setTimelineWindows((current) => {
          if ((liveTimelineGenerationBySession.current.get(selected) ?? 0) !== timelinePageGeneration) return current;
          const existing = current[selected];
          if (existing) {
            // A background catalogue/attention refresh may update the newest
            // page cursor, but it does not own how much history the reader has
            // revealed. Resetting revealStart here briefly removed almost the
            // entire transcript and made the scrollbar thumb fill its track.
            return existing.nextCursor === timelinePage.nextCursor
              ? current
              : { ...current, [selected]: { ...existing, nextCursor: retainedHistoryCursor(existing.nextCursor, timelinePage.nextCursor) } };
          }
          return { ...current, [selected]: initialTimelineWindow(timelinePage.items, timelinePage.nextCursor) };
        });
      }
      if (showToast) notify("Coding tools are up to date");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      refreshInFlight.current = false;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        void refreshAll(false);
      }
    }
  }, [hydrateProviderModels, loadTimelinePage, notify, seedWorkingBoundary]);

  const refreshSelectedView = useCallback(async (sessionId: string, force = false) => {
    if (selectedViewRefreshInFlight.current.has(sessionId)) {
      if (force) selectedViewForcedRefreshQueued.current.add(sessionId);
      return;
    }
    selectedViewRefreshInFlight.current.add(sessionId);
    try {
      let forceNext = force;
      while (true) {
        selectedViewForcedRefreshQueued.current.delete(sessionId);
        const forcedPass = forceNext;
        const incrementallyObserved = await watchSession(sessionId).catch(() => false);
        const current = snapshotRef.current;
        const currentSession = current?.sessions.find((candidate) => candidate.id === sessionId);
        const terminalRepair = currentSession !== undefined
          && terminalSessionNeedsCanonicalHistory(
            currentSession,
            current?.timelines[sessionId] ?? [],
            workingBoundaryBySession.current.get(sessionId),
          );
        // Normal history reconciliation waits until streaming is quiet. A
        // terminal state is different: the final reply may have been persisted
        // just after the state flag, so read it immediately. An incremental
        // watcher already consumes only new provider bytes while work is live;
        // forcing complete history through that same sub-second loop defeats
        // the watcher and can repeatedly parse a very large transcript.
        // A watcher says only that new bytes can be observed; it does not prove
        // that the final answer has reached the visible transcript. Completion
        // without a final/error therefore keeps forcing canonical reconciliation.
        const needsCanonicalHistory = forcedPass || !incrementallyObserved || terminalRepair;
        if (needsCanonicalHistory && (forcedPass || quietCatchUpDue(selectedLastDelta(sessionId), Date.now(), 2_000))) {
          const generation = liveTimelineGenerationBySession.current.get(sessionId) ?? 0;
          // One incremental generation gets at most one canonical repair. If a
          // final lands after that read, its provider event advances the
          // generation and permits exactly one more repair; an unchanged idle
          // task cannot reread complete history forever on the calm timer.
          const generationBounded = incrementallyObserved && !terminalRepair;
          if (generationBounded && canonicalHistoryGenerationBySession.current.get(sessionId) === generation) break;
          if (generationBounded) canonicalHistoryGenerationBySession.current.set(sessionId, generation);
          let page: Awaited<ReturnType<typeof loadSessionTimelinePage>>;
          try {
            page = await loadTimelinePage(sessionId, undefined, 40, true);
          } catch (error) {
            if (generationBounded && canonicalHistoryGenerationBySession.current.get(sessionId) === generation) {
              canonicalHistoryGenerationBySession.current.delete(sessionId);
            }
            if (forcedPass) {
              setSnapshot((current) => {
                if (!current) return current;
                const existing = current.timelines[sessionId];
                if (!existing) return current;
                const settled = settleTimelineImagePlaceholders(existing);
                return settled === existing
                  ? current
                  : { ...current, timelines: { ...current.timelines, [sessionId]: settled } };
              });
            }
            throw error;
          }
          if ((liveTimelineGenerationBySession.current.get(sessionId) ?? 0) === generation) {
            const observed = snapshotRef.current;
            const observedTimeline = reconcileTimelinePage(page.items, observed?.timelines[sessionId] ?? []);
            seedWorkingBoundary(page.session ?? observed?.sessions.find((session) => session.id === sessionId), observedTimeline);
          }
          // Reading a task is not activity. Bumping updatedAt here re-sorted the
          // recent-activity list under the pointer, so opening a chat threw it to
          // the top of the task list.
          setSnapshot((current) => {
            if (!current) return current;
            const existing = current.timelines[sessionId] ?? [];
            if ((liveTimelineGenerationBySession.current.get(sessionId) ?? 0) !== generation) {
              // A later live delta owns the transcript, but it must not strand
              // the attachment card. Adopt image detail only; deferred bytes
              // use the same semantic join when their canonical row id differs.
              if (!forcedPass) return current;
              const hydrated = mergeTimelineImageHydration(existing, page.items);
              return hydrated === existing
                ? current
                : { ...current, timelines: { ...current.timelines, [sessionId]: hydrated } };
            }
            if (!forcedPass && !quietCatchUpDue(selectedLastDelta(sessionId), Date.now(), 2_000)) return current;
            const merged = reconcileTimelinePage(page.items, existing);
            const nextSessions = applyOpenedSessionRefresh(current.sessions, page.session);
            const visibleSession = nextSessions.find((session) => session.id === sessionId);
            const reconciled = latestTurnHasCompletedFinal(merged)
              && (!visibleSession || !sessionPresentsLiveTurn(visibleSession, merged, workingBoundaryBySession.current.get(sessionId)))
              ? settleRunningTimeline(merged)
              : merged;
            return reconciled === existing && nextSessions === current.sessions ? current : { ...current, sessions: nextSessions, timelines: { ...current.timelines, [sessionId]: reconciled } };
          });
          setTimelineWindows((current) => {
            if ((liveTimelineGenerationBySession.current.get(sessionId) ?? 0) !== generation
              || (!forcedPass && !quietCatchUpDue(selectedLastDelta(sessionId), Date.now(), 2_000))) return current;
            const existing = current[sessionId];
            if (existing?.nextCursor === page.nextCursor) return current;
            return { ...current, [sessionId]: existing
              ? { ...existing, nextCursor: retainedHistoryCursor(existing.nextCursor, page.nextCursor) }
              : initialTimelineWindow(page.items, page.nextCursor) };
          });
        }
        forceNext = selectedViewForcedRefreshQueued.current.delete(sessionId);
        if (!forceNext) break;
      }
    } finally {
      selectedViewRefreshInFlight.current.delete(sessionId);
    }
  }, [loadTimelinePage, seedWorkingBoundary, selectedLastDelta]);

  const catchUpTranscript = useCallback((sessionId: string, force = false) => {
    const current = snapshotRef.current;
    const session = current?.sessions.find((candidate) => candidate.id === sessionId);
    const timeline = current?.timelines[sessionId] ?? [];
    if (!session || !sessionNeedsTranscriptCatchUp(session, timeline, workingBoundaryBySession.current.get(sessionId))) return;
    if (selectedViewRefreshInFlight.current.has(sessionId)) {
      if (force) void refreshSelectedView(sessionId, true).catch(() => undefined);
      return;
    }
    void refreshSelectedView(sessionId, force).catch(() => undefined);
  }, [refreshSelectedView]);

  const refreshVisibleState = useCallback(async (includeSelectedTimeline = true) => {
    if (visibleRefreshInFlight.current) {
      visibleRefreshQueued.current = true;
      visibleRefreshQueuedTimeline.current ||= includeSelectedTimeline;
      return;
    }
    visibleRefreshInFlight.current = true;
    const sessionRevisionsAtStart = new Map(liveSessionRevisionBySession.current);
    try {
      const selected = selectedSessionIdRef.current;
      const [sessions] = await Promise.all([
        listSessions(),
        includeSelectedTimeline && selected && quietCatchUpDue(selectedLastDelta(selected), Date.now(), 2_000)
          ? refreshSelectedView(selected).catch(() => undefined)
          : selected ? watchSession(selected).catch(() => undefined) : Promise.resolve(),
      ]);
      const quiet = (sessionId: string): boolean => quietCatchUpDue(selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, sessionId, lastLiveDeltaAt.current), Date.now(), 2_000);
      const changedSinceRefresh = (sessionId: string): boolean =>
        (liveSessionRevisionBySession.current.get(sessionId) ?? 0) !== (sessionRevisionsAtStart.get(sessionId) ?? 0);
      setSnapshot((current) => {
        if (!current) return current;
        const visibleSessions = withoutRetiredScheduledSessions(sessions, retiredScheduledSessionIdsRef.current);
        const refreshedIds = new Set(visibleSessions.map((session) => session.id));
        // Derived sessions (side chats and delegated children) are absent from
        // the bridge's top-level listings, so keep locally tracked ones instead
        // of letting an open delegated child vanish from its own workspace.
        const incomingProviders = new Set(visibleSessions.map((session) => session.providerId));
        const localOnly = current.sessions.filter((session) => (session.draft || isSideChatSession(session) || session.parentSessionId !== undefined || !incomingProviders.has(session.providerId) || changedSinceRefresh(session.id)) && !refreshedIds.has(session.id));
        const nextSessions = [...localOnly, ...mergeRefreshedSessions(current.sessions, visibleSessions, quiet, changedSinceRefresh)];
        return nextSessions.length === current.sessions.length && nextSessions.every((session, index) => session === current.sessions[index])
          ? current
          : { ...current, sessions: nextSessions };
      });
    } finally {
      visibleRefreshInFlight.current = false;
      if (visibleRefreshQueued.current) {
        const includeQueuedTimeline = visibleRefreshQueuedTimeline.current;
        visibleRefreshQueued.current = false;
        visibleRefreshQueuedTimeline.current = false;
        void refreshVisibleState(includeQueuedTimeline).catch(() => undefined);
      }
    }
  }, [refreshSelectedView]);

  useEffect(() => {
    if (!snapshot || snapshot.loading || !catalogueRefreshPending.current) return;
    catalogueRefreshPending.current = false;
    void refreshVisibleState(false).catch(() => {
      catalogueRefreshPending.current = true;
    });
  }, [refreshVisibleState, snapshot?.loading]);

  useEffect(() => {
    if (!snapshot || snapshot.loading || isBrowserPreview) return;
    const catchUpIfQuiet = () => {
      const selected = selectedSessionIdRef.current;
      if (!selected || !quietCatchUpDue(selectedLastDelta(selected), Date.now(), 2_000)) return;
      void refreshSelectedView(selected).catch(() => undefined);
    };
    const onFocus = () => catchUpIfQuiet();
    const onVisibility = () => {
      const hidden = document.hidden;
      const becameVisible = wasDocumentHidden.current && !hidden;
      wasDocumentHidden.current = hidden;
      if (hidden) return;
      const selected = selectedSessionIdRef.current;
      if (selected) void watchSession(selected).catch(() => undefined);
      if (!becameVisible) return;
      catchUpIfQuiet();
      void (async () => {
        await refreshVisibleState().catch(() => undefined);
        const replay = await request("sync.since", { sequence: lastEventSequence.current }).catch(() => null);
        if (!replay) return;
        const events = Array.isArray(replay.events) ? replay.events : [];
        const through = typeof replay.throughSequence === "number" ? replay.throughSequence : lastEventSequence.current;
        if (replay.replayGap === true && selected) {
          const generation = liveTimelineGenerationBySession.current.get(selected) ?? 0;
          const page = await loadTimelinePage(selected).catch(() => null);
          if (page && (liveTimelineGenerationBySession.current.get(selected) ?? 0) === generation) {
            const observed = snapshotRef.current;
            const reconciled = reconcileTimelinePage(page.items, observed?.timelines[selected] ?? []);
            seedWorkingBoundary(observed?.sessions.find((session) => session.id === selected) ?? page.session, reconciled);
            setSnapshot((current) => current && (liveTimelineGenerationBySession.current.get(selected) ?? 0) === generation ? {
              ...current,
              sessions: applyOpenedSessionPreview(current.sessions, page.session),
              timelines: { ...current.timelines, [selected]: reconcileTimelinePage(page.items, current.timelines[selected] ?? []) },
            } : current);
          }
          if (typeof replay.latestSequence === "number") lastEventSequence.current = replay.latestSequence;
          return;
        }
        if (events.length) ingestEventBatch.current({
          events: events as DesktopEventBatch["events"],
          latestSequence: through,
          replayGap: false,
        });
      })();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadTimelinePage, refreshSelectedView, refreshVisibleState, seedWorkingBoundary, snapshot?.loading]);

  useEffect(() => {
    if (!snapshot || snapshot.loading || isBrowserPreview) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      const selected = selectedSessionIdRef.current;
      if (!selected) return;
      if (!quietCatchUpDue(selectedLastDelta(selected), Date.now())) return;
      const current = snapshotRef.current;
      const session = current?.sessions.find((candidate) => candidate.id === selected);
      if (session && sessionNeedsTranscriptCatchUp(session, current?.timelines[selected] ?? [], workingBoundaryBySession.current.get(selected))) {
        catchUpTranscript(selected);
      }
      // Listing detects a turn started in another client. Settled history stays
      // untouched until that listing reports live work, so a quiet completed task
      // cannot flash every fifteen seconds merely because the heal timer fired.
      void refreshVisibleState(false).catch(() => undefined);
      healMissingModels();
    }, quietCatchUpIntervalMs);
    return () => window.clearInterval(interval);
  }, [catchUpTranscript, healMissingModels, refreshVisibleState, snapshot?.loading]);

  // Following a turn this app is not driving.
  //
  // A task started in another OpenCode window runs on that window's own server,
  // which never sends us its live chunks, so the open task sits there working with
  // nothing arriving. The shared store is the only thing both apps can read, and it
  // records a thought when the thought ends. The calm fifteen-second poll above
  // therefore showed the whole turn's thinking in one lump once it was over. Here
  // the open task is followed closely enough that each thought lands as it exists,
  // and only while it is working and its own stream is silent, so a task we are
  // streaming normally never takes this path.
  useEffect(() => {
    if (!snapshot || snapshot.loading || isBrowserPreview) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      const selected = selectedSessionIdRef.current;
      if (!selected) return;
      const current = snapshotRef.current;
      const session = current?.sessions.find((candidate) => candidate.id === selected);
      if (!session || !sessionNeedsTranscriptCatchUp(session, current?.timelines[selected] ?? [], workingBoundaryBySession.current.get(selected))) return;
      if (session.state !== "working" && session.state !== "needs_approval" && session.state !== "needs_input") return;
      if (!quietCatchUpDue(selectedLastDelta(selected), Date.now(), unownedTurnSilenceMs)) return;
      catchUpTranscript(selected);
    }, unownedTurnFollowMs);
    return () => window.clearInterval(interval);
  }, [catchUpTranscript, selectedLastDelta, snapshot?.loading]);

  useEffect(() => {
    // The bootstrap snapshot carries an event sequence. Subscribe only after
    // that snapshot is painted, then replay from the sequence below; this
    // removes the old window where live events arrived while snapshot was null
    // and were silently discarded.
    if (!snapshot) return;
    return subscribeToDesktop(
      (incoming) => {
        ingestEventBatch.current(incoming);
      },
      setRuntime,
    );
  }, [snapshot !== null]);

  useEffect(() => {
    if (!snapshot || snapshot.loading || isBrowserPreview || startupReplayStarted.current) return;
    const startingSequence = startupReplaySequence.current;
    if (startingSequence === null) return;
    startupReplayStarted.current = true;
    void (async () => {
      let cursor = startingSequence;
      for (let page = 0; page < 64; page += 1) {
        const replay = await request("sync.since", { sequence: cursor });
        const events = Array.isArray(replay.events) ? replay.events as DesktopEventBatch["events"] : [];
        const through = typeof replay.throughSequence === "number" ? replay.throughSequence : cursor;
        const latest = typeof replay.latestSequence === "number" ? replay.latestSequence : through;
        ingestEventBatch.current({ events, latestSequence: through, replayGap: replay.replayGap === true });
        if (replay.replayGap === true || through >= latest) return;
        if (through <= cursor) throw new Error("Startup event replay did not advance");
        cursor = through;
      }
      throw new Error("Startup event replay exceeded its page bound");
    })().catch(() => {
      // A bounded replay failure falls back to the cheap live cache read. It
      // must never blank the task shell or trigger a full provider catalogue.
      void refreshVisibleState(false).catch(() => undefined);
    });
  }, [refreshVisibleState, snapshot?.loading]);

  ingestEventBatch.current = (batch) => {
      const unseenEvents = batch.events.filter((event) => {
        if (seenEventSequences.current.has(event.sequence)) return false;
        seenEventSequences.current.add(event.sequence);
        return true;
      });
      lastEventSequence.current = Math.max(lastEventSequence.current, batch.latestSequence);
      if (seenEventSequences.current.size > 8_192) {
        const floor = lastEventSequence.current - 4_096;
        for (const sequence of seenEventSequences.current) if (sequence <= floor) seenEventSequences.current.delete(sequence);
      }
      if (unseenEvents.length !== batch.events.length) batch = { ...batch, events: unseenEvents };
      if (batch.events.length === 0 && !batch.replayGap) return;
      // Advance this synchronously, before React applies the rows, so a history
      // promise resolving in the same turn can already see that its page is stale.
      const visibleTimelineSessionIds = visibleTimelineSessionIdsRef.current;
      const invalidatedHiddenTimelineSessionIds = new Set<string>();
      for (const event of batch.events) {
        if (event.sessionId && !visibleTimelineSessionIds.has(event.sessionId) && eventInvalidatesHiddenTimeline(event)) {
          hiddenTimelineDirtySessionIds.current.add(event.sessionId);
          invalidatedHiddenTimelineSessionIds.add(event.sessionId);
        }
      }
      const timelineItems = batch.events.map((event) => event.sessionId && visibleTimelineSessionIds.has(event.sessionId)
        ? eventToTimelineItems(event)
        : []);
      // Provider state can get ahead of provider history. Capture the visible
      // ending at each real working transition, in batch order, so a previous
      // final answer cannot hide the next turn while its first row is in flight.
      const boundaryTimelines = new Map<string, TimelineItem[]>();
      for (const [eventIndex, event] of batch.events.entries()) {
        if (!event.sessionId) continue;
        const timeline = boundaryTimelines.get(event.sessionId)
          ?? snapshotRef.current?.timelines[event.sessionId]
          ?? [];
        if (isLiveTurnEvent(event)) {
          const currentBoundary = workingBoundaryBySession.current.get(event.sessionId);
          if (!sessionBoundaryNeedsVisibleEnding(timeline, currentBoundary)) {
            workingBoundaryBySession.current.set(event.sessionId, captureSessionWorkingBoundary(timeline));
          }
        }
        const items = timelineItems[eventIndex] ?? [];
        const advancedTimeline = items.reduce((current, item) => mergeTimeline(current, item), timeline);
        boundaryTimelines.set(event.sessionId, advancedTimeline);
        const workingBoundary = workingBoundaryBySession.current.get(event.sessionId);
        if (workingBoundary && !sessionBoundaryNeedsVisibleEnding(advancedTimeline, workingBoundary)) {
          workingBoundaryBySession.current.delete(event.sessionId);
        }
      }
      const changedSessionIds = new Set(batch.events.flatMap((event) => event.sessionId ? [event.sessionId] : []));
      for (const sessionId of changedSessionIds) {
        liveSessionRevisionBySession.current.set(sessionId, (liveSessionRevisionBySession.current.get(sessionId) ?? 0) + 1);
      }
      const changedTimelines = new Set(batch.events.flatMap((event, index) => event.sessionId && timelineItems[index]?.length ? [event.sessionId] : []));
      const liveTurnSessions = new Set(batch.events.flatMap((event) => event.sessionId && isLiveTurnEvent(event) ? [event.sessionId] : []));
      const advancedLiveSessions = new Set([...changedTimelines, ...liveTurnSessions, ...invalidatedHiddenTimelineSessionIds]);
      for (const sessionId of advancedLiveSessions) {
        liveTimelineGenerationBySession.current.set(sessionId, (liveTimelineGenerationBySession.current.get(sessionId) ?? 0) + 1);
      }
      if (liveTurnSessions.size) {
        const now = Date.now();
        lastLiveDeltaAt.current = now;
        for (const sessionId of liveTurnSessions) lastLiveDeltaBySession.current.set(sessionId, now);
      }
      const agentCompletionActions = new Map<number, TerminalStateEventAction>();
      for (const [eventIndex, event] of batch.events.entries()) {
        if (event.type !== "agent.completed" || !event.sessionId) continue;
        const hasLaterLiveEvent = batch.events.slice(eventIndex + 1).some((candidate) => candidate.sessionId === event.sessionId && isLiveTurnEvent(candidate));
        const authoritative = isAuthoritativeOpenCodeGuardCompletion(event);
        const action = terminalStateEventAction("completed", false, hasLaterLiveEvent, authoritative);
        agentCompletionActions.set(eventIndex, action);
      }
      const terminalSessionStateActions = new Map<number, TerminalStateEventAction>();
      for (const [eventIndex, event] of batch.events.entries()) {
        if ((event.type !== "session.updated" && event.type !== "session.status_changed") || !event.sessionId) continue;
        const state = event.payload.state;
        if (state !== "idle" && state !== "completed") continue;
        const hasLaterLiveEvent = batch.events.slice(eventIndex + 1).some((candidate) => candidate.sessionId === event.sessionId && isLiveTurnEvent(candidate));
        const action = terminalStateEventAction(state, false, hasLaterLiveEvent);
        terminalSessionStateActions.set(eventIndex, action);
      }
      // A provider can emit one last live chunk after Stop was clicked. Retain
      // the visual boundary until accepted terminal evidence arrives; then
      // retire it in the same event turn that settles canonical presentation.
      const stoppedPresentationsToSettle = new Set<string>();
      for (const [eventIndex, event] of batch.events.entries()) {
        if (!event.sessionId || !stopPresentationSessionIdsRef.current.has(event.sessionId)) continue;
        if (event.type === "agent.interrupted" || event.type === "agent.error" || isPersistedCodexFinalAnswer(event)) {
          stoppedPresentationsToSettle.add(event.sessionId);
          continue;
        }
        if (event.type === "agent.completed" && agentCompletionActions.get(eventIndex) === "apply") {
          stoppedPresentationsToSettle.add(event.sessionId);
          continue;
        }
        if (event.type !== "session.updated" && event.type !== "session.status_changed") continue;
        const state = event.payload.state;
        if ((state === "idle" || state === "completed") && terminalSessionStateActions.get(eventIndex) === "apply") {
          stoppedPresentationsToSettle.add(event.sessionId);
          continue;
        }
        if (state === "failed") {
          const hasLaterLiveEvent = batch.events.slice(eventIndex + 1).some((candidate) => candidate.sessionId === event.sessionId && isLiveTurnEvent(candidate));
          if (!hasLaterLiveEvent) stoppedPresentationsToSettle.add(event.sessionId);
        }
      }
      for (const sessionId of stoppedPresentationsToSettle) setStopPresentation(sessionId, false);
      const compactionEvents = batch.events.filter((event) => event.sessionId && (event.type === "context.compaction_started" || event.type === "context.compaction_completed" || event.type === "context.compaction_failed"));
      if (compactionEvents.length) {
        setCompactionsBySession((current) => {
          const next = { ...current };
          for (const event of compactionEvents) {
            const sessionId = event.sessionId!;
            const kind = event.payload.kind === "automatic" || event.payload.kind === "manual" ? event.payload.kind : null;
            next[sessionId] = { isCompacting: event.type === "context.compaction_started", kind };
          }
          return next;
        });
      }
      const visionEvents = batch.events.filter((event) => event.sessionId && event.type === "session.vision_updated");
      if (visionEvents.length) {
        // Update the ref before React renders. Open EYES controls use this
        // synchronous source to reject a status request that started before a
        // newer provider event, rather than flashing the older response first.
        visionBySessionRef.current = reconcileVisionStatusEvents(visionBySessionRef.current, visionEvents);
        setVisionBySession(visionBySessionRef.current);
      }
      const remotelyUpdatedSessionIds = [...new Set(batch.events.flatMap((event) => event.type === "message.remote_received" && event.sessionId ? [event.sessionId] : []))];
      const scheduledSessionRemaps = batch.events.flatMap((event) => {
        if ((event.type !== "scheduled_task.created" && event.type !== "scheduled_task.updated") || !event.sessionId) return [];
        const previous = event.payload.previousTargetSessionId;
        return typeof previous === "string" && previous !== event.sessionId
          ? [{ previous, current: event.sessionId }]
          : [];
      });
      const cancelledScheduledPlaceholders = batch.events.flatMap((event) =>
        (event.type === "scheduled_task.created" || event.type === "scheduled_task.updated")
          && event.payload.change === "cancelled"
          && typeof event.sessionId === "string"
          && isScheduledTaskPlaceholderId(event.sessionId)
          ? [event.sessionId]
          : []);
      for (const remap of scheduledSessionRemaps) {
        retiredScheduledSessionIdsRef.current.add(remap.previous);
        if (selectedSessionIdRef.current === remap.previous) {
          selectedSessionIdRef.current = remap.current;
          setSelectedSessionId(remap.current);
        }
        if (visibleTimelineSessionIdsRef.current.has(remap.previous)) {
          visibleTimelineSessionIdsRef.current = new Set([
            ...[...visibleTimelineSessionIdsRef.current].filter((sessionId) => sessionId !== remap.previous),
            remap.current,
          ]);
        }
      }
      for (const sessionId of cancelledScheduledPlaceholders) {
        retiredScheduledSessionIdsRef.current.add(sessionId);
        if (selectedSessionIdRef.current === sessionId) {
          selectedSessionIdRef.current = null;
          setSelectedSessionId(null);
        }
        if (visibleTimelineSessionIdsRef.current.has(sessionId)) {
          visibleTimelineSessionIdsRef.current = new Set(
            [...visibleTimelineSessionIdsRef.current].filter((candidate) => candidate !== sessionId),
          );
        }
      }
      if (scheduledSessionRemaps.length > 0 || cancelledScheduledPlaceholders.length > 0) {
        setTimelineWindows((current) => {
          const next = { ...current };
          for (const remap of scheduledSessionRemaps) {
            const previous = next[remap.previous];
            if (previous !== undefined && next[remap.current] === undefined) next[remap.current] = previous;
            delete next[remap.previous];
          }
          for (const sessionId of cancelledScheduledPlaceholders) delete next[sessionId];
          return next;
        });
      }
      // Decide follow-up work before scheduling the React state updater. React
      // may run that updater later, so mutating these flags from inside it can
      // silently lose a session-created event under normal concurrent renders.
      const attentionChanged = batch.events.some((event) => event.type === "approval.requested" || event.type === "approval.resolved" || event.type === "user_input.requested" || event.type === "user_input.resolved");
      const catalogueChanged = batch.events.some((event) => event.type === "session.catalog_changed");
      const scheduleChanged = batch.events.some((event) => event.type === "scheduled_task.created" || event.type === "scheduled_task.updated");
      const selectedScheduleStarted = batch.events.some((event) => {
        if (event.type !== "scheduled_task.created" && event.type !== "scheduled_task.updated") return false;
        const presentation = mapScheduledTaskPresentation(event.payload.task);
        return presentation?.status === "started" && presentation.sessionId === selectedSessionIdRef.current;
      });
      const terminalChanged = batch.events.some((event) => event.type === "agent.completed" || event.type === "agent.interrupted" || event.type === "agent.error" || isPersistedCodexFinalAnswer(event));
      if (batch.replayGap || attentionChanged || terminalChanged) attentionRevision.current += 1;
      const selectedTerminalCompletion = batch.events.some((event, eventIndex) => {
        if (!event.sessionId || event.sessionId !== selectedSessionIdRef.current) return false;
        if (event.type === "agent.completed") return agentCompletionActions.get(eventIndex) !== "ignore";
        if (event.type !== "session.updated" && event.type !== "session.status_changed") return false;
        const action = terminalSessionStateActions.get(eventIndex);
        return action !== undefined && action !== "ignore";
      });
      const canonicalTranscriptRefreshSessionIds = new Set(batch.events.flatMap((event) =>
        event.sessionId && visibleTimelineSessionIds.has(event.sessionId) && eventRequiresCanonicalTranscriptRefresh(event)
          ? [event.sessionId]
          : []));
      let refreshSessionsNeeded = batch.replayGap || remotelyUpdatedSessionIds.length > 0
        || attentionChanged || scheduleChanged || batch.events.some((event) => event.type === "session.created");
      let refreshProvidersNeeded = batch.replayGap || batch.events.some((event) => event.type === "provider.connected" || event.type === "provider.disconnected");
      let refreshAttentionNeeded = batch.replayGap || attentionChanged || terminalChanged;
      let refreshSelectedTimeline = batch.replayGap || selectedScheduleStarted;
      if (batch.replayGap || batch.events.some((event) => event.sessionId === selectedSessionIdRef.current && (event.type === "message.queued" || event.type === "message.queue_updated" || event.type === "message.queue_removed"))) {
        setQueueRevision((current) => current + 1);
      }
      setSnapshot((current) => {
        if (!current) return current;
        const next = cloneSnapshot(current);
        for (const [eventIndex, event] of batch.events.entries()) {
          if (event.type === "host.connected" || event.type === "host.disconnected") {
            next.connected = event.type === "host.connected";
          }
          if (event.type === "session.updated") {
            const effort = typeof event.payload.reasoningEffort === "string"
              ? event.payload.reasoningEffort
              : typeof event.payload.variantId === "string" ? event.payload.variantId : undefined;
            const model = typeof event.payload.modelId === "string" ? event.payload.modelId : undefined;
            const state = typeof event.payload.state === "string" ? event.payload.state : undefined;
            const known = state === "working" || state === "needs_approval" || state === "needs_input" || state === "idle" || state === "completed" || state === "failed" || state === "offline" || state === "disconnected" || state === "unknown";
            if (event.sessionId && (effort || model || known)) {
              // An idle report that races the stream must not settle running rows
              // (their next delta would then replace instead of extend the body);
              // a quiet stream that finally reports idle must settle the shimmer.
              const quiet = known ? quietCatchUpDue(selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, event.sessionId, lastLiveDeltaAt.current), Date.now(), 2_000) : true;
              const currentSession = next.sessions.find((session) => session.id === event.sessionId);
              const terminalTurnEvidence = !hiddenTimelineDirtySessionIds.current.has(event.sessionId)
                && currentSession !== undefined
                && !sessionHoldsFollowUpQueue(currentSession, next.timelines[event.sessionId] ?? [], workingBoundaryBySession.current.get(event.sessionId));
              const terminalAction = terminalSessionStateActions.get(eventIndex);
              const applyState = known && (terminalAction === "ignore"
                ? false
                : terminalAction === "apply" || shouldApplySessionState(state!, quiet || terminalTurnEvidence));
              const normalizedState = state === "disconnected" ? "offline" : state === "unknown" ? "idle" : state as SessionState;
              next.sessions = replaceSession(next.sessions, event.sessionId, {
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
                ...(applyState ? { state: normalizedState } : {}),
                ...(applyState && (normalizedState === "idle" || normalizedState === "completed" || normalizedState === "failed" || normalizedState === "offline") ? { providerStatus: null } : {}),
                updatedAt: event.occurredAt,
              });
              if (applyState && (normalizedState === "idle" || normalizedState === "completed" || normalizedState === "failed")) {
                const timeline = next.timelines[event.sessionId] ?? [];
                if (!sessionNeedsTranscriptCatchUp({ state: normalizedState }, timeline, workingBoundaryBySession.current.get(event.sessionId))) {
                  next.timelines[event.sessionId] = settleRunningTimeline(timeline, normalizedState === "failed" ? "failed" : "completed");
                }
              }
            }
          }
          if (event.type === "side_chat.created" || event.type === "side_chat.updated" || event.type === "side_chat.promoted") {
            const session = sideChatEventSession(event.payload.session, next.sessions, event.occurredAt);
            if (session) next.sessions = [session, ...next.sessions.filter((candidate) => candidate.id !== session.id)];
          }
          if (!event.sessionId) continue;
          if (event.type === "scheduled_task.created" || event.type === "scheduled_task.updated") {
            const previousTargetSessionId = typeof event.payload.previousTargetSessionId === "string"
              ? event.payload.previousTargetSessionId
              : undefined;
            if (previousTargetSessionId !== undefined && previousTargetSessionId !== event.sessionId) {
              const previousSession = next.sessions.find((session) => session.id === previousTargetSessionId);
              const currentSession = next.sessions.find((session) => session.id === event.sessionId);
              if (currentSession === undefined && previousSession !== undefined) {
                next.sessions = [{ ...previousSession, id: event.sessionId }, ...next.sessions.filter((session) => session.id !== previousTargetSessionId)];
              } else {
                next.sessions = next.sessions.filter((session) => session.id !== previousTargetSessionId);
              }
              const previousTimeline = next.timelines[previousTargetSessionId];
              if (previousTimeline !== undefined) {
                next.timelines[event.sessionId] = previousTimeline.reduce(
                  (combined, item) => mergeTimeline(combined, item),
                  next.timelines[event.sessionId] ?? [],
                );
                delete next.timelines[previousTargetSessionId];
              }
            }
            if (event.payload.change === "cancelled" && isScheduledTaskPlaceholderId(event.sessionId)) {
              next.sessions = next.sessions.filter((session) => session.id !== event.sessionId);
              delete next.timelines[event.sessionId];
              continue;
            }
            const presentationSession = next.sessions.find((session) => session.id === event.sessionId);
            const scheduled = event.payload.change === "cancelled" ? null : mapActiveScheduledTask(event.payload.task);
            const presentation = mapScheduledTaskPresentation(
              event.payload.task,
              presentationSession?.schedule?.content,
            );
            const eventSchedule = scheduled?.sessionId === event.sessionId
              ? scheduledTaskEventSchedule(presentationSession?.schedule, scheduled.schedule)
              : null;
            const presentationTimeline = next.timelines[event.sessionId] ?? [];
            const visibleEventSchedule = eventSchedule === null
              ? null
              : scheduledTaskScheduleAfterProviderEvidence(presentationSession, presentationTimeline, eventSchedule);
            const failureCanRetractPresentation = presentation?.status === "failed"
              && scheduledTaskFailureCanRetractPresentation(
                presentationSession,
                presentationTimeline,
                presentation.item.scheduledTaskId,
              );
            const presentationState = presentation?.sessionId === event.sessionId
              ? scheduledTaskPresentationState(
                  presentationSession,
                  presentationTimeline,
                  presentation.status,
                  presentation.item.scheduledTaskId,
                )
              : undefined;
            next.sessions = replaceSession(next.sessions, event.sessionId, {
              schedule: visibleEventSchedule,
              ...(presentationState !== undefined ? { state: presentationState } : {}),
              ...(presentationState === "working" && presentation
                ? { preview: presentation.item.body, updatedAt: presentation.item.timestamp }
                : {}),
            });
            if (presentation?.sessionId === event.sessionId) {
              next.timelines = {
                ...next.timelines,
                [event.sessionId]: failureCanRetractPresentation
                  ? rollbackOptimisticComposerRow(presentationTimeline, presentation.presentationId)
                  : presentation.status === "failed"
                    ? presentationTimeline
                    : mergeTimeline(presentationTimeline, presentation.item),
              };
            }
            continue;
          }
          if (event.type === "approval.resolved" && typeof event.payload.requestId === "string") {
            next.approvals = next.approvals.filter((approval) => approval.id !== event.payload.requestId);
          }
          if (event.type === "user_input.resolved" && typeof event.payload.requestId === "string") {
            next.inputRequests = next.inputRequests.filter((input) => input.id !== event.payload.requestId);
          }
          if (event.type === "session.goal_updated") {
            const goal = mapSessionGoal(event.payload.goal);
            const currentGoal = next.goals[event.sessionId];
            const clearedThrough = next.goalClearRevisions[event.sessionId] ?? -1;
            if (goal && goal.sessionId === event.sessionId && goal.revision > clearedThrough && (currentGoal === undefined || goal.revision >= currentGoal.revision)) next.goals[event.sessionId] = goal;
            continue;
          }
          if (event.type === "session.goal_cleared") {
            const revision = event.payload.revision;
            if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) continue;
            if ((next.goals[event.sessionId]?.revision ?? -1) <= revision) {
              delete next.goals[event.sessionId];
              next.goalClearRevisions[event.sessionId] = Math.max(next.goalClearRevisions[event.sessionId] ?? -1, revision);
            }
            continue;
          }
          const items = timelineItems[eventIndex] ?? [];
          if (items.length) next.timelines[event.sessionId] = items.reduce(
            (timeline, item) => mergeTimeline(timeline, item),
            next.timelines[event.sessionId] ?? [],
          );
          if (event.type === "session.status_changed") {
            const state = typeof event.payload.state === "string" ? event.payload.state : undefined;
            const known = state === "working" || state === "needs_approval" || state === "needs_input" || state === "idle" || state === "completed" || state === "failed" || state === "offline" || state === "disconnected" || state === "unknown";
            if (known) {
              const quiet = quietCatchUpDue(selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, event.sessionId, lastLiveDeltaAt.current), Date.now(), 2_000);
              const currentSession = next.sessions.find((session) => session.id === event.sessionId);
              const terminalTurnEvidence = !hiddenTimelineDirtySessionIds.current.has(event.sessionId)
                && currentSession !== undefined
                && !sessionHoldsFollowUpQueue(currentSession, next.timelines[event.sessionId] ?? [], workingBoundaryBySession.current.get(event.sessionId));
              const terminalAction = terminalSessionStateActions.get(eventIndex);
              const applyState = terminalAction === "ignore"
                ? false
                : terminalAction === "apply" || shouldApplySessionState(state, quiet || terminalTurnEvidence);
              const normalizedState = state === "disconnected" ? "offline" : state === "unknown" ? "idle" : state as SessionState;
              const hasProviderStatus = Object.prototype.hasOwnProperty.call(event.payload, "providerStatus");
              const providerStatus = providerStatusValue(event.payload.providerStatus);
              const terminalState = normalizedState === "idle" || normalizedState === "completed" || normalizedState === "failed" || normalizedState === "offline";
              const applyProviderStatus = (hasProviderStatus || terminalState) && (applyState || terminalAction === undefined);
              if (applyState || applyProviderStatus) next.sessions = replaceSession(next.sessions, event.sessionId, {
                ...(applyState ? { state: normalizedState } : {}),
                ...(applyProviderStatus ? { providerStatus: providerStatus ?? null } : {}),
                updatedAt: event.occurredAt,
              });
              if (applyState && (normalizedState === "idle" || normalizedState === "completed" || normalizedState === "failed")) {
                const timeline = next.timelines[event.sessionId] ?? [];
                if (!sessionNeedsTranscriptCatchUp({ state: normalizedState }, timeline, workingBoundaryBySession.current.get(event.sessionId))) {
                  next.timelines[event.sessionId] = settleRunningTimeline(timeline, normalizedState === "failed" ? "failed" : "completed");
                }
              }
            }
          }
          if (event.type === "message.started" || event.type === "message.delta" || event.type === "tool.started" || event.type === "command.started") {
            next.sessions = replaceSession(next.sessions, event.sessionId, {
              state: "working",
              ...(eventClearsProviderStatus(event) ? { providerStatus: null } : {}),
              updatedAt: event.occurredAt,
            });
          }
          if (event.type === "agent.completed" || event.type === "agent.interrupted" || event.type === "agent.error") {
            if (event.type === "agent.completed" && agentCompletionActions.get(eventIndex) !== "apply") continue;
            const state: SessionState = event.type === "agent.completed" ? "completed" : event.type === "agent.interrupted" ? "idle" : "failed";
            next.sessions = replaceSession(next.sessions, event.sessionId, {
              state, providerStatus: null, updatedAt: event.occurredAt,
              ...(event.type === "agent.interrupted" ? { interruptedAt: event.occurredAt } : {}),
            });
            // Not every harness closes its rows: OpenCode ends a turn with an idle
            // event and never sends message.completed. Settling here is what stops
            // a finished answer from shimmering until the user clicks it.
            const timeline = next.timelines[event.sessionId] ?? [];
            if (event.type !== "agent.completed" || !sessionNeedsTranscriptCatchUp({ state }, timeline, workingBoundaryBySession.current.get(event.sessionId))) {
              next.timelines[event.sessionId] = settleRunningTimeline(timeline, event.type === "agent.completed" ? "completed" : "failed");
            }
          }
          if (isPersistedCodexFinalAnswer(event)) {
            next.sessions = replaceSession(next.sessions, event.sessionId, { state: "completed", providerStatus: null, updatedAt: event.occurredAt });
            next.timelines[event.sessionId] = settleRunningTimeline(next.timelines[event.sessionId] ?? []);
          }
          if (event.type === "message.delta" || event.type === "message.completed") {
            const rawPreview = typeof event.payload.text === "string" ? event.payload.text : typeof event.payload.delta === "string" ? event.payload.delta : undefined;
            const preview = rawPreview === undefined ? undefined : visibleResponseAnnotationBody(rawPreview);
            next.sessions = replaceSession(next.sessions, event.sessionId, { ...(preview ? { preview } : {}), updatedAt: event.occurredAt });
          }
          if (eventProvesScheduledProviderActivity(event)) {
            const providerSession = next.sessions.find((session) => session.id === event.sessionId);
            if (providerSession?.schedule?.status === "failed") {
              next.sessions = replaceSession(next.sessions, event.sessionId, { schedule: null });
            }
          }
        }
        return next;
      });
      if (!batch.replayGap) {
        // Codex's local rollout event intentionally carries only a bounded
        // attachment descriptor. Read each visible, now-invalidated canonical
        // page at once so its placeholder is upgraded without waiting for a
        // later terminal state, quiet timer, task switch, or app restart.
        for (const sessionId of canonicalTranscriptRefreshSessionIds) {
          void refreshSelectedView(sessionId, true).catch(() => undefined);
        }
      }
      if (selectedTerminalCompletion && selectedSessionIdRef.current
        && !canonicalTranscriptRefreshSessionIds.has(selectedSessionIdRef.current)) {
        catchUpTranscript(selectedSessionIdRef.current, true);
      }
      if (batch.replayGap) {
        void refreshAll(false);
      } else {
        if (refreshSessionsNeeded || catalogueChanged) {
          catalogueRefreshPending.current = true;
          if (snapshotRef.current) {
            catalogueRefreshPending.current = false;
            void refreshVisibleState(false).catch(() => {
              catalogueRefreshPending.current = true;
            });
          }
        }
        if (refreshProvidersNeeded) {
          const connectedProviderIds = new Set(batch.events.flatMap((event) => event.type === "provider.connected" && event.providerId ? [event.providerId] : []));
          void refreshProviders().then((providers) => {
            const visibleProviders = providers.filter((provider) => !revokedConnectorIdsRef.current.has(provider.id));
            setSnapshot((current) => current ? { ...current, providers: visibleProviders } : current);
            const newlyConnected = visibleProviders.filter((provider) => connectedProviderIds.has(provider.id));
            if (newlyConnected.length) void hydrateProviderModels(newlyConnected).catch(() => undefined);
          }).catch(() => undefined);
        }
        if (refreshAttentionNeeded) {
          const requestedAttentionRevision = attentionRevision.current;
          void refreshAttention().then((attention) => {
            if (!attentionResponseIsCurrent(requestedAttentionRevision, attentionRevision.current)) return;
            setSnapshot((current) => current ? { ...current, approvals: attention.approvals, inputRequests: attention.inputRequests } : current);
          }).catch(() => undefined);
        }
        if (refreshSelectedTimeline) {
          const selected = selectedSessionIdRef.current;
          if (selected) {
            const generation = liveTimelineGenerationBySession.current.get(selected) ?? 0;
            void loadTimelinePage(selected).then((page) => {
              if ((liveTimelineGenerationBySession.current.get(selected) ?? 0) === generation) {
                const observed = snapshotRef.current;
                const reconciled = reconcileTimelinePage(page.items, observed?.timelines[selected] ?? []);
                seedWorkingBoundary(observed?.sessions.find((session) => session.id === selected) ?? page.session, reconciled);
              }
              setSnapshot((current) => current && (liveTimelineGenerationBySession.current.get(selected) ?? 0) === generation ? { ...current, sessions: applyOpenedSessionPreview(current.sessions, page.session), timelines: { ...current.timelines, [selected]: reconcileTimelinePage(page.items, current.timelines[selected] ?? []) } } : current);
              setTimelineWindows((current) => {
                if ((liveTimelineGenerationBySession.current.get(selected) ?? 0) !== generation) return current;
                const existing = current[selected];
                if (existing) return existing.nextCursor === retainedHistoryCursor(existing.nextCursor, page.nextCursor)
                  ? current
                  : { ...current, [selected]: { ...existing, nextCursor: retainedHistoryCursor(existing.nextCursor, page.nextCursor) } };
                return { ...current, [selected]: initialTimelineWindow(page.items, page.nextCursor) };
              });
            }).catch(() => undefined);
          }
        }
      }
  };

  const openSession = useCallback(async (sessionId: string, force = false) => {
    visibleTimelineSessionIdsRef.current = new Set([...visibleTimelineSessionIdsRef.current, sessionId]);
    setSelectedSessionId(sessionId);
    setView("workspace");
    if (narrow) setListCollapsed(true);
    if (isScheduledTaskPlaceholderId(sessionId)
      && snapshotRef.current?.sessions.some((session) => session.id === sessionId && session.schedule !== undefined) === true) {
      // Restored schedules have no provider transcript until materialization.
      // Paint their local workspace directly instead of parsing/watching the
      // placeholder as though it were a provider-owned global session ID.
      setSnapshot((current) => current && current.timelines[sessionId] === undefined
        ? { ...current, timelines: { ...current.timelines, [sessionId]: [] } }
        : current);
      setTimelineWindows((current) => current[sessionId] === undefined
        ? { ...current, [sessionId]: initialTimelineWindow([], null) }
        : current);
      return;
    }
    void watchSession(sessionId).catch(() => undefined);
    const alreadyLoaded = snapshot?.timelines[sessionId];
    const hasPagedWindow = timelineWindows[sessionId] !== undefined;
    if (alreadyLoaded !== undefined && hasPagedWindow && !force) {
      // Revealed history belongs to the task just like its scroll mode. Resetting
      // revealStart on every return removes the saved anchor from the DOM before
      // the scroll controller can restore it, so the task appears to jump toward
      // its newest rows even though its PRESERVE_VIEW policy is still correct.
      const dirty = hiddenTimelineDirtySessionIds.current.has(sessionId);
      void (dirty ? reconcileHiddenTimeline(sessionId) : refreshSelectedView(sessionId)).catch(() => undefined);
      return;
    }
    if (openingSessionIdsRef.current.has(sessionId)) return;
    openingSessionIdsRef.current.add(sessionId);
    try {
      const dirty = hiddenTimelineDirtySessionIds.current.has(sessionId);
      const generation = liveTimelineGenerationBySession.current.get(sessionId) ?? 0;
      const page = await loadTimelinePage(sessionId, undefined, HISTORY_PAGE_LIMIT, force || dirty);
      const observed = snapshotRef.current;
      const recentItems = reconcileTimelinePage(page.items, observed?.timelines[sessionId] ?? alreadyLoaded ?? []);
      const refreshIsCurrent = () => (liveTimelineGenerationBySession.current.get(sessionId) ?? 0) === generation;
      seedWorkingBoundary((force || dirty) && refreshIsCurrent()
        ? page.session ?? observed?.sessions.find((session) => session.id === sessionId)
        : observed?.sessions.find((session) => session.id === sessionId) ?? page.session, recentItems);
      setSnapshot((current) => {
        if (!current) return current;
        hiddenTimelineDirtySessionIds.current.delete(sessionId);
        const sessions = (force || dirty) && refreshIsCurrent()
          ? applyOpenedSessionRefresh(current.sessions, page.session)
          : applyOpenedSessionPreview(current.sessions, page.session);
        return { ...current, sessions, timelines: { ...current.timelines, [sessionId]: reconcileTimelinePage(page.items, current.timelines[sessionId] ?? []) } };
      });
      setTimelineWindows((current) => ({
        ...current,
        [sessionId]: initialTimelineWindow(recentItems, page.nextCursor),
      }));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      openingSessionIdsRef.current.delete(sessionId);
    }
  }, [loadTimelinePage, narrow, notify, reconcileHiddenTimeline, refreshSelectedView, seedWorkingBoundary, snapshot?.timelines, timelineWindows]);

  const markQueuedNewTaskDelivery = useCallback((
    sessionId: string,
    deliveryId: string,
    state: "sending" | "failed" | "sent",
    error?: string,
  ) => {
    setSnapshot((current) => {
      if (!current) return current;
      let ownsDelivery = false;
      const timeline = (current.timelines[sessionId] ?? []).map((item) => {
        if (item.queuedNewTaskDeliveryId !== deliveryId) return item;
        ownsDelivery = true;
        const settled = withoutQueuedNewTaskDelivery(item);
        if (state === "sent") return settled;
        return {
          ...settled,
          queuedNewTaskDeliveryId: deliveryId,
          queuedNewTaskDeliveryState: state,
          ...(state === "failed" && error ? { queuedNewTaskDeliveryError: error } : {}),
        };
      });
      // A canonical provider echo clears this identity in timeline_merge. It is
      // stronger evidence than a late transport failure and must stay settled.
      if (!ownsDelivery) return current;
      return {
        ...current,
        sessions: state === "failed"
          ? replaceSession(current.sessions, sessionId, { state: "idle" })
          : state === "sending"
            ? replaceSession(current.sessions, sessionId, { state: "working" })
            : current.sessions,
        timelines: { ...current.timelines, [sessionId]: timeline },
      };
    });
  }, []);

  const deliverQueuedNewTask = useCallback(async (sessionId: string, deliveryId: string) => {
    markQueuedNewTaskDelivery(sessionId, deliveryId, "sending");
    try {
      const result = await request("message_queue.deliver_new_task", { deliveryId });
      if (!result.delivery || typeof result.delivery !== "object" || Array.isArray(result.delivery)) {
        throw new Error("The bridge did not return the queued instruction delivery.");
      }
      const delivery = result.delivery as Record<string, unknown>;
      if (delivery.id !== deliveryId || delivery.sessionId !== sessionId) {
        throw new Error("The bridge returned a different queued instruction delivery.");
      }
      if (delivery.state === "sent") {
        markQueuedNewTaskDelivery(sessionId, deliveryId, "sent");
        return;
      }
      if (delivery.state === "failed") {
        const detail = typeof delivery.error === "string" && delivery.error.trim()
          ? delivery.error.trim()
          : "Something went wrong while sending this message.";
        markQueuedNewTaskDelivery(sessionId, deliveryId, "failed", detail);
        return;
      }
      throw new Error("The queued instruction delivery did not finish.");
    } catch (error) {
      markQueuedNewTaskDelivery(
        sessionId,
        deliveryId,
        "failed",
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Something went wrong while sending this message.",
      );
    }
  }, [markQueuedNewTaskDelivery]);

  const insertDerivedSession = useCallback((source: Session, value: Record<string, unknown>, _summary?: string, draft?: string, navigationIntent?: { selectedSessionId: string | null; view: View }, queuedNewTask?: QueuedNewTaskPresentation) => {
    try {
      const next = derivedSession(value, source);
      const shouldNavigate = navigationIntent
        ? selectedSessionIdRef.current === navigationIntent.selectedSessionId && viewRef.current === navigationIntent.view
        : selectedSessionIdRef.current === source.id && viewRef.current === "workspace";
      setSnapshot((current) => {
        if (!current) return current;
        const sessions = [next, ...current.sessions.filter((item) => item.id !== next.id)];
        if (!queuedNewTask) return { ...current, sessions };
        const existing = current.timelines[next.id] ?? [];
        const timeline = existing.some((item) => item.presentationId === queuedNewTask.optimisticItem.presentationId)
          ? existing
          : mergeTimeline(existing, queuedNewTask.optimisticItem);
        return { ...current, sessions, timelines: { ...current.timelines, [next.id]: timeline } };
      });
      if (queuedNewTask) {
        setTimelineWindows((current) => current[next.id] === undefined
          ? { ...current, [next.id]: initialTimelineWindow([queuedNewTask.optimisticItem], null) }
          : current);
      }
      if (draft) composerDrafts.current[next.id] = draft;
      if (shouldNavigate) void openSession(next.id, true);
      else {
        void watchSession(next.id).catch(() => undefined);
        void reconcileHiddenTimeline(next.id).catch(() => undefined);
      }
      if (queuedNewTask) {
        window.requestAnimationFrame(() => {
          void deliverQueuedNewTask(next.id, queuedNewTask.deliveryId);
        });
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [deliverQueuedNewTask, notify, openSession, reconcileHiddenTimeline]);

  const branchSessionFromList = useCallback(async (sessionId: string) => {
    const source = snapshot?.sessions.find((session) => session.id === sessionId);
    const provider = source ? providerFor(snapshot?.providers ?? [], source.providerId) : undefined;
    if (!source || source.draft || source.schedule || source.state === "offline" || !snapshot?.connected || provider?.state !== "online" || !provider.detected || !provider.capabilities.includes("Create Session") || !provider.capabilities.includes("Send Message") || !provider.capabilities.includes("Session History")) return;
    const navigationIntent = { selectedSessionId: selectedSessionIdRef.current, view: viewRef.current };
    try {
      const result = await request("session.branch", { sessionId });
      if (!result.session || typeof result.session !== "object" || Array.isArray(result.session)) throw new Error("Bridge did not return the branched task.");
      insertDerivedSession(source, result.session as Record<string, unknown>, undefined, undefined, navigationIntent);
      notify(`Branched in a new task${typeof result.copiedMessageCount === "number" ? ` with ${result.copiedMessageCount} copied messages` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [insertDerivedSession, notify, snapshot]);

  const openSideChatPanel = useCallback((sessionId: string, anchor: SideChatAnchor) => {
    visibleTimelineSessionIdsRef.current = new Set([...visibleTimelineSessionIdsRef.current, sessionId]);
    setOpenSideChats((current) => {
      const existing = current.find((item) => item.id === sessionId);
      if (existing) return current.map((item) => item.id === sessionId ? { ...item, anchor } : item);
      return [...current.slice(-1), { id: sessionId, anchor }];
    });
    const alreadyLoaded = snapshotRef.current?.timelines[sessionId] !== undefined;
    const dirty = hiddenTimelineDirtySessionIds.current.has(sessionId);
    if (alreadyLoaded && !dirty) return;
    const generation = liveTimelineGenerationBySession.current.get(sessionId) ?? 0;
    void (dirty ? reconcileHiddenTimeline(sessionId) : loadTimelinePage(sessionId).then((page) => {
      if ((liveTimelineGenerationBySession.current.get(sessionId) ?? 0) !== generation) return;
      const observed = snapshotRef.current;
      const reconciled = reconcileTimelinePage(page.items, observed?.timelines[sessionId] ?? []);
      seedWorkingBoundary(observed?.sessions.find((session) => session.id === sessionId) ?? page.session, reconciled);
      setSnapshot((current) => current && (liveTimelineGenerationBySession.current.get(sessionId) ?? 0) === generation ? { ...current, timelines: { ...current.timelines, [sessionId]: reconcileTimelinePage(page.items, current.timelines[sessionId] ?? []) } } : current);
    })).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
  }, [loadTimelinePage, notify, reconcileHiddenTimeline, seedWorkingBoundary]);

  // Every transient dismissal is hide-only. The stored session and its draft
  // remain available for the opted-in child row and a later reopen.
  const hideSideChatPanel = useCallback((sessionId: string) => {
    visibleTimelineSessionIdsRef.current = new Set([...visibleTimelineSessionIdsRef.current].filter((id) => id !== sessionId));
    setOpenSideChats((current) => current.some((item) => item.id === sessionId)
      ? current.filter((item) => item.id !== sessionId)
      : current);
  }, []);

  const createSideChat = useCallback(async (parentSessionId: string, prompt?: string, queuedMessageId?: string) => {
    const source = snapshotRef.current?.sessions.find((session) => session.id === parentSessionId && !isSideChatSession(session));
    if (!source) throw new Error("The parent task is no longer available.");
    const response = await request("side_chat.create", { parentSessionId, ...(prompt?.trim() ? { prompt: prompt.trim() } : {}), ...(queuedMessageId ? { queuedMessageId } : {}) });
    if (!response.session || typeof response.session !== "object" || Array.isArray(response.session)) throw new Error("Bridge did not return the side chat.");
    const next = derivedSession(response.session as Record<string, unknown>, source);
    const sideChat: Session = { ...next, sessionKind: "side_chat", parentSessionId, ...(prompt?.trim() ? { preview: prompt.trim() } : {}) };
    const initialSendError = typeof response.initialSendError === "string" && response.initialSendError.trim()
      ? response.initialSendError.trim()
      : undefined;
    if (initialSendError !== undefined && prompt?.trim()) {
      sideChatDrafts.current[sideChat.id] = { content: prompt.trim(), attachments: [] };
    }
    setSnapshot((current) => current ? { ...current, sessions: [sideChat, ...current.sessions.filter((session) => session.id !== sideChat.id)] } : current);
    const parentElement = document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(parentSessionId)}"]`);
    const bounds = parentElement?.getBoundingClientRect();
    openSideChatPanel(sideChat.id, { x: bounds?.right ?? 248, y: bounds ? bounds.top + bounds.height / 2 : Math.max(110, window.innerHeight - 210) });
    if (initialSendError !== undefined) notify(initialSendError, "error");
  }, [notify, openSideChatPanel]);

  const promoteSideChat = useCallback(async (sessionId: string) => {
    const selectedAtStart = selectedSessionIdRef.current;
    const viewAtStart = viewRef.current;
    const response = await request("side_chat.promote", { sessionId });
    const source = snapshot?.sessions.find((session) => session.id === sessionId);
    if (!source || !response.session || typeof response.session !== "object" || Array.isArray(response.session)) throw new Error("Bridge did not return the promoted task.");
    const promoted: Session = { ...derivedSession(response.session as Record<string, unknown>, source), sessionKind: "task" };
    delete promoted.parentSessionId;
    setSnapshot((current) => current ? { ...current, sessions: [promoted, ...current.sessions.filter((session) => session.id !== promoted.id)] } : current);
    hideSideChatPanel(sessionId);
    const shouldNavigate = selectedSessionIdRef.current === selectedAtStart && viewRef.current === viewAtStart;
    if (shouldNavigate) void openSession(promoted.id, true);
    else {
      void watchSession(promoted.id).catch(() => undefined);
      void reconcileHiddenTimeline(promoted.id).catch(() => undefined);
    }
    notify("Side chat copied to a full task");
  }, [hideSideChatPanel, notify, openSession, reconcileHiddenTimeline, snapshot?.sessions]);

  const updateSideChatDraft = useCallback((sessionId: string, update: SideChatDraftUpdate) => {
    const current = sideChatDrafts.current;
    const previous = current[sessionId] ?? emptySideChatDraft;
    const nextDraft = typeof update === "function" ? update(previous) : update;
    if (previous.content === nextDraft.content && previous.attachments === nextDraft.attachments) return;
    current[sessionId] = nextDraft;
  }, []);

  const discardSideChatDraft = useCallback((sessionId: string) => {
    delete sideChatDrafts.current[sessionId];
  }, []);

  const beginSideChatSend = useCallback((sessionId: string): boolean => {
    if (sideChatSendLocks.current.has(sessionId)) return false;
    sideChatSendLocks.current.add(sessionId);
    setSideChatSendingSessions((current) => {
      if (current.has(sessionId)) return current;
      const next = new Set(current);
      next.add(sessionId);
      return next;
    });
    return true;
  }, []);

  const finishSideChatSend = useCallback((sessionId: string) => {
    if (!sideChatSendLocks.current.delete(sessionId)) return;
    setSideChatSendingSessions((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const rollbackSideChatSend = useCallback((
    sessionId: string,
    presentationId: string,
    optimisticTimestamp: string,
    previousSession: Session,
    submittedDraft: SideChatDraft,
  ): boolean => {
    const observedPresentation = (snapshotRef.current?.timelines[sessionId] ?? [])
      .find((item) => item.id === presentationId || item.presentationId === presentationId);
    // The provider's canonical id can arrive before the request acknowledgement.
    // That echo is authoritative acceptance, so a later transport rejection must
    // not retract the row, restore a retryable duplicate, or cancel its uploads.
    if (observedPresentation?.presentationId === presentationId && observedPresentation.id !== presentationId) return false;
    const currentDraft = sideChatDrafts.current[sessionId] ?? emptySideChatDraft;
    const restoredDraft = mergeFailedSideChatDraft(submittedDraft, currentDraft);
    sideChatDrafts.current[sessionId] = restoredDraft;
    setSideChatDraftRestoreRevision((current) => current + 1);
    setSnapshot((current) => {
      if (!current) return current;
      const currentTimeline = current.timelines[sessionId] ?? [];
      const timeline = rollbackOptimisticComposerRow(currentTimeline, presentationId);
      let sessionChanged = false;
      const sessions = current.sessions.map((item) => {
        if (item.id !== sessionId || item.updatedAt !== optimisticTimestamp) return item;
        sessionChanged = true;
        return {
          ...item,
          state: previousSession.state,
          preview: previousSession.preview,
          updatedAt: previousSession.updatedAt,
        };
      });
      if (timeline === currentTimeline && !sessionChanged) return current;
      return {
        ...current,
        ...(sessionChanged ? { sessions } : {}),
        ...(timeline !== currentTimeline ? { timelines: { ...current.timelines, [sessionId]: timeline } } : {}),
      };
    });
    return true;
  }, []);

  const createContextHandoff = useCallback(async (parentSessionId: string, customNote: string) => {
    const source = snapshotRef.current?.sessions.find((session) => session.id === parentSessionId && !isSideChatSession(session));
    if (!source) throw new Error("The parent task is no longer available.");
    const trimmedNote = customNote.trim();
    const content = buildContextHandoffInstruction(trimmedNote);
    const response = await request("side_chat.create", { parentSessionId });
    if (!response.session || typeof response.session !== "object" || Array.isArray(response.session)) throw new Error("Bridge did not return the side chat.");
    const next = derivedSession(response.session as Record<string, unknown>, source);
    const sideChat: Session = { ...next, sessionKind: "side_chat", parentSessionId };
    const timestamp = new Date().toISOString();
    const id = `local-handoff-${crypto.randomUUID()}`;
    const promptId = `local-${Date.now()}`;
    const prompt: TimelineItem = { id: promptId, presentationId: promptId, kind: "user", body: content, timestamp, state: "completed" };
    const marker: TimelineItem = { id, presentationId: id, kind: "tool", title: trimmedNote ? "Custom context handoff" : "Context handoff", body: trimmedNote, detail: sideChat.id, timestamp, state: "completed" };
    beginSideChatSend(sideChat.id);
    setSnapshot((current) => current ? {
      ...current,
      sessions: [{ ...sideChat, state: "working", preview: content, updatedAt: timestamp }, ...current.sessions.filter((session) => session.id !== sideChat.id)],
      timelines: {
        ...current.timelines,
        [parentSessionId]: [...(current.timelines[parentSessionId] ?? []), marker],
        [sideChat.id]: mergeAcceptedComposerRow(current.timelines[sideChat.id] ?? [], prompt, new Set()),
      },
    } : current);
    const parentElement = document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(parentSessionId)}"]`);
    const bounds = parentElement?.getBoundingClientRect();
    openSideChatPanel(sideChat.id, { x: bounds?.right ?? 248, y: bounds ? bounds.top + bounds.height / 2 : Math.max(110, window.innerHeight - 210) });
    try {
      await request("session.send_message", { sessionId: sideChat.id, content });
    } catch (error) {
      if (!isDeliveryUnknownError(error)) rollbackSideChatSend(sideChat.id, prompt.id, timestamp, sideChat, { content, attachments: [] });
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      finishSideChatSend(sideChat.id);
    }
  }, [beginSideChatSend, finishSideChatSend, notify, openSideChatPanel, rollbackSideChatSend]);

  const updateSideChatAnchor = useCallback((sessionId: string, anchor: SideChatAnchor) => {
    setOpenSideChats((current) => current.map((item) => item.id === sessionId && (item.anchor.x !== anchor.x || item.anchor.y !== anchor.y) ? { ...item, anchor } : item));
  }, []);

  const loadOlderHistory = useCallback(async (sessionId: string) => {
    const windowState = timelineWindows[sessionId];
    if (!windowState || windowState.loadingOlder) return;
    if (windowState.revealStart > 0) {
      const timeline = snapshot?.timelines[sessionId] ?? [];
      setTimelineWindows((current) => {
        const existing = current[sessionId];
        if (!existing) return current;
        const revealStart = Math.max(0, existing.revealStart - 24);
        return { ...current, [sessionId]: {
          ...existing,
          revealStart,
          revealAnchorKey: timeline[revealStart] ? timelineRevealAnchorKey(timeline[revealStart]!) : null,
        } };
      });
      return;
    }
    if (!windowState.nextCursor) return;
    setTimelineWindows((current) => {
      const existing = current[sessionId];
      return existing ? { ...current, [sessionId]: { ...existing, loadingOlder: true } } : current;
    });
    try {
      const baseline = snapshot?.timelines[sessionId] ?? [];
      const session = snapshot?.sessions.find((item) => item.id === sessionId);
      const active = session ? sessionPresentsLiveTurn(session, baseline, workingBoundaryBySession.current.get(sessionId)) : false;
      const anchorsBefore = new Set(renderedTimelineAnchorIds(baseline, active));
      const requestedCursors = new Set<string>();
      let cursor: string | null = windowState.nextCursor;
      let loadedItems: TimelineItem[] = [];
      let rebased = false;
      for (let attempt = 0; attempt < maximumInvisibleHistoryPages && cursor !== null; attempt += 1) {
        if (requestedCursors.has(cursor)) {
          cursor = null;
          break;
        }
        requestedCursors.add(cursor);
        let page: Awaited<ReturnType<typeof loadTimelinePage>>;
        try {
          page = await loadTimelinePage(sessionId, cursor, HISTORY_PAGE_LIMIT);
        } catch (error) {
          if (rebased || !isHistoryPageExpired(error)) throw error;
          // A newest-page refresh can replace an opaque provider boundary while
          // this reader is idle. Rebase inside this history load, then continue
          // from the refreshed boundary exactly once; do not reread the whole
          // transcript or leave the reader with a dead loader.
          const latest = await loadTimelinePage(sessionId, undefined, HISTORY_PAGE_LIMIT, true);
          rebased = true;
          loadedItems = prependTimelinePage(loadedItems, latest.items);
          if (latest.nextCursor === cursor) {
            cursor = null;
            break;
          }
          cursor = latest.nextCursor;
          continue;
        }
        if (historyPageNeedsRebase(cursor, page.nextCursor)) {
          // The bridge snapshots provider history between cursor requests. If a
          // newest-page refresh replaced that snapshot, a formerly valid cursor
          // can appear exhausted and the UI used to remove the loader forever.
          // Re-open once, then continue from the new boundary.
          const latest = await loadTimelinePage(sessionId, undefined, HISTORY_PAGE_LIMIT, true);
          loadedItems = prependTimelinePage(loadedItems, latest.items);
          page = latest.nextCursor === null
            ? { items: [], nextCursor: null }
            : await loadTimelinePage(sessionId, latest.nextCursor, HISTORY_PAGE_LIMIT);
        }
        loadedItems = prependTimelinePage(loadedItems, page.items);
        const nextCursor: string | null = page.nextCursor === cursor || requestedCursors.has(page.nextCursor ?? "")
          ? null
          : page.nextCursor;
        cursor = nextCursor;
        const candidate = prependTimelinePage(baseline, loadedItems);
        if (renderedTimelineAnchorIds(candidate, active).some((id) => !anchorsBefore.has(id))) break;
      }
      setSnapshot((current) => current ? {
        ...current,
        timelines: { ...current.timelines, [sessionId]: prependTimelinePage(current.timelines[sessionId] ?? [], loadedItems) },
      } : current);
      setTimelineWindows((current) => ({
        ...current,
        [sessionId]: { nextCursor: cursor, revealStart: 0, revealAnchorKey: null, loadingOlder: false },
      }));
    } catch (error) {
      setTimelineWindows((current) => {
        const existing = current[sessionId];
        return existing ? { ...current, [sessionId]: { ...existing, loadingOlder: false } } : current;
      });
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [loadTimelinePage, notify, snapshot?.timelines, timelineWindows]);

  const startDraftTask = useCallback((workingDirectoryOverride?: string) => {
    if (!snapshot) return;
    const source = snapshot.sessions.find((session) => session.id === selectedSessionId && !session.draft)
      ?? snapshot.sessions.find((session) => !session.draft);
    const canCreate = (provider: Provider) => provider.detected && provider.state === "online" && provider.capabilities.includes("Create Session") && provider.capabilities.includes("Send Message");
    const preferredProvider = snapshot.providers.find((provider) => provider.id === source?.providerId && canCreate(provider))
      ?? snapshot.providers.find((provider) => provider.authenticated && canCreate(provider))
      ?? snapshot.providers.find(canCreate)
      ?? snapshot.providers[0];
    if (!preferredProvider) {
      notify("Connect an agent before starting a task.", "error");
      return;
    }
    const models = snapshot.models[preferredProvider.id] ?? [];
    const selection = resolveConcreteModelSelection(models, {}, preferences.agentDefaults[preferredProvider.id]);
    const workingDirectory = workingDirectoryOverride ?? source?.workingDirectory ?? "";
    const now = new Date().toISOString();
    const draft: Session = {
      id: `draft-${crypto.randomUUID()}`,
      draft: true,
      providerId: preferredProvider.id,
      title: "New task",
      state: "idle",
      project: workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "Choose a folder",
      workingDirectory,
      preview: "",
      updatedAt: now,
      model: selection?.modelId ?? "default",
      effort: selection?.reasoningEffort ?? "",
    };
    setSnapshot((current) => current ? {
      ...current,
      sessions: [draft, ...current.sessions],
      timelines: { ...current.timelines, [draft.id]: [] },
    } : current);
    setTimelineWindows((current) => ({ ...current, [draft.id]: { nextCursor: null, revealStart: 0, revealAnchorKey: null, loadingOlder: false } }));
    composerDrafts.current[draft.id] = "";
    setSelectedProvider("all");
    setSelectedSessionId(draft.id);
    setView("workspace");
    if (narrow) setListCollapsed(true);
  }, [narrow, notify, preferences.agentDefaults, selectedSessionId, snapshot]);

  const rememberProject = useCallback(async (directory: string, save = false) => {
    if (isBrowserPreview) {
      setPreferences((current) => {
        const saved = current.savedProjectDirectories ?? [];
        if (!save && !saved.some((candidate) => normalizeProjectDirectory(candidate) === normalizeProjectDirectory(directory))) return current;
        return { ...current, savedProjectDirectories: normalizeSavedProjectDirectories([directory, ...saved]) };
      });
      return;
    }
    setPreferences(await window.tethoqDesktop.preferencesAction({ type: save ? "save-project" : "use-project", directory }));
  }, []);

  const startProjectTask = useCallback(async () => {
    const currentDirectory = snapshot?.sessions.find((session) => session.id === selectedSessionId)?.workingDirectory
      ?? snapshot?.sessions.find((session) => session.workingDirectory)?.workingDirectory
      ?? "";
    try {
      const workingDirectory = await selectDirectory(currentDirectory);
      if (workingDirectory) {
        await rememberProject(workingDirectory, true);
        startDraftTask(workingDirectory);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [notify, rememberProject, selectedSessionId, snapshot?.sessions, startDraftTask]);

  const updateDraftSelection = useCallback((draftSessionId: string, selection: DraftModelSelection) => {
    setSnapshot((current) => current ? {
      ...current,
      sessions: current.sessions.map((session) => session.id === draftSessionId && session.draft
        ? { ...session, providerId: selection.providerId, model: selection.modelId, effort: selection.effort }
        : session),
    } : current);
  }, []);

  const chooseDraftDirectory = useCallback(async (draftSessionId: string, currentDirectory: string) => {
    try {
      const workingDirectory = await selectDirectory(currentDirectory);
      if (!workingDirectory) return;
      await rememberProject(workingDirectory, true);
      setSnapshot((current) => current ? {
        ...current,
        sessions: current.sessions.map((session) => session.id === draftSessionId && session.draft ? {
          ...session,
          workingDirectory,
          project: workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "New project",
        } : session),
      } : current);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [notify, rememberProject]);

  const beginDraftMaterialization = useCallback((input: DraftSessionMaterializeInput, firstTurn?: {
    readonly content?: string;
    readonly title: string;
    readonly simplify?: JsonObject;
  }): Promise<DraftMaterializationResult> => {
    const retained = composerDraftMaterializations.current.get(input.draftSessionId);
    if (retained) return retained.promise;
    const resolvedSessionId = resolveComposerDraftSessionId(input.draftSessionId);
    if (resolvedSessionId !== input.draftSessionId) {
      const existing = snapshotRef.current?.sessions.find((session) => session.id === resolvedSessionId);
      if (existing) return Promise.resolve({ session: existing, firstInstructionIncluded: false });
    }
    const source = snapshotRef.current?.sessions.find((session) => session.id === input.draftSessionId);
    if (!source || (!source.draft && source.providerId === input.providerId)) return Promise.reject(new Error("This task is no longer available for creation or a model switch."));
    if (!input.workingDirectory.trim()) return Promise.reject(new Error("Choose a project folder before starting this task."));
    const modelFields = {
      ...(!isAmbiguousSelectionValue(input.modelId) ? { modelId: input.modelId } : {}),
      ...(!isAmbiguousSelectionValue(input.effort) ? { reasoningEffort: input.effort.toLowerCase() } : {}),
    };
    const localDraft = composerDraftSnapshot(composerDraftStore, input.draftSessionId);
    const visibleDraft = parseResponseAnnotations(localDraft.content)?.body ?? localDraft.content;
    const title = firstTurn?.title.trim()
      || visibleDraft.trim().split(/\r?\n/u)[0]?.slice(0, 96)
      || "New task";
    let record: DraftMaterializationRecord;
    const promise = (async (): Promise<DraftMaterializationResult> => {
      if (!source.draft) {
        const response = await request("session.switch_model", {
          sessionId: source.id,
          providerId: input.providerId,
          modelId: input.modelId,
          ...(input.effort ? { reasoningEffort: input.effort } : {}),
          requestId: input.requestId!,
        });
        if (!response.session || typeof response.session !== "object" || Array.isArray(response.session)) throw new Error("The coding tool did not return the continued task");
        const next = derivedSession(response.session as Record<string, unknown>, source);
        const page = await loadTimelinePage(next.id);
        return { session: next, firstInstructionIncluded: false, timeline: page.items };
      }
      const response = await request("session.create", {
        providerId: input.providerId,
        workingDirectory: input.workingDirectory,
        title,
        provisionalTitle: true,
        ...modelFields,
        ...(firstTurn?.content !== undefined ? { firstInstruction: firstTurn.content } : {}),
        ...(firstTurn?.simplify !== undefined ? { simplify: firstTurn.simplify } : {}),
      });
      const firstInstructionIncluded = firstTurn?.content !== undefined;
      const visibleInput = firstTurn?.content !== undefined ? parseResponseAnnotations(firstTurn.content)?.body ?? firstTurn.content : "";
      return {
        session: materializedDraftSession(response.session, input, source, title, firstInstructionIncluded ? "working" : "idle", visibleInput),
        firstInstructionIncluded,
      };
    })();
    record = { promise };
    composerDraftMaterializations.current.set(input.draftSessionId, record);
    void promise.catch(() => {
      if (composerDraftMaterializations.current.get(input.draftSessionId) === record) composerDraftMaterializations.current.delete(input.draftSessionId);
    });
    return promise;
  }, [loadTimelinePage, resolveComposerDraftSessionId]);

  const commitDraftMaterialization = useCallback((input: DraftSessionMaterializeInput, result: DraftMaterializationResult, presentation: {
    readonly acceptedItem?: TimelineItem;
    readonly accepted?: boolean;
    readonly state?: SessionState;
    readonly preview?: string;
  } = {}): Session => {
    const sessionId = result.session.id;
    const firstCommit = resolveComposerDraftSessionId(input.draftSessionId) === input.draftSessionId;
    const retainedDraft = composerDraftSnapshot(composerDraftStore, input.draftSessionId);
    const retainedDelegationDraft = composerDelegationDrafts.current[input.draftSessionId];
    const shouldNavigate = selectedSessionIdRef.current === input.draftSessionId && viewRef.current === "workspace";
    if (firstCommit) {
      composerDraftMaterializations.current.delete(input.draftSessionId);
      composerDraftSessionAliases.current[input.draftSessionId] = sessionId;
      moveTaskOverride(input.draftSessionId, sessionId);
      rebindComposerDraftState(composerDraftStore, input.draftSessionId, sessionId, retainedDraft);
      // A different harness starts a fresh native turn; an old Steer mode cannot
      // steer that idle session. Later turns can use its ordinary task controls.
      if (result.session.relationshipKind === "model_switch" && composerDraftStore.modes[sessionId] === "steer") composerDraftStore.modes[sessionId] = "queue";
      delete composerDelegationDrafts.current[input.draftSessionId];
      if (retainedDelegationDraft && composerDelegationDrafts.current[sessionId] === undefined) composerDelegationDrafts.current[sessionId] = retainedDelegationDraft;
      setQueueingBySession((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, input.draftSessionId)) return current;
        const next = { ...current, [sessionId]: current[input.draftSessionId]! };
        delete next[input.draftSessionId];
        return next;
      });
      setComposerDraftRestoreRevisions((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, input.draftSessionId)) return current;
        const next = { ...current, [sessionId]: current[input.draftSessionId]! };
        delete next[input.draftSessionId];
        return next;
      });
    }
    const committed: Session = {
      ...result.session,
      ...(presentation.state !== undefined ? { state: presentation.state } : {}),
      ...(presentation.preview !== undefined ? { preview: presentation.preview } : {}),
    };
    setSnapshot((current) => {
      if (!current) return current;
      const timelines = { ...current.timelines };
      const draftTimeline = timelines[input.draftSessionId] ?? [];
      const providerTimeline = timelines[sessionId] ?? [];
      delete timelines[input.draftSessionId];
      const transferredTimeline = result.timeline;
      let combinedTimeline = transferredTimeline !== undefined
        ? [...transferredTimeline]
        : providerTimeline.reduce((combined, item) => mergeTimeline(combined, item), [...draftTimeline]);
      if (presentation.acceptedItem) {
        combinedTimeline = presentation.accepted === false
          ? rollbackOptimisticComposerRow(combinedTimeline, presentation.acceptedItem.presentationId ?? presentation.acceptedItem.id)
          : mergeAcceptedComposerRow(combinedTimeline, presentation.acceptedItem, new Set(combinedTimeline.filter((item) => item.kind === "user" && item.id !== presentation.acceptedItem!.id).map((item) => item.id)));
      }
      timelines[sessionId] = combinedTimeline;
      const existing = current.sessions.find((session) => session.id === sessionId);
      const nextSession = {
        ...committed,
        ...existing,
        state: committed.state,
        preview: committed.preview,
        model: committed.model,
        effort: committed.effort,
      };
      return {
        ...current,
        sessions: [nextSession, ...current.sessions.filter((session) => session.id !== input.draftSessionId && session.id !== sessionId)],
        timelines,
      };
    });
    setTimelineWindows((current) => {
      const next = { ...current };
      delete next[input.draftSessionId];
      next[sessionId] ??= { nextCursor: null, revealStart: 0, revealAnchorKey: null, loadingOlder: false };
      return next;
    });
    if (shouldNavigate) {
      selectedSessionIdRef.current = sessionId;
      setSelectedSessionId(sessionId);
      setView("workspace");
    }
    if (firstCommit) {
      void watchSession(sessionId).catch(() => undefined);
      void reconcileHiddenTimeline(sessionId).catch(() => undefined);
    }
    return committed;
  }, [moveTaskOverride, reconcileHiddenTimeline, resolveComposerDraftSessionId]);

  const materializeDraftForAction = useCallback(async (input: DraftSessionMaterializeInput, action: ComposerTaskAction): Promise<void> => {
    const result = await beginDraftMaterialization(input);
    const selectedSessionId = selectedSessionIdRef.current;
    const actionStillRequested = viewRef.current === "workspace"
      && (selectedSessionId === input.draftSessionId || selectedSessionId === result.session.id);
    if (actionStillRequested) setPendingComposerAction({ requestId: `draft-action-${crypto.randomUUID()}`, sessionId: result.session.id, action });
    commitDraftMaterialization(input, result);
  }, [beginDraftMaterialization, commitDraftMaterialization]);

  const createDraftSend = useCallback(async (input: DraftSessionSendInput) => {
    const materializeInput: DraftSessionMaterializeInput = {
      draftSessionId: input.draftSessionId,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      providerId: input.providerId,
      workingDirectory: input.workingDirectory,
      modelId: input.modelId,
      effort: input.effort,
    };
    const annotatedInput = parseResponseAnnotations(input.content);
    const visibleInput = annotatedInput?.body ?? input.content;
    const title = visibleInput.trim().split(/\r?\n/u)[0]?.slice(0, 96) || "Annotated response";
    const modelFields = {
      ...(!isAmbiguousSelectionValue(input.modelId) ? { modelId: input.modelId } : {}),
      ...(!isAmbiguousSelectionValue(input.effort) ? { reasoningEffort: input.effort.toLowerCase() } : {}),
    };
    const separatedFirstTurn = input.attachmentIds.length > 0 || input.workflowIds.length > 0 || input.goalObjective !== undefined;
    const result = await beginDraftMaterialization(materializeInput, {
      title,
      ...(!separatedFirstTurn ? {
        content: input.content,
        ...(input.simplify !== undefined ? { simplify: input.simplify } : {}),
      } : {}),
    });
    if (separatedFirstTurn || !result.firstInstructionIncluded) {
      try {
        await request("session.send_message", {
          sessionId: result.session.id,
          content: input.content,
          ...modelFields,
          ...(input.attachmentIds.length ? { attachmentIds: [...input.attachmentIds] } : {}),
          ...(input.workflowIds.length ? { workflowIds: [...input.workflowIds] } : {}),
          ...(input.simplify !== undefined ? { simplify: input.simplify } : {}),
          ...(input.goalObjective !== undefined ? { goal: { objective: input.goalObjective } } : {}),
        });
      } catch (error) {
        composerDraftRestoreTargets.current[input.draftSessionId] = result.session.id;
        commitDraftMaterialization(materializeInput, result, { acceptedItem: input.optimisticItem, accepted: false, state: "idle", preview: "" });
        throw error;
      }
    }
    delete composerDraftRestoreTargets.current[input.draftSessionId];
    if (input.goalObjective !== undefined) composerDraftStore.modes[resolveComposerDraftSessionId(input.draftSessionId)] = "queue";
    commitDraftMaterialization(materializeInput, result, { acceptedItem: input.optimisticItem, accepted: true, state: "working", preview: visibleInput });
  }, [beginDraftMaterialization, commitDraftMaterialization, composerDraftStore, resolveComposerDraftSessionId]);

  const retainDraftScheduleAttempt = useCallback((input: DraftSessionScheduleInput): DraftSessionScheduleInput => {
    const existing = composerScheduleAttempts.current[input.draftSessionId];
    if (existing) return existing.input;
    composerScheduleAttempts.current[input.draftSessionId] = { input, inFlight: null, failure: null };
    setComposerScheduleAttemptRevision((revision) => revision + 1);
    return input;
  }, []);

  const createDraftSchedule = useCallback((submittedInput: DraftSessionScheduleInput): Promise<void> => {
    const input = retainDraftScheduleAttempt(submittedInput);
    const record = composerScheduleAttempts.current[input.draftSessionId]!;
    if (record.inFlight) return record.inFlight;
    record.failure = null;
    const operation = (async () => {
      // Yield once so the Promise is published before any renderer re-entry can
      // submit this keyed draft again.
      await Promise.resolve();
      if (!input.workingDirectory.trim()) throw new Error("Choose a project folder before scheduling this task.");
      const modelFields = {
        ...(!isAmbiguousSelectionValue(input.modelId) ? { modelId: input.modelId } : {}),
        ...(!isAmbiguousSelectionValue(input.effort) ? { reasoningEffort: input.effort.toLowerCase() } : {}),
      };
      const response = await request("scheduled_task.create", {
        providerId: input.providerId,
        workingDirectory: input.workingDirectory,
        title: input.title,
        content: input.content,
        runAt: input.runAt,
        ...modelFields,
        ...(input.meshTargets.length ? { meshTargets: input.meshTargets.map(meshTargetRoute) } : {}),
      }, input.requestId);
      const scheduled = createdScheduledSession(response.task, input);
      const previousContent = composerDrafts.current[input.draftSessionId] ?? "";
      const retainedContent = clearScheduledDraftContent(previousContent, input.scheduledComposerContent);
      const retainedMeshTargets = moveMeshTargets(previousContent, retainedContent, remainingMeshTargetsAfterSchedule(
        composerMeshTargets.current[input.draftSessionId] ?? [],
        input.meshTargets,
      ));
      if (retainedMeshTargets.length) composerMeshTargets.current[input.draftSessionId] = retainedMeshTargets;
      else delete composerMeshTargets.current[input.draftSessionId];
      const retainedDraft = {
        ...composerDraftSnapshot(composerDraftStore, input.draftSessionId),
        content: retainedContent,
      };
      const retainedDelegationDraft = composerDelegationDrafts.current[input.draftSessionId];
      const hasRetainedComposition = retainedDraft.content.length > 0
        || retainedDraft.attachments.length > 0
        || retainedDraft.workflowAttachments.length > 0
        || retainedDraft.annotations.length > 0
        || retainedMeshTargets.length > 0
        || retainedDelegationDraft !== undefined;
      const draftWriteTarget: Session = {
        id: `draft-${crypto.randomUUID()}`,
        draft: true,
        providerId: input.providerId,
        title: "New task",
        state: "idle",
        project: input.workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "Choose a folder",
        workingDirectory: input.workingDirectory,
        preview: "",
        updatedAt: new Date().toISOString(),
        model: input.modelId,
        effort: input.effort,
      };
      const retainedSession: Session | null = hasRetainedComposition ? draftWriteTarget : null;
      const shouldNavigate = selectedSessionIdRef.current === input.draftSessionId && viewRef.current === "workspace";
      const draftWriteTargetId = draftWriteTarget.id;
      composerDraftSessionAliases.current[input.draftSessionId] = draftWriteTargetId;
      if (retainedSession === null) {
        latentComposerDraftSessions.current[draftWriteTargetId] = {
          session: draftWriteTarget,
          scheduledSessionId: scheduled.id,
        };
      }
      setSnapshot((current) => {
        if (!current) return current;
        const timelines = { ...current.timelines };
        const draftTimeline = timelines[input.draftSessionId] ?? [];
        const providerTimeline = timelines[scheduled.id] ?? [];
        delete timelines[input.draftSessionId];
        timelines[scheduled.id] = providerTimeline.reduce((combined, item) => mergeTimeline(combined, item), [...draftTimeline]);
        if (retainedSession) timelines[retainedSession.id] = [];
        return {
          ...current,
          sessions: [
            ...(retainedSession ? [retainedSession] : []),
            scheduled,
            ...current.sessions.filter((item) => item.id !== input.draftSessionId && item.id !== scheduled.id && item.id !== retainedSession?.id),
          ],
          timelines,
        };
      });
      rebindComposerDraftState(composerDraftStore, input.draftSessionId, draftWriteTargetId, retainedDraft);
      delete composerDelegationDrafts.current[input.draftSessionId];
      delete composerDelegationDrafts.current[draftWriteTargetId];
      if (retainedDelegationDraft) composerDelegationDrafts.current[draftWriteTargetId] = retainedDelegationDraft;
      setTimelineWindows((current) => {
        const next = { ...current };
        delete next[input.draftSessionId];
        next[scheduled.id] = { nextCursor: null, revealStart: 0, revealAnchorKey: null, loadingOlder: false };
        if (retainedSession) next[retainedSession.id] = { nextCursor: null, revealStart: 0, revealAnchorKey: null, loadingOlder: false };
        return next;
      });
      if (shouldNavigate) {
        setSelectedSessionId(retainedSession?.id ?? scheduled.id);
        setView("workspace");
      }
      if (composerScheduleAttempts.current[input.draftSessionId] === record) {
        delete composerScheduleAttempts.current[input.draftSessionId];
        setComposerScheduleAttemptRevision((revision) => revision + 1);
      }
    })().catch((error: unknown) => {
      if (composerScheduleAttempts.current[input.draftSessionId] === record) {
        record.inFlight = null;
        record.failure = error instanceof Error ? error.message : String(error);
        setComposerScheduleAttemptRevision((revision) => revision + 1);
      }
      throw error;
    });
    record.inFlight = operation;
    setComposerScheduleAttemptRevision((revision) => revision + 1);
    return operation;
  }, [retainDraftScheduleAttempt]);

  useEffect(() => {
    const selected = selectedSessionId
      ? snapshot?.sessions.find((session) => session.id === selectedSessionId)
      : undefined;
    const selectedIsLocal = selected?.draft === true || selected?.schedule !== undefined;
    if (selectedSessionId && snapshot && !selectedIsLocal && timelineWindows[selectedSessionId] === undefined) {
      void openSession(selectedSessionId);
    }
  }, [openSession, selectedSessionId, snapshot, timelineWindows]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") { event.preventDefault(); startDraftTask(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") { event.preventDefault(); void refreshAll(); }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [refreshAll, startDraftTask]);

  const organizedSessions = useMemo(() => organizeSessions(snapshot?.sessions ?? [], preferences.taskOverrides), [preferences.taskOverrides, snapshot]);
  const selectedSession = useMemo(() => organizedSessions.find((session) => session.id === selectedSessionId && !isSideChatSession(session) && session.sessionKind !== "internal") ?? null, [organizedSessions, selectedSessionId]);
  const lastUsedProject = useRef<string | null>(null);
  useEffect(() => {
    const directory = selectedSession?.workingDirectory;
    const key = normalizeProjectDirectory(directory);
    if (!directory || key === lastUsedProject.current || !(preferences.savedProjectDirectories ?? []).some((candidate) => normalizeProjectDirectory(candidate) === key)) return;
    lastUsedProject.current = key;
    void rememberProject(directory).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
  }, [notify, preferences.savedProjectDirectories, rememberProject, selectedSession?.workingDirectory]);
  const selectedDraftScheduleAttempt = useMemo<DraftSessionScheduleAttemptState | null>(() => {
    if (!selectedSession?.draft) return null;
    const record = composerScheduleAttempts.current[selectedSession.id];
    return record ? { input: record.input, inFlight: record.inFlight !== null, failure: record.failure } : null;
  }, [composerScheduleAttemptRevision, selectedSession?.draft, selectedSession?.id]);
  const presentedView = presentedNavigationView(view, selectedSession !== null);
  useLayoutEffect(() => {
    if (view !== "workspace" || selectedSession !== null) return;
    if (selectedSessionId !== null) setSelectedSessionId(null);
    setListCollapsed(false);
    setView("dashboard");
  }, [selectedSession, selectedSessionId, view]);
  // Session state remains the provider/transport fact used by sending and
  // interruption controls. Task-list status is a separate, visible fact once
  // that task's transcript has been loaded.
  const presentedOrganizedSessions = useMemo(() => organizedSessions.map((session) => {
    if (stopPresentationSessionIds.has(session.id) || session.state === "idle" && session.interruptedAt !== undefined) {
      return session.state === "idle" ? session : { ...session, state: "idle" as const };
    }
    const timeline = snapshot?.timelines[session.id];
    if (timeline === undefined || hiddenTimelineDirtySessionIds.current.has(session.id)) return session;
    const state = presentedSessionState(session, timeline, workingBoundaryBySession.current.get(session.id));
    return state === session.state ? session : { ...session, state };
  }), [organizedSessions, snapshot?.timelines, stopPresentationSessionIds]);
  // A child that is open in the workspace is retained across provider refreshes,
  // but confirmed provenance still keeps it out of every top-level task surface.
  // Do not use parentSessionId here: provider-owned user chats may legitimately
  // have one and must remain visible unless their relationship is a sub-agent.
  const topLevelSessions = useMemo(() => presentedOrganizedSessions.filter((session) => session.relationshipKind !== "subagent"), [presentedOrganizedSessions]);
  const taskListSessions = useMemo(
    () => sessionsForTaskListMode(topLevelSessions, preferences.taskListMode),
    [preferences.taskListMode, topLevelSessions],
  );
  useEffect(() => {
    if (isBrowserPreview) return;
    const ids = [
      ...(selectedSessionId && !selectedSession?.draft && selectedSession?.schedule === undefined ? [selectedSessionId] : []),
      ...openSideChats.map((chat) => chat.id),
    ];
    watchedSessionIds.current = new Set(ids);
    for (const sessionId of ids) void watchSession(sessionId).catch(() => undefined);
    return () => {
      for (const sessionId of ids) void unwatchSession(sessionId).catch(() => undefined);
    };
  }, [openSideChats, selectedSession?.draft, selectedSession?.schedule, selectedSessionId]);
  const filteredSessions = useMemo(() => {
    if (!snapshot) return [];
    const lowered = normalizeUiSearchQuery(query);
    const availableProviders = new Set(snapshot.providers.filter((provider) => provider.detected).map((provider) => provider.id));
    return taskListSessions.filter((session) => {
      if (session.provisional || isSideChatSession(session) || session.sessionKind === "internal") return false;
      if (isHiddenByArchive(session, showArchived)) return false;
      if (!matchesProviderFilters(session.providerId, selectedProvider, availableProviders)) return false;
      if (stateFilter !== "all" && session.state !== stateFilter) return false;
      if (lowered && !normalizeUiSearchQuery(`${session.title} ${session.project} ${session.preview}`, 4_000).includes(lowered)) return false;
      return true;
    }).sort(compareOrganizedSessions);
  }, [query, selectedProvider, showArchived, snapshot, stateFilter, taskListSessions]);
  const archivedCount = useMemo(() => topLevelSessions.filter((session) => session.archived && !isSideChatSession(session) && session.sessionKind !== "internal").length, [topLevelSessions]);
  // Restoring the last archived task removes the Show archived control. Clear
  // its now-unreachable mode as well, otherwise the next archived task remains
  // visible and makes the Archive action look broken.
  useEffect(() => {
    if (archivedCount === 0 && showArchived) setShowArchived(false);
  }, [archivedCount, showArchived]);
  /** Everything the dashboard and command palette may surface: real tasks the user has not put away. */
  const activeSessions = useMemo(() => topLevelSessions.filter((session) => !session.provisional && !session.archived && !isSideChatSession(session) && session.sessionKind !== "internal"), [topLevelSessions]);
  const setTaskOverride = useCallback(async (sessionId: string, override: TaskOverride) => {
    if (isBrowserPreview) { setPreferences((current) => ({ ...current, taskOverrides: { ...current.taskOverrides, [sessionId]: { ...current.taskOverrides[sessionId], ...override } } })); return; }
    try { setPreferences(await window.tethoqDesktop.preferencesAction({ type: "set-task-override", sessionId, override })); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  }, [notify]);

  const openSettings = useCallback(() => {
    settingsOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setView((current) => {
      if (current !== "settings") settingsReturnView.current = current;
      return "settings";
    });
  }, []);
  const closeSettings = useCallback(() => {
    const next = settingsReturnView.current;
    const opener = settingsOpener.current;
    setView(next);
    if (next === "workspace") setListCollapsed(false);
    setSelectedWorkflowId(null);
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
      else if (next === "workspace") document.querySelector<HTMLTextAreaElement>("#composer-message")?.focus();
      else document.querySelector<HTMLElement>("[data-view-root]")?.focus();
    });
  }, []);
  const navigateToView = useCallback((next: View) => {
    if (next === "settings") {
      if (view === "settings") closeSettings();
      else openSettings();
      return;
    }
    setView(next);
    if (next === "workspace") setListCollapsed(false);
    setSelectedWorkflowId(null);
  }, [closeSettings, openSettings, view]);

  if (!snapshot) {
    return <div className="app-loading-shell" aria-hidden="true"><div/><div/><div/></div>;
  }

  const runtimeConnectionState = presentedRuntimeConnectionState({
    runtimeState: runtime.state,
    connected: snapshot.connected,
    loading: snapshot.loading === true,
  });

  const setProvider = (providerId: ProviderFilterSelection) => {
    setSelectedProvider(providerId);
  };

  return (
    <LocalOpenProvider state={localOpenState} onOpen={openLocalTarget}>
    <div className={`desktop-app ${listCollapsed ? "list-collapsed" : ""} ${narrow ? "narrow" : ""} ${sidebarResizing ? "sidebar-resizing" : ""}`} style={narrow ? undefined : { "--navigation-panel": `${navigationPanelWidth}px` } as CSSProperties} data-provider={Array.isArray(selectedProvider) ? selectedProvider.join(",") : selectedProvider} data-runtime-state={runtime.state}>
      <a className="skip-to-message" href="#composer-message">Skip to message</a>
      <TitleBar snapshot={snapshot} session={selectedSession} notify={notify} onRefreshProviderModels={hydrateProviderModel} directApiSetupRevision={directApiSetupRevision} />
      <div className="app-body">
        <Sidebar
          loading={snapshot.loading === true}
          {...(bootstrap?.app.version ? { appVersion: bootstrap.app.version } : {})}
          sessions={filteredSessions}
          allSessions={presentedOrganizedSessions}
          providers={snapshot.providers}
          selected={selectedSessionId}
          selectedProvider={selectedProvider}
          query={query}
          stateFilter={stateFilter}
          view={presentedView}
          connected={snapshot.connected}
          runtimeConnectionState={runtimeConnectionState}
          hostName={snapshot.hostName}
          onQuery={setQuery}
          onFilter={setStateFilter}
          onProvider={setProvider}
          onOpen={openSession}
          onOpenChild={(child) => {
            setSnapshot((current) => current ? { ...current, sessions: [child, ...current.sessions.filter((item) => item.id !== child.id)] } : current);
            void openSession(child.id, true);
          }}
          onBranch={(sessionId) => void branchSessionFromList(sessionId)}
          onOpenDirectory={openSessionDirectory}
          onView={navigateToView}
          onNewTask={() => startDraftTask()}
          onNewTaskInProject={startDraftTask}
          onNewProject={() => void startProjectTask()}
          taskListMode={preferences.taskListMode}
          savedProjectDirectories={preferences.savedProjectDirectories ?? []}
          onTaskListMode={(value) => {
            if (preferences.taskListMode === value) return;
            if (isBrowserPreview) { setPreferences((current) => ({ ...current, taskListMode: value })); return; }
            void window.tethoqDesktop.preferencesAction({ type: "set-task-list-mode", value }).then(setPreferences).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
          }}
          onCommandSearch={() => setPaletteOpen(true)}
          onMobileConnection={() => setMobileConnectionOpen(true)}
          showSideChats={showSideChats}
          activeSideChatIds={openSideChats.map((item) => item.id)}
          onShowSideChats={setShowSideChats}
          onCreateSideChat={(parentSessionId) => createSideChat(parentSessionId)}
          onOpenSideChat={openSideChatPanel}
          onSideChatAnchor={updateSideChatAnchor}
          showArchived={showArchived}
          archivedCount={archivedCount}
          onShowArchived={setShowArchived}
          onTaskOverride={(sessionId, override) => void setTaskOverride(sessionId, override)}
        />
        {!narrow ? <div
          className="navigation-resize-handle"
          role="separator"
          aria-label="Resize task list"
          aria-orientation="vertical"
          aria-valuemin={minimumNavigationPanelWidth}
          aria-valuemax={clampNavigationPanelWidth(maximumNavigationPanelWidth, window.innerWidth)}
          aria-valuenow={navigationPanelWidth}
          tabIndex={0}
          onPointerDown={beginSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
        /> : null}
        {presentedView === "dashboard" ? <Dashboard snapshot={snapshot} runtimeConnectionState={runtimeConnectionState} sessions={activeSessions} onOpen={openSession} onNew={startDraftTask} onProvider={setProvider} /> : null}
        {presentedView === "settings" ? <SettingsPage snapshot={snapshot} runtimeConnectionState={runtimeConnectionState} {...(bootstrap ? { bootstrap } : {})} recorder={recorder} workflows={workflows} selectedWorkflowId={selectedWorkflowId} onSelectWorkflow={setSelectedWorkflowId} setWorkflows={setWorkflows} onSaveWorkflow={() => setSaveWorkflowOpen(true)} onClose={closeSettings} onDirectApiSetup={() => setDirectApiSetupRevision((current) => current + 1)} preferences={preferences} onSetReasoningDisplay={async (value) => {
          if (!isBrowserPreview) {
            const next = await window.tethoqDesktop.preferencesAction({ type: "set-reasoning-display", value });
            setPreferences(next);
          }
          notify(value === "expanded" ? "Reasoning will open expanded" : "Reasoning will open compact");
        }} onSetDesktopBehavior={async (action) => {
          if (isBrowserPreview) { notify("Desktop behavior is available in the installed desktop app"); return; }
          try { setPreferences(await window.tethoqDesktop.preferencesAction(action)); }
          catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
        }} onSetAgentDefault={async (providerId, modelId, reasoningEffort) => {
          if (isBrowserPreview) {
            setPreferences((current) => ({ ...current, agentDefaults: { ...current.agentDefaults, [providerId]: { modelId, ...(reasoningEffort ? { reasoningEffort } : {}) } } }));
          } else {
            const next = await window.tethoqDesktop.preferencesAction({ type: "set-agent-default", providerId, modelId, ...(reasoningEffort ? { reasoningEffort } : {}) });
            setPreferences(next);
          }
          notify("Model default updated");
        }} onSetExperimentalFeatures={async (enabled) => {
          if (!isBrowserPreview) {
            const next = await window.tethoqDesktop.preferencesAction({ type: "set-experimental-features", enabled });
            setPreferences(next);
          }
          notify(enabled ? "Experimental features enabled" : "Experimental features disabled");
        }} onConnectorState={(connectors) => {
          const activeConnectorIds = new Set(connectors.loaded.map((connector) => connector.id));
          const previousConnectorIds = new Set(bootstrap?.connectors.loaded.map((connector) => connector.id) ?? []);
          setBootstrap((current) => current ? { ...current, connectors } : current);
          setSnapshot((current) => {
            if (!current) return current;
          const removed = [...previousConnectorIds].filter((providerId) => !activeConnectorIds.has(providerId));
          if (!removed.length) return current;
          const removedIds = new Set(removed);
          for (const providerId of removedIds) revokedConnectorIdsRef.current.add(providerId);
          const models = { ...current.models };
            for (const providerId of removedIds) delete models[providerId];
            return { ...current, providers: current.providers.filter((provider) => !removedIds.has(provider.id)), models };
          });
        }} notify={notify} onReconnect={async (id) => { await reconnectProvider(id); await refreshAll(false); notify(`${providerDisplayName(id, providerFor(snapshot.providers, id))} connection checked`); }} /> : null}
        {presentedView === "browser" ? <BrowserWorkspace state={browser} focusAddressToken={browserAddressFocusToken} notify={notify} onReturn={() => {
          setView(selectedSession ? "workspace" : "dashboard");
          requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#composer-message")?.focus());
        }} /> : null}
        {presentedView === "workspace" && selectedSession ?
          <Workspace
            snapshot={snapshot}
            session={selectedSession}
            workingBoundary={workingBoundaryBySession.current.get(selectedSession.id)}
            stopPresentationActive={stopPresentationSessionIds.has(selectedSession.id) || selectedSession.state === "idle" && selectedSession.interruptedAt !== undefined}
            onStopPresentation={setStopPresentation}
            onBack={() => setListCollapsed(false)}
            onBrowser={() => setView("browser")}
            onLinkOpen={(url) => void openTimelineLink(url)}
            onManageWorkflow={(id) => { setSelectedWorkflowId(id ?? null); openSettings(); }}
            onDraftSelectionChange={(selection) => {
              if (!selectedSession?.draft) return;
              updateDraftSelection(resolveComposerDraftWriteSessionId(selectedSession.id, true), selection);
            }}
            onCreateDraftSend={createDraftSend}
            onMaterializeDraft={materializeDraftForAction}
            pendingComposerAction={pendingComposerAction?.sessionId === selectedSession.id ? pendingComposerAction : null}
            onPendingComposerActionConsumed={(requestId) => setPendingComposerAction((current) => current?.requestId === requestId ? null : current)}
            onCreateDraftSchedule={createDraftSchedule}
            draftScheduleAttempt={selectedDraftScheduleAttempt}
            onRetainDraftScheduleAttempt={retainDraftScheduleAttempt}
            onDraftDirectory={() => { if (selectedSession?.draft) void chooseDraftDirectory(selectedSession.id, selectedSession.workingDirectory); }}
            initialDraft={composerDrafts.current[selectedSession?.id ?? ""] ?? ""}
            onDraftChange={(value) => {
              if (!selectedSession) return;
              const sessionId = resolveComposerDraftWriteSessionId(selectedSession.id, value.length > 0);
              if (value) composerDrafts.current[sessionId] = value;
              else delete composerDrafts.current[sessionId];
              publishAliasedComposerWrite(selectedSession.id, sessionId);
            }}
            initialAttachments={composerAttachments.current[selectedSession?.id ?? ""] ?? []}
            onAttachmentsChange={(attachments) => {
              if (!selectedSession) return;
              const sessionId = resolveComposerDraftWriteSessionId(selectedSession.id, attachments.length > 0);
              if (attachments.length) composerAttachments.current[sessionId] = attachments;
              else delete composerAttachments.current[sessionId];
              publishAliasedComposerWrite(selectedSession.id, sessionId);
            }}
            initialWorkflowAttachments={composerWorkflowAttachments.current[selectedSession?.id ?? ""] ?? []}
            onWorkflowAttachmentsChange={(attachments) => {
              if (!selectedSession) return;
              const sessionId = resolveComposerDraftWriteSessionId(selectedSession.id, attachments.length > 0);
              if (attachments.length) composerWorkflowAttachments.current[sessionId] = attachments;
              else delete composerWorkflowAttachments.current[sessionId];
              publishAliasedComposerWrite(selectedSession.id, sessionId);
            }}
            initialAnnotations={composerAnnotations.current[selectedSession?.id ?? ""] ?? emptyResponseAnnotations}
            onAnnotationsChange={(annotations) => {
              if (!selectedSession) return;
              const sessionId = resolveComposerDraftWriteSessionId(selectedSession.id, annotations.length > 0);
              if (annotations.length) composerAnnotations.current[sessionId] = annotations;
              else delete composerAnnotations.current[sessionId];
              publishAliasedComposerWrite(selectedSession.id, sessionId);
            }}
            initialMode={composerModes.current[selectedSession?.id ?? ""] ?? "queue"}
            onModeChange={(value) => {
              if (!selectedSession) return;
              const sessionId = resolveComposerDraftWriteSessionId(selectedSession.id, false);
              composerModes.current[sessionId] = value;
              publishAliasedComposerWrite(selectedSession.id, sessionId);
            }}
            initialMeshTargets={composerMeshTargets.current[selectedSession?.id ?? ""] ?? []}
            onMeshTargetsChange={(targets) => {
              if (!selectedSession) return;
              const sessionId = resolveComposerDraftWriteSessionId(selectedSession.id, targets.length > 0);
              if (targets.length) composerMeshTargets.current[sessionId] = targets;
              else delete composerMeshTargets.current[sessionId];
              publishAliasedComposerWrite(selectedSession.id, sessionId);
            }}
            initialDelegationDraft={composerDelegationDrafts.current[selectedSession?.id ?? ""]}
            onDelegationDraftChange={(draft) => {
              if (!selectedSession) return;
              const sessionId = resolveComposerDraftWriteSessionId(selectedSession.id, draft !== null);
              if (draft) composerDelegationDrafts.current[sessionId] = draft;
              else delete composerDelegationDrafts.current[sessionId];
              publishAliasedComposerWrite(selectedSession.id, sessionId);
            }}
            draftRestoreRevision={composerDraftRestoreRevisions[selectedSession?.id ?? ""] ?? 0}
            onRestoreFailedSubmission={(submitted) => selectedSession
              ? restoreFailedComposerSubmission(selectedSession.id, submitted)
              : submitted}
            onDerivedSession={(value, summary, draft, queuedNewTask) => {
              if (selectedSession) insertDerivedSession(selectedSession, value, summary, draft, undefined, queuedNewTask);
            }}
            onRetryQueuedNewTaskDelivery={(deliveryId) => {
              if (selectedSession) void deliverQueuedNewTask(selectedSession.id, deliveryId);
            }}
            onOpenChild={(child) => {
              setSnapshot((current) => current ? { ...current, sessions: [child, ...current.sessions.filter((item) => item.id !== child.id)] } : current);
              void openSession(child.id, true);
            }}
            onOpenParent={(parentSessionId) => void openSession(parentSessionId)}
            notify={notify}
            updateSnapshot={setSnapshot}
            onAttentionMutation={() => { attentionRevision.current += 1; }}
            onPrepareTurnResume={prepareResumedTurnBoundary}
            onHydrateProviderModels={hydrateProviderModel}
            timelineWindow={selectedSession ? timelineWindows[selectedSession.id] : undefined}
            onLoadOlder={selectedSession ? () => loadOlderHistory(selectedSession.id) : undefined}
            reasoningDisplay={preferences.reasoningDisplay}
            agentDefaults={preferences.agentDefaults}
            ears={preferences.ears}
            onEarsChange={async (value) => {
              if (isBrowserPreview) {
                setPreferences((current) => ({ ...current, ears: value }));
                return;
              }
              try { setPreferences(await window.tethoqDesktop.preferencesAction({ type: "set-ears", ears: value })); }
              catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
            }}
            experimental={preferences.experimentalFeatures}
            foreignSubagentsEnabled={preferences.experimentalFeatures}
            sessionForeignSubagents={preferences.foreignSubagentOverrides?.[selectedSession?.id ?? ""] ?? true}
            onSessionForeignSubagents={async (allowed) => {
              if (!selectedSession) return;
              if (isBrowserPreview) {
                setPreferences((current) => ({ ...current, foreignSubagentOverrides: { ...(current.foreignSubagentOverrides ?? {}), [selectedSession.id]: allowed } }));
                return;
              }
              try {
                setPreferences(await window.tethoqDesktop.preferencesAction({ type: "set-session-foreign-subagents", sessionId: selectedSession.id, allowed }));
              } catch (error) {
                notify(error instanceof Error ? error.message : String(error), "error");
              }
            }}
            onInstantSession={() => { if (selectedSession) setLiveSessionTarget(selectedSession); }}
            onCreateSideChat={createSideChat}
            onContextHandoff={createContextHandoff}
            queueRevision={queueRevision}
            queueingEnabled={queueingBySession[selectedSession?.id ?? ""] ?? true}
            onQueueingEnabledChange={(enabled) => { if (selectedSession) setQueueingBySession((current) => ({ ...current, [selectedSession.id]: enabled })); }}
            reportedCompaction={selectedSession ? compactionsBySession[selectedSession.id] : undefined}
            visionStatus={selectedSession ? visionBySession[selectedSession.id] : undefined}
            readVisionStatus={readVisionStatus}
          />
        : null}
      </div>
      {loadError ? <div className="startup-load-error"><ErrorBanner title="Tethoq could not finish loading" message={loadError} onRetry={() => void initialize()} /></div> : null}
      {openSideChats.length ? <SideChatLayer
        items={openSideChats}
        snapshot={snapshot}
        drafts={sideChatDrafts.current}
        sendingSessions={sideChatSendingSessions}
        notify={notify}
        onClose={hideSideChatPanel}
        onPromote={promoteSideChat}
        onDraftChange={updateSideChatDraft}
        onDiscardDraft={discardSideChatDraft}
        onSendStarted={beginSideChatSend}
        onSendSettled={finishSideChatSend}
        onSent={(sessionId, item, userRowIdsBeforeDelivery) => setSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [sessionId]: mergeAcceptedComposerRow(current.timelines[sessionId] ?? [], item, userRowIdsBeforeDelivery) }, sessions: replaceSession(current.sessions, sessionId, { preview: item.body, state: "working", updatedAt: item.timestamp }) } : current)}
        onSendFailed={rollbackSideChatSend}
      /> : null}
      {liveSessionTarget ? <LiveSessionPanel key={liveSessionTarget.id} session={liveSessionTarget} experimental={preferences.experimentalFeatures} notify={notify} onClose={() => setLiveSessionTarget(null)} /> : null}
      {saveWorkflowOpen && recorder.phase === "staged" ? <SaveWorkflowModal recorder={recorder} onClose={() => { setSaveWorkflowOpen(false); }} onDiscard={async () => { if (!isBrowserPreview) await window.tethoqDesktop.recorderAction({ type: "discard" }); setSaveWorkflowOpen(false); }} onSaved={(workflow) => { setWorkflows((current) => [workflow, ...current.filter((item) => item.id !== workflow.id)]); setSaveWorkflowOpen(false); notify("Workflow saved locally"); }} /> : null}
      {recorder.phase === "recording" ? <RecordingBar recorder={recorder} onStop={async () => { if (!isBrowserPreview) await window.tethoqDesktop.recorderAction({ type: "stop", reason: "user" }); }} /> : null}
      {paletteOpen ? <CommandPalette snapshot={snapshot} sessions={activeSessions} onClose={() => setPaletteOpen(false)} onAction={(action) => {
        setPaletteOpen(false);
        if (action === "new") startDraftTask();
        else if (action === "refresh") void refreshAll();
        else if (action === "settings") openSettings();
        else if (action.startsWith("settings:")) {
          const targetId = settingsTargetForAction(action);
          if (!targetId) return;
          openSettings();
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            document.getElementById(targetId)?.scrollIntoView({ block: "start" });
          }));
        }
        else if (action === "shortcuts") setShortcutsOpen(true);
        else if (action.startsWith("session:")) void openSession(action.slice(8));
        else if (action.startsWith("provider:")) setProvider(action.slice(9));
      }} /> : null}
      {shortcutsOpen ? <KeyboardShortcuts onClose={() => setShortcutsOpen(false)} /> : null}
      {mobileConnectionOpen ? <MobileConnectionDialog onClose={() => setMobileConnectionOpen(false)} /> : null}
      {toast ? <Toast message={toast.message} {...(toast.tone ? { tone: toast.tone } : {})} /> : null}
      {isBrowserPreview ? <span className="preview-badge">Browser preview</span> : null}
      <AppTooltipLayer />
    </div>
    </LocalOpenProvider>
  );
}

function SideChatLayer({ items, snapshot, drafts, sendingSessions, notify, onClose, onPromote, onDraftChange, onDiscardDraft, onSendStarted, onSendSettled, onSent, onSendFailed }: {
  items: readonly { id: string; anchor: SideChatAnchor }[];
  snapshot: DesktopSnapshot;
  drafts: Readonly<Record<string, SideChatDraft>>;
  sendingSessions: ReadonlySet<string>;
  notify: (message: string, tone?: "normal" | "error") => void;
  onClose: (sessionId: string) => void;
  onPromote: (sessionId: string) => Promise<void>;
  onDraftChange: (sessionId: string, update: SideChatDraftUpdate) => void;
  onDiscardDraft: (sessionId: string) => void;
  onSendStarted: (sessionId: string) => boolean;
  onSendSettled: (sessionId: string) => void;
  onSent: (sessionId: string, item: TimelineItem, userRowIdsBeforeDelivery: ReadonlySet<string>) => void;
  onSendFailed: (sessionId: string, presentationId: string, optimisticTimestamp: string, previousSession: Session, submittedDraft: SideChatDraft) => boolean;
}) {
  const viewportWidth = Math.max(640, window.innerWidth);
  const viewportHeight = Math.max(440, window.innerHeight);
  const width = Math.min(430, viewportWidth - 286);
  const left = Math.min(viewportWidth - width - 12, 266);
  const topInset = 66;
  const bottomInset = 12;
  const panelGap = 10;
  const availableHeight = viewportHeight - topInset - bottomInset;
  const panelHeight = items.length > 1
    ? Math.max(150, Math.min(315, Math.floor((availableHeight - panelGap) / 2)))
    : Math.min(350, availableHeight);
  const positions: number[] = Array.from({ length: items.length }, () => topInset);
  if (items.length === 1) {
    positions[0] = Math.max(topInset, Math.min(viewportHeight - bottomInset - panelHeight, items[0]!.anchor.y - 42));
  } else if (items.length > 1) {
    const ordered = items.map((item, index) => ({ item, index })).sort((leftItem, rightItem) => leftItem.item.anchor.y - rightItem.item.anchor.y);
    const groupHeight = panelHeight * 2 + panelGap;
    const desiredTop = ordered[0]!.item.anchor.y - 42;
    const groupTop = Math.max(topInset, Math.min(viewportHeight - bottomInset - groupHeight, desiredTop));
    positions[ordered[0]!.index] = groupTop;
    positions[ordered[1]!.index] = groupTop + panelHeight + panelGap;
  }
  return <div className="side-chat-layer" aria-label="Open side chats">
    {items.map((item, index) => {
      const storedSession = snapshot.sessions.find((candidate) => candidate.id === item.id && isSideChatSession(candidate));
      const parentSessionId = storedSession ? sideChatParentSessionId(storedSession) : undefined;
      const session = storedSession ? {
        ...storedSession,
        sessionKind: "side_chat" as const,
        ...(parentSessionId ? { parentSessionId } : {}),
      } : undefined;
      if (!session) return null;
      const provider = snapshot.providers.find((candidate) => candidate.id === session.providerId);
      return <div className="side-chat-floating" key={session.id} style={{ left, top: positions[index], width, height: panelHeight }}><SideChatPanel
        session={session}
        provider={provider}
        timeline={snapshot.timelines[session.id]}
        request={request}
        selectImages={selectImages}
        notify={notify}
        draft={drafts[session.id] ?? emptySideChatDraft}
        sending={sendingSessions.has(session.id)}
        onDraftChange={(update) => onDraftChange(session.id, update)}
        onDiscardDraft={() => onDiscardDraft(session.id)}
        onSendStarted={() => onSendStarted(session.id)}
        onSendSettled={() => onSendSettled(session.id)}
        onSent={(timelineItem, userRowIdsBeforeDelivery) => onSent(session.id, timelineItem, userRowIdsBeforeDelivery)}
        onSendFailed={(presentationId, optimisticTimestamp, submittedDraft) => onSendFailed(session.id, presentationId, optimisticTimestamp, session, submittedDraft)}
        onClose={() => onClose(session.id)}
        onPromote={async () => { try { await onPromote(session.id); } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); } }}
      /></div>;
    })}
  </div>;
}

type WalletKind = "user_api" | "harness" | "subscription";

interface WalletStatusView {
  providerId: string;
  kind: WalletKind;
  label: string;
  detail: string;
  endpointId?: string;
  endpointName?: string;
  currency: string;
  balance?: number;
  spent?: number;
  apiKeyConfigured: boolean;
  apiKeyLabel?: string;
  caution?: string;
  availableEndpoints?: readonly { id: string; name: string; apiKeyLabel?: string }[];
}

function walletStatus(value: unknown): WalletStatusView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.providerId !== "string" || (item.kind !== "user_api" && item.kind !== "harness" && item.kind !== "subscription") || typeof item.label !== "string" || typeof item.detail !== "string" || typeof item.currency !== "string" || typeof item.apiKeyConfigured !== "boolean") return null;
  return {
    providerId: item.providerId,
    kind: item.kind,
    label: item.label,
    detail: item.detail,
    currency: item.currency,
    apiKeyConfigured: item.apiKeyConfigured,
    ...(typeof item.endpointId === "string" ? { endpointId: item.endpointId } : {}),
    ...(typeof item.endpointName === "string" ? { endpointName: item.endpointName } : {}),
    ...(typeof item.balance === "number" && Number.isFinite(item.balance) ? { balance: item.balance } : {}),
    ...(typeof item.spent === "number" && Number.isFinite(item.spent) ? { spent: item.spent } : {}),
    ...(typeof item.apiKeyLabel === "string" ? { apiKeyLabel: item.apiKeyLabel } : {}),
    ...(typeof item.caution === "string" ? { caution: item.caution } : {}),
    ...(Array.isArray(item.availableEndpoints) ? {
      availableEndpoints: item.availableEndpoints.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const endpoint = value as Record<string, unknown>;
        if (typeof endpoint.id !== "string" || typeof endpoint.name !== "string") return [];
        return [{ id: endpoint.id, name: endpoint.name, ...(typeof endpoint.apiKeyLabel === "string" ? { apiKeyLabel: endpoint.apiKeyLabel } : {}) }];
      }),
    } : {}),
  };
}

function walletAmount(value: number | undefined, currency: string): string {
  if (value === undefined) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toFixed(2)} ${currency}`; }
}

export function WalletDropdown({ snapshot, session, notify, onRefreshProviderModels, directApiSetupRevision = 0 }: { snapshot: DesktopSnapshot; session: Session | null; notify: (message: string, tone?: "normal" | "error") => void; onRefreshProviderModels: (providerId: Session["providerId"]) => Promise<void>; directApiSetupRevision?: number }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"task" | "direct">("task");
  const [directViewTaskIdentity, setDirectViewTaskIdentity] = useState("");
  const [taskStatus, setTaskStatus] = useState<WalletStatusView | null>(null);
  const [taskStatusIdentity, setTaskStatusIdentity] = useState("");
  const [directStatus, setDirectStatus] = useState<WalletStatusView | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [directLoading, setDirectLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [endpointId, setEndpointId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [budget, setBudget] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customProtocol, setCustomProtocol] = useState<"responses" | "chat_completions">("responses");
  const [customModels, setCustomModels] = useState("");
  const [saveError, setSaveError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const taskRefreshSequence = useRef(0);
  const directRefreshSequence = useRef(0);
  const configureSequence = useRef(0);
  const configureInFlight = useRef(false);
  const handledDirectApiSetupRevision = useRef(0);
  const taskProviderId = session?.providerId ?? "";
  const taskModelId = session?.model && session.model !== "CLI default" ? session.model : undefined;
  const taskIdentity = session ? `${session.id}\u0000${taskProviderId}\u0000${taskModelId ?? ""}` : "";
  const taskIdentityRef = useRef(taskIdentity);
  taskIdentityRef.current = taskIdentity;
  const walletView = view === "direct" && directViewTaskIdentity === taskIdentity ? "direct" : "task";
  const currentTaskStatus = taskStatusIdentity === taskIdentity ? taskStatus : null;
  const directWalletStatus = directStatus ?? (currentTaskStatus?.providerId === "direct" ? currentTaskStatus : null);
  const status = walletView === "direct" ? directStatus : currentTaskStatus;
  const loading = walletView === "direct" ? directLoading : taskLoading;
  const endpoints = useMemo(() => {
    const values = [...(status?.availableEndpoints ?? []), ...Object.values(snapshot.models).flat().map((model) => {
      const encodedEndpoint = model.id.includes("::") ? model.id.split("::", 1)[0] : undefined;
      const id = model.endpointId ?? encodedEndpoint;
      return id ? { id, name: model.endpointName ?? id } : null;
    }).filter((entry): entry is { id: string; name: string } => entry !== null)];
    if (status?.endpointId && !values.some((entry) => entry.id === status.endpointId)) values.unshift({ id: status.endpointId, name: status.endpointName ?? status.endpointId });
    return [...new Map(values.map((entry) => [entry.id, entry])).values()];
  }, [snapshot.models, status?.availableEndpoints, status?.endpointId, status?.endpointName]);
  const refreshTask = useCallback(async () => {
    const sequence = ++taskRefreshSequence.current;
    if (!taskProviderId) {
      setTaskStatus(null);
      setTaskStatusIdentity(taskIdentity);
      setTaskLoading(false);
      return;
    }
    setTaskLoading(true);
    try {
      const result = await request("wallet.get", { providerId: taskProviderId, ...(taskModelId ? { modelId: taskModelId } : {}) });
      const next = walletStatus(result.wallet);
      if (!next) throw new Error("Wallet status is unavailable.");
      if (sequence !== taskRefreshSequence.current) return;
      setTaskStatus(next);
      setTaskStatusIdentity(taskIdentity);
      if (next.providerId === "direct") setEndpointId(next.endpointId ?? "");
    } catch {
      if (sequence === taskRefreshSequence.current) {
        setTaskStatus(null);
        setTaskStatusIdentity(taskIdentity);
      }
    } finally {
      if (sequence === taskRefreshSequence.current) setTaskLoading(false);
    }
  }, [taskIdentity, taskModelId, taskProviderId]);
  useEffect(() => {
    directRefreshSequence.current += 1;
    setDirectLoading(false);
    setView("task");
    setSaveError("");
    setTaskStatus(null);
    setTaskStatusIdentity(taskIdentity);
    void refreshTask();
    return () => { taskRefreshSequence.current += 1; };
  }, [refreshTask]);
  const selectDirectEndpoint = useCallback(async (nextEndpointId: string) => {
    if (!nextEndpointId) return;
    const sequence = ++directRefreshSequence.current;
    const previousStatus = walletView === "task" && currentTaskStatus?.providerId === "direct"
      ? currentTaskStatus
      : directStatus;
    const previousEndpointId = previousStatus?.endpointId;
    setView("direct");
    setDirectViewTaskIdentity(taskIdentity);
    setDirectStatus(previousStatus);
    setEndpointId(nextEndpointId);
    setDirectLoading(true);
    setSaveError("");
    try {
      const result = await request("wallet.get", { providerId: "direct", endpointId: nextEndpointId });
      const next = walletStatus(result.wallet);
      if (!next || next.providerId !== "direct" || next.endpointId !== nextEndpointId) throw new Error("Bridge did not return the selected endpoint wallet.");
      if (sequence !== directRefreshSequence.current) return;
      setDirectStatus(next);
    } catch {
      if (sequence !== directRefreshSequence.current) return;
      setEndpointId(previousEndpointId ?? nextEndpointId);
      setSaveError("That endpoint's saved-key status could not be checked. Your previous endpoint is still selected.");
    } finally {
      if (sequence === directRefreshSequence.current) setDirectLoading(false);
    }
  }, [currentTaskStatus, directStatus, taskIdentity, walletView]);
  const closeWallet = useCallback(() => {
    directRefreshSequence.current += 1;
    setDirectLoading(false);
    setOpen(false);
    setView("task");
    setDirectViewTaskIdentity("");
    setSaveError("");
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) closeWallet(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closeWallet(); };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [closeWallet, open]);
  const configure = async (payload: Record<string, string | number | boolean | readonly string[] | Record<string, unknown>>) => {
    if (configureInFlight.current) return;
    configureInFlight.current = true;
    const sequence = ++configureSequence.current;
    const configuredTaskIdentity = taskIdentity;
    const targetEndpointId = endpointId || directWalletStatus?.endpointId || "";
    const savesApiKey = typeof payload.apiKey === "string";
    setSaving(true);
    setSaveError("");
    try {
      const result = await request("wallet.configure", { providerId: "direct", endpointId: targetEndpointId, ...payload } as unknown as import("../../../../../packages/protocol/src/index").JsonObject);
      const next = walletStatus(result.wallet);
      if (!next || next.providerId !== "direct" || (targetEndpointId && next.endpointId !== targetEndpointId)) throw new Error("invalid wallet");
      if (savesApiKey && !next.apiKeyConfigured) throw new Error("API key was not accepted");
      if (sequence !== configureSequence.current || configuredTaskIdentity !== taskIdentityRef.current) return;
      directRefreshSequence.current += 1;
      setDirectLoading(false);
      setDirectStatus(next);
      setEndpointId(next.endpointId ?? targetEndpointId);
      if (currentTaskStatus?.providerId === "direct" && currentTaskStatus.endpointId === next.endpointId) {
        taskRefreshSequence.current += 1;
        setTaskLoading(false);
        setTaskStatus(next);
        setTaskStatusIdentity(taskIdentity);
      }
      if (savesApiKey || payload.clearApiKey === true) setApiKey("");
      const directProvider = snapshot.providers.find((provider) => provider.id === "direct");
      if (directProvider) void onRefreshProviderModels(directProvider.id).catch(() => undefined);
    } catch {
      if (sequence !== configureSequence.current || configuredTaskIdentity !== taskIdentityRef.current) return;
      try {
        const result = await request("wallet.get", { providerId: "direct", endpointId: targetEndpointId });
        const authoritative = walletStatus(result.wallet);
        if (authoritative?.providerId === "direct" && (!targetEndpointId || authoritative.endpointId === targetEndpointId) && sequence === configureSequence.current && configuredTaskIdentity === taskIdentityRef.current) {
          directRefreshSequence.current += 1;
          setDirectLoading(false);
          setDirectStatus(authoritative);
          setEndpointId(authoritative.endpointId ?? targetEndpointId);
          if (currentTaskStatus?.providerId === "direct" && currentTaskStatus.endpointId === authoritative.endpointId) {
            taskRefreshSequence.current += 1;
            setTaskLoading(false);
            setTaskStatus(authoritative);
            setTaskStatusIdentity(taskIdentity);
          }
        }
      } catch { /* Keep the last confirmed state when even recovery is unavailable. */ }
      if (sequence === configureSequence.current) setSaveError(savesApiKey ? "That API key could not be verified. Check it and try again." : "Wallet settings could not be saved. Your previous settings are unchanged.");
    } finally {
      if (sequence === configureSequence.current) {
        configureInFlight.current = false;
        setSaving(false);
      }
    }
  };
  const showDirectWallet = useCallback(async () => {
    const sequence = ++directRefreshSequence.current;
    const requestedEndpointId = directWalletStatus?.endpointId ?? (currentTaskStatus?.providerId === "direct" ? currentTaskStatus.endpointId : undefined);
    setView("direct");
    setDirectViewTaskIdentity(taskIdentity);
    setDirectLoading(true);
    setSaveError("");
    try {
      const result = await request("wallet.get", { providerId: "direct", ...(requestedEndpointId ? { endpointId: requestedEndpointId } : {}) });
      const next = walletStatus(result.wallet);
      if (!next || next.providerId !== "direct") throw new Error("Direct API settings are unavailable.");
      if (sequence !== directRefreshSequence.current) return;
      setDirectStatus(next);
      setEndpointId(next.endpointId ?? endpoints[0]?.id ?? "");
    } catch {
      if (sequence !== directRefreshSequence.current) return;
      setSaveError("Direct API settings are unavailable right now. Try again from this panel.");
    } finally {
      if (sequence === directRefreshSequence.current) setDirectLoading(false);
    }
  }, [currentTaskStatus, directWalletStatus?.endpointId, endpoints, taskIdentity]);
  useEffect(() => {
    if (directApiSetupRevision <= handledDirectApiSetupRevision.current) return;
    handledDirectApiSetupRevision.current = directApiSetupRevision;
    setOpen(true);
    void showDirectWallet();
  }, [directApiSetupRevision, showDirectWallet]);
  const updateBudget = (mode: "setBalance" | "addBalance") => {
    const amount = Number(budget);
    if (!Number.isFinite(amount) || amount < 0) { notify("Enter a non-negative local spend budget.", "error"); return; }
    void configure({ [mode]: amount });
    setBudget("");
  };
  const saveCustomEndpoint = () => {
    const name = customName.trim();
    let parsed: URL;
    try { parsed = new URL(customBaseUrl.trim()); }
    catch { notify("Enter a valid endpoint URL.", "error"); return; }
    const localHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
    if (parsed.protocol !== "https:" && !localHttp) { notify("Custom endpoints must use HTTPS; local HTTP is allowed only for localhost.", "error"); return; }
    if (!name) { notify("Enter a custom endpoint name.", "error"); return; }
    const id = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48) || "endpoint"}`;
    setEndpointId(id);
    const modelIds = customModels.split(",").map((value) => value.trim()).filter(Boolean);
    void configure({ endpointId: id, customEndpoint: { id, name, baseUrl: parsed.toString(), protocol: customProtocol, ...(modelIds.length ? { modelIds } : {}) } });
  };
  const taskKind = currentTaskStatus?.kind ?? "subscription";
  const taskLabel = taskLoading && !currentTaskStatus && session ? "Wallet…" : currentTaskStatus?.label ?? "Billing settings";
  const panelTitle = walletView === "direct" ? "Direct API configuration" : status?.label ?? (session ? "Billing source unavailable" : "Billing settings");
  const panelDetail = status?.detail ?? (walletView === "direct"
    ? "Choose a Direct API endpoint to configure its key and optional local spend cap."
    : session ? "The local bridge did not report a billing source for this task." : "Select a task to see how it is funded.");
  return <div className={`wallet-dropdown wallet-${taskKind} ${open ? "open" : ""}`} ref={root}>
    <button className={`wallet-trigger ${currentTaskStatus?.kind === "user_api" && !currentTaskStatus.apiKeyConfigured ? "wallet-trigger-caution" : ""}`} data-tooltip={taskLabel} type="button" aria-label={`${taskLabel}. Open wallet`} aria-haspopup="dialog" aria-expanded={open} onClick={() => {
      if (open) { closeWallet(); return; }
      setView("task");
      setDirectViewTaskIdentity("");
      setSaveError("");
      setOpen(true);
      void refreshTask();
    }}><WalletIcon /></button>
    {open ? <section className="wallet-popover" role="dialog" aria-label="Wallet and billing source">
      <header><span className="wallet-mark"><WalletIcon /></span><span><strong>{panelTitle}</strong><small>{panelDetail}</small></span></header>
      {status ? <><dl className="wallet-stats"><div><dt>Route</dt><dd>{status.kind === "user_api" ? "Direct API" : status.kind === "harness" ? "Agent-managed" : "Subscription"}</dd></div>{status.balance !== undefined ? <div><dt>Spend cap</dt><dd>{status.balance > 0 ? `stops at ${walletAmount(status.balance, status.currency)}` : "No cap set"}</dd></div> : null}{status.spent !== undefined ? <div><dt>Observed spend</dt><dd>{walletAmount(status.spent, status.currency)}</dd></div> : null}{status.kind === "user_api" ? <div><dt>API key</dt><dd>{status.apiKeyConfigured ? "Saved" : "Not added"}</dd></div> : null}</dl>{status.caution || (status.kind === "user_api" && !status.apiKeyConfigured) ? <p className="wallet-caution"><AlertIcon />{status.caution ?? "Add your API key before using a direct model. The key stays in the local Bridge and is never displayed again."}</p> : null}</> : null}
      {walletView === "direct" ? <button className="wallet-route-switch" type="button" disabled={loading} onClick={() => {
        directRefreshSequence.current += 1;
        setDirectLoading(false);
        setView("task");
        setDirectViewTaskIdentity("");
        setSaveError("");
        if (currentTaskStatus?.providerId === "direct") setEndpointId(currentTaskStatus.endpointId ?? "");
        void refreshTask();
      }}><ArrowLeftIcon />Back to this task's billing</button> : currentTaskStatus?.providerId !== "direct" ? <button className="wallet-route-switch" type="button" disabled={loading} onClick={() => void showDirectWallet()}><WalletIcon />Configure Direct API</button> : null}
      {status?.kind === "user_api" ? <div className="wallet-direct-settings">
        <label><span>Endpoint</span><select value={endpointId} disabled={saving || loading} onChange={(event) => void selectDirectEndpoint(event.target.value)}>{endpoints.length ? endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>) : <option value={status.endpointId ?? ""}>{status.endpointName ?? "Direct endpoint"}</option>}</select>{loading && endpointId !== status.endpointId ? <small className="wallet-endpoint-checking">Checking this endpoint's API-key status...</small> : null}</label>
        <label><span>API key</span><input type="password" autoComplete="new-password" value={apiKey} disabled={saving || loading} onChange={(event) => { setApiKey(event.target.value); setSaveError(""); }} placeholder={status.apiKeyConfigured ? "Stored securely · enter only to replace" : "Paste API key"}/></label>
        <div className="wallet-key-actions"><button type="button" disabled={saving || loading || !endpointId || !apiKey.trim()} onClick={() => void configure({ apiKey: apiKey.trim(), validateApiKey: true })}>Save key</button><button type="button" disabled={saving || loading || !status.apiKeyConfigured} onClick={() => void configure({ clearApiKey: true })}>Clear key</button></div>
        {saveError ? <p className="wallet-inline-error" role="alert">{saveError}</p> : null}
        <div className="wallet-budget"><span><strong>Spend cap</strong><small>A local ceiling Tethoq stops you at. It is not credit, and no money is held here.</small></span><input type="number" min="0" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="0.00" aria-label="Spend cap amount"/><button type="button" disabled={saving || !budget} onClick={() => updateBudget("setBalance")}>Set cap</button><button type="button" disabled={saving || !budget} onClick={() => updateBudget("addBalance")}>Raise</button><button type="button" disabled={saving || status.balance === undefined} onClick={() => { setBudget(""); void configure({ clearBalance: true }); }}>Clear</button></div>
        <button className="wallet-advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced((current) => !current)}><ChevronRightIcon className={advanced ? "expanded" : ""}/>Advanced custom endpoint</button>
        {advanced ? <div className="wallet-advanced"><label><span>Name</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="My endpoint"/></label><label><span>Base URL</span><input inputMode="url" value={customBaseUrl} onChange={(event) => setCustomBaseUrl(event.target.value)} placeholder="https://api.example.com/v1"/></label><label><span>Protocol</span><select value={customProtocol} onChange={(event) => setCustomProtocol(event.target.value as "responses" | "chat_completions")}><option value="responses">Responses API</option><option value="chat_completions">OpenAI-compatible Chat Completions</option></select></label><label><span>Model IDs <small>optional, comma-separated</small></span><input value={customModels} onChange={(event) => setCustomModels(event.target.value)} placeholder="model-a, model-b"/></label><button type="button" disabled={saving || !customName.trim() || !customBaseUrl.trim()} onClick={saveCustomEndpoint}>Save custom endpoint</button></div> : null}
      </div> : null}
      {status?.kind === "user_api" ? <footer><LockIcon />API keys stay in the local Bridge and are never shown again.</footer> : null}
    </section> : null}
  </div>;
}

function TitleBar({ snapshot, session, notify, onRefreshProviderModels, directApiSetupRevision }: { snapshot: DesktopSnapshot; session: Session | null; notify: (message: string, tone?: "normal" | "error") => void; onRefreshProviderModels: (providerId: Session["providerId"]) => Promise<void>; directApiSetupRevision: number }) {
  return <header className="titlebar">
    <div className="titlebar-drag brand-lockup"><span className="brand-mark"><img src={tethoqIconUrl} alt="" /></span><strong>Tethoq</strong><span>Desktop</span></div>
    <div className="titlebar-tools"><WalletDropdown snapshot={snapshot} session={session} notify={notify} onRefreshProviderModels={onRefreshProviderModels} directApiSetupRevision={directApiSetupRevision}/></div>
  </header>;
}

async function browserAction(action: Parameters<Window["tethoqDesktop"]["browserAction"]>[0], update: (value: BrowserWorkspaceState) => void): Promise<void> {
  if (isBrowserPreview) return;
  update(await window.tethoqDesktop.browserAction(action));
}

const browserPrivacyNoticeDismissedKey = "tethoq.browser-privacy-notice-dismissed.v1";

function browserPrivacyNoticeWasDismissed(): boolean {
  try { return window.localStorage.getItem(browserPrivacyNoticeDismissedKey) === "true"; }
  catch { return false; }
}

function BrowserWorkspace({ state, focusAddressToken, notify, onReturn }: { state: BrowserWorkspaceState | null; focusAddressToken: number; notify: (message: string, tone?: "normal" | "error") => void; onReturn: () => void }) {
  const [current, setCurrent] = useState(state);
  const [address, setAddress] = useState("");
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloadsOpening, setDownloadsOpening] = useState(false);
  const [browserOverlayPhase, setBrowserOverlayPhase] = useState<"native" | "preparing" | "prepared" | "renderer">("native");
  const [privacyNoticeVisible, setPrivacyNoticeVisible] = useState(() => !browserPrivacyNoticeWasDismissed());
  const [browserFreezeFrame, setBrowserFreezeFrame] = useState<string | null>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const downloadsButton = useRef<HTMLButtonElement>(null);
  const downloadsPopover = useRef<HTMLDivElement>(null);
  const downloadsCloseButton = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const overlayTransitionGeneration = useRef(0);
  useEffect(() => setCurrent(state), [state]);
  const active = current?.tabs.find((tab) => tab.id === current.activeTabId);
  useEffect(() => setAddress(active?.url ?? ""), [active?.id, active?.url]);
  useEffect(() => {
    if (focusAddressToken === 0) return;
    addressInput.current?.focus();
    addressInput.current?.select();
  }, [focusAddressToken]);
  useEffect(() => {
    if (!viewport.current || isBrowserPreview) return;
    const update = () => {
      const rect = viewport.current?.getBoundingClientRect();
      if (rect) void browserAction({ type: "set-bounds", bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } }, setCurrent);
    };
    const observer = new ResizeObserver(update);
    observer.observe(viewport.current);
    update();
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  const act = async (action: Parameters<Window["tethoqDesktop"]["browserAction"]>[0]) => {
    try { await browserAction(action, setCurrent); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const tabActionFromKeyboard = (
    event: ReactKeyboardEvent<HTMLElement>,
    action: Parameters<Window["tethoqDesktop"]["browserAction"]>[0],
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    void act(action);
  };
  const closeDownloads = useCallback((restoreFocus = true) => {
    const generation = ++overlayTransitionGeneration.current;
    setDownloadsOpen(false);
    setDownloadsOpening(false);
    if (restoreFocus) downloadsButton.current?.focus();
    if (isBrowserPreview) {
      setBrowserOverlayPhase("native");
      setBrowserFreezeFrame(null);
      return;
    }
    // The native view must be restored before its painted surrogate is removed.
    // Keeping the frame until this acknowledgement prevents the inverse white
    // flash when the download panel closes.
    void window.tethoqDesktop.browserAction({ type: "close-overlay" }).then(async (result) => {
      if (overlayTransitionGeneration.current !== generation) return;
      setCurrent(result);
      setBrowserOverlayPhase("native");
      // The native view has been scheduled above the renderer. Keep its
      // surrogate for two paints so the compositor never exposes the window
      // background while Chromium returns.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (overlayTransitionGeneration.current !== generation) return;
      setBrowserFreezeFrame(null);
    }).catch(() => undefined);
  }, []);
  const openDownloads = useCallback(async () => {
    if (isBrowserPreview) {
      setBrowserOverlayPhase("renderer");
      setDownloadsOpen(true);
      return;
    }
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return;
    const generation = ++overlayTransitionGeneration.current;
    setDownloadsOpening(true);
    setBrowserOverlayPhase("preparing");
    try {
      const prepared = await window.tethoqDesktop.browserAction({ type: "prepare-overlay", bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
      if (overlayTransitionGeneration.current !== generation) return;
      const snapshot = prepared.overlaySnapshotDataUrl;
      const token = prepared.overlayToken;
      if (!snapshot || token === undefined) throw new Error("The browser overlay frame was unavailable");
      const image = new Image();
      image.src = snapshot;
      await image.decode();
      if (overlayTransitionGeneration.current !== generation) return;
      // Mount the decoded frame and panel together, then give Chromium two
      // animation frames to paint them behind the still-visible native page.
      flushSync(() => {
        setBrowserFreezeFrame(snapshot);
        setDownloadsOpen(true);
        setBrowserOverlayPhase("prepared");
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (overlayTransitionGeneration.current !== generation) return;
      const opened = await window.tethoqDesktop.browserAction({ type: "open-overlay", token });
      if (overlayTransitionGeneration.current !== generation) return;
      setCurrent(opened);
      setDownloadsOpening(false);
      setBrowserOverlayPhase("renderer");
    } catch (error) {
      if (overlayTransitionGeneration.current !== generation) return;
      closeDownloads();
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [closeDownloads, notify]);
  useEffect(() => {
    if (!downloadsOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || downloadsButton.current?.contains(target) || downloadsPopover.current?.contains(target)) return;
      closeDownloads();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeDownloads();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    downloadsCloseButton.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeDownloads, downloadsOpen]);
  const dismissPrivacyNotice = () => {
    setPrivacyNoticeVisible(false);
    try { window.localStorage.setItem(browserPrivacyNoticeDismissedKey, "true"); }
    catch { /* Dismissal still applies for this mounted browser workspace. */ }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); if (active && address.trim()) void act({ type: "navigate", tabId: active.id, input: address.trim() }); };
  useEffect(() => () => {
    ++overlayTransitionGeneration.current;
    if (!isBrowserPreview) void window.tethoqDesktop.browserAction({ type: "close-overlay" });
  }, []);
  return <main className="browser-page" data-browser-overlay-phase={browserOverlayPhase}>
    <button className="browser-session-return" aria-label="Return to task" title="Return to task" onClick={onReturn}><ArrowLeftIcon /></button>
    <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
      {current?.tabs.map((tab) => <button type="button" role="tab" aria-selected={tab.id === current.activeTabId} key={tab.id} onClick={() => void act({ type: "activate-tab", tabId: tab.id })}>
        <span>{tab.loading ? <span className="spinner" /> : tab.faviconUrl ? <img src={tab.faviconUrl} alt="" /> : <GlobeIcon />}</span>
        <strong>{tab.title || "New tab"}</strong>
        <span className={`browser-tab-actions ${tab.muted || tab.audible ? "persistent" : ""}`}>
          <span className="browser-tab-action" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); void act({ type: "set-muted", tabId: tab.id, muted: !tab.muted }); }} onKeyDown={(event) => tabActionFromKeyboard(event, { type: "set-muted", tabId: tab.id, muted: !tab.muted })} title={tab.muted ? "Unmute tab" : "Mute tab"} aria-label={`${tab.muted ? "Unmute" : "Mute"} ${tab.title || "tab"}`}>{tab.muted ? <MutedIcon /> : <VolumeIcon />}</span>
          <span className="browser-tab-action" role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); void act({ type: "close-tab", tabId: tab.id }); }} onKeyDown={(event) => tabActionFromKeyboard(event, { type: "close-tab", tabId: tab.id })} aria-label={`Close ${tab.title || "tab"}`}><XIcon /></span>
        </span>
      </button>)}
      <IconButton label="New browser tab" onClick={() => void act({ type: "create-tab", activate: true })}><PlusIcon /></IconButton>
    </div>
    <div className="browser-toolbar">
      <IconButton label="Back" disabled={!active?.canGoBack} onClick={() => active && void act({ type: "back", tabId: active.id })}><ArrowLeftIcon /></IconButton>
      <IconButton label="Forward" disabled={!active?.canGoForward} onClick={() => active && void act({ type: "forward", tabId: active.id })}><ChevronRightIcon /></IconButton>
      <IconButton label={active?.loading ? "Stop loading" : "Reload"} onClick={() => active && void act({ type: active.loading ? "stop" : "reload", tabId: active.id })}>{active?.loading ? <XIcon /> : <RefreshIcon className="refresh-icon" />}</IconButton>
      <IconButton label="Home" onClick={() => active && void act({ type: "navigate", tabId: active.id, input: "https://www.google.com/" })}><HomeIcon /></IconButton>
      <form className="browser-address" onSubmit={submit}><LockIcon /><input ref={addressInput} aria-label="Address and search" value={address} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.currentTarget.select()} spellCheck={false}/>{active?.url ? <span>{active.url.startsWith("https://") ? "Secure" : "Web"}</span> : null}</form>
      <button ref={downloadsButton} className={`browser-downloads ${downloadsOpen || downloadsOpening ? "active" : ""}`} type="button" aria-label="Downloads" aria-haspopup="dialog" aria-expanded={downloadsOpen} aria-busy={downloadsOpening} aria-controls="browser-download-panel" disabled={!isBrowserPreview && current?.visible !== true} onClick={() => downloadsOpen || downloadsOpening ? closeDownloads() : void openDownloads()}><DownloadIcon />{current?.downloads.some((item) => item.state === "progressing") ? <span>{current.downloads.filter((item) => item.state === "progressing").length}</span> : null}</button>
    </div>
    <div className="browser-chrome-panels">
      {privacyNoticeVisible ? <div className="browser-privacy-note"><LockIcon /><span><strong>Your optional sign-ins stay in this app-only Chromium profile.</strong> Tethoq never imports or automatically signs into your Chrome profile.</span><button type="button" onClick={() => void act({ type: "clear-profile" })}>{current?.profile.clearing ? "Clearing…" : "Clear profile data"}</button><button className="browser-privacy-note-dismiss" type="button" aria-label="Dismiss browser profile notice" title="Dismiss" onClick={dismissPrivacyNotice}><XIcon /></button></div> : null}
      {current?.pendingPermissions[0] ? <div className="browser-permission"><ShieldIcon /><span><strong>{current.pendingPermissions[0].origin}</strong> requests {current.pendingPermissions[0].permission} access.</span><Button onClick={() => void act({ type: "permission", requestId: current.pendingPermissions[0]!.id, allow: false })}>Block</Button><Button variant="primary" onClick={() => void act({ type: "permission", requestId: current.pendingPermissions[0]!.id, allow: true, rememberForSession: true })}>Allow this session</Button></div> : null}
    </div>
    <div className="browser-viewport" ref={viewport}>{browserFreezeFrame ? <img className="browser-freeze-frame" src={browserFreezeFrame} alt="" /> : isBrowserPreview ? <div className="browser-preview-empty"><BrowserIcon /><h2>Chromium lives here</h2><p>The native web surface is isolated from the coding UI and appears in the desktop build.</p></div> : null}</div>
    {downloadsOpen ? <div className="browser-download-popover" ref={downloadsPopover} role="dialog" aria-modal="false" aria-label="Downloads"><BrowserDownloads downloads={current?.downloads ?? []} onAction={act} onClose={closeDownloads} closeButtonRef={downloadsCloseButton} /></div> : null}
    {active?.crashed || active?.error ? <div className="browser-error"><AlertIcon /><strong>{active.error ?? "This tab stopped responding"}</strong><Button onClick={() => void act({ type: "reload", tabId: active.id })}>Reload tab</Button></div> : null}
  </main>;
}

function browserBytes(bytes: number): string {
  if (bytes < 1_024) return `${Math.max(0, bytes)} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

function BrowserDownloads({ downloads, onAction, onClose, closeButtonRef }: { downloads: readonly BrowserDownloadState[]; onAction: (action: Parameters<Window["tethoqDesktop"]["browserAction"]>[0]) => Promise<void>; onClose: () => void; closeButtonRef: RefObject<HTMLButtonElement | null> }) {
  const items = [...downloads].reverse();
  return <section className="browser-download-panel" id="browser-download-panel" aria-label="Browser downloads">
    <header><span><DownloadIcon /><strong>Downloads</strong><small>{downloads.length ? `${downloads.length} recent` : "App-only history"}</small></span><div>{downloads.some((item) => item.state !== "progressing") ? <button onClick={() => void onAction({ type: "clear-download-history" })}>Clear finished</button> : null}<button ref={closeButtonRef} className="icon-button" type="button" aria-label="Close downloads" title="Close downloads" onClick={onClose}><XIcon /></button></div></header>
    <div className="browser-download-list">
      {items.length ? items.map((download) => {
        const progress = download.totalBytes > 0 ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100)) : null;
        const activeDownload = download.state === "progressing";
        const stateLabel = activeDownload ? download.paused ? "Paused" : "Downloading" : download.state === "completed" ? "Complete" : download.state === "cancelled" ? "Cancelled" : "Interrupted";
        return <article key={download.id}>
          <DownloadIcon />
          <div className="browser-download-copy"><strong title={download.filename}>{download.filename}</strong><span aria-live="polite"><small>{stateLabel}</small><small>{browserBytes(download.receivedBytes)}{download.totalBytes ? ` of ${browserBytes(download.totalBytes)}` : ""}</small>{activeDownload && download.bytesPerSecond > 0 ? <small>{browserBytes(download.bytesPerSecond)}/s</small> : null}</span>{progress !== null ? <div className="browser-download-progress" role="progressbar" aria-label={`${download.filename} download progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div> : null}</div>
          <div className="browser-download-actions">{activeDownload ? <><button onClick={() => void onAction({ type: "download", id: download.id, action: download.paused ? "resume" : "pause" })}>{download.paused ? "Resume" : "Pause"}</button><button onClick={() => void onAction({ type: "download", id: download.id, action: "cancel" })}>Cancel</button></> : download.state === "completed" && download.savePath ? <button onClick={() => { if (!isBrowserPreview) void window.tethoqDesktop.revealPath(download.savePath!); }}>Open</button> : null}</div>
        </article>;
      }) : <div className="browser-download-empty"><DownloadIcon /><span><strong>No downloads yet</strong><small>Files downloaded in this Chromium workspace will appear here.</small></span></div>}
    </div>
  </section>;
}

function recordingDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function RecordingBar({ recorder, onStop }: { recorder: RecorderState; onStop: () => Promise<void> }) {
  const active = recorder.active;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (active === undefined) return;
    let timer: number | undefined;
    const update = () => setNow(Date.now());
    const start = () => {
      update();
      if (timer === undefined) timer = window.setInterval(update, 1_000);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => document.hidden ? stop() : start();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active?.id]);
  const elapsed = active ? now - active.startedWallTimeMs : 0;
  return <div className="recording-bar" role="status"><span className="recording-live"><i /><strong>Recording workflow</strong></span><time>{recordingDuration(elapsed)}</time><span><MouseIcon />{active?.counts.events ?? 0} events</span><span><ScreenshotIcon />{active?.counts.screenshots ?? 0} captures</span><small>Everything stops with <kbd>{active?.panicShortcut ?? "Ctrl+Shift+F12"}</kbd></small><Button variant="danger" onClick={() => void onStop()}><StopIcon /> Stop</Button></div>;
}

function SaveWorkflowModal({ recorder, onClose, onDiscard, onSaved }: { recorder: RecorderState; onClose: () => void; onDiscard: () => Promise<void>; onSaved: (workflow: WorkflowDescriptor) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const staged = recorder.staged;
  return <Modal title="Save recorded workflow" eyebrow="Everything is still local" onClose={onClose}><form className="save-workflow-form" onSubmit={async (event) => { event.preventDefault(); if (!name.trim()) return; setBusy(true); try { if (isBrowserPreview) return; const result = await window.tethoqDesktop.recorderAction({ type: "finalize", name: name.trim() }); if (result && !Array.isArray(result) && "id" in result) onSaved(result as WorkflowDescriptor); } finally { setBusy(false); } }}><div className="workflow-capture-summary"><WorkflowIcon /><span><strong>{staged?.summary.eventCount ?? 0} timed events</strong><small>{staged?.summary.screenshotCount ?? 0} screenshots · {recordingDuration(staged?.durationMs ?? 0)} total</small></span></div><label className="form-label"><span>Workflow name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Import a folder into CapCut" maxLength={120}/></label><p className="save-warning"><ShieldIcon />Screen content and key codes may contain sensitive information. Nothing is uploaded automatically.</p><div className="modal-actions"><Button type="button" variant="danger" onClick={() => void onDiscard()}><TrashIcon /> Discard</Button><span className="modal-spacer"/><Button type="button" onClick={onClose}>Keep unsaved</Button><Button type="submit" variant="primary" disabled={!name.trim() || busy}>{busy ? <span className="spinner" /> : <CheckIcon />} Save locally</Button></div></form></Modal>;
}

function childStateLabel(state: Session["state"]): string {
  if (state === "working") return "Working";
  if (state === "needs_approval") return "Needs approval";
  if (state === "needs_input") return "Needs input";
  if (state === "offline") return "Offline";
  if (state === "failed") return "Stopped with an issue";
  return state === "completed" ? "Completed" : "Idle";
}

function taskDetailsVisionTargets(value: unknown): readonly VisionProxyTarget[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const target = candidate as Record<string, unknown>;
    if (typeof target.providerId !== "string" || typeof target.displayName !== "string" || !Array.isArray(target.models)) return [];
    const providerId = target.providerId;
    const displayName = target.displayName;
    const models: VisionProxyTarget["models"][number][] = target.models.flatMap((modelValue) => {
      if (!modelValue || typeof modelValue !== "object" || Array.isArray(modelValue)) return [];
      const model = modelValue as Record<string, unknown>;
      if (typeof model.id !== "string" || typeof model.displayName !== "string") return [];
      const metadata = model.nativeMetadata && typeof model.nativeMetadata === "object" && !Array.isArray(model.nativeMetadata) ? model.nativeMetadata as Record<string, unknown> : {};
      if (metadata.walletKind === "user_api"
        && (metadata.apiKeyConfigured !== true || metadata.apiKeyVerified !== true)) return [];
      return [{
        id: model.id,
        providerId,
        displayName: model.displayName,
        isDefault: model.isDefault === true,
        ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((item): item is "text" | "image" | "audio" => item === "text" || item === "image" || item === "audio") } : {}),
        nativeMetadata: {},
      }];
    });
    return models.length ? [{ providerId, displayName, models }] : [];
  });
}

function mergeTaskDetailsVisionTargets(
  previous: readonly VisionProxyTarget[],
  fresh: readonly VisionProxyTarget[],
): readonly VisionProxyTarget[] {
  const freshProviders = new Set(fresh.map((target) => target.providerId));
  return [...fresh, ...previous.filter((target) => !freshProviders.has(target.providerId))];
}

function configuredEyesChoice(status: VisionProxyStatus | null): string {
  return status?.configured ? `${status.configured.providerId}|${status.configured.modelId}` : "";
}

function eyesChoiceIsAvailable(targets: readonly VisionProxyTarget[], status: VisionProxyStatus | null): boolean {
  if (!status?.configured) return true;
  return targets.some((target) => target.providerId === status.configured?.providerId && target.models.some((model) => model.id === status.configured?.modelId));
}

export function TaskDetailsControl({ session, providers, liveVisionStatus, readLiveVisionStatus, onOpenChild, foreignSubagentsEnabled, sessionForeignSubagents, onSessionForeignSubagents }: {
  session: Session;
  providers: readonly Provider[];
  liveVisionStatus?: VisionProxyStatus | undefined;
  readLiveVisionStatus?: ((sessionId: string) => VisionProxyStatus | undefined) | undefined;
  onOpenChild: (session: Session) => void;
  /** Master gate from Settings; the per-session control only exists while it is on. */
  foreignSubagentsEnabled: boolean;
  /** Effective per-session choice: explicit override or, absent one, allowed. */
  sessionForeignSubagents: boolean;
  onSessionForeignSubagents: (allowed: boolean) => void;
}) {
  const localOpen = useLocalOpen();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [childrenError, setChildrenError] = useState(false);
  const [children, setChildren] = useState<readonly Session[]>([]);
  const [sideChats, setSideChats] = useState<readonly { id: string; title: string; providerId: string; state: string; updatedAt: string; preview?: string }[]>([]);
  const [eyesTargets, setEyesTargets] = useState<readonly VisionProxyTarget[]>([]);
  const [eyes, setEyes] = useState<VisionProxyStatus | null>(null);
  const [eyesChoice, setEyesChoice] = useState("");
  const [eyesDiscovery, setEyesDiscovery] = useState<"loading" | "ready" | "unavailable">("loading");
  const [eyesStatusDiscovery, setEyesStatusDiscovery] = useState<"loading" | "ready" | "unavailable">("loading");
  const [eyesSaving, setEyesSaving] = useState(false);
  const [eyesError, setEyesError] = useState("");
  const [eyesCatalogueWarning, setEyesCatalogueWarning] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const eyesTargetsRef = useRef<readonly VisionProxyTarget[]>(eyesTargets);
  eyesTargetsRef.current = eyesTargets;
  const activeSessionId = useRef(session.id);
  activeSessionId.current = session.id;
  const refreshRevision = useRef(0);
  const eyesRequestRevision = useRef(0);
  const eyesSaveRevision = useRef(0);
  const eyesSaveInFlight = useRef(false);
  const popoverId = useId();
  const subagentsHeadingId = `${popoverId}-subagents`;
  const foreignSubagentsHeadingId = `${popoverId}-foreign-subagents`;
  const eyesHeadingId = `${popoverId}-eyes`;
  const sideChatsHeadingId = `${popoverId}-side-chats`;
  const locationHeadingId = `${popoverId}-location`;
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    refreshRevision.current += 1;
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  }, []);
  const closeFromOutside = useCallback(() => close(false), [close]);
  const refresh = useCallback(async () => {
    const requestedSessionId = session.id;
    const liveStatusAtStart = readLiveVisionStatus?.(requestedSessionId);
    const revision = ++refreshRevision.current;
    const eyesRevision = ++eyesRequestRevision.current;
    const isCurrent = () => refreshRevision.current === revision && activeSessionId.current === requestedSessionId;
    const isCurrentEyes = () => isCurrent() && eyesRequestRevision.current === eyesRevision;
    setLoading(true);
    setChildrenError(false);
    setEyesError("");
    setEyesCatalogueWarning("");
    if (!eyesTargets.length) setEyesDiscovery("loading");
    if (!eyes) setEyesStatusDiscovery("loading");
    const childRequest = listChildSessions(requestedSessionId).then((result) => {
      if (isCurrent()) setChildren(result);
    }).catch(() => {
      if (isCurrent()) setChildrenError(true);
    }).finally(() => {
      if (isCurrent()) setLoading(false);
    });
    const targetRequest = request("vision.targets", {}).then((available) => {
      if (!Array.isArray(available.targets)) throw new Error("invalid targets");
      if (!isCurrentEyes()) return;
      const fresh = taskDetailsVisionTargets(available.targets);
      const incomplete = available.incomplete === true;
      const cached = eyesTargetsRef.current;
      if (incomplete && fresh.length === 0 && cached.length === 0) {
        setEyesDiscovery("unavailable");
      } else {
        const next = incomplete ? mergeTaskDetailsVisionTargets(cached, fresh) : fresh;
        eyesTargetsRef.current = next;
        setEyesTargets(next);
        setEyesDiscovery("ready");
      }
      setEyesCatalogueWarning(incomplete ? "Some visual models could not be refreshed. Available choices are still shown." : "");
    }).catch(() => {
      if (isCurrentEyes()) setEyesDiscovery("unavailable");
    });
    const statusRequest = request("session.vision.get", { sessionId: requestedSessionId }).then((current) => {
      const received = parsedVisionStatus(current.vision, requestedSessionId);
      if (!received) throw new Error("invalid status");
      if (!isCurrentEyes()) return;
      const latestLive = readLiveVisionStatus?.(requestedSessionId);
      const status = latestLive !== undefined && latestLive !== liveStatusAtStart ? latestLive : received;
      setEyes(status);
      setEyesChoice(configuredEyesChoice(status));
      setEyesStatusDiscovery("ready");
    }).catch(() => {
      if (isCurrentEyes()) setEyesStatusDiscovery("unavailable");
    });
    // Side chats are nested rather than listed, so a finished one is otherwise
    // unreachable. Opening one reads it; it is not resumed from here.
    const sideChatRequest = request("session.side_chats", { sessionId: requestedSessionId }).then((result) => {
      if (isCurrent()) setSideChats(Array.isArray(result.sessions) ? result.sessions as unknown as typeof sideChats : []);
    }).catch(() => undefined);
    await Promise.allSettled([childRequest, targetRequest, statusRequest, sideChatRequest]);
  }, [eyes, readLiveVisionStatus, session.id]);
  const configureEyes = useCallback(async (value: string) => {
    const choiceExists = value === "" || eyesTargetsRef.current.some((target) =>
      target.models.some((model) => `${target.providerId}|${model.id}` === value));
    if (eyesSaveInFlight.current || !choiceExists) return;
    eyesSaveInFlight.current = true;
    const revision = ++eyesSaveRevision.current;
    eyesRequestRevision.current += 1;
    const previousChoice = configuredEyesChoice(eyes);
    const requestedSessionId = session.id;
    const liveStatusAtStart = readLiveVisionStatus?.(requestedSessionId);
    setEyesSaving(true);
    setEyesError("");
    try {
      // Split on the first separator only: a provider id never contains one, but a
      // model id legitimately can.
      const cut = value.indexOf("|");
      const providerId = cut > 0 ? value.slice(0, cut) : "";
      const modelId = cut > 0 ? value.slice(cut + 1) : "";
      const selection = providerId && modelId ? { providerId, modelId } : null;
      await request("session.vision.configure", { sessionId: requestedSessionId, selection: selection as unknown as JsonObject });
      const current = await request("session.vision.get", { sessionId: requestedSessionId });
      const received = parsedVisionStatus(current.vision, requestedSessionId);
      if (!received) throw new Error("invalid status");
      if (activeSessionId.current !== requestedSessionId || eyesSaveRevision.current !== revision) return;
      const latestLive = readLiveVisionStatus?.(requestedSessionId);
      const authoritative = latestLive !== undefined && latestLive !== liveStatusAtStart ? latestLive : received;
      eyesRequestRevision.current += 1;
      setEyes(authoritative);
      setEyesChoice(configuredEyesChoice(authoritative));
      setEyesStatusDiscovery("ready");
      const authoritativeChoice = configuredEyesChoice(authoritative);
      if (authoritativeChoice !== value) setEyesError("The saved visual model changed elsewhere. The latest saved choice is shown.");
    } catch {
      if (activeSessionId.current !== requestedSessionId || eyesSaveRevision.current !== revision) return;
      try {
        const current = await request("session.vision.get", { sessionId: requestedSessionId });
        const received = parsedVisionStatus(current.vision, requestedSessionId);
        if (activeSessionId.current !== requestedSessionId || eyesSaveRevision.current !== revision) return;
        const latestLive = readLiveVisionStatus?.(requestedSessionId);
        const authoritative = latestLive !== undefined && latestLive !== liveStatusAtStart ? latestLive : received;
        if (authoritative) {
          eyesRequestRevision.current += 1;
          setEyes(authoritative);
          const authoritativeChoice = configuredEyesChoice(authoritative);
          setEyesChoice(authoritativeChoice);
          setEyesStatusDiscovery("ready");
          if (authoritativeChoice !== value) setEyesError("The visual model was not changed. Your saved choice is shown.");
        } else {
          setEyesChoice(previousChoice);
          setEyesStatusDiscovery("unavailable");
          setEyesError("The visual model could not be saved. Try again when its status is available.");
        }
      } catch {
        if (activeSessionId.current !== requestedSessionId || eyesSaveRevision.current !== revision) return;
        setEyesChoice(previousChoice);
        setEyesStatusDiscovery("unavailable");
        setEyesError("The visual model could not be saved. Try again when its status is available.");
      }
    } finally {
      if (activeSessionId.current === requestedSessionId && eyesSaveRevision.current === revision) {
        eyesSaveInFlight.current = false;
        setEyesSaving(false);
      }
    }
  }, [eyes, readLiveVisionStatus, session.id]);

  useEffect(() => {
    refreshRevision.current += 1;
    eyesRequestRevision.current += 1;
    eyesSaveRevision.current += 1;
    eyesSaveInFlight.current = false;
    setOpen(false);
    setLoading(false);
    setChildrenError(false);
    setChildren([]);
    setSideChats([]);
    setEyesTargets([]);
    setEyes(null);
    setEyesChoice("");
    setEyesDiscovery("loading");
    setEyesStatusDiscovery("loading");
    setEyesSaving(false);
    setEyesError("");
    setEyesCatalogueWarning("");
  }, [session.id]);
  useEffect(() => {
    if (liveVisionStatus === undefined || liveVisionStatus.sessionId !== session.id) return;
    eyesRequestRevision.current += 1;
    setEyes(liveVisionStatus);
    setEyesChoice(configuredEyesChoice(liveVisionStatus));
    setEyesStatusDiscovery("ready");
  }, [liveVisionStatus, session.id]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) closeFromOutside(); };
    const closeEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    return () => { window.removeEventListener("mousedown", closeOutside); window.removeEventListener("keydown", closeEscape); };
  }, [close, closeFromOutside, open]);

  const savedEyesChoice = configuredEyesChoice(eyes);
  const persistedEyesUnavailable = Boolean(savedEyesChoice && !eyesChoiceIsAvailable(eyesTargets, eyes));

  return <div className={`task-details ${open ? "task-details-open" : ""}`} ref={root}>
    <button ref={trigger} type="button" className="task-details-trigger" title="Task details" aria-label="Task details" aria-expanded={open} aria-controls={popoverId} onClick={() => { if (open) close(); else { setOpen(true); void refresh(); } }}><InfoIcon /></button>
    {open ? <section id={popoverId} className="task-details-popover" role="dialog" aria-modal="false" aria-label="Task details">
      <header><strong>Task details</strong><button type="button" aria-label="Close task details" onClick={() => close()}><XIcon /></button></header>
      <section className="task-details-section" aria-labelledby={subagentsHeadingId}>
        <h2 id={subagentsHeadingId}>Sub-agents</h2>
        {loading ? <p className="task-details-empty"><span className="spinner" /> Checking this task…</p> : childrenError ? <p className="task-details-empty">Sub-agents are unavailable.<button type="button" className="task-details-retry" onClick={() => void refresh()}>Retry</button></p> : children.length ? <div className="task-child-list">{children.map((child) => {
          const childProvider = providers.find((provider) => provider.id === child.providerId);
          // The logo already names the harness, so repeating "Grok Build" in text spent
          // the line on something the reader can see. The model is the fact that is not
          // otherwise visible, and it is what distinguishes two children of one harness.
          const done = child.state === "completed" || child.state === "failed" || child.state === "idle";
          return <button type="button" key={child.id} data-child-state={done ? "done" : "working"} onClick={() => { close(false); onOpenChild(child); }}>
            <span className="task-child-icon"><ProviderLogo providerId={child.providerId} provider={childProvider} size={22}/></span>
            <span><strong>{child.agentNickname || child.title}</strong><small>{child.model || providerDisplayName(child.providerId, childProvider)} · {childStateLabel(child.state)}</small></span>
            {done ? null : <span className="spinner" aria-hidden="true" />}
            <ChevronRightIcon />
          </button>;
        })}</div> : <p className="task-details-empty">No sub-agents for this task.</p>}
      </section>
      {foreignSubagentsEnabled ? <section className="task-details-section" aria-labelledby={foreignSubagentsHeadingId}>
        <h2 id={foreignSubagentsHeadingId}>Other coding tools</h2>
        {/* The gate is on, so this task may spawn foreign sub-agents unless the
            user has explicitly switched it off here. */}
        <label className="task-details-eyes">
          <span><input type="checkbox" checked={sessionForeignSubagents} onChange={(event) => onSessionForeignSubagents(event.target.checked)} /> This task may spawn sub-agents on a different coding tool.</span>
        </label>
      </section> : null}
      <section className="task-details-section" aria-labelledby={eyesHeadingId}>
        <h2 id={eyesHeadingId}>Eyes</h2>
        {/* Offered whatever this model can already do: borrowing sharper eyes for a
            capable-but-weaker vision model is as valid as giving sight to one with none. */}
        <label className="task-details-eyes">
          <span>Look at images with</span>
          <select aria-label="Task EYES model" value={eyesChoice} disabled={eyesSaving || (eyesTargets.length === 0 && !eyes?.configured)} onChange={(event) => void configureEyes(event.target.value)}>
            {eyesDiscovery === "loading" || eyesStatusDiscovery === "loading" ? <option value="">Checking saved choice…</option> : <option value="">This task's own model</option>}
            {persistedEyesUnavailable ? <option value={savedEyesChoice} disabled>Saved visual model (currently unavailable)</option> : null}
            {eyesTargets.flatMap((target) => target.models.map((model) => <option key={`${target.providerId}|${model.id}`} value={`${target.providerId}|${model.id}`}>{target.displayName} · {model.displayName}</option>))}
          </select>
        </label>
        <p className="task-details-eyes-note">{eyesSaving ? "Saving this task's visual model…" : persistedEyesUnavailable ? "The saved visual model is unavailable. Choose another after discovery succeeds." : eyesDiscovery === "unavailable" || eyesStatusDiscovery === "unavailable" ? <>EYES status is unavailable.<button type="button" className="task-details-retry" onClick={() => void refresh()}>Retry</button></> : eyesDiscovery === "ready" && eyesTargets.length === 0 ? "No separate image-capable model is ready." : eyes?.configured ? "Images use the saved visual model for this task." : eyes?.primaryModelSupportsImageInput === false ? "This model cannot read images on its own." : "Pick another model to read images for this task."}</p>
        {eyesCatalogueWarning ? <p className="task-details-inline-error" role="status">{eyesCatalogueWarning}<button type="button" className="task-details-retry" onClick={() => void refresh()}>Retry</button></p> : null}
        {eyesError ? <p className="task-details-inline-error" role="alert">{eyesError}</p> : null}
      </section>
      {sideChats.length ? <section className="task-details-section" aria-labelledby={sideChatsHeadingId}>
        <h2 id={sideChatsHeadingId}>Side chats</h2>
        <div className="task-child-list">{sideChats.map((chat) => {
          const chatProvider = providers.find((provider) => provider.id === chat.providerId);
          return <button type="button" key={chat.id} data-child-state={chat.state === "working" ? "working" : "done"} onClick={() => { close(false); onOpenChild({ ...session, id: chat.id, title: chat.title, providerId: chat.providerId, state: chat.state as Session["state"], preview: chat.preview ?? "", updatedAt: chat.updatedAt, sessionKind: "side_chat", parentSessionId: session.id }); }}>
            <span className="task-child-icon"><ProviderLogo providerId={chat.providerId} provider={chatProvider} size={22}/></span>
            <span><strong>{chat.title}</strong><small>{relativeTime(chat.updatedAt)}</small></span>
            {chat.state === "working" ? <span className="spinner" aria-hidden="true" /> : null}
            <ChevronRightIcon />
          </button>;
        })}</div>
      </section> : null}
      <section className="task-details-section task-details-facts" aria-labelledby={locationHeadingId}>
        <h2 id={locationHeadingId}>Location</h2>
        <dl><div><dt>Project</dt><dd title={session.project}>{session.project}</dd></div><div><dt>Folder</dt><dd title={session.workingDirectory || "Not reported"}>{session.workingDirectory || "Not reported"}</dd></div></dl>
        {session.workingDirectory && localOpen.state.handlers.length ? <div className="task-details-open-in" role="group" aria-label="Open task folder in">
          {localOpen.state.handlers.map((handler) => <button type="button" key={handler.id} className={handler.id === localOpen.state.defaultHandlerId ? "default" : undefined} onClick={() => void localOpen.open({ path: session.workingDirectory! }, handler.id, true)}>
            <LocalOpenHandlerGlyph icon={handler.icon} />
            <span>{handler.label}</span>
            {handler.id === localOpen.state.defaultHandlerId ? <small>Default</small> : null}
          </button>)}
        </div> : null}
      </section>
    </section> : null}
  </div>;
}

function Workspace({ snapshot, session, workingBoundary, stopPresentationActive, onStopPresentation, onBack, onBrowser, onLinkOpen, onManageWorkflow, onDraftSelectionChange, onCreateDraftSend, onMaterializeDraft, pendingComposerAction, onPendingComposerActionConsumed, onCreateDraftSchedule, draftScheduleAttempt, onRetainDraftScheduleAttempt, onDraftDirectory, initialDraft, onDraftChange, initialAttachments, onAttachmentsChange, initialWorkflowAttachments, onWorkflowAttachmentsChange, initialAnnotations, onAnnotationsChange, initialMode, onModeChange, initialMeshTargets, onMeshTargetsChange, initialDelegationDraft, onDelegationDraftChange, draftRestoreRevision, onRestoreFailedSubmission, onDerivedSession, onRetryQueuedNewTaskDelivery, onOpenChild, onOpenParent, notify, updateSnapshot, onAttentionMutation, onPrepareTurnResume, onHydrateProviderModels, timelineWindow, onLoadOlder, reasoningDisplay, agentDefaults, ears, onEarsChange, experimental, foreignSubagentsEnabled, sessionForeignSubagents, onSessionForeignSubagents, onInstantSession, onCreateSideChat, onContextHandoff, queueRevision, queueingEnabled, onQueueingEnabledChange, reportedCompaction, visionStatus, readVisionStatus }: {
  snapshot: DesktopSnapshot; session: Session; workingBoundary?: SessionWorkingBoundary | undefined; stopPresentationActive: boolean; onStopPresentation: (sessionId: string, active: boolean) => void; onBack: () => void; onBrowser: () => void; onLinkOpen: (url: string) => void; onManageWorkflow: (id?: string) => void;
  onDraftSelectionChange: (selection: DraftModelSelection) => void; onCreateDraftSend: (input: DraftSessionSendInput) => Promise<void>; onMaterializeDraft: (input: DraftSessionMaterializeInput, action: ComposerTaskAction) => Promise<void>; pendingComposerAction: PendingComposerAction | null; onPendingComposerActionConsumed: (requestId: string) => void; onCreateDraftSchedule: (input: DraftSessionScheduleInput) => Promise<void>; draftScheduleAttempt: DraftSessionScheduleAttemptState | null; onRetainDraftScheduleAttempt: (input: DraftSessionScheduleInput) => DraftSessionScheduleInput; onDraftDirectory: () => void;
  handoffSummary?: string | undefined; initialDraft: string; onDraftChange: (value: string) => void; initialAttachments: readonly ComposerAttachment[]; onAttachmentsChange: (value: readonly ComposerAttachment[]) => void; initialWorkflowAttachments: readonly WorkflowAttachment[]; onWorkflowAttachmentsChange: (value: readonly WorkflowAttachment[]) => void; initialAnnotations: readonly ResponseAnnotation[]; onAnnotationsChange: (value: readonly ResponseAnnotation[]) => void; initialMode: "queue" | "steer" | "goal"; onModeChange: (value: "queue" | "steer" | "goal") => void; initialMeshTargets: readonly MeshTarget[]; onMeshTargetsChange: (value: readonly MeshTarget[]) => void; initialDelegationDraft: DelegationDraft | undefined; onDelegationDraftChange: (value: DelegationDraft | null) => void; draftRestoreRevision: number; onRestoreFailedSubmission: (submitted: ComposerDraftSnapshot) => ComposerDraftSnapshot; onDerivedSession: (value: Record<string, unknown>, summary?: string, draft?: string, queuedNewTask?: QueuedNewTaskPresentation) => void;
  onRetryQueuedNewTaskDelivery: (deliveryId: string) => void;
  onOpenChild: (session: Session) => void;
  onOpenParent: (parentSessionId: string) => void;
  notify: (message: string, tone?: "normal" | "error") => void; updateSnapshot: (value: DesktopSnapshot | ((current: DesktopSnapshot | null) => DesktopSnapshot | null) | null) => void; onAttentionMutation: () => void; onPrepareTurnResume: (sessionId: string) => () => void; onHydrateProviderModels: (providerId: Session["providerId"]) => Promise<void>;
  timelineWindow: TimelineWindowState | undefined; onLoadOlder: (() => Promise<void>) | undefined; reasoningDisplay: DesktopPreferencesState["reasoningDisplay"];
  agentDefaults: DesktopPreferencesState["agentDefaults"];
  ears: DesktopPreferencesState["ears"];
  onEarsChange: (value: DesktopPreferencesState["ears"]) => Promise<void>;
  experimental: boolean; foreignSubagentsEnabled: boolean; sessionForeignSubagents: boolean; onSessionForeignSubagents: (allowed: boolean) => void; onInstantSession: () => void; onCreateSideChat: (parentSessionId: string, prompt?: string, queuedMessageId?: string) => Promise<void>; onContextHandoff: (parentSessionId: string, customNote: string) => Promise<void>; queueRevision: number; queueingEnabled: boolean; onQueueingEnabledChange: (enabled: boolean) => void;
  reportedCompaction?: { isCompacting: boolean; kind: "automatic" | "manual" | null } | undefined;
  visionStatus?: VisionProxyStatus | undefined;
  readVisionStatus?: ((sessionId: string) => VisionProxyStatus | undefined) | undefined;
}) {
  const localOpen = useLocalOpen();
  const conversationHandle = useRef<ConversationHandle>(null);
  const continuingSessions = useRef(new Set<string>());
  const [pendingContinuations, setPendingContinuations] = useState<ReadonlySet<string>>(() => new Set());
  // One owner for the context reading. The header's meter used to fetch its own on
  // a timer rebuilt by every render, which a live turn re-renders far faster than
  // the timer's own delay — so the timer never reached it and the meter sat on
  // whatever it had when the turn began, which for a new task is nothing at all.
  // The poll below is keyed on the session, not on its churn, so it cannot starve.
  const [sessionContext, setSessionContext] = useState<SessionContextState | null>(null);
  const [contextCompaction, setContextCompaction] = useState<{ isCompacting: boolean; kind: "automatic" | "manual" | null }>({ isCompacting: false, kind: null });
  const contextCompactionSessionKey = useRef<string | null>(null);
  const [annotationRequest, setAnnotationRequest] = useState<{ text: string; anchor: { x: number; y: number } } | null>(null);
  const latestAnnotations = useRef<{ sessionId: string; restoreRevision: number; value: readonly ResponseAnnotation[] }>({ sessionId: session?.id ?? "", restoreRevision: draftRestoreRevision, value: initialAnnotations });
  if (latestAnnotations.current.sessionId !== (session?.id ?? "") || latestAnnotations.current.restoreRevision !== draftRestoreRevision) {
    latestAnnotations.current = { sessionId: session?.id ?? "", restoreRevision: draftRestoreRevision, value: initialAnnotations };
  }
  const updateAnnotations = (value: readonly ResponseAnnotation[]) => {
    latestAnnotations.current = { sessionId: session?.id ?? "", restoreRevision: draftRestoreRevision, value };
    onAnnotationsChange(value);
  };
  useEffect(() => { setAnnotationRequest(null); }, [session?.id]);
  const updateContextCompaction = useCallback((isCompacting: boolean, kind: "automatic" | "manual" | null = null) => {
    setContextCompaction((current) => current.isCompacting === isCompacting && current.kind === (isCompacting ? kind : null)
      ? current
      : { isCompacting, kind: isCompacting ? kind : null });
  }, []);
  const contextSessionKey = session && !session.draft && !session.schedule ? session.id : null;
  useEffect(() => {
    if (contextCompactionSessionKey.current === contextSessionKey) return;
    contextCompactionSessionKey.current = contextSessionKey;
    updateContextCompaction(reportedCompaction?.isCompacting ?? false, reportedCompaction?.kind ?? null);
  }, [contextSessionKey, reportedCompaction, updateContextCompaction]);
  useEffect(() => {
    if (reportedCompaction) updateContextCompaction(reportedCompaction.isCompacting, reportedCompaction.kind);
  }, [reportedCompaction, updateContextCompaction]);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    if (!session || session.draft || session.schedule) {
      setSessionContext(null);
      updateContextCompaction(false);
      return;
    }
    const active = session.state === "working" || session.state === "needs_approval" || session.state === "needs_input";
    let failures = 0;
    let inFlight = false;
    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), delay);
    };
    const poll = async () => {
      if (disposed || inFlight) return;
      // Nobody is reading a hidden window; the wake below takes a fresh reading the
      // moment there is someone again.
      if (document.hidden) return schedule(4_000);
      inFlight = true;
      // A settled task keeps a calm heartbeat rather than stopping after one
      // reading. One reading is a snapshot, and a snapshot taken at the wrong
      // moment — a provider still warming up, a turn whose usage had not landed
      // yet — is then the answer forever. Nothing about the number is expensive;
      // being wrong until the task is reopened is.
      let delay = active ? 650 : 2_500;
      try {
        const context = await loadSessionContext(session.id);
        failures = 0;
        if (context.isCompacting) delay = 650;
        if (!disposed) {
          setSessionContext((current) => sameSessionContext(current, context) ? current : context);
          updateContextCompaction(context.isCompacting, context.compactionKind);
        }
      } catch {
        // One failed reading is not proof the task has no context. Leave the last
        // good one standing — it is stamped with its own session, so it can only
        // ever be shown against the task it was actually read from — and back off
        // rather than hammering a provider that is still coming up.
        failures += 1;
        delay = Math.min(8_000, 400 * 2 ** Math.min(failures, 5));
      } finally {
        inFlight = false;
      }
      schedule(delay);
    };
    void poll();
    // Coming back to the window is the moment the number is looked at, so it is
    // also the moment to make sure it is current.
    const wake = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [session?.draft, session?.id, session?.schedule?.status, session?.state, updateContextCompaction]);
  const storedTimeline = snapshot.timelines[session.id];
  const timeline = useMemo(() => storedTimeline
    ? reconcileSubagentTimeline(session.id, storedTimeline, snapshot.sessions)
    : undefined, [session.id, snapshot.sessions, storedTimeline]);
  const continueTask = async () => {
    if (continuingSessions.current.has(session.id)
      || !stopPresentationActive && sessionPresentsLiveTurn(session, timeline ?? [], workingBoundary)) return false;
    continuingSessions.current.add(session.id);
    setPendingContinuations(new Set(continuingSessions.current));
    const boundary = captureSessionWorkingBoundary(timeline ?? []);
    const commitResumeBoundary = onPrepareTurnResume(session.id);
    const resumedAt = new Date().toISOString();
    conversationHandle.current?.prepareForSubmission();
    try {
      const result = await request("session.continue", {
        sessionId: session.id,
        ...(session.model !== "default" ? { modelId: session.model } : {}),
        ...(session.effort ? { reasoningEffort: session.effort.toLowerCase() } : {}),
      });
      if (result.accepted === false) throw new Error("The provider did not accept the continuation. Try Continue again.");
      commitResumeBoundary();
      onStopPresentation(session.id, false);
      updateSnapshot((current) => {
        if (!current) return current;
        const currentTimeline = current.timelines[session.id] ?? [];
        // A fast resumed turn can finish before the send acknowledgement arrives.
        const stillWorking = sessionBoundaryNeedsVisibleEnding(currentTimeline, boundary);
        return {
          ...current,
          sessions: current.sessions.map((item) => item.id === session.id ? {
            ...item,
            ...(stillWorking ? { state: "working" as const, updatedAt: resumedAt } : {}),
            externalWriter: false,
          } : item),
        };
      });
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      return false;
    } finally {
      continuingSessions.current.delete(session.id);
      setPendingContinuations(new Set(continuingSessions.current));
    }
  };
  const presentationTimeline = useMemo(
    () => stopPresentationActive && timeline ? settleRunningTimeline(timeline) : timeline,
    [stopPresentationActive, timeline],
  );
  const presentationSession = useMemo(
    () => stopPresentationActive ? { ...session, state: "idle" as const } : session,
    [session, stopPresentationActive],
  );
  const visibleSessionState = stopPresentationActive ? "idle" : presentedSessionState(session, timeline ?? [], workingBoundary);
  const resolvedRevealStart = timelineWindow && presentationTimeline
    ? anchoredTimelineRevealStart(presentationTimeline, timelineWindow.revealStart, timelineWindow.revealAnchorKey)
    : 0;
  const hasTimelineWindow = timelineWindow !== undefined;
  // Context and goal heartbeats rerender Workspace even when the transcript has
  // not changed. Keep the visible slice stable so ChatTimeline's expensive
  // normalization memo is not defeated by a fresh array on every heartbeat.
  const visibleTimeline = useMemo(
    () => hasTimelineWindow ? presentationTimeline?.slice(resolvedRevealStart) : undefined,
    [hasTimelineWindow, presentationTimeline, resolvedRevealStart],
  );
  const annotateTimelineSelection = useCallback((text: string, anchor: { x: number; y: number }) => {
    setAnnotationRequest({ text, anchor });
  }, []);
  const approvals = snapshot.approvals.filter((approval) => approval.sessionId === session.id);
  const inputs = snapshot.inputRequests.filter((input) => input.sessionId === session.id);
  const provider = snapshot.providers.find((item) => item.id === session.providerId);
  const sessionModel = snapshot.models[session.providerId]?.find((model) => model.id === session.model || model.name === session.model);
  const directAnnotationAudio = providerAcceptsDirectAudio(session.providerId) && modelAcceptsDirectAudio(sessionModel);
  const canInterrupt = provider?.capabilities.includes("Interrupt") === true;
  const interruptSession = async () => {
    try {
      await request("session.interrupt", { sessionId: session.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(message, "error");
    }
  };
  const olderAvailable = Boolean(resolvedRevealStart > 0 || timelineWindow?.nextCursor);
  const progressiveLoading = snapshot.loading === true && session.provisional === true;
  const parentSessionId = parentSessionIdForBack(session);
  const incomingBranch = session.relationshipKind === "branch" && session.relationshipSourceSessionId
    ? snapshot.sessions.find((candidate) => candidate.id === session.relationshipSourceSessionId)
    : undefined;
  const branchRelations = [
    ...(incomingBranch ? [{ session: incomingBranch, label: `Branched from ${incomingBranch.title}` }] : []),
    ...snapshot.sessions
      .filter((candidate) => candidate.relationshipKind === "branch" && candidate.relationshipSourceSessionId === session.id)
      .map((candidate) => ({ session: candidate, label: `Branched to ${candidate.title}` })),
  ];
  const openTimelineSubagent = useCallback((item: TimelineItem): void => {
    const childSessionId = item.childSessionId?.trim();
    if (!childSessionId) return;
    const parentSessionId = session.id;
    void resolveTimelineSubagentSession(parentSessionId, childSessionId, snapshot.sessions).then((child) => {
      if (child) onOpenChild(child);
      else notify("That sub-agent task is no longer available.", "error");
    }).catch((error: unknown) => {
      notify(error instanceof Error ? error.message : "Couldn’t open that sub-agent task.", "error");
    });
  }, [notify, onOpenChild, session.id, snapshot.sessions]);
  return <main className={`workspace ${progressiveLoading ? "workspace-progressive-loading" : ""}`}>
    <header className="workspace-header">
      {progressiveLoading ? <div className="workspace-header-skeleton" aria-hidden="true"><i/><span><b/><b/></span></div> : <>
        {parentSessionId
          ? <IconButton label="Back to parent task" className="parent-task-back" onClick={() => onOpenParent(parentSessionId)}><ArrowLeftIcon /></IconButton>
          : <IconButton label="Show task list" className="mobile-back" onClick={onBack}><ArrowLeftIcon /></IconButton>}
        <ProviderLogo providerId={session.providerId} provider={provider} size={32}/>
        <div className="workspace-title"><div><h1>{session.title}</h1>{session.draft ? null : <Status state={visibleSessionState} />}</div><button className={`workspace-location ${session.draft ? "draft-location" : ""}`} title={session.draft ? "Choose the project folder" : session.workingDirectory || session.project} aria-label={session.draft ? `Choose project folder. Current folder: ${session.workingDirectory || "none"}` : `Open working directory: ${session.workingDirectory || session.project}`} onClick={() => { if (session.draft) onDraftDirectory(); else if (session.workingDirectory) void localOpen.open({ path: session.workingDirectory }); }}><FolderIcon /><span>{session.workingDirectory || "Choose a folder"}</span></button></div>
      </>}
      <div className="workspace-actions" aria-hidden={progressiveLoading || undefined}>
        {progressiveLoading ? null : <>
        {session.draft || session.schedule ? null : <ContextUsageControl key={session.id} session={session} context={sessionContext?.sessionId === session.id ? sessionContext : null} notify={notify} onCompactionChange={updateContextCompaction} onContext={setSessionContext} />}
        {session.workingDirectory ? <WorkspaceLocalOpenControl path={session.workingDirectory} /> : null}
        {session.draft || session.schedule ? null : <TaskDetailsControl session={session} providers={snapshot.providers} liveVisionStatus={visionStatus} readLiveVisionStatus={readVisionStatus} onOpenChild={onOpenChild} foreignSubagentsEnabled={foreignSubagentsEnabled} sessionForeignSubagents={sessionForeignSubagents} onSessionForeignSubagents={onSessionForeignSubagents} />}
        </>}
      </div>
    </header>
    <Conversation ref={conversationHandle} timeline={visibleTimeline} approvals={approvals} inputs={inputs} session={presentationSession} workingBoundary={stopPresentationActive ? undefined : workingBoundary} provider={provider} notify={notify} updateSnapshot={updateSnapshot} onAttentionMutation={onAttentionMutation} prepareTurnResume={() => onPrepareTurnResume(session.id)} onContinue={continueTask} continuePending={pendingContinuations.has(session.id)} olderAvailable={olderAvailable} loadingOlder={timelineWindow?.loadingOlder === true} onLoadOlder={onLoadOlder} onLinkOpen={onLinkOpen} onWorkflowOpen={onManageWorkflow} onAnnotateSelection={annotateTimelineSelection} onRetryQueuedNewTaskDelivery={onRetryQueuedNewTaskDelivery} onOpenSubagent={openTimelineSubagent} reasoningDisplay={reasoningDisplay} isCompacting={contextCompaction.isCompacting} compactionKind={contextCompaction.kind} branchRelations={branchRelations} onOpenBranch={onOpenChild} />
    {annotationRequest ? <ResponseAnnotationEditor selectedText={annotationRequest.text} anchor={annotationRequest.anchor} providerId={session.providerId} request={request} notify={notify} directAudioAvailable={directAnnotationAudio} earsEnabled={ears.enabled} onClose={() => setAnnotationRequest(null)} onSave={(annotation) => { updateAnnotations([...latestAnnotations.current.value.filter((item) => item.id !== annotation.id), annotation]); setAnnotationRequest(null); }} /> : null}
    {session.schedule ? null : <Composer key={session.id} snapshot={snapshot} session={session} workingBoundary={workingBoundary} stopPresentationActive={stopPresentationActive} request={request} selectImages={selectImages} preview={isBrowserPreview} notify={notify} updateSnapshot={updateSnapshot} onHydrateProviderModels={onHydrateProviderModels} onBeforeSubmit={() => { onStopPresentation(session.id, false); conversationHandle.current?.prepareForSubmission(); }} onBrowser={onBrowser} onManageWorkflow={onManageWorkflow} initialDraft={initialDraft} onDraftChange={onDraftChange} initialAttachments={initialAttachments} onAttachmentsChange={onAttachmentsChange} initialWorkflowAttachments={initialWorkflowAttachments} onWorkflowAttachmentsChange={onWorkflowAttachmentsChange} initialAnnotations={latestAnnotations.current.value} onAnnotationsChange={updateAnnotations} initialMode={initialMode} onModeChange={onModeChange} initialMeshTargets={initialMeshTargets} onMeshTargetsChange={onMeshTargetsChange} initialDelegationDraft={initialDelegationDraft} onDelegationDraftChange={onDelegationDraftChange} draftRestoreRevision={draftRestoreRevision} onRestoreFailedSubmission={onRestoreFailedSubmission} onDerivedSession={onDerivedSession} onDraftSelectionChange={onDraftSelectionChange} onCreateDraftSend={onCreateDraftSend} onMaterializeDraft={onMaterializeDraft} pendingAction={pendingComposerAction} onPendingActionConsumed={onPendingComposerActionConsumed} onCreateDraftSchedule={onCreateDraftSchedule} draftScheduleAttempt={draftScheduleAttempt} onRetainDraftScheduleAttempt={onRetainDraftScheduleAttempt} experimental={experimental} onInstantSession={onInstantSession} onCreateSideChat={onCreateSideChat} onContextHandoff={onContextHandoff} queueRevision={queueRevision} queueingEnabled={queueingEnabled} onQueueingEnabledChange={onQueueingEnabledChange} agentDefaults={agentDefaults} ears={ears} onEarsChange={onEarsChange} goal={snapshot.goals[session.id] ?? null} goalClearRevision={snapshot.goalClearRevisions[session.id] ?? -1} onGoal={(goal, clearRevision, expectedRevision) => updateSnapshot((current) => current ? reconcileGoalResult(current, session.id, goal, clearRevision, expectedRevision) : current)} visionStatus={visionStatus} readVisionStatus={readVisionStatus} {...(canInterrupt ? { onInterrupt: interruptSession } : {})} />}
  </main>;
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

function compactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unavailable";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toLocaleString();
}

function usageCost(context: SessionContextState): string | null {
  if (context.usage.cost === undefined) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: context.usage.currency || "USD", maximumFractionDigits: 4 }).format(context.usage.cost);
  } catch {
    return `${context.usage.cost.toFixed(4)} ${context.usage.currency || "USD"}`;
  }
}

function ContextUsageControl({ session, context, notify, onCompactionChange, onContext }: { session: Session; context: SessionContextState | null; notify: (message: string, tone?: "normal" | "error") => void; onCompactionChange: (compacting: boolean, kind?: "automatic" | "manual" | null) => void; onContext: (context: SessionContextState) => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Only what the reader is part-way through changing. The applied threshold is
  // read from the live reading, so an arriving poll refreshes the numbers under
  // an open panel without overwriting a value they are still dragging.
  const [draftThreshold, setDraftThreshold] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const threshold = draftThreshold ?? context?.compactionThresholdTokens ?? context?.contextWindowTokens ?? null;
  const setThreshold = setDraftThreshold;
  const dismiss = useCallback(() => {
    setOpen(false);
    setDraftThreshold(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }, []);
  const dismissFromOutside = useCallback(() => {
    setOpen(false);
    setDraftThreshold(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) dismissFromOutside(); };
    const closeWithEscape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [dismiss, dismissFromOutside, open]);

  const save = async (value: number, compactNow: boolean) => {
    setSaving(true);
    const compactImmediately = compactNow && context?.usedTokens !== null && context?.usedTokens !== undefined && value <= context.usedTokens;
    if (compactImmediately) onCompactionChange(true, "manual");
    try {
      const next = await setSessionContextThreshold(session.id, Math.round(value), compactNow);
      onContext(next);
      onCompactionChange(next.isCompacting, next.compactionKind);
      dismiss();
      notify("Automatic compaction updated");
    } catch (error) {
      if (compactImmediately) onCompactionChange(context?.isCompacting === true, context?.compactionKind ?? null);
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
    }
  };

  const used = context?.usedTokens ?? null;
  const windowTokens = context?.contextWindowTokens ?? null;
  const reportedMinimum = context?.minimumThresholdTokens;
  const validMinimum = typeof reportedMinimum === "number" && Number.isFinite(reportedMinimum) && reportedMinimum > 0 ? reportedMinimum : 1_000;
  const minimum = Math.max(1, Math.min(validMinimum, windowTokens ?? Number.MAX_SAFE_INTEGER));
  const maximum = Math.max(minimum, windowTokens ?? minimum);
  const thresholdStep = Math.max(1, Math.min(1_000, maximum - minimum));
  const requestedThreshold = threshold ?? maximum;
  const safeThreshold = Number.isFinite(requestedThreshold) ? Math.max(minimum, Math.min(maximum, requestedThreshold)) : maximum;
  const thresholdAvailable = Boolean(context?.supportsThreshold && windowTokens !== null);
  const willCompactNow = used !== null && safeThreshold <= used;
  const activeTurnCompaction = willCompactNow && (session.state === "working" || session.state === "needs_approval" || session.state === "needs_input");
  const cost = context ? usageCost(context) : null;
  const appliedLimit = context?.compactionThresholdTokens ?? windowTokens;
  // The compact header answers how close this task is to the draft/applied
  // compaction point. The slider underlay is a separate signal: fixed context
  // occupancy against full model capacity. Dragging the thumb changes only the
  // first calculation and can never move the underlay.
  const meterLimit = thresholdAvailable ? safeThreshold : appliedLimit;
  const reportedPercent = used !== null && meterLimit !== null && meterLimit > 0
    ? used / meterLimit * 100
    : context?.usedPercent ?? null;
  const percent = reportedPercent !== null && Number.isFinite(reportedPercent) ? reportedPercent : null;
  const shownPercent = percent === null ? 0 : clampPercent(percent);
  const reportedContextPercent = used !== null && windowTokens !== null && windowTokens > 0
    ? used / windowTokens * 100
    : context?.usedPercent ?? null;
  const contextPercent = reportedContextPercent !== null && Number.isFinite(reportedContextPercent) ? reportedContextPercent : null;
  const shownContextPercent = contextPercent === null ? 0 : clampPercent(contextPercent);
  // Some agents report what a task has used without reporting the model's limit,
  // and a share of an unknown limit cannot be drawn. An empty gauge is not the
  // honest way to say that — it is indistinguishable from a full one at zero, and
  // it is what makes a working meter look broken. Say the part that is true: the
  // tokens actually used. Inventing a capacity to fill the gauge with would be
  // worse than either.
  const compactUsage = used === null ? "Usage unavailable"
    : meterLimit === null ? `${compactTokens(used)} used`
    : `${compactTokens(used)} / ${compactTokens(meterLimit)}`;
  const meterLabel = thresholdAvailable ? "Automatic compaction limit used" : "Context window used";
  const title = percent !== null ? `${Math.round(shownPercent)}% of ${thresholdAvailable ? "automatic compaction limit" : "context"} used`
    : used !== null ? `${compactTokens(used)} of context used; this agent does not report a limit`
    : "Context usage unavailable";

  return <div className={`context-usage ${open ? "context-usage-open" : ""}`} ref={root}>
    <button ref={trigger} className="context-usage-trigger" type="button" aria-label={`${title}. ${compactUsage}. Open context window settings.`} aria-haspopup="dialog" aria-expanded={open} aria-controls={popoverId} onClick={() => open ? dismiss() : setOpen(true)}>
      {percent !== null ? <span className="context-usage-track" role="progressbar" aria-label={meterLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shownPercent)}><i style={{ width: `${shownPercent}%` }} /></span> : null}
      {context === null ? <span className="context-usage-percent">…</span>
        : percent !== null ? <span className="context-usage-percent">{Math.round(shownPercent)}%</span>
        : used !== null ? <span className="context-usage-percent">{compactTokens(used)}</span>
        : null}
      <ChevronDownIcon className="context-usage-arrow" />
      <span className="context-usage-tooltip" aria-hidden="true"><strong>Context window</strong><span>{compactUsage}</span></span>
    </button>
    {open ? <section id={popoverId} className="context-usage-popover" role="dialog" aria-modal="false" aria-label="Context and compaction settings">
      <div className="context-usage-heading"><strong>Set automatic compaction</strong>{thresholdAvailable ? <b>{compactTokens(safeThreshold)}</b> : null}</div>
      {thresholdAvailable && context ? <div className="context-threshold">
        <div className="context-threshold-meter">
          <span className="context-expanded-track" role="progressbar" aria-label="Context window used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={contextPercent === null ? undefined : Math.round(shownContextPercent)}><i style={{ width: `${shownContextPercent}%` }} /></span>
          <input id={`context-threshold-${session.id}`} aria-label="Automatic compaction threshold" type="range" min={minimum} max={maximum} step={thresholdStep} value={safeThreshold} onChange={(event) => setThreshold(Number(event.target.value))} disabled={saving || context.isCompacting || maximum === minimum} />
        </div>
        <div className="context-threshold-range"><span>{compactTokens(minimum)}</span><span>{compactTokens(maximum)}</span></div>
        <p className="context-threshold-copy">Sets how full this task can get before it compacts automatically.</p>
        {activeTurnCompaction ? <p className="context-threshold-note">Applying now may compact while this turn is still running.</p> : null}
        <Button disabled={saving || context.isCompacting || safeThreshold === context.compactionThresholdTokens} onClick={() => void save(safeThreshold, true)}>{saving ? <span className="spinner" /> : null} Apply</Button>
      </div> : <p className="context-usage-unavailable">Automatic compaction is not available for this agent.</p>}
      {context?.isCompacting ? <p className="context-compacting"><span className="spinner" /> Compacting conversation…</p> : null}
      {context ? <section className="context-usage-details" aria-labelledby={`context-usage-details-${session.id}`}><h3 id={`context-usage-details-${session.id}`}>Usage</h3><dl className="context-usage-stats">
        <div><dt>Used</dt><dd>{compactTokens(used)}</dd></div>
        {appliedLimit !== null ? <div><dt>Compacts at</dt><dd>{compactTokens(appliedLimit)}</dd></div> : null}
        {windowTokens !== null ? <div><dt>Capacity</dt><dd>{compactTokens(windowTokens)}</dd></div> : null}
        <div><dt>Total tokens</dt><dd>{compactTokens(context.usage.totalTokens)}</dd></div>
        {context.usage.inputTokens !== undefined || context.usage.outputTokens !== undefined ? <div><dt>Input / output</dt><dd>{compactTokens(context.usage.inputTokens)} / {compactTokens(context.usage.outputTokens)}</dd></div> : null}
        {context.usage.cacheReadTokens !== undefined || context.usage.cacheWriteTokens !== undefined ? <div><dt>Cache read / write</dt><dd>{compactTokens(context.usage.cacheReadTokens)} / {compactTokens(context.usage.cacheWriteTokens)}</dd></div> : null}
        {cost ? <div><dt>Cost</dt><dd>{cost}</dd></div> : null}
      </dl></section> : null}
    </section> : null}
  </div>;
}

const LIVE_OUTPUT_GAP_PX = 52;
const READER_SCROLL_INTENT_MS = 800;
const SESSION_ANCHOR_RESTORE_FRAMES = 3;

type ConversationReaderAnchor = { readonly id: string; readonly offset: number; readonly memberToken?: string | undefined };
type ConversationScrollMode =
  | { readonly kind: "follow_tail" }
  | { readonly kind: "preserve_view"; readonly anchor: ConversationReaderAnchor | null };

const followTailScrollMode: ConversationScrollMode = Object.freeze({ kind: "follow_tail" });

interface ConversationHandle {
  prepareForSubmission: () => void;
}

function TranscriptSkeleton() {
  return <div className="transcript-skeleton" role="status" aria-label="Loading task history" aria-busy="true">
    <div className="transcript-skeleton-row assistant"><i/><span><b/><b/><b/></span></div>
    <div className="transcript-skeleton-row user"><span><b/><b/></span></div>
    <div className="transcript-skeleton-row assistant short"><i/><span><b/><b/></span></div>
  </div>;
}

function ScheduledTaskNotice({ session, updateSnapshot }: {
  session: Session & { schedule: SessionSchedule };
  updateSnapshot: (value: DesktopSnapshot | ((current: DesktopSnapshot | null) => DesktopSnapshot | null) | null) => void;
}) {
  const [busy, setBusy] = useState<"run" | "cancel" | "retry" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const schedule = session.schedule;
  const localRunAt = formatDraftScheduleLocalTime(new Date(schedule.runAt));
  const uncertainOutcome = schedule.status === "failed" && schedule.failure?.includes("outcome is uncertain") === true;
  const act = async (action: "run" | "cancel" | "retry") => {
    if (busy) return;
    setBusy(action);
    setFailure(null);
    try {
      const type = action === "run"
        ? "scheduled_task.run_now"
        : action === "cancel" ? "scheduled_task.cancel" : "scheduled_task.retry";
      const response = await request(type, { scheduledTaskId: schedule.id });
      const mapped = action === "cancel" ? null : mapActiveScheduledTask(response.task);
       updateSnapshot((current) => {
         if (!current) return current;
         if (action === "cancel" && isScheduledTaskPlaceholderId(session.id)) {
           const timelines = { ...current.timelines };
           delete timelines[session.id];
           return {
             ...current,
             sessions: current.sessions.filter((candidate) => candidate.id !== session.id),
             timelines,
           };
         }
         return {
           ...current,
           sessions: replaceSession(current.sessions, session.id, {
             schedule: mapped?.sessionId === session.id ? mapped.schedule : null,
           }),
         };
       });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const title = schedule.status === "pending"
    ? `Scheduled for ${localRunAt}`
    : schedule.status === "dispatching" ? "Starting scheduled task…" : "Scheduled task could not start";
  return <section className="scheduled-task-notice" data-status={schedule.status} aria-label="Scheduled task">
    <ClockIcon />
    <div><strong>{title}</strong>{schedule.status === "dispatching" ? null : <p>{session.preview}</p>}{schedule.failure || failure ? <small role="alert">{failure ?? schedule.failure}</small> : null}{uncertainOutcome ? <small>It may already have started. Retrying can run it twice.</small> : null}</div>
    <div className="scheduled-task-actions">
      {schedule.status === "pending" ? <>
        <button type="button" disabled={busy !== null} onClick={() => void act("run")}>{busy === "run" ? <span className="spinner" /> : null}Run now</button>
        <button type="button" disabled={busy !== null} onClick={() => void act("cancel")}>Cancel</button>
      </> : null}
      {schedule.status === "failed" ? <>
        <button type="button" disabled={busy !== null} onClick={() => void act("retry")}>{busy === "retry" ? <span className="spinner" /> : null}{uncertainOutcome ? "Retry anyway" : "Retry now"}</button>
        <button type="button" disabled={busy !== null} onClick={() => void act("cancel")}>Dismiss</button>
      </> : null}
    </div>
  </section>;
}

const Conversation = forwardRef<ConversationHandle, {
  timeline: TimelineItem[] | undefined; approvals: ApprovalRequest[]; inputs: InputRequest[]; session: Session;
  workingBoundary?: SessionWorkingBoundary | undefined;
  provider?: Provider | undefined;
  notify: (message: string, tone?: "normal" | "error") => void; updateSnapshot: (value: DesktopSnapshot | ((current: DesktopSnapshot | null) => DesktopSnapshot | null) | null) => void; onAttentionMutation: () => void; prepareTurnResume: () => () => void;
  olderAvailable: boolean; loadingOlder: boolean; onLoadOlder: (() => Promise<void>) | undefined;
  onLinkOpen: (url: string) => void;
  onWorkflowOpen: (id: string) => void;
  onAnnotateSelection: (text: string, anchor: { x: number; y: number }) => void;
  onRetryQueuedNewTaskDelivery: (deliveryId: string) => void;
  onOpenSubagent: (item: TimelineItem) => void;
  onContinue: () => Promise<boolean>;
  continuePending: boolean;
  reasoningDisplay: DesktopPreferencesState["reasoningDisplay"];
  isCompacting: boolean;
  compactionKind: "automatic" | "manual" | null;
  branchRelations: readonly { session: Session; label: string }[];
  onOpenBranch: (session: Session) => void;
}>(function Conversation({ onContinue, continuePending, timeline, approvals, inputs, session, workingBoundary, provider, notify, updateSnapshot, onAttentionMutation, prepareTurnResume, olderAvailable, loadingOlder, onLoadOlder, onLinkOpen, onWorkflowOpen, onAnnotateSelection, onRetryQueuedNewTaskDelivery, onOpenSubagent, reasoningDisplay, isCompacting, compactionKind, branchRelations, onOpenBranch }, ref) {
  const scroller = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const tailSpacer = useRef<HTMLDivElement>(null);
  const activeSession = useRef<string | null>(null);
  // Reader policy is one discriminated value, persisted independently per task.
  // A task can follow its live tail or preserve one visible row; it cannot be in
  // both modes, and switching tasks restores the destination task's own policy.
  const scrollMode = useRef<ConversationScrollMode>(followTailScrollMode);
  const sessionScrollModes = useRef(new Map<string, ConversationScrollMode>());
  // A press inside the transcript is the reader aiming at something. Following the
  // tail between their press and their release slides that target out from under
  // the pointer, and a release over different content is not a click at all, so a
  // disclosure they pressed squarely simply never opens. Hold the offset still for
  // the length of the press and resume at the release.
  const pointerHeld = useRef(false);
  // Native scrollbar drags can outlive the short intent lease, especially while
  // Chromium is throttled. Keep ownership for the actual press lifetime instead
  // of widening the lease for every kind of scroll input.
  const scrollbarHeld = useRef(false);
  const measuredComposerClearance = useRef(0);
  const lastScrollTop = useRef(0);
  const loadingOlderRef = useRef(false);
  // Distance from the end of the content, held for as long as a history load is
  // in flight. A prepend never changes that distance, so re-anchoring against it
  // keeps the reader on the same line no matter how tall the arriving page is.
  const historyAnchor = useRef<number | null>(null);
  const anchoredSignature = useRef<string | null>(null);
  // The offset our last write left behind, so the scroll event it echoes can be told
  // apart from one the reader caused. Following a streaming reply writes every frame,
  // and a blanket "ignore while we are writing" flag would swallow their scrolls.
  const writtenScrollTop = useRef<number | null>(null);
  const readerScrollIntent = useRef<{ sessionId: string; until: number } | null>(null);
  const pointerOrigin = useRef<{ x: number; y: number } | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionRestoreFrame = useRef<number | undefined>(undefined);
  const loadOlderProp = useRef(onLoadOlder);
  const timelineSignature = useMemo(
    // Include the rendered size-bearing fields, not only row membership. A live
    // delta normally grows the same final row, so length/first/last alone leaves
    // FOLLOW_TAIL waiting for ResizeObserver and can expose one line-height frame
    // before the observer corrects it. This commit signature lets the single
    // layout writer apply the current atomic policy before that frame is painted.
    () => timelinePresentationSignature(timeline),
    [timeline],
  );
  const signature = useRef(timelineSignature);
  loadOlderProp.current = onLoadOlder;
  const applyScrollTop = useCallback((element: HTMLDivElement, top: number) => {
    const next = clampScrollTop(element, top);
    if (Math.abs(element.scrollTop - next) < 1) {
      lastScrollTop.current = element.scrollTop;
      return;
    }
    element.scrollTop = next;
    writtenScrollTop.current = element.scrollTop;
    lastScrollTop.current = element.scrollTop;
  }, []);
  const readerHasCurrentScrollIntent = useCallback(() => {
    const intent = readerScrollIntent.current;
    return intent !== null && intent.sessionId === activeSession.current && Date.now() <= intent.until;
  }, []);
  const markReaderScrollIntent = useCallback(() => {
    const sessionId = activeSession.current;
    if (sessionId) {
      writtenScrollTop.current = null;
      readerScrollIntent.current = { sessionId, until: Date.now() + READER_SCROLL_INTENT_MS };
    }
  }, []);
  const setScrollMode = useCallback((next: ConversationScrollMode) => {
    scrollMode.current = next;
    if (activeSession.current) sessionScrollModes.current.set(activeSession.current, next);
  }, []);
  const captureReaderAnchor = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const viewport = element.getBoundingClientRect();
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-scroll-anchor]")]
      .find((candidate) => candidate.getBoundingClientRect().bottom > viewport.top + 1);
    const id = anchor?.dataset.scrollAnchor;
    if (anchor && id) {
      const offset = anchor.getBoundingClientRect().top - viewport.top;
      const memberToken = firstScrollMemberToken(anchor.dataset.scrollMembers);
      setScrollMode({ kind: "preserve_view", anchor: { id, offset, ...(memberToken ? { memberToken } : {}) } });
    }
  }, [setScrollMode]);
  const restoreReaderAnchor = useCallback((force = false) => {
    const element = scroller.current;
    const anchor = scrollMode.current.kind === "preserve_view" ? scrollMode.current.anchor : null;
    // A reader moving the native scrollbar does not reliably deliver pointer
    // events to the page. Never let a resize correction race a gesture that the
    // scroll events themselves have identified.
    if (!element || !anchor || (!force && (readerHasCurrentScrollIntent() || scrollbarHeld.current))) {
      return false;
    }
    const target = [...element.querySelectorAll<HTMLElement>("[data-scroll-anchor]")].find((candidate) =>
      scrollAnchorMatches(anchor, candidate.dataset.scrollAnchor, candidate.dataset.scrollMembers));
    if (!target) {
      return false;
    }
    const viewportTop = element.getBoundingClientRect().top;
    const bounds = target.getBoundingClientRect();
    // If the exact row was folded into a now-short Reasoning control, its old
    // deep negative offset is no longer meaningful. Put the surviving control at
    // the reading edge instead of letting the browser clamp to the document end.
    const foldedIntoGroup = target.dataset.scrollAnchor !== anchor.id
      && target.dataset.scrollMembers?.split("|").includes(encodeURIComponent(anchor.id)) === true;
    const desiredOffset = foldedIntoGroup && anchor.offset < 0 && bounds.height < -anchor.offset + 24 ? 0 : anchor.offset;
    const requestedScrollTop = element.scrollTop + bounds.top - viewportTop - desiredOffset;
    applyScrollTop(element, requestedScrollTop);
    return true;
  }, [applyScrollTop, readerHasCurrentScrollIntent]);
  const scheduleSessionAnchorRestore = useCallback((sessionId: string) => {
    if (sessionRestoreFrame.current !== undefined) window.cancelAnimationFrame(sessionRestoreFrame.current);
    let attemptsRemaining = SESSION_ANCHOR_RESTORE_FRAMES;
    const attempt = () => {
      sessionRestoreFrame.current = undefined;
      if (activeSession.current !== sessionId || scrollMode.current.kind !== "preserve_view" || readerHasCurrentScrollIntent()) {
        return;
      }
      restoreReaderAnchor();
      attemptsRemaining -= 1;
      if (attemptsRemaining > 0) sessionRestoreFrame.current = window.requestAnimationFrame(attempt);
    };
    sessionRestoreFrame.current = window.requestAnimationFrame(attempt);
  }, [readerHasCurrentScrollIntent, restoreReaderAnchor]);
  const scrollToLatest = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setScrollMode(followTailScrollMode);
    applyScrollTop(element, element.scrollHeight);
  }, [applyScrollTop, setScrollMode]);
  /** Following live output: skipped while the reader is pressing, resumed on release. */
  const followTail = useCallback(() => {
    if (historyAnchor.current !== null || scrollMode.current.kind !== "follow_tail" || pointerHeld.current) return;
    scrollToLatest();
  }, [scrollToLatest]);
  const releaseHistoryAnchor = useCallback(() => {
    historyAnchor.current = null;
    anchoredSignature.current = null;
    loadingOlderRef.current = false;
  }, []);
  const prepareForSubmission = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    // The composition will collapse immediately after this sample. Decide from
    // the reader's current physical position, not from an older saved mode.
    readerScrollIntent.current = null;
    writtenScrollTop.current = null;
    lastScrollTop.current = element.scrollTop;
    if (isAtPhysicalBottom(element)) {
      releaseHistoryAnchor();
      scrollToLatest();
      return;
    }
    setScrollMode({ kind: "preserve_view", anchor: null });
    captureReaderAnchor();
  }, [captureReaderAnchor, releaseHistoryAnchor, scrollToLatest, setScrollMode]);
  useImperativeHandle(ref, () => ({ prepareForSubmission }), [prepareForSubmission]);
  useEffect(() => () => {
    if (releaseTimer.current !== undefined) clearTimeout(releaseTimer.current);
    if (sessionRestoreFrame.current !== undefined) window.cancelAnimationFrame(sessionRestoreFrame.current);
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    const composer = element?.parentElement?.querySelector<HTMLElement>(".composer-wrap");
    const spacer = tailSpacer.current;
    if (!element || !spacer) return;
    if (!composer) {
      measuredComposerClearance.current = 0;
      spacer.style.height = "0px";
      if (session.schedule) applyScrollTop(element, 0);
      return;
    }
    let followFrame: number | undefined;
    const measure = () => {
      const viewportBounds = element.getBoundingClientRect();
      const composerBounds = composer.getBoundingClientRect();
      const next = Math.max(0, Math.ceil(viewportBounds.bottom - composerBounds.top + LIVE_OUTPUT_GAP_PX));
      if (measuredComposerClearance.current === next) return;
      measuredComposerClearance.current = next;
      // Whether we are following is already settled state; re-deriving it from the
      // reader's offset here would re-attach anyone who stepped only a little way
      // off the tail every time the composer changed height.
      const shouldFollow = historyAnchor.current === null && scrollMode.current.kind === "follow_tail";
      spacer.style.height = `${next}px`;
      if (followFrame !== undefined) window.cancelAnimationFrame(followFrame);
      if (shouldFollow) {
        setScrollMode(followTailScrollMode);
        followFrame = window.requestAnimationFrame(() => {
          followFrame = undefined;
          if (measuredComposerClearance.current === next && scrollMode.current.kind === "follow_tail") scrollToLatest();
        });
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    observer?.observe(composer);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer?.disconnect();
      if (followFrame !== undefined) window.cancelAnimationFrame(followFrame);
      window.removeEventListener("resize", measure);
    };
  }, [applyScrollTop, scrollToLatest, session.id, session.schedule, setScrollMode]);
  // One writer for the scroll position, so the history anchor and the follow-the-tail
  // behaviour can never both act on the same commit and fight each other.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (activeSession.current !== session.id) {
      if (sessionRestoreFrame.current !== undefined) {
        window.cancelAnimationFrame(sessionRestoreFrame.current);
        sessionRestoreFrame.current = undefined;
      }
      activeSession.current = session.id;
      // Intent belongs to the task where it happened. Carrying it across a task
      // switch lets the destination's own layout changes masquerade as reader
      // movement and replace its saved anchor.
      readerScrollIntent.current = null;
      scrollbarHeld.current = false;
      // Scroll echoes and offsets also belong to their source task. Prime the
      // destination before writing its saved position.
      writtenScrollTop.current = null;
      lastScrollTop.current = element.scrollTop;
      releaseHistoryAnchor();
      signature.current = timelineSignature;
      scrollMode.current = sessionScrollModes.current.get(session.id) ?? followTailScrollMode;
      if (scrollMode.current.kind === "follow_tail") scrollToLatest();
      else {
        // Correct this paint immediately, then keep a three-frame settling guard:
        // rows can already exist while a loading/relationship control above them
        // lands one paint later. Later attempts are non-forced so real input wins.
        restoreReaderAnchor(true);
        scheduleSessionAnchorRestore(session.id);
      }
      return;
    }
    if (historyAnchor.current !== null) {
      // A live provider can append below the reader while an older page is
      // prepended above them. Distance from the end cannot distinguish those two
      // directions and moves the viewport when both happen together. Once the
      // transcript itself changes, hold the concrete visible row instead; retain
      // the distance fallback only for the spinner-only commit or an empty view.
      if (anchoredSignature.current !== timelineSignature && scrollMode.current.kind === "preserve_view" && scrollMode.current.anchor) restoreReaderAnchor(true);
      else applyScrollTop(element, anchoredScrollTop(element, historyAnchor.current));
      // Release only once the page itself is on screen: the spinner appearing is a
      // separate commit, and letting go there would leave the real prepend unanchored.
      if (anchoredSignature.current !== timelineSignature && !loadingOlder) releaseHistoryAnchor();
      signature.current = timelineSignature;
      return;
    }
    const timelineChanged = signature.current !== timelineSignature;
    signature.current = timelineSignature;
    if (scrollMode.current.kind === "follow_tail") followTail();
    // Returning to a task normally restores against rows already in the DOM. If
    // its visible timeline was briefly absent, that first attempt has no target;
    // retry when the task's rows actually commit. Keep this non-forced so a real
    // wheel, touch, keyboard, or native-scrollbar gesture still wins the race.
    else if (timelineChanged) restoreReaderAnchor();
  }, [applyScrollTop, followTail, loadingOlder, releaseHistoryAnchor, restoreReaderAnchor, scheduleSessionAnchorRestore, scrollToLatest, session.id, timelineSignature]);
  useEffect(() => {
    const element = conversation.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (historyAnchor.current !== null) return;
      if (scrollMode.current.kind === "follow_tail") followTail();
      else restoreReaderAnchor();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [followTail, restoreReaderAnchor, session.id]);
  useEffect(() => {
    // The release can land anywhere — a press that began on a row often ends after
    // the pointer has left it — so the whole window reports it, not the transcript.
    // A window that loses focus mid-press never reports one at all, and the tail
    // has to start moving again on its own rather than waiting for a release that
    // is no longer coming.
    const release = () => {
      scrollbarHeld.current = false;
      if (!pointerHeld.current) return;
      pointerHeld.current = false;
      pointerOrigin.current = null;
      followTail();
    };
    const move = (event: PointerEvent) => {
      const origin = pointerOrigin.current;
      if (!pointerHeld.current || !origin) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4) markReaderScrollIntent();
    };
    const pressScrollbar = (event: PointerEvent) => {
      const element = scroller.current;
      if (event.button !== 0 || !element || event.target !== element) return;
      const bounds = element.getBoundingClientRect();
      const scrollbarWidth = Math.max(0, element.offsetWidth - element.clientWidth);
      const scrollbarStart = bounds.left + element.clientLeft + element.clientWidth;
      if (scrollbarWidth <= 0 || event.clientX < scrollbarStart || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
      pointerHeld.current = true;
      scrollbarHeld.current = true;
      pointerOrigin.current = { x: event.clientX, y: event.clientY };
      markReaderScrollIntent();
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      markReaderScrollIntent();
    };
    window.addEventListener("pointerdown", pressScrollbar, true);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("pointermove", move);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerdown", pressScrollbar, true);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", release);
    };
  }, [followTail, markReaderScrollIntent]);
  const loadOlder = useCallback(async () => {
    const element = scroller.current;
    const load = loadOlderProp.current;
    if (!element || !load || !olderAvailable || loadingOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    // A task reopened near the prefetch edge can request its next page without
    // reader input. Keep that task's frozen anchor; only establish a fresh one
    // when none exists or the current reader actually chose a new position.
    if (scrollMode.current.kind !== "preserve_view" || scrollMode.current.anchor === null || readerHasCurrentScrollIntent()) captureReaderAnchor();
    anchoredSignature.current = signature.current;
    historyAnchor.current = distanceFromEnd(element);
    if (releaseTimer.current !== undefined) clearTimeout(releaseTimer.current);
    try {
      await load();
    } finally {
      // Nothing arrived — a rejected page, or a request the loader declined. Hand
      // scrolling back rather than leaving the reader pinned to a stale anchor. A
      // timer rather than a frame, so an occluded window still releases the guard.
      releaseTimer.current = setTimeout(() => {
        releaseTimer.current = undefined;
        if (anchoredSignature.current === signature.current) releaseHistoryAnchor();
      }, 300);
    }
  }, [captureReaderAnchor, loadingOlder, olderAvailable, readerHasCurrentScrollIntent, releaseHistoryAnchor]);
  useEffect(() => {
    // A page that lands entirely above the fold parks the reader on the ceiling with
    // no further scroll event to ask for the next one.
    const element = scroller.current;
    if (element && historyAnchor.current === null && element.scrollTop <= 1) void loadOlder();
  });
  return <div className="conversation-scroll" ref={scroller} onPointerDown={(event) => {
    // Only the button that can actually activate something. A right-press opens a
    // menu whose release the window never sees, which would strand the guard on.
    if (event.button === 0) {
      pointerHeld.current = true;
      pointerOrigin.current = { x: event.clientX, y: event.clientY };
    }
  }} onWheel={(event) => {
    // Unambiguous intent, and the only signal that survives a reply streaming in:
    // stop following the moment the reader turns the wheel back.
    if (event.deltaY !== 0) markReaderScrollIntent();
    if (event.deltaY < 0 && scrollMode.current.kind === "follow_tail") setScrollMode({ kind: "preserve_view", anchor: null });
  }} onScroll={(event) => {
    const element = event.currentTarget;
    const echoed = writtenScrollTop.current !== null && Math.abs(element.scrollTop - writtenScrollTop.current) <= 1;
    // Scroll offsets are not proof of input: a transient one-frame height clamp
    // can report after the content has returned to the same final geometry. Only
    // wheel, touch/pointer, keyboard, or scrollbar-gutter input owns the position.
    const readerInitiated = !echoed && (readerHasCurrentScrollIntent() || scrollbarHeld.current);
    const steppedOffEnd = readerInitiated && movedOffEnd(element, lastScrollTop.current);
    if (readerInitiated) markReaderScrollIntent();
    const readerAboveEnd = readerInitiated && !isAtPhysicalBottom(element);
    const returnedToEnd = !echoed && readerReturnedToEnd(element, lastScrollTop.current, readerInitiated);
    writtenScrollTop.current = null;
    lastScrollTop.current = element.scrollTop;
    if (!echoed && !readerInitiated) {
      // An unowned move came from layout/browser clamping. Reinstate the active
      // atomic policy instead of silently turning that movement into user state.
      if (historyAnchor.current !== null) applyScrollTop(element, anchoredScrollTop(element, historyAnchor.current));
      else if (scrollMode.current.kind === "follow_tail") followTail();
      else restoreReaderAnchor();
      return;
    }
    // Order matters: a reader moving away is inside the follow gap for the first
    // frames of the gesture, so asking "are they near the bottom" first re-pins
    // them mid-scroll and the next commit drops them back at the tail. Their own
    // movement off the end is the answer; the gap only decides when they arrive.
    if (readerAboveEnd || steppedOffEnd) {
      const anchor = scrollMode.current.kind === "preserve_view" ? scrollMode.current.anchor : null;
      setScrollMode({ kind: "preserve_view", anchor });
    }
    else if (returnedToEnd) {
      setScrollMode(followTailScrollMode);
    }
    // Record only a position the reader actually chose. Passive layout movement
    // must leave the saved anchor intact so the layout/timeline restore can put
    // that same row back; the concrete gesture handlers cover real navigation.
    if (readerInitiated && scrollMode.current.kind === "preserve_view") captureReaderAnchor();
    // Follow the reader through an in-flight load instead of yanking them back.
    if (historyAnchor.current !== null && readerInitiated) historyAnchor.current = distanceFromEnd(element);
    if (shouldRequestOlder(element)) void loadOlder();
  }}>
    <div className="conversation" ref={conversation}>
      {olderAvailable || loadingOlder ? <div className="history-loading" data-busy={loadingOlder ? "true" : "false"} {...(loadingOlder ? { role: "status", "aria-label": "Loading earlier messages" } : { "aria-hidden": true })}><span className="spinner" /></div> : null}
      {timeline === undefined || (session.schedule && timeline.length === 0) ? null : <div className="conversation-date"><span />Today<span /></div>}
      {session.schedule ? <ScheduledTaskNotice session={session as Session & { schedule: SessionSchedule }} updateSnapshot={updateSnapshot} /> : null}
      {branchRelations.length ? <nav className="task-relationship-notices" aria-label="Task relationships">{branchRelations.map((relation) => <button type="button" key={`${relation.session.id}:${relation.label}`} aria-label={relation.label} onClick={() => onOpenBranch(relation.session)}><BranchIcon /><span>{relation.label}</span></button>)}</nav> : null}
      {timeline === undefined ? <TranscriptSkeleton /> : timeline.length === 0 && approvals.length === 0 && inputs.length === 0 && !session.schedule ? <EmptyState icon={<ChatIcon />} title="No messages yet" description="Send the first instruction to begin this task." /> : null}
      {timeline ? <ChatTimeline timeline={timeline} providerId={session.providerId} provider={provider} providerStatus={session.providerStatus} onLinkOpen={onLinkOpen} onWorkflowOpen={onWorkflowOpen} onAnnotateSelection={onAnnotateSelection} annotationOwnerId={session.id} onContinue={onContinue} continuePending={continuePending} onRetryQueuedNewTaskDelivery={onRetryQueuedNewTaskDelivery} onOpenSubagent={onOpenSubagent} reasoningDisplay={reasoningDisplay} isCompacting={isCompacting} compactionKind={compactionKind} active={sessionPresentsLiveTurn(session, timeline, workingBoundary)}/> : null}
      {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onRespond={async (choiceId) => {
        try {
          const rejected = choiceId.toLowerCase().includes("reject");
          const commitResumeBoundary = rejected ? null : prepareTurnResume();
          await request("approval.respond", { requestId: approval.id, choiceId, respondedAt: new Date().toISOString() });
          commitResumeBoundary?.();
          onAttentionMutation();
          updateSnapshot((current) => current ? { ...current, approvals: current.approvals.filter((item) => item.id !== approval.id), sessions: replaceSession(current.sessions, session.id, { state: rejected ? "idle" : "working" }) } : current);
          notify("Approval response sent");
        } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
      }} />)}
      {inputs.map((input) => <QuestionCard key={input.id} request={input} onLinkOpen={onLinkOpen} onSubmit={async (answers) => {
        try {
          const commitResumeBoundary = prepareTurnResume();
          await request("user_input.respond", { requestId: input.id, answers, respondedAt: new Date().toISOString() });
          commitResumeBoundary();
          onAttentionMutation();
          updateSnapshot((current) => current ? { ...current, inputRequests: current.inputRequests.filter((item) => item.id !== input.id), sessions: current.sessions.map((item) => item.id === session.id && item.state === "needs_input" ? { ...item, state: "working" } : item) } : current);
          notify("Answer sent");
        } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); throw error; }
      }} />)}
      <div className="conversation-tail-spacer" ref={tailSpacer} aria-hidden="true" />
    </div>
  </div>;
});

function ApprovalCard({ approval, onRespond }: { approval: ApprovalRequest; onRespond: (choiceId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <article className="request-card approval-card"><div className="request-icon"><ShieldIcon /></div><div className="request-content"><p className="eyebrow">Permission required</p><h3>{approval.title}</h3><p>{approval.reason}</p>{approval.command ? <pre><TerminalIcon />{approval.command}</pre> : null}<dl>{approval.directory ? <><dt>Directory</dt><dd>{approval.directory}</dd></> : null}{approval.files?.length ? <><dt>Files</dt><dd>{approval.files.join(", ")}</dd></> : null}</dl><div className="request-actions">{approval.choices.map((choice) => <Button key={choice.id} variant={choice.kind === "approve" ? "primary" : "secondary"} disabled={busy} onClick={async () => { setBusy(true); await onRespond(choice.id); setBusy(false); }}>{choice.label}</Button>)}</div></div></article>;
}


function Dashboard({ snapshot, runtimeConnectionState, sessions, onOpen, onNew, onProvider }: { snapshot: DesktopSnapshot; runtimeConnectionState: RuntimeConnectionPresentation; sessions: readonly Session[]; onOpen: (id: string) => void; onNew: () => void; onProvider: (id: ProviderFilterSelection) => void }) {
  const working = sessions.filter((session) => session.state === "working");
  const attention = sessions.filter((session) => session.state === "needs_approval" || session.state === "needs_input" || session.state === "failed");
  const recent = [...sessions].sort(compareOrganizedSessions).slice(0, 6);
  const active = working[0] ?? attention[0];
  return <main className="dashboard-page">
    <header className="page-heading"><h1>Dashboard</h1><Button variant="primary" onClick={onNew}><PlusIcon /><span>New task</span></Button></header>
    {runtimeConnectionState === "offline" ? <ErrorBanner title="Local runtime is offline" message="Your cached tasks are still visible. Reconnect the runtime to send instructions or approve actions." /> : null}
    <section className="dashboard-grid">
      <article className="active-task-card">
        <div className="card-heading"><span>{active ? <Status state={active.state} compact /> : null}Active now</span>{active ? <ProviderLabel providerId={active.providerId} provider={providerFor(snapshot.providers, active.providerId)} logoSize={32} /> : null}</div>
        {active ? <button onClick={() => onOpen(active.id)}><div><h2>{active.title}</h2><p>{active.preview}</p></div><div className="active-task-footer"><span><FolderIcon />{active.project}</span><span>{relativeTime(active.updatedAt)}</span></div></button> : <EmptyState icon={<CheckIcon />} title="Nothing running" description="Start a task when you are ready." />}
      </article>
      <article className="attention-card"><div className="card-heading"><span className="attention-heading">Needs attention <b>{attention.length}</b></span></div>{attention.length ? attention.slice(0, 3).map((session) => <button key={session.id} onClick={() => onOpen(session.id)}><ProviderLogo providerId={session.providerId} provider={providerFor(snapshot.providers, session.providerId)} size={25}/><span><strong>{session.title}</strong><small>{session.preview}</small></span><Status state={session.state} compact/><ChevronRightIcon /></button>) : <EmptyState icon={<ShieldIcon />} title="You’re all clear" description="Approvals and questions will appear here." />}</article>
    </section>
    <section className="recent-section"><div className="section-title"><h2>Recent tasks</h2><button onClick={() => onProvider("all")}>View all <ChevronRightIcon /></button></div><div className="recent-table"><div className="recent-table-head"><span>Task</span><span>Coding tool</span><span>Project</span><span>Status</span><span>Updated</span></div>{recent.map((session) => { const provider = providerFor(snapshot.providers, session.providerId); return <button key={session.id} onClick={() => onOpen(session.id)}><span><ProviderLogo providerId={session.providerId} provider={provider} size={30}/><strong>{session.title}</strong></span><span>{providerDisplayName(session.providerId, provider)}</span><span>{session.project}</span><Status state={session.state} compact showLabel/><time>{relativeTime(session.updatedAt)}</time></button>; })}</div></section>
  </main>;
}

function connectorFilesystemLabel(value: DesktopConnectorDescriptor["permissions"]["filesystem"]): string {
  if (value === "workspace") return "Workspace only";
  if (value === "unrestricted") return "Unrestricted";
  return "No file access";
}

function ConnectorCard({ connector, provider, onDisable }: { connector: DesktopConnectorDescriptor; provider?: Provider | undefined; onDisable: () => void }) {
  const capabilities = [
    { label: "Attachments", enabled: connector.capabilities.attachments },
    { label: "Reasoning effort", enabled: connector.capabilities.reasoningEfforts },
    { label: "Message queue", enabled: connector.capabilities.messageQueue },
  ];
  const state = provider?.state ?? "online";
  return <details className="connector-card" data-connector-id={connector.id}>
    <summary className="connector-card-heading">
      <ProviderLogo providerId={connector.id} provider={provider ?? { id: connector.id, name: connector.name }} size={34}/>
      <span className="connector-identity"><strong>{connector.name}</strong><small>v{connector.version}</small></span>
      <i className={`connection-dot ${state}`} data-tooltip={state === "online" ? "Connected" : state === "error" ? "Connection error" : "Offline"} />
      <span className="connector-disclosure"><span>Details</span><ChevronDownIcon className="details-chevron" /></span>
    </summary>
    <div className="connector-card-detail">
      <dl className="connector-permissions" aria-label={`${connector.name} declared permissions`}>
        <div><dt>Files</dt><dd>{connectorFilesystemLabel(connector.permissions.filesystem)}</dd></div>
        <div><dt>Network</dt><dd>{connector.permissions.network ? "Allowed" : "None"}</dd></div>
        <div><dt>Processes</dt><dd>{connector.permissions.spawnProcesses ? "Allowed" : "None"}</dd></div>
      </dl>
      <div className="connector-capabilities" aria-label={`${connector.name} capabilities`}>{capabilities.filter((capability) => capability.enabled).map((capability) => <span key={capability.label}><CheckIcon />{capability.label}</span>)}</div>
      <Button variant="ghost" onClick={onDisable}>Disable</Button>
    </div>
  </details>;
}

function PendingConnectorCard({ connector, onReview }: { connector: PendingDesktopConnectorDescriptor; onReview: () => void }) {
  return <details className="connector-card pending" data-connector-id={connector.id}>
    <summary className="connector-card-heading">
      <ProviderLogo providerId={connector.id} provider={{ id: connector.id, name: connector.name }} size={34}/>
      <span className="connector-identity"><strong>{connector.name}</strong><small>Review before enabling</small></span>
      <i className="connection-dot pending" data-tooltip="Review required" />
      <span className="connector-disclosure"><span>Details</span><ChevronDownIcon className="details-chevron" /></span>
    </summary>
    <div className="connector-card-detail">
      <dl className="connector-permissions" aria-label={`${connector.name} requested permissions`}>
        <div><dt>Files</dt><dd>{connectorFilesystemLabel(connector.permissions.filesystem)}</dd></div>
        <div><dt>Network</dt><dd>{connector.permissions.network ? "Requested" : "None"}</dd></div>
        <div><dt>Processes</dt><dd>{connector.permissions.spawnProcesses ? "Requested" : "None"}</dd></div>
      </dl>
      <Button onClick={onReview}><ShieldIcon /> Review</Button>
    </div>
  </details>;
}

function ConnectorReviewModal({ connector, busy, onClose, onApprove }: { connector: PendingDesktopConnectorDescriptor; busy: boolean; onClose: () => void; onApprove: () => void }) {
  const environment = connector.requestedEnvironmentNames.length ? connector.requestedEnvironmentNames.join(", ") : "None";
  return <Modal title={`Enable ${connector.name}?`} eyebrow="Independent third-party connector" onClose={onClose} wide><div className="connector-review-modal">
    <div className="connector-review-warning"><AlertIcon /><span><strong>This connector will run executable code on your computer.</strong><p>Tethoq has not reviewed, endorsed, or certified it. Enable it only if you trust its source and have confirmed its provider integration is authorized and complies with the provider's terms.</p></span></div>
    <dl>
      <div><dt>Connector</dt><dd>{connector.id} · {connector.version}</dd></div>
      <div><dt>Location</dt><dd><code>{connector.directory}</code></dd></div>
      <div><dt>Command</dt><dd><code>{[connector.runtime.command, ...connector.runtime.args].join(" ")}</code></dd></div>
      <div><dt>Environment access</dt><dd>{environment}</dd></div>
      <div><dt>Filesystem</dt><dd>{connectorFilesystemLabel(connector.permissions.filesystem)}</dd></div>
      <div><dt>Network</dt><dd>{connector.permissions.network ? "Requested" : "Not requested"}</dd></div>
      <div><dt>Child processes</dt><dd>{connector.permissions.spawnProcesses ? "Requested" : "Not requested"}</dd></div>
      <div><dt>Fingerprint</dt><dd><code>{connector.fingerprint}</code></dd></div>
    </dl>
    <p className="connector-policy-note">These permission declarations are informational, not an operating-system sandbox. Credentials must stay with the provider's local tool or this connector. Tethoq does not store provider secrets for community connectors. Any file, manifest, or execution-plan change invalidates this approval and requires review again.</p>
    <div className="modal-actions"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={onApprove}><ShieldIcon />{busy ? "Enabling…" : "Enable after restart"}</Button></div>
  </div></Modal>;
}

function SettingsPage({ snapshot, runtimeConnectionState, bootstrap, recorder, workflows, selectedWorkflowId, onSelectWorkflow, setWorkflows, onSaveWorkflow, onClose, onDirectApiSetup, onConnectorState, notify, onReconnect, preferences, onSetExperimentalFeatures, onSetReasoningDisplay, onSetDesktopBehavior, onSetAgentDefault }: {
  snapshot: DesktopSnapshot;
  runtimeConnectionState: RuntimeConnectionPresentation;
  bootstrap?: DesktopBootstrap;
  recorder: RecorderState;
  workflows: readonly WorkflowDescriptor[];
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string | null) => void;
  setWorkflows: (value: readonly WorkflowDescriptor[] | ((current: readonly WorkflowDescriptor[]) => readonly WorkflowDescriptor[])) => void;
  onSaveWorkflow: () => void;
  onClose: () => void;
  onDirectApiSetup: () => void;
  onConnectorState: (connectors: DesktopBootstrap["connectors"]) => void;
  notify: (message: string, tone?: "normal" | "error") => void;
  onReconnect: (id: string) => Promise<void>;
  preferences: DesktopPreferencesState;
  onSetExperimentalFeatures: (enabled: boolean) => Promise<void>;
  onSetReasoningDisplay: (value: DesktopPreferencesState["reasoningDisplay"]) => Promise<void>;
  onSetDesktopBehavior: (action: PreferencesAction) => Promise<void>;
  onSetAgentDefault: (providerId: string, modelId: string, reasoningEffort?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<PendingDesktopConnectorDescriptor | null>(null);
  const [setupHarness, setSetupHarness] = useState("opencode");
  const rejectedConnectors = bootstrap?.connectors.diagnostics.filter((diagnostic) => diagnostic.state === "rejected") ?? [];
  const connectorAction = async (type: "approve" | "revoke", fingerprint: string) => {
    if (isBrowserPreview) { notify("Connector trust changes are available in the installed desktop app"); return; }
    setBusy(fingerprint);
    try {
      const result = await window.tethoqDesktop.connectorAction({ type, fingerprint });
      onConnectorState(result.connectors);
      setReviewing(null);
      notify(type === "approve" ? "Connector approved. Restart Tethoq to enable it." : "Disabled now. Restart Tethoq to complete cleanup.");
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(null); }
  };
  const startWorkflow = async () => {
    try {
      if (!isBrowserPreview) await window.tethoqDesktop.recorderAction({ type: "start" });
      notify("Recording started. Screen and input capture are active.");
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const revealWorkflow = async (id: string) => { if (!isBrowserPreview) await window.tethoqDesktop.recorderAction({ type: "reveal", id }); };
  const deleteWorkflow = async (id: string) => {
    if (!isBrowserPreview) await window.tethoqDesktop.recorderAction({ type: "delete", id });
    setWorkflows((items) => items.filter((item) => item.id !== id));
    if (selectedWorkflowId === id) onSelectWorkflow(null);
    notify("Workflow deleted");
  };
  const listWorkflowScreenshots = useCallback(async (id: string): Promise<readonly WorkflowScreenshot[]> => {
    if (isBrowserPreview) return id === previewWorkflowId ? previewWorkflowScreenshots : [];
    const result = await window.tethoqDesktop.recorderAction({ type: "screenshots", id });
    return Array.isArray(result) ? result as WorkflowScreenshot[] : [];
  }, []);
  const loadWorkflowScreenshot = useCallback(async (id: string, frameId: string, variant: "thumbnail" | "full"): Promise<WorkflowScreenshotImage> => {
    if (isBrowserPreview) {
      if (id !== previewWorkflowId || !previewWorkflowScreenshots.some((item) => item.frameId === frameId)) throw new Error("Screenshot not found");
      return previewWorkflowScreenshot(frameId);
    }
    const result = await window.tethoqDesktop.recorderAction({ type: "screenshot-data", id, frameId, variant });
    if (result && !Array.isArray(result) && "dataUrl" in result) return result as WorkflowScreenshotImage;
    throw new Error("Screenshot data is unavailable");
  }, []);
  return <main className="settings-page settings-simplified" id="settings-page">
    <button className="settings-close-button" type="button" aria-label="Close settings" data-tooltip="Close settings" onClick={onClose}><XIcon /></button>
    <AgentDefaultsSettings snapshot={snapshot} preferences={preferences} onChange={onSetAgentDefault} onGlobalAgentsAction={onSetDesktopBehavior} onReconnect={onReconnect} onDirectApiSetup={onDirectApiSetup} onHarnessSetup={(id) => { setSetupHarness(id); document.getElementById("harness-connections")?.scrollIntoView({ block: "start" }); }} />
    <HarnessConnections snapshot={snapshot} {...(bootstrap ? { bootstrap } : {})} selected={setupHarness} onSelect={setSetupHarness} onReconnect={onReconnect} onDirectApiSetup={onDirectApiSetup} notify={notify} />
    <WorkflowSettings recorder={recorder} workflows={workflows} selectedWorkflowId={selectedWorkflowId} onSelectWorkflow={onSelectWorkflow} onStart={startWorkflow} onSave={onSaveWorkflow} onReveal={revealWorkflow} onDelete={deleteWorkflow} onListScreenshots={listWorkflowScreenshots} onLoadScreenshot={loadWorkflowScreenshot} />
    <DictationSettings request={request} notify={notify} />
    {bootstrap?.connectors ? <section className="settings-block connector-section"><header><h2>External connectors</h2><span className="settings-info" tabIndex={0} data-tooltip="Independent connectors run local code. Use trusted sources."><InfoIcon /></span></header><div className="connector-settings"><button className="connector-directory-action" onClick={() => { if (!isBrowserPreview) void window.tethoqDesktop.revealPath(bootstrap.connectors.directory); }}><FolderIcon /><strong>Connector folder</strong>{bootstrap.connectors.loaded.length || bootstrap.connectors.pending.length ? <small>{bootstrap.connectors.loaded.length} active · {bootstrap.connectors.pending.length} to review</small> : null}</button><div className="connector-list">{bootstrap.connectors.pending.map((connector) => <PendingConnectorCard key={connector.fingerprint} connector={connector} onReview={() => setReviewing(connector)} />)}{bootstrap.connectors.loaded.map((connector) => <ConnectorCard key={connector.id} connector={connector} provider={providerFor(snapshot.providers, connector.id)} onDisable={() => void connectorAction("revoke", connector.fingerprint)} />)}</div>{rejectedConnectors.length ? <details className="settings-alert-details"><summary><AlertIcon /><strong>{rejectedConnectors.length} connector {rejectedConnectors.length === 1 ? "issue" : "issues"}</strong><ChevronDownIcon /></summary><div>{rejectedConnectors.map((diagnostic, index) => <article key={`${diagnostic.directory}-${index}`}><strong>{diagnostic.connectorId ?? "Unknown connector"}</strong><p>{diagnostic.message}</p></article>)}</div></details> : null}</div></section> : null}
    <div className="settings-compact-grid"><details className="settings-compact-details"><summary><strong>Local runtime</strong><i className={`connection-dot ${runtimeConnectionState === "online" ? "online" : runtimeConnectionState === "starting" ? "starting" : "error"}`} data-tooltip={`Runtime ${runtimeConnectionState}`}/><ChevronDownIcon /></summary><dl><div><dt>Tethoq</dt><dd>v{bootstrap?.app.version ?? "0.1.0"}</dd></div><div><dt>Computer</dt><dd>{snapshot.hostName}</dd></div><div><dt>Platform</dt><dd>{bootstrap?.host.platform ?? "Windows"}</dd></div><div><dt>Managed process</dt><dd>{bootstrap?.openCode.state ?? "Unknown"}</dd></div><div><dt>Address</dt><dd>{bootstrap?.openCode.url ?? "Local bridge"}</dd></div></dl></details><details className="settings-compact-details"><summary><strong>Desktop behavior</strong><ChevronDownIcon /></summary><dl>
      <div><dt>Close</dt><dd><select aria-label="Close button" value={preferences.closeAction} disabled={isBrowserPreview} title="Tasks and alerts keep running while Tethoq stays in the tray." onChange={(event) => void onSetDesktopBehavior({ type: "set-close-action", value: event.target.value === "quit" ? "quit" : "tray" })}><option value="tray">Keep running in tray</option><option value="quit">Quit Tethoq</option></select></dd></div>
      <div><dt>Alerts</dt><dd><select aria-label="Alerts" value={preferences.alerts} disabled={isBrowserPreview} title="Windows notifications while the Tethoq window is not in focus." onChange={(event) => void onSetDesktopBehavior({ type: "set-alerts", value: event.target.value === "attention" ? "attention" : event.target.value === "off" ? "off" : "all" })}><option value="all">Everything</option><option value="attention">Only when I’m needed</option><option value="off">Off</option></select></dd></div>
      <div><dt>Startup</dt><dd><select aria-label="Startup" value={preferences.launchAtLogin} disabled={isBrowserPreview} title="Starting with Windows keeps your agents reachable after a restart." onChange={(event) => void onSetDesktopBehavior({ type: "set-launch-at-login", value: event.target.value === "window" ? "window" : event.target.value === "tray" ? "tray" : "off" })}><option value="off">Launch manually</option><option value="window">Start with Windows</option><option value="tray">Start hidden in tray</option></select></dd></div>
      <div><dt>Reasoning display</dt><dd><select aria-label="Reasoning display" value={preferences.reasoningDisplay} disabled={isBrowserPreview} title="Expanded streams every thought in full as it is written and shows tool calls as their own expandable rows. It does not change model effort." onChange={(event) => void onSetReasoningDisplay(event.target.value === "expanded" ? "expanded" : "compact")}><option value="compact">Compact</option><option value="expanded">Expanded</option></select></dd></div>
    </dl></details></div>
    <section className="settings-block experimental-features-block"><header><h2>Experimental features</h2><span className="settings-info" tabIndex={0} data-tooltip="Optional capabilities that may change. Disabled by default."><InfoIcon /></span></header><div className="settings-list"><article><span><strong>Enable experimental features</strong><small>Enables optional capabilities that may change, including instant sessions and sub-agents from other coding tools.</small></span><button type="button" className={`settings-toggle ${preferences.experimentalFeatures ? "on" : ""}`} role="switch" aria-checked={preferences.experimentalFeatures} aria-label="Enable experimental features" disabled={isBrowserPreview} onClick={() => void onSetExperimentalFeatures(!preferences.experimentalFeatures)}><i /></button></article></div></section>
    {reviewing ? <ConnectorReviewModal connector={reviewing} busy={busy === reviewing.fingerprint} onClose={() => setReviewing(null)} onApprove={() => void connectorAction("approve", reviewing.fingerprint)} /> : null}
  </main>;
}

function KeyboardShortcuts({ onClose }: { onClose: () => void }) {
  const groups = [
    { title: "Tasks", shortcuts: [
      { keys: "Ctrl K", label: "Open command palette" },
      { keys: "Ctrl N", label: "Start a new task" },
      { keys: "Ctrl R", label: "Sync coding tools" },
      { keys: "Enter", label: "Send instruction" },
      { keys: "Shift Enter", label: "Add a line in the composer" },
      { keys: "↑ / ↓", label: "Recall prompts at the composer start or end" },
      { keys: "Esc", label: "Close the current menu or dialog" },
    ] },
    { title: "Browser", shortcuts: [
      { keys: "Ctrl L", label: "Focus address" },
      { keys: "Ctrl T", label: "New tab" },
      { keys: "Ctrl W", label: "Close tab" },
      { keys: "Ctrl R", label: "Reload tab" },
      { keys: "Alt ← / →", label: "Back or forward" },
    ] },
    { title: "Recording", shortcuts: [
      { keys: "Ctrl Shift F12", label: "Stop an active workflow recording" },
    ] },
  ];
  return <Modal title="Keyboard shortcuts" onClose={onClose}><div className="shortcut-cheat-sheet">{groups.map((group) => <section key={group.title}><h3>{group.title}</h3><dl>{group.shortcuts.map((shortcut) => <div key={`${group.title}:${shortcut.keys}`}><dt><kbd>{shortcut.keys}</kbd></dt><dd>{shortcut.label}</dd></div>)}</dl></section>)}<div className="modal-actions"><Button type="button" onClick={onClose}>Close</Button></div></div></Modal>;
}

const settingsSearchCatalogue = [
  { id: "settings:agents", targetId: "agent-defaults", label: "Agents", detail: "Connections and default models for each agent", keywords: "agent provider connection model default reasoning" },
  { id: "settings:dictation", targetId: "dictation-settings", label: "Dictation", detail: "Speech-to-text providers and API keys", keywords: "dictation voice microphone speech transcription openai xai grok api key" },
  { id: "settings:workflows", targetId: "workflow-settings", label: "Recorded workflows", detail: "Saved desktop workflows", keywords: "workflow recording automation" },
  { id: "settings:connectors", targetId: "settings-page", label: "External connectors", detail: "Trusted local integrations", keywords: "connector integration trust" },
  { id: "settings:harnesses", targetId: "harness-connections", label: "Harness connections", detail: "Connect coding tools and copy setup prompts", keywords: "harness setup install grok opencode other connect" },
  { id: "settings:desktop", targetId: "settings-page", label: "Desktop behavior", detail: "Close, alerts, startup, and reasoning display", keywords: "desktop behavior close tray quit alerts notifications startup login launch windows reasoning display" },
  { id: "settings:runtime", targetId: "settings-page", label: "Local runtime", detail: "Desktop bridge status", keywords: "runtime bridge host local" },
  { id: "settings:experimental", targetId: "settings-page", label: "Experimental features", detail: "Optional desktop capabilities", keywords: "experimental feature instant session sub-agent subagent other coding tools" },
] as const;

function settingsTargetForAction(action: string): string | undefined {
  return settingsSearchCatalogue.find((item) => item.id === action)?.targetId;
}

function CommandPalette({ snapshot, sessions, onClose, onAction }: { snapshot: DesktopSnapshot; sessions: readonly Session[]; onClose: () => void; onAction: (action: string) => void }) {
  const [query, setQuery] = useState("");
  const providerNames = snapshot.providers.map((provider) => provider.name).join(" ");
  const actions = [
    { id: "new", label: "Start a new task", detail: "Ctrl N", keywords: "new task", icon: <PlusIcon /> },
    { id: "refresh", label: "Sync coding tools", detail: "Ctrl R", keywords: "refresh sync agents providers", icon: <RefreshIcon className="refresh-icon" /> },
    { id: "settings", label: "Open settings", detail: "", keywords: "settings preferences", icon: <WorkflowIcon /> },
    { id: "shortcuts", label: "Keyboard shortcuts", detail: "Reference", keywords: "keyboard shortcut keys", icon: <KeyboardIcon /> },
    ...settingsSearchCatalogue.map((item) => ({ ...item, keywords: `${item.keywords} ${item.id === "settings:agents" ? providerNames : ""}`, icon: <WorkflowIcon /> })),
    ...sessions.map((session) => ({ id: `session:${session.id}`, label: session.title, detail: session.project, keywords: session.preview, icon: <ProviderLogo providerId={session.providerId} provider={providerFor(snapshot.providers, session.providerId)} size={21}/> })),
  ];
  const normalizedQuery = normalizeUiSearchQuery(query);
  const filtered = actions.filter((action) => normalizeUiSearchQuery(`${action.label} ${action.detail} ${action.keywords}`, 2_000).includes(normalizedQuery)).slice(0, 12);
  const [index, setIndex] = useState(0);
  return <Modal title="" label="Command palette" onClose={onClose}><div className="palette"><label><SearchIcon /><input autoFocus value={query} maxLength={maximumUiSearchCharacters} onChange={(event) => { setQuery(event.target.value.slice(0, maximumUiSearchCharacters)); setIndex(0); }} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setIndex((current) => Math.min(Math.max(0, filtered.length - 1), current + 1)); } else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((current) => Math.max(0, current - 1)); } else if (event.key === "Enter" && filtered[index]) { onAction(filtered[index].id); } }} placeholder="Search tasks or type a command…"/><kbd>Esc</kbd></label><div>{filtered.length ? filtered.map((action, actionIndex) => <button key={action.id} className={actionIndex === index ? "selected" : ""} onMouseEnter={() => setIndex(actionIndex)} onClick={() => onAction(action.id)}>{action.icon}<span>{action.label}</span><small>{action.detail}</small><kbd>↵</kbd></button>) : <EmptyState icon={<SearchIcon />} title="No commands found" description="Try another search." />}</div></div></Modal>;
}

export default App;
