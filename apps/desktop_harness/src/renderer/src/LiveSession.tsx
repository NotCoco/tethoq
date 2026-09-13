import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonObject } from "../../../../../packages/protocol/src/index";
import { matchReasoningEffort, reasoningDisplayLabel, resolveModelReasoningProfile } from "../../../../../packages/protocol/src/reasoning";
import type { LiveSessionState, UtteranceEvidence, VisionProxySelection, VisionProxyStatus, VisionProxyTarget } from "@shared/desktop_api";
import { buildEyesQuestion, buildUtterancePrompt } from "@shared/live_session_prompt";
import { isBrowserPreview, request } from "./bridge";
import { blobToUploadable, chooseTranscriptionSource, uploadAttachments, type TranscriptionSource } from "./composer_helpers";
import { Button, Modal } from "./components";
import { AlertIcon, MicrophoneIcon, StopIcon } from "./icons";
import { encodeWavPcm16 } from "./live_session_audio";
import type { Session } from "./types";

function uploadRequest() {
  return (type: string, payload: Record<string, unknown> = {}) => request(type, payload as JsonObject);
}

const MIN_UTTERANCE_MS = 450;
const MAX_UTTERANCE_MS = 30_000;
const VAD_POLL_MS = 60;
const QUIET_HANGOVER_MS = 520;
const PCM_SAMPLE_RATE = 16_000;
const MAX_UTTERANCES = 80;
const DICTATION_SOURCE_KEY = "tethoq:live-session:dictation-source";

type PanelPhase = "idle" | "starting" | "recording" | "stopping";

interface UtteranceRecord {
  readonly id: string;
  readonly startedAtWallMs: number;
  readonly endedAtWallMs: number;
  transcript: string;
  status: "transcribing" | "sending" | "sent" | "error";
  error?: string;
  evidence?: UtteranceEvidence;
  eyesObservation?: string;
  usedEyes: boolean;
}

interface VadState {
  timer: number;
  noiseFloor: number;
  speaking: boolean;
  speakingSince: number;
  quietSince: number;
  buffer: Float32Array[];
}

export function LiveSessionPanel({ session, experimental, notify, onClose }: {
  session: Session;
  experimental: boolean;
  notify: (message: string, tone?: "normal" | "error") => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<PanelPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [liveState, setLiveState] = useState<LiveSessionState | null>(null);
  const [vision, setVision] = useState<"native" | "eyes" | "configuring" | "missing">("missing");
  const [targets, setTargets] = useState<readonly VisionProxyTarget[]>([]);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const [utterances, setUtterances] = useState<readonly UtteranceRecord[]>([]);
  const [transcript, setTranscript] = useState("");
  const [eyesNote, setEyesNote] = useState("");
  const audio = useRef<{ context: AudioContext; stream: MediaStream; processor: ScriptProcessorNode } | null>(null);
  const vad = useRef<VadState | null>(null);
  const stopRequested = useRef(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sourceRef = useRef<TranscriptionSource | null>(null);
  const visionNativeRef = useRef(false);

  const updateUtterance = useCallback((id: string, update: Partial<UtteranceRecord>) => {
    setUtterances((current) => current.map((item) => item.id === id ? { ...item, ...update } : item));
  }, []);

  const stopLocalAudio = useCallback(() => {
    if (vad.current?.timer !== undefined) window.clearInterval(vad.current.timer);
    vad.current = null;
    if (audio.current !== null) {
      try { audio.current.processor.disconnect(); } catch { /* already closed */ }
      try { void audio.current.context.close(); } catch { /* already closed */ }
      for (const track of audio.current.stream.getTracks()) track.stop();
      audio.current = null;
    }
  }, []);

  useEffect(() => {
    if (isBrowserPreview) return;
    void window.tethoqDesktop.liveSessionState().then(setLiveState).catch(() => undefined);
    const removeState = window.tethoqDesktop.onLiveSessionState((state) => {
      setLiveState(state);
      if (state.phase === "idle") setPhase((current) => current === "recording" ? "idle" : current);
    });
    const removeEvent = window.tethoqDesktop.onLiveSessionEvent((event) => {
      if (event.type !== "ended") return;
      stopLocalAudio();
      setPhase("idle");
      if (event.reason === "settings-disabled") notify("Instant session stopped because experimental features were disabled.", "error");
      else if (event.reason === "duration-limit") notify("Instant session reached its time limit and stopped.", "error");
    });
    return () => { removeState(); removeEvent(); };
  }, [notify, stopLocalAudio]);

  useEffect(() => () => {
    stopRequested.current = true;
    stopLocalAudio();
    if (!isBrowserPreview) void window.tethoqDesktop.liveSessionAction({ type: "end", reason: "user" }).catch(() => undefined);
  }, [stopLocalAudio]);

  const processUtterance = useCallback(async (record: UtteranceRecord, buffer: Float32Array[]) => {
    const source = sourceRef.current;
    if (source === null) throw new Error("No dictation source is selected.");
    // Capture screen/pointer evidence immediately so the frame stays fresh
    // relative to the utterance window, in parallel with transcription.
    const evidencePromise = window.tethoqDesktop.liveSessionAction({ type: "evidence", utteranceId: record.id, startedAtWallMs: record.startedAtWallMs, endedAtWallMs: record.endedAtWallMs });
    const total = buffer.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of buffer) { samples.set(chunk, offset); offset += chunk.length; }
    const wav = encodeWavPcm16(samples, PCM_SAMPLE_RATE);
    if (wav.byteLength > source.capabilities.maxAudioBytes) throw new Error(`${source.label} accepts recordings up to ${Math.round(source.capabilities.maxAudioBytes / 1024 / 1024)} MB.`);
    const audioUploadable = await blobToUploadable(new Blob([wav], { type: "audio/wav" }), `${record.id}.wav`);
    const pendingUploadIds: string[] = [];
    let attachmentId: string;
    try {
      const [id] = await uploadAttachments([audioUploadable], uploadRequest(), (uploadId) => pendingUploadIds.push(uploadId));
      if (id === undefined) throw new Error("The utterance recording could not be uploaded.");
      attachmentId = id;
    } catch (failure) {
      await Promise.all(pendingUploadIds.map((uploadId) => request("attachment.upload.cancel", { uploadId }).catch(() => undefined)));
      throw failure;
    }
    const transcribeResult = await request("dictation.transcribe", { attachmentId, dictionary: [], sourceId: source.id });
    const text = typeof transcribeResult.text === "string" ? transcribeResult.text.trim() : "";
    const evidencePayload = await evidencePromise;
    const evidence = evidencePayload as unknown as UtteranceEvidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || !Array.isArray(evidence.frames)) throw new Error("Desktop returned invalid instant-session evidence.");
    if (!text) {
      updateUtterance(record.id, { status: "error", error: "No speech was detected.", evidence });
      return;
    }
    updateUtterance(record.id, { transcript: text, status: "sending" });
    setTranscript(text);
    const useEyes = !visionNativeRef.current;
    let content = buildUtterancePrompt(text, evidence);
    let attachmentIds: readonly string[] = [];
    let eyesObservation: string | undefined;
    if (useEyes) {
      const crop = evidence.frames.find((frame) => frame.kind === "cursor") ?? evidence.frames[0];
      if (crop !== undefined) {
        const observation = await request("session.vision.ask", {
          sessionId: sessionRef.current.id,
          question: buildEyesQuestion(text, evidence),
          attachments: [{ name: `${record.id}-crop.jpg`, mimeType: crop.mimeType, dataBase64: crop.dataBase64, byteLength: crop.byteLength }],
        });
        eyesObservation = typeof observation.observation === "string" ? observation.observation.trim() : "";
        if (eyesObservation) content = `${content}\n\nVisual observation: ${eyesObservation}`;
      }
    } else if (evidence.frames.length > 0) {
      const frameUploads = evidence.frames.map((frame) => ({
        name: `${record.id}-${frame.kind}.jpg`,
        mimeType: frame.mimeType,
        byteLength: frame.byteLength,
        dataBase64: frame.dataBase64,
      }));
      try {
        attachmentIds = await uploadAttachments(frameUploads, uploadRequest(), (uploadId) => pendingUploadIds.push(uploadId));
      } catch (failure) {
        await Promise.all(pendingUploadIds.map((uploadId) => request("attachment.upload.cancel", { uploadId }).catch(() => undefined)));
        throw failure;
      }
    }
    const activeSession = sessionRef.current;
    const blocked = activeSession.state === "working" || activeSession.state === "needs_approval" || activeSession.state === "needs_input";
    const requestType = attachmentIds.length || blocked ? "message_queue.enqueue" : "session.send_message";
    await request(requestType, { sessionId: activeSession.id, content, ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}) });
    updateUtterance(record.id, { status: "sent", evidence, ...(eyesObservation !== undefined ? { eyesObservation, usedEyes: true } : {}) });
    if (useEyes && eyesObservation !== undefined) setEyesNote(eyesObservation);
  }, [updateUtterance]);

  const finishUtterance = useCallback((vadState: VadState, endedAtWallMs: number) => {
    const startedAtWallMs = vadState.speakingSince;
    const buffer = vadState.buffer;
    vadState.buffer = [];
    if (endedAtWallMs - startedAtWallMs < MIN_UTTERANCE_MS || buffer.length === 0) return;
    const id = `utterance-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const record: UtteranceRecord = { id, startedAtWallMs, endedAtWallMs, transcript: "", status: "transcribing", usedEyes: false };
    setUtterances((current) => [...current.slice(-(MAX_UTTERANCES - 1)), record]);
    void processUtterance(record, buffer).catch((failure: unknown) => {
      updateUtterance(record.id, { status: "error", error: safeLiveSessionError(failure, "That utterance could not be sent. Try again.") });
    });
  }, [processUtterance, updateUtterance]);

  const start = useCallback(async () => {
    if (isBrowserPreview) { notify("Instant sessions are available in the installed desktop app.", "error"); return; }
    setError(null);
    setPhase("starting");
    setUtterances([]);
    setTranscript("");
    setEyesNote("");
    try {
      await window.tethoqDesktop.liveSessionAction({ type: "begin" });
    } catch (failure) {
      setPhase("idle");
      notify(failure instanceof Error ? failure.message : String(failure), "error");
      return;
    }
    try {
      const visionResult = await request("session.vision.get", { sessionId: sessionRef.current.id });
      const status = visionResult.vision as unknown as VisionProxyStatus | undefined;
      if (!status || (status.primaryModelSupportsImageInput !== null && typeof status.primaryModelSupportsImageInput !== "boolean")) throw new Error("Bridge returned an invalid visual-support status.");
      if (status.primaryModelSupportsImageInput === false && status.configured === null) {
        const targetsPayload = await request("vision.targets", {});
        const available = Array.isArray(targetsPayload.targets) ? targetsPayload.targets as unknown as VisionProxyTarget[] : [];
        if (!available.length) {
          throw new Error(targetsPayload.incomplete === true
            ? "Visual models could not be checked right now. Try again in a moment."
            : "This model cannot see images and no vision model is available. Configure a visual-support model first.");
        }
        setTargets(available);
        setProviderId(available[0]?.providerId ?? "");
        setModelId(available[0]?.models.find((model) => model.isDefault)?.id ?? available[0]?.models[0]?.id ?? "");
        setVision("configuring");
        setPhase("idle");
        await window.tethoqDesktop.liveSessionAction({ type: "end", reason: "user" });
        return;
      }
      setVision(status.primaryModelSupportsImageInput === false ? "eyes" : "native");
      const sourcesPayload = await request("dictation.source.list", {});
      const sources = Array.isArray(sourcesPayload.sources) ? sourcesPayload.sources as unknown as TranscriptionSource[] : [];
      const preferred = window.localStorage.getItem(DICTATION_SOURCE_KEY);
      const source = chooseTranscriptionSource(sources, preferred);
      if (source === undefined || source.status !== "ready") throw new Error("No ready dictation source was reported by Bridge. Choose one in the dictation settings first.");
      sourceRef.current = source;
      if (source.id !== preferred) window.localStorage.setItem(DICTATION_SOURCE_KEY, source.id);

      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") throw new Error("Microphone dictation is unavailable on this computer.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      const analyser = context.createAnalyser();
      analyser.fftSize = 1_024;
      analyser.smoothingTimeConstant = 0.5;
      const processor = context.createScriptProcessor(2_048, 1, 1);
      const sourceNode = context.createMediaStreamSource(stream);
      sourceNode.connect(analyser);
      sourceNode.connect(processor);
      processor.connect(context.destination);
      const vadState: VadState = { timer: 0, noiseFloor: 0.5, speaking: false, speakingSince: 0, quietSince: 0, buffer: [] };
      const levelData = new Float32Array(analyser.fftSize);
      processor.onaudioprocess = (event) => {
        if (vadState.speaking && !stopRequested.current) {
          const channel = event.inputBuffer.getChannelData(0);
          vadState.buffer.push(new Float32Array(channel));
        }
      };
      vadState.timer = window.setInterval(() => {
        if (stopRequested.current) return;
        analyser.getFloatTimeDomainData(levelData);
        let sum = 0;
        for (const value of levelData) sum += value * value;
        const rms = Math.sqrt(sum / levelData.length);
        const threshold = Math.max(0.018, vadState.noiseFloor * 3);
        const now = Date.now();
        if (!vadState.speaking) {
          vadState.noiseFloor = Math.min(vadState.noiseFloor, rms);
          if (vadState.quietSince === 0) vadState.quietSince = now;
          if (rms > threshold && now - vadState.quietSince > 150) {
            vadState.speaking = true;
            vadState.speakingSince = now;
            vadState.buffer = [];
          }
          return;
        }
        vadState.quietSince = now;
        if (rms <= threshold) {
          if (now - vadState.quietSince > QUIET_HANGOVER_MS) {
            vadState.speaking = false;
            finishUtterance(vadState, now);
          }
        } else if (now - vadState.speakingSince > MAX_UTTERANCE_MS) {
          vadState.speaking = false;
          finishUtterance(vadState, now);
        }
      }, VAD_POLL_MS);
      audio.current = { context, stream, processor };
      vad.current = vadState;
      setPhase("recording");
      notify("Instant session started. Speak naturally; each utterance is transcribed and sent with synchronized screen and pointer evidence.");
    } catch (failure) {
      const message = safeLiveSessionError(failure, "Instant session could not start. Check the microphone and EYES settings, then try again.");
      setError(message);
      setPhase("idle");
      notify(microphoneErrorMessage(failure), "error");
      await window.tethoqDesktop.liveSessionAction({ type: "end", reason: "user" }).catch(() => undefined);
    }
  }, [finishUtterance, notify]);

  visionNativeRef.current = vision === "native";

  const stop = useCallback(async () => {
    stopRequested.current = true;
    stopLocalAudio();
    setPhase("stopping");
    try {
      if (!isBrowserPreview) await window.tethoqDesktop.liveSessionAction({ type: "end", reason: "user" });
    } catch (failure) {
      notify(safeLiveSessionError(failure, "EYES could not be configured. Refresh the available models and try again."), "error");
    }
    setPhase("idle");
  }, [notify, stopLocalAudio]);

  const visionTarget = targets.find((item) => item.providerId === providerId) ?? targets[0];
  const visionModel = visionTarget?.models.find((item) => item.id === modelId) ?? visionTarget?.models.find((item) => item.isDefault) ?? visionTarget?.models[0];
  const visionReasoning = resolveModelReasoningProfile({ providerId: visionTarget?.providerId ?? "", modelId: visionModel?.id ?? "", advertised: visionModel?.nativeMetadata });
  const visionEffort = matchReasoningEffort(effort, visionReasoning.efforts) ?? visionReasoning.defaultEffort ?? "";
  const configureEyes = useCallback(async () => {
    setError(null);
    try {
      const target = targets.find((item) => item.providerId === providerId) ?? targets[0];
      const model = target?.models.find((item) => item.id === modelId) ?? target?.models.find((item) => item.isDefault) ?? target?.models[0];
      if (target === undefined || model === undefined) throw new Error("Choose a vision model to continue.");
      if (visionReasoning.efforts.length && !visionEffort) throw new Error("Choose a reasoning level for EYES before saving.");
      const selection: VisionProxySelection = { providerId: target.providerId, modelId: model.id, ...(visionEffort ? { reasoningEffort: visionEffort } : {}) };
      await request("session.vision.configure", { sessionId: sessionRef.current.id, selection: selection as unknown as JsonObject });
      setVision("eyes");
      notify("Vision model configured as eyes for this session.");
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : String(failure), "error");
    }
  }, [modelId, notify, providerId, targets, visionEffort, visionReasoning.efforts.length]);

  const running = phase === "recording";
  const visionStatus = vision === "native" ? "Model sees the screen directly" : vision === "eyes" ? "Using the configured vision model as eyes" : vision === "configuring" ? "Choose a vision model as eyes" : "Checking vision support";
  return <Modal title="Instant session" eyebrow={session.title} wide onClose={() => { if (running) void stop(); else onClose(); }}>
    <div className="live-session-panel" aria-label="Instant session">
      <div className="live-session-status" role="status">
        <span className={`live-session-dot ${running ? "live" : ""}`} />
        <span><strong>{running ? "Listening" : phase === "starting" ? "Starting…" : "Standby"}</strong><small>{visionStatus} · {liveState?.supported === false ? "Unavailable on this platform" : "utterances are sent with synchronized evidence"}</small></span>
      </div>
      {vision === "configuring" ? <section className="live-session-eyes" aria-label="Choose a vision model">
        <header><span><strong>Choose a model as eyes</strong><small>The current model cannot see images, so each synchronized frame is described by a visual-support model.</small></span></header>
        <div className="vision-picker-fields">
          <label><span>Provider</span><select aria-label="Vision provider" value={providerId} onChange={(event) => { setProviderId(event.target.value); setModelId(""); setEffort(""); }}>{targets.map((item) => <option key={item.providerId} value={item.providerId}>{item.displayName}</option>)}</select></label>
          <label><span>Model</span><select aria-label="Vision model" value={visionModel?.id ?? ""} onChange={(event) => { setModelId(event.target.value); setEffort(""); }}>{visionTarget?.models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
          <label><span>Reasoning</span><select aria-label="Vision reasoning effort" value={visionEffort} disabled={!visionReasoning.efforts.length} onChange={(event) => setEffort(event.target.value)}><option value="">{visionReasoning.efforts.length ? "Choose effort" : "Not available"}</option>{visionReasoning.efforts.map((item) => <option key={item} value={item}>{reasoningDisplayLabel(item, { providerId, modelId: visionModel?.id })}</option>)}</select></label>
        </div>
        <div className="live-session-actions"><Button variant="primary" onClick={() => void configureEyes()}>Use this model as eyes</Button><Button onClick={onClose}>Cancel</Button></div>
      </section> : null}
      {error !== null ? <div className="live-session-error" role="alert"><AlertIcon /><span>{error}</span></div> : null}
      {running ? <button type="button" className="live-session-record-bar" onClick={() => void stop()} aria-label="Stop instant session"><i className="live-session-rec-dot" /><span><strong>Instant session is recording</strong><small>{liveState?.active !== undefined ? `${liveState.active.utteranceCount} utterance${liveState.active.utteranceCount === 1 ? "" : "s"} · ${liveState.active.frameCount} frame${liveState.active.frameCount === 1 ? "" : "s"} · ${liveState.active.droppedFrames} dropped` : "Capturing microphone, screen, and pointer evidence"}</small></span><StopIcon /></button>
        : <button type="button" className="live-session-start" onClick={() => void start()} disabled={!experimental}><MicrophoneIcon /><span><strong>Start instant session</strong><small>Speak to {session.title} with synchronized screen and pointer context</small></span></button>}
      <ol className="live-session-utterances" aria-label="Utterances">
        {[...utterances].reverse().map((item) => <UtteranceRow key={item.id} utterance={item} />)}
      </ol>
      {transcript !== "" && eyesNote !== "" ? <p className="live-session-eyes-note"><strong>Eyes:</strong> {eyesNote}</p> : null}
      <p className="live-session-privacy"><strong>Privacy:</strong> {liveState?.privacy.warning ?? "Microphone, screen, and pointer evidence is sent only with each utterance you speak."} Stop ends all capture immediately. Nothing is retained after the session.</p>
    </div>
  </Modal>;
}

function UtteranceRow({ utterance }: { utterance: UtteranceRecord }) {
  const thumb = utterance.evidence?.frames.find((frame) => frame.kind === "cursor");
  return <li className={`live-session-utterance live-session-utterance-${utterance.status}`}>
    <span className="live-session-utterance-head">
      <b>{new Date(utterance.startedAtWallMs).toLocaleTimeString()}</b>
      {utterance.status === "transcribing" ? <i>Transcribing…</i> : utterance.status === "sending" ? <i>Sending with evidence…</i> : utterance.status === "error" ? <i title={utterance.error ?? "Failed"}>Skipped</i> : <i>{utterance.usedEyes ? "Sent with eyes description" : "Sent with frame evidence"}</i>}
    </span>
    {utterance.transcript !== "" ? <q>{utterance.transcript}</q> : null}
    {thumb !== undefined ? <img className="live-session-utterance-thumb" src={`data:${thumb.mimeType};base64,${thumb.dataBase64}`} alt="Cursor-centred frame evidence" loading="lazy" /> : null}
    {utterance.error !== undefined ? <em>{utterance.error}</em> : null}
  </li>;
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Microphone access was denied. Allow the microphone for Tethoq to use instant sessions.";
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") return "No microphone device was found on this computer.";
  }
  return safeLiveSessionError(error, "Instant session could not access the microphone. Check the microphone settings and try again.");
}

function safeLiveSessionError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^EYES\b/u.test(message)) return message;
  const normalized = message.toLowerCase();
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|api[_ -]?key|credential|auth(?:entication|ori[sz]ation)?)\b/u.test(normalized)) {
    return "EYES could not use the selected model because its API key is missing, invalid, or no longer accepted. Update the key in EYES settings and try again.";
  }
  if (/\b(?:429|quota|rate[_ -]?limit|usage[_ -]?limit|resource[_ -]?exhausted|insufficient (?:balance|credit)|billing)\b/u.test(normalized)) {
    return "EYES could not use the selected model because its usage limit was reached or it is temporarily rate-limited. Check the provider account or choose another EYES model.";
  }
  return fallback;
}
