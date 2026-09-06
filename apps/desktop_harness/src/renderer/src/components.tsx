import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  AgentIcon,
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  CommandIcon,
  FileIcon,
  GridIcon,
  QuestionIcon,
  ShieldIcon,
  TerminalIcon,
  ToolIcon,
} from "./icons";
import type { Provider, ProviderFilter, ProviderId, SessionState, TimelineKind } from "./types";

export function Button({ className = "", variant = "secondary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function IconButton({ label, className = "", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function fallbackProviderName(providerId: ProviderId): string {
  const words = providerId
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean);
  return words.length ? words.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ") : "Unknown coding tool";
}

export function providerDisplayName(providerId: ProviderFilter, provider?: Pick<Provider, "id" | "name"> | undefined): string {
  if (providerId === "all") return "All coding tools";
  return provider?.name.trim() || fallbackProviderName(providerId);
}

function providerInitials(name: string): string {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean);
  if (words.length > 1) return `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
  const word = words[0] ?? "?";
  return (word.length <= 3 ? word : word[0] ?? "?").toUpperCase();
}

// Recognition comes from the truthful harness name, a restrained colour cue,
// and this one Tethoq-owned typographic family—not copied provider geometry.
const TETHOQ_HARNESS_MONOGRAMS: Readonly<Record<string, string>> = {
  codex: "CX",
  opencode: "OC",
  grok: "G",
  pi: "π",
  omp: "OMP",
  qwen: "Q",
  goose: "g",
  kimi: "K",
  hermes: "H",
  cline: "CL",
  copilot: "CP",
  direct: "API",
};

const TETHOQ_HARNESS_ALIASES: Readonly<Record<string, string>> = {
  "oh-my-pi": "omp",
  "qwen-code": "qwen",
  "kimi-code": "kimi",
  "hermes-agent": "hermes",
  "github-copilot": "copilot",
  "github-copilot-cli": "copilot",
};

function canonicalHarnessId(providerId: ProviderId): string {
  const normalized = providerId.trim().toLowerCase();
  return TETHOQ_HARNESS_ALIASES[normalized] ?? normalized;
}

function providerMonogram(providerId: ProviderId, name: string): string {
  return TETHOQ_HARNESS_MONOGRAMS[canonicalHarnessId(providerId)] ?? providerInitials(name);
}

function providerMonogramFontSize(monogram: string, size: number): number {
  const scale = monogram.length === 1 ? .54 : monogram.length === 2 ? .41 : .33;
  return Math.max(8, Math.round(size * scale * 10) / 10);
}

export function ProviderLogo({ providerId, provider, size = 28, tooltip }: { providerId: ProviderFilter; provider?: Pick<Provider, "id" | "name" | "iconDataUrl"> | undefined; size?: number; tooltip?: string | false }) {
  if (providerId === "all") return <span className="provider-logo provider-logo-all" {...(tooltip === false ? {} : { "data-tooltip": tooltip ?? "All agents" })} style={{ width: size, height: size }}><GridIcon /></span>;
  const name = providerDisplayName(providerId, provider);
  const accessibleName = providerId === "codex" ? "OpenAI Codex" : name;
  const monogram = providerMonogram(providerId, name);
  return <span className="provider-logo" data-provider-id={canonicalHarnessId(providerId)} {...(tooltip === false ? {} : { "data-tooltip": tooltip ?? accessibleName })} style={{ width: size, height: size, fontSize: providerMonogramFontSize(monogram, size) }} aria-label={`${accessibleName} provider`}><span className="provider-monogram" data-monogram-length={monogram.length} aria-hidden="true">{monogram}</span></span>;
}

export function ProviderLabel({ providerId, provider, secondary, logoSize }: { providerId: ProviderFilter; provider?: Pick<Provider, "id" | "name" | "iconDataUrl"> | undefined; secondary?: string; logoSize?: number }) {
  return <span className="provider-label"><ProviderLogo providerId={providerId} provider={provider} {...(logoSize === undefined ? {} : { size: logoSize })} /><span><strong>{providerDisplayName(providerId, provider)}</strong>{secondary ? <small>{secondary}</small> : null}</span></span>;
}

export function SelectMenu<T extends string>({ value, options, onChange, label, className = "" }: {
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode; description?: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  if (!selected) return null;
  return (
    <div className={`select-menu ${className}`} ref={ref}>
      <button className="select-trigger" aria-label={label} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((current) => !current)}>
        <span className="select-trigger-content">{selected.icon}<span><strong>{selected.label}</strong>{selected.description ? <small>{selected.description}</small> : null}</span></span>
        <ChevronDownIcon />
      </button>
      {open ? <div className="select-popover" id={menuId} role="listbox">
        {options.map((option) => <button key={option.value} role="option" aria-selected={option.value === value} disabled={option.disabled} onClick={() => { onChange(option.value); setOpen(false); }}>
          {option.icon}<span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>{option.value === value ? <CheckIcon className="option-check" /> : null}
        </button>)}
      </div> : null}
    </div>
  );
}

export const statusLabel = (state: SessionState): string => ({
  working: "Working",
  needs_approval: "Approval",
  needs_input: "Input",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  offline: "Offline",
})[state];

export function Status({ state, compact = false, showLabel = false }: { state: SessionState; compact?: boolean; showLabel?: boolean }) {
  const icon = state === "needs_approval" ? <ShieldIcon /> : state === "needs_input" ? <QuestionIcon /> : state === "failed" ? <AlertIcon /> : state === "completed" ? <CheckIcon /> : state === "working" ? <span className="spinner" /> : <span className="status-dot" />;
  const visibleLabel = showLabel || (state !== "idle" && state !== "working");
  return <span className={`status status-${state} ${compact ? "status-compact" : ""}`} aria-label={statusLabel(state)} title={statusLabel(state)}>{icon}{visibleLabel ? <span>{statusLabel(state)}</span> : null}</span>;
}

export function relativeTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "now";
  const delta = Math.max(0, Date.now() - parsed);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export const timelineIcon = (kind: TimelineKind): ReactNode => {
  switch (kind) {
    case "tool": return <ToolIcon />;
    case "command": return <TerminalIcon />;
    case "file": return <FileIcon />;
    case "subagent": return <AgentIcon />;
    case "error": return <AlertIcon />;
    case "reasoning": return <CommandIcon />;
    default: return null;
  }
};

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function LoadingState({ label = "Loading your coding tools" }: { label?: string }) {
  return <div className="loading-state" role="status"><span className="large-spinner" /><strong>{label}</strong><small>Connecting to your coding tools on this computer…</small></div>;
}

export function ErrorBanner({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return <div className="error-banner" role="alert"><AlertIcon /><div><strong>{title}</strong><p>{message}</p></div>{onRetry ? <Button onClick={onRetry}>Try again</Button> : null}</div>;
}

const focusableSelector = "a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

export function Modal({ title, label, eyebrow, children, onClose, wide = false }: { title: string; label?: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  closeRef.current = onClose;

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = dialog.current?.querySelector<HTMLElement>(focusableSelector);
    (first ?? dialog.current)?.focus();
    return () => {
      const target = opener.current;
      if (target && target.isConnected) target.focus();
    };
  }, []);

  useLayoutEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (!dialog.current?.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener("mousedown", closeOutside, true);
    return () => document.removeEventListener("mousedown", closeOutside, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
      .filter((item) => item.offsetParent !== null || item === document.activeElement);
    if (!items.length) {
      event.preventDefault();
      dialog.current?.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return <div className="modal-backdrop" role="presentation"><section ref={dialog} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" {...(label ? { "aria-label": label } : title ? { "aria-labelledby": titleId } : {})} tabIndex={-1} onKeyDown={handleKeyDown}>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}{title ? <h2 id={titleId}>{title}</h2> : null}{children}</section></div>;
}

export function Toast({ message, tone = "normal" }: { message: string; tone?: "normal" | "error" }) {
  return <div className={`toast toast-${tone}`} role="status">{tone === "error" ? <AlertIcon /> : <CheckIcon />}<span>{message}</span></div>;
}
