export const WORKFLOW_FORMAT_VERSION = 1 as const;
export const RECORDER_PANIC_SHORTCUT = "CommandOrControl+Shift+F12" as const;

export type RecorderPhase = "idle" | "recording" | "stopping" | "staged";
export type RecorderStopReason = "user" | "panic-shortcut" | "duration-limit" | "app-shutdown" | "error";

export interface RecorderPrivacy {
  readonly localOnly: true;
  readonly neverUploadedAutomatically: true;
  readonly capturesScreen: true;
  readonly capturesGlobalInput: true;
  readonly capturesKeyCodesNotText: true;
  readonly sensitiveDataPossible: true;
  readonly warning: string;
  readonly limitations: readonly string[];
}

export const RECORDER_PRIVACY: RecorderPrivacy = Object.freeze({
  localOnly: true,
  neverUploadedAutomatically: true,
  capturesScreen: true,
  capturesGlobalInput: true,
  capturesKeyCodesNotText: true,
  sensitiveDataPossible: true,
  warning: "Recording can capture sensitive information visible on screen, key identities, file names, window titles, and browser URLs. Review the local workflow before sharing it.",
  limitations: Object.freeze([
    "Password-field detection is best effort; custom or protected controls may not identify themselves.",
    "Key events store hardware key codes and modifiers, not reconstructed text or clipboard contents.",
    "The recorder cannot always identify the exact file or folder carried by a cross-application drag.",
    "Secure, elevated, DRM-protected, or hardware-accelerated windows may appear blank or expose limited metadata.",
  ]),
});

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rectangle extends Point {
  readonly width: number;
  readonly height: number;
}

export interface RecorderBrowserContext {
  readonly url: string;
  readonly title: string;
  readonly tabId: string;
}

export interface CursorElementContext {
  readonly name?: string;
  readonly automationId?: string;
  readonly controlType?: string;
  readonly isEnabled?: boolean;
  readonly isPassword?: boolean;
  readonly bounds?: Rectangle;
}

export interface ForegroundContext {
  readonly observedAt?: string;
  readonly observedWallTimeMs?: number;
  readonly appName?: string;
  readonly processId?: number;
  readonly processPath?: string;
  readonly windowTitle?: string;
  readonly windowId?: string;
  readonly bounds?: Rectangle;
  readonly focusedIsPassword?: boolean;
  readonly focusedElement?: CursorElementContext;
  readonly cursorElement?: CursorElementContext;
  readonly browser?: RecorderBrowserContext;
  readonly source?: "windows" | "provider" | "merged";
}

export type RecorderContextProvider = () => ForegroundContext | undefined | Promise<ForegroundContext | undefined>;

export interface RecorderCounts {
  readonly events: number;
  readonly screenshots: number;
  readonly clicks: number;
  readonly drags: number;
  readonly keyEvents: number;
  readonly droppedFrames: number;
  readonly contextErrors: number;
  readonly bytesWritten: number;
}

export interface ActiveRecording {
  readonly id: string;
  readonly phase: "recording";
  readonly startedAt: string;
  readonly startedWallTimeMs: number;
  readonly folderPath: string;
  readonly panicShortcut: typeof RECORDER_PANIC_SHORTCUT;
  readonly panicShortcutAvailable: boolean;
  readonly counts: RecorderCounts;
  readonly privacy: RecorderPrivacy;
}

export interface WorkflowCaptureSummary {
  readonly apps: readonly string[];
  readonly eventCount: number;
  readonly screenshotCount: number;
  readonly clickCount: number;
  readonly dragCount: number;
  readonly keyEventCount: number;
  readonly droppedFrames: number;
  readonly contextErrors: number;
  readonly bytesWritten: number;
}

export interface WorkflowDescriptor {
  readonly id: string;
  readonly name: string | null;
  readonly status: "staged" | "saved";
  readonly path: string;
  readonly manifestPath: string;
  readonly eventsPath: string;
  readonly startedAt: string;
  readonly stoppedAt: string;
  readonly durationMs: number;
  readonly stopReason: RecorderStopReason;
  readonly summary: WorkflowCaptureSummary;
  readonly privacy: RecorderPrivacy;
}

export type StagedWorkflow = WorkflowDescriptor & { readonly status: "staged"; readonly name: null };

export interface WorkflowAttachment {
  readonly kind: "tethoq-workflow";
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly manifestPath: string;
  readonly eventsPath: string;
  readonly promptReference: string;
  readonly summary: WorkflowCaptureSummary;
  readonly localOnly: true;
  readonly neverUploadedAutomatically: true;
  readonly sensitiveDataPossible: true;
}

export interface RecorderState {
  readonly phase: RecorderPhase;
  readonly supported: boolean;
  readonly active?: ActiveRecording;
  readonly staged?: StagedWorkflow;
  readonly privacy: RecorderPrivacy;
}

export type RecorderLiveEvent =
  | { readonly type: "state"; readonly state: RecorderState }
  | { readonly type: "progress"; readonly recording: ActiveRecording }
  | { readonly type: "warning"; readonly code: "panic-shortcut-unavailable" | "capture-limit" | "context-unavailable"; readonly message: string }
  | { readonly type: "panic-stop"; readonly stoppedAt: string };

export interface WorkflowManifest {
  readonly formatVersion: typeof WORKFLOW_FORMAT_VERSION;
  readonly id: string;
  readonly name: string | null;
  readonly status: "recording" | "staged" | "saved";
  readonly startedAt: string;
  readonly startedWallTimeMs: number;
  readonly stoppedAt?: string;
  readonly stoppedWallTimeMs?: number;
  readonly durationMs?: number;
  readonly stopReason?: RecorderStopReason;
  readonly platform: string;
  readonly capture: {
    readonly mouseSampleIntervalMs: number;
    readonly dragScreenshotIntervalMs: number;
    readonly keyScreenshotIntervalMs: number;
    readonly keyContextIntervalMs: number;
    readonly cursorCropSize: { readonly width: number; readonly height: number };
    readonly maxFrameDimension: number;
    readonly maxFrames: number;
    readonly maxDurationMs: number;
    readonly maxWorkflowBytes: number;
    readonly maxDragPathPoints: number;
    readonly maxContextQueue: number;
    readonly panicShortcut: typeof RECORDER_PANIC_SHORTCUT;
    readonly panicShortcutAvailable: boolean;
    readonly displays: readonly RecorderDisplay[];
  };
  readonly files: {
    readonly events: "events.ndjson";
    readonly fullScreens: "screens/full";
    readonly cursorCrops: "screens/cursor";
    readonly dragSummaries: "screens/drag-summary";
  };
  readonly summary: WorkflowCaptureSummary;
  readonly privacy: RecorderPrivacy;
}

export interface RecorderDisplay {
  readonly id: string;
  readonly bounds: Rectangle;
  readonly workArea: Rectangle;
  readonly scaleFactor: number;
  readonly rotation: number;
  readonly internal: boolean;
}

export interface RecorderTimestamp {
  readonly wallTimeMs: number;
  readonly wallTime: string;
  readonly monotonicMs: number;
}

export interface ModifierState {
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export interface HookKeyboardEvent extends ModifierState {
  readonly keycode: number;
  /** Stable libuiohook identity such as A, Enter, or ShiftRight; never typed text. */
  readonly key?: string;
  readonly repeat?: boolean;
}

export interface HookMouseEvent extends ModifierState, Point {
  readonly button: number;
  readonly clicks: number;
}

export interface RecorderInputHook {
  start(listeners: RecorderInputListeners): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface RecorderInputListeners {
  readonly keydown: (event: HookKeyboardEvent) => void;
  readonly keyup: (event: HookKeyboardEvent) => void;
  readonly mousedown: (event: HookMouseEvent) => void;
  readonly mouseup: (event: HookMouseEvent) => void;
  readonly mousemove: (event: HookMouseEvent) => void;
  readonly click: (event: HookMouseEvent) => void;
}

export interface CaptureRequest extends Point {
  readonly frameId: string;
  readonly triggerEventId: string;
  readonly timestamp: RecorderTimestamp;
  readonly fullPath: string;
  readonly cursorPath: string;
  readonly maxFrameDimension: number;
  readonly cursorCropSize: { readonly width: number; readonly height: number };
}

export interface CapturedFrame {
  readonly frameId: string;
  readonly triggerEventId: string;
  readonly timestamp: RecorderTimestamp;
  readonly displayId: string;
  readonly displayBounds: Rectangle;
  readonly imageSize: { readonly width: number; readonly height: number };
  readonly fullPath: string;
  readonly cursorPath: string;
  readonly fullRelativePath: string;
  readonly cursorRelativePath: string;
  readonly cursor?: {
    readonly screen: Point;
    readonly image: Point;
    readonly normalized: Point;
    readonly embeddedInImage: boolean;
  };
  readonly bytesWritten: number;
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

export interface DragSummaryRequest {
  readonly dragId: string;
  readonly frames: readonly CapturedFrame[];
  readonly path: readonly Point[];
  readonly outputDirectory: string;
  readonly padding: number;
  readonly minimumSize: { readonly width: number; readonly height: number };
}

export interface DragSummaryResult {
  readonly cropBounds: Rectangle;
  readonly framePaths: readonly string[];
  readonly bytesWritten: number;
}

export interface RecorderCaptureAdapter {
  displays(): readonly RecorderDisplay[];
  capture(request: CaptureRequest): Promise<CapturedFrame>;
  createDragSummary(request: DragSummaryRequest): Promise<DragSummaryResult | undefined>;
}

export interface RecorderShortcutAdapter {
  register(shortcut: string, callback: () => void): boolean;
  unregister(shortcut: string): void;
}

export interface RecorderManagerOptions {
  readonly rootDirectory: string;
  readonly onState?: (state: RecorderState) => void;
  readonly onEvent?: (event: RecorderLiveEvent) => void;
  readonly contextProvider?: RecorderContextProvider;
  readonly inputHook?: RecorderInputHook;
  readonly captureAdapter?: RecorderCaptureAdapter;
  readonly shortcutAdapter?: RecorderShortcutAdapter;
  readonly revealPath?: (path: string) => void | Promise<void>;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly monotonicNow?: () => bigint;
  readonly limits?: Partial<RecorderLimits>;
}

export interface RecorderLimits {
  readonly mouseSampleIntervalMs: number;
  readonly dragScreenshotIntervalMs: number;
  readonly keyScreenshotIntervalMs: number;
  readonly keyContextIntervalMs: number;
  readonly cursorCropWidth: number;
  readonly cursorCropHeight: number;
  readonly maxFrameDimension: number;
  readonly maxFrames: number;
  readonly maxDurationMs: number;
  readonly maxWorkflowBytes: number;
  readonly maxPendingCaptures: number;
  readonly maxDragPathPoints: number;
  readonly maxContextQueue: number;
}

export interface RecorderStartOptions {
  /** Must only be supplied after the user has intentionally pressed Record. */
  readonly privacyConsent: true;
}
