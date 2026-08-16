import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { globalShortcut, nativeImage, shell } from "electron";
import { ElectronCaptureAdapter } from "./capture.js";
import { WindowsInputHook } from "./input_hook.js";
import { directorySize, emptySummary, recoverInterruptedWorkflows, WorkflowStore, type WorkflowWriteSession } from "./store.js";
import {
  RECORDER_PANIC_SHORTCUT,
  RECORDER_PRIVACY,
  WORKFLOW_FORMAT_VERSION,
  type ActiveRecording,
  type CapturedFrame,
  type ForegroundContext,
  type HookKeyboardEvent,
  type HookMouseEvent,
  type Point,
  type RecorderCounts,
  type RecorderLimits,
  type RecorderLiveEvent,
  type RecorderManagerOptions,
  type RecorderState,
  type RecorderStopReason,
  type RecorderTimestamp,
  type StagedWorkflow,
  type WorkflowAttachment,
  type WorkflowDescriptor,
  type WorkflowManifest,
  type WorkflowScreenshot,
  type WorkflowScreenshotImage,
} from "./types.js";
import { createWindowsContextProvider, mergeForegroundContext } from "./windows_context.js";

export const DEFAULT_RECORDER_LIMITS: RecorderLimits = Object.freeze({
  mouseSampleIntervalMs: 24,
  dragScreenshotIntervalMs: 180,
  keyScreenshotIntervalMs: 900,
  keyContextIntervalMs: 750,
  cursorCropWidth: 640,
  cursorCropHeight: 480,
  maxFrameDimension: 1_920,
  maxFrames: 2_000,
  maxDurationMs: 2 * 60 * 60 * 1_000,
  maxWorkflowBytes: 2 * 1_024 * 1_024 * 1_024,
  maxPendingCaptures: 2,
  maxDragPathPoints: 100_000,
  maxContextQueue: 2,
});

const LIVE_PROGRESS_INTERVAL_MS = 100;

export function normalizeRecorderLimits(overrides: Partial<RecorderLimits> = {}): RecorderLimits {
  const requested = { ...DEFAULT_RECORDER_LIMITS, ...overrides };
  return {
    mouseSampleIntervalMs: boundedInteger(requested.mouseSampleIntervalMs, 8, 5_000),
    dragScreenshotIntervalMs: boundedInteger(requested.dragScreenshotIntervalMs, 50, 60_000),
    keyScreenshotIntervalMs: boundedInteger(requested.keyScreenshotIntervalMs, 100, 60_000),
    keyContextIntervalMs: boundedInteger(requested.keyContextIntervalMs, 100, 60_000),
    cursorCropWidth: boundedInteger(requested.cursorCropWidth, 160, 2_560),
    cursorCropHeight: boundedInteger(requested.cursorCropHeight, 120, 2_560),
    maxFrameDimension: boundedInteger(requested.maxFrameDimension, 480, 7_680),
    maxFrames: boundedInteger(requested.maxFrames, 1, 25_000),
    maxDurationMs: boundedInteger(requested.maxDurationMs, 1_000, 24 * 60 * 60 * 1_000),
    maxWorkflowBytes: boundedInteger(requested.maxWorkflowBytes, 1_024 * 1_024, 100 * 1_024 * 1_024 * 1_024),
    maxPendingCaptures: boundedInteger(requested.maxPendingCaptures, 1, 8),
    maxDragPathPoints: boundedInteger(requested.maxDragPathPoints, 100, 1_000_000),
    maxContextQueue: boundedInteger(requested.maxContextQueue, 1, 16),
  };
}

interface MutableCounts {
  events: number;
  screenshots: number;
  clicks: number;
  drags: number;
  keyEvents: number;
  droppedFrames: number;
  contextErrors: number;
  bytesWritten: number;
}

interface ActiveDrag {
  readonly id: string;
  readonly button: number;
  readonly startedAt: RecorderTimestamp;
  readonly start: Point;
  readonly path: Array<Point & RecorderTimestamp>;
  readonly frames: CapturedFrame[];
  lastSampleMs: number;
  lastScreenshotMs: number;
}

interface ActiveSession {
  readonly write: WorkflowWriteSession;
  readonly started: RecorderTimestamp;
  readonly monotonicOriginNs: bigint;
  readonly counts: MutableCounts;
  readonly apps: Set<string>;
  readonly pendingCaptures: Set<Promise<void>>;
  readonly contextQueue: Promise<void>[];
  readonly framesByEvent: Map<string, CapturedFrame>;
  manifest: WorkflowManifest;
  eventSequence: number;
  frameSequence: number;
  lastMouseSampleMs: number;
  lastKeyScreenshotMs: number;
  lastKeyContextMs: number;
  lastProgressMs: number;
  cursor: Point | undefined;
  drag: ActiveDrag | undefined;
  stopping: boolean;
  limitWarningSent: boolean;
  durationTimer: NodeJS.Timeout | undefined;
}

export class RecorderManager {
  readonly #store: WorkflowStore;
  readonly #inputHook;
  readonly #capture;
  readonly #shortcut;
  readonly #revealPath;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #monotonicNow: () => bigint;
  readonly #limits: RecorderLimits;
  readonly #providedContext;
  readonly #nativeContext;
  readonly #onState;
  readonly #onEvent;
  readonly #stateListeners = new Set<(state: RecorderState) => void>();
  readonly #eventListeners = new Set<(event: RecorderLiveEvent) => void>();
  #session: ActiveSession | undefined;
  #staged: StagedWorkflow | undefined;
  #initialized: Promise<void> | undefined;
  #operation: Promise<unknown> | undefined;

  public constructor(options: RecorderManagerOptions) {
    this.#store = new WorkflowStore(options.rootDirectory);
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonicNow ?? process.hrtime.bigint;
    this.#limits = normalizeRecorderLimits(options.limits);
    this.#inputHook = options.inputHook ?? new WindowsInputHook();
    this.#capture = options.captureAdapter ?? new ElectronCaptureAdapter();
    this.#shortcut = options.shortcutAdapter ?? {
      register: (shortcut: string, callback: () => void) => globalShortcut.register(shortcut, callback),
      unregister: (shortcut: string) => globalShortcut.unregister(shortcut),
    };
    this.#revealPath = options.revealPath ?? ((path: string) => shell.showItemInFolder(path));
    this.#providedContext = options.contextProvider;
    this.#nativeContext = createWindowsContextProvider(() => this.#session?.cursor, { platform: this.#platform });
    this.#onState = options.onState;
    this.#onEvent = options.onEvent;
  }

  public state(): RecorderState {
    const session = this.#session;
    if (session !== undefined) {
      return {
        phase: session.stopping ? "stopping" : "recording",
        supported: this.#platform === "win32",
        active: this.activeDescriptor(session),
        privacy: RECORDER_PRIVACY,
      };
    }
    if (this.#staged !== undefined) return { phase: "staged", supported: this.#platform === "win32", staged: this.#staged, privacy: RECORDER_PRIVACY };
    return { phase: "idle", supported: this.#platform === "win32", privacy: RECORDER_PRIVACY };
  }

  public onState(listener: (state: RecorderState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  public onEvent(listener: (event: RecorderLiveEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  public async start(_options: { readonly privacyConsent: true } = { privacyConsent: true }): Promise<ActiveRecording> {
    return await this.exclusive(async () => {
      await this.initialize();
      if (this.#platform !== "win32") throw new Error("Workflow recording is currently supported on Windows only");
      if (this.#session !== undefined) throw new Error("A workflow recording is already active");
      if (this.#staged !== undefined) throw new Error("Save or discard the staged workflow before recording another one");

      const startedWallTimeMs = this.#now();
      const monotonicOriginNs = this.#monotonicNow();
      const started: RecorderTimestamp = { wallTimeMs: startedWallTimeMs, wallTime: new Date(startedWallTimeMs).toISOString(), monotonicMs: 0 };
      const id = randomUUID();
      let panicShortcutAvailable = false;
      try {
        panicShortcutAvailable = this.#shortcut.register(RECORDER_PANIC_SHORTCUT, () => { void this.panicStop(); });
      } catch {
        panicShortcutAvailable = false;
      }
      const manifest: WorkflowManifest = {
        formatVersion: WORKFLOW_FORMAT_VERSION,
        id,
        name: null,
        status: "recording",
        startedAt: started.wallTime,
        startedWallTimeMs,
        platform: this.#platform,
        capture: {
          mouseSampleIntervalMs: this.#limits.mouseSampleIntervalMs,
          dragScreenshotIntervalMs: this.#limits.dragScreenshotIntervalMs,
          keyScreenshotIntervalMs: this.#limits.keyScreenshotIntervalMs,
          keyContextIntervalMs: this.#limits.keyContextIntervalMs,
          cursorCropSize: { width: this.#limits.cursorCropWidth, height: this.#limits.cursorCropHeight },
          maxFrameDimension: this.#limits.maxFrameDimension,
          maxFrames: this.#limits.maxFrames,
          maxDurationMs: this.#limits.maxDurationMs,
          maxWorkflowBytes: this.#limits.maxWorkflowBytes,
          maxDragPathPoints: this.#limits.maxDragPathPoints,
          maxContextQueue: this.#limits.maxContextQueue,
          panicShortcut: RECORDER_PANIC_SHORTCUT,
          panicShortcutAvailable,
          displays: this.#capture.displays(),
        },
        files: { events: "events.ndjson", fullScreens: "screens/full", cursorCrops: "screens/cursor", dragSummaries: "screens/drag-summary" },
        summary: emptySummary(),
        privacy: RECORDER_PRIVACY,
      };
      let write: WorkflowWriteSession | undefined;
      try {
        write = await this.#store.create(manifest);
        const session: ActiveSession = {
          write,
          started,
          monotonicOriginNs,
          counts: mutableCounts(),
          apps: new Set(),
          pendingCaptures: new Set(),
          contextQueue: [],
          framesByEvent: new Map(),
          manifest,
          eventSequence: 0,
          frameSequence: 0,
          lastMouseSampleMs: -Infinity,
          lastKeyScreenshotMs: -Infinity,
          lastKeyContextMs: -Infinity,
          lastProgressMs: -Infinity,
          cursor: undefined,
          drag: undefined,
          stopping: false,
          limitWarningSent: false,
          durationTimer: undefined,
        };
        this.#session = session;
        await this.#inputHook.start({
          keydown: (event) => this.handleKey("key-down", event),
          keyup: (event) => this.handleKey("key-up", event),
          mousedown: (event) => this.handleMouseDown(event),
          mouseup: (event) => this.handleMouseUp(event),
          mousemove: (event) => this.handleMouseMove(event),
          click: (event) => this.handleClick(event),
        });
        session.durationTimer = setTimeout(() => { void this.stop("duration-limit"); }, this.#limits.maxDurationMs);
        session.durationTimer.unref();
        this.append(session, "recording-started", { privacyConsent: true, panicShortcutAvailable });
        this.emitState();
        if (!panicShortcutAvailable) this.emitEvent({ type: "warning", code: "panic-shortcut-unavailable", message: `${RECORDER_PANIC_SHORTCUT} could not be registered. Use the on-screen Stop control.` });
        return this.activeDescriptor(session);
      } catch (error) {
        this.#session = undefined;
        this.#shortcut.unregister(RECORDER_PANIC_SHORTCUT);
        await Promise.allSettled([this.#inputHook.stop(), this.#store.abort(write)]);
        throw error;
      }
    });
  }

  public async stop(reason: RecorderStopReason = "user"): Promise<StagedWorkflow> {
    return await this.exclusive(async () => {
      const session = this.#session;
      if (session === undefined) {
        if (this.#staged !== undefined) return this.#staged;
        throw new Error("No workflow recording is active");
      }
      session.stopping = true;
      clearTimeout(session.durationTimer);
      session.durationTimer = undefined;
      this.emitState();
      this.#shortcut.unregister(RECORDER_PANIC_SHORTCUT);
      await Promise.allSettled([this.#inputHook.stop()]);

      if (session.drag !== undefined) await this.finishDrag(session, session.drag, session.cursor ?? session.drag.path.at(-1) ?? session.drag.start, this.timestamp(session), true);
      await drainAsyncWork(session);
      const stopped = this.timestamp(session);
      this.append(session, "recording-stopped", { reason });
      const bytesWritten = await directorySize(session.write.directory).catch(() => session.counts.bytesWritten);
      session.counts.bytesWritten = bytesWritten;
      // Capture tasks can finish slightly above the soft byte budget. Prune
      // newest visual pairs deterministically before staging so one workflow
      // can never grow without bound on a busy desktop.
      if (bytesWritten > this.#limits.maxWorkflowBytes) {
        session.counts.bytesWritten = await this.#store.enforceSizeLimit(session.write, this.#limits.maxWorkflowBytes)
          .catch(() => bytesWritten);
        this.warnLimit(session);
      }
      const manifest: WorkflowManifest = {
        ...session.manifest,
        status: "staged",
        stoppedAt: stopped.wallTime,
        stoppedWallTimeMs: stopped.wallTimeMs,
        durationMs: stopped.monotonicMs,
        stopReason: reason,
        summary: this.summary(session),
      };
      try {
        const staged = await this.#store.stop(session.write, manifest);
        this.#session = undefined;
        this.#staged = staged;
        this.emitState();
        return staged;
      } catch (error) {
        this.#session = undefined;
        this.emitState();
        throw error;
      }
    });
  }

  public async finalize(name: string): Promise<WorkflowDescriptor> {
    return await this.exclusive(async () => {
      const staged = this.#staged;
      if (staged === undefined) throw new Error("No staged workflow is waiting to be saved");
      const saved = await this.#store.finalize(staged, name);
      this.#staged = undefined;
      this.emitState();
      return saved;
    });
  }

  public async discard(): Promise<void> {
    await this.exclusive(async () => {
      if (this.#session !== undefined) throw new Error("Stop the workflow recording before discarding it");
      await this.#store.discard(this.#staged);
      this.#staged = undefined;
      this.emitState();
    });
  }

  public async list(): Promise<WorkflowDescriptor[]> {
    await this.initialize();
    return await this.#store.list();
  }

  public async screenshots(id: string): Promise<WorkflowScreenshot[]> {
    await this.initialize();
    return await this.#store.screenshots(id);
  }

  public async screenshot(id: string, frameId: string, variant: "thumbnail" | "full"): Promise<WorkflowScreenshotImage> {
    await this.initialize();
    const stored = await this.#store.screenshotBytes(id, frameId);
    const source = nativeImage.createFromBuffer(stored.bytes);
    const image = variant === "thumbnail" && !source.isEmpty() && source.getSize().width > 260
      ? source.resize({ width: 260, quality: "good" })
      : source;
    const imageSize = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
    const bytes = variant === "thumbnail" && !image.isEmpty() ? image.toJPEG(78) : stored.bytes;
    return {
      frameId,
      name: stored.name,
      dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      ...imageSize,
    };
  }

  public async delete(id: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.#staged?.id === id) {
        await this.#store.discard(this.#staged);
        this.#staged = undefined;
      } else {
        await this.#store.delete(id);
      }
      this.emitState();
    });
  }

  public async reveal(id: string): Promise<void> {
    const workflow = await this.#store.get(id);
    if (workflow === undefined) throw new Error("Workflow not found");
    await this.#revealPath(workflow.manifestPath);
  }

  public async attachment(id: string): Promise<WorkflowAttachment> {
    const workflow = await this.#store.get(id);
    if (workflow === undefined || workflow.status !== "saved" || workflow.name === null) throw new Error("Saved workflow not found");
    return {
      kind: "tethoq-workflow",
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      manifestPath: workflow.manifestPath,
      eventsPath: workflow.eventsPath,
      promptReference: `Review the local Tethoq workflow “${workflow.name}” at ${workflow.manifestPath}. Its chronological input/context records are at ${workflow.eventsPath}; screenshot paths referenced there are local files. New screenshots include a visible pointer, and their screenshot events retain the exact screen and image coordinates.`,
      summary: workflow.summary,
      localOnly: true,
      neverUploadedAutomatically: true,
      sensitiveDataPossible: true,
    };
  }

  public async dispose(): Promise<void> {
    if (this.#session !== undefined) {
      await this.stop("app-shutdown").catch(async () => {
        const session = this.#session;
        this.#session = undefined;
        await Promise.allSettled([this.#inputHook.stop(), this.#store.abort(session?.write)]);
      });
    }
    this.#shortcut.unregister(RECORDER_PANIC_SHORTCUT);
    this.#stateListeners.clear();
    this.#eventListeners.clear();
  }

  private async initialize(): Promise<void> {
    await (this.#initialized ??= (async () => {
      await recoverInterruptedWorkflows(this.#store.rootDirectory, RECORDER_PRIVACY, this.#now());
      this.#staged = (await this.#store.list()).find((workflow): workflow is StagedWorkflow => workflow.status === "staged");
    })());
  }

  private handleKey(type: "key-down" | "key-up", event: HookKeyboardEvent): void {
    const session = this.recordingSession();
    if (session === undefined) return;
    const timestamp = this.timestamp(session);
    session.counts.keyEvents += 1;
    const needsContext = type === "key-down" && timestamp.monotonicMs - session.lastKeyContextMs >= this.#limits.keyContextIntervalMs;
    const eventId = this.append(session, type, { keycode: event.keycode, modifiers: modifierPayload(event), textCaptured: false, contextPending: needsContext }, timestamp);
    if (needsContext) {
      session.lastKeyContextMs = timestamp.monotonicMs;
      this.enqueueContext(session, eventId, timestamp);
    }
    if (type === "key-down" && timestamp.monotonicMs - session.lastKeyScreenshotMs >= this.#limits.keyScreenshotIntervalMs && session.cursor !== undefined) {
      session.lastKeyScreenshotMs = timestamp.monotonicMs;
      this.enqueueCapture(session, eventId, session.cursor, timestamp);
    }
    this.progress(session);
  }

  private handleMouseDown(event: HookMouseEvent): void {
    const session = this.recordingSession();
    if (session === undefined) return;
    session.cursor = event;
    const timestamp = this.timestamp(session);
    const eventId = this.append(session, "mouse-down", { point: point(event), button: event.button, clicks: event.clicks, modifiers: modifierPayload(event), contextPending: true }, timestamp);
    session.drag = {
      id: `drag-${eventId}`,
      button: event.button,
      startedAt: timestamp,
      start: point(event),
      path: [{ ...point(event), ...timestamp }],
      frames: [],
      lastSampleMs: timestamp.monotonicMs,
      lastScreenshotMs: timestamp.monotonicMs,
    };
    this.enqueueContext(session, eventId, timestamp);
    this.enqueueCapture(session, eventId, event, timestamp, session.drag);
    this.progress(session);
  }

  private handleMouseMove(event: HookMouseEvent): void {
    const session = this.recordingSession();
    if (session === undefined) return;
    session.cursor = event;
    const timestamp = this.timestamp(session);
    const drag = session.drag;
    if (drag !== undefined) {
      if (timestamp.monotonicMs - drag.lastSampleMs >= this.#limits.mouseSampleIntervalMs && drag.path.length < this.#limits.maxDragPathPoints) {
        drag.lastSampleMs = timestamp.monotonicMs;
        drag.path.push({ ...point(event), ...timestamp });
      }
      if (timestamp.monotonicMs - drag.lastScreenshotMs >= this.#limits.dragScreenshotIntervalMs) {
        drag.lastScreenshotMs = timestamp.monotonicMs;
        const eventId = this.append(session, "drag-sample", { dragId: drag.id, point: point(event), sample: drag.path.length - 1 }, timestamp);
        this.enqueueCapture(session, eventId, event, timestamp, drag);
      }
      return;
    }
    if (timestamp.monotonicMs - session.lastMouseSampleMs >= this.#limits.mouseSampleIntervalMs) {
      session.lastMouseSampleMs = timestamp.monotonicMs;
      this.append(session, "mouse-move", { point: point(event) }, timestamp);
    }
  }

  private handleMouseUp(event: HookMouseEvent): void {
    const session = this.recordingSession();
    if (session === undefined) return;
    session.cursor = event;
    const timestamp = this.timestamp(session);
    const eventId = this.append(session, "mouse-up", { point: point(event), button: event.button, modifiers: modifierPayload(event), contextPending: true }, timestamp);
    this.enqueueContext(session, eventId, timestamp);
    this.enqueueCapture(session, eventId, event, timestamp, session.drag);
    const drag = session.drag;
    if (drag !== undefined) {
      const task = this.finishDrag(session, drag, event, timestamp, false).finally(() => session.pendingCaptures.delete(task));
      session.pendingCaptures.add(task);
    }
    this.progress(session);
  }

  private handleClick(event: HookMouseEvent): void {
    const session = this.recordingSession();
    if (session === undefined) return;
    session.cursor = event;
    session.counts.clicks += 1;
    const timestamp = this.timestamp(session);
    const eventId = this.append(session, "click", { point: point(event), button: event.button, clicks: event.clicks, modifiers: modifierPayload(event), contextPending: true }, timestamp);
    this.enqueueContext(session, eventId, timestamp);
    if (!session.framesByEvent.has(eventId)) this.enqueueCapture(session, eventId, event, timestamp);
    this.progress(session);
  }

  private async finishDrag(session: ActiveSession, drag: ActiveDrag, end: Point, timestamp: RecorderTimestamp, interrupted: boolean): Promise<void> {
    if (session.drag === drag) session.drag = undefined;
    const finalPoint = { ...point(end), ...timestamp };
    const previous = drag.path.at(-1);
    if (previous?.x !== finalPoint.x || previous.y !== finalPoint.y) drag.path.push(finalPoint);
    const distance = pathDistance(drag.path);
    const durationMs = timestamp.monotonicMs - drag.startedAt.monotonicMs;
    if (distance < 4 && durationMs < 350) return;
    session.counts.drags += 1;
    await Promise.allSettled([...session.pendingCaptures]);
    const summary = await this.#capture.createDragSummary({
      dragId: drag.id,
      frames: drag.frames,
      path: drag.path,
      outputDirectory: session.write.dragSummariesDirectory,
      padding: 120,
      minimumSize: { width: 720, height: 540 },
    }).catch(() => undefined);
    if (summary !== undefined) session.counts.bytesWritten += summary.bytesWritten;
    const eventId = this.append(session, "drag-complete", {
      dragId: drag.id,
      button: drag.button,
      start: drag.start,
      end: point(end),
      durationMs,
      distancePx: Math.round(distance),
      path: drag.path,
      interrupted,
      frames: drag.frames.map((frame) => ({ frameId: frame.frameId, fullPath: frame.fullRelativePath, cursorPath: frame.cursorRelativePath, timestamp: frame.timestamp })),
      dragSummary: summary === undefined ? undefined : { ...summary, framePaths: summary.framePaths.map((path) => `screens/drag-summary/${path.split(/[\\/]/u).at(-1) ?? path}`) },
      semantic: {
        action: "drag-and-drop",
        exactPayload: null,
        note: "Source/target UI Automation and foreground context events provide best-effort semantics; Windows does not expose every drag payload globally.",
      },
      contextPending: true,
    }, timestamp);
    this.enqueueContext(session, eventId, timestamp);
  }

  private enqueueCapture(session: ActiveSession, triggerEventId: string, location: Point, timestamp: RecorderTimestamp, drag?: ActiveDrag): void {
    if (!this.canCapture(session)) return;
    if (session.pendingCaptures.size >= this.#limits.maxPendingCaptures) {
      session.counts.droppedFrames += 1;
      this.warnLimit(session);
      return;
    }
    const frameId = `frame-${String(++session.frameSequence).padStart(6, "0")}`;
    const task = this.#capture.capture({
      frameId,
      triggerEventId,
      timestamp,
      x: location.x,
      y: location.y,
      fullPath: join(session.write.fullScreensDirectory, `${frameId}.jpg`),
      cursorPath: join(session.write.cursorCropsDirectory, `${frameId}.jpg`),
      maxFrameDimension: this.#limits.maxFrameDimension,
      cursorCropSize: { width: this.#limits.cursorCropWidth, height: this.#limits.cursorCropHeight },
    }).then((frame) => {
      if (session.stopping && this.#session !== session) return;
      session.counts.screenshots += 1;
      session.counts.bytesWritten += frame.bytesWritten;
      session.framesByEvent.set(triggerEventId, frame);
      drag?.frames.push(frame);
      this.append(session, "screenshot", {
        frameId,
        triggerEventId,
        displayId: frame.displayId,
        displayBounds: frame.displayBounds,
        imageSize: frame.imageSize,
        fullPath: frame.fullRelativePath,
        cursorPath: frame.cursorRelativePath,
        ...(frame.cursor ? { cursor: frame.cursor } : {}),
      }, timestamp);
    }).catch((error: unknown) => {
      session.counts.droppedFrames += 1;
      this.append(session, "screenshot-error", { triggerEventId, message: errorMessage(error) }, timestamp);
    }).finally(() => session.pendingCaptures.delete(task));
    session.pendingCaptures.add(task);
  }

  private enqueueContext(session: ActiveSession, triggerEventId: string, timestamp: RecorderTimestamp): void {
    if (session.contextQueue.length >= this.#limits.maxContextQueue) {
      session.counts.contextErrors += 1;
      return;
    }
    const previous = session.contextQueue.at(-1) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (this.#session !== session && !session.stopping) return;
      const [nativeResult, providedResult] = await Promise.allSettled([
        this.#nativeContext(),
        this.#providedContext?.(),
      ]);
      if (nativeResult.status === "rejected" || providedResult.status === "rejected") session.counts.contextErrors += 1;
      const context = mergeForegroundContext(
        nativeResult.status === "fulfilled" ? nativeResult.value : undefined,
        providedResult.status === "fulfilled" ? providedResult.value : undefined,
        timestamp,
      );
      if (context?.appName !== undefined) session.apps.add(context.appName);
      this.append(session, "context", {
        triggerEventId,
        context: redactPasswordContext(context),
        errors: [nativeResult, providedResult].filter((result) => result.status === "rejected").map((result) => errorMessage((result as PromiseRejectedResult).reason)),
      }, this.timestamp(session));
    }).catch(() => { session.counts.contextErrors += 1; });
    session.contextQueue.push(task);
    void task.finally(() => {
      const index = session.contextQueue.indexOf(task);
      if (index >= 0) session.contextQueue.splice(index, 1);
    });
  }

  private append(session: ActiveSession, type: string, payload: Record<string, unknown>, timestamp = this.timestamp(session)): string {
    const eventId = `event-${String(++session.eventSequence).padStart(8, "0")}`;
    session.counts.events += 1;
    if (!this.#store.append({ formatVersion: WORKFLOW_FORMAT_VERSION, eventId, sequence: session.eventSequence, type, ...timestamp, ...payload })) {
      session.counts.droppedFrames += 1;
    }
    return eventId;
  }

  private timestamp(session: ActiveSession): RecorderTimestamp {
    const wallTimeMs = this.#now();
    return {
      wallTimeMs,
      wallTime: new Date(wallTimeMs).toISOString(),
      monotonicMs: Number(this.#monotonicNow() - session.monotonicOriginNs) / 1_000_000,
    };
  }

  private activeDescriptor(session: ActiveSession): ActiveRecording {
    return {
      id: session.write.id,
      phase: "recording",
      startedAt: session.started.wallTime,
      startedWallTimeMs: session.started.wallTimeMs,
      folderPath: session.write.directory,
      panicShortcut: RECORDER_PANIC_SHORTCUT,
      panicShortcutAvailable: session.manifest.capture.panicShortcutAvailable,
      counts: freezeCounts(session.counts),
      privacy: RECORDER_PRIVACY,
    };
  }

  private summary(session: ActiveSession) {
    return {
      apps: [...session.apps].sort(),
      eventCount: session.counts.events,
      screenshotCount: session.counts.screenshots,
      clickCount: session.counts.clicks,
      dragCount: session.counts.drags,
      keyEventCount: session.counts.keyEvents,
      droppedFrames: session.counts.droppedFrames,
      contextErrors: session.counts.contextErrors,
      bytesWritten: session.counts.bytesWritten,
    };
  }

  private canCapture(session: ActiveSession): boolean {
    return session.counts.screenshots < this.#limits.maxFrames && session.counts.bytesWritten < this.#limits.maxWorkflowBytes;
  }

  private warnLimit(session: ActiveSession): void {
    if (session.limitWarningSent) return;
    session.limitWarningSent = true;
    this.emitEvent({ type: "warning", code: "capture-limit", message: "Some screenshots were skipped to keep recording overhead and storage bounded." });
  }

  private recordingSession(): ActiveSession | undefined {
    const session = this.#session;
    return session === undefined || session.stopping ? undefined : session;
  }

  private progress(session: ActiveSession): void {
    const elapsed = this.timestamp(session).monotonicMs;
    if (elapsed - session.lastProgressMs < LIVE_PROGRESS_INTERVAL_MS) return;
    session.lastProgressMs = elapsed;
    this.emitEvent({ type: "progress", recording: this.activeDescriptor(session) });
  }

  private emitState(): void {
    const state = this.state();
    this.#onState?.(state);
    for (const listener of this.#stateListeners) listener(state);
    this.emitEvent({ type: "state", state });
  }

  private emitEvent(event: RecorderLiveEvent): void {
    this.#onEvent?.(event);
    for (const listener of this.#eventListeners) listener(event);
  }

  private async panicStop(): Promise<void> {
    if (this.#session === undefined) return;
    this.emitEvent({ type: "panic-stop", stoppedAt: new Date(this.#now()).toISOString() });
    await this.stop("panic-shortcut").catch(() => undefined);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#operation !== undefined) await this.#operation.catch(() => undefined);
    const running = operation();
    this.#operation = running;
    try {
      return await running;
    } finally {
      if (this.#operation === running) this.#operation = undefined;
    }
  }
}

function mutableCounts(): MutableCounts {
  return { events: 0, screenshots: 0, clicks: 0, drags: 0, keyEvents: 0, droppedFrames: 0, contextErrors: 0, bytesWritten: 0 };
}

function freezeCounts(counts: MutableCounts): RecorderCounts {
  return { ...counts };
}

function point(value: Point): Point {
  return { x: value.x, y: value.y };
}

function modifierPayload(value: { readonly alt: boolean; readonly ctrl: boolean; readonly meta: boolean; readonly shift: boolean }) {
  return { alt: value.alt, ctrl: value.ctrl, meta: value.meta, shift: value.shift };
}

function pathDistance(path: readonly Point[]): number {
  let distance = 0;
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    if (previous !== undefined && current !== undefined) distance += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return distance;
}

function redactPasswordContext(context: ForegroundContext | undefined): ForegroundContext | undefined {
  if (context === undefined) return undefined;
  if (context.focusedIsPassword !== true && context.focusedElement?.isPassword !== true && context.cursorElement?.isPassword !== true) return context;
  return {
    ...context,
    ...(context.focusedElement === undefined ? {} : { focusedElement: { ...context.focusedElement, name: "[redacted password field]" } }),
    ...(context.cursorElement === undefined ? {} : { cursorElement: { ...context.cursorElement, name: "[redacted password field]" } }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

async function drainAsyncWork(session: ActiveSession): Promise<void> {
  while (session.pendingCaptures.size > 0 || session.contextQueue.length > 0) {
    await Promise.allSettled([...session.pendingCaptures, ...session.contextQueue]);
  }
}
