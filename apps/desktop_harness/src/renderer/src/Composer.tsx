import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { JsonObject } from "../../../../../packages/protocol/src/index";
import type { ScreenCaptureSource, SelectedFile, SelectedImage, VisionProxyStatus, VisionProxyTarget, WorkflowAttachment, WorkflowDescriptor } from "@shared/desktop_api";
import { IconButton, LoadingState, ProviderLogo } from "./components";
import {
  AgentIcon,
  AlertIcon,
  BrowserIcon,
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileIcon,
  MoreIcon,
  PaperclipIcon,
  SearchIcon,
  ScreenshotIcon,
  SendIcon,
  SlidersIcon,
  StopIcon,
  WorkflowIcon,
  XIcon,
} from "./icons";
import type { DesktopSnapshot, ModelOption, Provider, Session, TimelineItem } from "./types";
import {
  appendAttachmentsWithinLimits,
  appendTranscript,
  blobToUploadable,
  chooseTranscriptionSource,
  growTextarea,
  maximumMessageAttachmentBytes,
  resolveComposerModelId,
  uploadAttachments,
  type TranscriptionSource,
} from "./composer_helpers";
import "./composer.css";

type Request = (type: string, payload?: JsonObject) => Promise<Record<string, unknown>>;

export interface DraftSessionSendInput {
  /** Local-only session id, used by App to replace the draft atomically. */
  draftSessionId: string;
  providerId: Session["providerId"];
  workingDirectory: string;
  content: string;
  modelId: string;
  effort: string;
  /** Attachments have already been uploaded; App owns their one-time consumption. */
  attachmentIds: readonly string[];
}

export interface DraftModelSelection {
  providerId: Session["providerId"];
  modelId: string;
  effort: string;
}

export interface ComposerProps {
  snapshot: DesktopSnapshot;
  session: Session;
  request: Request;
  selectImages: () => Promise<readonly SelectedImage[]>;
  preview: boolean;
  notify: (message: string, tone?: "normal" | "error") => void;
  updateSnapshot: (value: DesktopSnapshot | ((current: DesktopSnapshot | null) => DesktopSnapshot | null) | null) => void;
  onBrowser: () => void;
  onManageWorkflow: (id?: string) => void;
  initialDraft: string;
  onDraftChange: (value: string) => void;
  onDerivedSession: (value: Record<string, unknown>, summary?: string, draft?: string) => void;
  /** Mirrors local selection into Session.draft so surrounding UI stays accurate. */
  onDraftSelectionChange?: (selection: DraftModelSelection) => void;
  /** Must perform the sole create/send path and replace the local draft atomically. */
  onCreateDraftSend?: (input: DraftSessionSendInput) => Promise<void>;
  /** Instant sessions are experimental; the entry point is only rendered when true. */
  experimental?: boolean;
  onInstantSession?: () => void;
  /** Incremented only when a queue event arrives; avoids polling the queue. */
  queueRevision?: number;
}

interface PopoverProps {
  label: string;
  className: string;
  children: ReactNode;
  open: boolean;
  onOpen: (open: boolean) => void;
  trigger: React.ReactNode;
}

function Popover({ label, className, children, open, onOpen, trigger }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onOpen(false); };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [onOpen, open]);
  return <div className={`composer-popover-root ${className}`} ref={ref}>
    <button type="button" aria-label={label} title={label} aria-expanded={open} aria-controls={id} aria-haspopup="menu" onClick={() => onOpen(!open)}>{trigger}</button>
    {open ? <div id={id} className="composer-popover" role="menu" aria-label={label}>{children}</div> : null}
  </div>;
}

function ChoiceMenu({ value, label, options, onChange, className = "", triggerDescription }: {
  value: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string; description?: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  className?: string;
  triggerDescription?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  if (!selected) return null;
  return <Popover label={label} className={`composer-choice composer-setting ${className}`} open={open} onOpen={setOpen} trigger={<>{triggerDescription ? <span className="composer-setting-label">{triggerDescription}</span> : null}<span className="composer-setting-value choice-setting-value"><strong>{selected.label}</strong><ChevronDownIcon /></span></>}>
    {options.map((option) => <button type="button" role="menuitemradio" aria-checked={option.value === value} key={option.value} disabled={option.disabled} onClick={() => { onChange(option.value); setOpen(false); }}><span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>{option.value === value ? <CheckIcon /> : null}</button>)}
  </Popover>;
}

export function reasoningLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "default") return "Auto";
  if (normalized === "low") return "Light";
  return value;
}

export function compactComposerModelLabel(value: string, providerId: string): string {
  if (providerId !== "codex") return value;
  const match = value.trim().match(/^GPT[- ]?(\d+(?:\.\d+)*)(?:[- ]+(.+))?$/iu);
  if (!match) return value;
  const suffix = match[2]?.replaceAll("-", " ").replace(/\s+/gu, " ").trim();
  return suffix ? `${match[1]} ${suffix}` : match[1]!;
}

const RECENT_MODELS_KEY = "tethoq:recent-models";

interface CatalogModel {
  readonly key: string;
  readonly provider: Provider;
  readonly model: ModelOption;
}

function storedRecentModels(): readonly string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_MODELS_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

function rememberModel(key: string): readonly string[] {
  const next = [key, ...storedRecentModels().filter((item) => item !== key)].slice(0, 5);
  try { localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next)); }
  catch { /* Preferences may be unavailable in a restricted preview. */ }
  return next;
}

function ModelCatalogResults({ entries, recentKeys, query, activeProviderId, selectedKey, allowProviderChange, onChoose }: {
  entries: readonly CatalogModel[];
  recentKeys: readonly string[];
  query: string;
  activeProviderId: string;
  selectedKey: string | undefined;
  allowProviderChange: boolean;
  onChoose: (entry: CatalogModel) => void;
}) {
  const lowered = query.trim().toLowerCase();
  const visible = entries.filter((entry) => !lowered || `${entry.model.name} ${entry.model.id} ${entry.provider.name} ${entry.model.endpointName ?? ""}`.toLowerCase().includes(lowered));
  const recents = lowered ? [] : recentKeys.map((key) => entries.find((entry) => entry.key === key)).filter((entry): entry is CatalogModel => entry !== undefined);
  const groups = visible.reduce<Array<{ provider: Provider; models: CatalogModel[] }>>((current, entry) => {
    const found = current.find((group) => group.provider.id === entry.provider.id);
    if (found) found.models.push(entry);
    else current.push({ provider: entry.provider, models: [entry] });
    return current;
  }, []).sort((left, right) => left.provider.id === activeProviderId ? -1 : right.provider.id === activeProviderId ? 1 : left.provider.name.localeCompare(right.provider.name));
  const defaultKeys = new Set(entries.reduce<string[]>((keys, entry) => {
    if (keys.some((key) => key.startsWith(`${entry.provider.id}:`))) return keys;
    const providerModels = entries.filter((candidate) => candidate.provider.id === entry.provider.id);
    const providerDefault = providerModels.find((candidate) => candidate.model.isDefault) ?? providerModels[0];
    if (providerDefault) keys.push(providerDefault.key);
    return keys;
  }, []));
  const button = (entry: CatalogModel, recent = false) => {
    const providerReady = entry.provider.state === "online" && entry.provider.capabilities.includes("Create Session") && entry.provider.capabilities.includes("Send Message");
    const selectable = allowProviderChange ? providerReady : entry.provider.id === activeProviderId;
    const selected = entry.key === selectedKey;
    const needsApiKey = entry.model.walletKind === "user_api" && entry.model.apiKeyConfigured === false;
    const caution = entry.model.caution ?? `API key required for ${entry.model.endpointName ?? "this endpoint"}`;
    const providerName = entry.model.endpointName ?? entry.provider.name;
    const unavailableTitle = allowProviderChange ? `${entry.provider.name} is not ready` : `Start or hand off to ${entry.provider.name} to use this model`;
    return <button type="button" className={[needsApiKey ? "needs-api-key" : "", selected ? "selected" : ""].filter(Boolean).join(" ") || undefined} aria-current={selected ? "true" : undefined} key={`${recent ? "recent:" : ""}${entry.key}`} disabled={!selectable} title={selectable ? needsApiKey ? caution : `${entry.model.name} · ${providerName}` : unavailableTitle} onClick={() => onChoose(entry)}>
      <ProviderLogo providerId={entry.provider.id} provider={entry.provider} size={23}/>
      <span><strong>{entry.model.name}</strong>{needsApiKey ? <small className="model-api-caution">{caution}</small> : null}</span>
      <span className="model-row-meta">{defaultKeys.has(entry.key) ? <small>Default</small> : null}{recent ? <time>Recent</time> : !selectable && !allowProviderChange ? <small>New task</small> : null}{selected ? <CheckIcon /> : null}</span>
    </button>;
  };
  return <div className="model-catalog-results">
    {recents.length ? <section><h4>Recent models</h4>{recents.map((entry) => button(entry, true))}</section> : null}
    {groups.map((group) => <section key={group.provider.id} data-provider-group={group.provider.id}><h4><ProviderLogo providerId={group.provider.id} provider={group.provider} size={18}/>{group.provider.name}</h4>{group.models.map((entry) => button(entry))}</section>)}
    {!groups.length ? <div className="model-catalog-empty"><SearchIcon /><strong>No matching models</strong><small>Try a model, provider, or endpoint name.</small></div> : null}
  </div>;
}

function ModelPicker({ snapshot, providerId, sessionModel, value, allowProviderChange = false, onChange }: {
  snapshot: DesktopSnapshot;
  providerId: Session["providerId"];
  sessionModel: string;
  value: string;
  allowProviderChange?: boolean;
  onChange: (providerId: Session["providerId"], modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [recentKeys, setRecentKeys] = useState<readonly string[]>(storedRecentModels);
  const root = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => snapshot.providers.flatMap((provider) => (snapshot.models[provider.id] ?? []).map((model) => ({ key: `${provider.id}:${model.id}`, provider, model }))), [snapshot.models, snapshot.providers]);
  const providerEntries = entries.filter((entry) => entry.provider.id === providerId);
  const defaultEntry = providerEntries.find((entry) => entry.model.isDefault) ?? providerEntries[0];
  const selected = value === "default" ? defaultEntry : providerEntries.find((entry) => entry.model.id === value) ?? defaultEntry;
  const selectedNeedsApiKey = selected?.model.walletKind === "user_api" && selected.model.apiKeyConfigured === false;
  const fallbackModel = sessionModel && sessionModel.toLowerCase() !== "cli default" ? sessionModel : "";
  const label = selected?.model.name ?? (fallbackModel || "Current model");
  const displayLabel = compactComposerModelLabel(label, selected?.provider.id ?? providerId);
  const selectedProvider = selected?.provider ?? snapshot.providers.find((provider) => provider.id === providerId);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);
  const choose = (entry: CatalogModel) => {
    const providerReady = entry.provider.state === "online" && entry.provider.capabilities.includes("Create Session") && entry.provider.capabilities.includes("Send Message");
    if (entry.provider.id !== providerId && (!allowProviderChange || !providerReady)) return;
    onChange(entry.provider.id, entry.model.id);
    setRecentKeys(rememberModel(entry.key));
    setOpen(false);
    setExpanded(false);
  };
  const search = <label className="model-catalog-search"><SearchIcon /><input autoFocus={expanded} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models and providers" aria-label="Search models"/><kbd>Esc</kbd></label>;
  const results = <ModelCatalogResults entries={entries} recentKeys={recentKeys} query={query} activeProviderId={providerId} selectedKey={selected?.key} allowProviderChange={allowProviderChange} onChoose={choose}/>;
  return <div className="model-picker-root composer-setting" ref={root}>
    <button className={`model-picker-trigger ${selectedNeedsApiKey ? "needs-api-key" : ""}`} type="button" aria-label={`Choose model. Current model: ${label}${selectedNeedsApiKey ? ". API key required" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}><span className="composer-setting-label">Model</span><span className="composer-setting-value model-setting-value"><ProviderLogo providerId={providerId} provider={selectedProvider} size={18}/><strong>{displayLabel}</strong>{selectedNeedsApiKey ? <AlertIcon className="model-setting-caution" title="API key required"/> : null}<ChevronDownIcon /></span></button>
    {open ? <section className="model-picker-dropup" role="dialog" aria-label="Choose model"><header><strong>Models</strong><button type="button" aria-label="Open full model browser" title="Open full model browser" onClick={() => { setOpen(false); setExpanded(true); }}><ExternalLinkIcon /></button></header>{search}<div className="model-picker-scroll">{results}</div></section> : null}
    {expanded ? <div className="model-library-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false); }}><section className="model-library" role="dialog" aria-modal="true" aria-label="Model browser"><header><strong>Model browser</strong><button type="button" aria-label="Close model browser" onClick={() => setExpanded(false)}><XIcon /></button></header>{search}<div className="model-library-scroll">{results}</div></section></div> : null}
  </div>;
}

function uploadRequest(request: Request) {
  return (type: string, payload: Record<string, unknown> = {}) => request(type, payload as JsonObject);
}

function toSource(value: unknown): TranscriptionSource | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const capabilities = item.capabilities as Record<string, unknown> | undefined;
  if (typeof item.id !== "string" || typeof item.label !== "string" || (item.status !== "ready" && item.status !== "needs_credential") || typeof item.setupEnvironmentVariable !== "string" || typeof capabilities?.maxAudioBytes !== "number") return null;
  return { id: item.id, label: item.label, status: item.status, setupEnvironmentVariable: item.setupEnvironmentVariable, capabilities: { batch: capabilities.batch === true, maxAudioBytes: capabilities.maxAudioBytes } };
}

function preferredDictationKey(providerId: string): string {
  return `tethoq:dictation-source:${providerId}`;
}

function safeStoredSource(providerId: string): string {
  try { return localStorage.getItem(preferredDictationKey(providerId)) ?? ""; }
  catch { return ""; }
}

function storeSource(providerId: string, sourceId: string): void {
  try { localStorage.setItem(preferredDictationKey(providerId), sourceId); }
  catch { /* Preferences may be unavailable in a restricted preview. */ }
}

function DictationControl({ providerId, request, notify, onTranscript }: {
  providerId: string;
  request: Request;
  notify: ComposerProps["notify"];
  onTranscript: (value: string) => void;
}) {
  const [sources, setSources] = useState<readonly TranscriptionSource[]>([]);
  const [selectedId, setSelectedId] = useState(() => safeStoredSource(providerId));
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    let active = true;
    void request("dictation.source.list").then((payload) => {
      if (!active) return;
      const next = Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : [];
      const chosen = chooseTranscriptionSource(next, safeStoredSource(providerId));
      setSources(next);
      setSelectedId(chosen?.id ?? "");
    }).catch(() => { if (active) setSources([]); });
    return () => {
      active = false;
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [providerId, request]);

  const selected = chooseTranscriptionSource(sources, selectedId);
  const stopTracks = () => { streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; };
  const finish = useCallback(async (blob: Blob, source: TranscriptionSource) => {
    setPhase("transcribing");
    let uploadId = "";
    try {
      const audio = await blobToUploadable(blob);
      if (audio.byteLength > source.capabilities.maxAudioBytes) throw new Error(`${source.label} accepts recordings up to ${Math.round(source.capabilities.maxAudioBytes / 1024 / 1024)} MB.`);
      const [attachmentId] = await uploadAttachments([audio], uploadRequest(request), (id) => { uploadId = id; });
      if (!attachmentId) throw new Error("The dictation recording could not be uploaded.");
      const result = await request("dictation.transcribe", { attachmentId, dictionary: [], sourceId: source.id });
      const transcript = typeof result.text === "string" ? result.text.trim() : "";
      if (!transcript) throw new Error("No speech was detected.");
      onTranscript(transcript);
      notify("Dictation added to your message");
      uploadId = "";
    } catch (error) {
      if (uploadId) await request("attachment.upload.cancel", { uploadId }).catch(() => undefined);
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally { setPhase("idle"); }
  }, [notify, onTranscript, request]);

  const start = async () => {
    if (!selected || selected.status !== "ready") { setSourceMenuOpen(true); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { notify("Microphone dictation is unavailable on this computer.", "error"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => { stopTracks(); setPhase("idle"); notify("Dictation recording failed.", "error"); };
      recorder.onstop = () => {
        stopTracks();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length) void finish(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), selected);
        else { setPhase("idle"); notify("No audio was recorded.", "error"); }
      };
      recorder.start(500);
      setPhase("recording");
    } catch (error) { stopTracks(); notify(error instanceof Error ? error.message : "Microphone permission was not granted.", "error"); }
  };
  const stop = () => { if (recorderRef.current?.state === "recording") recorderRef.current.stop(); };
  const select = (source: TranscriptionSource) => {
    setSelectedId(source.id);
    storeSource(providerId, source.id);
    setSourceMenuOpen(false);
  };

  return <div className={`dictation-control dictation-${phase}`}>
    <button className="dictation-main" type="button" aria-label={phase === "recording" ? "Stop dictation" : phase === "transcribing" ? "Transcribing dictation" : "Start dictation"} title={phase === "recording" ? "Stop dictation" : selected?.status === "ready" ? `Dictate with ${selected.label}` : "Choose a dictation source"} disabled={phase === "transcribing"} onClick={() => phase === "recording" ? stop() : void start()}>{phase === "transcribing" ? <span className="spinner" /> : phase === "recording" ? <StopIcon /> : <MicrophoneIcon />}</button>
    <Popover label="Choose dictation source" className="dictation-source-menu" open={sourceMenuOpen} onOpen={setSourceMenuOpen} trigger={<ChevronDownIcon />}>
      <header><strong>Dictation source</strong><small>Saved separately for {providerId}</small></header>
      {sources.length ? sources.map((source) => <button type="button" role="menuitemradio" aria-checked={source.id === selected?.id} key={source.id} onClick={() => select(source)}><ProviderLogo providerId={source.id.startsWith("xai") ? "grok" : "codex"} size={25}/><span><strong>{source.label}</strong><small>{source.status === "ready" ? "Ready" : `Set ${source.setupEnvironmentVariable} in Bridge`}</small></span>{source.id === selected?.id ? <CheckIcon /> : null}</button>) : <p>No dictation source was reported by Bridge.</p>}
    </Popover>
  </div>;
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></svg>;
}

function ContextHandoffPicker({ session, request, notify, onClose, onComplete }: {
  session: Session;
  request: Request;
  notify: ComposerProps["notify"];
  onClose: () => void;
  onComplete: (sessionValue: Record<string, unknown>, summary: string, draft: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await request("session.context_handoff", { sessionId: session.id });
      const summary = typeof result.summary === "string" ? result.summary.trim() : "";
      const sessionValue = result.session;
      const wordCount = summary ? summary.split(/\s+/u).length : 0;
      if (!sessionValue || typeof sessionValue !== "object" || Array.isArray(sessionValue)) throw new Error("Bridge did not return the handoff task.");
      if (wordCount < 100 || wordCount > 1_000) throw new Error("Bridge returned a context summary outside the 100–1000 word handoff range.");
      onComplete(sessionValue as Record<string, unknown>, summary, prompt);
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return <section className="chat-picker handoff-chat-picker" role="dialog" aria-label="Context Handoff">
    <header><span><strong>Context Handoff</strong><small>Start a clean task with a focused 100–1000-word summary</small></span><button type="button" aria-label="Close context handoff" onClick={onClose}><XIcon /></button></header>
    <div className="handoff-copy"><ChatIcon /><span><strong>What should the new task carry forward?</strong><small>This second chatbox is optional. Tethoq will summarize the current conversation and prefill your focus note in the new composer.</small></span></div>
    <div className="handoff-composer"><textarea ref={textarea} autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder="Optional focus for the new task…" rows={3}/><DictationControl providerId={session.providerId} request={request} notify={notify} onTranscript={(transcript) => { setPrompt((current) => appendTranscript(current, transcript)); requestAnimationFrame(() => textarea.current?.focus()); }}/><button type="button" className="handoff-send" aria-label="Create context handoff" disabled={busy} onClick={() => void submit()}>{busy ? <span className="spinner" /> : <SendIcon />}</button></div>
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={busy} onClick={() => void submit()}>{busy ? <span className="spinner" /> : <ChatIcon />} Create new task</button></footer>
  </section>;
}

interface NormalizedCrop { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

function normalizedPoint(event: ReactPointerEvent, element: HTMLElement): { x: number; y: number } {
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
  };
}

async function cropScreenSource(source: ScreenCaptureSource, crop: NormalizedCrop): Promise<SelectedImage> {
  const image = new Image();
  image.src = source.dataUrl;
  await image.decode();
  const x = Math.max(0, Math.min(image.naturalWidth - 1, Math.round(crop.x * image.naturalWidth)));
  const y = Math.max(0, Math.min(image.naturalHeight - 1, Math.round(crop.y * image.naturalHeight)));
  const width = Math.max(1, Math.min(image.naturalWidth - x, Math.round(crop.width * image.naturalWidth)));
  const height = Math.max(1, Math.min(image.naturalHeight - y, Math.round(crop.height * image.naturalHeight)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Screen capture could not be prepared.");
  context.drawImage(image, x, y, width, height, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Screen capture could not be encoded.")), "image/png"));
  const uploadable = await blobToUploadable(blob, `screen-region-${Date.now()}.png`);
  return { ...uploadable, path: `screen-capture:${source.id}:${Date.now()}` };
}

function ScreenRegionPicker({ notify, onClose, onChoose }: { notify: ComposerProps["notify"]; onClose: () => void; onChoose: (image: SelectedImage) => boolean }) {
  const [sources, setSources] = useState<readonly ScreenCaptureSource[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [selection, setSelection] = useState<NormalizedCrop | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    void window.tethoqDesktop.captureScreens().then((items) => {
      if (!active) return;
      setSources(items);
      setSourceId(items[0]?.id ?? "");
    }).catch((error: unknown) => { if (active) notify(error instanceof Error ? error.message : String(error), "error"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notify]);
  const source = sources.find((item) => item.id === sourceId) ?? sources[0];
  const updateSelection = (point: { x: number; y: number }) => {
    if (!start.current) return;
    const left = Math.min(start.current.x, point.x);
    const top = Math.min(start.current.y, point.y);
    setSelection({ x: left, y: top, width: Math.abs(point.x - start.current.x), height: Math.abs(point.y - start.current.y) });
  };
  const finish = async () => {
    if (!source || !selection || selection.width < .005 || selection.height < .005 || preparing) return;
    setPreparing(true);
    try {
      const image = await cropScreenSource(source, selection);
      if (image.byteLength > 25 * 1024 * 1024) throw new Error("The selected screen region is larger than 25 MiB.");
      if (onChoose(image)) notify("Screen region attached");
      onClose();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setPreparing(false);
    }
  };
  return <div className="screen-capture-backdrop" role="presentation"><section className="screen-capture-picker" role="dialog" aria-modal="true" aria-label="Capture a screen region">
    <header><span><strong>Capture screen region</strong><small>Drag over the exact area to attach. Nothing is sent until you submit the message.</small></span><button type="button" aria-label="Close screen capture" onClick={onClose}><XIcon /></button></header>
    {sources.length > 1 ? <label className="screen-source-select"><span>Screen</span><select value={sourceId} onChange={(event) => { setSourceId(event.target.value); setSelection(null); }}>{sources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
    <div className="screen-capture-stage">{loading ? <LoadingState label="Capturing screens" /> : source ? <div className="screen-capture-frame" ref={frame} onPointerDown={(event) => { const point = normalizedPoint(event, event.currentTarget); start.current = point; setSelection({ ...point, width: 0, height: 0 }); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => updateSelection(normalizedPoint(event, event.currentTarget))} onPointerUp={(event) => { updateSelection(normalizedPoint(event, event.currentTarget)); start.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}><img src={source.dataUrl} alt={source.name} draggable={false}/>{selection ? <i className="screen-capture-selection" style={{ left: `${selection.x * 100}%`, top: `${selection.y * 100}%`, width: `${selection.width * 100}%`, height: `${selection.height * 100}%` }} /> : null}</div> : <div className="chat-picker-empty"><strong>No screen is available</strong><small>Desktop capture may be blocked by your operating-system privacy settings.</small></div>}</div>
    <footer><small>{selection ? `${Math.round(selection.width * (source?.width ?? 0))} × ${Math.round(selection.height * (source?.height ?? 0))} px` : "Drag to select a region"}</small><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={!selection || selection.width < .005 || selection.height < .005 || preparing} onClick={() => void finish()}>{preparing ? <span className="spinner" /> : <ScreenshotIcon />} Attach region</button></footer>
  </section></div>;
}

function WorkflowPicker({ selected, preview, onClose, onChoose, onManageWorkflow }: {
  selected: readonly string[];
  preview: boolean;
  onClose: () => void;
  onChoose: (attachment: WorkflowAttachment) => void;
  onManageWorkflow: (id?: string) => void;
}) {
  const [items, setItems] = useState<readonly WorkflowDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (preview) { setLoading(false); return; }
    void window.tethoqDesktop.recorderAction({ type: "list" }).then((value) => { if (Array.isArray(value)) setItems(value as WorkflowDescriptor[]); }).finally(() => setLoading(false));
  }, [preview]);
  return <section className="chat-picker workflow-chat-picker" role="dialog" aria-label="Choose a recorded workflow">
    <header><span><strong>Recorded workflows</strong><small>Attach local visual and action context</small></span><button type="button" aria-label="Close workflows" onClick={onClose}><XIcon /></button></header>
    <div>{loading ? <LoadingState label="Loading workflows" /> : items.length ? items.map((item) => <button type="button" key={item.id} disabled={selected.includes(item.id)} onClick={async () => { const value = await window.tethoqDesktop.recorderAction({ type: "attachment", id: item.id }); if (value && !Array.isArray(value) && "promptReference" in value) onChoose(value as WorkflowAttachment); }}><WorkflowIcon /><span><strong>{item.name ?? "Unnamed workflow"}</strong><small>{item.summary.eventCount} events · {item.summary.screenshotCount} frames</small></span>{selected.includes(item.id) ? <CheckIcon /> : <ChevronRightIcon />}</button>) : <div className="chat-picker-empty"><strong>No workflows saved</strong><small>Record and inspect workflows in Settings.</small></div>}</div>
    <footer><button type="button" onClick={() => onManageWorkflow()}>Manage workflows <ChevronRightIcon /></button></footer>
  </section>;
}

function DelegationPicker({ snapshot, session, request, onClose, notify }: {
  snapshot: DesktopSnapshot;
  session: Session;
  request: Request;
  onClose: () => void;
  notify: ComposerProps["notify"];
}) {
  const options = snapshot.providers.filter((provider) => provider.id !== session.providerId && provider.state === "online" && provider.capabilities.includes("Create Session") && provider.capabilities.includes("Send Message"));
  const [selected, setSelected] = useState<Session["providerId"][]>(options[0] ? [options[0].id] : []);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  return <section className="chat-picker delegation-chat-picker" role="dialog" aria-label="Delegate task">
    <header><span><strong>Delegate a task</strong><small>Create grouped child sessions with another coding tool</small></span><button type="button" aria-label="Close delegation" onClick={onClose}><XIcon /></button></header>
    <div className="delegation-cli-options">{options.map((provider) => <button type="button" key={provider.id} className={selected.includes(provider.id) ? "selected" : ""} aria-pressed={selected.includes(provider.id)} onClick={() => setSelected((current) => current.includes(provider.id) ? current.filter((id) => id !== provider.id) : current.length < 4 ? [...current, provider.id] : current)}><ProviderLogo providerId={provider.id} provider={provider} size={27}/><span><strong>{provider.name}</strong><small>New child task</small></span>{selected.includes(provider.id) ? <CheckIcon /> : null}</button>)}</div>
    {options.length ? <textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="What should the delegated coding tool own?" rows={3}/> : <div className="chat-picker-empty"><strong>No other coding tool is ready</strong><small>Connect another tool before delegating.</small></div>}
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={!prompt.trim() || !selected.length || busy} onClick={async () => { setBusy(true); try { await request("delegation.start", { parentSessionId: session.id, prompt: prompt.trim(), targets: selected.map((providerId) => ({ providerId })) }); notify("Delegated tasks started"); onClose(); } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } }}><AgentIcon /> Delegate</button></footer>
  </section>;
}

function providerFor(providers: readonly Provider[], id: string): Provider | undefined {
  return providers.find((provider) => provider.id === id);
}

type SelectedComposerAttachment = SelectedImage | SelectedFile;

function isSelectedFile(attachment: SelectedComposerAttachment): attachment is SelectedFile {
  return "kind" in attachment && attachment.kind === "file";
}

export function supportsGenericFileAttachments(providerId: string): boolean {
  return providerId === "opencode";
}

const PROMPT_HISTORY_KEY = "tethoq:prompt-history";
const MAX_PROMPT_HISTORY_ITEMS = 50;
const MAX_PROMPT_HISTORY_ENTRY_CHARS = 20_000;
const MAX_PROMPT_HISTORY_TOTAL_CHARS = 100_000;

export function boundedPromptHistory(values: readonly unknown[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  for (const value of values) {
    if (typeof value !== "string" || !value || value.length > MAX_PROMPT_HISTORY_ENTRY_CHARS || seen.has(value)) continue;
    if (result.length >= MAX_PROMPT_HISTORY_ITEMS || totalChars + value.length > MAX_PROMPT_HISTORY_TOTAL_CHARS) break;
    result.push(value);
    seen.add(value);
    totalChars += value.length;
  }
  return result;
}

function storedPromptHistory(): readonly string[] {
  try {
    if (typeof globalThis.localStorage === "undefined") return [];
    const value = JSON.parse(globalThis.localStorage.getItem(PROMPT_HISTORY_KEY) ?? "[]") as unknown;
    return boundedPromptHistory(Array.isArray(value) ? value : []);
  } catch {
    return [];
  }
}

function rememberPrompt(prompt: string, current: readonly string[]): readonly string[] {
  const next = boundedPromptHistory([prompt, ...current]);
  try { globalThis.localStorage?.setItem(PROMPT_HISTORY_KEY, JSON.stringify(next)); }
  catch { /* Prompt history is optional in restricted renderer contexts. */ }
  return next;
}

interface QueuedMessageView {
  readonly id: string;
  readonly content: string;
  readonly state: "queued" | "sending" | "failed";
  readonly attachmentCount: number;
}

export function queuedMessagesForSession(value: unknown, sessionId: string): readonly QueuedMessageView[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const message = candidate as Record<string, unknown>;
    if (typeof message.id !== "string" || message.sessionId !== sessionId || typeof message.content !== "string") return [];
    if (message.state !== "queued" && message.state !== "sending" && message.state !== "failed") return [];
    return [{
      id: message.id,
      content: message.content,
      state: message.state,
      attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
    }];
  });
}

export function queuedMessagePreview(content: string): string {
  const preview = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(0, 2).join(" · ");
  if (!preview) return "Queued instruction";
  return preview.length > 180 ? `${preview.slice(0, 177).trimEnd()}…` : preview;
}

type VisualAction = "browser" | "workflow";

function visionReasoningEfforts(model: VisionProxyTarget["models"][number] | undefined): readonly string[] {
  if (!model) return ["Default"];
  const metadata = model.nativeMetadata as Record<string, unknown>;
  const raw = metadata.supportedReasoningEfforts ?? metadata.reasoningEfforts ?? metadata.supported_reasoning_efforts;
  if (!Array.isArray(raw)) return ["Default"];
  const values = raw.map((value) => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const item = value as Record<string, unknown>;
    return typeof item.reasoningEffort === "string" ? item.reasoningEffort : typeof item.id === "string" ? item.id : "";
  }).filter(Boolean);
  return values.length ? values : ["Default"];
}

function VisionEyesPicker({ session, request, action, onClose, onReady, notify }: {
  session: Session;
  request: Request;
  action: VisualAction;
  onClose: () => void;
  onReady: (action: VisualAction) => void;
  notify: ComposerProps["notify"];
}) {
  const [targets, setTargets] = useState<readonly VisionProxyTarget[]>([]);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("Default");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void request("vision.targets", {}).then((payload) => {
      if (!active) return;
      const next = Array.isArray(payload.targets) ? payload.targets as unknown as VisionProxyTarget[] : [];
      const usable = next.filter((target) => typeof target.providerId === "string" && Array.isArray(target.models) && target.models.length > 0);
      const firstTarget = usable[0];
      const firstModel = firstTarget?.models.find((model) => model.isDefault) ?? firstTarget?.models[0];
      setTargets(usable);
      setProviderId(firstTarget?.providerId ?? "");
      setModelId(firstModel?.id ?? "");
      setEffort(visionReasoningEfforts(firstModel)[0] ?? "Default");
    }).catch((error) => {
      if (active) notify(error instanceof Error ? error.message : String(error), "error");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [notify, request]);

  const target = targets.find((item) => item.providerId === providerId);
  const selectedModel = target?.models.find((item) => item.id === modelId);
  const efforts = visionReasoningEfforts(selectedModel);
  const configure = async () => {
    if (!providerId || !modelId || saving) return;
    setSaving(true);
    const selection: JsonObject = { providerId, modelId, ...(effort !== "Default" ? { reasoningEffort: effort } : {}) };
    try {
      await request("session.vision.configure", { sessionId: session.id, selection });
      onReady(action);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      setSaving(false);
    }
  };

  return <section className="chat-picker vision-eyes-picker" role="dialog" aria-label="Choose a vision model">
    <header><span><strong>Choose a model as eyes</strong><small>This text-only session needs visual support for {action === "browser" ? "the browser" : "recorded workflows"}.</small></span><button type="button" aria-label="Close vision model selection" onClick={onClose}><XIcon /></button></header>
    {loading ? <div><LoadingState label="Loading vision models" /></div> : targets.length ? <div className="vision-picker-fields">
      <label><span>Provider</span><select aria-label="Vision provider" value={providerId} onChange={(event) => { const nextTarget = targets.find((item) => item.providerId === event.target.value); const nextModel = nextTarget?.models.find((item) => item.isDefault) ?? nextTarget?.models[0]; setProviderId(event.target.value); setModelId(nextModel?.id ?? ""); setEffort(visionReasoningEfforts(nextModel)[0] ?? "Default"); }}>{targets.map((item) => <option key={item.providerId} value={item.providerId}>{item.displayName}</option>)}</select></label>
      <label><span>Model</span><select aria-label="Vision model" value={modelId} onChange={(event) => { const nextModel = target?.models.find((item) => item.id === event.target.value); setModelId(event.target.value); setEffort(visionReasoningEfforts(nextModel)[0] ?? "Default"); }}>{target?.models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      <label><span>Reasoning</span><select aria-label="Vision reasoning effort" value={effort} onChange={(event) => setEffort(event.target.value)}>{efforts.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    </div> : <div className="chat-picker-empty"><strong>No image-capable model is ready</strong><small>Connect one in Settings, then try again.</small></div>}
    <footer><button type="button" onClick={onClose}>Not now</button><button className="primary" type="button" disabled={loading || !providerId || !modelId || saving} onClick={() => void configure()}>{saving ? <span className="spinner" /> : <CheckIcon />} Use as eyes</button></footer>
  </section>;
}

export function Composer({ snapshot, session, request, selectImages, preview, notify, updateSnapshot, onBrowser, onManageWorkflow, initialDraft, onDraftChange, onDerivedSession, onDraftSelectionChange, onCreateDraftSend, experimental, onInstantSession, queueRevision = 0 }: ComposerProps) {
  const [content, setContent] = useState(initialDraft);
  const draftChangeRef = useRef(onDraftChange);
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const draftSession = session.draft === true;
  const [providerId, setProviderId] = useState(session.providerId);
  const models = snapshot.models[providerId] ?? [];
  const [model, setModel] = useState(() => {
    const resolved = resolveComposerModelId(models, session.model);
    return resolved === "default" ? models.find((item) => item.isDefault)?.id ?? models[0]?.id ?? "default" : resolved;
  });
  const [effort, setEffort] = useState(session.effort || "Default");
  const [attachments, setAttachments] = useState<readonly SelectedComposerAttachment[]>([]);
  const [workflowAttachments, setWorkflowAttachments] = useState<readonly WorkflowAttachment[]>([]);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
  const [visionAction, setVisionAction] = useState<VisualAction | null>(null);
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<SelectedImage | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<readonly QueuedMessageView[]>([]);
  const [cancellingQueuedId, setCancellingQueuedId] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const promptHistory = useRef<readonly string[]>(storedPromptHistory());
  const historyIndex = useRef<number | null>(null);
  const unsentHistoryDraft = useRef(initialDraft);
  const chosenModel = models.find((item) => item.id === model);
  const efforts = chosenModel?.efforts ?? ["Default"];
  const provider = providerFor(snapshot.providers, providerId);
  const canSend = provider?.state === "online" && provider.capabilities.includes("Send Message") && (!draftSession || provider.capabilities.includes("Create Session") && onCreateDraftSend !== undefined);
  const canSteer = !draftSession && canSend && session.state === "working" && provider.capabilities.includes("Steering");
  const canAttach = canSend && provider?.supportsAttachments === true;
  const canAttachFiles = canSend && provider?.supportsAttachments === true && supportsGenericFileAttachments(providerId);
  const canDelegate = snapshot.providers.some((item) => item.id !== session.providerId && item.state === "online" && item.capabilities.includes("Create Session") && item.capabilities.includes("Send Message"));

  const loadQueuedMessages = useCallback(async () => {
    if (draftSession) { setQueuedMessages([]); return; }
    try {
      const result = await request("message_queue.list", { sessionId: session.id });
      setQueuedMessages(queuedMessagesForSession(result, session.id));
    } catch {
      // Queue visibility is opportunistic; send failures still surface through the normal composer notice.
    }
  }, [draftSession, request, session.id]);

  useEffect(() => { if (mode === "steer" && !canSteer) setMode("queue"); }, [canSteer, mode]);
  useEffect(() => {
    if (model !== "default" || models.length === 0) return;
    const nextModel = models.find((item) => item.isDefault) ?? models[0]!;
    const nextEffort = nextModel.efforts[0] ?? "Default";
    setModel(nextModel.id);
    setEffort(nextEffort);
    if (draftSession) onDraftSelectionChange?.({ providerId, modelId: nextModel.id, effort: nextEffort });
  }, [draftSession, model, models, onDraftSelectionChange, providerId]);
  useEffect(() => { if (textarea.current) growTextarea(textarea.current); }, [content]);
  useEffect(() => { draftChangeRef.current = onDraftChange; }, [onDraftChange]);
  useEffect(() => { draftChangeRef.current(content); }, [content]);
  useEffect(() => { void loadQueuedMessages(); }, [loadQueuedMessages, queueRevision]);
  useEffect(() => {
    if (!attachmentPreview) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setAttachmentPreview(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [attachmentPreview]);

  const addImages = useCallback((images: readonly SelectedImage[]) => {
    const next = appendAttachmentsWithinLimits(attachments, images);
    setAttachments(next.items);
    if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
    else if (next.rejectedForCount) notify("You can attach up to four items per message.", "error");
    return next;
  }, [attachments, notify]);

  const addFiles = useCallback((files: readonly SelectedFile[]) => {
    const next = appendAttachmentsWithinLimits(attachments, files);
    setAttachments(next.items);
    if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
    else if (next.rejectedForCount) notify("You can attach up to four items per message.", "error");
    return next;
  }, [attachments, notify]);

  const onPaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (!canAttach) { notify(`${provider?.name ?? "This coding tool"} does not support image attachments.`, "error"); return; }
    try {
      const images = await Promise.all(files.slice(0, 4).map(async (file, index) => {
        if (file.size <= 0 || file.size > 25 * 1024 * 1024) throw new Error("Pasted images must be between 1 byte and 25 MiB.");
        const uploadable = await blobToUploadable(file, file.name || `pasted-image-${index + 1}.png`);
        return { ...uploadable, path: `clipboard:${Date.now()}:${index}` } satisfies SelectedImage;
      }));
      const added = addImages(images);
      if (added.acceptedCount > 0 && !added.rejectedForBytes && !added.rejectedForCount) notify(added.acceptedCount === 1 ? "Pasted image attached" : `${added.acceptedCount} pasted images attached`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const submit = async () => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    setSending(true);
    const pendingUploadIds: string[] = [];
    try {
      if (!canSend) throw new Error(`${provider?.name ?? "This coding tool"} cannot accept messages right now.`);
      const imageAttachments = attachments.filter((attachment): attachment is SelectedImage => !isSelectedFile(attachment));
      const fileAttachments = attachments.filter(isSelectedFile);
      if (imageAttachments.length && !canAttach) throw new Error(`${provider?.name ?? "This coding tool"} does not support image attachments.`);
      if (fileAttachments.length && !canAttachFiles) throw new Error("Generic file attachments are available only for OpenCode.");
      if (attachments.length > 4) throw new Error("You can attach up to four items per message.");
      if (attachments.some((attachment) => attachment.byteLength <= 0 || attachment.byteLength > 25 * 1024 * 1024)) throw new Error("Attachments must be between 1 byte and 25 MiB each.");
      if (attachments.reduce((total, attachment) => total + attachment.byteLength, 0) > maximumMessageAttachmentBytes) throw new Error("Attachments can total up to 50 MiB per message.");
      const attachmentIds = attachments.length ? await uploadAttachments(attachments, uploadRequest(request), (id) => pendingUploadIds.push(id)) : [];
      const workflowContext = workflowAttachments.length ? `\n\nRecorded workflow context:\n${workflowAttachments.map((workflow) => `- ${workflow.promptReference}; ${workflow.summary.eventCount} events, ${workflow.summary.screenshotCount} screenshots`).join("\n")}` : "";
      const messageContent = `${trimmed}${workflowContext}`;
      let sentLabel = "Instruction sent";
      if (draftSession) {
        if (!onCreateDraftSend) throw new Error("This local draft cannot be created right now.");
        await onCreateDraftSend({
          draftSessionId: session.id,
          providerId,
          workingDirectory: session.workingDirectory,
          content: messageContent,
          modelId: model,
          effort,
          attachmentIds,
        });
        sentLabel = "Task started";
      } else {
        const payload: JsonObject = {
          sessionId: session.id,
          content: messageContent,
          ...(model !== "default" ? { modelId: model } : {}),
          ...(effort !== "Default" ? { reasoningEffort: effort.toLowerCase() } : {}),
          ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}),
        };
        const blockedByAttention = session.state === "working" || session.state === "needs_approval" || session.state === "needs_input";
        const requestType = mode === "steer" ? "session.steer_message" : attachments.length || blockedByAttention ? "message_queue.enqueue" : "session.send_message";
        await request(requestType, payload);
        if (requestType === "message_queue.enqueue") await loadQueuedMessages();
        const optimisticNotes = [
          ...workflowAttachments.map((workflow) => `Attached workflow: ${workflow.name}`),
          ...fileAttachments.map((attachment) => `Attached file: ${attachment.name}`),
        ];
        if (requestType !== "message_queue.enqueue") {
          const optimistic: TimelineItem = { id: `local-${Date.now()}`, kind: "user", body: optimisticNotes.length ? `${trimmed}\n\n${optimisticNotes.join("\n")}` : trimmed, ...(imageAttachments.length ? { images: imageAttachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}` })) } : {}), timestamp: new Date().toISOString(), state: "completed" };
          updateSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [session.id]: [...(current.timelines[session.id] ?? []), optimistic] }, sessions: current.sessions.map((item) => item.id === session.id ? { ...item, state: "working", preview: trimmed, updatedAt: optimistic.timestamp } : item) } : current);
        }
        sentLabel = mode === "steer" ? "Task steered" : requestType === "message_queue.enqueue" ? "Instruction queued" : "Instruction sent";
      }
      pendingUploadIds.length = 0;
      promptHistory.current = rememberPrompt(trimmed, promptHistory.current);
      historyIndex.current = null;
      unsentHistoryDraft.current = "";
      setContent(""); setAttachments([]); setAttachmentPreview(null); setWorkflowAttachments([]);
      notify(sentLabel);
    } catch (error) {
      await Promise.all(pendingUploadIds.map((uploadId) => request("attachment.upload.cancel", { uploadId }).catch(() => undefined)));
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally { setSending(false); textarea.current?.focus(); }
  };
  const cancelQueuedMessage = async (messageId: string) => {
    if (cancellingQueuedId) return;
    setCancellingQueuedId(messageId);
    try {
      const result = await request("message_queue.cancel", { messageId });
      if (result.cancelled !== true) notify("That queued instruction is already being sent.", "error");
      else notify("Queued instruction cancelled");
      await loadQueuedMessages();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setCancellingQueuedId(null);
    }
  };
  const showHistoryEntry = (value: string, caret: "start" | "end") => {
    setContent(value);
    requestAnimationFrame(() => {
      const target = textarea.current;
      if (!target) return;
      const position = caret === "start" ? 0 : target.value.length;
      target.setSelectionRange(position, position);
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); return; }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
    const atEnd = event.currentTarget.selectionStart === event.currentTarget.value.length && event.currentTarget.selectionEnd === event.currentTarget.value.length;
    if (event.key === "ArrowUp" && atStart && promptHistory.current.length) {
      event.preventDefault();
      if (historyIndex.current === null) unsentHistoryDraft.current = content;
      const nextIndex = Math.min(promptHistory.current.length - 1, (historyIndex.current ?? -1) + 1);
      historyIndex.current = nextIndex;
      showHistoryEntry(promptHistory.current[nextIndex]!, "start");
    } else if (event.key === "ArrowDown" && atEnd && historyIndex.current !== null) {
      event.preventDefault();
      if (historyIndex.current === 0) {
        historyIndex.current = null;
        showHistoryEntry(unsentHistoryDraft.current, "end");
      } else {
        historyIndex.current -= 1;
        showHistoryEntry(promptHistory.current[historyIndex.current]!, "end");
      }
    }
  };
  const selectComposerModel = (nextProviderId: Session["providerId"], nextModelId: string) => {
    const nextModels = snapshot.models[nextProviderId] ?? [];
    const nextModel = nextModels.find((item) => item.id === nextModelId);
    const nextEffort = nextModel?.efforts[0] ?? "Default";
    if (!supportsGenericFileAttachments(nextProviderId) && attachments.some(isSelectedFile)) {
      setAttachments((current) => current.filter((attachment) => !isSelectedFile(attachment)));
      notify("OpenCode file attachments were removed for this coding tool.");
    }
    setProviderId(nextProviderId);
    setModel(nextModelId);
    setEffort(nextEffort);
    if (draftSession) onDraftSelectionChange?.({ providerId: nextProviderId, modelId: nextModelId, effort: nextEffort });
  };
  const selectComposerEffort = (nextEffort: string) => {
    setEffort(nextEffort);
    if (draftSession) onDraftSelectionChange?.({ providerId, modelId: model, effort: nextEffort });
  };
  const continueVisualAction = (action: VisualAction) => {
    setVisionAction(null);
    if (action === "workflow") setWorkflowPickerOpen(true);
    else onBrowser();
  };
  const openVisualAction = async (action: VisualAction) => {
    setActionsOpen(false);
    try {
      const result = await request("session.vision.get", { sessionId: session.id });
      const status = result.vision as unknown as VisionProxyStatus | undefined;
      if (!status || (status.primaryModelSupportsImageInput !== null && typeof status.primaryModelSupportsImageInput !== "boolean")) throw new Error("Bridge returned an invalid visual-support status.");
      if (status.primaryModelSupportsImageInput === false && status.configured === null) setVisionAction(action);
      else continueVisualAction(action);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
  };
  const branchSession = async () => {
    if (deriving) return;
    setActionsOpen(false);
    setDeriving(true);
    try {
      const result = await request("session.branch", { sessionId: session.id });
      if (!result.session || typeof result.session !== "object" || Array.isArray(result.session)) throw new Error("Bridge did not return the branched task.");
      onDerivedSession(result.session as Record<string, unknown>);
      notify(`Branched in a new task${typeof result.copiedMessageCount === "number" ? ` with ${result.copiedMessageCount} copied messages` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setDeriving(false);
    }
  };
  const actions = <>
    <button type="button" role="menuitem" disabled={!canAttach} onClick={async () => { setActionsOpen(false); const selected = await selectImages(); addImages(selected); }}><PaperclipIcon /><span><strong>Attach image</strong><small>{canAttach ? "Choose up to four images" : "Unavailable for this coding tool"}</small></span></button>
    {supportsGenericFileAttachments(providerId) ? <button type="button" role="menuitem" disabled={!canAttachFiles || preview} onClick={async () => {
      setActionsOpen(false);
      try {
        const selected = await window.tethoqDesktop.selectFiles(providerId);
        const added = addFiles(selected);
        if (added.acceptedCount > 0 && !added.rejectedForBytes && !added.rejectedForCount) notify(added.acceptedCount === 1 ? "File attached" : `${added.acceptedCount} files attached`);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }}><FileIcon /><span><strong>Attach file</strong><small>{canAttachFiles ? "Four attachments total · 25 MiB each" : "OpenCode is unavailable"}</small></span></button> : null}
    <button type="button" role="menuitem" disabled={!canAttach || preview} onClick={() => { setActionsOpen(false); setCaptureOpen(true); }}><ScreenshotIcon /><span><strong>Capture screen region</strong><small>{canAttach ? "Drag, crop, and attach automatically" : "Unavailable for this coding tool"}</small></span></button>
    {!draftSession ? <><button type="button" role="menuitem" disabled={deriving} onClick={() => { setActionsOpen(false); setHandoffOpen(true); }}><ChatIcon /><span><strong>Context Handoff</strong><small>Clean task with a concise working summary</small></span></button>
    <button type="button" role="menuitem" disabled={deriving} onClick={() => void branchSession()}><BranchIcon /><span><strong>Branch in New Task</strong><small>Continue from this exact conversation</small></span>{deriving ? <span className="spinner" /> : null}</button></> : null}
    <button type="button" role="menuitem" onClick={() => { if (draftSession) { setActionsOpen(false); setWorkflowPickerOpen(true); } else void openVisualAction("workflow"); }}><WorkflowIcon /><span><strong>Attach workflow</strong><small>Use recorded local context</small></span></button>
    {!draftSession ? <><button type="button" role="menuitem" onClick={() => void openVisualAction("browser")}><BrowserIcon /><span><strong>Open session browser</strong><small>Persistent, app-owned Chromium</small></span></button>
    <button type="button" role="menuitem" disabled={!canDelegate} onClick={() => { setActionsOpen(false); setDelegationOpen(true); }}><AgentIcon /><span><strong>Delegate task</strong><small>Start grouped child sessions</small></span></button>
    <button type="button" role="menuitem" onClick={() => { setMode(mode === "queue" && canSteer ? "steer" : "queue"); setActionsOpen(false); }}><SendIcon /><span><strong>Send behavior: {mode === "steer" ? "Steer" : "Queue"}</strong><small>{canSteer ? "Switch between next-up and live guidance" : "Instructions run next"}</small></span><CheckIcon /></button></> : null}
    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onManageWorkflow(); }}><SlidersIcon /><span><strong>Manage workflows</strong><small>Review recordings in Settings</small></span></button>
    {experimental && onInstantSession && !draftSession ? <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onInstantSession(); }}><MicrophoneIcon /><span><strong>Instant session</strong><small>Speak with synchronized screen and pointer evidence</small></span></button> : null}
  </>;

  return <div className="composer-wrap">
    {workflowPickerOpen ? <WorkflowPicker selected={workflowAttachments.map((item) => item.id)} preview={preview} onClose={() => setWorkflowPickerOpen(false)} onChoose={(attachment) => { setWorkflowAttachments((current) => [...current.filter((item) => item.id !== attachment.id), attachment]); setWorkflowPickerOpen(false); }} onManageWorkflow={onManageWorkflow} /> : null}
    {visionAction ? <VisionEyesPicker key={`${session.id}:${visionAction}`} session={session} request={request} action={visionAction} notify={notify} onClose={() => setVisionAction(null)} onReady={continueVisualAction} /> : null}
    {delegationOpen ? <DelegationPicker snapshot={snapshot} session={session} request={request} notify={notify} onClose={() => setDelegationOpen(false)} /> : null}
    {handoffOpen ? <ContextHandoffPicker session={session} request={request} notify={notify} onClose={() => setHandoffOpen(false)} onComplete={(value, summary, draft) => onDerivedSession(value, summary, draft)} /> : null}
    {captureOpen && !preview ? <ScreenRegionPicker notify={notify} onClose={() => setCaptureOpen(false)} onChoose={(image) => addImages([image]).acceptedCount > 0} /> : null}
    {attachmentPreview ? <div className="image-lightbox composer-image-lightbox" role="dialog" aria-modal="true" aria-label={`Preview ${attachmentPreview.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setAttachmentPreview(null); }}><button type="button" aria-label="Close attachment preview" onClick={() => setAttachmentPreview(null)}><XIcon /></button><figure><img src={`data:${attachmentPreview.mimeType};base64,${attachmentPreview.dataBase64}`} alt={attachmentPreview.name} referrerPolicy="no-referrer"/><figcaption>{attachmentPreview.name}</figcaption></figure></div> : null}
    {queuedMessages.length ? <details className="queued-next">
      <summary><span><strong>Queued next</strong><small>{queuedMessages.length} instruction{queuedMessages.length === 1 ? "" : "s"}</small></span><ChevronDownIcon /></summary>
      <div>{queuedMessages.map((message) => <article key={message.id}><span><strong>{queuedMessagePreview(message.content)}</strong><small>{message.state}{message.attachmentCount ? ` · ${message.attachmentCount} attachment${message.attachmentCount === 1 ? "" : "s"}` : ""}</small></span><button type="button" aria-label="Cancel queued instruction" title="Cancel queued instruction" disabled={message.state === "sending" || cancellingQueuedId === message.id} onClick={() => void cancelQueuedMessage(message.id)}>{cancellingQueuedId === message.id ? <span className="spinner" /> : <XIcon />}</button></article>)}</div>
    </details> : null}
    {attachments.length || workflowAttachments.length ? <div className="attachment-chips">
      {attachments.map((attachment) => isSelectedFile(attachment)
        ? <span className="file-attachment-chip" key={attachment.path}><FileIcon /><span><strong>{attachment.name}</strong><small>{Math.ceil(attachment.byteLength / 1024)} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}><XIcon /></button></span>
        : <span className="image-attachment-chip" key={attachment.path}><button type="button" className="attachment-thumbnail" title={`Preview ${attachment.name}`} aria-label={`Preview ${attachment.name}`} onClick={() => setAttachmentPreview(attachment)}><img src={`data:${attachment.mimeType};base64,${attachment.dataBase64}`} alt=""/></button><span><strong>{attachment.name}</strong><small>{Math.ceil(attachment.byteLength / 1024)} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}><XIcon /></button></span>)}
      {workflowAttachments.map((attachment) => <span className="workflow-attachment-chip" key={attachment.id}><button type="button" className="workflow-chip-link" title="View workflow details" onClick={() => onManageWorkflow(attachment.id)}><WorkflowIcon /><span><strong>{attachment.name}</strong><small>Recorded workflow</small></span></button><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setWorkflowAttachments((current) => current.filter((item) => item.id !== attachment.id))}><XIcon /></button></span>)}
    </div> : null}
    <div className="composer-box">
      <div className="composer-footer" aria-label="Message options">
        <ModelPicker snapshot={snapshot} providerId={providerId} sessionModel={providerId === session.providerId ? session.model : ""} value={model} allowProviderChange={draftSession} onChange={selectComposerModel} />
        <ChoiceMenu value={effort} options={efforts.map((item) => ({ value: item, label: reasoningLabel(item) }))} onChange={selectComposerEffort} label="Choose reasoning effort" className="effort-choice" triggerDescription="Reasoning" />
      </div>
      <textarea ref={textarea} value={content} onChange={(event) => { historyIndex.current = null; unsentHistoryDraft.current = event.target.value; setContent(event.target.value); }} onPaste={(event) => void onPaste(event)} onKeyDown={onKeyDown} placeholder={draftSession ? "Describe the task…" : session.state === "working" ? "Add an instruction…" : "Continue this task…"} rows={1} aria-label="Message"/>
      <div className="composer-primary-actions">
        <Popover label="More message actions" className="composer-actions-menu" open={actionsOpen} onOpen={setActionsOpen} trigger={<MoreIcon />}>{actions}</Popover>
        <DictationControl providerId={providerId} request={request} notify={notify} onTranscript={(transcript) => { setContent((current) => appendTranscript(current, transcript)); requestAnimationFrame(() => textarea.current?.focus()); }}/>
        <IconButton label={draftSession ? "Start task" : mode === "steer" ? "Steer task" : "Send instruction"} className="send-button" disabled={!canSend || !content.trim() || sending} onClick={() => void submit()}>{sending ? <span className="spinner" /> : mode === "steer" ? <SlidersIcon /> : <SendIcon />}</IconButton>
      </div>
    </div>
  </div>;
}
