import { randomUUID } from "node:crypto";
import { screen } from "electron";
import { createWindowsContextProvider, mergeForegroundContext } from "../recorder/windows_context.js";
import type { ForegroundContext, Point, RecorderContextProvider } from "../recorder/types.js";
import { ElectronLiveCaptureAdapter } from "./capture.js";
import { normalizedPoint, pointerSummary } from "./evidence.js";
import {
  DEFAULT_LIVE_SESSION_LIMITS,
  LIVE_SESSION_FORMAT_VERSION,
  LIVE_SESSION_PRIVACY,
  type LiveCaptureFrame,
  type LiveCursorSample,
  type LiveSessionActive,
  type LiveSessionCaptureAdapter,
  type LiveSessionEndReason,
  type LiveSessionLimits,
  type LiveSessionLiveEvent,
  type LiveSessionManagerOptions,
  type LiveSessionState,
  type UtteranceEvidence,
} from "./types.js";

interface ActiveSession {
  readonly id: string;
  readonly startedAt: string;
  readonly startedWallTimeMs: number;
  readonly samples: LiveCursorSample[];
  readonly pendingCaptures: Set<Promise<void>>;
  utteranceCount: number;
  frameCount: number;
  droppedFrames: number;
  captureErrors: number;
  durationTimer: NodeJS.Timeout | undefined;
  stopping: boolean;
}

export function normalizeLiveSessionLimits(overrides: Partial<LiveSessionLimits> = {}): LiveSessionLimits {
  const requested = { ...DEFAULT_LIVE_SESSION_LIMITS, ...overrides };
  return {
    cursorSampleIntervalMs: boundedInteger(requested.cursorSampleIntervalMs, 8, 5_000),
    cursorRingCapacity: boundedInteger(requested.cursorRingCapacity, 60, 60_000),
    maxSamplesPerEvidence: boundedInteger(requested.maxSamplesPerEvidence, 1, 2_000),
    maxUtteranceWindowMs: boundedInteger(requested.maxUtteranceWindowMs, 1_000, 10 * 60_000),
    futureClockSkewMs: boundedInteger(requested.futureClockSkewMs, 0, 60_000),
    maxFrameDimension: boundedInteger(requested.maxFrameDimension, 320, 4_096),
    cursorCropWidth: boundedInteger(requested.cursorCropWidth, 160, 2_560),
    cursorCropHeight: boundedInteger(requested.cursorCropHeight, 120, 2_560),
    jpegQuality: boundedInteger(requested.jpegQuality, 40, 95),
    maxFramesPerSession: boundedInteger(requested.maxFramesPerSession, 1, 2_000),
    maxInlineFrameBytes: boundedInteger(requested.maxInlineFrameBytes, 64 * 1_024, 2 * 1_024 * 1_024),
    maxSessionDurationMs: boundedInteger(requested.maxSessionDurationMs, 1_000, 24 * 60 * 60 * 1_000),
    maxPendingCaptures: boundedInteger(requested.maxPendingCaptures, 1, 8),
    captureStaleMs: boundedInteger(requested.captureStaleMs, 100, 60_000),
  };
}

export class LiveSessionManager {
  readonly #isEnabled: () => boolean;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #cursorReader: () => Point | undefined;
  readonly #capture: LiveSessionCaptureAdapter;
  readonly #providedContext: RecorderContextProvider | undefined;
  readonly #nativeContext: RecorderContextProvider;
  readonly #limits: LiveSessionLimits;
  readonly #onState;
  readonly #onEvent;
  readonly #stateListeners = new Set<(state: LiveSessionState) => void>();
  readonly #eventListeners = new Set<(event: LiveSessionLiveEvent) => void>();
  #session: ActiveSession | undefined;
  #sampleTimer: NodeJS.Timeout | undefined;
  #operation: Promise<unknown> | undefined;

  public constructor(options: LiveSessionManagerOptions) {
    this.#isEnabled = options.isEnabled;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? Date.now;
    this.#limits = normalizeLiveSessionLimits(options.limits);
    this.#cursorReader = options.cursorReader ?? (() => screen.getCursorScreenPoint());
    this.#capture = options.captureAdapter ?? new ElectronLiveCaptureAdapter();
    this.#providedContext = options.contextProvider;
    this.#nativeContext = options.nativeContextProvider ?? createWindowsContextProvider(() => this.lastSamplePoint(), { platform: this.#platform });
    this.#onState = options.onState;
    this.#onEvent = options.onEvent;
  }

  public state(): LiveSessionState {
    const session = this.#session;
    const active = session !== undefined && !session.stopping;
    return {
      phase: active ? "active" : "idle",
      supported: this.#platform === "win32",
      enabled: this.#isEnabled(),
      ...(active ? { active: this.activeDescriptor(session) } : {}),
      privacy: LIVE_SESSION_PRIVACY,
    };
  }

  public onState(listener: (state: LiveSessionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  public onEvent(listener: (event: LiveSessionLiveEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  public async begin(): Promise<LiveSessionActive> {
    return await this.exclusive(async () => {
      if (!this.#isEnabled()) throw new Error("Instant sessions require experimental features. Enable them in Tethoq Settings first.");
      if (this.#platform !== "win32") throw new Error("Instant sessions are currently supported on Windows only.");
      if (this.#session !== undefined) throw new Error("An instant session is already active.");
      const startedWallTimeMs = this.#now();
      const session: ActiveSession = {
        id: randomUUID(),
        startedAt: new Date(startedWallTimeMs).toISOString(),
        startedWallTimeMs,
        samples: [],
        pendingCaptures: new Set(),
        utteranceCount: 0,
        frameCount: 0,
        droppedFrames: 0,
        captureErrors: 0,
        durationTimer: undefined,
        stopping: false,
      };
      this.#session = session;
      this.#sampleTimer = setInterval(() => this.sampleCursor(), this.#limits.cursorSampleIntervalMs);
      this.#sampleTimer.unref();
      session.durationTimer = setTimeout(() => { void this.end("duration-limit"); }, this.#limits.maxSessionDurationMs);
      session.durationTimer.unref();
      this.sampleCursor();
      this.emitState();
      return this.activeDescriptor(session);
    });
  }

  public async end(reason: LiveSessionEndReason = "user"): Promise<void> {
    await this.exclusive(async () => {
      const session = this.#session;
      if (session === undefined) return;
      session.stopping = true;
      if (this.#sampleTimer !== undefined) clearInterval(this.#sampleTimer);
      this.#sampleTimer = undefined;
      if (session.durationTimer !== undefined) clearTimeout(session.durationTimer);
      session.durationTimer = undefined;
      await Promise.allSettled([...session.pendingCaptures]);
      this.#session = undefined;
      this.emitState();
      this.emitEvent({ type: "ended", reason });
    });
  }

  public async evidence(input: { readonly utteranceId: string; readonly startedAtWallMs: number; readonly endedAtWallMs: number }): Promise<UtteranceEvidence> {
    return await this.exclusive(async () => {
      const session = this.#session;
      if (session === undefined || session.stopping) throw new Error("No instant session is active.");
      if (input.utteranceId.length === 0 || input.utteranceId.length > 160) throw new Error("The utterance ID is invalid.");
      const now = this.#now();
      const startedAtWallMs = input.startedAtWallMs;
      const endedAtWallMs = input.endedAtWallMs;
      if (!Number.isFinite(startedAtWallMs) || !Number.isFinite(endedAtWallMs) || startedAtWallMs >= endedAtWallMs) throw new Error("The utterance window is invalid.");
      if (endedAtWallMs - startedAtWallMs > this.#limits.maxUtteranceWindowMs) throw new Error("The utterance window is too long.");
      if (endedAtWallMs > now + this.#limits.futureClockSkewMs) throw new Error("The utterance window is in the future.");

      const start = lastSampleAtOrBefore(session.samples, startedAtWallMs) ?? session.samples[0] ?? null;
      const end = lastSampleAtOrBefore(session.samples, endedAtWallMs) ?? start;
      const windowSamples = session.samples.filter((sample) => sample.wallTimeMs >= startedAtWallMs && sample.wallTimeMs <= endedAtWallMs);
      const step = Math.max(1, Math.ceil(windowSamples.length / this.#limits.maxSamplesPerEvidence));
      const boundedSamples = windowSamples.filter((_sample, index) => index % step === 0);

      const capturePoint = end ?? start;
      let frames: LiveCaptureFrame[] = [];
      let captureError: string | null = null;
      let stale = false;
      if (capturePoint === null) {
        captureError = "No pointer position was recorded during the utterance.";
      } else if (session.frameCount >= this.#limits.maxFramesPerSession) {
        session.droppedFrames += 1;
        captureError = "This session reached its screen-frame cap.";
      } else if (session.pendingCaptures.size >= this.#limits.maxPendingCaptures) {
        session.droppedFrames += 1;
        captureError = "Screen capture is busy; this utterance has no frame.";
      } else {
        const task = this.#capture.capture({ x: capturePoint.x, y: capturePoint.y }, {
          maxFrameDimension: this.#limits.maxFrameDimension,
          cursorCropSize: { width: this.#limits.cursorCropWidth, height: this.#limits.cursorCropHeight },
          jpegQuality: this.#limits.jpegQuality,
        }).then((result) => {
          if (this.#session !== session) return;
          if (result === undefined) {
            session.captureErrors += 1;
            captureError = "The display could not be captured.";
            return;
          }
          session.frameCount += 1;
          const kept: LiveCaptureFrame[] = [];
          for (const frame of [result.crop, result.frame]) {
            if (frame.byteLength > this.#limits.maxInlineFrameBytes) continue;
            kept.push(frame);
            if (kept.length >= 2) break;
          }
          if (kept.length === 0) {
            session.droppedFrames += 1;
            captureError = "The captured frames were too large to include.";
          }
          frames.push(...kept);
          stale = result.frame.capturedWallTimeMs - endedAtWallMs > this.#limits.captureStaleMs;
        }).catch((error: unknown) => {
          session.captureErrors += 1;
          captureError = errorMessage(error);
        }).finally(() => session.pendingCaptures.delete(task));
        session.pendingCaptures.add(task);
        await Promise.allSettled([task]);
      }

      let hover: ForegroundContext | null = null;
      if (capturePoint !== null) {
        const [nativeResult, providedResult] = await Promise.allSettled([
          this.#nativeContext(),
          this.#providedContext?.(),
        ]);
        if (nativeResult.status === "rejected" || providedResult.status === "rejected") session.captureErrors += 1;
        const merged = mergeForegroundContext(
          nativeResult.status === "fulfilled" ? nativeResult.value : undefined,
          providedResult.status === "fulfilled" ? providedResult.value : undefined,
          { wallTime: new Date(now).toISOString(), wallTimeMs: now },
        );
        hover = merged === undefined ? null : redactPasswordContext(merged);
      }

      session.utteranceCount += 1;
      const sampledAtWallTimeMs = this.#now();
      const cursorBlock = { start, end, samples: boundedSamples };
      const evidence: UtteranceEvidence = {
        formatVersion: LIVE_SESSION_FORMAT_VERSION,
        sessionId: session.id,
        utteranceId: input.utteranceId,
        window: {
          startedAtWallMs,
          endedAtWallMs,
          startedAt: new Date(startedAtWallMs).toISOString(),
          endedAt: new Date(endedAtWallMs).toISOString(),
        },
        sampledAtWallTimeMs,
        sampledAt: new Date(sampledAtWallTimeMs).toISOString(),
        cursor: cursorBlock,
        frames,
        captureError,
        stale,
        hover,
        pointerSummary: pointerSummary(cursorBlock),
        privacy: LIVE_SESSION_PRIVACY,
      };
      this.emitEvent({ type: "progress", session: this.activeDescriptor(session) });
      return evidence;
    });
  }

  public async dispose(): Promise<void> {
    if (this.#session !== undefined) await this.end("app-shutdown");
    this.#stateListeners.clear();
    this.#eventListeners.clear();
  }

  private sampleCursor(): void {
    const session = this.#session;
    if (session === undefined || session.stopping) return;
    const point = this.#cursorReader();
    if (point === undefined) return;
    const display = this.#capture.displayNearest(point);
    if (display === undefined) return;
    const wallTimeMs = this.#now();
    const sample: LiveCursorSample = {
      wallTimeMs,
      wallTime: new Date(wallTimeMs).toISOString(),
      x: point.x,
      y: point.y,
      displayId: display.id,
      displayBounds: display.bounds,
      displayScaleFactor: display.scaleFactor,
      ...normalizedPoint(point, display.bounds),
    };
    if (session.samples.length >= this.#limits.cursorRingCapacity) session.samples.shift();
    session.samples.push(sample);
  }

  private lastSamplePoint(): Point | undefined {
    const sample = this.#session?.samples.at(-1);
    return sample === undefined ? undefined : { x: sample.x, y: sample.y };
  }

  private activeDescriptor(session: ActiveSession): LiveSessionActive {
    return {
      id: session.id,
      phase: "active",
      startedAt: session.startedAt,
      startedWallTimeMs: session.startedWallTimeMs,
      maxDurationMs: this.#limits.maxSessionDurationMs,
      utteranceCount: session.utteranceCount,
      frameCount: session.frameCount,
      droppedFrames: session.droppedFrames,
      captureErrors: session.captureErrors,
      cursorSampleCount: session.samples.length,
      privacy: LIVE_SESSION_PRIVACY,
    };
  }

  private emitState(): void {
    const state = this.state();
    this.#onState?.(state);
    for (const listener of this.#stateListeners) listener(state);
    this.emitEvent({ type: "state", state });
  }

  private emitEvent(event: LiveSessionLiveEvent): void {
    this.#onEvent?.(event);
    for (const listener of this.#eventListeners) listener(event);
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

function lastSampleAtOrBefore(samples: readonly LiveCursorSample[], wallTimeMs: number): LiveCursorSample | null {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample !== undefined && sample.wallTimeMs <= wallTimeMs) return sample;
  }
  return null;
}

function redactPasswordContext(context: ForegroundContext): ForegroundContext {
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
