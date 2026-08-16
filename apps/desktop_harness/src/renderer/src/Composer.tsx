import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  defaultSimplifyMaxWords,
  maximumSimplifyMaxWords,
  normalizeSimplifySettings,
  parseSimplifyCommand,
  type SimplifySettings,
} from "../../../../../packages/protocol/src/simplify";
import type { JsonObject } from "../../../../../packages/protocol/src/index";
import type { DesktopPreferencesState, ScreenCaptureSource, SelectedFile, SelectedImage, VisionProxyStatus, VisionProxyTarget, WorkflowAttachment, WorkflowDescriptor } from "@shared/desktop_api";
import { IconButton, LoadingState, ProviderLogo } from "./components";
import { ChatTimeline } from "./ChatTimeline";
import {
  AgentIcon,
  AlertIcon,
  BrowserIcon,
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CommandIcon,
  ExternalLinkIcon,
  FileIcon,
  MoreIcon,
  PaperclipIcon,
  PlusIcon,
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
  insertedSlashCommand,
  maximumMessageAttachmentBytes,
  isAmbiguousSelectionValue,
  resolveConcreteModelSelection,
  resolveComposerModelId,
  slashCommandSuggestions,
  uploadAttachments,
  type ComposerSlashCommand,
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
  workflowIds: readonly string[];
  workflows: NonNullable<TimelineItem["workflows"]>;
  simplify?: JsonObject;
}

export interface DraftModelSelection {
  providerId: Session["providerId"];
  modelId: string;
  effort: string;
}

/**
 * A local, unsent attachment. The parent may keep these values in per-session
 * React state so switching tasks does not discard the draft. Never persist the
 * base64 payload to localStorage.
 */
export type ComposerAttachment = SelectedImage | SelectedFile;

export interface SideChatDraft {
  readonly content: string;
  readonly attachments: readonly SelectedImage[];
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
  initialAttachments?: readonly ComposerAttachment[];
  onAttachmentsChange?: (value: readonly ComposerAttachment[]) => void;
  onDerivedSession: (value: Record<string, unknown>, summary?: string, draft?: string) => void;
  /** Mirrors local selection into Session.draft so surrounding UI stays accurate. */
  onDraftSelectionChange?: (selection: DraftModelSelection) => void;
  /** Must perform the sole create/send path and replace the local draft atomically. */
  onCreateDraftSend?: (input: DraftSessionSendInput) => Promise<void>;
  /** Instant sessions are experimental; the entry point is only rendered when true. */
  experimental?: boolean;
  onInstantSession?: () => void;
  /** Creates a hidden context-sharing side chat and opens its compact panel. */
  onCreateSideChat?: (parentSessionId: string, prompt?: string, queuedMessageId?: string) => Promise<void>;
  /** Incremented only when a queue event arrives; avoids polling the queue. */
  queueRevision?: number;
  /** Per-task preference owned by App so Composer remounts do not reset it. */
  queueingEnabled: boolean;
  onQueueingEnabledChange: (enabled: boolean) => void;
  /** Persisted concrete defaults keyed only by provider ID. */
  agentDefaults?: DesktopPreferencesState["agentDefaults"];
  /** Stops the active task while the composer is empty; typing restores send. */
  onInterrupt?: () => Promise<void>;
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

const simplifySettingsKey = "tethoq:simplify-settings:v1";

export function storedSimplifySettings(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): SimplifySettings {
  try {
    const value = storage?.getItem(simplifySettingsKey);
    return normalizeSimplifySettings(value ? JSON.parse(value) : undefined);
  } catch {
    return { maxWords: defaultSimplifyMaxWords };
  }
}

export function simplifySubmission(content: string, settings: SimplifySettings): {
  readonly content: string;
  readonly simplify?: JsonObject;
} {
  const parsed = parseSimplifyCommand(content);
  const normalized = normalizeSimplifySettings(settings);
  return parsed.active
    ? { content: parsed.content, simplify: { maxWords: normalized.maxWords, ...(normalized.guidance !== undefined ? { guidance: normalized.guidance } : {}), target: parsed.target } }
    : { content: parsed.content };
}

function SimplifyIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M5.5 10h9M8 15h4" /></svg>;
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
  return <div className={`composer-choice composer-setting ${className}`}>
    {triggerDescription ? <span className="composer-setting-label">{triggerDescription}</span> : null}
    <Popover label={label} className="composer-setting-control" open={open} onOpen={setOpen} trigger={<span className="composer-setting-value choice-setting-value"><strong>{selected.label}</strong><ChevronDownIcon /></span>}>
      {options.map((option) => <button type="button" role="menuitemradio" aria-checked={option.value === value} key={option.value} disabled={option.disabled} onClick={() => { onChange(option.value); setOpen(false); }}><span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>{option.value === value ? <CheckIcon /> : null}</button>)}
    </Popover>
  </div>;
}

export function reasoningLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (isAmbiguousSelectionValue(value)) return "";
  if (normalized === "low") return "Light";
  if (normalized === "medium") return "Medium";
  if (normalized === "high") return "High";
  if (normalized === "minimal") return "Minimal";
  if (normalized === "max") return "Max";
  if (normalized === "ultra") return "Ultra";
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

function usableQueueTaskEntries(snapshot: DesktopSnapshot): readonly CatalogModel[] {
  return snapshot.providers.flatMap((provider) => {
    const ready = provider.state === "online"
      && provider.capabilities.includes("Create Session")
      && provider.capabilities.includes("Send Message");
    if (!ready) return [];
    return (snapshot.models[provider.id] ?? [])
      .filter((model) => model.walletKind !== "user_api" || model.apiKeyConfigured !== false)
      .map((model) => ({ key: `${provider.id}:${model.id}`, provider, model }));
  });
}

export function mostRecentReasoningForModel(
  sessions: readonly Session[],
  providerId: string,
  model: ModelOption,
): string | undefined {
  const supported = new Set(model.efforts.filter((effort) => !isAmbiguousSelectionValue(effort)));
  if (supported.size === 0) return undefined;
  return [...sessions]
    .filter((session) => session.providerId === providerId && (session.model === model.id || session.model === model.name))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((session) => session.effort)
    .find((effort) => !isAmbiguousSelectionValue(effort) && supported.has(effort));
}

function queuedTaskModelSelection(
  snapshot: DesktopSnapshot,
  providerId: string,
  modelId: string | undefined,
  agentDefaults: DesktopPreferencesState["agentDefaults"],
): DraftModelSelection | null {
  const models = snapshot.models[providerId] ?? [];
  const requested = models.find((model) => model.id === modelId || model.name === modelId)
    ?? models.find((model) => model.id === agentDefaults[providerId]?.modelId)
    ?? models.find((model) => model.isDefault)
    ?? models[0];
  if (!requested) return null;
  const recentEffort = mostRecentReasoningForModel(snapshot.sessions, providerId, requested);
  const resolved = resolveConcreteModelSelection(
    models,
    { modelId: requested.id, ...(recentEffort !== undefined ? { reasoningEffort: recentEffort } : {}) },
    agentDefaults[providerId],
  );
  return resolved === null ? null : {
    providerId,
    modelId: resolved.modelId,
    effort: resolved.reasoningEffort ?? "",
  };
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
    <span className="composer-setting-label">Model</span>
    <button className={`model-picker-trigger ${selectedNeedsApiKey ? "needs-api-key" : ""}`} type="button" aria-label={`Choose model. Current model: ${label}${selectedNeedsApiKey ? ". API key required" : ""}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}><span className="composer-setting-value model-setting-value"><ProviderLogo providerId={providerId} provider={selectedProvider} size={18}/><strong>{displayLabel}</strong>{selectedNeedsApiKey ? <AlertIcon className="model-setting-caution" title="API key required"/> : null}<ChevronDownIcon /></span></button>
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
  const credential = item.credential as Record<string, unknown> | undefined;
  if (typeof item.id !== "string" || typeof item.label !== "string" || (item.status !== "ready" && item.status !== "needs_credential") || typeof item.setupEnvironmentVariable !== "string" || typeof capabilities?.maxAudioBytes !== "number") return null;
  return {
    id: item.id,
    label: item.label,
    status: item.status,
    setupEnvironmentVariable: item.setupEnvironmentVariable,
    ...(credential?.kind === "api_key" && typeof credential.label === "string" && typeof credential.setupUrl === "string" ? { credential: { kind: "api_key" as const, label: credential.label, setupUrl: credential.setupUrl } } : {}),
    capabilities: { batch: capabilities.batch === true, maxAudioBytes: capabilities.maxAudioBytes },
  };
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

function providerDictationSource(providerId: string): string {
  if (providerId === "grok") return "xai-stt";
  if (providerId === "codex" || providerId === "direct") return "openai-stt";
  return "";
}

export function DictationControl({ providerId, request, notify, onTranscript }: {
  providerId: string;
  request: Request;
  notify: ComposerProps["notify"];
  onTranscript: (value: string) => void;
}) {
  const [sources, setSources] = useState<readonly TranscriptionSource[]>([]);
  const [selectedId, setSelectedId] = useState(() => safeStoredSource(providerId));
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [setupSourceId, setSetupSourceId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    let active = true;
    void request("dictation.source.list").then((payload) => {
      if (!active) return;
      const next = Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : [];
      const chosen = chooseTranscriptionSource(next, safeStoredSource(providerId) || providerDictationSource(providerId));
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
  const hasReadySource = sources.some((source) => source.status === "ready");
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
    if (!selected || selected.status !== "ready") {
      setSetupSourceId("");
      setSourceMenuOpen(true);
      return;
    }
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
    if (source.status !== "ready") {
      setSetupSourceId(source.id);
      setApiKey("");
      return;
    }
    setSelectedId(source.id);
    storeSource(providerId, source.id);
    setSourceMenuOpen(false);
  };
  const setupSource = sources.find((source) => source.id === setupSourceId);
  const configureCredential = async () => {
    if (!setupSource?.credential || credentialBusy) return;
    setCredentialBusy(true);
    try {
      const payload = await request("dictation.source.configure", { sourceId: setupSource.id, apiKey: apiKey.trim() });
      const next = Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : [];
      const configured = next.find((source) => source.id === setupSource.id && source.status === "ready");
      if (!configured) throw new Error(`${setupSource.label} did not become ready.`);
      setSources(next);
      setSelectedId(configured.id);
      storeSource(providerId, configured.id);
      setApiKey("");
      setSetupSourceId("");
      setSourceMenuOpen(false);
      notify(`${configured.label} is ready`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setCredentialBusy(false);
    }
  };
  const clearCredential = async () => {
    if (!setupSource?.credential || credentialBusy) return;
    setCredentialBusy(true);
    try {
      const payload = await request("dictation.source.configure", { sourceId: setupSource.id, clear: true });
      const next = Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : [];
      setSources(next);
      setSelectedId(chooseTranscriptionSource(next, providerDictationSource(providerId))?.id ?? "");
      setApiKey("");
      setSetupSourceId("");
      notify(`${setupSource.label} key removed`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setCredentialBusy(false);
    }
  };

  return <div className={`dictation-control dictation-${phase}`}>
    <button className="dictation-main" type="button" aria-label={phase === "recording" ? "Stop dictation" : phase === "transcribing" ? "Transcribing dictation" : "Start dictation"} title={phase === "recording" ? "Stop dictation" : phase === "transcribing" ? "Transcribing dictation" : "Dictate"} disabled={phase === "transcribing"} onClick={() => phase === "recording" ? stop() : void start()}>{phase === "transcribing" ? <span className="spinner" /> : phase === "recording" ? <StopIcon /> : <MicrophoneIcon />}</button>
    <Popover label="Choose dictation source" className="dictation-source-menu" open={sourceMenuOpen} onOpen={setSourceMenuOpen} trigger={<DictationCrescentIcon />}>
      {setupSource?.credential ? <form className="dictation-credential-setup" onSubmit={(event) => { event.preventDefault(); void configureCredential(); }}>
        <header><button type="button" aria-label="Back to dictation sources" onClick={() => { setSetupSourceId(""); setApiKey(""); }}><ChevronRightIcon /></button><span><strong>{setupSource.label}</strong><small>Uses your {setupSource.credential.label}; this is separate from a consumer subscription.</small></span></header>
        <p>The key is checked with {setupSource.id === "xai-stt" ? "xAI" : "OpenAI"}, encrypted, and stored only on this computer.</p>
        <label><span>{setupSource.credential.label}</span><input autoFocus type="password" value={apiKey} minLength={8} maxLength={512} autoComplete="off" spellCheck={false} placeholder="Paste API key" onChange={(event) => setApiKey(event.target.value)} /></label>
        <div className="dictation-credential-actions"><button type="button" onClick={() => { if (typeof window.tethoqDesktop?.openDictationSetupPage === "function") void window.tethoqDesktop.openDictationSetupPage(setupSource.id === "xai-stt" ? "xai-stt" : "openai-stt"); }}><ExternalLinkIcon />Get API key</button>{setupSource.status === "ready" ? <button type="button" disabled={credentialBusy} onClick={() => void clearCredential()}>Remove saved key</button> : null}<button type="submit" disabled={credentialBusy || apiKey.trim().length < 8}>{credentialBusy ? "Checking…" : "Save and use"}</button></div>
      </form> : <>
        <header className={hasReadySource ? undefined : "dictation-source-empty"}><strong>{hasReadySource ? "Dictation source" : "No dictation source is enabled"}</strong><small>{hasReadySource ? `Saved separately for ${providerId}` : sources.length ? "Choose a provider below to set one up." : "No compatible source is available on this computer."}</small></header>
        {sources.length ? sources.map((source) => {
          const active = source.status === "ready" && source.id === selected?.id;
          return <button type="button" role="menuitemradio" aria-checked={active} key={source.id} onClick={() => select(source)}><ProviderLogo providerId={source.id.startsWith("xai") ? "grok" : "codex"} size={25}/><span><strong>{source.label}</strong><small>{source.status === "ready" ? "Ready" : `${source.credential?.label ?? "API key"} required · Set up`}</small></span>{active ? <CheckIcon /> : null}</button>;
        }) : null}
        {selected?.status === "ready" && selected.credential ? <button type="button" className="dictation-manage-source" onClick={() => { setSetupSourceId(selected.id); setApiKey(""); }}><span><strong>Manage selected source</strong><small>Replace or remove its saved API key</small></span><ChevronRightIcon /></button> : null}
      </>}
    </Popover>
  </div>;
}

export function DictationSettings({ request, notify }: {
  request: Request;
  notify: ComposerProps["notify"];
}) {
  const [sources, setSources] = useState<readonly TranscriptionSource[]>([]);
  const [editingId, setEditingId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void request("dictation.source.list").then((payload) => {
      if (!active) return;
      setSources(Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : []);
    }).catch(() => { if (active) setSources([]); });
    return () => { active = false; };
  }, [request]);
  const editing = sources.find((source) => source.id === editingId);
  const save = async () => {
    if (!editing?.credential || busy) return;
    setBusy(true);
    try {
      const payload = await request("dictation.source.configure", { sourceId: editing.id, apiKey: apiKey.trim() });
      setSources(Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : []);
      setEditingId("");
      setApiKey("");
      notify(`${editing.label} is ready`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(false); }
  };
  const remove = async (source: TranscriptionSource) => {
    if (!source.credential || busy) return;
    setBusy(true);
    try {
      const payload = await request("dictation.source.configure", { sourceId: source.id, clear: true });
      setSources(Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((item): item is TranscriptionSource => item !== null) : []);
      setEditingId("");
      setApiKey("");
      notify(`${source.label} key removed`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setBusy(false); }
  };
  return <section className="settings-block dictation-settings-block" id="dictation-settings">
    <header><h2>Dictation</h2><small>Provider speech-to-text, configured on this computer</small></header>
    <div className="settings-list">{sources.map((source) => <article key={source.id}>
      <ProviderLogo providerId={source.id === "xai-stt" ? "grok" : "codex"} size={31}/>
      <span><strong>{source.label}</strong><small>{source.status === "ready" ? `${source.credential?.label ?? "API key"} saved` : `${source.credential?.label ?? "API key"} required`}</small></span>
      <button type="button" disabled={!source.credential || busy} onClick={() => { setEditingId(source.id); setApiKey(""); }}>{source.status === "ready" ? "Manage" : "Set up"}</button>
    </article>)}</div>
    {editing?.credential ? <form className="dictation-settings-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div><strong>{editing.label}</strong><small>A subscription does not supply this API key. Tethoq encrypts it locally.</small></div>
      <label><span>{editing.credential.label}</span><input autoFocus type="password" value={apiKey} minLength={8} maxLength={512} autoComplete="off" spellCheck={false} placeholder="Paste API key" onChange={(event) => setApiKey(event.target.value)}/></label>
      <div><button type="button" onClick={() => { if (typeof window.tethoqDesktop?.openDictationSetupPage === "function") void window.tethoqDesktop.openDictationSetupPage(editing.id === "xai-stt" ? "xai-stt" : "openai-stt"); }}><ExternalLinkIcon />Get API key</button>{editing.status === "ready" ? <button type="button" disabled={busy} onClick={() => void remove(editing)}>Remove saved key</button> : null}<button type="button" onClick={() => { setEditingId(""); setApiKey(""); }}>Cancel</button><button type="submit" disabled={busy || apiKey.trim().length < 8}>{busy ? "Checking…" : "Save and use"}</button></div>
    </form> : null}
  </section>;
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></svg>;
}

function DictationCrescentIcon() {
  return <svg viewBox="0 0 24 12" aria-hidden="true"><path d="m7 3.25 5 4.25 5-4.25" /></svg>;
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

function isSelectedFile(attachment: ComposerAttachment): attachment is SelectedFile {
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

export interface QueuedMessageView {
  readonly id: string;
  readonly content: string;
  readonly state: "queued" | "sending" | "failed";
  readonly attachmentCount: number;
  readonly attachments: readonly QueuedAttachmentView[];
}

export interface QueuedAttachmentView {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly dataUrl?: string;
}

// Keep local thumbnails in renderer memory only. Queue history intentionally
// exposes metadata without image bytes, so a remount can reuse a thumbnail only
// when this renderer actually selected the source image.
const queuedAttachmentPreviewCache = new Map<string, readonly QueuedAttachmentView[]>();
const queuedAttachmentPreviewOwners = new Map<string, string>();

function queuedAttachment(value: unknown): QueuedAttachmentView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attachment = value as Record<string, unknown>;
  const name = typeof attachment.name === "string" && attachment.name.trim() ? attachment.name.trim() : "Attachment";
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream";
  const byteLength = typeof attachment.byteLength === "number" && Number.isFinite(attachment.byteLength) ? Math.max(0, attachment.byteLength) : 0;
  const inlineData = typeof attachment.dataBase64 === "string" && /^image\/[a-z0-9.+-]+$/iu.test(mimeType) && /^[a-z0-9+/]*={0,2}$/iu.test(attachment.dataBase64)
    ? `data:${mimeType};base64,${attachment.dataBase64}`
    : undefined;
  const retainedData = typeof attachment.dataUrl === "string" && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]*={0,2}$/iu.test(attachment.dataUrl)
    ? attachment.dataUrl
    : undefined;
  const dataUrl = inlineData ?? retainedData;
  return dataUrl ? { name, mimeType, byteLength, dataUrl } : { name, mimeType, byteLength };
}

function mergeQueuedAttachmentPreviews(message: QueuedMessageView): QueuedMessageView {
  const cached = queuedAttachmentPreviewCache.get(message.id);
  if (!cached?.length || message.attachments.some((attachment) => attachment.dataUrl)) return message;
  return {
    ...message,
    attachments: message.attachments.map((attachment, index) => {
      const preview = cached[index];
      if (!preview?.dataUrl || preview.name !== attachment.name || preview.mimeType !== attachment.mimeType) return attachment;
      return { ...attachment, dataUrl: preview.dataUrl };
    }),
  };
}

function rememberQueuedAttachmentPreviews(message: QueuedMessageView, images: readonly SelectedImage[], sessionId: string): void {
  if (!images.length || !message.attachments.length) return;
  const unused = [...images];
  const attachments = message.attachments.map((attachment) => {
    const index = unused.findIndex((image) => image.name === attachment.name && image.mimeType === attachment.mimeType && image.byteLength === attachment.byteLength);
    if (index < 0) return attachment;
    const [image] = unused.splice(index, 1);
    return { ...attachment, dataUrl: `data:${image!.mimeType};base64,${image!.dataBase64}` };
  });
  if (!attachments.some((attachment) => attachment.dataUrl)) return;
  queuedAttachmentPreviewCache.set(message.id, attachments);
  queuedAttachmentPreviewOwners.set(message.id, sessionId);
}

function forgetMissingQueuedAttachmentPreviews(sessionId: string, messages: readonly QueuedMessageView[]): void {
  const retained = new Set(messages.map((message) => message.id));
  for (const [messageId, owner] of queuedAttachmentPreviewOwners) {
    if (owner !== sessionId || retained.has(messageId)) continue;
    queuedAttachmentPreviewOwners.delete(messageId);
    queuedAttachmentPreviewCache.delete(messageId);
  }
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
    const attachments = Array.isArray(message.attachments) ? message.attachments.flatMap((attachment) => {
      const parsed = queuedAttachment(attachment);
      return parsed ? [parsed] : [];
    }) : [];
    const view: QueuedMessageView = {
      id: message.id,
      content: message.content,
      state: message.state,
      attachmentCount: attachments.length,
      attachments,
    };
    if (attachments.some((attachment) => attachment.dataUrl)) {
      queuedAttachmentPreviewCache.set(view.id, attachments);
      queuedAttachmentPreviewOwners.set(view.id, sessionId);
    }
    return [mergeQueuedAttachmentPreviews(view)];
  });
}

export function queuedMessagePreview(content: string): string {
  const preview = content.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
  if (!preview) return "Queued instruction";
  return preview.length > 180 ? `${preview.slice(0, 177).trimEnd()}…` : preview;
}

function QueueGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h11M5 12h8M5 17h5"/><path d="m15 14 4 3-4 3"/></svg>;
}

function ComposerSurfaceOutline() {
  const ref = useRef<SVGSVGElement>(null);
  const [geometry, setGeometry] = useState({ width: 1, height: 1, shelfHeight: 39, shelfWidth: 340 });
  useEffect(() => {
    const svg = ref.current;
    const box = svg?.parentElement;
    const shelf = box?.querySelector<HTMLElement>(".composer-footer");
    if (!svg || !box || !shelf || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const boxBounds = box.getBoundingClientRect();
      const shelfBounds = shelf.getBoundingClientRect();
      setGeometry({
        width: Math.max(1, Math.round(boxBounds.width)),
        height: Math.max(1, Math.round(boxBounds.height)),
        shelfHeight: Math.max(1, Math.round(shelfBounds.height)),
        shelfWidth: Math.max(1, Math.min(Math.round(shelfBounds.width), Math.round(boxBounds.width - 42))),
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(shelf);
    measure();
    return () => observer.disconnect();
  }, []);
  const { width, height, shelfHeight, shelfWidth } = geometry;
  const totalHeight = height + shelfHeight;
  const shelfLeft = Math.max(42, width - shelfWidth);
  const curveStart = Math.max(18, shelfLeft - 24);
  const radius = Math.min(15, height / 2);
  const path = [
    `M ${radius} ${shelfHeight}`,
    `H ${curveStart}`,
    `C ${curveStart + 11} ${shelfHeight} ${shelfLeft - 11} 0 ${shelfLeft} 0`,
    `H ${width - radius}`,
    `Q ${width} 0 ${width} ${radius}`,
    `V ${totalHeight - radius}`,
    `Q ${width} ${totalHeight} ${width - radius} ${totalHeight}`,
    `H ${radius}`,
    `Q 0 ${totalHeight} 0 ${totalHeight - radius}`,
    `V ${shelfHeight + radius}`,
    `Q 0 ${shelfHeight} ${radius} ${shelfHeight}`,
    "Z",
  ].join(" ");
  return <svg ref={ref} className="composer-surface-outline" viewBox={`0 0 ${width} ${totalHeight}`} preserveAspectRatio="none" style={{ top: -shelfHeight, height: totalHeight }} aria-hidden="true"><path d={path} vectorEffect="non-scaling-stroke"/></svg>;
}

function QueuedMessageRow({ message, busy, queueingEnabled, onSteer, onRemove, onEdit, onSideChat, onNewTask, onToggleQueueing }: {
  message: QueuedMessageView;
  busy: boolean;
  queueingEnabled: boolean;
  onSteer: () => Promise<void>;
  onRemove: () => Promise<void>;
  onEdit: (content: string) => Promise<void>;
  onSideChat: () => Promise<void>;
  onNewTask: () => void;
  onToggleQueueing: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(message.content);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!editing) setValue(message.content); }, [editing, message.content]);
  const save = async () => {
    const next = value.trim();
    if (!next || next === message.content || saving) { setEditing(false); return; }
    setSaving(true);
    try { await onEdit(next); setEditing(false); }
    finally { setSaving(false); }
  };
  const previewAttachment = message.attachments.find((attachment) => attachment.dataUrl);
  return <article className={`queued-message-row queued-message-${message.state}`} aria-label={`Queued instruction: ${queuedMessagePreview(message.content)}`} onContextMenu={(event) => {
    if (editing) return;
    event.preventDefault();
    setMenuOpen(true);
  }}>
    <span className="queued-state" aria-hidden="true">{message.state === "sending" ? <span className="spinner"/> : <QueueGlyph/>}</span>
    {editing ? <div className="queued-message-edit"><input autoFocus value={value} aria-label="Edit queued instruction" onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } else if (event.key === "Escape") setEditing(false); }}/><button type="button" disabled={saving || !value.trim()} onClick={() => void save()}>{saving ? <span className="spinner"/> : <CheckIcon/>}<span>Save</span></button></div> : <span className="queued-message-copy">{previewAttachment?.dataUrl ? <img className="queued-attachment-preview" src={previewAttachment.dataUrl} alt=""/> : null}<strong>{queuedMessagePreview(message.content)}</strong>{message.attachmentCount ? <small>{previewAttachment ? null : <FileIcon/>}{previewAttachment && message.attachmentCount > 1 ? `+${message.attachmentCount - 1}` : previewAttachment ? "Image" : message.attachmentCount}</small> : null}</span>}
    {!editing ? <div className="queued-message-actions">
      <button type="button" className="queued-steer" disabled={busy || message.state === "sending"} aria-label="Steer with this queued instruction" data-tooltip="Steer" onClick={() => void onSteer()}><SendIcon/><span>Steer</span></button>
      <button type="button" disabled={busy || message.state === "sending"} aria-label="Remove queued instruction" data-tooltip="Remove" onClick={() => void onRemove()}><XIcon/></button>
      <Popover label="Queued instruction actions" className="queued-message-menu" open={menuOpen} onOpen={setMenuOpen} trigger={<MoreIcon/>}>
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setEditing(true); }}><SlidersIcon/><span><strong>Edit message</strong></span></button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); void onSideChat(); }}><ChatIcon/><span><strong>Open in side chat</strong></span></button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => { setMenuOpen(false); onNewTask(); }}><BranchIcon/><span><strong>Send to new task</strong></span></button>
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onToggleQueueing(); }}><QueueGlyph/><span><strong>{queueingEnabled ? "Turn off queuing" : "Turn on queuing"}</strong></span></button>
      </Popover>
    </div> : null}
  </article>;
}

function QueuedNewTaskPicker({ snapshot, sourceSession, message, agentDefaults, onClose, onSubmit }: {
  snapshot: DesktopSnapshot;
  sourceSession: Session;
  message: QueuedMessageView;
  agentDefaults: DesktopPreferencesState["agentDefaults"];
  onClose: () => void;
  onSubmit: (selection: DraftModelSelection) => Promise<boolean>;
}) {
  const entries = useMemo(() => usableQueueTaskEntries(snapshot), [snapshot]);
  const providers = useMemo(() => snapshot.providers.filter((provider) => entries.some((entry) => entry.provider.id === provider.id)), [entries, snapshot.providers]);
  const initialProvider = providers.find((provider) => provider.id === sourceSession.providerId) ?? providers[0];
  const initialSelection = initialProvider
    ? queuedTaskModelSelection(snapshot, initialProvider.id, sourceSession.model, agentDefaults)
    : null;
  const [providerFilter, setProviderFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [providerId, setProviderId] = useState(initialSelection?.providerId ?? "");
  const [modelId, setModelId] = useState(initialSelection?.modelId ?? "");
  const [effort, setEffort] = useState(initialSelection?.effort ?? "");
  const [saving, setSaving] = useState(false);
  const visibleEntries = providerFilter === "all" ? entries : entries.filter((entry) => entry.provider.id === providerFilter);
  const selectedEntry = entries.find((entry) => entry.provider.id === providerId && entry.model.id === modelId);
  const efforts = selectedEntry?.model.efforts.filter((item) => !isAmbiguousSelectionValue(item)) ?? [];
  const choose = (entry: CatalogModel) => {
    const selection = queuedTaskModelSelection(snapshot, entry.provider.id, entry.model.id, agentDefaults);
    if (!selection) return;
    setProviderId(selection.providerId);
    setModelId(selection.modelId);
    setEffort(selection.effort);
    rememberModel(entry.key);
  };
  const start = async () => {
    if (!providerId || !modelId || saving) return;
    setSaving(true);
    const completed = await onSubmit({ providerId, modelId, effort });
    if (completed) onClose();
    else setSaving(false);
  };
  return <div className="queue-new-task-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="queue-new-task-picker" role="dialog" aria-modal="true" aria-label="Send queued instruction to a new task">
      <header><span><strong>Send to new task</strong><small>{queuedMessagePreview(message.content)}</small></span><button type="button" aria-label="Close new task selection" disabled={saving} onClick={onClose}><XIcon/></button></header>
      {entries.length ? <>
        <div className="queue-new-task-tools">
          <label className="model-catalog-search"><SearchIcon/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" aria-label="Search models for new task"/></label>
          <label><span>Agent</span><select aria-label="Filter models by Agent" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">All Agents</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label>
        </div>
        <div className="queue-new-task-models"><ModelCatalogResults entries={visibleEntries} recentKeys={storedRecentModels()} query={query} activeProviderId={providerId} selectedKey={selectedEntry?.key} allowProviderChange onChoose={choose}/></div>
        <div className="queue-new-task-selection">
          <span><small>Model</small><strong>{selectedEntry?.model.name ?? "Choose a model"}</strong></span>
          {efforts.length ? <label><small>Reasoning</small><select aria-label="Reasoning for new task" value={effort} onChange={(event) => setEffort(event.target.value)}>{efforts.map((item) => <option value={item} key={item}>{reasoningLabel(item)}</option>)}</select></label> : null}
        </div>
      </> : <div className="chat-picker-empty"><strong>No Agent is ready to start a task</strong><small>Connect an Agent in Settings, then try again.</small></div>}
      <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={!selectedEntry || saving} onClick={() => void start()}>{saving ? <span className="spinner"/> : <BranchIcon/>} Start task</button></footer>
    </section>
  </div>;
}

export function SideChatPanel({ session, provider, timeline, request, selectImages, notify, draft, onDraftChange, onDiscardDraft, onSent, onClose, onPromote }: {
  session: Session;
  provider?: Provider | undefined;
  timeline: readonly TimelineItem[];
  request: Request;
  selectImages: () => Promise<readonly SelectedImage[]>;
  notify: ComposerProps["notify"];
  draft: SideChatDraft;
  onDraftChange: (update: SideChatDraft | ((current: SideChatDraft) => SideChatDraft)) => void;
  onDiscardDraft: () => void;
  onSent: (item: TimelineItem) => void;
  onClose: () => void;
  onPromote: () => Promise<void>;
}) {
  const { content, attachments } = draft;
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const add = async () => {
    const selected = await selectImages();
    const next = appendAttachmentsWithinLimits(attachments, selected);
    onDraftChange((current) => ({ ...current, attachments: next.items.filter((item): item is SelectedImage => !isSelectedFile(item)) }));
    if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
    else if (next.rejectedForCount) notify("You can attach up to four items per message.", "error");
  };
  const send = async () => {
    const trimmed = content.trim();
    if (!trimmed || sending) return;
    setSending(true);
    const pendingUploadIds: string[] = [];
    try {
      const attachmentIds = attachments.length ? await uploadAttachments(attachments, uploadRequest(request), (id) => pendingUploadIds.push(id)) : [];
      await request("session.send_message", { sessionId: session.id, content: trimmed, ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}) });
      const timestamp = new Date().toISOString();
      onSent({ id: `local-side-${Date.now()}`, kind: "user", body: trimmed, timestamp, state: "completed", ...(attachments.length ? { images: attachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}` })) } : {}) });
      pendingUploadIds.length = 0;
      const sentContent = content;
      const sentPaths = new Set(attachments.map((attachment) => attachment.path));
      onDraftChange((current) => ({
        content: current.content === sentContent ? "" : current.content,
        attachments: current.attachments.filter((attachment) => !sentPaths.has(attachment.path)),
      }));
    } catch (error) {
      await Promise.all(pendingUploadIds.map((uploadId) => request("attachment.upload.cancel", { uploadId }).catch(() => undefined)));
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally { setSending(false); textarea.current?.focus(); }
  };
  return <section className="side-chat-panel" role="dialog" aria-label="Side chat">
    <header><span><ProviderLogo providerId={session.providerId} provider={provider} size={24}/><strong>Side chat</strong></span><div><Popover label="Side chat actions" className="side-chat-panel-menu" open={menuOpen} onOpen={setMenuOpen} trigger={<MoreIcon/>}><button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void onPromote(); }}><BranchIcon/><span><strong>Copy to full task</strong></span></button>{content || attachments.length ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDiscardDraft(); }}><XIcon/><span><strong>Discard draft</strong></span></button> : null}</Popover><button type="button" aria-label="Close side chat" onClick={onClose}><XIcon/></button></div></header>
    <div className="side-chat-transcript">{timeline.length ? <ChatTimeline timeline={timeline} providerId={session.providerId} provider={provider}/> : <p>Ask about this task without leaving it.</p>}</div>
    {attachments.length ? <div className="side-chat-attachments">{attachments.map((attachment) => <span key={attachment.path}><img src={`data:${attachment.mimeType};base64,${attachment.dataBase64}`} alt=""/><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onDraftChange((current) => ({ ...current, attachments: current.attachments.filter((item) => item.path !== attachment.path) }))}><XIcon/></button></span>)}</div> : null}
    <div className="side-chat-composer"><button type="button" aria-label="Attach image" data-tooltip="Attach image" onClick={() => void add()}><PlusIcon/></button><textarea ref={textarea} value={content} rows={1} placeholder="Ask about this task…" aria-label="Side chat message" onChange={(event) => onDraftChange((current) => ({ ...current, content: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}/><DictationControl providerId={session.providerId} request={request} notify={notify} onTranscript={(value) => onDraftChange((current) => ({ ...current, content: appendTranscript(current.content, value) }))}/><button className="side-chat-send" type="button" aria-label="Send side chat message" disabled={!content.trim() || sending} onClick={() => void send()}>{sending ? <span className="spinner"/> : <SendIcon/>}</button></div>
  </section>;
}

type VisualAction = "browser" | "workflow";

function visionReasoningEfforts(model: VisionProxyTarget["models"][number] | undefined): readonly string[] {
  if (!model) return [];
  const metadata = model.nativeMetadata as Record<string, unknown>;
  const raw = metadata.supportedReasoningEfforts ?? metadata.reasoningEfforts ?? metadata.supported_reasoning_efforts;
  if (!Array.isArray(raw)) return [];
  const values = raw.map((value) => {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    const item = value as Record<string, unknown>;
    return typeof item.reasoningEffort === "string" ? item.reasoningEffort : typeof item.id === "string" ? item.id : "";
  }).filter((value) => Boolean(value) && !isAmbiguousSelectionValue(value));
  const nativeDefault = [metadata.defaultReasoningEffort, metadata.default_reasoning_effort]
    .find((value): value is string => typeof value === "string" && !isAmbiguousSelectionValue(value));
  return nativeDefault && values.includes(nativeDefault) ? [nativeDefault, ...values.filter((value) => value !== nativeDefault)] : values;
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
  const [effort, setEffort] = useState("");
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
      setEffort(visionReasoningEfforts(firstModel)[0] ?? "");
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
    const selection: JsonObject = { providerId, modelId, ...(effort ? { reasoningEffort: effort } : {}) };
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
      <label><span>Provider</span><select aria-label="Vision provider" value={providerId} onChange={(event) => { const nextTarget = targets.find((item) => item.providerId === event.target.value); const nextModel = nextTarget?.models.find((item) => item.isDefault) ?? nextTarget?.models[0]; setProviderId(event.target.value); setModelId(nextModel?.id ?? ""); setEffort(visionReasoningEfforts(nextModel)[0] ?? ""); }}>{targets.map((item) => <option key={item.providerId} value={item.providerId}>{item.displayName}</option>)}</select></label>
      <label><span>Model</span><select aria-label="Vision model" value={modelId} onChange={(event) => { const nextModel = target?.models.find((item) => item.id === event.target.value); setModelId(event.target.value); setEffort(visionReasoningEfforts(nextModel)[0] ?? ""); }}>{target?.models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      {efforts.length ? <label><span>Reasoning</span><select aria-label="Vision reasoning effort" value={effort} onChange={(event) => setEffort(event.target.value)}>{efforts.map((item) => <option key={item} value={item}>{reasoningLabel(item)}</option>)}</select></label> : null}
    </div> : <div className="chat-picker-empty"><strong>No image-capable model is ready</strong><small>Connect one in Settings, then try again.</small></div>}
    <footer><button type="button" onClick={onClose}>Not now</button><button className="primary" type="button" disabled={loading || !providerId || !modelId || saving} onClick={() => void configure()}>{saving ? <span className="spinner" /> : <CheckIcon />} Use as eyes</button></footer>
  </section>;
}

export function Composer({ snapshot, session, request, selectImages, preview, notify, updateSnapshot, onBrowser, onManageWorkflow, initialDraft, onDraftChange, initialAttachments = [], onAttachmentsChange, onDerivedSession, onDraftSelectionChange, onCreateDraftSend, experimental, onInstantSession, onCreateSideChat, queueRevision = 0, queueingEnabled, onQueueingEnabledChange, agentDefaults = {}, onInterrupt }: ComposerProps) {
  const [content, setContent] = useState(initialDraft);
  const draftChangeRef = useRef(onDraftChange);
  const attachmentsChangeRef = useRef(onAttachmentsChange);
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const draftSession = session.draft === true;
  const [providerId, setProviderId] = useState(session.providerId);
  const models = snapshot.models[providerId] ?? [];
  const initialSelection = resolveConcreteModelSelection(models, { modelId: session.model, reasoningEffort: session.effort }, agentDefaults[session.providerId]);
  const [model, setModel] = useState(initialSelection?.modelId ?? resolveComposerModelId(models, session.model));
  const [effort, setEffort] = useState(initialSelection?.reasoningEffort ?? "");
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(() => initialAttachments);
  const [workflowAttachments, setWorkflowAttachments] = useState<readonly WorkflowAttachment[]>([]);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
  const [visionAction, setVisionAction] = useState<VisualAction | null>(null);
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<SelectedImage | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<readonly QueuedMessageView[]>([]);
  const [queuedNewTaskMessage, setQueuedNewTaskMessage] = useState<QueuedMessageView | null>(null);
  const [cancellingQueuedId, setCancellingQueuedId] = useState<string | null>(null);
  const [updatingQueuedId, setUpdatingQueuedId] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [sending, setSending] = useState(false);
  const [simplifySettings, setSimplifySettings] = useState<SimplifySettings>(() => storedSimplifySettings());
  const [simplifyOpen, setSimplifyOpen] = useState(false);
  const [slashSelection, setSlashSelection] = useState(0);
  const [slashPaletteDismissed, setSlashPaletteDismissed] = useState(false);
  const slashListId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const attachmentList = useRef<HTMLDivElement>(null);
  const promptHistory = useRef<readonly string[]>(storedPromptHistory());
  const historyIndex = useRef<number | null>(null);
  const unsentHistoryDraft = useRef(initialDraft);
  const chosenModel = models.find((item) => item.id === model);
  const efforts = [...new Set([...(chosenModel?.efforts ?? []).filter((item) => !isAmbiguousSelectionValue(item)), ...(!isAmbiguousSelectionValue(effort) ? [effort] : [])])];
  const provider = providerFor(snapshot.providers, providerId);
  const canSend = provider?.state === "online" && provider.capabilities.includes("Send Message") && (!draftSession || provider.capabilities.includes("Create Session") && onCreateDraftSend !== undefined);
  const canSteer = !draftSession && canSend && session.state === "working" && provider.capabilities.includes("Steering");
  const canInterrupt = !draftSession && session.state === "working" && provider?.capabilities.includes("Interrupt") === true && onInterrupt !== undefined;
  const canAttach = canSend && provider?.supportsAttachments === true;
  const canAttachFiles = canSend && provider?.supportsAttachments === true && supportsGenericFileAttachments(providerId);
  const canDelegate = snapshot.providers.some((item) => item.id !== session.providerId && item.state === "online" && item.capabilities.includes("Create Session") && item.capabilities.includes("Send Message"));
  const simplifyCommand = useMemo(() => parseSimplifyCommand(content), [content]);
  const slashSuggestions = useMemo(() => slashCommandSuggestions(content), [content]);
  const slashPaletteVisible = !slashPaletteDismissed && slashSuggestions !== null;
  const simplifyPreset = [100, 200, 300].includes(simplifySettings.maxWords) ? String(simplifySettings.maxWords) : "custom";

  const loadQueuedMessages = useCallback(async () => {
    if (draftSession) { setQueuedMessages([]); return; }
    try {
      const result = await request("message_queue.list", { sessionId: session.id });
      const messages = queuedMessagesForSession(result, session.id);
      forgetMissingQueuedAttachmentPreviews(session.id, messages);
      setQueuedMessages(messages);
    } catch {
      // Queue visibility is opportunistic; send failures still surface through the normal composer notice.
    }
  }, [draftSession, request, session.id]);

  useEffect(() => { if (mode === "steer" && !canSteer) setMode("queue"); }, [canSteer, mode]);
  useEffect(() => {
    if (models.length === 0 || models.some((item) => item.id === model) && !isAmbiguousSelectionValue(effort)) return;
    const selection = resolveConcreteModelSelection(models, { modelId: model, reasoningEffort: effort }, agentDefaults[providerId]);
    if (!selection) return;
    const nextEffort = selection.reasoningEffort ?? "";
    if (selection.modelId === model && nextEffort === effort) return;
    setModel(selection.modelId);
    setEffort(nextEffort);
    if (draftSession) onDraftSelectionChange?.({ providerId, modelId: selection.modelId, effort: nextEffort });
  }, [agentDefaults, draftSession, effort, model, models, onDraftSelectionChange, providerId]);
  const resizeTextarea = useCallback(() => {
    const target = textarea.current;
    if (!target) return;
    const composerLimit = Math.max(112, Math.floor(window.innerHeight * 0.4));
    const attachmentHeight = attachmentList.current ? Math.min(attachmentList.current.scrollHeight, Math.floor(composerLimit * 0.42)) : 0;
    growTextarea(target, Math.max(42, composerLimit - attachmentHeight - 20));
  }, []);
  useEffect(() => { resizeTextarea(); }, [attachments, content, resizeTextarea, workflowAttachments]);
  useEffect(() => {
    window.addEventListener("resize", resizeTextarea);
    return () => window.removeEventListener("resize", resizeTextarea);
  }, [resizeTextarea]);
  useEffect(() => { draftChangeRef.current = onDraftChange; }, [onDraftChange]);
  useEffect(() => { draftChangeRef.current(content); }, [content]);
  useEffect(() => { attachmentsChangeRef.current = onAttachmentsChange; }, [onAttachmentsChange]);
  useEffect(() => { attachmentsChangeRef.current?.(attachments); }, [attachments]);
  useEffect(() => { void loadQueuedMessages(); }, [loadQueuedMessages, queueRevision]);
  useEffect(() => {
    try { localStorage.setItem(simplifySettingsKey, JSON.stringify(simplifySettings)); } catch { /* Preferences remain usable for this window. */ }
  }, [simplifySettings]);
  useEffect(() => { if (!simplifyCommand.active) setSimplifyOpen(false); }, [simplifyCommand.active]);
  useEffect(() => { setSlashSelection(0); }, [content]);
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
      const simplified = simplifySubmission(trimmed, simplifySettings);
      const messageContent = simplified.content;
      const workflowItems = workflowAttachments.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        eventCount: workflow.summary.eventCount,
        screenshotCount: workflow.summary.screenshotCount,
        ...(workflow.summary.apps.length ? { applications: [...workflow.summary.apps] } : {}),
      }));
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
          workflowIds: workflowAttachments.map((workflow) => workflow.id),
          workflows: workflowItems,
          ...(simplified.simplify !== undefined ? { simplify: simplified.simplify } : {}),
        });
        sentLabel = "Task started";
      } else {
        const payload: JsonObject = {
          sessionId: session.id,
          content: messageContent,
          ...(model !== "default" ? { modelId: model } : {}),
          ...(effort ? { reasoningEffort: effort.toLowerCase() } : {}),
          ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}),
          ...(workflowAttachments.length ? { workflowIds: workflowAttachments.map((workflow) => workflow.id) } : {}),
          ...(simplified.simplify !== undefined ? { simplify: simplified.simplify } : {}),
        };
        const blockedByAttention = session.state === "working" || session.state === "needs_approval" || session.state === "needs_input";
        const liveGuidance = mode === "steer" || (!queueingEnabled && canSteer);
        const requestType = liveGuidance ? "session.steer_message" : attachments.length || (blockedByAttention && queueingEnabled) ? "message_queue.enqueue" : "session.send_message";
        const response = await request(requestType, payload);
        if (requestType === "message_queue.enqueue") {
          const queued = queuedMessagesForSession({ messages: [response.message] }, session.id)[0];
          if (queued) rememberQueuedAttachmentPreviews(queued, imageAttachments, session.id);
          await loadQueuedMessages();
        }
        const optimisticNotes = fileAttachments.map((attachment) => `Attached file: ${attachment.name}`);
        if (requestType !== "message_queue.enqueue") {
          const optimistic: TimelineItem = { id: `local-${Date.now()}`, kind: "user", body: optimisticNotes.length ? `${simplified.content}\n\n${optimisticNotes.join("\n")}` : simplified.content, ...(imageAttachments.length ? { images: imageAttachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}` })) } : {}), ...(workflowItems.length ? { workflows: workflowItems } : {}), timestamp: new Date().toISOString(), state: "completed" };
          updateSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [session.id]: [...(current.timelines[session.id] ?? []), optimistic] }, sessions: current.sessions.map((item) => item.id === session.id ? { ...item, state: "working", preview: simplified.content, updatedAt: optimistic.timestamp, model, ...(effort ? { effort } : {}) } : item) } : current);
        }
        sentLabel = liveGuidance ? "Task steered" : requestType === "message_queue.enqueue" ? "Instruction queued" : "Instruction sent";
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
      else {
        queuedAttachmentPreviewCache.delete(messageId);
        queuedAttachmentPreviewOwners.delete(messageId);
        notify("Queued instruction cancelled");
      }
      await loadQueuedMessages();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setCancellingQueuedId(null);
    }
  };
  const editQueuedMessage = async (messageId: string, nextContent: string) => {
    setUpdatingQueuedId(messageId);
    try {
      await request("message_queue.edit", { messageId, content: nextContent });
      await loadQueuedMessages();
      notify("Queued instruction updated");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally { setUpdatingQueuedId(null); }
  };
  const deliverQueuedMessage = async (messageId: string) => {
    setUpdatingQueuedId(messageId);
    try {
      const result = await request("message_queue.deliver", { messageId, mode: canSteer ? "steer" : "send" });
      if (result.delivered !== true) throw new Error("That queued instruction could not be delivered.");
      queuedAttachmentPreviewCache.delete(messageId);
      queuedAttachmentPreviewOwners.delete(messageId);
      await loadQueuedMessages();
      notify(canSteer ? "Task steered" : "Instruction sent");
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally { setUpdatingQueuedId(null); }
  };
  const openQueuedInSideChat = async (message: QueuedMessageView) => {
    if (!onCreateSideChat) return;
    setUpdatingQueuedId(message.id);
    try { await onCreateSideChat(session.id, undefined, message.id); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    finally { setUpdatingQueuedId(null); }
  };
  const moveQueuedToNewTask = async (message: QueuedMessageView, selection: DraftModelSelection): Promise<boolean> => {
    setUpdatingQueuedId(message.id);
    try {
      const result = await request("message_queue.move_to_new_task", {
        messageId: message.id,
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(selection.effort ? { reasoningEffort: selection.effort } : {}),
      });
      if (!result.session || typeof result.session !== "object" || Array.isArray(result.session)) {
        throw new Error("The bridge did not return the new task.");
      }
      queuedAttachmentPreviewCache.delete(message.id);
      queuedAttachmentPreviewOwners.delete(message.id);
      await loadQueuedMessages();
      onDerivedSession(result.session as Record<string, unknown>);
      notify("Queued instruction started in a new task");
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      await loadQueuedMessages();
      return false;
    } finally { setUpdatingQueuedId(null); }
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
  const insertComposerSlashCommand = (command: ComposerSlashCommand) => {
    const value = insertedSlashCommand(command);
    historyIndex.current = null;
    unsentHistoryDraft.current = value;
    setSlashPaletteDismissed(false);
    setContent(value);
    requestAnimationFrame(() => {
      const target = textarea.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(value.length, value.length);
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!event.nativeEvent.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && slashPaletteVisible) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashPaletteDismissed(true);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (slashSuggestions?.length) {
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setSlashSelection((current) => (current + direction + slashSuggestions.length) % slashSuggestions.length);
        }
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const selected = slashSuggestions?.[Math.min(slashSelection, Math.max(0, slashSuggestions.length - 1))];
        if (selected) insertComposerSlashCommand(selected);
        return;
      }
    }
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
    const selection = resolveConcreteModelSelection(nextModels, { modelId: nextModelId }, agentDefaults[nextProviderId]);
    const resolvedModelId = selection?.modelId ?? nextModelId;
    const nextEffort = selection?.reasoningEffort ?? "";
    if (!supportsGenericFileAttachments(nextProviderId) && attachments.some(isSelectedFile)) {
      setAttachments((current) => current.filter((attachment) => !isSelectedFile(attachment)));
      notify("OpenCode file attachments were removed for this coding tool.");
    }
    setProviderId(nextProviderId);
    setModel(resolvedModelId);
    setEffort(nextEffort);
    if (draftSession) onDraftSelectionChange?.({ providerId: nextProviderId, modelId: resolvedModelId, effort: nextEffort });
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
  const attachmentActions = <>
    <button type="button" role="menuitem" disabled={!canAttach} onClick={async () => { setAttachmentsOpen(false); const selected = await selectImages(); addImages(selected); }}><PaperclipIcon /><span><strong>Attach image</strong><small>{canAttach ? "Choose up to four images" : "Unavailable for this coding tool"}</small></span></button>
    {supportsGenericFileAttachments(providerId) ? <button type="button" role="menuitem" disabled={!canAttachFiles || preview} onClick={async () => {
      setAttachmentsOpen(false);
      try {
        const selected = await window.tethoqDesktop.selectFiles(providerId);
        const added = addFiles(selected);
        if (added.acceptedCount > 0 && !added.rejectedForBytes && !added.rejectedForCount) notify(added.acceptedCount === 1 ? "File attached" : `${added.acceptedCount} files attached`);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }}><FileIcon /><span><strong>Attach file</strong><small>{canAttachFiles ? "Four attachments total · 25 MiB each" : "OpenCode is unavailable"}</small></span></button> : null}
    <button type="button" role="menuitem" disabled={!canAttach || preview} onClick={() => { setAttachmentsOpen(false); setCaptureOpen(true); }}><ScreenshotIcon /><span><strong>Capture screen region</strong><small>{canAttach ? "Drag, crop, and attach automatically" : "Unavailable for this coding tool"}</small></span></button>
    <button type="button" role="menuitem" onClick={() => { setAttachmentsOpen(false); if (draftSession) setWorkflowPickerOpen(true); else void openVisualAction("workflow"); }}><WorkflowIcon /><span><strong>Attach workflow</strong><small>Use recorded local context</small></span></button>
  </>;
  const actions = <>
    {!draftSession ? <><button type="button" role="menuitem" disabled={deriving} onClick={() => { setActionsOpen(false); setHandoffOpen(true); }}><ChatIcon /><span><strong>Context Handoff</strong><small>Clean task with a concise working summary</small></span></button>
    <button type="button" role="menuitem" disabled={deriving} onClick={() => void branchSession()}><BranchIcon /><span><strong>Branch in New Task</strong><small>Continue from this exact conversation</small></span>{deriving ? <span className="spinner" /> : null}</button></> : null}
    {!draftSession ? <><button type="button" role="menuitem" onClick={() => void openVisualAction("browser")}><BrowserIcon /><span><strong>Open session browser</strong><small>Persistent, app-owned Chromium</small></span></button>
    <button type="button" role="menuitem" disabled={!onCreateSideChat} onClick={() => { setActionsOpen(false); void onCreateSideChat?.(session.id); }}><ChatIcon /><span><strong>Open side chat</strong><small>Ask with this task's current context</small></span></button>
    <button type="button" role="menuitem" disabled={!canDelegate} onClick={() => { setActionsOpen(false); setDelegationOpen(true); }}><AgentIcon /><span><strong>Delegate task</strong><small>Start grouped child sessions</small></span></button>
    <button type="button" role="menuitem" onClick={() => { setMode(mode === "queue" && canSteer ? "steer" : "queue"); setActionsOpen(false); }}><SendIcon /><span><strong>Send behavior: {mode === "steer" ? "Steer" : "Queue"}</strong><small>{canSteer ? "Switch between next-up and live guidance" : "Instructions run next"}</small></span><CheckIcon /></button></> : null}
    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onManageWorkflow(); }}><SlidersIcon /><span><strong>Manage workflows</strong><small>Review recordings in Settings</small></span></button>
    {experimental && onInstantSession && !draftSession ? <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onInstantSession(); }}><MicrophoneIcon /><span><strong>Instant session</strong><small>Speak with synchronized screen and pointer evidence</small></span></button> : null}
  </>;

  return <div className="composer-wrap">
    {queuedNewTaskMessage ? createPortal(<QueuedNewTaskPicker
      snapshot={snapshot}
      sourceSession={session}
      message={queuedNewTaskMessage}
      agentDefaults={agentDefaults}
      onClose={() => setQueuedNewTaskMessage(null)}
      onSubmit={(selection) => moveQueuedToNewTask(queuedNewTaskMessage, selection)}
    />, document.body) : null}
    {workflowPickerOpen ? <WorkflowPicker selected={workflowAttachments.map((item) => item.id)} preview={preview} onClose={() => setWorkflowPickerOpen(false)} onChoose={(attachment) => { setWorkflowAttachments((current) => [...current.filter((item) => item.id !== attachment.id), attachment]); setWorkflowPickerOpen(false); }} onManageWorkflow={onManageWorkflow} /> : null}
    {visionAction ? <VisionEyesPicker key={`${session.id}:${visionAction}`} session={session} request={request} action={visionAction} notify={notify} onClose={() => setVisionAction(null)} onReady={continueVisualAction} /> : null}
    {delegationOpen ? <DelegationPicker snapshot={snapshot} session={session} request={request} notify={notify} onClose={() => setDelegationOpen(false)} /> : null}
    {handoffOpen ? <ContextHandoffPicker session={session} request={request} notify={notify} onClose={() => setHandoffOpen(false)} onComplete={(value, summary, draft) => onDerivedSession(value, summary, draft)} /> : null}
    {captureOpen && !preview ? <ScreenRegionPicker notify={notify} onClose={() => setCaptureOpen(false)} onChoose={(image) => addImages([image]).acceptedCount > 0} /> : null}
    {attachmentPreview ? <div className="image-lightbox composer-image-lightbox" role="dialog" aria-modal="true" aria-label={`Preview ${attachmentPreview.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setAttachmentPreview(null); }}><button type="button" aria-label="Close attachment preview" onClick={() => setAttachmentPreview(null)}><XIcon /></button><figure><img src={`data:${attachmentPreview.mimeType};base64,${attachmentPreview.dataBase64}`} alt={attachmentPreview.name} referrerPolicy="no-referrer"/><figcaption>{attachmentPreview.name}</figcaption></figure></div> : null}
    {queuedMessages.length ? <div className="queued-strip" role="list" aria-label="Queued instructions">{queuedMessages.map((message) => <QueuedMessageRow
      key={message.id}
      message={message}
      busy={cancellingQueuedId === message.id || updatingQueuedId === message.id}
      queueingEnabled={queueingEnabled}
      onSteer={() => deliverQueuedMessage(message.id)}
      onRemove={() => cancelQueuedMessage(message.id)}
      onEdit={(next) => editQueuedMessage(message.id, next)}
      onSideChat={() => openQueuedInSideChat(message)}
      onNewTask={() => setQueuedNewTaskMessage(message)}
      onToggleQueueing={() => {
        const next = !queueingEnabled;
        setMode(next ? "queue" : canSteer ? "steer" : "queue");
        onQueueingEnabledChange(next);
        notify(next ? "Queuing enabled" : "Queuing turned off");
      }}
    />)}</div> : null}
    <div className="composer-box">
      <ComposerSurfaceOutline />
      <div className="composer-footer" aria-label="Message options">
        <ModelPicker snapshot={snapshot} providerId={providerId} sessionModel={providerId === session.providerId ? session.model : ""} value={model} allowProviderChange={draftSession} onChange={selectComposerModel} />
        {effort && efforts.length ? <ChoiceMenu value={effort} options={efforts.map((item) => ({ value: item, label: reasoningLabel(item) }))} onChange={selectComposerEffort} label="Choose reasoning effort" className="effort-choice" triggerDescription="Reasoning" /> : null}
      </div>
      {slashPaletteVisible ? <div className="slash-command-palette" id={slashListId} role="listbox" aria-label="Commands">
        {slashSuggestions?.length ? slashSuggestions.map((command, index) => <button
          key={command.id}
          id={`${slashListId}-${command.id}`}
          type="button"
          role="option"
          aria-selected={index === slashSelection}
          onMouseDown={(event) => event.preventDefault()}
          onPointerMove={() => setSlashSelection(index)}
          onClick={() => insertComposerSlashCommand(command)}
        ><CommandIcon /><span><strong>{command.command}</strong><small>{command.description}</small></span><kbd>Enter</kbd></button>)
          : <span className="slash-command-empty">No commands match</span>}
      </div> : null}
      {simplifyCommand.active && !slashPaletteVisible ? <div className="simplify-command-row">
        <Popover
          label="Simplify settings"
          className="simplify-command"
          open={simplifyOpen}
          onOpen={setSimplifyOpen}
          trigger={<><SimplifyIcon /><span>{simplifyCommand.target === "previous" ? "Simplify previous answer" : "Simplify next answer"}</span><ChevronDownIcon /></>}
        >
          <div className="simplify-settings" role="group" aria-label="Simplify response settings">
            <p>Simplify controls this response only, while preserving details the model judges important.</p>
            <span className="simplify-settings-label">Maximum words</span>
            <div className="simplify-presets" aria-label="Maximum words">
              {[100, 200, 300].map((words) => <button key={words} type="button" className={simplifyPreset === String(words) ? "selected" : ""} aria-pressed={simplifyPreset === String(words)} onClick={() => setSimplifySettings((current) => ({ ...current, maxWords: words }))}>{words}</button>)}
              <button type="button" className={simplifyPreset === "custom" ? "selected" : ""} aria-pressed={simplifyPreset === "custom"} onClick={() => setSimplifySettings((current) => ({ ...current, maxWords: simplifyPreset === "custom" ? current.maxWords : 150 }))}>Custom</button>
            </div>
            {simplifyPreset === "custom" ? <label><span>Maximum words</span><input type="number" min={1} max={maximumSimplifyMaxWords} value={simplifySettings.maxWords} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) setSimplifySettings((current) => ({ ...current, maxWords: Math.max(1, Math.min(maximumSimplifyMaxWords, Math.trunc(value))) })); }}/></label> : null}
            <label><span>Custom guidance <small>Optional</small></span><textarea value={simplifySettings.guidance ?? ""} maxLength={600} rows={3} placeholder="For example: keep the concrete example." onChange={(event) => setSimplifySettings(normalizeSimplifySettings({ ...simplifySettings, guidance: event.target.value }))}/></label>
          </div>
        </Popover>
      </div> : null}
      {attachments.length || workflowAttachments.length ? <div className="attachment-chips" ref={attachmentList} aria-label="Draft attachments">
        {attachments.map((attachment) => isSelectedFile(attachment)
          ? <span className="file-attachment-chip" key={attachment.path}><FileIcon /><span><strong>{attachment.name}</strong><small>{Math.ceil(attachment.byteLength / 1024)} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}><XIcon /></button></span>
          : <span className="image-attachment-chip" key={attachment.path}><button type="button" className="attachment-thumbnail" title={`Preview ${attachment.name}`} aria-label={`Preview ${attachment.name}`} onClick={() => setAttachmentPreview(attachment)}><img src={`data:${attachment.mimeType};base64,${attachment.dataBase64}`} alt=""/></button><span><strong>{attachment.name}</strong><small>{Math.ceil(attachment.byteLength / 1024)} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}><XIcon /></button></span>)}
        {workflowAttachments.map((attachment) => <span className="workflow-attachment-chip" key={attachment.id}><button type="button" className="workflow-chip-link" title="View workflow details" onClick={() => onManageWorkflow(attachment.id)}><WorkflowIcon /><span><strong>{attachment.name}</strong><small>Recorded workflow</small></span></button><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setWorkflowAttachments((current) => current.filter((item) => item.id !== attachment.id))}><XIcon /></button></span>)}
      </div> : null}
      <div className="composer-entry-row">
        <Popover label="Add attachment" className="composer-attachment-menu" open={attachmentsOpen} onOpen={(open) => { setAttachmentsOpen(open); if (open) setActionsOpen(false); }} trigger={<PlusIcon />}>{attachmentActions}</Popover>
        <textarea ref={textarea} value={content} onChange={(event) => { historyIndex.current = null; unsentHistoryDraft.current = event.target.value; setSlashPaletteDismissed(false); setContent(event.target.value); }} onPaste={(event) => void onPaste(event)} onKeyDown={onKeyDown} placeholder={draftSession ? "Describe the task…" : session.state === "working" ? "Add an instruction…" : "Continue this task…"} rows={1} aria-label="Message" aria-expanded={slashPaletteVisible} aria-controls={slashPaletteVisible ? slashListId : undefined} aria-activedescendant={slashPaletteVisible && slashSuggestions?.length ? `${slashListId}-${slashSuggestions[Math.min(slashSelection, slashSuggestions.length - 1)]!.id}` : undefined}/>
        <div className="composer-primary-actions">
          <Popover label="More message actions" className="composer-actions-menu" open={actionsOpen} onOpen={(open) => { setActionsOpen(open); if (open) setAttachmentsOpen(false); }} trigger={<MoreIcon />}>{actions}</Popover>
          <DictationControl providerId={providerId} request={request} notify={notify} onTranscript={(transcript) => { setContent((current) => appendTranscript(current, transcript)); requestAnimationFrame(() => textarea.current?.focus()); }}/>
          <IconButton
            label={canInterrupt && !content.trim() ? "Stop task" : draftSession ? "Start task" : mode === "steer" ? "Steer task" : "Send instruction"}
            className={`send-button ${canInterrupt && !content.trim() ? "stop-button" : ""}`}
            disabled={sending || (canInterrupt && !content.trim() ? false : !canSend || !content.trim())}
            onClick={() => canInterrupt && !content.trim() ? void onInterrupt() : void submit()}
          >{sending ? <span className="spinner" /> : canInterrupt && !content.trim() ? <StopIcon /> : mode === "steer" ? <SlidersIcon /> : <SendIcon />}</IconButton>
        </div>
      </div>
    </div>
  </div>;
}
