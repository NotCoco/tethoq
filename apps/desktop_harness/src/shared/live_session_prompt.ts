/**
 * Pure, dependency-free grounding text for instant-session evidence.
 * Shared by the main process and the renderer so the exact same narrative
 * reaches the coding tool regardless of which process assembles the message.
 */

export interface LivePromptPoint {
  readonly x: number;
  readonly y: number;
}

export interface LivePromptDisplayBounds extends LivePromptPoint {
  readonly width: number;
  readonly height: number;
}

export interface LivePromptCursorSample extends LivePromptPoint {
  readonly displayId: string;
  readonly displayBounds: LivePromptDisplayBounds;
  readonly displayScaleFactor: number;
  readonly xNormalized: number;
  readonly yNormalized: number;
}

export interface LivePromptFrame {
  readonly kind: "full" | "cursor";
  readonly label: string;
  readonly capturedWallTimeMs: number;
  readonly displayId: string;
  readonly displayBounds: LivePromptDisplayBounds;
}

export interface LivePromptHover {
  readonly appName?: string;
  readonly windowTitle?: string;
  readonly cursorElement?: { readonly name?: string; readonly controlType?: string; readonly isPassword?: boolean };
  readonly browser?: { readonly title?: string; readonly url?: string };
}

export interface LivePromptEvidence {
  readonly window: { readonly startedAtWallMs: number; readonly endedAtWallMs: number };
  readonly sampledAtWallTimeMs: number;
  readonly cursor: {
    readonly start: LivePromptCursorSample | null;
    readonly end: LivePromptCursorSample | null;
    readonly samples: readonly LivePromptCursorSample[];
  };
  readonly frames: readonly LivePromptFrame[];
  readonly captureError: string | null;
  readonly stale: boolean;
  readonly hover: LivePromptHover | null;
  readonly pointerSummary: string;
}

/** Normalizes a virtual-screen point against a display's DIP bounds. */
export function normalizedLivePoint(point: LivePromptPoint, display: LivePromptDisplayBounds): { readonly xNormalized: number; readonly yNormalized: number } {
  const width = Math.max(1, display.width);
  const height = Math.max(1, display.height);
  return {
    xNormalized: clamp01((point.x - display.x) / width),
    yNormalized: clamp01((point.y - display.y) / height),
  };
}

export function formatLiveClock(ms: number): string {
  const date = new Date(ms);
  const parts = [date.getHours(), date.getMinutes(), date.getSeconds()].map((value) => String(value).padStart(2, "0"));
  return `${parts.join(":")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function compactSample(sample: LivePromptCursorSample | null): string {
  if (sample === null) return "unavailable";
  return `(${sample.x}, ${sample.y}) normalized (${sample.xNormalized.toFixed(3)}, ${sample.yNormalized.toFixed(3)}) on display ${sample.displayId} (${sample.displayBounds.width}x${sample.displayBounds.height}, scale ${sample.displayScaleFactor})`;
}

export function livePointerSummary(cursor: LivePromptEvidence["cursor"]): string {
  if (cursor.end === null) return "Pointer position unavailable for this utterance.";
  return `Pointer: start ${compactSample(cursor.start)} -> end ${compactSample(cursor.end)}; ${cursor.samples.length} samples in the utterance window.`;
}

/**
 * Compact, time-aligned grounding text attached to every instant-session
 * message so both vision-capable and text-only models receive the same
 * synchronized evidence narrative.
 */
export function buildUtterancePrompt(transcript: string, evidence: LivePromptEvidence): string {
  const lines = [
    "[Instant session evidence]",
    `Spoken: ${transcript.trim()}`,
    `Utterance window: ${formatLiveClock(evidence.window.startedAtWallMs)} - ${formatLiveClock(evidence.window.endedAtWallMs)} (wall clock)`,
    evidence.pointerSummary,
  ];
  const hover = evidence.hover;
  if (hover !== null && hover !== undefined) {
    const target = [hover.appName, hover.windowTitle === undefined || hover.windowTitle.length === 0 ? undefined : `"${hover.windowTitle}"`].filter(Boolean).join(" — ");
    if (target.length > 0) lines.push(`Onscreen context: ${target}`);
    if (hover.cursorElement !== undefined) {
      const label = hover.cursorElement.isPassword === true ? "[redacted password field]" : [hover.cursorElement.name, hover.cursorElement.controlType].filter(Boolean).join(" (") + (hover.cursorElement.controlType === undefined ? "" : ")");
      if (label !== undefined && label !== "") lines.push(`Hovered element: ${label}`);
    }
    if (hover.browser !== undefined) lines.push(`Active browser tab: ${hover.browser.title || "untitled"} (${hover.browser.url})`);
  }
  if (evidence.frames.length > 0) {
    lines.push(`${evidence.frames.map((frame) => frame.label).join(" and ")} captured at ${formatLiveClock(evidence.frames[0]?.capturedWallTimeMs ?? evidence.sampledAtWallTimeMs)} are attached to this message.`);
  } else if (evidence.captureError !== null) {
    lines.push(`No screen frame is attached: ${evidence.captureError}`);
  }
  if (evidence.stale) lines.push("Note: the frame was captured noticeably after the utterance ended; the pointer path and window times above remain authoritative.");
  return lines.join("\n");
}

/**
 * Question for the existing vision-support ("eyes") model when the primary
 * model cannot inspect the synchronized frame itself.
 */
export function buildEyesQuestion(transcript: string, evidence: LivePromptEvidence): string {
  const hovered = evidence.hover?.cursorElement?.name !== undefined
    ? `hovering the element "${evidence.hover.cursorElement.name}"`
    : "near the marked pointer position";
  const display = evidence.frames[0] !== undefined
    ? `display ${evidence.frames[0].displayId} (${evidence.frames[0].displayBounds.width}x${evidence.frames[0].displayBounds.height})`
    : "the display";
  const end = evidence.cursor.end;
  return `This is a synchronized screen frame from an instant session. The user said: "${transcript.trim()}". At ${formatLiveClock(evidence.window.endedAtWallMs)} their cursor was ${hovered} on ${display}, at normalized position (${end !== null ? end.xNormalized.toFixed(3) : "?"}, ${end !== null ? end.yNormalized.toFixed(3) : "?"}). Describe in three to five sentences what the cursor is pointing at and what is visible in the region around it, including exact labels, text, and nearby items. Reply with the description only.`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
