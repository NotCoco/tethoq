import type { ForegroundContext, Point, RecorderContextProvider, RecorderDisplay } from "../recorder/types.js";

export const LIVE_SESSION_FORMAT_VERSION = 1 as const;

export type LiveSessionPhase = "idle" | "active";
export type LiveSessionEndReason = "user" | "app-shutdown" | "settings-disabled" | "duration-limit" | "error";

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

export const LIVE_SESSION_PRIVACY: LiveSessionPrivacy = Object.freeze({
  localOnly: true,
  neverUploadedAutomatically: true,
  capturesScreen: true,
  capturesPointer: true,
  capturesMicrophone: true,
  sensitiveDataPossible: true,
  warning: "Instant sessions capture your microphone, the screen, and your pointer position while you talk. Spoken utterances, synchronized screen frames, and hover context are sent to the selected coding tool and, when the model cannot see images, to your configured visual-support model.",
  limitations: Object.freeze([
    "The pointer timeline records position and hovered element context, not global button state.",
    "Secure, elevated, DRM-protected, or hardware-accelerated windows may be blank or incomplete.",
    "Password-field detection is best effort; protected controls may not identify themselves.",
    "A frame is captured once per utterance, at its end, so it reflects the state while you spoke; the capture time is always recorded with the frame.",
  ]),
});

export interface LiveCursorSample {
  readonly wallTimeMs: number;
  readonly wallTime: string;
  readonly x: number;
  readonly y: number;
  readonly displayId: string;
  readonly displayBounds: RecorderDisplay["bounds"];
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
  readonly displayBounds: RecorderDisplay["bounds"];
  readonly displayScaleFactor: number;
  readonly cursor: { readonly x: number; readonly y: number; readonly xNormalized: number; readonly yNormalized: number };
}

export interface LiveCaptureResult {
  readonly frame: LiveCaptureFrame;
  readonly crop: LiveCaptureFrame;
}

export interface LiveSessionCaptureAdapter {
  displays(): readonly RecorderDisplay[];
  displayNearest(point: Point): RecorderDisplay | undefined;
  capture(point: Point, options: { readonly maxFrameDimension: number; readonly cursorCropSize: { readonly width: number; readonly height: number }; readonly jpegQuality: number }): Promise<LiveCaptureResult | undefined>;
}

export interface LiveSessionLimits {
  readonly cursorSampleIntervalMs: number;
  readonly cursorRingCapacity: number;
  readonly maxSamplesPerEvidence: number;
  readonly maxUtteranceWindowMs: number;
  readonly futureClockSkewMs: number;
  readonly maxFrameDimension: number;
  readonly cursorCropWidth: number;
  readonly cursorCropHeight: number;
  readonly jpegQuality: number;
  readonly maxFramesPerSession: number;
  readonly maxInlineFrameBytes: number;
  readonly maxSessionDurationMs: number;
  readonly maxPendingCaptures: number;
  readonly captureStaleMs: number;
}

export const DEFAULT_LIVE_SESSION_LIMITS: LiveSessionLimits = Object.freeze({
  cursorSampleIntervalMs: 50,
  cursorRingCapacity: 2_400,
  maxSamplesPerEvidence: 240,
  maxUtteranceWindowMs: 60_000,
  futureClockSkewMs: 2_000,
  maxFrameDimension: 1_280,
  cursorCropWidth: 640,
  cursorCropHeight: 480,
  jpegQuality: 78,
  maxFramesPerSession: 120,
  maxInlineFrameBytes: 900 * 1_024,
  maxSessionDurationMs: 2 * 60 * 60 * 1_000,
  maxPendingCaptures: 2,
  captureStaleMs: 1_500,
});

export interface UtteranceEvidence {
  readonly formatVersion: typeof LIVE_SESSION_FORMAT_VERSION;
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
  readonly hover: ForegroundContext | null;
  readonly pointerSummary: string;
  readonly privacy: LiveSessionPrivacy;
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
  readonly phase: LiveSessionPhase;
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly active?: LiveSessionActive;
  readonly privacy: LiveSessionPrivacy;
}

export type LiveSessionLiveEvent =
  | { readonly type: "state"; readonly state: LiveSessionState }
  | { readonly type: "progress"; readonly session: LiveSessionActive }
  | { readonly type: "ended"; readonly reason: LiveSessionEndReason };

export interface LiveSessionManagerOptions {
  readonly isEnabled: () => boolean;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly cursorReader?: () => Point | undefined;
  readonly captureAdapter?: LiveSessionCaptureAdapter;
  readonly contextProvider?: RecorderContextProvider;
  readonly nativeContextProvider?: RecorderContextProvider;
  readonly limits?: Partial<LiveSessionLimits>;
  readonly onState?: (state: LiveSessionState) => void;
  readonly onEvent?: (event: LiveSessionLiveEvent) => void;
}
