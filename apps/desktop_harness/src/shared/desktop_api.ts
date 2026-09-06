import type {
  AgentEvent,
  Host,
  JsonObject,
  ProviderConnection,
  RequestEnvelope,
  ResponseEnvelope,
  VisionProxySelection,
  VisionProxyStatus,
  VisionProxyTarget,
} from "../../../../packages/protocol/src/index.js";

export type { VisionProxySelection, VisionProxyStatus, VisionProxyTarget };

/**
 * Renderer RPC seam for per-session visual support:
 * - `vision.targets` -> `{ targets: VisionProxyTarget[], incomplete: boolean }`
 * - `session.vision.get` `{ sessionId }` -> `{ vision: VisionProxyStatus }`
 * - `session.vision.configure` `{ sessionId, selection: VisionProxySelection | null }`
 * - `session.vision.ask` `{ sessionId, question, attachments? }` -> `{ observation }`
 */
export const VISION_PROXY_REQUESTS = Object.freeze({
  targets: "vision.targets",
  get: "session.vision.get",
  configure: "session.vision.configure",
  ask: "session.vision.ask",
} as const);

/** Built-in providers shipped and trusted by the desktop application. */
export const DESKTOP_PROVIDERS = ["codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct"] as const;
export type BuiltInDesktopProviderId = (typeof DESKTOP_PROVIDERS)[number];
/** External connector IDs are validated by the main-process connector registry. */
export type DesktopProviderId = string;

export const IPC_CHANNELS = Object.freeze({
  bootstrap: "tethoq:bootstrap",
  request: "tethoq:request",
  selectDirectory: "tethoq:select-directory",
  selectImages: "tethoq:select-images",
  selectFiles: "tethoq:select-files",
  captureScreens: "tethoq:capture-screens",
  revealPath: "tethoq:reveal-path",
  copyText: "tethoq:copy-text",
  localOpenHandlers: "tethoq:local-open-handlers",
  openLocalTarget: "tethoq:open-local-target",
  openDictationSetupPage: "tethoq:open-dictation-setup-page",
  openHarnessSetupPage: "tethoq:open-harness-setup-page",
  showWindow: "tethoq:show-window",
  hideWindow: "tethoq:hide-window",
  /** Renderer has its first snapshot and is worth looking at. */
  rendererReady: "tethoq:renderer-ready",
  openCodeStatus: "tethoq:opencode-status",
  restartOpenCode: "tethoq:restart-opencode",
  connectorAction: "tethoq:connector-action",
  eventBatch: "tethoq:event-batch",
  runtimeState: "tethoq:runtime-state",
  browserState: "tethoq:browser-state",
  browserNotice: "tethoq:browser-notice",
  browserGetState: "tethoq:browser-get-state",
  browserAction: "tethoq:browser-action",
  recorderState: "tethoq:recorder-state",
  recorderEvent: "tethoq:recorder-event",
  recorderGetState: "tethoq:recorder-get-state",
  recorderAction: "tethoq:recorder-action",
  preferencesState: "tethoq:preferences-state",
  preferencesGet: "tethoq:preferences-get",
  preferencesAction: "tethoq:preferences-action",
  liveSessionState: "tethoq:live-session-state",
  liveSessionEvent: "tethoq:live-session-event",
  liveSessionGetState: "tethoq:live-session-get-state",
  liveSessionAction: "tethoq:live-session-action",
  mobileConnectionState: "tethoq:mobile-connection-state",
  mobileConnectionGetState: "tethoq:mobile-connection-get-state",
  mobileConnectionAction: "tethoq:mobile-connection-action",
  smokeQuit: "tethoq:smoke-quit",
} as const);

export interface DesktopBootstrap {
  readonly app: {
    readonly name: string;
    readonly version: string;
    readonly platform: NodeJS.Platform;
    readonly packaged: boolean;
  };
  readonly host: Host;
  readonly providers: readonly ProviderConnection[];
  readonly allowedProviders: readonly DesktopProviderId[];
  readonly connectors: DesktopConnectorState;
  readonly latestSequence: number;
  readonly openCode: OpenCodeProcessStatus;
  readonly providerSetupIssues?: readonly { readonly providerId: string; readonly message: string }[];
}

export interface DesktopConnectorDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: "external";
  readonly fingerprint: string;
  readonly directory: string;
  readonly permissions: {
    readonly filesystem: "none" | "workspace" | "unrestricted";
    readonly network: boolean;
    readonly spawnProcesses: boolean;
  };
  readonly capabilities: {
    readonly attachments: boolean;
    readonly reasoningEfforts: boolean;
    readonly messageQueue: boolean;
  };
}

export interface PendingDesktopConnectorDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly fingerprint: string;
  readonly directory: string;
  readonly runtime: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  };
  readonly requestedEnvironmentNames: readonly string[];
  readonly permissions: DesktopConnectorDescriptor["permissions"];
}

export interface DesktopConnectorDiagnostic {
  readonly directory: string;
  readonly state: "loaded" | "rejected";
  readonly connectorId?: string;
  readonly message: string;
}

export interface DesktopConnectorState {
  readonly directory: string;
  readonly loaded: readonly DesktopConnectorDescriptor[];
  readonly pending: readonly PendingDesktopConnectorDescriptor[];
  readonly diagnostics: readonly DesktopConnectorDiagnostic[];
}

export type ConnectorAction =
  | { readonly type: "approve"; readonly fingerprint: string }
  | { readonly type: "revoke"; readonly fingerprint: string };

export interface ConnectorActionResult {
  readonly connectors: DesktopConnectorState;
  readonly restartRequired: boolean;
}

export type OpenCodeProcessState = "external" | "starting" | "managed" | "stopped" | "unavailable" | "failed";

export interface OpenCodeProcessStatus {
  readonly state: OpenCodeProcessState;
  readonly url: string;
  readonly managed: boolean;
  readonly pid?: number;
  readonly message?: string;
  /** Stable machine-readable cause used for safe supervision decisions. */
  readonly reason?: "credentials_required" | "port_in_use";
}

export interface DesktopEventBatch {
  readonly events: readonly AgentEvent[];
  readonly latestSequence: number;
  readonly replayGap: boolean;
}

export interface DesktopRuntimeState {
  readonly state: "starting" | "ready" | "stopping" | "failed";
  readonly message?: string;
}

export interface MobileConnectionDevice {
  /** Opaque main-process handle used only to remove this pairing. */
  readonly id: string;
  readonly pairedAt: string;
  /** True only while this saved phone has an authenticated live connection. */
  readonly connected: boolean;
}

export interface MobileConnectionState {
  readonly state: "idle" | "starting" | "ready" | "paired" | "error";
  readonly devices: readonly MobileConnectionDevice[];
  readonly qrDataUrl?: string;
  readonly expiresAt?: string;
  readonly message?: string;
}

export type MobileConnectionAction =
  | { readonly type: "start" }
  | { readonly type: "revoke"; readonly connectionId: string };

export type AttachmentOrigin = "file-picker" | "drag-drop" | "clipboard" | "dictation";

export interface SelectedImage {
  readonly name: string;
  readonly path: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly dataBase64: string;
  readonly origin?: AttachmentOrigin;
}

/** A single user-selected file. The main process rejects folders and executable/package binaries. */
export interface SelectedFile {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly dataBase64: string;
  readonly origin?: AttachmentOrigin;
}

/** A bounded desktop snapshot prepared by the main process for interactive cropping. */
export interface ScreenCaptureSource {
  readonly id: string;
  readonly name: string;
  readonly displayId: string;
  readonly width: number;
  readonly height: number;
  readonly dataUrl: string;
}

export interface BrowserBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface BrowserTabState {
  readonly id: string; readonly title: string; readonly url: string; readonly faviconUrl: string | null;
  readonly loading: boolean; readonly canGoBack: boolean; readonly canGoForward: boolean; readonly crashed: boolean; readonly error: string | null;
  readonly muted: boolean; readonly audible: boolean;
}
export interface BrowserDownloadState {
  readonly id: string; readonly tabId: string | null; readonly filename: string; readonly url: string; readonly state: "progressing" | "completed" | "cancelled" | "interrupted";
  readonly savePath: string | null; readonly mimeType: string; readonly receivedBytes: number; readonly totalBytes: number; readonly bytesPerSecond: number;
  readonly paused: boolean; readonly startedAt: string; readonly finishedAt: string | null;
}
export interface BrowserPermissionRequest {
  readonly id: string; readonly origin: string; readonly permission: string; readonly tabId: string; readonly requestingUrl: string; readonly requestedAt: string;
}
export interface BrowserWorkspaceState {
  readonly partition: "persist:tethoq-browser";
  readonly profile: { readonly persistent: true; readonly appOwned: true; readonly importsSystemProfile: false; readonly clearing: boolean };
  readonly visible: boolean; readonly bounds: BrowserBounds; readonly activeTabId: string | null;
  readonly tabs: readonly BrowserTabState[]; readonly downloads: readonly BrowserDownloadState[];
  readonly pendingPermissions: readonly BrowserPermissionRequest[];
  readonly permissionDecisions: readonly { readonly origin: string; readonly permission: string; readonly decision: "allow" | "deny" }[];
  readonly overlaySnapshotDataUrl?: string;
  readonly overlayToken?: number;
}
export interface BrowserNotice {
  readonly tone: "info" | "error";
  readonly message: string;
  readonly action?: "focus-address";
  readonly tabId?: string;
}
export type BrowserAction =
  | { readonly type: "create-tab"; readonly input?: string; readonly activate?: boolean }
  | { readonly type: "activate-tab" | "close-tab" | "back" | "forward" | "reload" | "stop"; readonly tabId: string }
  | { readonly type: "set-muted"; readonly tabId: string; readonly muted: boolean }
  | { readonly type: "navigate"; readonly tabId: string; readonly input: string }
  | { readonly type: "set-bounds"; readonly bounds: BrowserBounds }
  | { readonly type: "set-visible"; readonly visible: boolean; readonly sessionId?: string }
  | { readonly type: "focus" | "clear-profile" | "clear-download-history" | "close-overlay" }
  | { readonly type: "prepare-overlay"; readonly bounds: BrowserBounds }
  | { readonly type: "open-overlay"; readonly token: number }
  | { readonly type: "permission"; readonly requestId: string; readonly allow: boolean; readonly rememberForSession?: boolean }
  | { readonly type: "download"; readonly id: string; readonly action: "pause" | "resume" | "cancel" };

export type RecorderPhase = "idle" | "recording" | "stopping" | "staged";
export interface RecorderCounts { readonly events: number; readonly screenshots: number; readonly clicks: number; readonly drags: number; readonly keyEvents: number; readonly droppedFrames: number; readonly contextErrors: number; readonly bytesWritten: number }
export interface RecorderPrivacy { readonly localOnly: true; readonly neverUploadedAutomatically: true; readonly capturesScreen: true; readonly capturesGlobalInput: true; readonly capturesKeyCodesNotText: true; readonly sensitiveDataPossible: true; readonly warning: string; readonly limitations: readonly string[] }
export interface ActiveRecording { readonly id: string; readonly phase: "recording"; readonly startedAt: string; readonly startedWallTimeMs: number; readonly folderPath: string; readonly panicShortcut: string; readonly panicShortcutAvailable: boolean; readonly counts: RecorderCounts; readonly privacy: RecorderPrivacy }
export interface WorkflowCaptureSummary { readonly apps: readonly string[]; readonly eventCount: number; readonly screenshotCount: number; readonly clickCount: number; readonly dragCount: number; readonly keyEventCount: number; readonly droppedFrames: number; readonly contextErrors: number; readonly bytesWritten: number }
export interface WorkflowDescriptor {
  readonly id: string; readonly name: string | null; readonly status: "staged" | "saved"; readonly path: string; readonly manifestPath: string; readonly eventsPath: string;
  readonly startedAt: string; readonly stoppedAt: string; readonly durationMs: number; readonly stopReason: "user" | "panic-shortcut" | "duration-limit" | "app-shutdown" | "error";
  readonly summary: WorkflowCaptureSummary; readonly privacy: RecorderPrivacy;
}
export interface WorkflowScreenshot {
  readonly frameId: string;
  readonly name: string;
}
export interface WorkflowScreenshotImage extends WorkflowScreenshot {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}
export interface StagedWorkflow extends WorkflowDescriptor { readonly status: "staged"; readonly name: null }
export interface WorkflowAttachment { readonly kind: "tethoq-workflow"; readonly id: string; readonly name: string; readonly path: string; readonly manifestPath: string; readonly eventsPath: string; readonly promptReference: string; readonly summary: WorkflowCaptureSummary; readonly localOnly: true; readonly neverUploadedAutomatically: true; readonly sensitiveDataPossible: true }
export interface RecorderState {
  readonly phase: RecorderPhase; readonly supported: boolean; readonly active?: ActiveRecording; readonly staged?: StagedWorkflow; readonly privacy: RecorderPrivacy;
}
export type RecorderProgressEvent = { readonly type: "state"; readonly state: RecorderState } | { readonly type: "progress"; readonly recording: ActiveRecording } | { readonly type: "warning"; readonly code: string; readonly message: string } | { readonly type: "panic-stop"; readonly stoppedAt: string };
export type RecorderAction =
  | { readonly type: "start" }
  | { readonly type: "stop"; readonly reason?: "user" | "panic-shortcut" | "app-shutdown" }
  | { readonly type: "finalize"; readonly name: string }
  | { readonly type: "discard" | "list" }
  | { readonly type: "delete" | "reveal" | "attachment" | "screenshots"; readonly id: string }
  | { readonly type: "screenshot-data"; readonly id: string; readonly frameId: string; readonly variant: "thumbnail" | "full" };

/**
 * Desktop preferences. Every gated experimental capability must verify
 * `experimentalFeatures` in the main process before it can touch the
 * microphone, screen capture, or the pointer timeline.
 */
export interface DesktopPreferencesState {
  readonly version: 1;
  readonly experimentalFeatures: boolean;
  readonly reasoningDisplay: "compact" | "expanded";
  /** How the task rail is organised. Recency remains the default. */
  readonly taskListMode: TaskListMode;
  /** Explicitly saved project folders, most recently used first. */
  readonly savedProjectDirectories: readonly string[];
  readonly localOpenHandlerId: LocalOpenHandlerId;
  /** What the window close button does. Tray keeps active tasks and alerts alive. */
  readonly closeAction: DesktopCloseAction;
  /** Whether Windows starts Tethoq for the user, and whether it opens a window. */
  readonly launchAtLogin: DesktopLaunchAtLogin;
  /** Which unfocused events are allowed to raise an operating-system notification. */
  readonly alerts: DesktopAlertLevel;
  /** Concrete model/reasoning defaults used when a task has no recorded selection yet. */
  readonly agentDefaults: Readonly<Record<string, AgentModelDefault>>;
  /** Optional user-selected AGENTS.md applied privately to every Tethoq task turn. */
  readonly globalAgentsPath: string | null;
  /** Local, user-owned task organisation keyed by session ID. Provider titles are never overwritten upstream. */
  readonly taskOverrides: Readonly<Record<string, TaskOverride>>;
  /** Backwards-compatible mirror of the experimental-features gate. */
  readonly allowForeignSubagents?: boolean;
  /** Explicit per-session choices recorded by the user; absent keys follow the gate's default. */
  readonly foreignSubagentOverrides?: Readonly<Record<string, boolean>>;
  /** Dictation preprocessing: enabled state, audio-capable model, and verbatim/cleaned mode. */
  readonly ears: EarsSettings;
}
export interface EarsSettings {
  readonly enabled: boolean;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly mode: "verbatim" | "cleaned";
}
export type DesktopCloseAction = "tray" | "quit";
export type DesktopLaunchAtLogin = "off" | "window" | "tray";
export type DesktopAlertLevel = "all" | "attention" | "off";
export type TaskListMode = "recent" | "project";
export interface AgentModelDefault {
  readonly modelId: string;
  readonly reasoningEffort?: string;
}
/** A user's own name, priority, and put-away state for one task. Absent fields mean "unchanged". */
export interface TaskOverride {
  readonly title?: string;
  readonly pinned?: boolean;
  readonly archived?: boolean;
}
export const MAX_TASK_OVERRIDES = 500;
export const MAX_TASK_TITLE_CHARACTERS = 120;
export type PreferencesAction =
  | { readonly type: "set-experimental-features"; readonly enabled: boolean }
  | { readonly type: "set-reasoning-display"; readonly value: "compact" | "expanded" }
  | { readonly type: "set-task-list-mode"; readonly value: TaskListMode }
  | { readonly type: "save-project" | "use-project"; readonly directory: string }
  | { readonly type: "set-close-action"; readonly value: DesktopCloseAction }
  | { readonly type: "set-launch-at-login"; readonly value: DesktopLaunchAtLogin }
  | { readonly type: "set-alerts"; readonly value: DesktopAlertLevel }
  | { readonly type: "choose-global-agents" | "clear-global-agents" }
  | { readonly type: "set-task-override"; readonly sessionId: string; readonly override: TaskOverride }
  | { readonly type: "move-task-override"; readonly fromSessionId: string; readonly toSessionId: string }
  | { readonly type: "set-agent-default"; readonly providerId: string; readonly modelId: string; readonly reasoningEffort?: string }
  | { readonly type: "set-allow-foreign-subagents"; readonly enabled: boolean }
  | { readonly type: "set-session-foreign-subagents"; readonly sessionId: string; readonly allowed: boolean }
  | { readonly type: "set-ears"; readonly ears: EarsSettings };

export type LocalOpenHandlerId = "system" | "vscode" | "cursor" | "windsurf" | "sublime" | "notepadpp" | "zed";
export type LocalOpenHandlerIcon = "explorer" | "vscode" | "cursor" | "windsurf" | "sublime" | "notepadpp" | "zed";
export interface LocalOpenHandler {
  readonly id: LocalOpenHandlerId;
  readonly label: string;
  readonly icon: LocalOpenHandlerIcon;
}
export interface LocalOpenState {
  readonly defaultHandlerId: LocalOpenHandlerId;
  readonly handlers: readonly LocalOpenHandler[];
}
export interface LocalOpenTarget {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly handlerId?: LocalOpenHandlerId;
  readonly rememberAsDefault?: boolean;
}
export interface LocalOpenResult {
  readonly opened: true;
  readonly handlerId: LocalOpenHandlerId;
  readonly state: LocalOpenState;
}

export interface LiveSessionPrivacy {
  readonly localOnly: true;
  readonly neverUploadedAutomatically: true;
  readonly capturesScreen: true;
  readonly capturesPointer: true;
  readonly capturesMicrophone: true;
  readonly sensitiveDataPossible: true;
  readonly warning: string;
  readonly limitations: readonly string[];
}
export interface LiveSessionActive {
  readonly id: string;
  readonly phase: "active";
  readonly startedAt: string;
  readonly startedWallTimeMs: number;
  readonly maxDurationMs: number;
  readonly utteranceCount: number;
  readonly frameCount: number;
  readonly droppedFrames: number;
  readonly captureErrors: number;
  readonly cursorSampleCount: number;
  readonly privacy: LiveSessionPrivacy;
}
export interface LiveSessionState {
  readonly phase: "idle" | "active";
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly active?: LiveSessionActive;
  readonly privacy: LiveSessionPrivacy;
}
export type LiveSessionEndReason = "user" | "app-shutdown" | "settings-disabled" | "duration-limit" | "error";
export type LiveSessionAction =
  | { readonly type: "begin" }
  | { readonly type: "end"; readonly reason?: "user" | "settings-disabled" }
  | { readonly type: "evidence"; readonly utteranceId: string; readonly startedAtWallMs: number; readonly endedAtWallMs: number };
export type LiveSessionEvent =
  | { readonly type: "state"; readonly state: LiveSessionState }
  | { readonly type: "progress"; readonly session: LiveSessionActive }
  | { readonly type: "ended"; readonly reason: LiveSessionEndReason };

export interface LiveCursorSample {
  readonly wallTimeMs: number;
  readonly wallTime: string;
  readonly x: number;
  readonly y: number;
  readonly displayId: string;
  readonly displayBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly displayScaleFactor: number;
  readonly xNormalized: number;
  readonly yNormalized: number;
}
export interface LiveCaptureFrame {
  readonly kind: "full" | "cursor";
  readonly label: string;
  readonly mimeType: "image/jpeg";
  readonly dataBase64: string;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly capturedWallTimeMs: number;
  readonly capturedAt: string;
  readonly displayId: string;
  readonly displayBounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly displayScaleFactor: number;
  readonly cursor: { readonly x: number; readonly y: number; readonly xNormalized: number; readonly yNormalized: number };
}
export interface UtteranceEvidence {
  readonly formatVersion: 1;
  readonly sessionId: string;
  readonly utteranceId: string;
  readonly window: { readonly startedAtWallMs: number; readonly endedAtWallMs: number; readonly startedAt: string; readonly endedAt: string };
  readonly sampledAtWallTimeMs: number;
  readonly sampledAt: string;
  readonly cursor: {
    readonly start: LiveCursorSample | null;
    readonly end: LiveCursorSample | null;
    readonly samples: readonly LiveCursorSample[];
  };
  readonly frames: readonly LiveCaptureFrame[];
  readonly captureError: string | null;
  readonly stale: boolean;
  readonly hover: Record<string, unknown> | null;
  readonly pointerSummary: string;
  readonly privacy: LiveSessionPrivacy;
}

export interface DesktopHarnessApi {
  bootstrap(): Promise<DesktopBootstrap>;
  request(type: string, payload?: JsonObject, requestId?: string): Promise<ResponseEnvelope>;
  selectDirectory(defaultPath?: string): Promise<string | null>;
  selectImages(): Promise<readonly SelectedImage[]>;
  selectFiles(providerId: DesktopProviderId): Promise<readonly SelectedFile[]>;
  captureScreens(): Promise<readonly ScreenCaptureSource[]>;
  revealPath(path: string): Promise<boolean>;
  /**
   * Copy through the desktop's own clipboard rather than the web one. The window
   * runs from file:// under a permission policy that grants nothing but audio, so
   * navigator.clipboard.writeText is refused outright — the copy controls could
   * never have worked. Resolves false when there was nothing to copy.
   */
  copyText(text: string): Promise<boolean>;
  localOpenHandlers(): Promise<LocalOpenState>;
  openLocalTarget(target: LocalOpenTarget): Promise<LocalOpenResult>;
  openDictationSetupPage(sourceId: "openai-stt" | "xai-stt"): Promise<void>;
  openHarnessSetupPage(providerId: BuiltInDesktopProviderId): Promise<void>;
  showWindow(): Promise<void>;
  hideWindow(): Promise<void>;
  /** Tells the shell the first snapshot has landed, so the window can be revealed already populated. */
  notifyReady(): void;
  openCodeStatus(): Promise<OpenCodeProcessStatus>;
  restartOpenCode(): Promise<OpenCodeProcessStatus>;
  connectorAction(action: ConnectorAction): Promise<ConnectorActionResult>;
  browserState(): Promise<BrowserWorkspaceState>;
  browserAction(action: BrowserAction): Promise<BrowserWorkspaceState>;
  recorderState(): Promise<RecorderState>;
  recorderAction(action: RecorderAction): Promise<RecorderState | WorkflowDescriptor | readonly WorkflowDescriptor[] | readonly WorkflowScreenshot[] | WorkflowScreenshotImage | WorkflowAttachment | null>;
  preferencesState(): Promise<DesktopPreferencesState>;
  preferencesAction(action: PreferencesAction): Promise<DesktopPreferencesState>;
  liveSessionState(): Promise<LiveSessionState>;
  liveSessionAction(action: LiveSessionAction): Promise<LiveSessionState | UtteranceEvidence>;
  mobileConnectionState(): Promise<MobileConnectionState>;
  mobileConnectionAction(action: MobileConnectionAction): Promise<MobileConnectionState>;
  /** Present only in packaged-smoke processes started with the explicit env guard. */
  quitForSmoke?: () => Promise<boolean>;
  onEventBatch(listener: (batch: DesktopEventBatch) => void): () => void;
  onRuntimeState(listener: (state: DesktopRuntimeState) => void): () => void;
  onBrowserState(listener: (state: BrowserWorkspaceState) => void): () => void;
  onBrowserNotice(listener: (notice: BrowserNotice) => void): () => void;
  onRecorderState(listener: (state: RecorderState) => void): () => void;
  onRecorderEvent(listener: (event: RecorderProgressEvent) => void): () => void;
  onPreferencesState(listener: (state: DesktopPreferencesState) => void): () => void;
  onLiveSessionState(listener: (state: LiveSessionState) => void): () => void;
  onLiveSessionEvent(listener: (event: LiveSessionEvent) => void): () => void;
  onMobileConnectionState(listener: (state: MobileConnectionState) => void): () => void;
}

export function isBuiltInDesktopProvider(value: unknown): value is BuiltInDesktopProviderId {
  return typeof value === "string" && (DESKTOP_PROVIDERS as readonly string[]).includes(value);
}

export function desktopRequestEnvelope(
  hostId: string,
  type: string,
  payload: JsonObject,
  requestId: string,
): RequestEnvelope {
  return {
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    hostId,
    sentAt: new Date().toISOString(),
    kind: "request",
    type,
    requestId,
    payload,
  };
}
