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

function ProviderGlyph({ providerId }: { providerId: ProviderId }) {
  switch (providerId) {
    case "codex": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5H5v5m11-5h3v5M8 19H5v-5m11 5h3v-5"/><path d="M9 9h6v6H9z"/></svg>;
    case "opencode": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 9-8 9-8-9z"/><path d="m8.5 12 3.5-4 3.5 4-3.5 4z"/></svg>;
    case "grok": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7c4-4 10-4 14 0M5 17c4 4 10 4 14 0M7 5c-4 4-4 10 0 14m10-14c4 4 4 10 0 14"/><circle cx="12" cy="12" r="2"/></svg>;
    case "pi": return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M8 9h8M10 9v7m4-7v7"/></svg>;
    case "omp": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 8 4-3 4 3 4-3 4 3M4 16l4 3 4-3 4 3 4-3M8 9v6m8-6v6"/></svg>;
    case "qwen": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 7 4v8l-7 6-7-6V7z"/><path d="m5 8 7 4 7-4M12 12v8"/></svg>;
    case "goose": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15c4-1 6-4 8-9 1 4 3 6 8 7-3 4-7 6-12 5"/><path d="m15 8 4-2-1 4"/></svg>;
    case "kimi": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 4a8.5 8.5 0 1 0 3 13 7 7 0 0 1-3-13Z"/><circle cx="17.5" cy="8" r="1"/></svg>;
    case "hermes": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M5 7l7 4 7-4M5 17l7-4 7 4"/><path d="m5 7 2-3m12 3-2-3m-10 16-2-3m12 3 2-3"/></svg>;
    case "cline": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5-6 7 6 7m6-14 6 7-6 7"/><path d="M11 16 14 8"/></svg>;
    case "copilot": return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M4 14c2 5 14 5 16 0M10 9h4"/></svg>;
    case "direct": return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7H5a3 3 0 0 0 0 6h3m8-6h3a3 3 0 0 1 0 6h-3M8 10h8M8 14h8"/><path d="m13 3-3 7h4l-3 7"/></svg>;
    default: return null;
  }
}

export function ProviderLogo({ providerId, provider, size = 28, tooltip }: { providerId: ProviderFilter; provider?: Pick<Provider, "id" | "name" | "iconDataUrl"> | undefined; size?: number; tooltip?: string | false }) {
  if (providerId === "all") return <span className="provider-logo provider-logo-all" {...(tooltip === false ? {} : { "data-tooltip": tooltip ?? "All agents" })} style={{ width: size, height: size }}><GridIcon /></span>;
  const name = providerDisplayName(providerId, provider);
  const icon = provider?.iconDataUrl;
  const accessibleName = providerId === "codex" ? "OpenAI Codex" : name;
  const glyph = ProviderGlyph({ providerId });
  return <span className="provider-logo" data-provider-id={providerId} {...(tooltip === false ? {} : { "data-tooltip": tooltip ?? accessibleName })} style={{ width: size, height: size }} aria-label={`${accessibleName} provider`}>{icon ? <img src={icon} alt="" /> : glyph ?? <span>{providerInitials(name)}</span>}</span>;
}

export function ProviderLabel({ providerId, provider, secondary }: { providerId: ProviderFilter; provider?: Pick<Provider, "id" | "name" | "iconDataUrl"> | undefined; secondary?: string }) {
  return <span className="provider-label"><ProviderLogo providerId={providerId} provider={provider} /><span><strong>{providerDisplayName(providerId, provider)}</strong>{secondary ? <small>{secondary}</small> : null}</span></span>;
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

export function Status({ state, compact = false }: { state: SessionState; compact?: boolean }) {
  const icon = state === "needs_approval" ? <ShieldIcon /> : state === "needs_input" ? <QuestionIcon /> : state === "failed" ? <AlertIcon /> : state === "completed" ? <CheckIcon /> : state === "working" ? <span className="spinner" /> : <span className="status-dot" />;
  const visibleLabel = state !== "idle" && state !== "working";
  return <span className={`status status-${state} ${compact ? "status-compact" : ""}`} aria-label={statusLabel(state)} title={statusLabel(state)}>{icon}{visibleLabel ? <span>{statusLabel(state)}</span> : null}</span>;
}

export function relativeTime(value: string): string {
  const delta = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d`;
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

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeRef.current(); }}><section ref={dialog} className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" {...(label ? { "aria-label": label } : title ? { "aria-labelledby": titleId } : {})} tabIndex={-1} onKeyDown={handleKeyDown}>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}{title ? <h2 id={titleId}>{title}</h2> : null}{children}</section></div>;
}

export function Toast({ message, tone = "normal" }: { message: string; tone?: "normal" | "error" }) {
  return <div className={`toast toast-${tone}`} role="status">{tone === "error" ? <AlertIcon /> : <CheckIcon />}<span>{message}</span></div>;
}
