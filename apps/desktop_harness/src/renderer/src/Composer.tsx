import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  defaultSimplifyMaxWords,
  maximumSimplifyMaxWords,
  normalizeSimplifySettings,
  parseSimplifyCommand,
  type SimplifySettings,
} from "../../../../../packages/protocol/src/simplify";
import type { JsonObject } from "../../../../../packages/protocol/src/index";
import type { DesktopPreferencesState, EarsSettings, ScreenCaptureSource, SelectedFile, SelectedImage, VisionProxyStatus, VisionProxyTarget, WorkflowAttachment, WorkflowDescriptor } from "@shared/desktop_api";
import {
  composeEarsDestinationText,
  defaultEarsSettings,
  earsCancelledMessage,
  earsConfigurationError,
  isEarsCancelledError,
  lowestReasoningEffort,
  reasoningLabelForNote,
  routeAcceptsEarsAudio,
  type EarsAudioRoute,
} from "../../../../../packages/protocol/src/ears";
import { reasoningDisplayLabel, type ReasoningLabelContext } from "../../../../../packages/protocol/src/reasoning";
import { IconButton, LoadingState, ProviderLogo } from "./components";
import { refreshProviders } from "./bridge";
import { ChatTimeline } from "./ChatTimeline";
import { AudioPlaybackChip, AudioTraceCanvas, liveTraceLevels, Mp3DictationRecorder, type SelectedAudio } from "./audio_dictation";
import {
  AgentIcon,
  AlertIcon,
  AnnotationIcon,
  ArrowLeftIcon,
  BrowserIcon,
  BranchIcon,
  ChatIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CommandIcon,
  EditIcon,
  ExternalLinkIcon,
  FileIcon,
  InfoIcon,
  MoreIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  ScreenshotIcon,
  SendIcon,
  SettingsIcon,
  SlidersIcon,
  StopIcon,
  WorkflowIcon,
  XIcon,
} from "./icons";
import type { DesktopSnapshot, ModelOption, Provider, Session, TimelineItem } from "./types";
import {
  appendAttachmentsWithinLimits,
  acknowledgeTransportQueueSuppression,
  appendTranscript,
  blobToUploadable,
  canSendToProvider,
  chooseTranscriptionSource,
  classifyDroppedFile,
  filterAttachmentsForDestination,
  growTextarea,
  dictationAudioConstraints,
  insertedSlashCommand,
  isDictationAudioAttachment,
  maximumMessageAttachmentBytes,
  isAmbiguousSelectionValue,
  modelCatalogRoute,
  modelMatchesCatalogQuery,
  modelAcceptsDirectAudio,
  newEarsRequestId,
  providerAcceptsDirectAudio,
  resolveConcreteModelSelection,
  resolvedDictationDeviceId,
  resolveComposerModelId,
  sessionHoldsFollowUpQueue,
  composerMessageRequestType,
  composerSubmissionAppearsInTranscript,
  slashCommandSuggestions,
  uploadAttachments,
  visibleTransportQueueMessages,
  type ComposerSlashCommand,
  type TransportQueueSuppression,
  type TranscriptionSource,
} from "./composer_helpers";
import "./composer.css";
import { serializeResponseAnnotations, type ResponseAnnotation } from "./response_annotations";

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
export type ComposerAttachment = SelectedImage | SelectedFile | SelectedAudio;

export function isSelectedAudio(attachment: ComposerAttachment): attachment is SelectedAudio {
  return !("kind" in attachment && attachment.kind === "file") && attachment.mimeType.toLowerCase().startsWith("audio/");
}

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
  initialAnnotations?: readonly ResponseAnnotation[];
  onAnnotationsChange?: (value: readonly ResponseAnnotation[]) => void;
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
  ears?: EarsSettings;
  onEarsChange?: (value: EarsSettings) => Promise<void> | void;
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousOpen = useRef(open);
  const focusTriggerAfterAction = useRef(false);
  const id = useId();
  useLayoutEffect(() => {
    if (previousOpen.current && !open) {
      const active = document.activeElement;
      if (focusTriggerAfterAction.current || (active instanceof HTMLElement && active !== triggerRef.current && ref.current?.contains(active))) {
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    }
    focusTriggerAfterAction.current = false;
    previousOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { onOpen(false); requestAnimationFrame(() => triggerRef.current?.focus()); } };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [onOpen, open]);
  return <div className={`composer-popover-root ${className}`} ref={ref} onClick={(event) => { if (open && event.target instanceof Element && event.target.closest('[role="menuitem"], [role="menuitemradio"]')) focusTriggerAfterAction.current = true; }}>
    <button ref={triggerRef} type="button" aria-label={label} title={label} aria-expanded={open} aria-controls={id} aria-haspopup="menu" onClick={() => { if (open) requestAnimationFrame(() => triggerRef.current?.focus()); onOpen(!open); }}>{trigger}</button>
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

export function reasoningLabel(value: string, context: ReasoningLabelContext = {}): string {
  return reasoningDisplayLabel(value, context);
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
  const visible = entries.filter((entry) => modelMatchesCatalogQuery(query, entry.provider.id, entry.provider.name, entry.model));
  const recents = query.trim() ? [] : recentKeys.map((key) => entries.find((entry) => entry.key === key)).filter((entry): entry is CatalogModel => entry !== undefined);
  const groups = visible.reduce<Array<{ provider: Provider; route: ReturnType<typeof modelCatalogRoute>; models: CatalogModel[] }>>((current, entry) => {
    const route = modelCatalogRoute(entry.provider.id, entry.provider.name, entry.model);
    const found = current.find((group) => group.provider.id === entry.provider.id && group.route.key === route.key);
    if (found) found.models.push(entry);
    else current.push({ provider: entry.provider, route, models: [entry] });
    return current;
  }, []).sort((left, right) => {
    if (left.provider.id !== right.provider.id) return left.provider.id === activeProviderId ? -1 : right.provider.id === activeProviderId ? 1 : left.provider.name.localeCompare(right.provider.name);
    return left.route.label.localeCompare(right.route.label);
  });
  const button = (entry: CatalogModel, recent = false) => {
    const providerReady = entry.provider.state === "online" && entry.provider.capabilities.includes("Create Session") && entry.provider.capabilities.includes("Send Message");
    const selectable = allowProviderChange ? providerReady : entry.provider.id === activeProviderId;
    const selected = entry.key === selectedKey;
    const needsApiKey = entry.model.walletKind === "user_api" && entry.model.apiKeyConfigured === false;
    const caution = entry.model.caution ?? `API key required for ${entry.model.endpointName ?? "this endpoint"}`;
    const route = modelCatalogRoute(entry.provider.id, entry.provider.name, entry.model);
    const providerName = route.label;
    const routeLabel = recent && entry.provider.id === "opencode" ? route.carriedBy ? `${route.label} via ${route.carriedBy}` : route.label : undefined;
    const unavailableTitle = allowProviderChange ? `${entry.provider.name} is not ready` : `Start or hand off to ${entry.provider.name} to use this model`;
    return <button type="button" className={[needsApiKey ? "needs-api-key" : "", selected ? "selected" : ""].filter(Boolean).join(" ") || undefined} aria-current={selected ? "true" : undefined} key={`${recent ? "recent:" : ""}${entry.key}`} disabled={!selectable} title={selectable ? needsApiKey ? caution : `${entry.model.name} · ${providerName}` : unavailableTitle} onClick={() => onChoose(entry)}>
      <ProviderLogo providerId={entry.provider.id} provider={entry.provider} size={23}/>
      <span><strong>{entry.model.name}</strong>{needsApiKey ? <small className="model-api-caution">{caution}</small> : routeLabel ? <small className="model-route-label">{routeLabel}</small> : null}</span>
      <span className="model-row-meta">{recent ? <time>Recent</time> : !selectable && !allowProviderChange ? <small>New task</small> : null}{selected ? <CheckIcon /> : null}</span>
    </button>;
  };
  return <div className="model-catalog-results">
    {recents.length ? <section><h4>Recent</h4>{recents.map((entry) => button(entry, true))}</section> : null}
    {groups.map((group) => <section key={`${group.provider.id}:${group.route.key}`} data-provider-group={group.provider.id} data-route-group={group.route.key}><h4><ProviderLogo providerId={group.provider.id} provider={group.provider} size={18}/><span>{group.route.label}{group.route.carriedBy ? <small> via {group.route.carriedBy}</small> : null}</span></h4>{group.models.map((entry) => button(entry))}</section>)}
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
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const modelLibrary = useRef<HTMLElement>(null);
  const dropupId = useId();
  const libraryId = useId();
  const entries = useMemo(() => snapshot.providers.flatMap((provider) => (snapshot.models[provider.id] ?? []).map((model) => ({ key: `${provider.id}:${model.id}`, provider, model }))), [snapshot.models, snapshot.providers]);
  const providerEntries = entries.filter((entry) => entry.provider.id === providerId);
  const defaultEntry = providerEntries.find((entry) => entry.model.isDefault) ?? providerEntries[0];
  const selected = value === "default" ? defaultEntry : providerEntries.find((entry) => entry.model.id === value) ?? defaultEntry;
  const selectedNeedsApiKey = selected?.model.walletKind === "user_api" && selected.model.apiKeyConfigured === false;
  const fallbackModel = sessionModel && sessionModel.toLowerCase() !== "cli default" ? sessionModel : "";
  const label = selected?.model.name ?? (fallbackModel || "Current model");
  const displayLabel = compactComposerModelLabel(label, selected?.provider.id ?? providerId);
  const selectedProvider = selected?.provider ?? snapshot.providers.find((provider) => provider.id === providerId);
  const closePicker = (restoreFocus = true) => {
    setOpen(false);
    setExpanded(false);
    if (restoreFocus) requestAnimationFrame(() => modelTrigger.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) closePicker(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closePicker(); };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") closePicker(); };
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = [...(modelLibrary.current?.querySelectorAll<HTMLElement>("a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])" ) ?? [])];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("keydown", trap);
    requestAnimationFrame(() => modelLibrary.current?.querySelector<HTMLElement>("input, button:not([disabled])")?.focus());
    return () => { window.removeEventListener("keydown", escape); window.removeEventListener("keydown", trap); };
  }, [expanded]);
  const choose = (entry: CatalogModel) => {
    const providerReady = entry.provider.state === "online" && entry.provider.capabilities.includes("Create Session") && entry.provider.capabilities.includes("Send Message");
    if (entry.provider.id !== providerId && (!allowProviderChange || !providerReady)) return;
    onChange(entry.provider.id, entry.model.id);
    setRecentKeys(rememberModel(entry.key));
    closePicker();
  };
  const search = <label className="model-catalog-search"><SearchIcon /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models and providers" aria-label="Search models"/><kbd>Esc</kbd></label>;
  const results = <ModelCatalogResults entries={entries} recentKeys={recentKeys} query={query} activeProviderId={providerId} selectedKey={selected?.key} allowProviderChange={allowProviderChange} onChoose={choose}/>;
  return <div className="model-picker-root composer-setting" ref={root}>
    <span className="composer-setting-label">Model</span>
    <button ref={modelTrigger} className={`model-picker-trigger ${selectedNeedsApiKey ? "needs-api-key" : ""}`} type="button" aria-label={`Choose model. Current model: ${label}${selectedNeedsApiKey ? ". API key required" : ""}`} aria-haspopup="dialog" aria-expanded={open || expanded} aria-controls={open ? dropupId : expanded ? libraryId : undefined} onClick={() => { if (open || expanded) closePicker(); else setOpen(true); }}><span className="composer-setting-value model-setting-value"><ProviderLogo providerId={providerId} provider={selectedProvider} size={18}/><strong>{displayLabel}</strong>{selectedNeedsApiKey ? <AlertIcon className="model-setting-caution" title="API key required"/> : null}<ChevronDownIcon /></span></button>
    {open ? <section id={dropupId} className="model-picker-dropup" role="dialog" aria-modal="false" aria-label="Choose model"><header><strong>Models</strong><button type="button" aria-label="Open full model browser" title="Open full model browser" onClick={() => { setOpen(false); setExpanded(true); }}><ExternalLinkIcon /></button></header>{search}<div className="model-picker-scroll">{results}</div></section> : null}
    {expanded ? <div className="model-library-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePicker(); }}><section ref={modelLibrary} id={libraryId} className="model-library" role="dialog" aria-modal="true" aria-label="Model browser"><header><strong>Model browser</strong><button type="button" aria-label="Close model browser" onClick={() => closePicker()}><XIcon /></button></header>{search}<div className="model-library-scroll">{results}</div></section></div> : null}
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

const preferredMicrophoneKey = "tethoq:dictation-microphone-device";

function safeStoredMicrophone(): string {
  try { return localStorage.getItem(preferredMicrophoneKey) ?? ""; }
  catch { return ""; }
}

function storeMicrophone(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(preferredMicrophoneKey, deviceId);
    else localStorage.removeItem(preferredMicrophoneKey);
  } catch { /* Preferences may be unavailable in a restricted preview. */ }
}

function unavailableMicrophoneError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotFoundError" || error.name === "OverconstrainedError");
}

function providerDictationSource(providerId: string): string {
  if (providerId === "grok") return "xai-stt";
  if (providerId === "codex" || providerId === "direct") return "openai-stt";
  return "";
}

export interface DictationControlHandle {
  stop: () => void;
}

export const DictationControl = forwardRef<DictationControlHandle, {
  providerId: string;
  request: Request;
  notify: ComposerProps["notify"];
  onTranscript: (value: string) => void;
  /** When provided, a recorded clip can be attached to the outgoing message. */
  onAudio?: (audio: SelectedAudio) => void;
  audioDictationAvailable?: boolean;
  /** False when EARS transcribes the clip on the way instead of the model hearing it. */
  directToModel?: boolean;
  liveStripHost?: RefObject<HTMLDivElement | null>;
  onPhaseChange?: (phase: "idle" | "recording" | "transcribing" | "audio-recording") => void;
  onCommit?: () => void;
  onSettled?: (committed: boolean) => void;
}>(({
  providerId,
  request,
  notify,
  onTranscript,
  onAudio,
  audioDictationAvailable,
  directToModel = true,
  liveStripHost,
  onPhaseChange,
  onCommit,
  onSettled,
}, ref) => {
  const [sources, setSources] = useState<readonly TranscriptionSource[]>([]);
  const [selectedId, setSelectedId] = useState(() => safeStoredSource(providerId));
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [microphoneSettingsOpen, setMicrophoneSettingsOpen] = useState(false);
  const [microphones, setMicrophones] = useState<readonly MediaDeviceInfo[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState(safeStoredMicrophone);
  const [microphoneBusy, setMicrophoneBusy] = useState(false);
  const [setupSourceId, setSetupSourceId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing" | "audio-recording">("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRecorderRef = useRef<Mp3DictationRecorder | null>(null);
  const [audioElapsed, setAudioElapsed] = useState(0);
  const audioTimerRef = useRef<number | null>(null);
  const directAudioId = "direct-audio";
  const directAudioEnabled = audioDictationAvailable === true && onAudio !== undefined;

  useEffect(() => { onPhaseChange?.(phase); }, [onPhaseChange, phase]);

  const refreshMicrophones = useCallback(async (requestLabels: boolean) => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) throw new Error("Microphone selection is unavailable on this computer.");
    let devices = await mediaDevices.enumerateDevices();
    const labelsUnavailable = devices.some((device) => device.kind === "audioinput" && !device.label);
    if (requestLabels && labelsUnavailable && mediaDevices.getUserMedia) {
      const permissionStream = await mediaDevices.getUserMedia({ audio: true, video: false });
      permissionStream.getTracks().forEach((track) => track.stop());
      devices = await mediaDevices.enumerateDevices();
    }
    const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId !== "default");
    setMicrophones(inputs);
    setSelectedMicrophoneId((current) => {
      const resolved = resolvedDictationDeviceId(inputs, current);
      if (current && !resolved) storeMicrophone("");
      return resolved;
    });
    return inputs;
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    const refresh = () => { void refreshMicrophones(false).catch(() => undefined); };
    refresh();
    mediaDevices.addEventListener?.("devicechange", refresh);
    return () => mediaDevices.removeEventListener?.("devicechange", refresh);
  }, [refreshMicrophones]);

  const openMicrophoneSettings = () => {
    setMicrophoneSettingsOpen(true);
    setMicrophoneBusy(true);
    void refreshMicrophones(true)
      .catch((error) => notify(error instanceof Error ? error.message : String(error), "error"))
      .finally(() => setMicrophoneBusy(false));
  };

  const requestMicrophoneStream = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone recording is unavailable on this computer.");
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: dictationAudioConstraints(selectedMicrophoneId), video: false });
    } catch (error) {
      if (!selectedMicrophoneId || !unavailableMicrophoneError(error)) throw error;
      setSelectedMicrophoneId("");
      storeMicrophone("");
      return await navigator.mediaDevices.getUserMedia({ audio: dictationAudioConstraints(), video: false });
    }
  }, [selectedMicrophoneId]);

  useEffect(() => {
    let active = true;
    void request("dictation.source.list").then((payload) => {
      if (!active) return;
      const next = Array.isArray(payload.sources) ? payload.sources.map(toSource).filter((source): source is TranscriptionSource => source !== null) : [];
      const stored = safeStoredSource(providerId);
      const chosen = chooseTranscriptionSource(next, stored || providerDictationSource(providerId));
      setSources(next);
      // An explicit earlier choice wins; otherwise recording is the friendlier
      // default whenever the clip has somewhere to go.
      setSelectedId(stored || (directAudioEnabled ? directAudioId : chosen?.id ?? ""));
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
      void audioRecorderRef.current?.cancel();
      audioRecorderRef.current = null;
      if (audioTimerRef.current !== null) window.clearInterval(audioTimerRef.current);
      audioTimerRef.current = null;
    };
  }, [directAudioEnabled, directAudioId, providerId, request]);

  // MP3 stays visible in the menu whether or not the current model can hear it,
  // so the free route is always discoverable; directAudioEnabled is what gates
  // actually recording through it.
  const directAudioSource: TranscriptionSource | undefined = onAudio !== undefined ? {
    id: directAudioId,
    label: "MP3",
    status: "ready",
    setupEnvironmentVariable: "",
    capabilities: { batch: false, maxAudioBytes: 24 * 1024 * 1024 },
  } : undefined;
  const allSources = directAudioSource ? [...sources, directAudioSource] : sources;
  const selected = allSources.find((source) => source.id === selectedId) ?? (directAudioSource ?? chooseTranscriptionSource(sources, providerDictationSource(providerId)));
  const hasReadySource = directAudioEnabled || sources.some((source) => source.status === "ready");
  const stopTracks = () => { streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; };
  const finish = useCallback(async (blob: Blob, source: TranscriptionSource) => {
    setPhase("transcribing");
    let uploadId = "";
    let committed = false;
    try {
      const audio = await blobToUploadable(blob);
      if (audio.byteLength > source.capabilities.maxAudioBytes) throw new Error(`${source.label} accepts recordings up to ${Math.round(source.capabilities.maxAudioBytes / 1024 / 1024)} MB.`);
      const [attachmentId] = await uploadAttachments([audio], uploadRequest(request), (id) => { uploadId = id; });
      if (!attachmentId) throw new Error("The dictation recording could not be uploaded.");
      const result = await request("dictation.transcribe", { attachmentId, dictionary: [], sourceId: source.id });
      const transcript = typeof result.text === "string" ? result.text.trim() : "";
      if (!transcript) throw new Error("No speech was detected.");
      onTranscript(transcript);
      onCommit?.();
      committed = true;
      notify("Dictation added to your message");
      uploadId = "";
    } catch (error) {
      if (uploadId) await request("attachment.upload.cancel", { uploadId }).catch(() => undefined);
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      onSettled?.(committed);
      setPhase("idle");
    }
  }, [notify, onCommit, onSettled, onTranscript, request]);

  const clearAudioTimer = () => {
    if (audioTimerRef.current !== null) window.clearInterval(audioTimerRef.current);
    audioTimerRef.current = null;
  };

  const stopAudio = useCallback(async () => {
    const recorder = audioRecorderRef.current;
    if (!recorder) return;
    audioRecorderRef.current = null;
    clearAudioTimer();
    setPhase("transcribing");
    let committed = false;
    try {
      const audio = await recorder.stop();
      if (onAudio === undefined) return;
      if (audio.byteLength > 25 * 1024 * 1024) throw new Error("Audio recordings can be up to 25 MiB.");
      onAudio(audio);
      onCommit?.();
      committed = true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      onSettled?.(committed);
      setPhase("idle");
    }
  }, [notify, onAudio, onCommit, onSettled]);

  const startAudio = async () => {
    if (!navigator.mediaDevices?.getUserMedia) { notify("Microphone dictation is unavailable on this computer.", "error"); return; }
    let stream: MediaStream | undefined;
    try {
      stream = await requestMicrophoneStream();
      const recorder = new Mp3DictationRecorder((level) => liveTraceLevels.push(level));
      await recorder.start(stream);
      audioRecorderRef.current = recorder;
      setAudioElapsed(0);
      setPhase("audio-recording");
      audioTimerRef.current = window.setInterval(() => {
        setAudioElapsed((current) => {
          if (current + 1 >= 600) void stopAudio();
          return current + 1;
        });
      }, 1000);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      notify(error instanceof Error ? error.message : "Microphone permission was not granted.", "error");
      setPhase("idle");
    }
  };

  const start = async () => {
    if (!selected || selected.status !== "ready") {
      setSetupSourceId("");
      setSourceMenuOpen(true);
      return;
    }
    if (selected.id === directAudioId) {
      if (!directAudioEnabled) { notify("This model cannot hear a recording, so MP3 dictation is unavailable.", "error"); return; }
      await startAudio();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { notify("Microphone dictation is unavailable on this computer.", "error"); return; }
    try {
      const stream = await requestMicrophoneStream();
      const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => { stopTracks(); onSettled?.(false); setPhase("idle"); notify("Dictation recording failed.", "error"); };
      recorder.onstop = () => {
        stopTracks();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (chunks.length) void finish(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), selected);
        else { onSettled?.(false); setPhase("idle"); notify("No audio was recorded.", "error"); }
      };
      recorder.start(500);
      setPhase("recording");
    } catch (error) { stopTracks(); notify(error instanceof Error ? error.message : "Microphone permission was not granted.", "error"); }
  };
  const stop = () => {
    if (phase === "audio-recording") { void stopAudio(); return; }
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  };
  useImperativeHandle(ref, () => ({ stop }), [phase]);
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
  const selectMicrophone = (deviceId: string) => {
    setSelectedMicrophoneId(deviceId);
    storeMicrophone(deviceId);
    setMicrophoneSettingsOpen(false);
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

  const recording = phase === "recording" || phase === "audio-recording";
  const liveStrip = phase === "audio-recording" && liveStripHost?.current
    ? createPortal(<div className="dictation-audio-strip" role="status" aria-live="polite">
      <AudioTraceCanvas live/>
      <span className="dictation-audio-elapsed">{Math.floor(audioElapsed / 60)}:{String(audioElapsed % 60).padStart(2, "0")}</span>
      <button type="button" className="dictation-audio-stop" aria-label="Stop recording" title="Stop recording" onClick={() => void stopAudio()}><StopIcon /></button>
    </div>, liveStripHost.current)
    : null;

  return <div className={`dictation-control dictation-${phase}`}>
    {liveStrip}
    <button className="dictation-main" type="button" aria-label={recording ? "Stop dictation" : phase === "transcribing" ? "Transcribing dictation" : "Start dictation"} title={recording ? "Stop dictation" : phase === "transcribing" ? "Transcribing dictation" : "Dictate"} disabled={phase === "transcribing"} onClick={() => recording ? stop() : void start()}>{phase === "transcribing" ? <span className="spinner" /> : recording ? <StopIcon /> : <MicrophoneIcon />}</button>
    <Popover label="Choose dictation source" className="dictation-source-menu" open={sourceMenuOpen} onOpen={(open) => { setSourceMenuOpen(open); if (!open) setMicrophoneSettingsOpen(false); }} trigger={<DictationCrescentIcon />}>
      {microphoneSettingsOpen ? <section className="dictation-device-picker">
        <header><button type="button" aria-label="Back to dictation sources" onClick={() => setMicrophoneSettingsOpen(false)}><ChevronRightIcon /></button><span><strong>Microphone</strong><small>Used for MP3 and transcription recording</small></span></header>
        <div role="radiogroup" aria-label="Recording microphone">
          <button type="button" role="radio" aria-checked={!selectedMicrophoneId} onClick={() => selectMicrophone("")}><MicrophoneIcon /><span><strong>Default microphone</strong><small>Follows the current Windows default</small></span>{!selectedMicrophoneId ? <CheckIcon /> : null}</button>
          {microphones.map((device, index) => <button type="button" role="radio" aria-checked={selectedMicrophoneId === device.deviceId} key={device.deviceId} onClick={() => selectMicrophone(device.deviceId)}><MicrophoneIcon /><span><strong>{device.label || `Microphone ${index + 1}`}</strong><small>{selectedMicrophoneId === device.deviceId ? "Selected" : "Audio input"}</small></span>{selectedMicrophoneId === device.deviceId ? <CheckIcon /> : null}</button>)}
        </div>
        {microphoneBusy ? <p><span className="spinner" /> Checking microphones…</p> : null}
      </section> : setupSource?.credential ? <form className="dictation-credential-setup" onSubmit={(event) => { event.preventDefault(); void configureCredential(); }}>
        <header><button type="button" aria-label="Back to dictation sources" onClick={() => { setSetupSourceId(""); setApiKey(""); }}><ChevronRightIcon /></button><span><strong>{setupSource.label}</strong><small>Uses your {setupSource.credential.label}; this is separate from a consumer subscription.</small></span></header>
        <p>The key is checked with {setupSource.id === "xai-stt" ? "xAI" : "OpenAI"}, encrypted, and stored only on this computer.</p>
        <label><span>{setupSource.credential.label}</span><input autoFocus type="password" value={apiKey} minLength={8} maxLength={512} autoComplete="off" spellCheck={false} placeholder="Paste API key" onChange={(event) => setApiKey(event.target.value)} /></label>
        <div className="dictation-credential-actions"><button type="button" onClick={() => { if (typeof window.tethoqDesktop?.openDictationSetupPage === "function") void window.tethoqDesktop.openDictationSetupPage(setupSource.id === "xai-stt" ? "xai-stt" : "openai-stt"); }}><ExternalLinkIcon />Get API key</button>{setupSource.status === "ready" ? <button type="button" disabled={credentialBusy} onClick={() => void clearCredential()}>Remove saved key</button> : null}<button type="submit" disabled={credentialBusy || apiKey.trim().length < 8}>{credentialBusy ? "Checking…" : "Save and use"}</button></div>
      </form> : <>
        <header className={hasReadySource ? undefined : "dictation-source-empty"}><span><strong>{hasReadySource ? "Dictation source" : "No dictation source is enabled"}</strong><small>{hasReadySource ? `Saved separately for ${providerId}` : sources.length ? "Choose a provider below to set one up." : "No compatible source is available on this computer."}</small></span><button type="button" className="dictation-device-settings" aria-label="Choose microphone" title="Choose microphone" onClick={openMicrophoneSettings}><SettingsIcon /></button></header>
        {directAudioSource ? <div className="dictation-unlimited-group">
          <div className="dictation-section-label"><h5>unlimited</h5><button type="button" className="dictation-info-button" aria-label="About MP3 dictation" data-tooltip-align="end" data-tooltip={directAudioEnabled ? "This model allows audio input, so a recording can be used as a dictation alternative." : "This model does not accept audio input. Recording becomes available with an audio-capable model or EARS transcription."}><InfoIcon /></button></div>
          <button type="button" role="menuitemradio" aria-checked={selected?.id === directAudioId} disabled={!directAudioEnabled} className={`dictation-direct-audio-option${directAudioEnabled ? "" : " dictation-source-unavailable"}`} key={directAudioId} onClick={() => select(directAudioSource)}><span className="dictation-direct-audio-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M2 12h2.5M6 8.5v7M9.5 5v14M13 8.5v7M16.5 5v14M20 9.5v5M22.5 12H22" /></svg></span><span><strong>{directAudioSource.label}</strong><small>{directAudioEnabled ? (directToModel ? "The model hears your recording" : "EARS turns your recording into text") : "This model cannot hear a recording"}</small></span>{selected?.id === directAudioId ? <CheckIcon /> : null}</button>
        </div> : null}
        <div className="dictation-api-heading"><strong>API transcription</strong><small>Uses your provider API key</small></div>
        <div className="dictation-sources-scroll" role="group" aria-label="API transcription sources">
          {sources.length ? sources.map((source) => {
            const active = source.status === "ready" && source.id === selected?.id;
            return <button type="button" role="menuitemradio" aria-checked={active} key={source.id} onClick={() => select(source)}><ProviderLogo providerId={source.id.startsWith("xai") ? "grok" : "codex"} size={25}/><span><strong>{source.label}</strong><small>{source.status === "ready" ? "Ready" : `${source.credential?.label ?? "API key"} required · Set up`}</small></span>{active ? <CheckIcon /> : null}</button>;
          }) : null}
          {selected?.status === "ready" && selected.id !== directAudioId && selected.credential ? <button type="button" className="dictation-manage-source" onClick={() => { setSetupSourceId(selected.id); setApiKey(""); }}><span><strong>Manage selected source</strong><small>Replace or remove its saved API key</small></span><ChevronRightIcon /></button> : null}
        </div>
      </>}
    </Popover>
  </div>;
});

export function ResponseAnnotationEditor({ selectedText, initial, anchor, providerId, request, notify, directAudioAvailable, earsEnabled, onSave, onClose }: {
  selectedText: string;
  initial?: ResponseAnnotation | undefined;
  anchor: { x: number; y: number };
  providerId: string;
  request: Request;
  notify: ComposerProps["notify"];
  directAudioAvailable: boolean;
  earsEnabled: boolean;
  onSave: (annotation: ResponseAnnotation) => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState(initial?.annotation ?? "");
  const [audio, setAudio] = useState<SelectedAudio | undefined>(initial?.audio);
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing" | "audio-recording">("idle");
  const [commitRevision, setCommitRevision] = useState(0);
  const submitAfterRecordingRevision = useRef<number | null>(null);
  const dictation = useRef<DictationControlHandle>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const save = useCallback(() => {
    if (!comment.trim() && !audio) return;
    onSave({
      id: initial?.id ?? `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: selectedText.trim(),
      annotation: comment.trim(),
      ...(audio ? { audio } : {}),
    });
  }, [audio, comment, initial?.id, onSave, selectedText]);
  useEffect(() => {
    const expectedRevision = submitAfterRecordingRevision.current;
    if (expectedRevision === null || phase !== "idle" || commitRevision < expectedRevision) return;
    submitAfterRecordingRevision.current = null;
    save();
  }, [commitRevision, phase, save]);
  useEffect(() => {
    textarea.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const recording = phase === "recording" || phase === "audio-recording";
  const add = () => {
    if (recording) {
      submitAfterRecordingRevision.current = commitRevision + 1;
      dictation.current?.stop();
      return;
    }
    save();
  };
  const left = Math.max(12, Math.min(anchor.x, window.innerWidth - 380));
  const top = Math.max(72, Math.min(anchor.y + 8, window.innerHeight - 310));
  return createPortal(<div className="annotation-editor-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="annotation-editor" role="dialog" aria-label={initial ? "Edit response annotation" : "Annotate selected response"} style={{ left, top }}>
      <header><span><AnnotationIcon /><strong>{initial ? "Edit annotation" : "Annotate response"}</strong></span><button type="button" aria-label="Close annotation editor" onClick={onClose}><XIcon /></button></header>
      <blockquote>{selectedText}</blockquote>
      {audio ? <AudioPlaybackChip name={audio.name} dataUrl={`data:${audio.mimeType};base64,${audio.dataBase64}`} dictation durationSeconds={audio.durationSeconds} onRemove={() => setAudio(undefined)} /> : null}
      <div className="annotation-editor-entry">
        <textarea ref={textarea} value={comment} rows={3} placeholder="Add your comment…" aria-label="Annotation comment" onChange={(event) => setComment(event.target.value)} />
        <div className="annotation-editor-actions">
          <DictationControl
            ref={dictation}
            providerId={providerId}
            request={request}
            notify={notify}
            onTranscript={(value) => setComment((current) => appendTranscript(current, value))}
            onAudio={setAudio}
            audioDictationAvailable={directAudioAvailable || earsEnabled}
            directToModel={directAudioAvailable}
            onPhaseChange={setPhase}
            onCommit={() => setCommitRevision((current) => current + 1)}
            onSettled={(committed) => { if (!committed) submitAfterRecordingRevision.current = null; }}
          />
          <button type="button" className="annotation-editor-send" aria-label={recording ? "Stop recording and add annotation" : "Add annotation to message"} disabled={phase === "transcribing" || (!comment.trim() && !audio && !recording)} onClick={add}><SendIcon /></button>
        </div>
      </div>
    </section>
  </div>, document.body);
}

function ComposerAnnotationChip({ annotation, index, onEdit, onRemove }: {
  annotation: ResponseAnnotation;
  index: number;
  onEdit: (anchor: { x: number; y: number }) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("pointerdown", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("pointerdown", dismiss);
    };
  }, [open]);
  return <span ref={root} className="composer-annotation-chip">
    <button type="button" className="composer-annotation-main" aria-expanded={open} aria-label={`View annotation ${index + 1}`} onClick={() => setOpen((current) => !current)}><AnnotationIcon /><strong>{index + 1}</strong><span>{annotation.text}</span></button>
    <button type="button" className="composer-annotation-edit" aria-label={`Edit annotation ${index + 1}`} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setOpen(false); onEdit({ x: bounds.left, y: bounds.top }); }}><EditIcon /></button>
    <button type="button" className="composer-annotation-remove" aria-label={`Remove annotation ${index + 1}`} onClick={onRemove}><XIcon /></button>
    {open ? <span className="composer-annotation-detail" role="note"><small>Selected response</small><blockquote>{annotation.text}</blockquote><small>Your annotation</small>{annotation.annotation ? <p>{annotation.annotation}</p> : null}{annotation.audio ? <AudioPlaybackChip name={annotation.audio.name} dataUrl={`data:${annotation.audio.mimeType};base64,${annotation.audio.dataBase64}`} dictation durationSeconds={annotation.audio.durationSeconds}/> : null}</span> : null}
  </span>;
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

interface MeshTarget {
  readonly providerId: Session["providerId"];
  readonly modelId?: string;
  readonly reasoningEffort?: string;
}

// The bridge refuses more than four targets in one delegation, so the panel
// caps additions before a request is ever sent.
const maximumMeshTargets = 4;

function meshTargetModelLabel(snapshot: DesktopSnapshot, target: MeshTarget): string {
  return snapshot.models[target.providerId]?.find((model) => model.id === target.modelId)?.name ?? target.modelId ?? "Harness default";
}

function MeshModelPicker({ snapshot, provider, existing, onCommit, onClose }: {
  snapshot: DesktopSnapshot;
  provider: Provider;
  existing?: MeshTarget;
  onCommit: (target: MeshTarget) => void;
  onClose: () => void;
}) {
  const models = snapshot.models[provider.id] ?? [];
  const currentSelection = existing
    ? { ...(existing.modelId ? { modelId: existing.modelId } : {}), ...(existing.reasoningEffort ? { reasoningEffort: existing.reasoningEffort } : {}) }
    : {};
  const resolved = resolveConcreteModelSelection(models, currentSelection);
  const [modelId, setModelId] = useState(resolved?.modelId ?? "");
  const [effort, setEffort] = useState(resolved?.reasoningEffort ?? "");
  const chosenModel = models.find((model) => model.id === modelId);
  const efforts = (chosenModel?.efforts ?? []).filter((item) => !isAmbiguousSelectionValue(item));
  const chooseModel = (nextModelId: string) => {
    setModelId(nextModelId);
    // The effort must always belong to the model it will be sent with.
    setEffort(resolveConcreteModelSelection(models, { modelId: nextModelId })?.reasoningEffort ?? "");
  };
  const commit = () => {
    onCommit({ providerId: provider.id, ...(modelId ? { modelId } : {}), ...(effort ? { reasoningEffort: effort } : {}) });
  };
  return <div className="mesh-model-picker" role="dialog" aria-label={`Choose model for ${provider.name}`}>
    <header><button type="button" aria-label="Back to mesh targets" onClick={onClose}><ChevronRightIcon /></button><span className="mesh-model-picker-title"><ProviderLogo providerId={provider.id} provider={provider} size={24}/><span><strong>{provider.name}</strong><small>Model and reasoning</small></span></span><button type="button" aria-label="Close model picker" onClick={onClose}><XIcon /></button></header>
    <div className="mesh-model-picker-scroll">
      {models.length ? <section><h4>Model</h4>{models.map((model) => <button type="button" role="radio" aria-checked={model.id === modelId} key={model.id} className={model.id === modelId ? "selected" : ""} onClick={() => chooseModel(model.id)}><span><strong>{model.name}</strong></span><span className="mesh-row-meta">{model.id === modelId ? <CheckIcon /> : null}</span></button>)}</section> : <div className="mesh-model-empty"><strong>Harness default model</strong><small>This coding tool does not expose model choices.</small></div>}
      {efforts.length ? <section><h4>Reasoning</h4>{efforts.map((value) => <button type="button" role="radio" aria-checked={value === effort} key={value} className={value === effort ? "selected" : ""} onClick={() => setEffort(value)}><span><strong>{reasoningLabel(value, { providerId: provider.id, modelId, displayName: chosenModel?.name })}</strong></span>{value === effort ? <CheckIcon /> : null}</button>)}</section> : null}
    </div>
    <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={models.length > 0 && !modelId} onClick={commit}>{existing ? "Save target" : "Add to mesh"}</button></footer>
  </div>;
}

function MeshPanel({ snapshot, session, targets, onAdd, onClose }: {
  snapshot: DesktopSnapshot;
  session: Session;
  targets: readonly MeshTarget[];
  onAdd: (providerId: Session["providerId"]) => void;
  onClose: () => void;
}) {
  const selectedProviders = new Set(targets.map((target) => target.providerId));
  // Mesh references several agents at once, so every online tool other than the
  // current session is offerable - unlike Delegate, which stays single-select.
  const options = snapshot.providers.filter((provider) => provider.id !== session.providerId && !selectedProviders.has(provider.id) && provider.state === "online" && provider.capabilities.includes("Create Session") && provider.capabilities.includes("Send Message"));
  const room = targets.length < maximumMeshTargets;
  // Referenced tools live on the composer as chips, not in here: they have to
  // survive this panel closing, or writing the actual instruction would throw
  // the selection away. So the panel only ever offers what is not referenced yet.
  return <section className="mesh-panel" role="dialog" aria-label="Mesh delegation">
    {/* One row, not two. The command palette already named /mesh and described it
        while the user typed, so the panel carries only its list heading and the
        close control; the dialog keeps its accessible name from aria-label. */}
    <header className="mesh-panel-header">
      <span className="mesh-add-label">Reference coding tool</span>
      <button type="button" aria-label="Close mesh panel" onClick={onClose}><XIcon /></button>
    </header>
    {options.length && room ? <div className="mesh-add">
      {options.map((provider) => <button type="button" key={provider.id} onClick={() => onAdd(provider.id)}><ProviderLogo providerId={provider.id} provider={provider} size={25}/><span><strong>{provider.name}</strong><small>Create a real child session</small></span><ChevronRightIcon /></button>)}
    </div> : null}
    {!options.length || !room ? <div className="mesh-panel-empty">
      <strong>{targets.length ? "Every available coding tool is referenced" : "No other coding tool is ready"}</strong>
      <small>{targets.length ? "Write the instruction below and send it to them." : "Connect another tool before meshing."}</small>
    </div> : null}
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
  // One delegate, not a set. Multi-select read as "fan this out", which is not what
  // the surrounding copy promises and not what a reader expects from one dialog.
  const [selected, setSelected] = useState<Session["providerId"] | null>(options[0]?.id ?? null);
  const models = selected ? snapshot.models[selected] ?? [] : [];
  const [modelId, setModelId] = useState<string>("");
  const [effort, setEffort] = useState<string>("");
  const activeModel = models.find((model) => model.id === modelId) ?? models.find((model) => model.isDefault) ?? models[0];
  const efforts = activeModel?.efforts ?? [];
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const choose = (providerId: Session["providerId"]) => {
    setSelected(providerId);
    setModelId("");
    setEffort("");
  };
  return <section className="chat-picker delegation-chat-picker" role="dialog" aria-label="Delegate task">
    <header><span><strong>Delegate a task</strong><small>Create a grouped child task with another coding tool</small></span><button type="button" aria-label="Close delegation" onClick={onClose}><XIcon /></button></header>
    <div className="delegation-cli-options" role="radiogroup" aria-label="Coding tool">{options.map((provider) => <button type="button" role="radio" key={provider.id} className={selected === provider.id ? "selected" : ""} aria-checked={selected === provider.id} onClick={() => choose(provider.id)}><ProviderLogo providerId={provider.id} provider={provider} size={27}/><span><strong>{provider.name}</strong><small>New child task</small></span>{selected === provider.id ? <CheckIcon /> : null}</button>)}</div>
    {selected && (models.length || efforts.length) ? <div className="delegation-tuning">
      {models.length ? <label><span>Model</span><select value={activeModel?.id ?? ""} onChange={(event) => { setModelId(event.target.value); setEffort(""); }}>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label> : null}
      {efforts.length ? <label><span>Reasoning</span><select value={effort || activeModel?.defaultEffort || efforts[0] || ""} onChange={(event) => setEffort(event.target.value)}>{efforts.map((value) => <option key={value} value={value}>{reasoningLabel(value, { providerId: selected ?? undefined, modelId: activeModel?.id, displayName: activeModel?.name })}</option>)}</select></label> : null}
    </div> : null}
    {options.length ? <textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Give it an instruction…" rows={3}/> : <div className="chat-picker-empty"><strong>No other coding tool is ready</strong><small>Connect another tool before delegating.</small></div>}
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={!prompt.trim() || !selected || busy} onClick={async () => { setBusy(true); try { const chosenEffort = effort || activeModel?.defaultEffort || ""; await request("delegation.start", { parentSessionId: session.id, prompt: prompt.trim(), targets: [{ providerId: selected, ...(activeModel ? { modelId: activeModel.id } : {}), ...(chosenEffort ? { reasoningEffort: chosenEffort } : {}) }] }); notify("Delegated task started"); onClose(); } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); } finally { setBusy(false); } }}><AgentIcon /> Delegate</button></footer>
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
  readonly durationSeconds?: number;
}

// Keep local thumbnails in renderer memory only. Queue history intentionally
// exposes metadata without large attachment bytes, so a remount can reuse a
// preview only when this renderer actually selected the image or audio source.
const queuedAttachmentPreviewCache = new Map<string, readonly QueuedAttachmentView[]>();
const queuedAttachmentPreviewOwners = new Map<string, string>();

function queuedAttachment(value: unknown): QueuedAttachmentView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attachment = value as Record<string, unknown>;
  const name = typeof attachment.name === "string" && attachment.name.trim() ? attachment.name.trim() : "Attachment";
  const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : "application/octet-stream";
  const byteLength = typeof attachment.byteLength === "number" && Number.isFinite(attachment.byteLength) ? Math.max(0, attachment.byteLength) : 0;
  const previewable = /^(?:image|audio)\/[a-z0-9.+-]+$/iu.test(mimeType);
  const inlineData = typeof attachment.dataBase64 === "string" && previewable && /^[a-z0-9+/]*={0,2}$/iu.test(attachment.dataBase64)
    ? `data:${mimeType};base64,${attachment.dataBase64}`
    : undefined;
  const retainedData = typeof attachment.dataUrl === "string" && previewable && new RegExp(`^data:${mimeType.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")};base64,[a-z0-9+/]*={0,2}$`, "iu").test(attachment.dataUrl)
    ? attachment.dataUrl
    : undefined;
  const dataUrl = inlineData ?? retainedData;
  const durationSeconds = typeof attachment.durationSeconds === "number" && Number.isFinite(attachment.durationSeconds) && attachment.durationSeconds > 0
    ? attachment.durationSeconds
    : undefined;
  return {
    name,
    mimeType,
    byteLength,
    ...(dataUrl ? { dataUrl } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

function mergeQueuedAttachmentPreviews(message: QueuedMessageView): QueuedMessageView {
  const cached = queuedAttachmentPreviewCache.get(message.id);
  if (!cached?.length) return message;
  return {
    ...message,
    attachments: message.attachments.map((attachment, index) => {
      const preview = cached[index];
      if (!preview || preview.name !== attachment.name || preview.mimeType !== attachment.mimeType) return attachment;
      return {
        ...attachment,
        ...(attachment.dataUrl === undefined && preview.dataUrl !== undefined ? { dataUrl: preview.dataUrl } : {}),
        ...(attachment.durationSeconds === undefined && preview.durationSeconds !== undefined ? { durationSeconds: preview.durationSeconds } : {}),
      };
    }),
  };
}

function rememberQueuedAttachmentPreviews(message: QueuedMessageView, sources: readonly ComposerAttachment[], sessionId: string): void {
  if (!sources.length || !message.attachments.length) return;
  const unused = [...sources];
  const attachments = message.attachments.map((attachment) => {
    const index = unused.findIndex((source) => source.name === attachment.name && source.mimeType === attachment.mimeType && source.byteLength === attachment.byteLength);
    if (index < 0) return attachment;
    const [source] = unused.splice(index, 1);
    const previewable = source!.mimeType.toLowerCase().startsWith("image/") || source!.mimeType.toLowerCase().startsWith("audio/");
    return {
      ...attachment,
      ...(previewable ? { dataUrl: `data:${source!.mimeType};base64,${source!.dataBase64}` } : {}),
      ...("durationSeconds" in source! && typeof source!.durationSeconds === "number" ? { durationSeconds: source!.durationSeconds } : {}),
    };
  });
  if (!attachments.some((attachment, index) => attachment !== message.attachments[index])) return;
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

function QueuedAttachmentWidget({ attachment }: { attachment: QueuedAttachmentView }) {
  const image = attachment.mimeType.toLowerCase().startsWith("image/");
  const audio = attachment.mimeType.toLowerCase().startsWith("audio/");
  if (image && attachment.dataUrl) {
    return <span className="queued-attachment-widget queued-attachment-image" title={attachment.name}><img src={attachment.dataUrl} alt={attachment.name}/></span>;
  }
  if (audio && attachment.dataUrl) {
    return <AudioPlaybackChip className="queued-attachment-audio" name={attachment.name} dataUrl={attachment.dataUrl} durationSeconds={attachment.durationSeconds}/>;
  }
  return <span className={`queued-attachment-widget queued-attachment-${image ? "image-fallback" : audio ? "audio-fallback" : "file"}`} title={attachment.name}>
    {image ? <ScreenshotIcon/> : <FileIcon/>}<span>{attachment.name}</span>
  </span>;
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
  return <article className={`queued-message-row queued-message-${message.state}`} aria-label={`Queued instruction: ${queuedMessagePreview(message.content)}`} onContextMenu={(event) => {
    if (editing) return;
    event.preventDefault();
    setMenuOpen(true);
  }}>
    <span className="queued-state" aria-hidden="true">{message.state === "sending" ? <span className="spinner"/> : <QueueGlyph/>}</span>
    {editing ? <div className="queued-message-edit"><input autoFocus value={value} aria-label="Edit queued instruction" onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } else if (event.key === "Escape") setEditing(false); }}/><button type="button" disabled={saving || !value.trim()} onClick={() => void save()}>{saving ? <span className="spinner"/> : <CheckIcon/>}<span>Save</span></button></div> : <div className="queued-message-content">{message.attachments.length ? <div className="queued-attachment-widgets">{message.attachments.map((attachment, index) => <QueuedAttachmentWidget key={`${attachment.name}-${attachment.mimeType}-${index}`} attachment={attachment}/>)}</div> : null}<strong>{queuedMessagePreview(message.content)}</strong></div>}
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
          {efforts.length ? <label><small>Reasoning</small><select aria-label="Reasoning for new task" value={effort} onChange={(event) => setEffort(event.target.value)}>{efforts.map((item) => <option value={item} key={item}>{reasoningLabel(item, { providerId, modelId, displayName: selectedEntry?.model.name })}</option>)}</select></label> : null}
        </div>
      </> : <div className="chat-picker-empty"><strong>No Agent is ready to start a task</strong><small>Connect an Agent in Settings, then try again.</small></div>}
      <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="primary" type="button" disabled={!selectedEntry || saving} onClick={() => void start()}>{saving ? <span className="spinner"/> : <BranchIcon/>} Start task</button></footer>
    </section>
  </div>;
}

// Side chats are seeded by copying the parent transcript so the provider has
// the task's context; the bridge marks those copies with a `:copied:` id. The
// panel keeps that context out of sight so the chat reads as fresh.
export function visibleSideChatTimeline(timeline: readonly TimelineItem[]): readonly TimelineItem[] {
  return timeline.filter((item) => !item.id.includes(":copied:") && item.messageId?.startsWith("copied:") !== true);
}

// Below these sizes the composer and transcript stop being usable.
const sideChatMinimumWidth = 260;
const sideChatMinimumHeight = 180;

interface SideChatBounds { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

// The panel position is owned by the user, but the viewport is not: dragging
// or resizing can never push the panel off-screen.
function clampSideChatBounds(bounds: SideChatBounds): SideChatBounds {
  const width = Math.min(window.innerWidth, Math.max(bounds.width, sideChatMinimumWidth));
  const height = Math.min(window.innerHeight, Math.max(bounds.height, sideChatMinimumHeight));
  const left = Math.max(0, Math.min(bounds.left, Math.max(0, window.innerWidth - width)));
  const top = Math.max(0, Math.min(bounds.top, Math.max(0, window.innerHeight - height)));
  return { left, top, width, height };
}

interface SideChatTether {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly path: string | null;
  readonly mask: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
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
  const [dragging, setDragging] = useState(false);
  const [bounds, setBounds] = useState<SideChatBounds | null>(null);
  const [tether, setTether] = useState<SideChatTether>(() => ({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, path: null, mask: null }));
  const textarea = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null>(null);
  const resizeState = useRef<{ pointerId: number; startX: number; startY: number; startLeft: number; startTop: number; startWidth: number; startHeight: number } | null>(null);
  const tetherMaskId = useId().replaceAll(":", "");
  const visible = visibleSideChatTimeline(timeline);
  const restoreFocus = () => {
    const target = opener.current;
    if (target && target.isConnected) requestAnimationFrame(() => target.focus());
  };
  const closePanel = () => {
    restoreFocus();
    onClose();
  };
  const promote = async () => {
    try { await onPromote(); }
    finally { restoreFocus(); }
  };

  // Take over the placement App measured for this session, then own it: later
  // anchor updates from the task list are ignored so scrolling never moves
  // the panel again.
  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const wrapper = root.current?.parentElement;
    const rect = wrapper?.getBoundingClientRect();
    const width = Math.max(sideChatMinimumWidth, Math.min(window.innerWidth - 12, rect && rect.width > 0 ? rect.width : Math.min(430, window.innerWidth - 24)));
    const height = Math.max(sideChatMinimumHeight, Math.min(window.innerHeight - 12, rect && rect.height > 0 ? rect.height : Math.min(350, window.innerHeight - 84)));
    setBounds(clampSideChatBounds({ left: rect && rect.width > 0 ? rect.left : 12, top: rect && rect.height > 0 ? rect.top : 66, width, height }));
  }, []);

  const measureTether = useCallback(() => {
    setTether((current) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const parentSessionId = session.parentSessionId;
      if (!parentSessionId) return { ...current, viewportWidth, viewportHeight, path: null, mask: null };
      const panel = root.current;
      const list = document.querySelector<HTMLElement>(".session-list-scroll");
      if (!panel || !list) return { ...current, viewportWidth, viewportHeight, path: null, mask: null };
      const listBounds = list.getBoundingClientRect();
      // A collapsed list has no visible boundary to tether to.
      if (listBounds.width <= 0 || listBounds.height <= 0) return { ...current, viewportWidth, viewportHeight, path: null, mask: null };
      const rowBounds = list.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(parentSessionId)}"]`)?.getBoundingClientRect();
      const panelBounds = panel.getBoundingClientRect();
      // The origin stays pinned inside the visible list: when its row scrolls
      // out of view the line stops at the boundary instead of chasing it.
      const anchorX = listBounds.right;
      const rowCenterY = rowBounds && rowBounds.height > 0 ? rowBounds.top + rowBounds.height / 2 : listBounds.top + listBounds.height / 2;
      const anchorY = Math.max(listBounds.top + 4, Math.min(listBounds.bottom - 4, rowCenterY));
      const attachY = Math.max(panelBounds.top + 10, Math.min(panelBounds.bottom - 10, panelBounds.top + panelBounds.height / 2));
      const attachX = panelBounds.left + panelBounds.width / 2 > anchorX ? panelBounds.left : panelBounds.right;
      const midX = (anchorX + attachX) / 2;
      // Orthogonal elbow routing only: horizontal, vertical, horizontal.
      const path = `M ${anchorX} ${anchorY} H ${midX} V ${attachY} H ${attachX}`;
      const conversationBounds = document.querySelector<HTMLElement>(".conversation-scroll")?.getBoundingClientRect();
      const mask = conversationBounds && conversationBounds.width > 0 && conversationBounds.height > 0
        ? { x: conversationBounds.left - 6, y: conversationBounds.top - 6, width: conversationBounds.width + 12, height: conversationBounds.height + 12 }
        : null;
      return { viewportWidth, viewportHeight, path, mask };
    });
  }, [session.parentSessionId]);

  // Re-route whenever the panel lands somewhere new, and keep the line honest
  // while anything scrolls: capture-phase listening sees the task list scroll
  // without attaching to a particular container.
  useEffect(() => {
    measureTether();
  }, [bounds, measureTether]);
  useEffect(() => {
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measureTether); };
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
  }, [measureTether]);
  useEffect(() => {
    const clamp = () => setBounds((current) => current === null ? current : clampSideChatBounds(current));
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (bounds === null || event.button !== 0) return;
    // Header controls stay clickable; only the empty header starts a drag.
    if ((event.target as Element).closest("button")) return;
    event.preventDefault();
    dragState.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: bounds.left, startTop: bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const state = dragState.current;
    if (state === null) return;
    const left = state.startLeft + event.clientX - state.startX;
    const top = state.startTop + event.clientY - state.startY;
    setBounds((current) => current === null ? current : clampSideChatBounds({ ...current, left, top }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const pointerId = dragState.current?.pointerId;
    if (pointerId === undefined) return;
    if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
    dragState.current = null;
    setDragging(false);
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (bounds === null || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeState.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startLeft: bounds.left, startTop: bounds.top, startWidth: bounds.width, startHeight: bounds.height };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = resizeState.current;
    if (state === null) return;
    const width = Math.max(sideChatMinimumWidth, Math.min(window.innerWidth - state.startLeft, state.startWidth + event.clientX - state.startX));
    const height = Math.max(sideChatMinimumHeight, Math.min(window.innerHeight - state.startTop, state.startHeight + event.clientY - state.startY));
    setBounds((current) => current === null ? current : { ...current, width, height });
  };
  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointerId = resizeState.current?.pointerId;
    if (pointerId === undefined) return;
    if (event.currentTarget.hasPointerCapture(pointerId)) event.currentTarget.releasePointerCapture(pointerId);
    resizeState.current = null;
  };

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
  return <>
    {tether.path !== null ? <svg className="side-chat-connectors" width={tether.viewportWidth} height={tether.viewportHeight} viewBox={`0 0 ${tether.viewportWidth} ${tether.viewportHeight}`} aria-hidden="true">
      <defs>
        <filter id={`${tetherMaskId}-blur`} x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="9"/></filter>
        {/* The mask carves the transcript column out of the tether: fully
            invisible across the conversation, with a soft fade at each edge. */}
        <mask id={tetherMaskId} maskUnits="userSpaceOnUse">
          <rect width={tether.viewportWidth} height={tether.viewportHeight} fill="white"/>
          {tether.mask !== null ? <rect x={tether.mask.x} y={tether.mask.y} width={tether.mask.width} height={tether.mask.height} fill="black" filter={`url(#${tetherMaskId}-blur)`}/> : null}
        </mask>
      </defs>
      <path d={tether.path} mask={`url(#${tetherMaskId})`}/>
    </svg> : null}
    <section ref={root} className={`side-chat-panel ${dragging ? "dragging" : ""}`} role="dialog" aria-modal="false" aria-label="Side chat" style={bounds === null ? { visibility: "hidden" } : { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}>
      <header onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><span><ProviderLogo providerId={session.providerId} provider={provider} size={24}/><strong>Side chat</strong></span><div><Popover label="Side chat actions" className="side-chat-panel-menu" open={menuOpen} onOpen={setMenuOpen} trigger={<MoreIcon/>}><button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void promote(); }}><BranchIcon/><span><strong>Copy to full task</strong></span></button>{content || attachments.length ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDiscardDraft(); }}><XIcon/><span><strong>Discard draft</strong></span></button> : null}</Popover><button type="button" className="side-chat-promote" aria-label="Send findings to the parent task" data-tooltip="Send findings to the parent task" onClick={() => void promote()}><ArrowLeftIcon/></button><button type="button" aria-label="Close side chat" onClick={closePanel}><XIcon/></button></div></header>
      <div className="side-chat-transcript">{visible.length ? <ChatTimeline timeline={visible} providerId={session.providerId} provider={provider} active={sessionHoldsFollowUpQueue(session, visible)}/> : <p className="side-chat-context-note">This side chat already carries the parent task's context.</p>}</div>
      {attachments.length ? <div className="side-chat-attachments">{attachments.map((attachment) => <span key={attachment.path}><img src={`data:${attachment.mimeType};base64,${attachment.dataBase64}`} alt=""/><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onDraftChange((current) => ({ ...current, attachments: current.attachments.filter((item) => item.path !== attachment.path) }))}><XIcon/></button></span>)}</div> : null}
      <div className="side-chat-composer"><button type="button" aria-label="Attach image" data-tooltip="Attach image" onClick={() => void add()}><PlusIcon/></button><textarea ref={textarea} value={content} rows={1} placeholder="Ask about this task…" aria-label="Side chat message" onChange={(event) => onDraftChange((current) => ({ ...current, content: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}/><DictationControl providerId={session.providerId} request={request} notify={notify} onTranscript={(value) => onDraftChange((current) => ({ ...current, content: appendTranscript(current.content, value) }))}/><button className="side-chat-send" type="button" aria-label="Send side chat message" disabled={!content.trim() || sending} onClick={() => void send()}>{sending ? <span className="spinner"/> : <SendIcon/>}</button></div>
      <button type="button" className="side-chat-resize" aria-label="Resize side chat" data-tooltip="Resize side chat" onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}/>
    </section>
  </>;
}

type VisualAction = "browser" | "workflow";
// "settings" is the standalone route: /eyes opens the same picker with no
// queued action behind it, so configuring is the whole point rather than a
// gate in front of the browser or a workflow.
type VisionPickerMode = VisualAction | "settings";

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
  action: VisionPickerMode;
  onClose: () => void;
  onReady: (action: VisionPickerMode) => void;
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
    <header><span><strong>Choose a model as eyes</strong><small>{action === "settings" ? "Pick the model this task uses to read images." : `This text-only session needs visual support for ${action === "browser" ? "the browser" : "recorded workflows"}.`}</small></span><button type="button" aria-label="Close vision model selection" onClick={onClose}><XIcon /></button></header>
    {loading ? <div><LoadingState label="Loading vision models" /></div> : targets.length ? <div className="vision-picker-fields">
      <label><span>Provider</span><select aria-label="Vision provider" value={providerId} onChange={(event) => { const nextTarget = targets.find((item) => item.providerId === event.target.value); const nextModel = nextTarget?.models.find((item) => item.isDefault) ?? nextTarget?.models[0]; setProviderId(event.target.value); setModelId(nextModel?.id ?? ""); setEffort(visionReasoningEfforts(nextModel)[0] ?? ""); }}>{targets.map((item) => <option key={item.providerId} value={item.providerId}>{item.displayName}</option>)}</select></label>
      <label><span>Model</span><select aria-label="Vision model" value={modelId} onChange={(event) => { const nextModel = target?.models.find((item) => item.id === event.target.value); setModelId(event.target.value); setEffort(visionReasoningEfforts(nextModel)[0] ?? ""); }}>{target?.models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
      {efforts.length ? <label><span>Reasoning</span><select aria-label="Vision reasoning effort" value={effort} onChange={(event) => setEffort(event.target.value)}>{efforts.map((item) => <option key={item} value={item}>{reasoningLabel(item, { providerId, modelId, displayName: selectedModel?.displayName })}</option>)}</select></label> : null}
    </div> : <div className="chat-picker-empty"><strong>No image-capable model is ready</strong><small>Connect one in Settings, then try again.</small></div>}
    <footer><button type="button" onClick={onClose}>{action === "settings" ? "Cancel" : "Not now"}</button><button className="primary" type="button" disabled={loading || !providerId || !modelId || saving} onClick={() => void configure()}>{saving ? <span className="spinner" /> : <CheckIcon />} Use as eyes</button></footer>
  </section>;
}

function earsRoutesFromSnapshot(snapshot: DesktopSnapshot): readonly EarsAudioRoute[] {
  return snapshot.providers.flatMap((provider) => (snapshot.models[provider.id] ?? []).flatMap((model) => {
    const route = {
      providerId: provider.id,
      modelId: model.id,
      displayName: model.name,
      inputModalities: model.inputModalities ?? [],
      efforts: model.efforts,
    };
    return routeAcceptsEarsAudio(route) ? [route] : [];
  }));
}

function EarsSettingsPanel({ settings, routes, onChange, onClose }: {
  settings: EarsSettings;
  routes: readonly EarsAudioRoute[];
  onChange: (value: EarsSettings) => void;
  onClose: () => void;
}) {
  const selected = routes.find((route) => route.providerId === settings.providerId && route.modelId === settings.modelId);
  const effort = selected ? lowestReasoningEffort(selected.efforts) : undefined;
  const effortNote = reasoningLabelForNote(effort, selected ? { providerId: selected.providerId, modelId: selected.modelId, displayName: selected.displayName } : {});
  return <div className="ears-settings" role="dialog" aria-label="EARS settings">
    <header>
      <span><strong>EARS</strong><small>Dictation audio is sent to this model first. The destination agent receives only the resulting text.</small></span>
      <button type="button" aria-label="Close EARS settings" onClick={onClose}><XIcon /></button>
    </header>
    <label className="ears-toggle">
      <input type="checkbox" checked={settings.enabled} onChange={(event) => onChange({ ...settings, enabled: event.target.checked })} />
      <span>Preprocess dictation before send</span>
    </label>
    <label>
      <span>Model</span>
      <select
        aria-label="EARS model"
        value={selected ? `${selected.providerId}:${selected.modelId}` : ""}
        disabled={routes.length === 0}
        onChange={(event) => {
          const [providerId, ...rest] = event.target.value.split(":");
          const modelId = rest.join(":");
          onChange({ ...settings, enabled: true, providerId: providerId || null, modelId: modelId || null });
        }}
      >
        <option value="">{routes.length ? "Choose an audio-capable model" : "No audio-capable model is available"}</option>
        {routes.map((route) => <option key={`${route.providerId}:${route.modelId}`} value={`${route.providerId}:${route.modelId}`}>{route.displayName}</option>)}
      </select>
    </label>
    <fieldset>
      <legend>Processing</legend>
      <label><input type="radio" name="ears-mode" checked={settings.mode === "cleaned"} onChange={() => onChange({ ...settings, mode: "cleaned" })} /><span><strong>Cleaned</strong><small>Turn the recording into a clear written prompt while keeping the speaker’s meaning.</small></span></label>
      <label><input type="radio" name="ears-mode" checked={settings.mode === "verbatim"} onChange={() => onChange({ ...settings, mode: "verbatim" })} /><span><strong>Verbatim</strong><small>Transcribe the recording as faithfully as possible.</small></span></label>
    </fieldset>
    {effortNote ? <p className="ears-reasoning-note">Uses {effortNote} reasoning automatically</p> : null}
  </div>;
}

export function Composer({ snapshot, session, request, selectImages, preview, notify, updateSnapshot, onBrowser, onManageWorkflow, initialDraft, onDraftChange, initialAttachments = [], onAttachmentsChange, initialAnnotations = [], onAnnotationsChange, onDerivedSession, onDraftSelectionChange, onCreateDraftSend, experimental, onInstantSession, onCreateSideChat, queueRevision = 0, queueingEnabled, onQueueingEnabledChange, agentDefaults = {}, ears = defaultEarsSettings, onEarsChange, onInterrupt }: ComposerProps) {
  const [content, setContent] = useState(initialDraft);
  const draftChangeRef = useRef(onDraftChange);
  const attachmentsChangeRef = useRef(onAttachmentsChange);
  const annotationsChangeRef = useRef(onAnnotationsChange);
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const draftSession = session.draft === true;
  const [providerId, setProviderId] = useState(session.providerId);
  const models = snapshot.models[providerId] ?? [];
  const initialSelection = resolveConcreteModelSelection(models, { modelId: session.model, reasoningEffort: session.effort }, agentDefaults[session.providerId]);
  const [model, setModel] = useState(initialSelection?.modelId ?? resolveComposerModelId(models, session.model));
  const [effort, setEffort] = useState(initialSelection?.reasoningEffort ?? "");
  // The composer can mount before the provider's model catalogue arrives (the
  // supervised OpenCode server starts asynchronously), freezing the selection
  // on a placeholder id. When the catalogue lands, re-resolve from the session
  // so the model picker and the reasoning choice show the real model and level.
  useEffect(() => {
    if (models.some((item) => item.id === model || item.name === model)) return;
    const resolved = resolveConcreteModelSelection(models, { modelId: session.model, reasoningEffort: session.effort }, agentDefaults[session.providerId]);
    if (!resolved) return;
    setModel(resolved.modelId);
    setEffort(resolved.reasoningEffort ?? "");
  }, [agentDefaults, model, models, session.effort, session.model, session.providerId]);
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(() => initialAttachments);
  const [annotations, setAnnotations] = useState<readonly ResponseAnnotation[]>(() => initialAnnotations);
  const [annotationEditor, setAnnotationEditor] = useState<{ annotation: ResponseAnnotation; anchor: { x: number; y: number } } | null>(null);
  const dictationControl = useRef<DictationControlHandle>(null);
  const [dictationPhase, setDictationPhase] = useState<"idle" | "recording" | "transcribing" | "audio-recording">("idle");
  const [dictationCommitRevision, setDictationCommitRevision] = useState(0);
  const sendAfterDictationRevision = useRef<number | null>(null);
  const [workflowAttachments, setWorkflowAttachments] = useState<readonly WorkflowAttachment[]>([]);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [earsOpen, setEarsOpen] = useState(false);
  const [earsBusy, setEarsBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const earsRequestId = useRef<string | null>(null);
  const earsCancelled = useRef(false);
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
  const [visionAction, setVisionAction] = useState<VisionPickerMode | null>(null);
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [meshTargets, setMeshTargets] = useState<readonly MeshTarget[]>([]);
  const [meshOpen, setMeshOpen] = useState(false);
  const [meshModelPicker, setMeshModelPicker] = useState<Session["providerId"] | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<SelectedImage | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<readonly QueuedMessageView[]>([]);
  const transportQueueSuppressions = useRef<readonly TransportQueueSuppression[]>([]);
  const [queuedNewTaskMessage, setQueuedNewTaskMessage] = useState<QueuedMessageView | null>(null);
  const [cancellingQueuedId, setCancellingQueuedId] = useState<string | null>(null);
  const [updatingQueuedId, setUpdatingQueuedId] = useState<string | null>(null);
  const [deriving, setDeriving] = useState(false);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [simplifySettings, setSimplifySettings] = useState<SimplifySettings>(() => storedSimplifySettings());
  const [simplifyOpen, setSimplifyOpen] = useState(false);
  const [slashSelection, setSlashSelection] = useState(0);
  const [slashPaletteDismissed, setSlashPaletteDismissed] = useState(false);
  const slashListId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const attachmentList = useRef<HTMLDivElement>(null);
  const audioStripHost = useRef<HTMLDivElement>(null);
  const interruptingRef = useRef(false);
  const promptHistory = useRef<readonly string[]>(storedPromptHistory());
  const historyIndex = useRef<number | null>(null);
  const unsentHistoryDraft = useRef(initialDraft);
  const chosenModel = models.find((item) => item.id === model);
  const efforts = [...new Set([...(chosenModel?.efforts ?? []).filter((item) => !isAmbiguousSelectionValue(item)), ...(!isAmbiguousSelectionValue(effort) ? [effort] : [])])];
  const provider = providerFor(snapshot.providers, providerId);
  const audioDictationAvailable = providerAcceptsDirectAudio(providerId) && modelAcceptsDirectAudio(chosenModel);
  // Recording an MP3 is offered wherever the clip can reach the model: either the
  // model hears it directly, or EARS transcribes it first. Gating the control on
  // direct audio alone hid the microphone from every text-only harness.
  const earsCanCarryAudio = ears.enabled && earsRoutesFromSnapshot(snapshot).length > 0;
  const audioRecordingAvailable = audioDictationAvailable || earsCanCarryAudio;
  const timeline = snapshot.timelines[session.id] ?? [];
  const holdsFollowUpQueue = sessionHoldsFollowUpQueue(session, timeline);
  const turnInFlight = useRef(false);
  const canSend = canSendToProvider(provider, { draft: draftSession, canCreateDraft: onCreateDraftSend !== undefined });
  /**
   * Ask the harness itself, rather than trusting what we last wrote down.
   *
   * Whether a coding tool can take a message is read from a snapshot the window
   * holds, and that snapshot is only rebuilt on a few occasions. Any moment the
   * tool could not answer - a restart, a stalled read, a probe that lost a race
   * with the server this app starts - is written into it, and it stays written
   * until something happens to rebuild it. So a tool that is up and healthy could
   * sit there refusing to be written to, which no amount of waiting fixed. A
   * stale note is not allowed to be the last word on this: the tool is asked
   * again, and only its own answer can refuse the message.
   */
  const reverifyProvider = useCallback(async (): Promise<Provider | undefined> => {
    const providers = await refreshProviders();
    const fresh = providers.find((entry) => entry.id === providerId);
    // Only this provider is written back, so a connector the workspace has
    // deliberately hidden cannot reappear on the strength of a send.
    if (fresh) updateSnapshot((current) => current ? { ...current, providers: current.providers.map((entry) => entry.id === fresh.id ? fresh : entry) } : current);
    return fresh;
  }, [providerId, updateSnapshot]);
  // A composer that believes it cannot send checks that belief once, immediately,
  // so the control comes back on its own instead of waiting for a relaunch.
  useEffect(() => {
    if (canSend || preview) return;
    let abandoned = false;
    void reverifyProvider().catch(() => undefined).finally(() => { if (abandoned) return; });
    return () => { abandoned = true; };
  }, [canSend, preview, reverifyProvider]);
  const canSteer = !draftSession && canSend && holdsFollowUpQueue && session.state === "working" && provider?.capabilities.includes("Steering") === true;
  const canInterrupt = !draftSession && holdsFollowUpQueue && provider?.capabilities.includes("Interrupt") === true && onInterrupt !== undefined;
  const canAttach = canSend && provider?.supportsAttachments === true;
  const canAttachFiles = canSend && provider?.supportsAttachments === true && supportsGenericFileAttachments(providerId);
  const canDelegate = snapshot.providers.some((item) => item.id !== session.providerId && item.state === "online" && item.capabilities.includes("Create Session") && item.capabilities.includes("Send Message"));
  const meshPickerProvider = meshModelPicker === null ? null : providerFor(snapshot.providers, meshModelPicker);
  const meshEditingTarget = meshPickerProvider ? meshTargets.find((target) => target.providerId === meshPickerProvider.id) : undefined;
  const simplifyCommand = useMemo(() => parseSimplifyCommand(content), [content]);
  const slashSuggestions = useMemo(() => slashCommandSuggestions(content), [content]);
  const slashPaletteVisible = !slashPaletteDismissed && slashSuggestions !== null;
  const simplifyPreset = [100, 200, 300].includes(simplifySettings.maxWords) ? String(simplifySettings.maxWords) : "custom";

  const loadQueuedMessages = useCallback(async () => {
    if (draftSession) { setQueuedMessages([]); return; }
    try {
      const result = await request("message_queue.list", { sessionId: session.id });
      const messages = queuedMessagesForSession(result, session.id);
      const visible = visibleTransportQueueMessages(messages, transportQueueSuppressions.current);
      forgetMissingQueuedAttachmentPreviews(session.id, visible);
      setQueuedMessages(visible);
    } catch {
      // Queue visibility is opportunistic; send failures still surface through the normal composer notice.
    }
  }, [draftSession, request, session.id]);

  useEffect(() => { if (mode === "steer" && !canSteer) setMode("queue"); }, [canSteer, mode]);
  useEffect(() => {
    if (!sessionHoldsFollowUpQueue(session, snapshot.timelines[session.id] ?? [])) turnInFlight.current = false;
  }, [session, snapshot.timelines]);
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
  useEffect(() => {
    if (draftSession || isAmbiguousSelectionValue(session.effort)) return;
    const selection = resolveConcreteModelSelection(models, { modelId: session.model, reasoningEffort: session.effort }, agentDefaults[providerId]);
    const nextEffort = selection?.reasoningEffort ?? "";
    if (!nextEffort) return;
    setEffort(nextEffort);
  }, [agentDefaults, draftSession, models, providerId, session.effort, session.model]);
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
  useEffect(() => { annotationsChangeRef.current = onAnnotationsChange; }, [onAnnotationsChange]);
  useEffect(() => { attachmentsChangeRef.current?.(attachments); }, [attachments]);
  useEffect(() => { annotationsChangeRef.current?.(annotations); }, [annotations]);
  useEffect(() => { setAnnotations(initialAnnotations); }, [initialAnnotations]);
  useEffect(() => { void loadQueuedMessages(); }, [loadQueuedMessages, queueRevision]);
  useEffect(() => {
    try { localStorage.setItem(simplifySettingsKey, JSON.stringify(simplifySettings)); } catch { /* Preferences remain usable for this window. */ }
  }, [simplifySettings]);
  useEffect(() => { if (!simplifyCommand.active) setSimplifyOpen(false); }, [simplifyCommand.active]);
  useEffect(() => { setSlashSelection(0); }, [content]);
  useEffect(() => {
    if (!/^\/ears\s*$/iu.test(content)) return;
    setEarsOpen(true);
    setContent("");
    historyIndex.current = null;
    unsentHistoryDraft.current = "";
  }, [content]);
  useEffect(() => {
    // Same shape as /ears: a settings route, not a message. Unlike the reactive
    // prompt, this opens whatever the task's current visual support is, because
    // asking for it is the user's explicit intent.
    if (draftSession || !/^\/eyes\s*$/iu.test(content)) return;
    setVisionAction("settings");
    setContent("");
    historyIndex.current = null;
    unsentHistoryDraft.current = "";
  }, [content, draftSession]);
  useEffect(() => {
    // Opening the panel must not consume what the user typed. The command stays
    // in the composer and the panel is bound to it: the moment the text stops
    // reading /mesh - another letter, a backspace, the start of the real
    // instruction - the panel closes again. Referenced tools are not discarded
    // with it; they live on the composer as chips.
    if (draftSession) return;
    setMeshOpen(/^\/mesh\s*$/iu.test(content));
  }, [content, draftSession]);
  useEffect(() => {
    if (!meshOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (meshModelPicker !== null) setMeshModelPicker(null);
      else setMeshOpen(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [meshModelPicker, meshOpen]);
  useEffect(() => {
    if (!attachmentPreview) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setAttachmentPreview(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [attachmentPreview]);

  const addImages = useCallback((images: readonly SelectedImage[]) => {
    const next = appendAttachmentsWithinLimits(attachments, images.map((image) => ({ ...image, origin: image.origin ?? "file-picker" })));
    setAttachments(next.items);
    if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
    else if (next.rejectedForCount) notify("You can attach up to four items per message.", "error");
    return next;
  }, [attachments, notify]);

  const addFiles = useCallback((files: readonly SelectedFile[]) => {
    const next = appendAttachmentsWithinLimits(attachments, files.map((file) => ({ ...file, origin: file.origin ?? "file-picker" })));
    setAttachments(next.items);
    if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
    else if (next.rejectedForCount) notify("You can attach up to four items per message.", "error");
    return next;
  }, [attachments, notify]);

  const addAudio = useCallback((audio: SelectedAudio) => {
    const next = appendAttachmentsWithinLimits(attachments, [audio]);
    setAttachments(next.items);
    if (next.rejectedForBytes) notify("Attachments can total up to 50 MiB per message.", "error");
    else if (next.rejectedForCount) notify("You can attach up to four items per message.", "error");
    return next.acceptedCount > 0;
  }, [attachments, notify]);

  const cancelEarsTranscription = useCallback(() => {
    earsCancelled.current = true;
    const requestId = earsRequestId.current;
    if (!requestId) return;
    void request("ears.cancel", { requestId }).catch(() => undefined);
  }, [request]);

  const onComposerDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dropActive) setDropActive(true);
  };

  const onComposerDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setDropActive(false);
  };

  const onComposerDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    const dropped = [...event.dataTransfer.files];
    if (!dropped.length) return;
    const images: SelectedImage[] = [];
    const files: SelectedFile[] = [];
    try {
      for (const file of dropped) {
        if (file.size <= 0 || file.size > 25 * 1024 * 1024) throw new Error("Dropped files must be between 1 byte and 25 MiB.");
        const kind = classifyDroppedFile(file);
        if (kind === "image") {
          if (!canAttach) throw new Error(`${provider?.name ?? "This coding tool"} does not support image attachments.`);
          const uploadable = await blobToUploadable(file, file.name || "dropped-image.png");
          images.push({ ...uploadable, path: `drag-drop:${Date.now()}:${file.name}`, origin: "drag-drop" });
        } else if (canAttachFiles) {
          const uploadable = await blobToUploadable(file, file.name || "dropped-file");
          files.push({ ...uploadable, kind: "file", path: `drag-drop:${Date.now()}:${file.name}`, origin: "drag-drop" });
        } else {
          throw new Error("Drop an image, or switch to OpenCode to attach other files.");
        }
      }
      if (images.length) addImages(images);
      if (files.length) {
        const added = addFiles(files);
        if (added.acceptedCount > 0 && !added.rejectedForBytes && !added.rejectedForCount) notify(added.acceptedCount === 1 ? "File attached" : `${added.acceptedCount} files attached`);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const onPaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    if (!canAttach) { notify(`${provider?.name ?? "This coding tool"} does not support image attachments.`, "error"); return; }
    try {
      const images = await Promise.all(files.slice(0, 4).map(async (file, index) => {
        if (file.size <= 0 || file.size > 25 * 1024 * 1024) throw new Error("Pasted images must be between 1 byte and 25 MiB.");
        const uploadable = await blobToUploadable(file, file.name || `pasted-image-${index + 1}.png`);
        return { ...uploadable, path: `clipboard:${Date.now()}:${index}`, origin: "clipboard" } satisfies SelectedImage;
      }));
      const added = addImages(images);
      if (added.acceptedCount > 0 && !added.rejectedForBytes && !added.rejectedForCount) notify(added.acceptedCount === 1 ? "Pasted image attached" : `${added.acceptedCount} pasted images attached`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const submit = async () => {
    // /mesh stays visible while the panel is open, so strip it before it can be
    // mistaken for the instruction.
    const trimmed = content.trim().replace(/^\/mesh\b\s*/iu, "").trim();
    if (sending || earsBusy || (!trimmed && meshTargets.length === 0 && annotations.length === 0 && !attachments.some(isDictationAudioAttachment))) return;
    setSending(true);
    if (meshTargets.length > 0) {
      try {
        // An empty prompt is a deliberate mesh send: the bridge and the parent
        // agent compose the instruction, so the send control stays enabled.
        await request("delegation.start", { parentSessionId: session.id, prompt: trimmed, targets: meshTargets.map((target) => ({ ...target })) });
        setMeshTargets([]);
        setMeshModelPicker(null);
        setMeshOpen(false);
        setContent("");
        notify("Mesh delegation started");
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        setSending(false);
        textarea.current?.focus();
      }
      return;
    }
    const pendingUploadIds: string[] = [];
    let optimisticId: string | null = null;
    let transportSuppressionToken: string | null = null;
    try {
      if (!canSend) {
        const fresh = await reverifyProvider().catch(() => undefined);
        const usable = fresh?.detected === true
          && fresh.capabilities.includes("Send Message")
          && (!draftSession || fresh.capabilities.includes("Create Session"));
        if (!usable) throw new Error(`${fresh?.name ?? provider?.name ?? "This coding tool"} cannot accept messages right now.`);
      }
      const imageAttachments = attachments.filter((attachment): attachment is SelectedImage => !isSelectedFile(attachment) && !isSelectedAudio(attachment));
      const fileAttachments = attachments.filter(isSelectedFile);
      const messageDictationClips = attachments.filter(isDictationAudioAttachment);
      const annotationClips = annotations.flatMap((annotation) => annotation.audio ? [annotation.audio] : []);
      const dictationClips = [...messageDictationClips, ...annotationClips];
      const combinedAttachments = [...attachments, ...annotationClips];
      const shouldUseEars = ears.enabled && dictationClips.length > 0 && !audioDictationAvailable;
      const outgoingAttachments = shouldUseEars
        ? combinedAttachments.filter((attachment) => !isDictationAudioAttachment(attachment))
        : combinedAttachments;
      const outgoingAudio = outgoingAttachments.filter(isSelectedAudio);
      if (imageAttachments.length && !canAttach) throw new Error(`${provider?.name ?? "This coding tool"} does not support image attachments.`);
      if (fileAttachments.length && !canAttachFiles) throw new Error("Generic file attachments are available only for OpenCode.");
      if (outgoingAudio.length && !audioDictationAvailable) throw new Error(`${chosenModel?.name ?? "This model"} does not accept direct audio.`);
      if (!ears.enabled && dictationClips.length && !audioDictationAvailable) {
        throw new Error(`${chosenModel?.name ?? "This model"} does not accept direct audio. Enable EARS or choose an audio-capable model.`);
      }
      if (combinedAttachments.length > 4) throw new Error("You can attach up to four items per message, including voice annotations.");
      if (combinedAttachments.some((attachment) => attachment.byteLength <= 0 || attachment.byteLength > 25 * 1024 * 1024)) throw new Error("Attachments must be between 1 byte and 25 MiB each.");
      if (combinedAttachments.reduce((total, attachment) => total + attachment.byteLength, 0) > maximumMessageAttachmentBytes) throw new Error("Attachments can total up to 50 MiB per message.");
      const simplified = simplifySubmission(trimmed, simplifySettings);
      let messageContent = simplified.content;
      let submissionAnnotations = annotations;
      if (shouldUseEars) {
        const routes = earsRoutesFromSnapshot(snapshot);
        const configurationError = earsConfigurationError(ears, routes, dictationClips.map((clip) => ({
          id: clip.path,
          mimeType: clip.mimeType,
          origin: "dictation",
        })));
        if (configurationError) {
          setEarsOpen(true);
          throw new Error(configurationError);
        }
        setEarsBusy(true);
        earsCancelled.current = false;
        const requestId = newEarsRequestId();
        earsRequestId.current = requestId;
        try {
          const dictationIds = await uploadAttachments(dictationClips, uploadRequest(request), (id) => pendingUploadIds.push(id));
          if (earsCancelled.current) throw new Error(earsCancelledMessage);
          const processed = await request("ears.process", {
            providerId: ears.providerId ?? "",
            modelId: ears.modelId ?? "",
            mode: ears.mode,
            attachmentIds: [...dictationIds],
            requestId,
            ...(draftSession ? {} : { sessionId: session.id }),
          });
          const texts = Array.isArray(processed.texts) ? processed.texts.filter((item): item is string => typeof item === "string") : [];
          if (texts.length !== dictationClips.length) throw new Error("EARS did not return text for every dictation recording.");
          const messageTexts = texts.slice(0, messageDictationClips.length);
          const annotationTexts = texts.slice(messageDictationClips.length);
          messageContent = composeEarsDestinationText(simplified.content, messageTexts);
          let annotationIndex = 0;
          submissionAnnotations = annotations.map((annotation) => annotation.audio
            ? { id: annotation.id, text: annotation.text, annotation: appendTranscript(annotation.annotation, annotationTexts[annotationIndex++] ?? "") }
            : annotation);
          if (!messageContent.trim() && !submissionAnnotations.some((annotation) => annotation.annotation.trim())) throw new Error("EARS did not hear any speech.");
          pendingUploadIds.length = 0;
        } finally {
          setEarsBusy(false);
          earsRequestId.current = null;
        }
      }
      const attachmentIds = outgoingAttachments.length ? await uploadAttachments(outgoingAttachments, uploadRequest(request), (id) => pendingUploadIds.push(id)) : [];
      const annotationAudioCount = submissionAnnotations.filter((annotation) => annotation.audio).length;
      const transportContent = serializeResponseAnnotations(messageContent, submissionAnnotations, outgoingAudio.length - annotationAudioCount);
      const workflowItems = workflowAttachments.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        eventCount: workflow.summary.eventCount,
        screenshotCount: workflow.summary.screenshotCount,
        ...(workflow.summary.apps.length ? { applications: [...workflow.summary.apps] } : {}),
      }));
      // A plain send announces nothing. Your message appearing in the transcript is
      // already the confirmation, so a card saying so is one more thing to read and
      // dismiss for the most ordinary action there is. The cases below survive
      // because each one reports something the transcript does not show by itself.
      let sentLabel: string | null = null;
      if (draftSession) {
        if (!onCreateDraftSend) throw new Error("This local draft cannot be created right now.");
        await onCreateDraftSend({
          draftSessionId: session.id,
          providerId,
          workingDirectory: session.workingDirectory,
          content: transportContent,
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
          content: transportContent,
          ...(model !== "default" ? { modelId: model } : {}),
          ...(effort ? { reasoningEffort: effort.toLowerCase() } : {}),
          ...(attachmentIds.length ? { attachmentIds: [...attachmentIds] } : {}),
          ...(workflowAttachments.length ? { workflowIds: workflowAttachments.map((workflow) => workflow.id) } : {}),
          ...(simplified.simplify !== undefined ? { simplify: simplified.simplify } : {}),
        };
        const blockedByAttention = holdsFollowUpQueue || turnInFlight.current || transportQueueSuppressions.current.length > 0;
        const liveGuidance = mode === "steer" || (!queueingEnabled && canSteer);
        const requestType = composerMessageRequestType({
          liveGuidance,
          hasAttachments: combinedAttachments.length > 0,
          blockedByAttention,
          queueingEnabled,
          externalWriter: session.externalWriter === true,
          externalWriterAttachmentsSupported: providerId === "codex",
        });
        const optimisticNotes = fileAttachments.map((attachment) => `Attached file: ${attachment.name}`);
        const annotationAudioPaths = new Set(submissionAnnotations.flatMap((annotation) => annotation.audio ? [annotation.audio.path] : []));
        const visibleOutgoingAudio = outgoingAudio.filter((attachment) => !annotationAudioPaths.has(attachment.path));
        const optimisticAnnotations = submissionAnnotations.map(({ id, text, annotation, audio }) => ({
          id,
          text,
          annotation,
          ...(audio ? { audio: { name: audio.name, mimeType: audio.mimeType, dataUrl: `data:${audio.mimeType};base64,${audio.dataBase64}`, durationSeconds: audio.durationSeconds, dictation: true } } : {}),
        }));
        const optimistic: TimelineItem = { id: `local-${Date.now()}`, kind: "user", body: optimisticNotes.length ? `${messageContent}\n\n${optimisticNotes.join("\n")}` : messageContent, ...(optimisticAnnotations.length ? { annotations: optimisticAnnotations } : {}), ...(imageAttachments.length ? { images: imageAttachments.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}` })) } : {}), ...(visibleOutgoingAudio.length ? { audio: visibleOutgoingAudio.map((attachment) => ({ name: attachment.name, mimeType: attachment.mimeType, dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`, durationSeconds: attachment.durationSeconds, dictation: isDictationAudioAttachment(attachment) })) } : {}), ...(workflowItems.length ? { workflows: workflowItems } : {}), timestamp: new Date().toISOString(), state: "completed" };
        const queuedSubmission = requestType === "message_queue.enqueue";
        const transportOnlySubmission = queuedSubmission && session.externalWriter === true && !blockedByAttention;
        const appearsInTranscript = composerSubmissionAppearsInTranscript(requestType, transportOnlySubmission);
        if (transportOnlySubmission) {
          transportSuppressionToken = `transport-${optimistic.id}`;
          transportQueueSuppressions.current = [...transportQueueSuppressions.current, {
            token: transportSuppressionToken,
            content: transportContent,
          }];
        }
        if (!queuedSubmission) turnInFlight.current = true;
        if (appearsInTranscript) {
          optimisticId = optimistic.id;
          updateSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [session.id]: [...(current.timelines[session.id] ?? []), optimistic] }, sessions: current.sessions.map((item) => item.id === session.id ? { ...item, state: queuedSubmission ? item.state : "working", preview: simplified.content, updatedAt: optimistic.timestamp, model, ...(effort ? { effort } : {}) } : item) } : current);
        }
        const response = await request(requestType, payload);
        if (queuedSubmission) {
          const queued = queuedMessagesForSession({ messages: [response.message] }, session.id)[0];
          if (queued) {
            rememberQueuedAttachmentPreviews(queued, outgoingAttachments, session.id);
            if (transportOnlySubmission && transportSuppressionToken) {
              // Queue list reads can resolve out of order. Keep acknowledged ids
              // for this mounted task instead of treating one stale empty read as
              // proof of consumption; native queue ids are unique and the bounded
              // set disappears when the task composer unmounts.
              transportQueueSuppressions.current = acknowledgeTransportQueueSuppression(transportQueueSuppressions.current, transportSuppressionToken, queued.id).slice(-32);
              setQueuedMessages((current) => visibleTransportQueueMessages(current, transportQueueSuppressions.current));
            } else {
              setQueuedMessages((current) => current.some((item) => item.id === queued.id) ? current : [...current, queued]);
            }
          }
          // The queue acknowledgement is already authoritative. Refresh its controls
          // in the background so neither the transcript row nor composer clearing waits
          // on a second Desktop IPC round trip.
          void loadQueuedMessages();
        }
        sentLabel = requestType === "session.steer_message" ? "Task steered" : null;
        optimisticId = null;
      }
      pendingUploadIds.length = 0;
      promptHistory.current = rememberPrompt(trimmed, promptHistory.current);
      historyIndex.current = null;
      unsentHistoryDraft.current = "";
      setContent(""); setAttachments([]); setAnnotations([]); setAttachmentPreview(null); setWorkflowAttachments([]);
      if (sentLabel !== null) notify(sentLabel);
    } catch (error) {
      if (transportSuppressionToken) {
        transportQueueSuppressions.current = transportQueueSuppressions.current.filter((suppression) => suppression.token !== transportSuppressionToken);
        void loadQueuedMessages();
      }
      if (optimisticId) {
        updateSnapshot((current) => current ? { ...current, timelines: { ...current.timelines, [session.id]: (current.timelines[session.id] ?? []).filter((item) => item.id !== optimisticId) } } : current);
      }
      await Promise.all(pendingUploadIds.map((uploadId) => request("attachment.upload.cancel", { uploadId }).catch(() => undefined)));
      if (isEarsCancelledError(error)) notify("Transcription cancelled");
      else notify(error instanceof Error ? error.message : String(error), "error");
    } finally { setSending(false); textarea.current?.focus(); }
  };
  const dictationRecording = dictationPhase === "recording" || dictationPhase === "audio-recording";
  useEffect(() => {
    const expectedRevision = sendAfterDictationRevision.current;
    if (expectedRevision === null || dictationPhase !== "idle" || dictationCommitRevision < expectedRevision) return;
    sendAfterDictationRevision.current = null;
    void submit();
  }, [dictationCommitRevision, dictationPhase]);
  const interrupt = async () => {
    if (onInterrupt === undefined || interruptingRef.current) return;
    interruptingRef.current = true;
    setInterrupting(true);
    try {
      await onInterrupt();
    } finally {
      interruptingRef.current = false;
      setInterrupting(false);
      textarea.current?.focus();
    }
  };
  const primaryAction = () => {
    if (dictationRecording) {
      sendAfterDictationRevision.current = dictationCommitRevision + 1;
      dictationControl.current?.stop();
      return;
    }
    const stopTask = canInterrupt && !content.trim() && annotations.length === 0 && !attachments.some(isDictationAudioAttachment);
    if (stopTask) void interrupt();
    else void submit();
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
    const queuedIndex = queuedMessages.findIndex((message) => message.id === messageId);
    const queuedMessage = queuedIndex >= 0 ? queuedMessages[queuedIndex] : undefined;
    // Delivery can emit the canonical user history row before its IPC response
    // resolves. Remove the queue row before crossing that boundary so React can
    // commit the queue-to-transcript handoff atomically in one painted frame.
    // A failed delivery restores the exact item at its original position.
    if (queuedMessage) setQueuedMessages((current) => current.filter((message) => message.id !== messageId));
    setUpdatingQueuedId(messageId);
    try {
      const result = await request("message_queue.deliver", { messageId, mode: canSteer ? "steer" : "send" });
      if (result.delivered !== true) throw new Error("That queued instruction could not be delivered.");
      queuedAttachmentPreviewCache.delete(messageId);
      queuedAttachmentPreviewOwners.delete(messageId);
      await loadQueuedMessages();
      if (canSteer) notify("Task steered");
    } catch (error) {
      if (queuedMessage) {
        setQueuedMessages((current) => {
          if (current.some((message) => message.id === messageId)) return current;
          const insertAt = Math.min(queuedIndex, current.length);
          return [...current.slice(0, insertAt), queuedMessage, ...current.slice(insertAt)];
        });
      }
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
    if (command.id === "ears") {
      setEarsOpen(true);
      setSlashPaletteDismissed(false);
      setContent("");
      historyIndex.current = null;
      unsentHistoryDraft.current = "";
      return;
    }
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
    if (event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0 && meshTargets.length && !draftSession) {
      // The mesh widget sits on the message line itself, so backing onto it
      // deletes it like the word it replaced - the newest target goes first.
      event.preventDefault();
      removeMeshTarget(meshTargets[meshTargets.length - 1]!.providerId);
      return;
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
    const nextAudioAvailable = providerAcceptsDirectAudio(nextProviderId) && modelAcceptsDirectAudio(nextModels.find((item) => item.id === resolvedModelId));
    if (!nextAudioAvailable && attachments.some(isSelectedAudio)) {
      const nextAttachments = filterAttachmentsForDestination(attachments, false, ears.enabled);
      setAttachments(nextAttachments);
      if (nextAttachments.length !== attachments.length) {
        notify(nextAttachments.some(isDictationAudioAttachment)
          ? "Audio that this model cannot hear was removed."
          : "Audio recordings were removed for this model.");
      }
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
  const openMeshModelPicker = (nextProviderId: Session["providerId"]) => {
    // The bridge accepts at most four targets per delegation.
    if (meshTargets.length >= maximumMeshTargets) return;
    setMeshModelPicker(nextProviderId);
  };
  const commitMeshTarget = (target: MeshTarget) => {
    setMeshTargets((current) => {
      const exists = current.some((item) => item.providerId === target.providerId);
      const next = exists ? current.map((item) => item.providerId === target.providerId ? target : item) : [...current, target];
      return next.slice(0, maximumMeshTargets);
    });
    setMeshModelPicker(null);
    // The /mesh text is the command, not the message: the first committed target
    // consumes it, and the target takes its place inline in the entry row. The
    // panel closes with the text, exactly like the command palette would.
    setContent("");
    historyIndex.current = null;
    unsentHistoryDraft.current = "";
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const removeMeshTarget = (targetProviderId: Session["providerId"]) => {
    setMeshTargets((current) => current.filter((target) => target.providerId !== targetProviderId));
  };
  const closeMesh = () => {
    // Closing the chooser is not the same as abandoning the mesh. The chips stay
    // on the composer so the user can write the instruction they are for; each
    // chip removes itself, and sending clears them.
    setMeshOpen(false);
    setMeshModelPicker(null);
  };
  const continueVisualAction = (action: VisionPickerMode) => {
    setVisionAction(null);
    // /eyes is a settings command: there is nothing queued to resume afterwards,
    // so saying the choice landed is the whole feedback the user needs.
    if (action === "settings") { notify("Vision model saved for this task"); return; }
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
    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); setEarsOpen(true); }}><MicrophoneIcon /><span><strong>EARS settings</strong><small>Preprocess dictation before the destination agent</small></span></button>
    <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onManageWorkflow(); }}><SlidersIcon /><span><strong>Manage workflows</strong><small>Review recordings in Settings</small></span></button>
    {experimental && onInstantSession && !draftSession ? <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onInstantSession(); }}><MicrophoneIcon /><span><strong>Instant session</strong><small>Speak with synchronized screen and pointer evidence</small></span></button> : null}
  </>;
  const stopTaskAvailable = canInterrupt && !dictationRecording && !content.trim() && annotations.length === 0 && !attachments.some(isDictationAudioAttachment) && !meshTargets.length;
  const nothingToSend = !content.trim() && annotations.length === 0 && !attachments.some(isDictationAudioAttachment);

  return <div className="composer-wrap">
    {queuedNewTaskMessage ? createPortal(<QueuedNewTaskPicker
      snapshot={snapshot}
      sourceSession={session}
      message={queuedNewTaskMessage}
      agentDefaults={agentDefaults}
      onClose={() => setQueuedNewTaskMessage(null)}
      onSubmit={(selection) => moveQueuedToNewTask(queuedNewTaskMessage, selection)}
    />, document.body) : null}
    {annotationEditor ? <ResponseAnnotationEditor
      selectedText={annotationEditor.annotation.text}
      initial={annotationEditor.annotation}
      anchor={annotationEditor.anchor}
      providerId={providerId}
      request={request}
      notify={notify}
      directAudioAvailable={audioDictationAvailable}
      earsEnabled={ears.enabled}
      onClose={() => setAnnotationEditor(null)}
      onSave={(next) => { setAnnotations((current) => current.map((item) => item.id === next.id ? next : item)); setAnnotationEditor(null); }}
    /> : null}
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
    <div className={`composer-box${dropActive ? " composer-drop-active" : ""}`} onDragEnter={onComposerDragOver} onDragOver={onComposerDragOver} onDragLeave={onComposerDragLeave} onDrop={(event) => void onComposerDrop(event)}>
      <ComposerSurfaceOutline />
      <div className="composer-footer" aria-label="Message options">
        <ModelPicker snapshot={snapshot} providerId={providerId} sessionModel={providerId === session.providerId ? session.model : ""} value={model} allowProviderChange={draftSession} onChange={selectComposerModel} />
        {effort && efforts.length ? <ChoiceMenu value={effort} options={efforts.map((item) => ({ value: item, label: reasoningLabel(item, { providerId, modelId: model, displayName: chosenModel?.name }) }))} onChange={selectComposerEffort} label="Choose reasoning effort" className="effort-choice" triggerDescription="Reasoning" /> : null}
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
      {meshOpen && !draftSession ? <div className="mesh-panel-anchor">
        <MeshPanel snapshot={snapshot} session={session} targets={meshTargets} onAdd={openMeshModelPicker} onClose={closeMesh} />
      </div> : null}
      {meshPickerProvider && !draftSession ? <div className="mesh-panel-anchor">
        <MeshModelPicker snapshot={snapshot} provider={meshPickerProvider} {...(meshEditingTarget ? { existing: meshEditingTarget } : {})} onCommit={commitMeshTarget} onClose={() => setMeshModelPicker(null)} />
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
      {annotations.length ? <div className="composer-annotation-chips" role="list" aria-label="Response annotations">{annotations.map((annotation, index) => <ComposerAnnotationChip
        key={annotation.id}
        annotation={annotation}
        index={index}
        onEdit={(anchor) => setAnnotationEditor({ annotation, anchor })}
        onRemove={() => setAnnotations((current) => current.filter((item) => item.id !== annotation.id))}
      />)}</div> : null}
      {attachments.length || workflowAttachments.length ? <div className="attachment-chips" ref={attachmentList} aria-label="Draft attachments">
        {attachments.map((attachment) => isSelectedAudio(attachment)
          ? <AudioPlaybackChip key={attachment.path} name={attachment.name} dataUrl={`data:${attachment.mimeType};base64,${attachment.dataBase64}`} dictation={isDictationAudioAttachment(attachment)} durationSeconds={attachment.durationSeconds} onRemove={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))} />
          : isSelectedFile(attachment)
          ? <span className="file-attachment-chip" key={attachment.path}><FileIcon /><span><strong>{attachment.name}</strong><small>{Math.ceil(attachment.byteLength / 1024)} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}><XIcon /></button></span>
          : <span className="image-attachment-chip" key={attachment.path}><button type="button" className="attachment-thumbnail" title={`Preview ${attachment.name}`} aria-label={`Preview ${attachment.name}`} onClick={() => setAttachmentPreview(attachment)}><img src={`data:${attachment.mimeType};base64,${attachment.dataBase64}`} alt=""/></button><span><strong>{attachment.name}</strong><small>{Math.ceil(attachment.byteLength / 1024)} KB</small></span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))}><XIcon /></button></span>)}
        {workflowAttachments.map((attachment) => <span className="workflow-attachment-chip" key={attachment.id}><button type="button" className="workflow-chip-link" title="View workflow details" onClick={() => onManageWorkflow(attachment.id)}><WorkflowIcon /><span><strong>{attachment.name}</strong><small>Recorded workflow</small></span></button><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setWorkflowAttachments((current) => current.filter((item) => item.id !== attachment.id))}><XIcon /></button></span>)}
      </div> : null}
      {earsOpen ? <EarsSettingsPanel settings={ears} routes={earsRoutesFromSnapshot(snapshot)} onChange={(value) => { void onEarsChange?.(value); }} onClose={() => setEarsOpen(false)} /> : null}
      {earsBusy ? <div className="ears-progress" role="status" aria-live="polite">
        <span>Transcribing dictation…</span>
        <button type="button" className="ears-cancel" onClick={cancelEarsTranscription}>Cancel transcription</button>
      </div> : null}
      <div className="dictation-audio-strip-host" ref={audioStripHost} />
      <div className="composer-entry-row">
        <Popover label="Add attachment" className="composer-attachment-menu" open={attachmentsOpen} onOpen={(open) => { setAttachmentsOpen(open); if (open) setActionsOpen(false); }} trigger={<PlusIcon />}>{attachmentActions}</Popover>
        {meshTargets.length && !draftSession ? <span className="composer-inline-mesh" role="list" aria-label="Referenced coding tools">
          {meshTargets.map((target) => {
            const provider = snapshot.providers.find((candidate) => candidate.id === target.providerId);
            const name = provider?.name ?? target.providerId;
            const modelLabel = meshTargetModelLabel(snapshot, target);
            const effortLabel = reasoningLabel(target.reasoningEffort ?? "", { providerId: target.providerId, modelId: target.modelId, displayName: modelLabel });
            return <span className="composer-mesh-widget" role="listitem" key={target.providerId}>
              <button type="button" className="composer-mesh-widget-body" aria-label={`Edit ${name} target`} onClick={() => openMeshModelPicker(target.providerId)}>
                <span className="composer-mesh-widget-text"><strong>{modelLabel}</strong>{effortLabel ? <span className="composer-mesh-widget-effort">· {effortLabel}</span> : null}</span>
              </button>
              <button type="button" className="composer-mesh-widget-remove" aria-label={`Remove ${name} from mesh`} onClick={() => removeMeshTarget(target.providerId)}><XIcon /></button>
            </span>;
          })}
        </span> : null}
        <textarea id="composer-message" ref={textarea} value={content} onChange={(event) => { historyIndex.current = null; unsentHistoryDraft.current = event.target.value; setSlashPaletteDismissed(false); setContent(event.target.value); }} onPaste={(event) => void onPaste(event)} onKeyDown={onKeyDown} placeholder={draftSession ? "Describe the task…" : meshOpen ? "Optional instruction for the mesh…" : holdsFollowUpQueue ? "Add an instruction…" : "Continue this task…"} rows={1} aria-label="Message" aria-expanded={slashPaletteVisible} aria-controls={slashPaletteVisible ? slashListId : undefined} aria-activedescendant={slashPaletteVisible && slashSuggestions?.length ? `${slashListId}-${slashSuggestions[Math.min(slashSelection, slashSuggestions.length - 1)]!.id}` : undefined}/>
        <div className="composer-primary-actions">
          <Popover label="More message actions" className="composer-actions-menu" open={actionsOpen} onOpen={(open) => { setActionsOpen(open); if (open) setAttachmentsOpen(false); }} trigger={<MoreIcon />}>{actions}</Popover>
          <DictationControl providerId={providerId} ref={dictationControl} request={request} notify={notify} onTranscript={(transcript) => { setContent((current) => appendTranscript(current, transcript)); requestAnimationFrame(() => textarea.current?.focus()); }} onAudio={(audio) => { addAudio(audio); requestAnimationFrame(() => textarea.current?.focus()); }} audioDictationAvailable={audioRecordingAvailable} directToModel={audioDictationAvailable} liveStripHost={audioStripHost} onPhaseChange={setDictationPhase} onCommit={() => setDictationCommitRevision((current) => current + 1)} onSettled={(committed) => { if (!committed) sendAfterDictationRevision.current = null; }}/>
          <IconButton
            label={interrupting ? "Stopping task" : dictationRecording ? "Stop dictation and send" : meshTargets.length ? "Send mesh delegation" : stopTaskAvailable ? "Stop task" : draftSession ? "Start task" : mode === "steer" ? "Steer task" : "Send instruction"}
            className={`send-button ${stopTaskAvailable ? "stop-button" : ""}`}
            /* Never disabled by what we last wrote down about the harness. That note
               can be wrong - it is rebuilt on a handful of occasions and any moment the
               tool could not answer gets written into it - and a disabled control gives
               a person nothing to press and no reason why, so a message simply vanished
               on the way out. Pressing send now always attempts it, and the attempt asks
               the harness itself; a real refusal comes back in the harness's own words. */
            disabled={sending || interrupting || dictationPhase === "transcribing" || (meshTargets.length ? false : !dictationRecording && !stopTaskAvailable && nothingToSend)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.click(); } }}
            onClick={primaryAction}
          >{sending || interrupting ? <span className="spinner" /> : stopTaskAvailable ? <StopIcon /> : mode === "steer" && !dictationRecording ? <SlidersIcon /> : <SendIcon />}</IconButton>
        </div>
      </div>
    </div>
  </div>;
}
