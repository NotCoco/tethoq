import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { BrowserDownloadState, BrowserWorkspaceState, DesktopBootstrap, DesktopConnectorDescriptor, DesktopEventBatch, DesktopPreferencesState, DesktopRuntimeState, LocalOpenState, PendingDesktopConnectorDescriptor, PreferencesAction, RecorderState, TaskOverride, VisionProxyStatus, VisionProxyTarget, WorkflowDescriptor, WorkflowScreenshot, WorkflowScreenshotImage } from "@shared/desktop_api";
import type { JsonObject } from "../../../../../packages/protocol/src/index";
import {
  eventToTimeline,
  eventClearsProviderStatus,
  demoBrowserState,
  isBrowserPreview,
  loadInitialSnapshot,
  listChildSessions,
  listSessions,
  loadProviderModels,
  loadSessionContext,
  loadSessionTimelinePage,
  providerStatusValue,
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
import { ChatTimeline } from "./ChatTimeline";
import { AgentDefaultsSettings } from "./AgentDefaultsSettings";
import { Composer, DictationSettings, ResponseAnnotationEditor, SideChatPanel, type ComposerAttachment, type DraftModelSelection, type DraftSessionSendInput, type SideChatDraft } from "./Composer";
import { isAmbiguousSelectionValue, isPersistedCodexFinalAnswer, latestTurnHasCompletedFinal, modelAcceptsDirectAudio, parentSessionIdForBack, providerAcceptsDirectAudio, quietCatchUpDue, quietCatchUpIntervalMs, resolveConcreteModelSelection, selectedSessionLastDeltaAt, sessionHoldsFollowUpQueue, sessionNeedsTranscriptCatchUp, shouldApplySessionState, terminalTranscriptCatchUpMaxAttempts, unownedTurnFollowMs, unownedTurnSilenceMs } from "./composer_helpers";
import { mergeTimeline, reconcileTimelinePage, settleRunningTimeline } from "./timeline_merge";
import { mergeRefreshedSessions, sameSessionContext } from "./session_refresh";
import { parseResponseAnnotations, visibleResponseAnnotationBody, type ResponseAnnotation } from "./response_annotations";
import { visibleToastFeedback } from "./toast_feedback";
import { LiveSessionPanel } from "./LiveSession";
import { Sidebar, type NavigationView as View, type SessionFilter, type SideChatAnchor } from "./NavigationPanels";
import { WorkflowSettings } from "./WorkflowSettings";
import { LocalOpenProvider, WorkspaceLocalOpenControl, previewLocalOpenState, useLocalOpen, type LocalOpenLocation } from "./LocalOpen";
import { maximumUiSearchCharacters, normalizeUiSearchQuery } from "./search_helpers";
import { compareOrganizedSessions, isHiddenByArchive, matchesProviderFilters, organizeSessions } from "./task_organization";
import { HISTORY_PAGE_LIMIT, anchoredScrollTop, clampScrollTop, distanceFromEnd, historyPageNeedsRebase, isAtPhysicalBottom, movedOffEnd, readerReturnedToEnd, retainedHistoryCursor, shouldRequestOlder } from "./conversation_scroll";
import {
  Button,
  EmptyState,
  ErrorBanner,
  IconButton,
  LoadingState,
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
  BrowserIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  GlobeIcon,
  PlusIcon,
  QuestionIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  StopIcon,
  DownloadIcon,
  HomeIcon,
  InfoIcon,
  KeyboardIcon,
  LockIcon,
  MouseIcon,
  ScreenshotIcon,
  TrashIcon,
  TerminalIcon,
  XIcon,
  WorkflowIcon,
  WalletIcon,
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
  SessionState,
  TimelineItem,
} from "./types";
import tethoqIconUrl from "../../../assets/tethoq-icon.png";

const emptyResponseAnnotations: readonly ResponseAnnotation[] = Object.freeze([]);

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
  return { ...snapshot, providers: [...snapshot.providers], sessions: [...snapshot.sessions], timelines: { ...snapshot.timelines }, approvals: [...snapshot.approvals], inputRequests: [...snapshot.inputRequests], models: { ...snapshot.models } };
}

type SessionUpdate = Omit<Partial<Session>, "providerStatus"> & { providerStatus?: ProviderStatus | null };

function replaceSession(sessions: Session[], sessionId: string, update: SessionUpdate): Session[] {
  return sessions.map((session) => {
    if (session.id !== sessionId) return session;
    const { providerStatus, ...rest } = update;
    const merged = { ...session, ...rest };
    if (providerStatus) return { ...merged, providerStatus };
    if (providerStatus === null) {
      const { providerStatus: _removed, ...withoutProviderStatus } = merged;
      return withoutProviderStatus;
    }
    return merged;
  });
}

function applyOpenedSessionPreview(sessions: Session[], opened: Session | undefined): Session[] {
  if (opened === undefined) return sessions;
  const current = sessions.find((session) => session.id === opened.id);
  if (current === undefined || current.preview === opened.preview) return sessions;
  return sessions.map((session) => session.id === opened.id ? { ...session, preview: opened.preview } : session);
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
  const providerStatus = providerStatusValue(value.providerStatus);
  return {
    id: value.id,
    sessionKind,
    ...(parentSessionId ? { parentSessionId } : {}),
    providerId,
    title: typeof value.title === "string" && value.title ? value.title : `${source.title} · continuation`,
    state,
    project: typeof value.project === "string" && value.project ? value.project : workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? source.project,
    workingDirectory,
    preview: typeof value.preview === "string" ? value.preview : "Context transferred from the previous task.",
    updatedAt: typeof value.lastActivityAt === "string" ? value.lastActivityAt : new Date().toISOString(),
    model: typeof value.modelId === "string" ? value.modelId : source.model,
    effort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : source.effort,
    ...(providerStatus ? { providerStatus } : {}),
    ...(contextSummary !== undefined ? { contextSummary } : {}),
  };
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
    effort: typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : "Default",
  };
  try { return derivedSession(raw, source); }
  catch { return null; }
}

function createdSession(value: unknown, input: DraftSessionSendInput, state: SessionState, preview: string): Session {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridge returned an invalid new task.");
  const raw = value as Record<string, unknown>;
  const source: Session = {
    id: input.draftSessionId,
    providerId: input.providerId,
    title: input.content.trim().split(/\r?\n/u)[0]?.slice(0, 72) || "New task",
    state,
    project: input.workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "New project",
    workingDirectory: input.workingDirectory,
    preview,
    updatedAt: new Date().toISOString(),
    model: input.modelId,
    effort: input.effort,
  };
  const mapped = derivedSession(raw, source);
  return {
    ...mapped,
    title: source.title,
    state,
    preview,
    model: typeof raw.modelId === "string" ? raw.modelId : input.modelId,
    effort: typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : input.effort,
  };
}

function isLiveTurnEvent(event: DesktopEventBatch["events"][number]): boolean {
  if (event.type === "message.started" || event.type === "message.delta" || event.type === "tool.started" || event.type === "command.started") return true;
  return event.type === "session.status_changed" && event.payload.state === "working";
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
  loadingOlder: boolean;
}

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

function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const snapshotRef = useRef<DesktopSnapshot | null>(null);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  const [bootstrap, setBootstrap] = useState<DesktopBootstrap | undefined>();
  const [runtime, setRuntime] = useState<DesktopRuntimeState>({ state: "starting" });
  const [view, setView] = useState<View>("workspace");
  const settingsReturnView = useRef<Exclude<View, "settings">>("workspace");
  const [selectedProvider, setSelectedProvider] = useState<ProviderFilterSelection>("all");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const lastLiveDeltaAt = useRef(0);
  const lastLiveDeltaBySession = useRef(new Map<string, number>());
  // A latest-history request may begin while the stream is quiet, then resolve
  // after the next chunk arrives. Keep a per-task generation so that late page
  // cannot replace or split the live tail it predates.
  const liveTimelineGenerationBySession = useRef(new Map<string, number>());
  // Session listings are asynchronous. A per-task live revision prevents an
  // older response from restoring state (especially a retry notice) that a
  // newer event already cleared.
  const liveSessionRevisionBySession = useRef(new Map<string, number>());
  const deferredAgentCompletionTimers = useRef(new Map<string, number>());
  const lastEventSequence = useRef(0);
  const watchedSessionIds = useRef(new Set<string>());
  const selectedViewRefreshInFlight = useRef(new Set<string>());
  const selectedViewForcedRefreshQueued = useRef(new Set<string>());
  const terminalTranscriptCatchUpAttempts = useRef(new Map<string, number>());
  const wasDocumentHidden = useRef(typeof document !== "undefined" ? document.hidden : false);
  const selectedLastDelta = useCallback((sessionId: string | null): number =>
    selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, sessionId, lastLiveDeltaAt.current), []);
  const cancelDeferredAgentCompletion = useCallback((sessionId: string) => {
    const timer = deferredAgentCompletionTimers.current.get(sessionId);
    if (timer !== undefined) window.clearTimeout(timer);
    deferredAgentCompletionTimers.current.delete(sessionId);
  }, []);
  const deferAgentCompletionUntilQuiet = useCallback((sessionId: string, occurredAt: string, generation: number) => {
    cancelDeferredAgentCompletion(sessionId);
    const settleWhenQuiet = () => {
      if ((liveTimelineGenerationBySession.current.get(sessionId) ?? 0) !== generation) {
        deferredAgentCompletionTimers.current.delete(sessionId);
        return;
      }
      const lastDelta = selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, sessionId, lastLiveDeltaAt.current);
      const remaining = Math.max(0, 2_000 - (Date.now() - lastDelta));
      if (remaining > 0) {
        const timer = window.setTimeout(settleWhenQuiet, remaining);
        deferredAgentCompletionTimers.current.set(sessionId, timer);
        return;
      }
      deferredAgentCompletionTimers.current.delete(sessionId);
      setSnapshot((current) => {
        if (!current || current.sessions.find((session) => session.id === sessionId)?.state !== "working") return current;
        const timeline = current.timelines[sessionId] ?? [];
        return {
          ...current,
          sessions: replaceSession(current.sessions, sessionId, { state: "completed", updatedAt: occurredAt }),
          timelines: { ...current.timelines, [sessionId]: timeline },
        };
      });
    };
    const lastDelta = selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, sessionId, lastLiveDeltaAt.current);
    const timer = window.setTimeout(settleWhenQuiet, Math.max(1, 2_000 - (Date.now() - lastDelta)));
    deferredAgentCompletionTimers.current.set(sessionId, timer);
  }, [cancelDeferredAgentCompletion]);
  useEffect(() => () => {
    for (const timer of deferredAgentCompletionTimers.current.values()) window.clearTimeout(timer);
    deferredAgentCompletionTimers.current.clear();
  }, []);
  const modelHealAttempts = useRef(new Map<string, number>());
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
    void loadProviderModels([provider]).then((models) => {
      setSnapshot((value) => value ? { ...value, models: { ...value.models, ...models } } : value);
    }).catch(() => undefined);
  }, []);
  const ingestEventBatch = useRef<(batch: DesktopEventBatch) => void>(() => undefined);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<SessionFilter>("all");
  const [listCollapsed, setListCollapsed] = useState(false);
  const [navigationPanelWidth, setNavigationPanelWidth] = useState(initialNavigationPanelWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
  const [liveSessionOpen, setLiveSessionOpen] = useState(false);
  const [handoffSummaries, setHandoffSummaries] = useState<Record<string, string>>({});
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [composerAttachments, setComposerAttachments] = useState<Record<string, readonly ComposerAttachment[]>>({});
  const [composerAnnotations, setComposerAnnotations] = useState<Record<string, readonly ResponseAnnotation[]>>({});
  const [sideChatDrafts, setSideChatDrafts] = useState<Record<string, SideChatDraft>>({});
  const [queueingBySession, setQueueingBySession] = useState<Record<string, boolean>>({});
  const [compactionsBySession, setCompactionsBySession] = useState<Record<string, { isCompacting: boolean; kind: "automatic" | "manual" | null }>>({});
  const [timelineWindows, setTimelineWindows] = useState<Record<string, TimelineWindowState>>({});
  const narrow = useMedia("(max-width: 780px)");
  const selectedSessionIdRef = useRef<string | null>(null);
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const visibleRefreshInFlight = useRef(false);
  const openingSessionIdsRef = useRef(new Set<string>());
  const revokedConnectorIdsRef = useRef(new Set<string>());
  const sideChatsHydratedRef = useRef(false);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => { selectedSessionIdRef.current = selectedSessionId; }, [selectedSessionId]);

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
    try {
      const [result, persistedPreferences] = await Promise.all([
        loadInitialSnapshot(),
        isBrowserPreview ? Promise.resolve(initialDesktopPreferences) : window.tethoqDesktop.preferencesState().catch(() => initialDesktopPreferences),
      ]);
      const tasks = result.snapshot.sessions.filter((session) => session.sessionKind !== "side_chat" && session.sessionKind !== "internal" && session.relationshipKind !== "subagent");
      const firstAttention = tasks.find((session) => session.state === "needs_approval" || session.state === "needs_input");
      const first = tasks.find((session) => session.state === "working") ?? firstAttention ?? tasks[0];
      let initialSnapshot = result.snapshot;
      if (first) {
        try {
          const page = await loadSessionTimelinePage(first.id);
          const items = reconcileTimelinePage(page.items, result.snapshot.timelines[first.id] ?? []);
          initialSnapshot = { ...result.snapshot, sessions: applyOpenedSessionPreview(result.snapshot.sessions, page.session), timelines: { ...result.snapshot.timelines, [first.id]: items } };
          setTimelineWindows((current) => ({
            ...current,
            [first.id]: { nextCursor: page.nextCursor, revealStart: initialTimelineRevealStart(items), loadingOlder: false },
          }));
        } catch {
          const items = result.snapshot.timelines[first.id] ?? [];
          initialSnapshot = { ...result.snapshot, timelines: { ...result.snapshot.timelines, [first.id]: items } };
          setTimelineWindows((current) => ({
            ...current,
            [first.id]: { nextCursor: null, revealStart: initialTimelineRevealStart(items), loadingOlder: false },
          }));
        }
      }
      setPreferences(persistedPreferences);
      setSnapshot(initialSnapshot);
      setBootstrap(result.bootstrap);
      if (typeof result.bootstrap?.latestSequence === "number") lastEventSequence.current = result.bootstrap.latestSequence;
      setRuntime({ state: "ready" });
      setSelectedSessionId((current) => current ?? first?.id ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setRuntime({ state: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      // Reported on failure too: a window held back forever is worse than one showing
      // why it could not load, and the shell has no other way to learn the difference.
      if (!isBrowserPreview) window.tethoqDesktop.notifyReady();
    }
  }, []);

  useEffect(() => { void initialize(); }, [initialize]);

  useEffect(() => {
    if (!snapshot || sideChatsHydratedRef.current) return;
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
          const parent = current.sessions.find((session) => session.id === parentSessionId && session.sessionKind !== "side_chat");
          if (!parent) return [];
          try { return [{ ...derivedSession(raw, parent), sessionKind: "side_chat" as const, parentSessionId }]; }
          catch { return []; }
        });
        if (!mapped.length) return current;
        const ids = new Set(mapped.map((session: Session) => session.id));
        return { ...current, sessions: [...mapped, ...current.sessions.filter((session) => !ids.has(session.id))] };
      });
    }).catch(() => undefined);
  }, [snapshot]);

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
    if (isBrowserPreview) return;
    void window.tethoqDesktop.browserAction({ type: "set-visible", visible: view === "browser", ...(selectedSessionId ? { sessionId: selectedSessionId } : {}) }).then(setBrowser).catch(() => undefined);
  }, [selectedSessionId, view]);

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
    try {
      const [sessions, providers, attention] = await Promise.all([
        refreshSessions(),
        refreshProviders(),
        refreshAttention(),
      ]);
      const visibleProviders = providers.filter((provider) => !revokedConnectorIdsRef.current.has(provider.id));
      const models = await loadProviderModels(visibleProviders);
      const selected = selectedSessionIdRef.current;
      // A working turn is allowed to catch up through session/load once its
      // live stream goes quiet: the provider adapters skip history reloads
      // while chunks are still arriving, so this cannot race the stream.
      const timelinePageGeneration = selected
        ? liveTimelineGenerationBySession.current.get(selected) ?? 0
        : null;
      const timelinePage = selected && quietCatchUpDue(selectedLastDelta(selected), Date.now(), 3_000)
        ? await loadSessionTimelinePage(selected).catch(() => null)
        : null;
      const quiet = (sessionId: string): boolean => quietCatchUpDue(selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, sessionId, lastLiveDeltaAt.current), Date.now(), 2_000);
      const changedSinceRefresh = (sessionId: string): boolean =>
        (liveSessionRevisionBySession.current.get(sessionId) ?? 0) !== (sessionRevisionsAtStart.get(sessionId) ?? 0);
      setSnapshot((current) => {
        if (!current) return current;
        const refreshedIds = new Set(sessions.map((session) => session.id));
        // Refresh responses deliberately omit derived sessions (side chats and
        // delegated children), so keep locally tracked ones. Dropping an open
        // child here empties its workspace the moment any refresh lands.
        const incomingProviders = new Set(sessions.map((session) => session.providerId));
        const localOnly = current.sessions.filter((session) => (session.draft || session.sessionKind === "side_chat" || session.parentSessionId !== undefined || !incomingProviders.has(session.providerId) || changedSinceRefresh(session.id)) && !refreshedIds.has(session.id));
        return {
          ...current,
          sessions: applyOpenedSessionPreview([...localOnly, ...mergeRefreshedSessions(current.sessions, sessions, quiet, changedSinceRefresh)], timelinePage?.session),
          providers: visibleProviders,
          models,
          approvals: attention.approvals,
          inputRequests: attention.inputRequests,
          timelines: selected && timelinePage
            && (liveTimelineGenerationBySession.current.get(selected) ?? 0) === timelinePageGeneration
            ? { ...current.timelines, [selected]: reconcileTimelinePage(timelinePage.items, current.timelines[selected] ?? []) }
            : current.timelines,
        };
      });
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
          return { ...current, [selected]: { nextCursor: timelinePage.nextCursor, revealStart: initialTimelineRevealStart(timelinePage.items), loadingOlder: false } };
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
  }, [notify]);

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
        await watchSession(sessionId).catch(() => undefined);
        // Normal history reconciliation waits until streaming is quiet. A
        // terminal state is different: the final reply may have been persisted
        // just after the state flag, so read it immediately.
        if (forcedPass || quietCatchUpDue(selectedLastDelta(sessionId), Date.now(), 2_000)) {
          const generation = liveTimelineGenerationBySession.current.get(sessionId) ?? 0;
          const page = await loadSessionTimelinePage(sessionId, undefined, 40, true);
          // Reading a task is not activity. Bumping updatedAt here re-sorted the
          // recent-activity list under the pointer, so opening a chat threw it to
          // the top of the task list.
          setSnapshot((current) => {
            if (!current
              || (liveTimelineGenerationBySession.current.get(sessionId) ?? 0) !== generation
              || (!forcedPass && !quietCatchUpDue(selectedLastDelta(sessionId), Date.now(), 2_000))) return current;
            const existing = current.timelines[sessionId] ?? [];
            const merged = reconcileTimelinePage(page.items, existing);
            const reconciled = latestTurnHasCompletedFinal(merged)
              ? settleRunningTimeline(merged.filter((item) => item.id !== `${sessionId}:error:response-incomplete`))
              : merged;
            const nextSessions = applyOpenedSessionPreview(current.sessions, page.session);
            return reconciled === existing && nextSessions === current.sessions ? current : { ...current, sessions: nextSessions, timelines: { ...current.timelines, [sessionId]: reconciled } };
          });
          setTimelineWindows((current) => {
            if ((liveTimelineGenerationBySession.current.get(sessionId) ?? 0) !== generation
              || (!forcedPass && !quietCatchUpDue(selectedLastDelta(sessionId), Date.now(), 2_000))) return current;
            const existing = current[sessionId];
            if (existing?.nextCursor === page.nextCursor) return current;
            return { ...current, [sessionId]: existing
              ? { ...existing, nextCursor: retainedHistoryCursor(existing.nextCursor, page.nextCursor) }
              : { nextCursor: page.nextCursor, revealStart: initialTimelineRevealStart(page.items), loadingOlder: false } };
          });
        }
        forceNext = selectedViewForcedRefreshQueued.current.delete(sessionId);
        if (!forceNext) break;
      }
    } finally {
      selectedViewRefreshInFlight.current.delete(sessionId);
    }
  }, [selectedLastDelta]);

  const settleIncompleteTranscript = useCallback((sessionId: string) => {
    terminalTranscriptCatchUpAttempts.current.delete(sessionId);
    setSnapshot((current) => {
      if (!current) return current;
      const session = current.sessions.find((candidate) => candidate.id === sessionId);
      const timeline = current.timelines[sessionId] ?? [];
      if (!session || !sessionNeedsTranscriptCatchUp(session, timeline)) return current;
      const settled = settleRunningTimeline(timeline);
      const id = `${sessionId}:error:response-incomplete`;
      const incomplete: TimelineItem = {
        id,
        kind: "error",
        title: "Response incomplete",
        body: "The task finished, but its final reply was not available.",
        state: "failed",
        timestamp: new Date().toISOString(),
      };
      return {
        ...current,
        timelines: { ...current.timelines, [sessionId]: settled.some((item) => item.id === id) ? settled : [...settled, incomplete] },
      };
    });
  }, []);

  const catchUpTranscript = useCallback((sessionId: string, force = false, terminalHint = false) => {
    const current = snapshotRef.current;
    const session = current?.sessions.find((candidate) => candidate.id === sessionId);
    const timeline = current?.timelines[sessionId] ?? [];
    if (!session || !sessionNeedsTranscriptCatchUp(session, timeline)) {
      terminalTranscriptCatchUpAttempts.current.delete(sessionId);
      return;
    }
    if (selectedViewRefreshInFlight.current.has(sessionId)) {
      if (force) void refreshSelectedView(sessionId, true).catch(() => undefined);
      return;
    }
    const terminal = terminalHint || session.state === "idle" || session.state === "completed";
    if (terminal) {
      const attempts = terminalTranscriptCatchUpAttempts.current.get(sessionId) ?? 0;
      if (attempts >= terminalTranscriptCatchUpMaxAttempts) {
        settleIncompleteTranscript(sessionId);
        return;
      }
      terminalTranscriptCatchUpAttempts.current.set(sessionId, attempts + 1);
    }
    void refreshSelectedView(sessionId, force).catch(() => undefined);
  }, [refreshSelectedView, settleIncompleteTranscript]);

  const refreshVisibleState = useCallback(async (includeSelectedTimeline = true) => {
    if (visibleRefreshInFlight.current) return;
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
        const refreshedIds = new Set(sessions.map((session) => session.id));
        // Derived sessions (side chats and delegated children) are absent from
        // the bridge's top-level listings, so keep locally tracked ones instead
        // of letting an open delegated child vanish from its own workspace.
        const incomingProviders = new Set(sessions.map((session) => session.providerId));
        const localOnly = current.sessions.filter((session) => (session.draft || session.sessionKind === "side_chat" || session.parentSessionId !== undefined || !incomingProviders.has(session.providerId) || changedSinceRefresh(session.id)) && !refreshedIds.has(session.id));
        const nextSessions = [...localOnly, ...mergeRefreshedSessions(current.sessions, sessions, quiet, changedSinceRefresh)];
        return nextSessions.length === current.sessions.length && nextSessions.every((session, index) => session === current.sessions[index])
          ? current
          : { ...current, sessions: nextSessions };
      });
    } finally {
      visibleRefreshInFlight.current = false;
    }
  }, [refreshSelectedView]);

  useEffect(() => {
    if (!snapshot || isBrowserPreview) return;
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
          const page = await loadSessionTimelinePage(selected).catch(() => null);
          if (page) {
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
  }, [refreshSelectedView, refreshVisibleState, snapshot !== null]);

  useEffect(() => {
    if (!snapshot || isBrowserPreview) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      const selected = selectedSessionIdRef.current;
      if (!selected) return;
      if (!quietCatchUpDue(selectedLastDelta(selected), Date.now())) return;
      const current = snapshotRef.current;
      const session = current?.sessions.find((candidate) => candidate.id === selected);
      if (session && sessionNeedsTranscriptCatchUp(session, current?.timelines[selected] ?? [])) {
        catchUpTranscript(selected);
      }
      // Listing detects a turn started in another client. Settled history stays
      // untouched until that listing reports live work, so a quiet completed task
      // cannot flash every fifteen seconds merely because the heal timer fired.
      void refreshVisibleState(false).catch(() => undefined);
      healMissingModels();
    }, quietCatchUpIntervalMs);
    return () => window.clearInterval(interval);
  }, [catchUpTranscript, healMissingModels, refreshVisibleState, snapshot !== null]);

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
    if (!snapshot || isBrowserPreview) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      const selected = selectedSessionIdRef.current;
      if (!selected) return;
      const current = snapshotRef.current;
      const session = current?.sessions.find((candidate) => candidate.id === selected);
      if (!session || !sessionNeedsTranscriptCatchUp(session, current?.timelines[selected] ?? [])) return;
      if (!quietCatchUpDue(selectedLastDelta(selected), Date.now(), unownedTurnSilenceMs)) return;
      catchUpTranscript(selected);
    }, unownedTurnFollowMs);
    return () => window.clearInterval(interval);
  }, [catchUpTranscript, selectedLastDelta, snapshot !== null]);

  useEffect(() => subscribeToDesktop(
    (incoming) => {
      ingestEventBatch.current(incoming);
    },
    setRuntime,
  ), []);

  ingestEventBatch.current = (batch) => {
      lastEventSequence.current = Math.max(lastEventSequence.current, batch.latestSequence);
      // Advance this synchronously, before React applies the rows, so a history
      // promise resolving in the same turn can already see that its page is stale.
      const timelineItems = batch.events.map((event) => event.sessionId ? eventToTimeline(event) : null);
      const changedSessionIds = new Set(batch.events.flatMap((event) => event.sessionId ? [event.sessionId] : []));
      for (const sessionId of changedSessionIds) {
        liveSessionRevisionBySession.current.set(sessionId, (liveSessionRevisionBySession.current.get(sessionId) ?? 0) + 1);
      }
      const changedTimelines = new Set(batch.events.flatMap((event, index) => event.sessionId && timelineItems[index] ? [event.sessionId] : []));
      const liveTurnSessions = new Set(batch.events.flatMap((event) => event.sessionId && isLiveTurnEvent(event) ? [event.sessionId] : []));
      const advancedLiveSessions = new Set([...changedTimelines, ...liveTurnSessions]);
      for (const sessionId of advancedLiveSessions) {
        cancelDeferredAgentCompletion(sessionId);
        terminalTranscriptCatchUpAttempts.current.delete(sessionId);
        liveTimelineGenerationBySession.current.set(sessionId, (liveTimelineGenerationBySession.current.get(sessionId) ?? 0) + 1);
      }
      if (liveTurnSessions.size) {
        const now = Date.now();
        lastLiveDeltaAt.current = now;
        for (const sessionId of liveTurnSessions) lastLiveDeltaBySession.current.set(sessionId, now);
      }
      const agentCompletionActions = new Map<number, "apply" | "defer" | "ignore">();
      for (const [eventIndex, event] of batch.events.entries()) {
        if (event.type !== "agent.completed" || !event.sessionId) continue;
        const hasLaterLiveEvent = batch.events.slice(eventIndex + 1).some((candidate) => candidate.sessionId === event.sessionId && isLiveTurnEvent(candidate));
        const authoritative = isAuthoritativeOpenCodeGuardCompletion(event);
        const quiet = quietCatchUpDue(selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, event.sessionId, lastLiveDeltaAt.current), Date.now(), 2_000);
        if (!authoritative && hasLaterLiveEvent) {
          agentCompletionActions.set(eventIndex, "ignore");
        } else if (authoritative || shouldApplySessionState("completed", quiet)) {
          cancelDeferredAgentCompletion(event.sessionId);
          agentCompletionActions.set(eventIndex, "apply");
        } else {
          const generation = liveTimelineGenerationBySession.current.get(event.sessionId) ?? 0;
          deferAgentCompletionUntilQuiet(event.sessionId, event.occurredAt, generation);
          agentCompletionActions.set(eventIndex, "defer");
        }
      }
      const compactionEvents = batch.events.filter((event) => event.sessionId && (event.type === "context.compaction_started" || event.type === "context.compaction_completed"));
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
      const remotelyUpdatedSessionIds = [...new Set(batch.events.flatMap((event) => event.type === "message.remote_received" && event.sessionId ? [event.sessionId] : []))];
      // Decide follow-up work before scheduling the React state updater. React
      // may run that updater later, so mutating these flags from inside it can
      // silently lose a session-created event under normal concurrent renders.
      const attentionChanged = batch.events.some((event) => event.type === "approval.requested" || event.type === "approval.resolved" || event.type === "user_input.requested");
      const terminalChanged = batch.events.some((event) => event.type === "agent.completed" || event.type === "agent.interrupted" || event.type === "agent.error" || isPersistedCodexFinalAnswer(event));
      const selectedTerminalCompletion = batch.events.some((event, eventIndex) => {
        if (!event.sessionId || event.sessionId !== selectedSessionIdRef.current) return false;
        if (event.type === "agent.completed") return agentCompletionActions.get(eventIndex) !== "ignore";
        if (event.type !== "session.updated" && event.type !== "session.status_changed") return false;
        return event.payload.state === "idle" || event.payload.state === "completed";
      });
      let refreshSessionsNeeded = batch.replayGap || remotelyUpdatedSessionIds.length > 0
        || attentionChanged || batch.events.some((event) => event.type === "session.created");
      let refreshProvidersNeeded = batch.replayGap || batch.events.some((event) => event.type === "provider.connected" || event.type === "provider.disconnected");
      let refreshAttentionNeeded = batch.replayGap || attentionChanged || terminalChanged;
      let refreshSelectedTimeline = batch.replayGap;
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
            const effort = typeof event.payload.reasoningEffort === "string" ? event.payload.reasoningEffort : undefined;
            const model = typeof event.payload.modelId === "string" ? event.payload.modelId : undefined;
            const state = typeof event.payload.state === "string" ? event.payload.state : undefined;
            const known = state === "working" || state === "needs_approval" || state === "needs_input" || state === "idle" || state === "completed" || state === "failed" || state === "offline" || state === "disconnected" || state === "unknown";
            if (event.sessionId && (effort || model || known)) {
              // An idle report that races the stream must not settle running rows
              // (their next delta would then replace instead of extend the body);
              // a quiet stream that finally reports idle must settle the shimmer.
              const quiet = known ? quietCatchUpDue(selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, event.sessionId, lastLiveDeltaAt.current), Date.now(), 2_000) : true;
              const currentSession = next.sessions.find((session) => session.id === event.sessionId);
              const terminalTurnEvidence = currentSession !== undefined
                && !sessionHoldsFollowUpQueue(currentSession, next.timelines[event.sessionId] ?? []);
              const applyState = known && shouldApplySessionState(state!, quiet || terminalTurnEvidence);
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
                if (!sessionNeedsTranscriptCatchUp({ state: normalizedState }, timeline)) {
                  next.timelines[event.sessionId] = settleRunningTimeline(timeline);
                }
              }
            }
          }
          if (event.type === "side_chat.created" || event.type === "side_chat.updated" || event.type === "side_chat.promoted") {
            const session = sideChatEventSession(event.payload.session, next.sessions, event.occurredAt);
            if (session) next.sessions = [session, ...next.sessions.filter((candidate) => candidate.id !== session.id)];
          }
          if (!event.sessionId) continue;
          const item = timelineItems[eventIndex];
          if (item) next.timelines[event.sessionId] = mergeTimeline(next.timelines[event.sessionId] ?? [], item);
          if (event.type === "session.status_changed") {
            const state = typeof event.payload.state === "string" ? event.payload.state : undefined;
            const known = state === "working" || state === "needs_approval" || state === "needs_input" || state === "idle" || state === "completed" || state === "failed" || state === "offline" || state === "disconnected" || state === "unknown";
            if (known) {
              const quiet = quietCatchUpDue(selectedSessionLastDeltaAt(lastLiveDeltaBySession.current, event.sessionId, lastLiveDeltaAt.current), Date.now(), 2_000);
              const currentSession = next.sessions.find((session) => session.id === event.sessionId);
              const terminalTurnEvidence = currentSession !== undefined
                && !sessionHoldsFollowUpQueue(currentSession, next.timelines[event.sessionId] ?? []);
              const applyState = shouldApplySessionState(state, quiet || terminalTurnEvidence);
              const normalizedState = state === "disconnected" ? "offline" : state === "unknown" ? "idle" : state as SessionState;
              const hasProviderStatus = Object.prototype.hasOwnProperty.call(event.payload, "providerStatus");
              const providerStatus = providerStatusValue(event.payload.providerStatus);
              const terminalState = normalizedState === "idle" || normalizedState === "completed" || normalizedState === "failed" || normalizedState === "offline";
              if (applyState || hasProviderStatus || terminalState) next.sessions = replaceSession(next.sessions, event.sessionId, {
                ...(applyState ? { state: normalizedState } : {}),
                ...(hasProviderStatus || terminalState ? { providerStatus: providerStatus ?? null } : {}),
                updatedAt: event.occurredAt,
              });
              if (applyState && (normalizedState === "idle" || normalizedState === "completed" || normalizedState === "failed")) {
                const timeline = next.timelines[event.sessionId] ?? [];
                if (!sessionNeedsTranscriptCatchUp({ state: normalizedState }, timeline)) {
                  next.timelines[event.sessionId] = settleRunningTimeline(timeline);
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
            next.sessions = replaceSession(next.sessions, event.sessionId, { state, providerStatus: null, updatedAt: event.occurredAt });
            // Not every harness closes its rows: OpenCode ends a turn with an idle
            // event and never sends message.completed. Settling here is what stops
            // a finished answer from shimmering until the user clicks it.
            const timeline = next.timelines[event.sessionId] ?? [];
            if (event.type !== "agent.completed" || !sessionNeedsTranscriptCatchUp({ state }, timeline)) {
              next.timelines[event.sessionId] = settleRunningTimeline(timeline);
            }
          }
          if (isPersistedCodexFinalAnswer(event)) {
            cancelDeferredAgentCompletion(event.sessionId);
            next.sessions = replaceSession(next.sessions, event.sessionId, { state: "completed", providerStatus: null, updatedAt: event.occurredAt });
            next.timelines[event.sessionId] = settleRunningTimeline(next.timelines[event.sessionId] ?? []);
          }
          if (event.type === "message.delta" || event.type === "message.completed") {
            const rawPreview = typeof event.payload.text === "string" ? event.payload.text : typeof event.payload.delta === "string" ? event.payload.delta : undefined;
            const preview = rawPreview === undefined ? undefined : visibleResponseAnnotationBody(rawPreview);
            next.sessions = replaceSession(next.sessions, event.sessionId, { ...(preview ? { preview } : {}), updatedAt: event.occurredAt });
          }
        }
        return next;
      });
      if (selectedTerminalCompletion && selectedSessionIdRef.current) {
        catchUpTranscript(selectedSessionIdRef.current, true, true);
      }
      if (refreshSessionsNeeded || refreshProvidersNeeded || refreshAttentionNeeded) {
        void refreshAll(false);
      } else if (refreshSelectedTimeline) {
        const selected = selectedSessionIdRef.current;
        if (selected) {
          const generation = liveTimelineGenerationBySession.current.get(selected) ?? 0;
          void loadSessionTimelinePage(selected).then((page) => {
            setSnapshot((current) => current && (liveTimelineGenerationBySession.current.get(selected) ?? 0) === generation ? { ...current, sessions: applyOpenedSessionPreview(current.sessions, page.session), timelines: { ...current.timelines, [selected]: reconcileTimelinePage(page.items, current.timelines[selected] ?? []) } } : current);
            setTimelineWindows((current) => {
              if ((liveTimelineGenerationBySession.current.get(selected) ?? 0) !== generation) return current;
              const existing = current[selected];
              if (existing) return existing.nextCursor === retainedHistoryCursor(existing.nextCursor, page.nextCursor)
                ? current
                : { ...current, [selected]: { ...existing, nextCursor: retainedHistoryCursor(existing.nextCursor, page.nextCursor) } };
              return { ...current, [selected]: { nextCursor: page.nextCursor, revealStart: initialTimelineRevealStart(page.items), loadingOlder: false } };
            });
          }).catch(() => undefined);
        }
      }
  };

  const openSession = useCallback(async (sessionId: string, force = false) => {
    setSelectedSessionId(sessionId);
    setView("workspace");
    if (narrow) setListCollapsed(true);
    void watchSession(sessionId).catch(() => undefined);
    const alreadyLoaded = snapshot?.timelines[sessionId];
    const hasPagedWindow = timelineWindows[sessionId] !== undefined;
    if (alreadyLoaded !== undefined && hasPagedWindow && !force) {
      // Revealed history belongs to the task just like its scroll mode. Resetting
      // revealStart on every return removes the saved anchor from the DOM before
      // the scroll controller can restore it, so the task appears to jump toward
      // its newest rows even though its PRESERVE_VIEW policy is still correct.
      void refreshSelectedView(sessionId).catch(() => undefined);
      return;
    }
    if (openingSessionIdsRef.current.has(sessionId)) return;
    openingSessionIdsRef.current.add(sessionId);
    if (!alreadyLoaded) setSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [sessionId]: [] } } : current);
    try {
      const page = await loadSessionTimelinePage(sessionId);
      setSnapshot((current) => current ? { ...current, sessions: applyOpenedSessionPreview(current.sessions, page.session), timelines: { ...current.timelines, [sessionId]: reconcileTimelinePage(page.items, current.timelines[sessionId] ?? []) } } : current);
      const recentItems = reconcileTimelinePage(page.items, alreadyLoaded ?? []);
      setTimelineWindows((current) => ({
        ...current,
        [sessionId]: { nextCursor: page.nextCursor, revealStart: initialTimelineRevealStart(recentItems), loadingOlder: false },
      }));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      openingSessionIdsRef.current.delete(sessionId);
    }
  }, [narrow, notify, refreshSelectedView, snapshot?.timelines, timelineWindows]);

  const insertDerivedSession = useCallback((source: Session, value: Record<string, unknown>, summary?: string, draft?: string) => {
    try {
      const next = derivedSession(value, source);
      setSnapshot((current) => current ? { ...current, sessions: [next, ...current.sessions.filter((item) => item.id !== next.id)] } : current);
      if (summary) setHandoffSummaries((current) => ({ ...current, [next.id]: summary }));
      if (draft) setComposerDrafts((current) => ({ ...current, [next.id]: draft }));
      void openSession(next.id, true);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [notify, openSession]);

  const branchSessionFromList = useCallback(async (sessionId: string) => {
    const source = snapshot?.sessions.find((session) => session.id === sessionId);
    const provider = source ? providerFor(snapshot?.providers ?? [], source.providerId) : undefined;
    if (!source || source.draft || source.state === "offline" || !snapshot?.connected || provider?.state !== "online" || !provider.detected || !provider.capabilities.includes("Create Session") || !provider.capabilities.includes("Send Message") || !provider.capabilities.includes("Session History")) return;
    try {
      const result = await request("session.branch", { sessionId });
      if (!result.session || typeof result.session !== "object" || Array.isArray(result.session)) throw new Error("Bridge did not return the branched task.");
      insertDerivedSession(source, result.session as Record<string, unknown>);
      notify(`Branched in a new task${typeof result.copiedMessageCount === "number" ? ` with ${result.copiedMessageCount} copied messages` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [insertDerivedSession, notify, snapshot]);

  const openSideChatPanel = useCallback((sessionId: string, anchor: SideChatAnchor) => {
    setOpenSideChats((current) => {
      const existing = current.find((item) => item.id === sessionId);
      if (existing) return current.map((item) => item.id === sessionId ? { ...item, anchor } : item);
      return [...current.slice(-1), { id: sessionId, anchor }];
    });
    if (snapshot?.timelines[sessionId] !== undefined) return;
    setSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [sessionId]: [] } } : current);
    void loadSessionTimelinePage(sessionId).then((page) => {
      setSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [sessionId]: reconcileTimelinePage(page.items, current.timelines[sessionId] ?? []) } } : current);
    }).catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), "error"));
  }, [notify, snapshot?.timelines]);

  const createSideChat = useCallback(async (parentSessionId: string, prompt?: string, queuedMessageId?: string) => {
    const source = snapshot?.sessions.find((session) => session.id === parentSessionId && session.sessionKind !== "side_chat");
    if (!source) throw new Error("The parent task is no longer available.");
    const response = await request("side_chat.create", { parentSessionId, ...(prompt?.trim() ? { prompt: prompt.trim() } : {}), ...(queuedMessageId ? { queuedMessageId } : {}) });
    if (!response.session || typeof response.session !== "object" || Array.isArray(response.session)) throw new Error("Bridge did not return the side chat.");
    const next = derivedSession(response.session as Record<string, unknown>, source);
    const sideChat: Session = { ...next, sessionKind: "side_chat", parentSessionId, ...(prompt?.trim() ? { preview: prompt.trim() } : {}) };
    setSnapshot((current) => current ? { ...current, sessions: [sideChat, ...current.sessions.filter((session) => session.id !== sideChat.id)] } : current);
    const parentElement = document.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(parentSessionId)}"]`);
    const bounds = parentElement?.getBoundingClientRect();
    openSideChatPanel(sideChat.id, { x: bounds?.right ?? 248, y: bounds ? bounds.top + bounds.height / 2 : Math.max(110, window.innerHeight - 210) });
  }, [openSideChatPanel, snapshot?.sessions]);

  const promoteSideChat = useCallback(async (sessionId: string) => {
    const response = await request("side_chat.promote", { sessionId });
    const source = snapshot?.sessions.find((session) => session.id === sessionId);
    if (!source || !response.session || typeof response.session !== "object" || Array.isArray(response.session)) throw new Error("Bridge did not return the promoted task.");
    const promoted: Session = { ...derivedSession(response.session as Record<string, unknown>, source), sessionKind: "task" };
    delete promoted.parentSessionId;
    setSnapshot((current) => current ? { ...current, sessions: [promoted, ...current.sessions.filter((session) => session.id !== promoted.id)] } : current);
    setOpenSideChats((current) => current.filter((item) => item.id !== sessionId));
    setSelectedSessionId(promoted.id);
    setView("workspace");
    void openSession(promoted.id, true);
    notify("Side chat copied to a full task");
  }, [notify, openSession, snapshot?.sessions]);

  const updateSideChatDraft = useCallback((sessionId: string, update: SideChatDraftUpdate) => {
    setSideChatDrafts((current) => {
      const previous = current[sessionId] ?? emptySideChatDraft;
      const nextDraft = typeof update === "function" ? update(previous) : update;
      if (previous.content === nextDraft.content && previous.attachments === nextDraft.attachments) return current;
      return { ...current, [sessionId]: nextDraft };
    });
  }, []);

  const discardSideChatDraft = useCallback((sessionId: string) => {
    setSideChatDrafts((current) => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const updateSideChatAnchor = useCallback((sessionId: string, anchor: SideChatAnchor) => {
    setOpenSideChats((current) => current.map((item) => item.id === sessionId && (item.anchor.x !== anchor.x || item.anchor.y !== anchor.y) ? { ...item, anchor } : item));
  }, []);

  const loadOlderHistory = useCallback(async (sessionId: string) => {
    const windowState = timelineWindows[sessionId];
    if (!windowState || windowState.loadingOlder) return;
    if (windowState.revealStart > 0) {
      setTimelineWindows((current) => {
        const existing = current[sessionId];
        if (!existing) return current;
        return { ...current, [sessionId]: { ...existing, revealStart: Math.max(0, existing.revealStart - 24) } };
      });
      return;
    }
    if (!windowState.nextCursor) return;
    setTimelineWindows((current) => {
      const existing = current[sessionId];
      return existing ? { ...current, [sessionId]: { ...existing, loadingOlder: true } } : current;
    });
    try {
      let page = await loadSessionTimelinePage(sessionId, windowState.nextCursor, HISTORY_PAGE_LIMIT);
      if (historyPageNeedsRebase(windowState.nextCursor, page.nextCursor)) {
        // The bridge snapshots provider history between cursor requests. If a
        // newest-page refresh replaced that snapshot, a formerly valid cursor
        // can appear exhausted and the UI used to remove the loader forever.
        // Re-open once, then continue from the new boundary.
        const latest = await loadSessionTimelinePage(sessionId, undefined, HISTORY_PAGE_LIMIT, true);
        page = latest.nextCursor === null
          ? { items: [], nextCursor: null }
          : await loadSessionTimelinePage(sessionId, latest.nextCursor, HISTORY_PAGE_LIMIT);
      }
      setSnapshot((current) => current ? {
        ...current,
        timelines: { ...current.timelines, [sessionId]: prependTimelinePage(current.timelines[sessionId] ?? [], page.items) },
      } : current);
      setTimelineWindows((current) => ({
        ...current,
        [sessionId]: { nextCursor: page.nextCursor, revealStart: 0, loadingOlder: false },
      }));
    } catch (error) {
      setTimelineWindows((current) => {
        const existing = current[sessionId];
        return existing ? { ...current, [sessionId]: { ...existing, loadingOlder: false } } : current;
      });
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  }, [notify, timelineWindows]);

  const startDraftTask = useCallback(() => {
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
    const workingDirectory = source?.workingDirectory ?? "";
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
    setTimelineWindows((current) => ({ ...current, [draft.id]: { nextCursor: null, revealStart: 0, loadingOlder: false } }));
    setComposerDrafts((current) => ({ ...current, [draft.id]: "" }));
    setSelectedProvider("all");
    setSelectedSessionId(draft.id);
    setView("workspace");
    if (narrow) setListCollapsed(true);
  }, [narrow, notify, preferences.agentDefaults, selectedSessionId, snapshot]);

  const updateDraftSelection = useCallback((draftSessionId: string, selection: DraftModelSelection) => {
    setSnapshot((current) => current ? {
      ...current,
      sessions: current.sessions.map((session) => session.id === draftSessionId && session.draft
        ? { ...session, providerId: selection.providerId, model: selection.modelId, effort: selection.effort }
        : session),
    } : current);
  }, []);

  const chooseDraftDirectory = useCallback(async (draftSessionId: string, currentDirectory: string) => {
    const workingDirectory = await selectDirectory(currentDirectory);
    if (!workingDirectory) return;
    setSnapshot((current) => current ? {
      ...current,
      sessions: current.sessions.map((session) => session.id === draftSessionId && session.draft ? {
        ...session,
        workingDirectory,
        project: workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? "New project",
      } : session),
    } : current);
  }, []);

  const createDraftSend = useCallback(async (input: DraftSessionSendInput) => {
    if (!input.workingDirectory) throw new Error("Choose a project folder before starting this task.");
    const annotatedInput = parseResponseAnnotations(input.content);
    const visibleInput = annotatedInput?.body ?? input.content;
    const modelFields = {
      ...(!isAmbiguousSelectionValue(input.modelId) ? { modelId: input.modelId } : {}),
      ...(!isAmbiguousSelectionValue(input.effort) ? { reasoningEffort: input.effort.toLowerCase() } : {}),
    };
    const separatedFirstTurn = input.attachmentIds.length > 0 || input.workflowIds.length > 0;
    const response = await request("session.create", {
      providerId: input.providerId,
      workingDirectory: input.workingDirectory,
      title: visibleInput.trim().split(/\r?\n/u)[0]?.slice(0, 96) || "Annotated response",
      ...modelFields,
      ...(separatedFirstTurn ? {} : { firstInstruction: input.content }),
      ...(!separatedFirstTurn && input.simplify !== undefined ? { simplify: input.simplify } : {}),
    });
    const pending = createdSession(response.session, input, separatedFirstTurn ? "idle" : "working", separatedFirstTurn ? "" : visibleInput);

    const commit = (session: Session, retainedDraft: string, includeOptimisticMessage: boolean) => {
      const now = new Date().toISOString();
      setSnapshot((current) => {
        if (!current) return current;
        const timelines = { ...current.timelines };
        const draftTimeline = timelines[input.draftSessionId] ?? [];
        delete timelines[input.draftSessionId];
        timelines[session.id] = includeOptimisticMessage
          ? [...draftTimeline, { id: `local-${Date.now()}`, kind: "user", body: visibleInput, ...(annotatedInput ? { annotations: annotatedInput.annotations } : {}), ...(input.workflows.length ? { workflows: input.workflows } : {}), timestamp: now, state: "completed" }]
          : draftTimeline;
        return {
          ...current,
          sessions: [session, ...current.sessions.filter((item) => item.id !== input.draftSessionId && item.id !== session.id)],
          timelines,
        };
      });
      setComposerDrafts((current) => {
        const next = { ...current };
        delete next[input.draftSessionId];
        if (retainedDraft) next[session.id] = retainedDraft;
        else delete next[session.id];
        return next;
      });
      setComposerAttachments((current) => {
        const next = { ...current };
        delete next[input.draftSessionId];
        delete next[session.id];
        return next;
      });
      setComposerAnnotations((current) => {
        const next = { ...current };
        delete next[input.draftSessionId];
        delete next[session.id];
        return next;
      });
      setTimelineWindows((current) => {
        const next = { ...current };
        delete next[input.draftSessionId];
        next[session.id] = { nextCursor: null, revealStart: 0, loadingOlder: false };
        return next;
      });
      setSelectedSessionId(session.id);
      setView("workspace");
    };

    if (separatedFirstTurn) {
      try {
        await request("session.send_message", {
          sessionId: pending.id,
          content: input.content,
          ...modelFields,
          attachmentIds: [...input.attachmentIds],
          ...(input.workflowIds.length ? { workflowIds: [...input.workflowIds] } : {}),
          ...(input.simplify !== undefined ? { simplify: input.simplify } : {}),
        });
      } catch (error) {
        commit(pending, input.content, false);
        void openSession(pending.id, true);
        throw error;
      }
    }

    const active = separatedFirstTurn ? { ...pending, state: "working" as const, preview: input.content } : pending;
    commit(active, "", true);
    void watchSession(active.id).catch(() => undefined);
  }, [openSession]);

  useEffect(() => {
    if (selectedSessionId && snapshot && timelineWindows[selectedSessionId] === undefined) {
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
  const selectedSession = useMemo(() => organizedSessions.find((session) => session.id === selectedSessionId && session.sessionKind !== "side_chat" && session.sessionKind !== "internal") ?? null, [organizedSessions, selectedSessionId]);
  // A child that is open in the workspace is retained across provider refreshes,
  // but confirmed provenance still keeps it out of every top-level task surface.
  // Do not use parentSessionId here: provider-owned user chats may legitimately
  // have one and must remain visible unless their relationship is a sub-agent.
  const topLevelSessions = useMemo(() => organizedSessions.filter((session) => session.relationshipKind !== "subagent"), [organizedSessions]);
  useEffect(() => {
    if (isBrowserPreview) return;
    const ids = [
      ...(selectedSessionId && !selectedSession?.draft ? [selectedSessionId] : []),
      ...openSideChats.map((chat) => chat.id),
    ];
    watchedSessionIds.current = new Set(ids);
    for (const sessionId of ids) void watchSession(sessionId).catch(() => undefined);
    return () => {
      for (const sessionId of ids) void unwatchSession(sessionId).catch(() => undefined);
    };
  }, [openSideChats, selectedSession?.draft, selectedSessionId]);
  const filteredSessions = useMemo(() => {
    if (!snapshot) return [];
    const lowered = normalizeUiSearchQuery(query);
    const availableProviders = new Set(snapshot.providers.filter((provider) => provider.detected).map((provider) => provider.id));
    return topLevelSessions.filter((session) => {
      if (session.sessionKind === "side_chat" || session.sessionKind === "internal") return false;
      if (isHiddenByArchive(session, showArchived)) return false;
      if (!matchesProviderFilters(session.providerId, selectedProvider, availableProviders)) return false;
      if (stateFilter !== "all" && session.state !== stateFilter) return false;
      if (lowered && !normalizeUiSearchQuery(`${session.title} ${session.project} ${session.preview}`, 4_000).includes(lowered)) return false;
      return true;
    }).sort(compareOrganizedSessions);
  }, [query, selectedProvider, showArchived, snapshot, stateFilter, topLevelSessions]);
  const archivedCount = useMemo(() => topLevelSessions.filter((session) => session.archived && session.sessionKind !== "side_chat" && session.sessionKind !== "internal").length, [topLevelSessions]);
  // Restoring the last archived task removes the Show archived control. Clear
  // its now-unreachable mode as well, otherwise the next archived task remains
  // visible and makes the Archive action look broken.
  useEffect(() => {
    if (archivedCount === 0 && showArchived) setShowArchived(false);
  }, [archivedCount, showArchived]);
  /** Everything the dashboard and command palette may surface: real tasks the user has not put away. */
  const activeSessions = useMemo(() => topLevelSessions.filter((session) => !session.archived && session.sessionKind !== "side_chat" && session.sessionKind !== "internal"), [topLevelSessions]);
  const setTaskOverride = useCallback(async (sessionId: string, override: TaskOverride) => {
    if (isBrowserPreview) { setPreferences((current) => ({ ...current, taskOverrides: { ...current.taskOverrides, [sessionId]: { ...current.taskOverrides[sessionId], ...override } } })); return; }
    try { setPreferences(await window.tethoqDesktop.preferencesAction({ type: "set-task-override", sessionId, override })); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  }, [notify]);

  const openSettings = useCallback(() => {
    setView((current) => {
      if (current !== "settings") settingsReturnView.current = current;
      return "settings";
    });
  }, []);
  const closeSettings = useCallback(() => {
    const next = settingsReturnView.current;
    setView(next);
    if (next === "workspace") setListCollapsed(false);
    setSelectedWorkflowId(null);
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
    return <div className="app-loading">{loadError ? <ErrorBanner title="Tethoq could not start" message={loadError} onRetry={() => void initialize()} /> : <LoadingState />}</div>;
  }

  const setProvider = (providerId: ProviderFilterSelection) => {
    setSelectedProvider(providerId);
    setView("workspace");
    setListCollapsed(false);
  };

  return (
    <LocalOpenProvider state={localOpenState} onOpen={openLocalTarget}>
    <div className={`desktop-app ${listCollapsed ? "list-collapsed" : ""} ${narrow ? "narrow" : ""} ${sidebarResizing ? "sidebar-resizing" : ""}`} style={narrow ? undefined : { "--navigation-panel": `${navigationPanelWidth}px` } as CSSProperties} data-provider={Array.isArray(selectedProvider) ? selectedProvider.join(",") : selectedProvider} data-runtime-state={runtime.state}>
      <a className="skip-to-message" href="#composer-message">Skip to message</a>
      <TitleBar snapshot={snapshot} session={selectedSession} notify={notify} onDirectModels={(models) => setSnapshot((current) => current ? { ...current, models: { ...current.models, direct: models } } : current)} />
      <div className="app-body">
        <Sidebar
          {...(bootstrap?.app.version ? { appVersion: bootstrap.app.version } : {})}
          sessions={filteredSessions}
          allSessions={organizedSessions}
          providers={snapshot.providers}
          selected={selectedSessionId}
          selectedProvider={selectedProvider}
          query={query}
          stateFilter={stateFilter}
          view={view}
          connected={snapshot.connected}
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
          onNewTask={startDraftTask}
          onCommandSearch={() => setPaletteOpen(true)}
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
        {view === "dashboard" ? <Dashboard snapshot={snapshot} sessions={activeSessions} onOpen={openSession} onNew={startDraftTask} onProvider={setProvider} /> : null}
        {view === "settings" ? <SettingsPage snapshot={snapshot} {...(bootstrap ? { bootstrap } : {})} recorder={recorder} workflows={workflows} selectedWorkflowId={selectedWorkflowId} onSelectWorkflow={setSelectedWorkflowId} setWorkflows={setWorkflows} onSaveWorkflow={() => setSaveWorkflowOpen(true)} onClose={closeSettings} preferences={preferences} onSetReasoningDisplay={async (value) => {
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
        }} onSetAllowForeignSubagents={async (enabled) => {
          if (!isBrowserPreview) {
            const next = await window.tethoqDesktop.preferencesAction({ type: "set-allow-foreign-subagents", enabled });
            setPreferences(next);
          }
          notify(enabled ? "Sub-agents from other coding tools enabled" : "Sub-agents from other coding tools disabled");
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
        }} notify={notify} onReconnect={async (id) => { await reconnectProvider(id); await refreshAll(false); notify(`${providerDisplayName(id, providerFor(snapshot.providers, id))} reconnected`); }} /> : null}
        {view === "browser" ? <BrowserWorkspace state={browser} focusAddressToken={browserAddressFocusToken} notify={notify} onReturn={() => setView("workspace")} /> : null}
        {view === "workspace" ?
          <Workspace
            snapshot={snapshot}
            session={selectedSession}
            onBack={() => setListCollapsed(false)}
            onNew={startDraftTask}
            onBrowser={() => setView("browser")}
            onLinkOpen={(url) => void openTimelineLink(url)}
            onManageWorkflow={(id) => { setSelectedWorkflowId(id ?? null); openSettings(); }}
            onDraftSelectionChange={(selection) => { if (selectedSession?.draft) updateDraftSelection(selectedSession.id, selection); }}
            onCreateDraftSend={createDraftSend}
            onDraftDirectory={() => { if (selectedSession?.draft) void chooseDraftDirectory(selectedSession.id, selectedSession.workingDirectory); }}
            handoffSummary={handoffSummaries[selectedSession?.id ?? ""] ?? selectedSession?.contextSummary}
            initialDraft={composerDrafts[selectedSession?.id ?? ""] ?? ""}
            onDraftChange={(value) => { if (selectedSession) setComposerDrafts((current) => current[selectedSession.id] === value ? current : { ...current, [selectedSession.id]: value }); }}
            initialAttachments={composerAttachments[selectedSession?.id ?? ""] ?? []}
            onAttachmentsChange={(attachments) => {
              if (!selectedSession) return;
              setComposerAttachments((current) => {
                if (current[selectedSession.id] === attachments) return current;
                const next = { ...current };
                if (attachments.length) next[selectedSession.id] = attachments;
                else delete next[selectedSession.id];
                return next;
              });
            }}
            initialAnnotations={composerAnnotations[selectedSession?.id ?? ""] ?? emptyResponseAnnotations}
            onAnnotationsChange={(annotations) => {
              if (!selectedSession) return;
              setComposerAnnotations((current) => {
                if (current[selectedSession.id] === annotations) return current;
                const next = { ...current };
                if (annotations.length) next[selectedSession.id] = annotations;
                else delete next[selectedSession.id];
                return next;
              });
            }}
            onDerivedSession={(value, summary, draft) => {
              if (selectedSession) insertDerivedSession(selectedSession, value, summary, draft);
            }}
            onOpenChild={(child) => {
              setSnapshot((current) => current ? { ...current, sessions: [child, ...current.sessions.filter((item) => item.id !== child.id)] } : current);
              void openSession(child.id, true);
            }}
            onOpenParent={(parentSessionId) => void openSession(parentSessionId)}
            notify={notify}
            updateSnapshot={setSnapshot}
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
            foreignSubagentsEnabled={preferences.allowForeignSubagents === true}
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
            onInstantSession={() => setLiveSessionOpen(true)}
            onCreateSideChat={createSideChat}
            queueRevision={queueRevision}
            queueingEnabled={queueingBySession[selectedSession?.id ?? ""] ?? true}
            onQueueingEnabledChange={(enabled) => { if (selectedSession) setQueueingBySession((current) => ({ ...current, [selectedSession.id]: enabled })); }}
            reportedCompaction={selectedSession ? compactionsBySession[selectedSession.id] : undefined}
          />
        : null}
      </div>
      {openSideChats.length ? <SideChatLayer
        items={openSideChats}
        snapshot={snapshot}
        drafts={sideChatDrafts}
        notify={notify}
        onClose={(sessionId) => setOpenSideChats((current) => current.filter((item) => item.id !== sessionId))}
        onPromote={promoteSideChat}
        onDraftChange={updateSideChatDraft}
        onDiscardDraft={discardSideChatDraft}
        onSent={(sessionId, item) => setSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [sessionId]: [...(current.timelines[sessionId] ?? []), item] }, sessions: replaceSession(current.sessions, sessionId, { preview: item.body, state: "working", updatedAt: item.timestamp }) } : current)}
      /> : null}
      {liveSessionOpen && selectedSession ? <LiveSessionPanel session={selectedSession} experimental={preferences.experimentalFeatures} notify={notify} onClose={() => setLiveSessionOpen(false)} /> : null}
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
      {toast ? <Toast message={toast.message} {...(toast.tone ? { tone: toast.tone } : {})} /> : null}
      {isBrowserPreview ? <span className="preview-badge">Browser preview</span> : null}
    </div>
    </LocalOpenProvider>
  );
}

function SideChatLayer({ items, snapshot, drafts, notify, onClose, onPromote, onDraftChange, onDiscardDraft, onSent }: {
  items: readonly { id: string; anchor: SideChatAnchor }[];
  snapshot: DesktopSnapshot;
  drafts: Readonly<Record<string, SideChatDraft>>;
  notify: (message: string, tone?: "normal" | "error") => void;
  onClose: (sessionId: string) => void;
  onPromote: (sessionId: string) => Promise<void>;
  onDraftChange: (sessionId: string, update: SideChatDraftUpdate) => void;
  onDiscardDraft: (sessionId: string) => void;
  onSent: (sessionId: string, item: TimelineItem) => void;
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
    <svg className="side-chat-connectors" width={viewportWidth} height={viewportHeight} viewBox={`0 0 ${viewportWidth} ${viewportHeight}`} aria-hidden="true">{items.map((item, index) => {
      const targetY = (positions[index] ?? 66) + 42;
      const middle = item.anchor.x + Math.max(6, (left - item.anchor.x) / 2);
      return <path key={item.id} d={`M ${item.anchor.x} ${item.anchor.y} C ${middle} ${item.anchor.y}, ${middle} ${targetY}, ${left} ${targetY}`}/>;
    })}</svg>
    {items.map((item, index) => {
      const session = snapshot.sessions.find((candidate) => candidate.id === item.id && candidate.sessionKind === "side_chat");
      if (!session) return null;
      const provider = snapshot.providers.find((candidate) => candidate.id === session.providerId);
      return <div className="side-chat-floating" key={session.id} style={{ left, top: positions[index], width, height: panelHeight }}><SideChatPanel
        session={session}
        provider={provider}
        timeline={snapshot.timelines[session.id] ?? []}
        request={request}
        selectImages={selectImages}
        notify={notify}
        draft={drafts[session.id] ?? emptySideChatDraft}
        onDraftChange={(update) => onDraftChange(session.id, update)}
        onDiscardDraft={() => onDiscardDraft(session.id)}
        onSent={(timelineItem) => onSent(session.id, timelineItem)}
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

function WalletDropdown({ snapshot, session, notify, onDirectModels }: { snapshot: DesktopSnapshot; session: Session | null; notify: (message: string, tone?: "normal" | "error") => void; onDirectModels: (models: ModelOption[]) => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WalletStatusView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [endpointId, setEndpointId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [budget, setBudget] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customProtocol, setCustomProtocol] = useState<"responses" | "chat_completions">("responses");
  const [customModels, setCustomModels] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const endpointRefreshSequence = useRef(0);
  const providerId = session?.providerId ?? snapshot.providers.find((provider) => provider.state === "online")?.id ?? "";
  const modelId = session?.model && session.model !== "CLI default" ? session.model : undefined;
  const endpoints = useMemo(() => {
    const values = [...(status?.availableEndpoints ?? []), ...Object.values(snapshot.models).flat().map((model) => {
      const encodedEndpoint = model.id.includes("::") ? model.id.split("::", 1)[0] : undefined;
      const id = model.endpointId ?? encodedEndpoint;
      return id ? { id, name: model.endpointName ?? id } : null;
    }).filter((entry): entry is { id: string; name: string } => entry !== null)];
    if (status?.endpointId && !values.some((entry) => entry.id === status.endpointId)) values.unshift({ id: status.endpointId, name: status.endpointName ?? status.endpointId });
    return [...new Map(values.map((entry) => [entry.id, entry])).values()];
  }, [snapshot.models, status?.availableEndpoints, status?.endpointId, status?.endpointName]);
  const refresh = useCallback(async () => {
    if (!providerId) { setStatus(null); return; }
    setLoading(true);
    try {
      const result = await request("wallet.get", { providerId, ...(modelId ? { modelId } : {}) });
      const next = walletStatus(result.wallet);
      if (!next) throw new Error("Wallet status is unavailable.");
      setStatus(next);
      setEndpointId(next.endpointId ?? "");
    } catch {
      setStatus(null);
    } finally { setLoading(false); }
  }, [modelId, providerId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const selectDirectEndpoint = useCallback(async (nextEndpointId: string) => {
    if (!nextEndpointId) return;
    const sequence = ++endpointRefreshSequence.current;
    setEndpointId(nextEndpointId);
    setLoading(true);
    try {
      const result = await request("wallet.get", { providerId: "direct", endpointId: nextEndpointId });
      const next = walletStatus(result.wallet);
      if (!next || next.providerId !== "direct" || next.endpointId !== nextEndpointId) throw new Error("Bridge did not return the selected endpoint wallet.");
      if (sequence !== endpointRefreshSequence.current) return;
      setStatus(next);
    } catch (error) {
      if (sequence !== endpointRefreshSequence.current) return;
      setEndpointId(status?.endpointId ?? nextEndpointId);
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (sequence === endpointRefreshSequence.current) setLoading(false);
    }
  }, [notify, status?.endpointId]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  const configure = async (payload: Record<string, string | number | boolean | readonly string[] | Record<string, unknown>>) => {
    setSaving(true);
    try {
      const result = await request("wallet.configure", { providerId: "direct", endpointId: endpointId || status?.endpointId || "", ...payload } as unknown as import("../../../../../packages/protocol/src/index").JsonObject);
      const next = walletStatus(result.wallet);
      if (!next) throw new Error("Bridge did not return the updated wallet.");
      setStatus(next);
      setEndpointId(next.endpointId ?? endpointId);
      const directProvider = snapshot.providers.find((provider) => provider.id === "direct");
      if (directProvider) onDirectModels((await loadProviderModels([directProvider])).direct ?? []);
      notify("Wallet settings saved");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setApiKey("");
      setSaving(false);
    }
  };
  const showDirectWallet = async () => {
    setLoading(true);
    try {
      const result = await request("wallet.get", { providerId: "direct" });
      const next = walletStatus(result.wallet);
      if (!next) throw new Error("Direct API settings are unavailable.");
      setStatus(next);
      setEndpointId(next.endpointId ?? endpoints[0]?.id ?? "");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally { setLoading(false); }
  };
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
  const kind = status?.kind ?? "subscription";
  const label = loading && !status ? "Wallet…" : status?.label ?? "Billing source";
  return <div className={`wallet-dropdown wallet-${kind} ${open ? "open" : ""}`} ref={root}>
    <button className={`wallet-trigger ${status?.kind === "user_api" && !status.apiKeyConfigured ? "wallet-trigger-caution" : ""}`} data-tooltip={label} type="button" aria-label={`${label}. Open wallet`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen((current) => !current); if (!open) void refresh(); }}><WalletIcon /></button>
    {open ? <section className="wallet-popover" role="dialog" aria-label="Wallet and billing source">
      <header><span className="wallet-mark"><WalletIcon /></span><span><strong>{status?.label ?? "Billing source unavailable"}</strong><small>{status?.detail ?? "The local bridge did not report a wallet for this coding tool."}</small></span></header>
      {status ? <><dl className="wallet-stats"><div><dt>Route</dt><dd>{status.kind === "user_api" ? "Direct API" : status.kind === "harness" ? "Agent-managed" : "Subscription"}</dd></div>{status.balance !== undefined ? <div><dt>Spend cap</dt><dd>{status.balance > 0 ? `stops at ${walletAmount(status.balance, status.currency)}` : "No cap set"}</dd></div> : null}{status.spent !== undefined ? <div><dt>Observed spend</dt><dd>{walletAmount(status.spent, status.currency)}</dd></div> : null}{status.kind === "user_api" ? <div><dt>API key</dt><dd>{status.apiKeyConfigured ? "Saved" : "Not added"}</dd></div> : null}</dl>{status.caution || (status.kind === "user_api" && !status.apiKeyConfigured) ? <p className="wallet-caution"><AlertIcon />{status.caution ?? "Add your API key before using a direct model. The key stays in the local Bridge and is never displayed again."}</p> : null}</> : null}
      {/* Always one hop from the other wallet. The switch flips to name wherever you
          are not, so Direct API is reachable from a task wallet and the task's own
          billing is reachable back from Direct API without hunting for a way out. */}
      <button className="wallet-route-switch" type="button" disabled={loading} onClick={() => status?.providerId === "direct" ? void refresh() : void showDirectWallet()}>{status?.providerId === "direct" ? <ArrowLeftIcon /> : <WalletIcon />}{status?.providerId === "direct" ? "Back to this task's billing" : "Configure Direct API"}</button>
      {status?.kind === "user_api" ? <div className="wallet-direct-settings">
        <label><span>Endpoint</span><select value={endpointId} disabled={saving || loading} onChange={(event) => void selectDirectEndpoint(event.target.value)}>{endpoints.length ? endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>) : <option value={status.endpointId ?? ""}>{status.endpointName ?? "Direct endpoint"}</option>}</select>{loading && endpointId !== status.endpointId ? <small className="wallet-endpoint-checking">Checking this endpoint's API-key status...</small> : null}</label>
        <label><span>API key</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={status.apiKeyConfigured ? "Stored securely · enter only to replace" : "Paste API key"}/></label>
        <div className="wallet-key-actions"><button type="button" disabled={saving || loading || !endpointId || !apiKey.trim()} onClick={() => void configure({ apiKey: apiKey.trim() })}>Save key</button><button type="button" disabled={saving || loading || !status.apiKeyConfigured} onClick={() => void configure({ clearApiKey: true })}>Clear key</button></div>
        <div className="wallet-budget"><span><strong>Spend cap</strong><small>A local ceiling Tethoq stops you at. It is not credit, and no money is held here.</small></span><input type="number" min="0" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="0.00" aria-label="Spend cap amount"/><button type="button" disabled={saving || !budget} onClick={() => updateBudget("setBalance")}>Set cap</button><button type="button" disabled={saving || !budget} onClick={() => updateBudget("addBalance")}>Raise</button><button type="button" disabled={saving || status.balance === undefined} onClick={() => { setBudget(""); void configure({ setBalance: 0 }); }}>Clear</button></div>
        <button className="wallet-advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced((current) => !current)}><ChevronRightIcon className={advanced ? "expanded" : ""}/>Advanced custom endpoint</button>
        {advanced ? <div className="wallet-advanced"><label><span>Name</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="My endpoint"/></label><label><span>Base URL</span><input inputMode="url" value={customBaseUrl} onChange={(event) => setCustomBaseUrl(event.target.value)} placeholder="https://api.example.com/v1"/></label><label><span>Protocol</span><select value={customProtocol} onChange={(event) => setCustomProtocol(event.target.value as "responses" | "chat_completions")}><option value="responses">Responses API</option><option value="chat_completions">OpenAI-compatible Chat Completions</option></select></label><label><span>Model IDs <small>optional, comma-separated</small></span><input value={customModels} onChange={(event) => setCustomModels(event.target.value)} placeholder="model-a, model-b"/></label><button type="button" disabled={saving || !customName.trim() || !customBaseUrl.trim()} onClick={saveCustomEndpoint}>Save custom endpoint</button></div> : null}
      </div> : null}
      {status?.kind === "user_api" ? <footer><LockIcon />API keys stay in the local Bridge and are never shown again.</footer> : null}
    </section> : null}
  </div>;
}

function TitleBar({ snapshot, session, notify, onDirectModels }: { snapshot: DesktopSnapshot; session: Session | null; notify: (message: string, tone?: "normal" | "error") => void; onDirectModels: (models: ModelOption[]) => void }) {
  return <header className="titlebar">
    <div className="titlebar-drag brand-lockup"><span className="brand-mark"><img src={tethoqIconUrl} alt="" /></span><strong>Tethoq</strong><span>Desktop</span></div>
    <div className="titlebar-tools"><WalletDropdown snapshot={snapshot} session={session} notify={notify} onDirectModels={onDirectModels}/></div>
  </header>;
}

async function browserAction(action: Parameters<Window["tethoqDesktop"]["browserAction"]>[0], update: (value: BrowserWorkspaceState) => void): Promise<void> {
  if (isBrowserPreview) return;
  update(await window.tethoqDesktop.browserAction(action));
}

function BrowserWorkspace({ state, focusAddressToken, notify, onReturn }: { state: BrowserWorkspaceState | null; focusAddressToken: number; notify: (message: string, tone?: "normal" | "error") => void; onReturn: () => void }) {
  const [current, setCurrent] = useState(state);
  const [address, setAddress] = useState("");
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [browserFreezeFrame, setBrowserFreezeFrame] = useState<string | null>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const downloadsButton = useRef<HTMLButtonElement>(null);
  const downloadsPopover = useRef<HTMLDivElement>(null);
  const downloadsCloseButton = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => setCurrent(state), [state]);
  const active = current?.tabs.find((tab) => tab.id === current.activeTabId);
  useEffect(() => setAddress(active?.url ?? ""), [active?.id, active?.url]);
  useEffect(() => {
    if (focusAddressToken === 0) return;
    addressInput.current?.focus();
    addressInput.current?.select();
  }, [focusAddressToken]);
  useEffect(() => {
    if (!downloadsOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || downloadsButton.current?.contains(target) || downloadsPopover.current?.contains(target)) return;
      setDownloadsOpen(false);
      downloadsButton.current?.focus();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDownloadsOpen(false);
      downloadsButton.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    downloadsCloseButton.current?.focus();
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [downloadsOpen]);
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
  const submit = (event: FormEvent) => { event.preventDefault(); if (active && address.trim()) void act({ type: "navigate", tabId: active.id, input: address.trim() }); };
  useEffect(() => {
    if (isBrowserPreview || !viewport.current) return;
    let cancelled = false;
    if (downloadsOpen) {
      const rect = viewport.current.getBoundingClientRect();
      void window.tethoqDesktop.browserAction({ type: "open-overlay", bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } }).then((result) => {
        if (cancelled) return;
        const snapshot = result.overlaySnapshotDataUrl;
        if (snapshot) setBrowserFreezeFrame(snapshot);
      }).catch((error: unknown) => {
        if (cancelled) return;
        setDownloadsOpen(false);
        notify(error instanceof Error ? error.message : String(error), "error");
      });
    } else {
      setBrowserFreezeFrame(null);
      void window.tethoqDesktop.browserAction({ type: "close-overlay" }).then(setCurrent).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [downloadsOpen, notify]);
  useEffect(() => () => { if (!isBrowserPreview) void window.tethoqDesktop.browserAction({ type: "close-overlay" }); }, []);
  return <main className="browser-page">
    <button className="browser-session-return" aria-label="Return to task" title="Return to task" onClick={onReturn}><ArrowLeftIcon /></button>
    <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
      {current?.tabs.map((tab) => <button role="tab" aria-selected={tab.id === current.activeTabId} key={tab.id} onClick={() => void act({ type: "activate-tab", tabId: tab.id })}><span>{tab.loading ? <span className="spinner" /> : tab.faviconUrl ? <img src={tab.faviconUrl} alt="" /> : <GlobeIcon />}</span><strong>{tab.title || "New tab"}</strong><i onClick={(event) => { event.stopPropagation(); void act({ type: "close-tab", tabId: tab.id }); }} aria-label={`Close ${tab.title || "tab"}`}><XIcon /></i></button>)}
      <IconButton label="New browser tab" onClick={() => void act({ type: "create-tab", activate: true })}><PlusIcon /></IconButton>
      <span className="browser-profile-pill"><LockIcon />Tethoq profile</span>
    </div>
    <div className="browser-toolbar">
      <IconButton label="Back" disabled={!active?.canGoBack} onClick={() => active && void act({ type: "back", tabId: active.id })}><ArrowLeftIcon /></IconButton>
      <IconButton label="Forward" disabled={!active?.canGoForward} onClick={() => active && void act({ type: "forward", tabId: active.id })}><ChevronRightIcon /></IconButton>
      <IconButton label={active?.loading ? "Stop loading" : "Reload"} onClick={() => active && void act({ type: active.loading ? "stop" : "reload", tabId: active.id })}>{active?.loading ? <XIcon /> : <RefreshIcon className="refresh-icon" />}</IconButton>
      <IconButton label="Home" onClick={() => active && void act({ type: "navigate", tabId: active.id, input: "https://www.google.com/" })}><HomeIcon /></IconButton>
      <form className="browser-address" onSubmit={submit}><LockIcon /><input ref={addressInput} aria-label="Address and search" value={address} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.currentTarget.select()} spellCheck={false}/>{active?.url ? <span>{active.url.startsWith("https://") ? "Secure" : "Web"}</span> : null}</form>
      <button ref={downloadsButton} className={`browser-downloads ${downloadsOpen ? "active" : ""}`} type="button" aria-label="Downloads" aria-haspopup="dialog" aria-expanded={downloadsOpen} aria-controls="browser-download-panel" disabled={!isBrowserPreview && current?.visible !== true} onClick={() => setDownloadsOpen((open) => !open)}><DownloadIcon />{current?.downloads.some((item) => item.state === "progressing") ? <span>{current.downloads.filter((item) => item.state === "progressing").length}</span> : null}</button>
    </div>
    <div className="browser-chrome-panels">
      <div className="browser-privacy-note"><LockIcon /><span><strong>Your optional sign-ins stay in this app-only Chromium profile.</strong> Tethoq never imports or automatically signs into your Chrome profile.</span><button onClick={() => void act({ type: "clear-profile" })}>{current?.profile.clearing ? "Clearing…" : "Clear profile data"}</button></div>
      {current?.pendingPermissions[0] ? <div className="browser-permission"><ShieldIcon /><span><strong>{current.pendingPermissions[0].origin}</strong> requests {current.pendingPermissions[0].permission} access.</span><Button onClick={() => void act({ type: "permission", requestId: current.pendingPermissions[0]!.id, allow: false })}>Block</Button><Button variant="primary" onClick={() => void act({ type: "permission", requestId: current.pendingPermissions[0]!.id, allow: true, rememberForSession: true })}>Allow this session</Button></div> : null}
    </div>
    <div className="browser-viewport" ref={viewport}>{browserFreezeFrame ? <img className="browser-freeze-frame" src={browserFreezeFrame} alt="" /> : isBrowserPreview ? <div className="browser-preview-empty"><BrowserIcon /><h2>Chromium lives here</h2><p>The native web surface is isolated from the coding UI and appears in the desktop build.</p></div> : null}</div>
    {downloadsOpen ? <div className="browser-download-popover" ref={downloadsPopover} role="dialog" aria-modal="false" aria-label="Downloads"><BrowserDownloads downloads={current?.downloads ?? []} onAction={act} onClose={() => { setDownloadsOpen(false); downloadsButton.current?.focus(); }} closeButtonRef={downloadsCloseButton} /></div> : null}
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

function TaskDetailsControl({ session, providers, onOpenChild, notify, foreignSubagentsEnabled, sessionForeignSubagents, onSessionForeignSubagents }: {
  session: Session;
  providers: readonly Provider[];
  onOpenChild: (session: Session) => void;
  notify: (message: string, tone?: "normal" | "error") => void;
  /** Master gate from Settings; the per-session control only exists while it is on. */
  foreignSubagentsEnabled: boolean;
  /** Effective per-session choice: explicit override or, absent one, allowed. */
  sessionForeignSubagents: boolean;
  onSessionForeignSubagents: (allowed: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [children, setChildren] = useState<readonly Session[]>([]);
  const [sideChats, setSideChats] = useState<readonly { id: string; title: string; providerId: string; state: string; updatedAt: string; preview?: string }[]>([]);
  const [eyesTargets, setEyesTargets] = useState<readonly VisionProxyTarget[]>([]);
  const [eyes, setEyes] = useState<VisionProxyStatus | null>(null);
  const [eyesChoice, setEyesChoice] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }, []);
  const closeFromOutside = useCallback(() => setOpen(false), []);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setChildren(await listChildSessions(session.id)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setLoading(false); }
    // The eyes helper is deliberately absent from the task list, so this panel is the
    // only place it is visible. Failures here stay quiet: it is secondary detail.
    try {
      const [available, current] = await Promise.all([
        request("vision.targets", {}),
        request("session.vision.get", { sessionId: session.id }),
      ]);
      setEyesTargets(Array.isArray(available.targets) ? available.targets as unknown as VisionProxyTarget[] : []);
      setEyes((current.vision as unknown as VisionProxyStatus | undefined) ?? null);
    } catch { /* secondary detail; the rest of the panel still stands */ }
    // Side chats are nested rather than listed, so a finished one is otherwise
    // unreachable. Opening one reads it; it is not resumed from here.
    try {
      const result = await request("session.side_chats", { sessionId: session.id });
      setSideChats(Array.isArray(result.sessions) ? result.sessions as unknown as typeof sideChats : []);
    } catch { /* secondary detail */ }
  }, [notify, session.id]);
  const configureEyes = useCallback(async (value: string) => {
    setEyesChoice(value);
    try {
      // Split on the first separator only: a provider id never contains one, but a
      // model id legitimately can.
      const cut = value.indexOf("|");
      const providerId = cut > 0 ? value.slice(0, cut) : "";
      const modelId = cut > 0 ? value.slice(cut + 1) : "";
      const selection = providerId && modelId ? { providerId, modelId } : null;
      await request("session.vision.configure", { sessionId: session.id, selection: selection as unknown as JsonObject });
      const current = await request("session.vision.get", { sessionId: session.id });
      setEyes((current.vision as unknown as VisionProxyStatus | undefined) ?? null);
      notify(selection ? "Eyes model set for this task" : "Eyes model cleared");
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  }, [notify, session.id]);

  useEffect(() => { setOpen(false); setChildren([]); }, [session.id]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) closeFromOutside(); };
    const closeEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeEscape);
    return () => { window.removeEventListener("mousedown", closeOutside); window.removeEventListener("keydown", closeEscape); };
  }, [close, closeFromOutside, open]);

  return <div className={`task-details ${open ? "task-details-open" : ""}`} ref={root}>
    <button ref={trigger} type="button" className="task-details-trigger" title="Task details" aria-label="Task details" aria-expanded={open} aria-controls={popoverId} onClick={() => { if (open) close(); else { setOpen(true); void refresh(); } }}><InfoIcon /></button>
    {open ? <section id={popoverId} className="task-details-popover" role="dialog" aria-modal="false" aria-label="Task details">
      <header><strong>Task details</strong><button type="button" aria-label="Close task details" onClick={close}><XIcon /></button></header>
      <section className="task-details-section" aria-labelledby={`task-subagents-${session.id}`}>
        <h2 id={`task-subagents-${session.id}`}>Sub-agents</h2>
        {loading ? <p className="task-details-empty"><span className="spinner" /> Checking this task…</p> : children.length ? <div className="task-child-list">{children.map((child) => {
          const childProvider = providers.find((provider) => provider.id === child.providerId);
          // The logo already names the harness, so repeating "Grok Build" in text spent
          // the line on something the reader can see. The model is the fact that is not
          // otherwise visible, and it is what distinguishes two children of one harness.
          const done = child.state === "completed" || child.state === "failed" || child.state === "idle";
          return <button type="button" key={child.id} data-child-state={done ? "done" : "working"} onClick={() => { onOpenChild(child); close(); }}>
            <span className="task-child-icon"><ProviderLogo providerId={child.providerId} provider={childProvider} size={22}/></span>
            <span><strong>{child.agentNickname || child.title}</strong><small>{child.model || providerDisplayName(child.providerId, childProvider)} · {childStateLabel(child.state)}</small></span>
            {done ? null : <span className="spinner" aria-hidden="true" />}
            <ChevronRightIcon />
          </button>;
        })}</div> : <p className="task-details-empty">No sub-agents for this task.</p>}
      </section>
      {foreignSubagentsEnabled ? <section className="task-details-section" aria-labelledby={`task-foreign-subagents-${session.id}`}>
        <h2 id={`task-foreign-subagents-${session.id}`}>Other coding tools</h2>
        {/* The gate is on, so this task may spawn foreign sub-agents unless the
            user has explicitly switched it off here. */}
        <label className="task-details-eyes">
          <span><input type="checkbox" checked={sessionForeignSubagents} onChange={(event) => onSessionForeignSubagents(event.target.checked)} /> This task may spawn sub-agents on a different coding tool.</span>
        </label>
      </section> : null}
      {eyesTargets.length ? <section className="task-details-section" aria-labelledby={`task-eyes-${session.id}`}>
        <h2 id={`task-eyes-${session.id}`}>Eyes</h2>
        {/* Offered whatever this model can already do: borrowing sharper eyes for a
            capable-but-weaker vision model is as valid as giving sight to one with none. */}
        <label className="task-details-eyes">
          <span>Look at images with</span>
          <select value={eyesChoice || (eyes?.configured ? `${eyes.configured.providerId}|${eyes.configured.modelId}` : "")} onChange={(event) => void configureEyes(event.target.value)}>
            <option value="">This task's own model</option>
            {eyesTargets.flatMap((target) => target.models.map((model) => <option key={`${target.providerId}|${model.id}`} value={`${target.providerId}|${model.id}`}>{target.displayName} · {model.displayName ?? model.id}</option>))}
          </select>
        </label>
        <p className="task-details-eyes-note">{eyes?.configured ? "One helper session answers every image question for this task; it stays out of the task list." : eyes?.primaryModelSupportsImageInput === false ? "This model cannot read images on its own." : "Pick another model to read images for this task."}</p>
      </section> : null}
      {sideChats.length ? <section className="task-details-section" aria-labelledby={`task-sidechats-${session.id}`}>
        <h2 id={`task-sidechats-${session.id}`}>Side chats</h2>
        <div className="task-child-list">{sideChats.map((chat) => {
          const chatProvider = providers.find((provider) => provider.id === chat.providerId);
          return <button type="button" key={chat.id} data-child-state={chat.state === "working" ? "working" : "done"} onClick={() => { onOpenChild({ ...session, id: chat.id, title: chat.title, providerId: chat.providerId, state: chat.state as Session["state"], preview: chat.preview ?? "", updatedAt: chat.updatedAt, sessionKind: "side_chat", parentSessionId: session.id }); close(); }}>
            <span className="task-child-icon"><ProviderLogo providerId={chat.providerId} provider={chatProvider} size={22}/></span>
            <span><strong>{chat.title}</strong><small>{relativeTime(chat.updatedAt)}</small></span>
            {chat.state === "working" ? <span className="spinner" aria-hidden="true" /> : null}
            <ChevronRightIcon />
          </button>;
        })}</div>
      </section> : null}
      <section className="task-details-section task-details-facts" aria-labelledby={`task-location-${session.id}`}>
        <h2 id={`task-location-${session.id}`}>Location</h2>
        <dl><div><dt>Project</dt><dd title={session.project}>{session.project}</dd></div><div><dt>Folder</dt><dd title={session.workingDirectory || "Not reported"}>{session.workingDirectory || "Not reported"}</dd></div></dl>
      </section>
    </section> : null}
  </div>;
}

function Workspace({ snapshot, session, onBack, onNew, onBrowser, onLinkOpen, onManageWorkflow, onDraftSelectionChange, onCreateDraftSend, onDraftDirectory, handoffSummary, initialDraft, onDraftChange, initialAttachments, onAttachmentsChange, initialAnnotations, onAnnotationsChange, onDerivedSession, onOpenChild, onOpenParent, notify, updateSnapshot, timelineWindow, onLoadOlder, reasoningDisplay, agentDefaults, ears, onEarsChange, experimental, foreignSubagentsEnabled, sessionForeignSubagents, onSessionForeignSubagents, onInstantSession, onCreateSideChat, queueRevision, queueingEnabled, onQueueingEnabledChange, reportedCompaction }: {
  snapshot: DesktopSnapshot; session: Session | null; onBack: () => void; onNew: () => void; onBrowser: () => void; onLinkOpen: (url: string) => void; onManageWorkflow: (id?: string) => void;
  onDraftSelectionChange: (selection: DraftModelSelection) => void; onCreateDraftSend: (input: DraftSessionSendInput) => Promise<void>; onDraftDirectory: () => void;
  handoffSummary: string | undefined; initialDraft: string; onDraftChange: (value: string) => void; initialAttachments: readonly ComposerAttachment[]; onAttachmentsChange: (value: readonly ComposerAttachment[]) => void; initialAnnotations: readonly ResponseAnnotation[]; onAnnotationsChange: (value: readonly ResponseAnnotation[]) => void; onDerivedSession: (value: Record<string, unknown>, summary?: string, draft?: string) => void;
  onOpenChild: (session: Session) => void;
  onOpenParent: (parentSessionId: string) => void;
  notify: (message: string, tone?: "normal" | "error") => void; updateSnapshot: (value: DesktopSnapshot | ((current: DesktopSnapshot | null) => DesktopSnapshot | null) | null) => void;
  timelineWindow: TimelineWindowState | undefined; onLoadOlder: (() => Promise<void>) | undefined; reasoningDisplay: DesktopPreferencesState["reasoningDisplay"];
  agentDefaults: DesktopPreferencesState["agentDefaults"];
  ears: DesktopPreferencesState["ears"];
  onEarsChange: (value: DesktopPreferencesState["ears"]) => Promise<void>;
  experimental: boolean; foreignSubagentsEnabled: boolean; sessionForeignSubagents: boolean; onSessionForeignSubagents: (allowed: boolean) => void; onInstantSession: () => void; onCreateSideChat: (parentSessionId: string, prompt?: string, queuedMessageId?: string) => Promise<void>; queueRevision: number; queueingEnabled: boolean; onQueueingEnabledChange: (enabled: boolean) => void;
  reportedCompaction?: { isCompacting: boolean; kind: "automatic" | "manual" | null } | undefined;
}) {
  const localOpen = useLocalOpen();
  // One owner for the context reading. The header's meter used to fetch its own on
  // a timer rebuilt by every render, which a live turn re-renders far faster than
  // the timer's own delay — so the timer never reached it and the meter sat on
  // whatever it had when the turn began, which for a new task is nothing at all.
  // The poll below is keyed on the session, not on its churn, so it cannot starve.
  const [sessionContext, setSessionContext] = useState<SessionContextState | null>(null);
  const [contextCompaction, setContextCompaction] = useState<{ isCompacting: boolean; kind: "automatic" | "manual" | null }>({ isCompacting: false, kind: null });
  const [annotationRequest, setAnnotationRequest] = useState<{ text: string; anchor: { x: number; y: number } } | null>(null);
  useEffect(() => { setAnnotationRequest(null); }, [session?.id]);
  const updateContextCompaction = useCallback((isCompacting: boolean, kind: "automatic" | "manual" | null = null) => {
    setContextCompaction((current) => current.isCompacting === isCompacting && current.kind === (isCompacting ? kind : null)
      ? current
      : { isCompacting, kind: isCompacting ? kind : null });
  }, []);
  useEffect(() => {
    if (reportedCompaction) updateContextCompaction(reportedCompaction.isCompacting, reportedCompaction.kind);
  }, [reportedCompaction, updateContextCompaction]);
  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    if (!session || session.draft) {
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
        if (!disposed) updateContextCompaction(false);
        failures += 1;
        delay = Math.min(8_000, 400 * 2 ** Math.min(failures, 5));
      } finally {
        inFlight = false;
      }
      schedule(delay);
    };
    updateContextCompaction(false);
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
  }, [session?.draft, session?.id, session?.state, updateContextCompaction]);
  if (!session) return <main className="workspace empty-workspace"><EmptyState icon={<ChatIcon />} title="Choose a task" description="Open an existing task from the list, or start a fresh one with any connected coding tool." action={<Button variant="primary" onClick={onNew}><PlusIcon /> New task</Button>} /></main>;
  const timeline = snapshot.timelines[session.id];
  const approvals = snapshot.approvals.filter((approval) => approval.sessionId === session.id);
  const inputs = snapshot.inputRequests.filter((input) => input.sessionId === session.id);
  const provider = snapshot.providers.find((item) => item.id === session.providerId);
  const sessionModel = snapshot.models[session.providerId]?.find((model) => model.id === session.model || model.name === session.model);
  const directAnnotationAudio = providerAcceptsDirectAudio(session.providerId) && modelAcceptsDirectAudio(sessionModel);
  const canInterrupt = provider?.capabilities.includes("Interrupt") === true;
  const interruptSession = async () => {
    try {
      await request("session.interrupt", { sessionId: session.id });
      updateSnapshot((current) => current ? { ...current, sessions: replaceSession(current.sessions, session.id, { state: "idle" }) } : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The harness reporting no turn is proof this task is not running: a delegating
      // parent stays marked working after its hand-off turn ends, which is what left a
      // stop button on a task that had nothing to stop. Settle the state instead of
      // showing the reader an error about a turn they never started.
      if (/no active .* turn/iu.test(message)) {
        updateSnapshot((current) => current ? { ...current, sessions: replaceSession(current.sessions, session.id, { state: "idle" }) } : current);
        return;
      }
      notify(message, "error");
    }
  };
  const visibleTimeline = timelineWindow ? timeline?.slice(timelineWindow.revealStart) : undefined;
  const olderAvailable = Boolean((timelineWindow?.revealStart ?? 0) > 0 || timelineWindow?.nextCursor);
  const parentSessionId = parentSessionIdForBack(session);
  return <main className="workspace">
    <header className="workspace-header">
      {parentSessionId
        ? <IconButton label="Back to parent task" className="parent-task-back" onClick={() => onOpenParent(parentSessionId)}><ArrowLeftIcon /></IconButton>
        : <IconButton label="Show task list" className="mobile-back" onClick={onBack}><ArrowLeftIcon /></IconButton>}
      <ProviderLogo providerId={session.providerId} provider={provider} size={32}/>
      <div className="workspace-title"><div><h1>{session.title}</h1>{session.draft ? null : <Status state={session.state} />}</div><button className={`workspace-location ${session.draft ? "draft-location" : ""}`} title={session.draft ? "Choose the project folder" : session.workingDirectory || session.project} aria-label={session.draft ? `Choose project folder. Current folder: ${session.workingDirectory || "none"}` : `Open working directory: ${session.workingDirectory || session.project}`} onClick={() => { if (session.draft) onDraftDirectory(); else if (session.workingDirectory) void localOpen.open({ path: session.workingDirectory }); }}><FolderIcon /><span>{session.workingDirectory || "Choose a folder"}</span></button></div>
      <div className="workspace-actions">
        {session.draft ? null : <ContextUsageControl key={session.id} session={session} context={sessionContext?.sessionId === session.id ? sessionContext : null} notify={notify} onCompactionChange={updateContextCompaction} onContext={setSessionContext} />}
        {session.workingDirectory ? <WorkspaceLocalOpenControl path={session.workingDirectory} /> : null}
        {session.draft ? null : <TaskDetailsControl session={session} providers={snapshot.providers} onOpenChild={onOpenChild} notify={notify} foreignSubagentsEnabled={foreignSubagentsEnabled} sessionForeignSubagents={sessionForeignSubagents} onSessionForeignSubagents={onSessionForeignSubagents} />}
      </div>
    </header>
    <Conversation timeline={visibleTimeline} approvals={approvals} inputs={inputs} session={session} provider={provider} notify={notify} updateSnapshot={updateSnapshot} olderAvailable={olderAvailable} loadingOlder={timelineWindow?.loadingOlder === true} onLoadOlder={onLoadOlder} onLinkOpen={onLinkOpen} onWorkflowOpen={onManageWorkflow} onAnnotateSelection={(text, anchor) => setAnnotationRequest({ text, anchor })} reasoningDisplay={reasoningDisplay} isCompacting={contextCompaction.isCompacting} compactionKind={contextCompaction.kind} />
    {annotationRequest ? <ResponseAnnotationEditor selectedText={annotationRequest.text} anchor={annotationRequest.anchor} providerId={session.providerId} request={request} notify={notify} directAudioAvailable={directAnnotationAudio} earsEnabled={ears.enabled} onClose={() => setAnnotationRequest(null)} onSave={(annotation) => { onAnnotationsChange([...initialAnnotations, annotation]); setAnnotationRequest(null); }} /> : null}
    {handoffSummary ? <aside className="context-handoff-summary" aria-label="Context handoff summary"><span><ChatIcon /><strong>Context carried into this new task</strong><small>{handoffSummary.split(/\s+/u).length} words</small></span><p>{handoffSummary}</p></aside> : null}
    <Composer key={session.id} snapshot={snapshot} session={session} request={request} selectImages={selectImages} preview={isBrowserPreview} notify={notify} updateSnapshot={updateSnapshot} onBrowser={onBrowser} onManageWorkflow={onManageWorkflow} initialDraft={initialDraft} onDraftChange={onDraftChange} initialAttachments={initialAttachments} onAttachmentsChange={onAttachmentsChange} initialAnnotations={initialAnnotations} onAnnotationsChange={onAnnotationsChange} onDerivedSession={onDerivedSession} onDraftSelectionChange={onDraftSelectionChange} onCreateDraftSend={onCreateDraftSend} experimental={experimental} onInstantSession={onInstantSession} onCreateSideChat={onCreateSideChat} queueRevision={queueRevision} queueingEnabled={queueingEnabled} onQueueingEnabledChange={onQueueingEnabledChange} agentDefaults={agentDefaults} ears={ears} onEarsChange={onEarsChange} {...(canInterrupt ? { onInterrupt: interruptSession } : {})} />
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
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setSaving(false);
      if (compactImmediately) onCompactionChange(false);
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
  // While the popover is open the meter previews the draft threshold. Closing
  // without Apply discards that draft, so the compact meter returns to the
  // bridge-confirmed limit instead of presenting an unsaved value as active.
  const meterLimit = thresholdAvailable ? safeThreshold : appliedLimit;
  const reportedPercent = used !== null && meterLimit !== null && meterLimit > 0
    ? used / meterLimit * 100
    : context?.usedPercent ?? null;
  const percent = reportedPercent !== null && Number.isFinite(reportedPercent) ? reportedPercent : null;
  const shownPercent = percent === null ? 0 : clampPercent(percent);
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
          <span className="context-expanded-track" role="progressbar" aria-label={meterLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.round(shownPercent)}><i style={{ width: `${shownPercent}%` }} /></span>
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

type ConversationReaderAnchor = { readonly id: string; readonly offset: number };
type ConversationScrollMode =
  | { readonly kind: "follow_tail" }
  | { readonly kind: "preserve_view"; readonly anchor: ConversationReaderAnchor | null };

const followTailScrollMode: ConversationScrollMode = Object.freeze({ kind: "follow_tail" });

function Conversation({ timeline, approvals, inputs, session, provider, notify, updateSnapshot, olderAvailable, loadingOlder, onLoadOlder, onLinkOpen, onWorkflowOpen, onAnnotateSelection, reasoningDisplay, isCompacting, compactionKind }: {
  timeline: TimelineItem[] | undefined; approvals: ApprovalRequest[]; inputs: InputRequest[]; session: Session;
  provider?: Provider | undefined;
  notify: (message: string, tone?: "normal" | "error") => void; updateSnapshot: (value: DesktopSnapshot | ((current: DesktopSnapshot | null) => DesktopSnapshot | null) | null) => void;
  olderAvailable: boolean; loadingOlder: boolean; onLoadOlder: (() => Promise<void>) | undefined;
  onLinkOpen: (url: string) => void;
  onWorkflowOpen: (id: string) => void;
  onAnnotateSelection: (text: string, anchor: { x: number; y: number }) => void;
  reasoningDisplay: DesktopPreferencesState["reasoningDisplay"];
  isCompacting: boolean;
  compactionKind: "automatic" | "manual" | null;
}) {
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
  const readerScrollIntentUntil = useRef(0);
  const lastScrollGeometry = useRef({ scrollHeight: 0, clientHeight: 0 });
  const pointerOrigin = useRef<{ x: number; y: number } | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadOlderProp = useRef(onLoadOlder);
  const timelineSignature = useMemo(
    // Include the rendered size-bearing fields, not only row membership. A live
    // delta normally grows the same final row, so length/first/last alone leaves
    // FOLLOW_TAIL waiting for ResizeObserver and can expose one line-height frame
    // before the observer corrects it. This commit signature lets the single
    // layout writer apply the current atomic policy before that frame is painted.
    () => timeline ? timeline.map((item) => `${item.id}:${item.body.length}:${item.state ?? ""}`).join("|") : "none",
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
  const markReaderScrollIntent = useCallback(() => {
    readerScrollIntentUntil.current = Date.now() + READER_SCROLL_INTENT_MS;
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
    if (anchor && id) setScrollMode({ kind: "preserve_view", anchor: { id, offset: anchor.getBoundingClientRect().top - viewport.top } });
  }, [setScrollMode]);
  const restoreReaderAnchor = useCallback((force = false) => {
    const element = scroller.current;
    const anchor = scrollMode.current.kind === "preserve_view" ? scrollMode.current.anchor : null;
    // A reader moving the native scrollbar does not reliably deliver pointer
    // events to the page. Never let a resize correction race a gesture that the
    // scroll events themselves have identified.
    if (!element || !anchor || (!force && Date.now() <= readerScrollIntentUntil.current)) return;
    const target = [...element.querySelectorAll<HTMLElement>("[data-scroll-anchor]")].find((candidate) =>
      candidate.dataset.scrollAnchor === anchor.id || candidate.dataset.scrollMembers?.split("|").includes(encodeURIComponent(anchor.id)));
    if (!target) return;
    const viewportTop = element.getBoundingClientRect().top;
    const bounds = target.getBoundingClientRect();
    // If the exact row was folded into a now-short Reasoning control, its old
    // deep negative offset is no longer meaningful. Put the surviving control at
    // the reading edge instead of letting the browser clamp to the document end.
    const foldedIntoGroup = target.dataset.scrollAnchor !== anchor.id
      && target.dataset.scrollMembers?.split("|").includes(encodeURIComponent(anchor.id)) === true;
    const desiredOffset = foldedIntoGroup && anchor.offset < 0 && bounds.height < -anchor.offset + 24 ? 0 : anchor.offset;
    applyScrollTop(element, element.scrollTop + bounds.top - viewportTop - desiredOffset);
  }, [applyScrollTop]);
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
  useEffect(() => () => { if (releaseTimer.current !== undefined) clearTimeout(releaseTimer.current); }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    const composer = element?.parentElement?.querySelector<HTMLElement>(".composer-wrap");
    const spacer = tailSpacer.current;
    if (!element || !composer || !spacer) return;
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
  }, [scrollToLatest, session.id, setScrollMode]);
  // One writer for the scroll position, so the history anchor and the follow-the-tail
  // behaviour can never both act on the same commit and fight each other.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (activeSession.current !== session.id) {
      activeSession.current = session.id;
      releaseHistoryAnchor();
      signature.current = timelineSignature;
      scrollMode.current = sessionScrollModes.current.get(session.id) ?? followTailScrollMode;
      if (scrollMode.current.kind === "follow_tail") scrollToLatest();
      else restoreReaderAnchor(true);
      return;
    }
    if (historyAnchor.current !== null) {
      applyScrollTop(element, anchoredScrollTop(element, historyAnchor.current));
      // Release only once the page itself is on screen: the spinner appearing is a
      // separate commit, and letting go there would leave the real prepend unanchored.
      if (anchoredSignature.current !== timelineSignature && !loadingOlder) releaseHistoryAnchor();
      signature.current = timelineSignature;
      return;
    }
    signature.current = timelineSignature;
    if (scrollMode.current.kind === "follow_tail") followTail();
  }, [applyScrollTop, followTail, loadingOlder, releaseHistoryAnchor, restoreReaderAnchor, scrollToLatest, session.id, timelineSignature]);
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
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("pointermove", move);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("blur", release);
    };
  }, [followTail, markReaderScrollIntent]);
  const loadOlder = useCallback(async () => {
    const element = scroller.current;
    const load = loadOlderProp.current;
    if (!element || !load || !olderAvailable || loadingOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
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
  }, [loadingOlder, olderAvailable, releaseHistoryAnchor]);
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
    const geometryStable = Math.abs(element.scrollHeight - lastScrollGeometry.current.scrollHeight) <= 1
      && Math.abs(element.clientHeight - lastScrollGeometry.current.clientHeight) <= 1;
    const steppedOffEnd = !echoed && movedOffEnd(element, lastScrollTop.current);
    // Native scrollbar drags may emit no pointer event into page content. A
    // non-echoed offset change with unchanged geometry can only be navigation,
    // whereas compaction, folding, resize and browser clamping change geometry.
    const readerInitiated = !echoed && (Date.now() <= readerScrollIntentUntil.current || geometryStable);
    if (readerInitiated) markReaderScrollIntent();
    const readerAboveEnd = readerInitiated && !isAtPhysicalBottom(element);
    const returnedToEnd = !echoed && readerReturnedToEnd(element, lastScrollTop.current, readerInitiated);
    writtenScrollTop.current = null;
    lastScrollTop.current = element.scrollTop;
    lastScrollGeometry.current = { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
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
    // Record wherever an external scroll event left the viewport, even when a
    // passive layout change caused it. This prevents a stale anchor from later
    // undoing a native scrollbar move that did not expose pointer intent.
    if (!echoed && scrollMode.current.kind === "preserve_view") captureReaderAnchor();
    // Follow the reader through an in-flight load instead of yanking them back.
    if (historyAnchor.current !== null && !echoed) historyAnchor.current = distanceFromEnd(element);
    if (shouldRequestOlder(element)) void loadOlder();
  }}>
    <div className="conversation" ref={conversation}>
      {olderAvailable || loadingOlder ? <div className="history-loading" data-busy={loadingOlder ? "true" : "false"} {...(loadingOlder ? { role: "status", "aria-label": "Loading earlier messages" } : { "aria-hidden": true })}><span className="spinner" /></div> : null}
      <div className="conversation-date"><span />Today<span /></div>
      {timeline === undefined ? <LoadingState label="Loading task history" /> : timeline.length === 0 && approvals.length === 0 && inputs.length === 0 ? <EmptyState icon={<ChatIcon />} title="No messages yet" description="Send the first instruction to begin this task." /> : null}
      {timeline ? <ChatTimeline timeline={timeline} providerId={session.providerId} provider={provider} providerStatus={session.providerStatus} onLinkOpen={onLinkOpen} onWorkflowOpen={onWorkflowOpen} onAnnotateSelection={onAnnotateSelection} onContinueInComposer={() => {
        const composer = document.getElementById("composer-message");
        if (!(composer instanceof HTMLTextAreaElement)) return;
        composer.focus({ preventScroll: true });
        composer.scrollIntoView({ block: "nearest" });
      }} reasoningDisplay={reasoningDisplay} isCompacting={isCompacting} compactionKind={compactionKind} active={sessionHoldsFollowUpQueue(session, timeline)}/> : null}
      {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onRespond={async (choiceId) => {
        try {
          await request("approval.respond", { requestId: approval.id, choiceId, respondedAt: new Date().toISOString() });
          updateSnapshot((current) => current ? { ...current, approvals: current.approvals.filter((item) => item.id !== approval.id), sessions: replaceSession(current.sessions, session.id, { state: choiceId.toLowerCase().includes("reject") ? "idle" : "working" }) } : current);
          notify("Approval response sent");
        } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
      }} />)}
      {inputs.map((input) => <InputCard key={input.id} request={input} onSubmit={async (answer) => {
        try {
          await request("user_input.respond", { requestId: input.id, answers: { [input.answerKey]: [answer] }, respondedAt: new Date().toISOString() });
          updateSnapshot((current) => current ? { ...current, inputRequests: current.inputRequests.filter((item) => item.id !== input.id), sessions: replaceSession(current.sessions, session.id, { state: "working" }) } : current);
          notify("Answer sent");
        } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
      }} />)}
      <div className="conversation-tail-spacer" ref={tailSpacer} aria-hidden="true" />
    </div>
  </div>;
}

function ApprovalCard({ approval, onRespond }: { approval: ApprovalRequest; onRespond: (choiceId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <article className="request-card approval-card"><div className="request-icon"><ShieldIcon /></div><div className="request-content"><p className="eyebrow">Permission required</p><h3>{approval.title}</h3><p>{approval.reason}</p>{approval.command ? <pre><TerminalIcon />{approval.command}</pre> : null}<dl>{approval.directory ? <><dt>Directory</dt><dd>{approval.directory}</dd></> : null}{approval.files?.length ? <><dt>Files</dt><dd>{approval.files.join(", ")}</dd></> : null}</dl><div className="request-actions">{approval.choices.map((choice) => <Button key={choice.id} variant={choice.kind === "approve" ? "primary" : "secondary"} disabled={busy} onClick={async () => { setBusy(true); await onRespond(choice.id); setBusy(false); }}>{choice.label}</Button>)}</div></div></article>;
}

function InputCard({ request: input, onSubmit }: { request: InputRequest; onSubmit: (answer: string) => Promise<void> }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  return <article className="request-card input-card"><div className="request-icon"><QuestionIcon /></div><div className="request-content"><p className="eyebrow">Your input is needed</p><h3>{input.title}</h3><p>{input.prompt}</p>{input.options ? <div className="input-options">{input.options.map((option) => <button key={option} className={answer === option ? "selected" : ""} onClick={() => setAnswer(option)}>{option}{answer === option ? <CheckIcon /> : null}</button>)}</div> : <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Type your answer…" rows={3}/>}<div className="request-actions"><Button variant="primary" disabled={!answer.trim() || busy} onClick={async () => { setBusy(true); await onSubmit(answer.trim()); setBusy(false); }}>Submit answer <SendIcon /></Button></div></div></article>;
}

function Dashboard({ snapshot, sessions, onOpen, onNew, onProvider }: { snapshot: DesktopSnapshot; sessions: readonly Session[]; onOpen: (id: string) => void; onNew: () => void; onProvider: (id: ProviderFilterSelection) => void }) {
  const working = sessions.filter((session) => session.state === "working");
  const attention = sessions.filter((session) => session.state === "needs_approval" || session.state === "needs_input" || session.state === "failed");
  const recent = [...sessions].sort(compareOrganizedSessions).slice(0, 6);
  const active = working[0] ?? attention[0];
  return <main className="dashboard-page">
    <header className="page-heading"><div><p className="eyebrow">Local coding workspace</p><h1>Dashboard</h1><p>Everything running across your coding tools, in one calm place.</p></div><Button variant="primary" onClick={onNew}><PlusIcon /> New task</Button></header>
    {!snapshot.connected ? <ErrorBanner title="Local runtime is offline" message="Your cached tasks are still visible. Reconnect the runtime to send instructions or approve actions." /> : null}
    <section className="dashboard-grid">
      <article className="active-task-card">
        <div className="card-heading"><span><i />Active now</span>{active ? <ProviderLabel providerId={active.providerId} provider={providerFor(snapshot.providers, active.providerId)} /> : null}</div>
        {active ? <button onClick={() => onOpen(active.id)}><div><Status state={active.state} /><h2>{active.title}</h2><p>{active.preview}</p></div><div className="active-task-footer"><span><FolderIcon />{active.project}</span><span>{relativeTime(active.updatedAt)}</span><ChevronRightIcon /></div></button> : <EmptyState icon={<CheckIcon />} title="Nothing running" description="Start a task when you are ready." />}
      </article>
      <article className="attention-card"><div className="card-heading"><span>Needs attention</span><b>{attention.length}</b></div>{attention.length ? attention.slice(0, 3).map((session) => <button key={session.id} onClick={() => onOpen(session.id)}><ProviderLogo providerId={session.providerId} provider={providerFor(snapshot.providers, session.providerId)} size={25}/><span><strong>{session.title}</strong><small>{session.preview}</small></span><Status state={session.state} compact/><ChevronRightIcon /></button>) : <EmptyState icon={<ShieldIcon />} title="You’re all clear" description="Approvals and questions will appear here." />}</article>
    </section>
    <section className="recent-section"><div className="section-title"><div><p className="eyebrow">Across every coding tool</p><h2>Recent tasks</h2></div><button onClick={() => onProvider("all")}>View all <ChevronRightIcon /></button></div><div className="recent-table"><div className="recent-table-head"><span>Task</span><span>Coding tool</span><span>Project</span><span>Status</span><span>Updated</span><span /></div>{recent.map((session) => { const provider = providerFor(snapshot.providers, session.providerId); return <button key={session.id} onClick={() => onOpen(session.id)}><span><ProviderLogo providerId={session.providerId} provider={provider} size={25}/><strong>{session.title}</strong></span><span>{providerDisplayName(session.providerId, provider)}</span><span>{session.project}</span><Status state={session.state} compact/><time>{relativeTime(session.updatedAt)}</time><ChevronRightIcon /></button>; })}</div></section>
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
      <ChevronDownIcon className="details-chevron" />
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
      <ChevronDownIcon className="details-chevron" />
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

function SettingsPage({ snapshot, bootstrap, recorder, workflows, selectedWorkflowId, onSelectWorkflow, setWorkflows, onSaveWorkflow, onClose, onConnectorState, notify, onReconnect, preferences, onSetExperimentalFeatures, onSetAllowForeignSubagents, onSetReasoningDisplay, onSetDesktopBehavior, onSetAgentDefault }: {
  snapshot: DesktopSnapshot;
  bootstrap?: DesktopBootstrap;
  recorder: RecorderState;
  workflows: readonly WorkflowDescriptor[];
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string | null) => void;
  setWorkflows: (value: readonly WorkflowDescriptor[] | ((current: readonly WorkflowDescriptor[]) => readonly WorkflowDescriptor[])) => void;
  onSaveWorkflow: () => void;
  onClose: () => void;
  onConnectorState: (connectors: DesktopBootstrap["connectors"]) => void;
  notify: (message: string, tone?: "normal" | "error") => void;
  onReconnect: (id: string) => Promise<void>;
  preferences: DesktopPreferencesState;
  onSetExperimentalFeatures: (enabled: boolean) => Promise<void>;
  onSetAllowForeignSubagents: (enabled: boolean) => Promise<void>;
  onSetReasoningDisplay: (value: DesktopPreferencesState["reasoningDisplay"]) => Promise<void>;
  onSetDesktopBehavior: (action: PreferencesAction) => Promise<void>;
  onSetAgentDefault: (providerId: string, modelId: string, reasoningEffort?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<PendingDesktopConnectorDescriptor | null>(null);
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
    <WorkflowSettings recorder={recorder} workflows={workflows} selectedWorkflowId={selectedWorkflowId} onSelectWorkflow={onSelectWorkflow} onStart={startWorkflow} onSave={onSaveWorkflow} onReveal={revealWorkflow} onDelete={deleteWorkflow} onListScreenshots={listWorkflowScreenshots} onLoadScreenshot={loadWorkflowScreenshot} />
    <AgentDefaultsSettings snapshot={snapshot} preferences={preferences} onChange={onSetAgentDefault} onGlobalAgentsAction={onSetDesktopBehavior} onReconnect={onReconnect} />
    <DictationSettings request={request} notify={notify} />
    {bootstrap?.connectors ? <section className="settings-block connector-section"><header><h2>External connectors</h2><span className="settings-info" tabIndex={0} data-tooltip="Independent connectors run local code. Use trusted sources."><InfoIcon /></span></header><div className="connector-settings"><button className="connector-directory-action" onClick={() => { if (!isBrowserPreview) void window.tethoqDesktop.revealPath(bootstrap.connectors.directory); }}><FolderIcon /><strong>Connector folder</strong>{bootstrap.connectors.loaded.length || bootstrap.connectors.pending.length ? <small>{bootstrap.connectors.loaded.length} active · {bootstrap.connectors.pending.length} to review</small> : null}</button><div className="connector-list">{bootstrap.connectors.pending.map((connector) => <PendingConnectorCard key={connector.fingerprint} connector={connector} onReview={() => setReviewing(connector)} />)}{bootstrap.connectors.loaded.map((connector) => <ConnectorCard key={connector.id} connector={connector} provider={providerFor(snapshot.providers, connector.id)} onDisable={() => void connectorAction("revoke", connector.fingerprint)} />)}</div>{rejectedConnectors.length ? <details className="settings-alert-details"><summary><AlertIcon /><strong>{rejectedConnectors.length} connector {rejectedConnectors.length === 1 ? "issue" : "issues"}</strong><ChevronDownIcon /></summary><div>{rejectedConnectors.map((diagnostic, index) => <article key={`${diagnostic.directory}-${index}`}><strong>{diagnostic.connectorId ?? "Unknown connector"}</strong><p>{diagnostic.message}</p></article>)}</div></details> : null}</div></section> : null}
    <div className="settings-compact-grid"><details className="settings-compact-details"><summary><strong>Local runtime</strong><i className={`connection-dot ${snapshot.connected ? "online" : "offline"}`} data-tooltip={snapshot.connected ? "Runtime online" : "Runtime offline"}/><ChevronDownIcon /></summary><dl><div><dt>Tethoq</dt><dd>v{bootstrap?.app.version ?? "0.1.0"}</dd></div><div><dt>Computer</dt><dd>{snapshot.hostName}</dd></div><div><dt>Platform</dt><dd>{bootstrap?.host.platform ?? "Windows"}</dd></div><div><dt>Managed process</dt><dd>{bootstrap?.openCode.state ?? "Unknown"}</dd></div><div><dt>Address</dt><dd>{bootstrap?.openCode.url ?? "Local bridge"}</dd></div></dl></details><details className="settings-compact-details"><summary><strong>Desktop behavior</strong><ChevronDownIcon /></summary><dl>
      <div><dt>Close</dt><dd><select aria-label="Close button" value={preferences.closeAction} disabled={isBrowserPreview} title="Tasks and alerts keep running while Tethoq stays in the tray." onChange={(event) => void onSetDesktopBehavior({ type: "set-close-action", value: event.target.value === "quit" ? "quit" : "tray" })}><option value="tray">Keep running in tray</option><option value="quit">Quit Tethoq</option></select></dd></div>
      <div><dt>Alerts</dt><dd><select aria-label="Alerts" value={preferences.alerts} disabled={isBrowserPreview} title="Windows notifications while the Tethoq window is not in focus." onChange={(event) => void onSetDesktopBehavior({ type: "set-alerts", value: event.target.value === "attention" ? "attention" : event.target.value === "off" ? "off" : "all" })}><option value="all">Everything</option><option value="attention">Only when I’m needed</option><option value="off">Off</option></select></dd></div>
      <div><dt>Startup</dt><dd><select aria-label="Startup" value={preferences.launchAtLogin} disabled={isBrowserPreview} title="Starting with Windows keeps your agents reachable after a restart." onChange={(event) => void onSetDesktopBehavior({ type: "set-launch-at-login", value: event.target.value === "window" ? "window" : event.target.value === "tray" ? "tray" : "off" })}><option value="off">Launch manually</option><option value="window">Start with Windows</option><option value="tray">Start hidden in tray</option></select></dd></div>
      <div><dt>Reasoning display</dt><dd><select aria-label="Reasoning display" value={preferences.reasoningDisplay} disabled={isBrowserPreview} title="Expanded streams every thought in full as it is written and shows tool calls as their own expandable rows. It does not change model effort." onChange={(event) => void onSetReasoningDisplay(event.target.value === "expanded" ? "expanded" : "compact")}><option value="compact">Compact</option><option value="expanded">Expanded</option></select></dd></div>
    </dl></details></div>
    <section className="settings-block experimental-features-block"><header><h2>Experimental features</h2><span className="settings-info" tabIndex={0} data-tooltip="Optional capabilities that may change. Disabled by default."><InfoIcon /></span></header><div className="settings-list"><article><span><strong>Enable experimental features</strong><small>Adds instant sessions: talk to a coding tool while your microphone, screen, and pointer position are captured, time-aligned, and sent with each utterance.</small></span><button type="button" className={`settings-toggle ${preferences.experimentalFeatures ? "on" : ""}`} role="switch" aria-checked={preferences.experimentalFeatures} aria-label="Enable experimental features" disabled={isBrowserPreview} onClick={() => void onSetExperimentalFeatures(!preferences.experimentalFeatures)}><i /></button></article></div></section>
    {/* Same row markup as the experimental gate: one master switch for the
        foreign-subagent permission model, kept next to the other gates. */}
    <section className="settings-block experimental-features-block"><header><h2>Sub-agents</h2><span className="settings-info" tabIndex={0} data-tooltip="Controls whether a task may spawn sub-agents on a different coding tool."><InfoIcon /></span></header><div className="settings-list"><article><span><strong>Allow sub-agents from other coding tools</strong><small>An agent may spawn sub-agents on a coding tool different from its own. Off by default.</small></span><button type="button" className={`settings-toggle ${preferences.allowForeignSubagents === true ? "on" : ""}`} role="switch" aria-checked={preferences.allowForeignSubagents === true} aria-label="Allow sub-agents from other coding tools" disabled={isBrowserPreview} onClick={() => void onSetAllowForeignSubagents(preferences.allowForeignSubagents !== true)}><i /></button></article></div></section>
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
  { id: "settings:desktop", targetId: "settings-page", label: "Desktop behavior", detail: "Close, alerts, startup, and reasoning display", keywords: "desktop behavior close tray quit alerts notifications startup login launch windows reasoning display" },
  { id: "settings:runtime", targetId: "settings-page", label: "Local runtime", detail: "Desktop bridge status", keywords: "runtime bridge host local" },
  { id: "settings:experimental", targetId: "settings-page", label: "Experimental features", detail: "Optional desktop capabilities", keywords: "experimental feature instant session" },
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
