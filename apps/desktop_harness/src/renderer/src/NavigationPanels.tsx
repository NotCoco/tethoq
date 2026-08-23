import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { TaskOverride } from "@shared/desktop_api";
import { MAX_TASK_TITLE_CHARACTERS } from "@shared/desktop_api";
import { EmptyState, ProviderLogo, providerDisplayName, relativeTime } from "./components";
import { listChildSessions } from "./bridge";
import { ArchiveIcon, BranchIcon, ChatIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, FolderIcon, GridIcon, InfoIcon, PinIcon, PlusIcon, RenameIcon, SearchIcon, SettingsIcon, SlidersIcon, XIcon } from "./icons";
import { maximumUiSearchCharacters } from "./search_helpers";
import type { Provider, ProviderFilter, ProviderFilterSelection, ProviderId, Session, SessionState } from "./types";

export type NavigationView = "workspace" | "dashboard" | "browser" | "settings";
export type SessionFilter = "all" | SessionState;

const stateOrder: SessionFilter[] = ["all", "working", "needs_approval", "needs_input", "idle", "completed", "failed", "offline"];
const stateLabels: Record<SessionFilter, string> = {
  all: "Any status",
  working: "Working",
  needs_approval: "Needs approval",
  needs_input: "Needs input",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  offline: "Offline",
};

const providerFor = (providers: Provider[], providerId: string): Provider | undefined =>
  providers.find((provider) => provider.id === providerId);

const AVAILABLE_PROVIDER_FILTER = "available";

function providerFilterKeys(selection: ProviderFilterSelection): ProviderId[] {
  if (selection === "all") return [];
  return Array.isArray(selection) ? [...selection] : [selection as ProviderId];
}

function AvailableAgentsIcon() {
  return <svg className="available-agents-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M4 19c.5-4 2.2-6 5-6s4.5 2 5 6"/><path d="m14.5 11.5 2 2 3.5-4"/></svg>;
}

function OverflowReveal({ axis, className, children }: { axis: "horizontal" | "vertical"; className: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  useEffect(() => {
    const measure = () => {
      const outer = root.current;
      const inner = content.current;
      if (!outer || !inner) return;
      setDistance(Math.max(0, axis === "horizontal" ? inner.scrollWidth - outer.clientWidth : inner.scrollHeight - outer.clientHeight));
    };
    if (typeof ResizeObserver === "undefined") { measure(); return; }
    const observer = new ResizeObserver(measure);
    if (root.current) observer.observe(root.current);
    if (content.current) observer.observe(content.current);
    measure();
    return () => observer.disconnect();
  }, [axis, children]);
  const pixelsPerSecond = axis === "vertical" ? 18 : 28;
  const duration = distance / pixelsPerSecond;
  return <div ref={root} className={`overflow-reveal overflow-reveal-${axis} ${className}`} data-overflow={distance > 1 || undefined} style={{ "--overflow-distance": `${Math.ceil(distance)}px`, "--overflow-duration": `${duration.toFixed(2)}s` } as CSSProperties}><span ref={content}>{children}</span></div>;
}

export interface SidebarProps {
  sessions: Session[];
  allSessions: Session[];
  providers: Provider[];
  selected: string | null;
  selectedProvider: ProviderFilterSelection;
  query: string;
  stateFilter: SessionFilter;
  view: NavigationView;
  connected: boolean;
  hostName: string;
  /** Shown in the runtime indicator's own info box rather than stamped on the rail. */
  appVersion?: string | undefined;
  onQuery: (value: string) => void;
  onFilter: (value: SessionFilter) => void;
  onProvider: (value: ProviderFilterSelection) => void;
  onOpen: (id: string) => void;
  onOpenChild: (session: Session) => void;
  onBranch: (id: string) => void;
  onOpenDirectory: (path: string) => void;
  onView: (view: NavigationView) => void;
  onNewTask: () => void;
  onCommandSearch: () => void;
  showSideChats: boolean;
  activeSideChatIds: readonly string[];
  onShowSideChats: (value: boolean) => void;
  onCreateSideChat: (parentSessionId: string) => Promise<void>;
  onOpenSideChat: (sessionId: string, anchor: SideChatAnchor) => void;
  onSideChatAnchor: (sessionId: string, anchor: SideChatAnchor) => void;
  showArchived: boolean;
  archivedCount: number;
  onShowArchived: (value: boolean) => void;
  onTaskOverride: (sessionId: string, override: TaskOverride) => void;
}

export interface SideChatAnchor { readonly x: number; readonly y: number }

export function Sidebar({ sessions, allSessions, providers, selected, selectedProvider, query, stateFilter, view, connected, hostName, appVersion, onQuery, onFilter, onProvider, onOpen, onOpenChild, onBranch, onOpenDirectory, onView, onNewTask, onCommandSearch, showSideChats, activeSideChatIds, onShowSideChats, onCreateSideChat, onOpenSideChat, onSideChatAnchor, showArchived, archivedCount, onShowArchived, onTaskOverride }: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{ sessionId: string; title: string; workingDirectory: string; x: number; y: number } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const searchRegion = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const sessionMenuElement = useRef<HTMLDivElement>(null);
  const sessionList = useRef<HTMLDivElement>(null);
  const [expandedSideChatParents, setExpandedSideChatParents] = useState<ReadonlySet<string>>(() => new Set());
  const [sideChatInfoParent, setSideChatInfoParent] = useState<string | null>(null);
  const selectedProviderKeys = providerFilterKeys(selectedProvider);
  const activeFilterCount = selectedProviderKeys.length + Number(stateFilter !== "all");
  const searchExpanded = searchOpen || Boolean(query);
  const filterSummary = [
    selectedProviderKeys.length ? selectedProviderKeys.map((providerId) => providerId === AVAILABLE_PROVIDER_FILTER ? "Available agents" : providerDisplayName(providerId, providerFor(providers, providerId))).join(" + ") : null,
    stateFilter !== "all" ? stateLabels[stateFilter] : null,
  ].filter(Boolean).join(", ");
  const menuSession = sessionMenu ? allSessions.find((session) => session.id === sessionMenu.sessionId) : undefined;
  const menuProvider = menuSession ? providerFor(providers, menuSession.providerId) : undefined;
  const canBranchMenuSession = connected && menuSession?.draft !== true && menuSession?.state !== "offline" && menuProvider?.detected === true && menuProvider.state === "online" && menuProvider.capabilities.includes("Create Session") && menuProvider.capabilities.includes("Send Message") && menuProvider.capabilities.includes("Session History");
  const providerOptions = useMemo(() => {
    const known = new Set(providers.map((provider) => provider.id));
    const unavailable = [...new Set(allSessions.map((session) => session.providerId).filter((providerId) => !known.has(providerId)))];
    return [
      { id: "all", label: "All agents", provider: undefined, available: true, kind: "all" as const },
      { id: AVAILABLE_PROVIDER_FILTER, label: "Available agents", provider: undefined, available: true, kind: "available" as const },
      ...providers.map((provider) => ({ id: provider.id, label: provider.name, provider, available: provider.detected, kind: "provider" as const })),
      ...unavailable.map((providerId) => ({ id: providerId, label: providerDisplayName(providerId), provider: undefined, available: false, kind: "provider" as const })),
    ];
  }, [allSessions, providers]);
  const sideChatsByParent = useMemo(() => {
    const grouped = new Map<string, Session[]>();
    for (const sideChat of allSessions) {
      if (sideChat.sessionKind !== "side_chat" || !sideChat.parentSessionId) continue;
      const current = grouped.get(sideChat.parentSessionId) ?? [];
      current.push(sideChat);
      grouped.set(sideChat.parentSessionId, current);
    }
    for (const items of grouped.values()) items.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return grouped;
  }, [allSessions]);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (searchRegion.current?.contains(event.target as Node)) return;
      setFiltersOpen(false);
      if (!query && activeFilterCount === 0) setSearchOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [activeFilterCount, query]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !searchRegion.current?.contains(document.activeElement)) return;
      event.preventDefault();
      if (filtersOpen) {
        setFiltersOpen(false);
        filterButton.current?.focus();
      } else if (query) {
        onQuery("");
      } else if (activeFilterCount === 0) {
        setSearchOpen(false);
        searchInput.current?.blur();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [activeFilterCount, filtersOpen, onQuery, query]);

  useEffect(() => {
    if (!sessionMenu) return;
    sessionMenuElement.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!sessionMenuElement.current?.contains(event.target as Node)) setSessionMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSessionMenu(null);
      }
    };
    const close = () => setSessionMenu(null);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [sessionMenu]);

  useEffect(() => {
    if (!activeSideChatIds.length) return;
    const list = sessionList.current;
    if (!list) return;
    let frame = 0;
    const report = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const listBounds = list.getBoundingClientRect();
        for (const sessionId of activeSideChatIds) {
          const sideChat = allSessions.find((session) => session.id === sessionId);
          const sideElement = list.querySelector<HTMLElement>(`[data-side-chat-id="${CSS.escape(sessionId)}"]`);
          const parentElement = sideChat?.parentSessionId ? list.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sideChat.parentSessionId)}"]`) : null;
          const bounds = (sideElement ?? parentElement)?.getBoundingClientRect();
          const rawY = bounds ? bounds.top + bounds.height / 2 : listBounds.top;
          onSideChatAnchor(sessionId, { x: listBounds.right, y: Math.max(listBounds.top + 4, Math.min(listBounds.bottom - 4, rawY)) });
        }
      });
    };
    report();
    list.addEventListener("scroll", report, { passive: true });
    window.addEventListener("resize", report);
    return () => { window.cancelAnimationFrame(frame); list.removeEventListener("scroll", report); window.removeEventListener("resize", report); };
  }, [activeSideChatIds, allSessions, onSideChatAnchor, showSideChats]);

  const chooseProvider = (value: ProviderFilter) => { onProvider(value); setFiltersOpen(false); };
  const toggleProvider = (value: ProviderId) => {
    const next = selectedProviderKeys.includes(value)
      ? selectedProviderKeys.filter((providerId) => providerId !== value)
      : [...selectedProviderKeys, value];
    onProvider(next.length ? next : "all");
  };
  const chooseState = (value: SessionFilter) => { onFilter(value); setFiltersOpen(false); };
  const openTaskSearch = () => {
    setSearchOpen(true);
    window.requestAnimationFrame(() => searchInput.current?.focus());
  };
  return <aside className={`sidebar sidebar-view-${view}`}>
    <div className="new-task-row">
      <button className="new-task-button" onClick={onNewTask} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onNewTask(); } }} aria-label="New task"><PlusIcon /><span>New task</span></button>
      <button className="sidebar-command-search" type="button" onClick={onCommandSearch} aria-label="Search tasks or run a command" data-tooltip="Commands · Ctrl K"><SearchIcon /></button>
    </div>
    <nav className="primary-nav" aria-label="Primary">
      {/* Highlight follows the pointer, matching Settings. The current view stays
          announced for assistive tech without a permanent lit-up chip. */}
      <button {...(view === "dashboard" ? { "aria-current": "page" as const } : {})} onClick={() => onView("dashboard")}><GridIcon /><span>Dashboard</span></button>
    </nav>

    <section className="sidebar-tasks" aria-label="Tasks">
      <header className="sidebar-task-header">
        <h2>Tasks</h2>
        <div className="sidebar-task-tools" ref={searchRegion}>
          <div className="sidebar-task-search" data-expanded={searchExpanded} role="search">
            <button type="button" className="sidebar-task-search-trigger" aria-label="Search tasks" aria-expanded={searchExpanded} aria-controls="sidebar-task-search-input" data-tooltip={searchExpanded ? undefined : "Search tasks"} onClick={openTaskSearch}><SearchIcon /></button>
            <input ref={searchInput} id="sidebar-task-search-input" tabIndex={searchExpanded ? 0 : -1} value={query} maxLength={maximumUiSearchCharacters} onChange={(event) => onQuery(event.target.value.slice(0, maximumUiSearchCharacters))} placeholder="Search tasks" aria-label="Search tasks" />
            {query ? <button type="button" className="task-search-clear" aria-label="Clear search" data-tooltip="Clear" onClick={() => { onQuery(""); searchInput.current?.focus(); }}><XIcon /></button> : null}
          </div>
          <button ref={filterButton} type="button" className={filtersOpen || activeFilterCount ? "sidebar-task-filter active" : "sidebar-task-filter"} aria-label={filterSummary ? `Task filters: ${filterSummary}` : "Filter tasks"} aria-expanded={filtersOpen} data-tooltip={filterSummary || "Filter tasks"} onClick={() => setFiltersOpen((current) => !current)}><SlidersIcon />{activeFilterCount ? <b>{activeFilterCount}</b> : null}</button>
          {filtersOpen ? <div className="task-filter-popover" role="dialog" aria-label="Task filters">
            <section><header><strong>Agent</strong>{selectedProviderKeys.length ? <button onClick={() => chooseProvider("all")}>Clear</button> : null}</header><div className="task-filter-options provider-options" role="group" aria-label="Agent filters">{providerOptions.map((option) => {
              const isSingleSelection = !Array.isArray(selectedProvider) && selectedProvider === option.id;
              const isIncluded = selectedProviderKeys.includes(option.id);
              const hasSessions = allSessions.some((session) => session.providerId === option.id);
              const unavailable = option.kind === "provider" && !option.available && !hasSessions;
              return <div key={option.id} className={`provider-filter-option ${option.available ? "available" : "unavailable"} ${isSingleSelection ? "selected" : ""} ${isIncluded ? "included" : ""}`}>
                <button className="provider-filter-primary" type="button" disabled={unavailable} aria-pressed={isSingleSelection} onClick={() => chooseProvider(option.id)}>
                  {option.kind === "available" ? <AvailableAgentsIcon /> : <ProviderLogo providerId={option.id} {...(option.provider ? { provider: option.provider } : {})} size={22}/>}<span>{option.label}</span>
                </button>
                {option.kind !== "all" ? <button className="provider-filter-checkbox" type="button" role="checkbox" aria-checked={isIncluded} aria-label={`${isIncluded ? "Remove" : "Add"} ${option.label} ${isIncluded ? "from" : "to"} custom filter`} disabled={unavailable} onClick={() => toggleProvider(option.id)}><CheckIcon /></button> : null}
              </div>;
            })}</div></section>
            <section><header><strong>Status</strong>{stateFilter !== "all" ? <button onClick={() => chooseState("all")}>Clear</button> : null}</header><div className="task-filter-options state-options">{stateOrder.map((state) => <button key={state} className={stateFilter === state ? "selected" : ""} onClick={() => chooseState(state)}>{stateLabels[state]}</button>)}</div></section>
            <section className="side-chat-filter">
              <button type="button" role="checkbox" aria-checked={showSideChats} onClick={() => onShowSideChats(!showSideChats)}><ChatIcon/><span>Show side chats</span><CheckIcon/></button>
              {archivedCount ? <button type="button" role="checkbox" aria-checked={showArchived} onClick={() => onShowArchived(!showArchived)}><ArchiveIcon/><span>Show archived</span><CheckIcon/></button> : null}
            </section>
            <footer>{sessions.length} matching {sessions.length === 1 ? "task" : "tasks"}</footer>
          </div> : null}
        </div>
        <button type="button" onClick={onNewTask} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onNewTask(); } }} aria-label="New task" data-tooltip="New task"><PlusIcon /></button>
      </header>
      <div className="session-list-scroll" ref={sessionList}>
        {sessions.length ? sessions.map((session) => {
          const allSideChats = sideChatsByParent.get(session.id) ?? [];
          const expanded = expandedSideChatParents.has(session.id);
          const visibleSideChats = showSideChats ? (expanded ? allSideChats : allSideChats.slice(0, 2)) : [];
          return <div className={`session-row-group ${visibleSideChats.length ? "has-side-chats" : ""}`} key={session.id}>
          <SessionRow session={session} provider={providerFor(providers, session.providerId)} providers={providers} selected={session.id === selected} renaming={renamingSessionId === session.id} onOpenChild={onOpenChild} onRename={(title) => { setRenamingSessionId(null); onTaskOverride(session.id, { title }); }} onCancelRename={() => setRenamingSessionId(null)} onOpen={() => { setSessionMenu(null); onOpen(session.id); }} onContextMenu={(event) => {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = event.clientX || bounds.left + 24;
          const y = event.clientY || bounds.top + 24;
          setSessionMenu({
            sessionId: session.id,
            title: session.title,
            workingDirectory: session.workingDirectory,
            x: Math.max(8, Math.min(x, window.innerWidth - 208)),
            y: Math.max(8, Math.min(y, window.innerHeight - 96)),
          });
        }} />
          {visibleSideChats.length ? <div className="session-side-chats">{visibleSideChats.map((sideChat) => <button type="button" key={sideChat.id} data-side-chat-id={sideChat.id} className={activeSideChatIds.includes(sideChat.id) ? "active" : ""} onClick={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); onOpenSideChat(sideChat.id, { x: bounds.right, y: bounds.top + bounds.height / 2 }); }}><OverflowReveal axis="horizontal" className="side-chat-preview">{sideChat.preview || sideChat.title}</OverflowReveal></button>)}</div> : null}
          {showSideChats ? <div className="side-chat-controls">
            {allSideChats.length ? <button type="button" aria-label="About side chats" data-tooltip="About side chats" onClick={() => setSideChatInfoParent((current) => current === session.id ? null : session.id)}><InfoIcon/></button> : null}
            {allSideChats.length > 2 ? <button type="button" aria-label={expanded ? "Show fewer side chats" : "Show all side chats"} data-tooltip={expanded ? "Show fewer" : `${allSideChats.length - 2} more`} onClick={() => setExpandedSideChatParents((current) => { const next = new Set(current); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next; })}><ChevronDownIcon className={expanded ? "expanded" : ""}/></button> : null}
            <button type="button" aria-label="New side chat" data-tooltip="New side chat" onClick={() => void onCreateSideChat(session.id)}><PlusIcon/></button>
            {sideChatInfoParent === session.id ? <p className="side-chat-info" role="status">Side chats for this task.</p> : null}
          </div> : null}
        </div>;
        }) : <EmptyState icon={<SearchIcon />} title="No matching tasks" description="Try another search or filter." />}
      </div>
      {sessionMenu ? <div ref={sessionMenuElement} className="session-context-menu" role="menu" aria-label={`Task actions for ${sessionMenu.title}`} style={{ left: sessionMenu.x, top: sessionMenu.y }}>
        <button type="button" role="menuitem" disabled={!menuSession || menuSession.draft === true} onClick={() => {
          const sessionId = sessionMenu.sessionId;
          setSessionMenu(null);
          setRenamingSessionId(sessionId);
        }}><RenameIcon /><span>Rename</span></button>
        <button type="button" role="menuitem" disabled={!menuSession || menuSession.draft === true} onClick={() => {
          const sessionId = sessionMenu.sessionId;
          const pinned = menuSession?.pinned === true;
          setSessionMenu(null);
          onTaskOverride(sessionId, { pinned: !pinned });
        }}><PinIcon /><span>{menuSession?.pinned ? "Unpin" : "Pin to top"}</span></button>
        <button type="button" role="menuitem" disabled={!canBranchMenuSession} onClick={() => {
          const sessionId = sessionMenu.sessionId;
          setSessionMenu(null);
          onBranch(sessionId);
        }}><BranchIcon /><span>Branch in New Task</span></button>
        <button type="button" role="menuitem" disabled={!sessionMenu.workingDirectory} onClick={() => {
          const path = sessionMenu.workingDirectory;
          setSessionMenu(null);
          if (path) onOpenDirectory(path);
        }}><FolderIcon /><span>Open in File Explorer</span></button>
        <button type="button" role="menuitem" disabled={!menuSession} onClick={() => {
          const sessionId = sessionMenu.sessionId;
          const archived = menuSession?.archived === true;
          setSessionMenu(null);
          onTaskOverride(sessionId, { archived: !archived, ...(archived ? {} : { pinned: false }) });
        }}><ArchiveIcon /><span>{menuSession?.archived ? "Restore" : "Archive"}</span></button>
      </div> : null}
    </section>

    <div className="sidebar-footer">
      <button className="sidebar-settings" type="button" aria-label={view === "settings" ? "Close settings" : "Open settings"} onClick={() => onView("settings")}><SettingsIcon /><span>Settings</span></button>
      {/* The version belongs with the thing it describes. Stamped on the rail it was
          a number floating in the corner of every screen for the one moment a year
          anybody needs it; here it is a line in the box that already answers "what is
          this dot telling me". */}
      <span className={`sidebar-runtime-indicator ${connected ? "connected" : "offline"}`} role="status" aria-label={`${hostName}. Runtime ${connected ? "online" : "offline"}${appVersion ? `. Tethoq version ${appVersion}` : ""}`} data-tooltip={`${hostName} · Runtime ${connected ? "online" : "offline"}${appVersion ? ` · Tethoq v${appVersion}` : ""}`} />
    </div>
  </aside>;
}

/**
 * Renaming happens in the row itself so the task keeps its place and geometry.
 * An emptied field clears the local name and restores the provider's own title.
 */
function TaskNameField({ value, onCommit, onCancel }: { value: string; onCommit: (title: string) => void; onCancel: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const committed = useRef(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { input.current?.select(); }, []);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const title = draft.trim();
    if (title === value.trim()) onCancel(); else onCommit(title);
  };
  return <input
    ref={input}
    className="session-row-rename"
    autoFocus
    value={draft}
    maxLength={MAX_TASK_TITLE_CHARACTERS}
    aria-label="Task name"
    placeholder="Task name"
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); commit(); }
      else if (event.key === "Escape") { event.preventDefault(); committed.current = true; onCancel(); }
    }}
  />;
}

function sidebarChildStateLabel(state: Session["state"]): string {
  if (state === "working") return "Working";
  if (state === "needs_approval") return "Needs approval";
  if (state === "needs_input") return "Needs input";
  if (state === "failed") return "Stopped with an issue";
  if (state === "offline") return "Offline";
  return state === "completed" ? "Completed" : "Idle";
}

function SessionSubagentControl({ session, providers, onOpenChild }: { session: Session; providers: readonly Provider[]; onOpenChild: (session: Session) => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [children, setChildren] = useState<readonly Session[]>([]);
  const [childrenLoaded, setChildrenLoaded] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const [tooltipActive, setTooltipActive] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverId = `session-subagents-${session.id}`;
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const closeFromOutside = () => setOpen(false);
  const providerId = session.childProviderIds?.[0] ?? "opencode";
  const provider = providers.find((candidate) => candidate.id === providerId);
  const displayedChildCount = childrenLoaded ? children.length : session.childCount;
  const countLabel = `${displayedChildCount} sub-agent${displayedChildCount === 1 ? "" : "s"}`;
  const positionTooltip = () => {
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const right = Math.max(8, window.innerWidth - bounds.right);
    if (bounds.bottom + 40 <= window.innerHeight - 8) {
      setTooltipStyle({ right, top: bounds.bottom + 8 });
    } else {
      setTooltipStyle({ right, bottom: window.innerHeight - bounds.top + 8 });
    }
  };
  useEffect(() => {
    if (!tooltipActive) return;
    positionTooltip();
    window.addEventListener("resize", positionTooltip);
    document.addEventListener("scroll", positionTooltip, true);
    return () => {
      window.removeEventListener("resize", positionTooltip);
      document.removeEventListener("scroll", positionTooltip, true);
    };
  }, [tooltipActive]);
  useEffect(() => {
    if (!open) return;
    const position = () => {
      const bounds = root.current?.getBoundingClientRect();
      if (!bounds) return;
      const gap = 6;
      const viewportInset = 8;
      const popoverWidth = 270;
      const availableAbove = Math.max(0, bounds.top - viewportInset - gap);
      const availableBelow = Math.max(0, window.innerHeight - bounds.bottom - viewportInset - gap);
      const openAbove = availableAbove >= Math.min(260, availableBelow);
      const maxHeight = Math.max(80, Math.min(260, openAbove ? availableAbove : availableBelow));
      setPopoverStyle({
        left: Math.max(viewportInset, Math.min(window.innerWidth - popoverWidth - viewportInset, bounds.right + gap)),
        maxHeight,
        ...(openAbove
          ? { top: "auto", bottom: window.innerHeight - bounds.top + gap }
          : { top: bounds.bottom + gap, bottom: "auto" }),
      });
    };
    const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) closeFromOutside(); };
    const closeEscape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    position();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let inFlight = false;
    const refreshChildren = async (initial: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (initial) setLoading(true);
      try {
        const next = await listChildSessions(session.id);
        if (!disposed) {
          setChildren(next);
          setChildrenLoaded(true);
        }
      } catch {
        if (!disposed && initial) setChildren([]);
      } finally {
        inFlight = false;
        if (!disposed && initial) setLoading(false);
      }
    };
    void refreshChildren(true);
    // Child state can change in a provider other than the parent's provider.
    // Refresh only while this small live view is open, and never overlap reads.
    const timer = window.setInterval(() => { void refreshChildren(false); }, 1_500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [open, session.id]);
  if (!displayedChildCount) return null;
  return <div className={`session-subagents ${open ? "open" : ""}`} ref={root}>
    <button ref={trigger} type="button" className="session-subagents-trigger" aria-label={countLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={popoverId} aria-describedby={tooltipActive && !open ? `session-subagents-tooltip-${session.id}` : undefined} onPointerEnter={() => { positionTooltip(); setTooltipActive(true); }} onPointerLeave={() => setTooltipActive(false)} onFocus={() => { positionTooltip(); setTooltipActive(true); }} onBlur={() => setTooltipActive(false)} onClick={(event) => { event.stopPropagation(); if (open) close(); else setOpen(true); }}>
      <ProviderLogo providerId={providerId} {...(provider ? { provider } : {})} size={18} tooltip={false}/><span>{displayedChildCount}</span><ChevronDownIcon />
    </button>
    {tooltipActive && !open ? createPortal(<span id={`session-subagents-tooltip-${session.id}`} className="session-subagents-tooltip visible" role="tooltip" style={tooltipStyle}>{countLabel}</span>, document.body) : null}
    {open ? <section id={popoverId} className="session-subagents-popover" style={popoverStyle} role="dialog" aria-modal="false" aria-label={`Sub-agents for ${session.title}`}>
      {loading ? <p><span className="spinner" /> Loading sub-agents…</p> : children.map((child) => {
        const childProvider = providers.find((candidate) => candidate.id === child.providerId);
        return <button type="button" key={child.id} onClick={() => { close(); onOpenChild(child); }}>
          <ProviderLogo providerId={child.providerId} {...(childProvider ? { provider: childProvider } : {})} size={20}/>
          <span><strong>{child.agentNickname || child.title}</strong><small>{child.model} · {sidebarChildStateLabel(child.state)}</small></span>
          {child.state === "working" ? <span className="spinner" aria-hidden="true" /> : null}<ChevronRightIcon />
        </button>;
      })}{!loading && children.length === 0 ? <p>No sub-agents available.</p> : null}
    </section> : null}
  </div>;
}

function SessionRow({ session, provider, providers, selected, renaming, onRename, onCancelRename, onOpen, onOpenChild, onContextMenu }: { session: Session; provider?: Provider | undefined; providers: readonly Provider[]; selected: boolean; renaming: boolean; onRename: (title: string) => void; onCancelRename: () => void; onOpen: () => void; onOpenChild: (session: Session) => void; onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void }) {
  const location = session.workingDirectory || session.project;
  const content = <>
    <div className="session-row-top">
      <ProviderLogo providerId={session.providerId} provider={provider} size={36}/>
      {renaming
        ? <TaskNameField value={session.title} onCommit={onRename} onCancel={onCancelRename} />
        : <OverflowReveal axis="horizontal" className="session-row-title"><strong>{session.title}</strong></OverflowReveal>}
      <span className="session-row-trailing">{session.pinned ? <PinIcon className="session-row-pin" /> : null}<time>{relativeTime(session.updatedAt)}</time></span>
      {session.state === "working" ? <i className="session-row-working-spinner" aria-label="Working" data-tooltip="Working" /> : null}
    </div>
    <OverflowReveal axis="vertical" className="session-row-preview">{session.preview}</OverflowReveal>
    <div className="session-row-meta"><span className="session-location" title={location} aria-label={`${session.project}. Working directory: ${location}`}><FolderIcon />{session.project}</span>{session.pinned ? <span>Pinned</span> : null}{session.archived ? <span>Archived</span> : null}{session.unread ? <b className="unread-count">{session.unread}</b> : null}</div>
  </>;
  const className = `session-row ${selected ? "selected" : ""} ${session.archived ? "archived" : ""} ${renaming ? "renaming" : ""}`;
  return <div className="session-row-shell" data-session-id={session.id} onContextMenu={onContextMenu}>
    {renaming
      ? <div className={className}>{content}</div>
      : <button type="button" className={className} aria-current={selected ? "page" : undefined} onClick={onOpen}>{content}</button>}
    <SessionSubagentControl session={session} providers={providers} onOpenChild={onOpenChild}/>
  </div>;
}
