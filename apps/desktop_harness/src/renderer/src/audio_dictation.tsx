/**
 * Direct-audio dictation for the Tethoq composer and transcript.
 *
 * The recorder captures raw PCM through the Web Audio API and encodes it as a
 * mono MP3 with lamejs, so the user's clip reaches the model as a real audio
 * input block rather than a transcription. The same module renders the
 * single-line live trace and the playable message widget.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mp3Encoder } from "lamejs";
import MPEGMode from "lamejs/src/js/MPEGMode.js";
import Lame from "lamejs/src/js/Lame.js";
import BitStream from "lamejs/src/js/BitStream.js";

/**
 * lamejs 1.2.1 was written for plain <script> tags: several of its modules
 * (Encoder, Lame, PsyModel) reference MPEGMode and friends as globals without
 * requiring them, which works only when every file shares one global scope. Any
 * bundler gives each module its own scope, so encoding threw "MPEGMode is not
 * defined" the moment a recording stopped. Free lookups resolve against the
 * global object at call time, so publishing the classes there makes the library
 * work as its authors intended without patching the dependency.
 */
const lameGlobals: Readonly<Record<string, unknown>> = { MPEGMode, Lame, BitStream };
for (const [name, value] of Object.entries(lameGlobals)) {
  if ((globalThis as Record<string, unknown>)[name] === undefined) {
    (globalThis as Record<string, unknown>)[name] = value;
  }
}

function PlayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg>;
}

function PauseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.5h3.5v13H7zM13.5 5.5H17v13h-3.5z" /></svg>;
}

export interface SelectedAudio {
  readonly path: string;
  readonly name: string;
  readonly mimeType: "audio/mpeg";
  readonly byteLength: number;
  readonly dataBase64: string;
  readonly durationSeconds: number;
  readonly origin: "file-picker" | "drag-drop" | "clipboard" | "dictation";
}

const encoderSampleRate = 44100;
const encoderBitRate = 128;
const maximumAudioBytes = 24 * 1024 * 1024;

/** Converts bytes to base64 without stressing the call stack on larger clips. */
function bytesToBase64(bytes: Uint8Array): string {
  const step = 32 * 1024;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + step)));
  }
  return btoa(binary);
}

export class Mp3DictationRecorder {
  readonly #onLevel: (level: number) => void;
  #stream: MediaStream | null = null;
  #context: AudioContext | null = null;
  #processor: ScriptProcessorNode | null = null;
  #chunks: Float32Array[] = [];
  #sampleCount = 0;
  #lastLevelAt = 0;

  public constructor(onLevel: (level: number) => void) {
    this.#onLevel = onLevel;
  }

  public async start(inputStream?: MediaStream): Promise<void> {
    if (!inputStream && !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone recording is unavailable on this computer.");
    const stream = inputStream ?? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    this.#stream = stream;
    const context = new AudioContext({ sampleRate: encoderSampleRate });
    this.#context = context;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    this.#processor = processor;
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      this.#chunks.push(new Float32Array(input));
      this.#sampleCount += input.length;
      const now = performance.now();
      if (now - this.#lastLevelAt >= 50) {
        this.#lastLevelAt = now;
        let sum = 0;
        for (let index = 0; index < input.length; index += 1) sum += input[index]! * input[index]!;
        const level = Math.min(1, Math.sqrt(sum / input.length) * 4);
        this.#onLevel(level);
      }
    };
    source.connect(processor);
    processor.connect(context.destination);
  }

  public async stop(): Promise<SelectedAudio> {
    const durationSeconds = this.#sampleCount / encoderSampleRate;
    const samples = this.collectSamples();
    this.teardown();
    if (durationSeconds < 0.5) throw new Error("No audio was recorded.");
    const encoded = encodeMp3(samples);
    if (encoded.byteLength > maximumAudioBytes) throw new Error("Recordings can be up to about 25 minutes for direct audio dictation.");
    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/u, "");
    const name = `dictation-${stamp}.mp3`;
    return {
      path: `audio-dictation:${Date.now()}`,
      name,
      mimeType: "audio/mpeg",
      byteLength: encoded.byteLength,
      dataBase64: bytesToBase64(encoded),
      durationSeconds,
      origin: "dictation",
    };
  }

  public async cancel(): Promise<void> {
    this.#chunks = [];
    this.#sampleCount = 0;
    this.teardown();
  }

  public dispose(): void {
    this.teardown();
  }

  private collectSamples(): Float32Array {
    const result = new Float32Array(this.#sampleCount);
    let offset = 0;
    for (const chunk of this.#chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    this.#chunks = [];
    this.#sampleCount = 0;
    return result;
  }

  private teardown(): void {
    const processor = this.#processor;
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
      this.#processor = null;
    }
    if (this.#stream) {
      this.#stream.getTracks().forEach((track) => track.stop());
      this.#stream = null;
    }
    if (this.#context && this.#context.state !== "closed") void this.#context.close().catch(() => undefined);
    this.#context = null;
  }
}

function encodeMp3(samples: Float32Array): Uint8Array {
  const encoder = new Mp3Encoder(1, encoderSampleRate, encoderBitRate);
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    pcm[index] = sample < 0 ? Math.max(-1, sample) * 0x8000 : Math.min(1, sample) * 0x7fff;
  }
  const parts: Int8Array[] = [];
  const block = 1152;
  for (let offset = 0; offset < pcm.length; offset += block) {
    parts.push(encoder.encodeBuffer(pcm.subarray(offset, offset + block)));
  }
  parts.push(encoder.flush());
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
    offset += part.byteLength;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Playback and waveform helpers

interface DecodedClip {
  readonly buffer: AudioBuffer;
  readonly peaks: readonly number[];
}

const decodedClipCache = new WeakMap<Blob, Promise<DecodedClip>>();
let playbackContext: AudioContext | null = null;
let playbackSource: AudioBufferSourceNode | null = null;

function sharedPlaybackContext(): AudioContext {
  if (playbackContext === null || playbackContext.state === "closed") {
    playbackContext = new AudioContext();
  }
  return playbackContext;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const mimeType = /^data:([^;]+)/u.exec(header)?.[1] ?? "audio/mpeg";
  return new Blob([bytes], { type: mimeType });
}

async function decodeClip(dataUrl: string): Promise<DecodedClip> {
  const blob = dataUrlToBlob(dataUrl);
  const cached = decodedClipCache.get(blob);
  if (cached) return cached;
  const decoded = (async () => {
    const context = sharedPlaybackContext();
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const bars = 84;
    const peaks: number[] = [];
    const channel = buffer.getChannelData(0);
    const width = Math.max(1, Math.floor(channel.length / bars));
    for (let bar = 0; bar < bars; bar += 1) {
      let peak = 0;
      const start = bar * width;
      for (let index = start; index < Math.min(channel.length, start + width); index += 1) {
        peak = Math.max(peak, Math.abs(channel[index]!));
      }
      peaks.push(peak);
    }
    return { buffer, peaks };
  })();
  decodedClipCache.set(blob, decoded);
  return decoded;
}

export function useAudioClip(dataUrl: string): { readonly duration: number | null; readonly peaks: readonly number[] } {
  const [clip, setClip] = useState<DecodedClip | null>(null);
  useEffect(() => {
    let active = true;
    void decodeClip(dataUrl).then((decoded) => { if (active) setClip(decoded); }).catch(() => undefined);
    return () => { active = false; };
  }, [dataUrl]);
  return useMemo(() => ({ duration: clip?.buffer.duration ?? null, peaks: clip?.peaks ?? [] }), [clip]);
}

/**
 * Playback position counts up from zero, so it floors. A clip's own length
 * rounds instead: flooring reported a real recording just under a second as
 * "0:00", which reads as an empty clip.
 */
function formatSeconds(total: number, rounding: "floor" | "nearest" = "floor"): string {
  const seconds = Math.max(0, rounding === "nearest" ? Math.round(total) : Math.floor(total));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Waveform canvas: one continuous line that traces the audio path.

export function AudioTraceCanvas({ live = false, peaks, progress = 0, className }: {
  /** When live, draws the rolling microphone amplitude trace. */
  live?: boolean;
  /** Static peaks for a recorded clip. */
  peaks?: readonly number[];
  /** Playback position, 0..1, used to advance the static window. */
  progress?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const liveLevels = useRef<number[]>([]);
  const liveFrame = useRef<number | null>(null);
  const progressRef = useRef(progress);
  const peaksRef = useRef(peaks);
  progressRef.current = progress;
  peaksRef.current = peaks;

  useEffect(() => {
    const target = canvas.current;
    if (!target) return undefined;
    const draw = () => {
      const context = target.getContext("2d");
      const parent = target.parentElement;
      const width = parent?.clientWidth ?? 320;
      const height = target.clientHeight || 40;
      if (!context || width <= 0) return;
      const ratio = window.devicePixelRatio || 1;
      if (target.width !== Math.round(width * ratio) || target.height !== Math.round(height * ratio)) {
        target.width = Math.max(1, Math.round(width * ratio));
        target.height = Math.max(1, Math.round(height * ratio));
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.lineWidth = 1.5;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.strokeStyle = "currentColor";
      context.beginPath();
      if (live) {
        const levels = liveLevels.current;
        const step = width / 220;
        if (!levels.length) {
          context.moveTo(0, height / 2);
          context.lineTo(width, height / 2);
        } else {
          for (let index = 0; index < levels.length; index += 1) {
            const x = width - (levels.length - index) * step;
            const y = height / 2 - levels[index]! * (height / 2 - 3);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          }
        }
      } else {
        const currentPeaks = peaksRef.current;
        if (currentPeaks?.length) {
          const windowBars = Math.min(48, currentPeaks.length);
          const offset = Math.max(0, Math.min(currentPeaks.length - windowBars, Math.round(progressRef.current * currentPeaks.length)));
          const visible = currentPeaks.slice(offset, offset + windowBars);
          const step = width / Math.max(1, visible.length - 1);
          visible.forEach((peak, index) => {
            const x = index * step;
            const y = height / 2 - Math.max(0.04, Math.min(1, peak)) * (height / 2 - 3);
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
        } else {
          context.moveTo(0, height / 2);
          context.lineTo(width, height / 2);
        }
      }
      context.stroke();
    };
    const animate = () => {
      draw();
      liveFrame.current = requestAnimationFrame(animate);
    };
    draw();
    window.addEventListener("resize", draw);
    if (live) {
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      liveLevels.current = [];
      const onLevel = (level: number) => {
        liveLevels.current.push(Math.max(0.02, Math.min(1, level)));
        if (liveLevels.current.length > 220) liveLevels.current.shift();
      };
      liveTraceLevels.listeners.add(onLevel);
      liveFrame.current = requestAnimationFrame(animate);
      if (reducedMotion) {
        // Reduced motion: refresh on level changes only, at a calm cadence.
        cancelAnimationFrame(liveFrame.current);
        liveFrame.current = null;
        const interval = window.setInterval(draw, 400);
        return () => {
          window.clearInterval(interval);
          liveTraceLevels.listeners.delete(onLevel);
        };
      }
    }
    return () => {
      window.removeEventListener("resize", draw);
      liveTraceLevels.listeners.clear();
      if (liveFrame.current !== null) cancelAnimationFrame(liveFrame.current);
      liveFrame.current = null;
    };
  }, [live, peaks, progress]);

  return <span className={["audio-trace", className].filter(Boolean).join(" ")}>
    <canvas ref={canvas} aria-hidden="true" />
  </span>;
}

/** The live trace subscribes to this module-level channel via a public ref handle. */
export const liveTraceLevels = {
  listeners: new Set<(level: number) => void>(),
  push(level: number): void {
    for (const listener of this.listeners) listener(level);
  },
};

// ---------------------------------------------------------------------------
// Playable clip widget

export function AudioPlaybackChip({ name, dataUrl, onRemove, className = "", dictation = false, durationSeconds }: {
  name: string;
  dataUrl: string;
  onRemove?: (() => void) | undefined;
  className?: string;
  dictation?: boolean;
  /** Known length, used when the clip cannot be decoded for playback. */
  durationSeconds?: number | undefined;
}) {
  const { duration: decodedDuration, peaks } = useAudioClip(dataUrl);
  // Decoding is what enables playback, but the recorder already measured the
  // clip while capturing it. That measurement is the better answer and survives
  // a clip the browser cannot decode, so it is preferred where it exists.
  const duration = durationSeconds !== undefined && durationSeconds > 0 ? durationSeconds : decodedDuration;
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const startedAt = useRef<number | null>(null);
  const buffer = useRef<DecodedClip | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    void decodeClip(dataUrl).then((decoded) => { if (active) buffer.current = decoded; }).catch(() => undefined);
    return () => { active = false; };
  }, [dataUrl]);

  const tick = useCallback(() => {
    frame.current = null;
    const clip = buffer.current;
    if (!clip || startedAt.current === null) return;
    const elapsed = sharedPlaybackContext().currentTime - startedAt.current;
    if (elapsed >= clip.buffer.duration) {
      setProgress(1);
      setPlaying(false);
      startedAt.current = null;
      return;
    }
    setProgress(elapsed / clip.buffer.duration);
    frame.current = requestAnimationFrame(tick);
  }, []);

  const stopPlayback = useCallback(() => {
    if (playbackSource) {
      try { playbackSource.onended = null; playbackSource.stop(); } catch { /* Already stopped. */ }
      playbackSource.disconnect();
      playbackSource = null;
    }
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    startedAt.current = null;
    setPlaying(false);
  }, []);

  const toggle = useCallback(async () => {
    const clip = buffer.current;
    if (!clip) return;
    if (playing) {
      stopPlayback();
      return;
    }
    const context = sharedPlaybackContext();
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    const source = context.createBufferSource();
    source.buffer = clip.buffer;
    source.connect(context.destination);
    source.onended = () => {
      playbackSource = null;
      startedAt.current = null;
      setPlaying(false);
      setProgress(1);
    };
    playbackSource = source;
    startedAt.current = context.currentTime;
    setProgress(0);
    setPlaying(true);
    source.start();
    frame.current = requestAnimationFrame(tick);
  }, [playing, stopPlayback, tick]);

  useEffect(() => stopPlayback, [stopPlayback]);

  // The length of the clip is the point of the widget, so it never disappears.
  // Playback adds the position in front of it rather than replacing it.
  const label = duration === null
    ? "Audio"
    : playing
      ? `${formatSeconds(progress * duration)} / ${formatSeconds(duration, "nearest")}`
      : formatSeconds(duration, "nearest");
  return <span className={`audio-playback-chip ${dictation ? "audio-playback-dictation" : ""} ${className}`.trim()}>
    <button type="button" className="audio-playback-toggle" aria-label={playing ? `Pause ${name}` : `Play ${name}`} title={playing ? "Pause recording" : "Play recording"} onClick={() => void toggle()}>{playing ? <PauseIcon /> : <PlayIcon />}</button>
    <AudioTraceCanvas peaks={peaks} progress={progress} />
    <span className="audio-playback-label">{label}</span>
    {dictation ? <span className="audio-dictation-mark" title="Dictation" aria-label="Dictation"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="2" width="4" height="7" rx="2"/><path d="M4 8a4 4 0 0 0 8 0M8 12v2M6 14h4"/></svg></span> : null}
    {onRemove ? <button type="button" className="audio-playback-remove" aria-label={`Remove ${name}`} title={`Remove ${name}`} onClick={onRemove}><span aria-hidden="true">×</span></button> : null}
  </span>;
}
