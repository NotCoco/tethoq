import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDesktopUpdates } from "./DesktopUpdates";
import type { TaskListMode, TaskOverride } from "@shared/desktop_api";
import { MAX_TASK_TITLE_CHARACTERS } from "@shared/desktop_api";
import { reasoningDisplayLabel } from "../../../../../packages/protocol/src/reasoning";
import { EmptyState, ProviderLogo, providerDisplayName, relativeTime } from "./components";
import { useTaskChildren } from "./session_metadata";
import { AlertIcon, ArchiveIcon, BranchIcon, BridgeIcon, ChatIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, FolderIcon, FolderPlusIcon, GridIcon, InfoIcon, MicrophoneIcon, PinIcon, PlusIcon, RenameIcon, SearchIcon, SettingsIcon, SlidersIcon, SubagentsIcon, XIcon } from "./icons";
import { maximumUiSearchCharacters } from "./search_helpers";
import type { RuntimeConnectionPresentation } from "./progressive_startup";
import { groupSessionsByProject, initialProjectCount, isSideChatSession, projectDirectoryName, reconcileProjectDirectoryOrder, sideChatParentSessionId, visibleProjectSessions } from "./session_projects";
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

function OverflowReveal({ axis, className, children, prefix }: { axis: "horizontal" | "vertical"; className: string; children: ReactNode; prefix?: ReactNode }) {
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
  return <div ref={root} className={`overflow-reveal overflow-reveal-${axis} ${className}`} data-overflow={distance > 0 || undefined} style={{ "--overflow-distance": `${Math.ceil(distance)}px`, "--overflow-duration": `${duration.toFixed(2)}s` } as CSSProperties}>{prefix ? <i className="overflow-reveal-prefix">{prefix}</i> : null}<span ref={content}>{children}</span></div>;
}

function ProjectNewTaskButton({ directory, name, onNewTask }: { directory: string; name: string; onNewTask: (workingDirectory: string) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const [tooltipActive, setTooltipActive] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});
  const tooltipId = useId();
  const label = `New task in ${name}`;
  const clearHoverTimer = () => {
    if (hoverTimer.current === undefined) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = undefined;
  };
  const positionTooltip = () => {
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const tooltipHeight = tooltip.current?.offsetHeight ?? 34;
    const right = Math.max(8, window.innerWidth - bounds.right);
    if (bounds.bottom + 8 + tooltipHeight <= window.innerHeight - 8) {
      setTooltipStyle({ right, top: bounds.bottom + 8, bottom: "auto" });
    } else {
      setTooltipStyle({ right, top: "auto", bottom: window.innerHeight - bounds.top + 8 });
    }
  };
  const hideTooltip = () => {
    clearHoverTimer();
    setTooltipActive(false);
  };
  const showTooltipImmediately = () => {
    clearHoverTimer();
    positionTooltip();
    setTooltipActive(true);
  };
  const showTooltipAfterDelay = () => {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      positionTooltip();
      setTooltipActive(true);
    }, 460);
  };
  useLayoutEffect(() => {
    if (tooltipActive) positionTooltip();
  }, [tooltipActive, label]);
  useEffect(() => {
    if (!tooltipActive) return;
    window.addEventListener("resize", positionTooltip);
    document.addEventListener("scroll", positionTooltip, true);
    return () => {
      window.removeEventListener("resize", positionTooltip);
      document.removeEventListener("scroll", positionTooltip, true);
    };
  }, [tooltipActive]);
  useEffect(() => () => clearHoverTimer(), []);
  return <>
    <button
      ref={trigger}
      type="button"
      className="session-project-new-task"
      aria-label={label}
      aria-describedby={tooltipActive ? tooltipId : undefined}
      onPointerEnter={showTooltipAfterDelay}
      onPointerLeave={hideTooltip}
      onFocus={showTooltipImmediately}
      onBlur={hideTooltip}
      onClick={() => { hideTooltip(); onNewTask(directory); }}
    ><PlusIcon /></button>
    {tooltipActive ? createPortal(<span ref={tooltip} id={tooltipId} className="session-project-new-task-tooltip" role="tooltip" style={tooltipStyle}>{label}</span>, document.body) : null}
  </>;
}

export interface SidebarProps {
  loading?: boolean;
  sessions: Session[];
  allSessions: Session[];
  providers: Provider[];
  selected: string | null;
  selectedProvider: ProviderFilterSelection;
  query: string;
  stateFilter: SessionFilter;
  view: NavigationView;
  connected: boolean;
  runtimeConnectionState: RuntimeConnectionPresentation;
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
  onNewTaskInProject: (workingDirectory: string) => void;
  onNewProject: () => void;
  taskListMode: TaskListMode;
  savedProjectDirectories?: readonly string[];
  onTaskListMode: (value: TaskListMode) => void;
  onCommandSearch: () => void;
  onMobileConnection: () => void;
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

const noSavedProjects: readonly string[] = [];

export function Sidebar({ loading = false, sessions, allSessions, providers, selected, selectedProvider, query, stateFilter, view, connected, runtimeConnectionState, hostName, appVersion, onQuery, onFilter, onProvider, onOpen, onOpenChild, onBranch, onOpenDirectory, onView, onNewTask, onNewTaskInProject, onNewProject, taskListMode, savedProjectDirectories = noSavedProjects, onTaskListMode, onCommandSearch, onMobileConnection, showSideChats, activeSideChatIds, onShowSideChats, onCreateSideChat, onOpenSideChat, onSideChatAnchor, showArchived, archivedCount, onShowArchived, onTaskOverride }: SidebarProps) {
  const updates = useDesktopUpdates();
  const updateAvailable = updates?.phase === "available" || updates?.phase === "downloaded";
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
  const [collapsedSideChatParents, setCollapsedSideChatParents] = useState<ReadonlySet<string>>(() => new Set());
  const [sideChatInfoParent, setSideChatInfoParent] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [projectDirectoryOrder, setProjectDirectoryOrder] = useState(savedProjectDirectories);
  const [showAllProjects, setShowAllProjects] = useState(false);
  useEffect(() => {
    setProjectDirectoryOrder((current) => reconcileProjectDirectoryOrder(current, savedProjectDirectories));
  }, [savedProjectDirectories]);
  const selectedProviderKeys = providerFilterKeys(selectedProvider);
  const activeFilterCount = selectedProviderKeys.length + Number(stateFilter !== "all");
  const searchExpanded = searchOpen || Boolean(query);
  const filterSummary = [
    selectedProviderKeys.length ? selectedProviderKeys.map((providerId) => providerId === AVAILABLE_PROVIDER_FILTER ? "Available agents" : providerDisplayName(providerId, providerFor(providers, providerId))).join(" + ") : null,
    stateFilter !== "all" ? stateLabels[stateFilter] : null,
  ].filter(Boolean).join(", ");
  const menuSession = sessionMenu ? allSessions.find((session) => session.id === sessionMenu.sessionId) : undefined;
  const menuProvider = menuSession ? providerFor(providers, menuSession.providerId) : undefined;
  const canBranchMenuSession = connected && menuSession?.draft !== true && menuSession?.schedule === undefined && menuSession?.state !== "offline" && menuProvider?.detected === true && menuProvider.state === "online" && menuProvider.capabilities.includes("Create Session") && menuProvider.capabilities.includes("Send Message") && menuProvider.capabilities.includes("Session History");
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
      const parentSessionId = sideChatParentSessionId(sideChat);
      if (!isSideChatSession(sideChat) || !parentSessionId) continue;
      const current = grouped.get(parentSessionId) ?? [];
      current.push(sideChat);
      grouped.set(parentSessionId, current);
    }
    for (const items of grouped.values()) items.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return grouped;
  }, [allSessions]);
  const projectGroups = useMemo(() => groupSessionsByProject(sessions, projectDirectoryOrder), [projectDirectoryOrder, sessions]);
  const filteringProjects = Boolean(query || activeFilterCount || showArchived);
  const matchingProjectGroups = filteringProjects ? projectGroups.filter((group) => group.sessions.length > 0) : projectGroups;
  const visibleProjectGroups = [...(showAllProjects || filteringProjects ? matchingProjectGroups : matchingProjectGroups.slice(0, initialProjectCount))];
  const selectedProject = matchingProjectGroups.find((group) => group.sessions.some((session) => session.id === selected));
  if (selectedProject && !visibleProjectGroups.includes(selectedProject)) visibleProjectGroups.push(selectedProject);
  const duplicateProjectNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of projectGroups) counts.set(group.name.toLocaleLowerCase(), (counts.get(group.name.toLocaleLowerCase()) ?? 0) + 1);
    return new Set([...counts.entries()].flatMap(([name, count]) => count > 1 ? [name] : []));
  }, [projectGroups]);

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

  useLayoutEffect(() => {
    if (!sessionMenu || !sessionMenuElement.current) return;
    const bounds = sessionMenuElement.current.getBoundingClientRect();
    const inset = 8;
    const x = Math.max(inset, Math.min(sessionMenu.x, window.innerWidth - bounds.width - inset));
    const y = Math.max(inset, Math.min(sessionMenu.y, window.innerHeight - bounds.height - inset));
    if (x === sessionMenu.x && y === sessionMenu.y) return;
    setSessionMenu((current) => current ? { ...current, x, y } : current);
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
          const parentSessionId = sideChat ? sideChatParentSessionId(sideChat) : undefined;
          const parentElement = parentSessionId ? list.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(parentSessionId)}"]`) : null;
          const bounds = (parentElement ?? sideElement)?.getBoundingClientRect();
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
  const renderSession = (session: Session, compact = false) => {
    const allSideChats = sideChatsByParent.get(session.id) ?? [];
    const expanded = expandedSideChatParents.has(session.id);
    const collapsed = collapsedSideChatParents.has(session.id);
    const hasSideChatRail = showSideChats && allSideChats.length > 0;
    const visibleSideChats = hasSideChatRail ? (expanded ? allSideChats : allSideChats.slice(0, 2)) : [];
    const sideChatRegionId = `session-side-chats-${session.id}`;
    return <div className={`session-row-group ${!collapsed && visibleSideChats.length ? "has-side-chats" : ""} ${hasSideChatRail && collapsed ? "side-chats-collapsed" : ""}`} key={session.id}>
      <SessionRow compact={compact} session={session} provider={providerFor(providers, session.providerId)} providers={providers} selected={session.id === selected} renaming={renamingSessionId === session.id} onOpenChild={onOpenChild} onRename={(title) => { setRenamingSessionId(null); onTaskOverride(session.id, { title }); }} onCancelRename={() => setRenamingSessionId(null)} onOpen={() => { setSessionMenu(null); onOpen(session.id); }} onContextMenu={(event) => {
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
      {hasSideChatRail ? <div className={`session-side-chat-rail ${collapsed ? "collapsed" : "expanded"}`}>
        <button type="button" className="session-side-chat-toggle" aria-label={`${collapsed ? "Show" : "Hide"} side chats for ${session.title}`} aria-expanded={!collapsed} aria-controls={sideChatRegionId} data-tooltip={collapsed ? "Show side chats" : "Hide side chats"} onClick={() => setCollapsedSideChatParents((current) => { const next = new Set(current); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next; })}><ChevronDownIcon /></button>
        <div id={sideChatRegionId} className="session-side-chats" hidden={collapsed}>{visibleSideChats.map((sideChat) => <button type="button" key={sideChat.id} data-side-chat-id={sideChat.id} className={activeSideChatIds.includes(sideChat.id) ? "active" : ""} onClick={(event) => { const parentElement = event.currentTarget.closest<HTMLElement>(".session-row-group")?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(session.id)}"]`); const bounds = (parentElement ?? event.currentTarget).getBoundingClientRect(); onOpenSideChat(sideChat.id, { x: bounds.right, y: bounds.top + bounds.height / 2 }); }}><OverflowReveal axis="horizontal" className="side-chat-preview">{sideChat.preview || sideChat.title}</OverflowReveal></button>)}</div>
      </div> : null}
      {showSideChats && !collapsed && (!compact || allSideChats.length > 2) ? <div className="side-chat-controls">
        {!compact && allSideChats.length ? <button type="button" aria-label="About side chats" data-tooltip="About side chats" onClick={() => setSideChatInfoParent((current) => current === session.id ? null : session.id)}><InfoIcon/></button> : null}
        {allSideChats.length > 2 ? <button type="button" aria-label={expanded ? "Show fewer side chats" : "Show all side chats"} data-tooltip={expanded ? "Show fewer" : `${allSideChats.length - 2} more`} onClick={() => setExpandedSideChatParents((current) => { const next = new Set(current); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next; })}><ChevronDownIcon className={expanded ? "expanded" : ""}/></button> : null}
        {!compact ? <button type="button" aria-label="New side chat" data-tooltip="New side chat" onClick={() => void onCreateSideChat(session.id)}><PlusIcon/></button> : null}
        {!compact && sideChatInfoParent === session.id ? <p className="side-chat-info" role="status">Side chats for this task.</p> : null}
      </div> : null}
    </div>;
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
      <header className={`sidebar-task-header ${searchExpanded ? "search-expanded" : ""}`}>
        <h2>Tasks</h2>
        <div className="task-list-mode">
          <button type="button" aria-label={taskListMode === "project" ? "Arrange tasks by recency" : "Arrange tasks by project"} aria-pressed={taskListMode === "project"} data-tooltip={taskListMode === "project" ? "Recent" : "Projects"} onClick={() => onTaskListMode(taskListMode === "project" ? "recent" : "project")}>{taskListMode === "project" ? <ClockIcon /> : <FolderIcon />}</button>
        </div>
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
        <button type="button" onClick={taskListMode === "project" ? onNewProject : onNewTask} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (taskListMode === "project") onNewProject(); else onNewTask(); } }} aria-label={taskListMode === "project" ? "New project" : "New task"} data-tooltip={taskListMode === "project" ? "Choose or create a project folder" : "New task"}>{taskListMode === "project" ? <FolderPlusIcon className="folder-plus-icon" /> : <PlusIcon />}</button>
      </header>
      <div className="session-list-scroll" ref={sessionList}>
        {loading ? <div className="session-list-skeleton" role="status" aria-label="Loading tasks" aria-busy="true">{[0, 1, 2, 3, 4].map((index) => <div className="session-row-skeleton" key={index} aria-hidden="true"><i/><span><b/><b/><b/></span></div>)}</div>
          : taskListMode === "project" ? <>{visibleProjectGroups.map((group) => {
          const collapsed = collapsedProjects.has(group.key);
          const expanded = expandedProjects.has(group.key);
          const duplicateName = duplicateProjectNames.has(group.name.toLocaleLowerCase());
          const visibleSessions = visibleProjectSessions(group.sessions, selected, expanded);
          const hiddenSessionCount = group.sessions.length - visibleSessions.length;
          return <section className="session-project-group" key={group.key} data-project-key={group.key}>
            <div className="session-project-heading">
              <button type="button" className="session-project-header" aria-expanded={!collapsed} title={group.directory} onClick={() => setCollapsedProjects((current) => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}>
                <FolderIcon /><span><strong>{group.name}</strong>{duplicateName && group.directory ? <small>{group.directory}</small> : null}</span><ChevronDownIcon className={collapsed ? "" : "expanded"}/>
              </button>
              {group.directory ? <ProjectNewTaskButton directory={group.directory} name={group.name} onNewTask={onNewTaskInProject}/> : null}
            </div>
            {!collapsed ? <div className="session-project-items">
              {visibleSessions.map((session) => renderSession(session, true))}
              {hiddenSessionCount > 0 ? <button type="button" className="session-project-show-more" aria-label={`Show ${hiddenSessionCount} more tasks in ${group.name}`} onClick={() => setExpandedProjects((current) => new Set(current).add(group.key))}>Show more</button> : null}
            </div> : null}
          </section>;
        })}
        {!filteringProjects && projectGroups.length > initialProjectCount ? <button type="button" className="session-projects-disclosure" aria-expanded={showAllProjects} onClick={() => setShowAllProjects((current) => !current)}>{showAllProjects ? "Show fewer projects" : "Show all projects"}</button> : null}
        {!visibleProjectGroups.length ? projectGroups.length ? <EmptyState icon={<SearchIcon />} title="No matching tasks" description="Try another search or filter." /> : <EmptyState icon={<FolderIcon />} title="Add a project" description="Choose a folder to collect its tasks from every harness." /> : null}
        </> : sessions.length ? sessions.map((session) => renderSession(session)) : <EmptyState icon={<SearchIcon />} title="No matching tasks" description="Try another search or filter." />}
      </div>
      {sessionMenu ? <div ref={sessionMenuElement} className="session-context-menu" role="menu" aria-label={`Task actions for ${sessionMenu.title}`} style={{ left: sessionMenu.x, top: sessionMenu.y }}>
        {menuSession?.schedule === undefined ? <><button type="button" role="menuitem" disabled={!menuSession || menuSession.draft === true} onClick={() => {
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
        }}><BranchIcon /><span>Branch in New Task</span></button></> : null}
        <button type="button" role="menuitem" disabled={!sessionMenu.workingDirectory} onClick={() => {
          const path = sessionMenu.workingDirectory;
          setSessionMenu(null);
          if (path) onOpenDirectory(path);
        }}><FolderIcon /><span>Open in File Explorer</span></button>
        {menuSession?.schedule === undefined ? <button type="button" role="menuitem" disabled={!menuSession} onClick={() => {
          const sessionId = sessionMenu.sessionId;
          const archived = menuSession?.archived === true;
          setSessionMenu(null);
          onTaskOverride(sessionId, { archived: !archived, ...(archived ? {} : { pinned: false }) });
        }}><ArchiveIcon /><span>{menuSession?.archived ? "Restore" : "Archive"}</span></button> : null}
      </div> : null}
    </section>

    <div className="sidebar-footer">
      <div className="sidebar-footer-actions">
        <button className="sidebar-mobile-connection" type="button" aria-label="Connect your phone" data-tooltip="Connect your phone" onClick={onMobileConnection}><BridgeIcon /></button>
        <button className="sidebar-settings" type="button" aria-label={view === "settings" ? "Close settings" : "Open settings"} aria-description={updateAvailable ? "Tethoq update available" : undefined} onClick={() => onView("settings")}><SettingsIcon /><span>{updateAvailable ? "Update available" : "Settings"}</span></button>
      </div>
      {/* The version belongs with the thing it describes. Stamped on the rail it was
          a number floating in the corner of every screen for the one moment a year
          anybody needs it; here it is a line in the box that already answers "what is
          this dot telling me". */}
      <span className={`sidebar-runtime-indicator ${runtimeConnectionState === "online" ? "connected" : runtimeConnectionState}`} role="status" aria-label={`${hostName}. Runtime ${runtimeConnectionState}${appVersion ? `. Tethoq version ${appVersion}` : ""}`} data-tooltip={`${hostName} · Runtime ${runtimeConnectionState}${appVersion ? ` · Tethoq v${appVersion}` : ""}`} />
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

export function SessionSubagentControl({ compact = false, session, providers, onOpenChild }: { compact?: boolean; session: Session; providers: readonly Provider[]; onOpenChild: (session: Session) => void }) {
  const [open, setOpen] = useState(false);
  const childMetadata = useTaskChildren(session, open, open);
  const children = childMetadata.data ?? [];
  const childrenLoaded = childMetadata.data !== undefined;
  const loading = (!childrenLoaded || (children.length === 0 && (session.childCount ?? 0) > 0 && childMetadata.loading)) && !childMetadata.error;
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLElement>(null);
  const popoverId = `session-subagents-${session.id}`;
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const closeFromOutside = () => setOpen(false);
  const displayedChildCount = children.length || (session.childCount ?? 0);
  const countLabel = `${displayedChildCount} sub-agent${displayedChildCount === 1 ? "" : "s"}`;
  const compactCountCapped = compact && displayedChildCount >= 1_000;
  const visibleChildCount = compactCountCapped ? "1k+" : displayedChildCount;
  useEffect(() => {
    if (!open) return;
    const position = () => {
      const bounds = root.current?.getBoundingClientRect();
      if (!bounds) return;
      const gap = 6;
      const viewportInset = 8;
      const popoverWidth = 300;
      const popoverMaximumHeight = 318;
      const availableAbove = Math.max(0, bounds.top - viewportInset - gap);
      const availableBelow = Math.max(0, window.innerHeight - bounds.bottom - viewportInset - gap);
      const openAbove = availableAbove >= Math.min(popoverMaximumHeight, availableBelow);
      const maxHeight = Math.max(80, Math.min(popoverMaximumHeight, openAbove ? availableAbove : availableBelow));
      setPopoverStyle({
        left: Math.max(viewportInset, Math.min(window.innerWidth - popoverWidth - viewportInset, bounds.right + gap)),
        maxHeight,
        ...(openAbove
          ? { top: "auto", bottom: window.innerHeight - bounds.top + gap }
          : { top: bounds.bottom + gap, bottom: "auto" }),
      });
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !popover.current?.contains(target)) closeFromOutside();
    };
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
  if (!displayedChildCount) return null;
  return <div className={`session-subagents ${compact ? "compact" : ""} ${open ? "open" : ""}`} ref={root}>
    <button ref={trigger} type="button" className="session-subagents-trigger" aria-label={countLabel} aria-haspopup="dialog" aria-expanded={open} aria-controls={popoverId} data-tooltip={open ? undefined : countLabel} onClick={(event) => { event.stopPropagation(); if (open) close(); else setOpen(true); }}>
      <span className="session-subagents-summary"><SubagentsIcon className="session-subagents-icon"/><span className="session-subagents-count" data-count-capped={compactCountCapped || undefined}>{visibleChildCount}</span></span>
      {!compact ? <ChevronDownIcon className="session-subagents-chevron" /> : null}
    </button>
    {open ? createPortal(<section ref={popover} id={popoverId} className="session-subagents-popover" style={popoverStyle} role="dialog" aria-modal="false" aria-label={`Sub-agents for ${session.title}`}>
      {loading ? <p><span className="spinner" /> Loading sub-agents…</p> : children.map((child) => {
        const childProvider = providers.find((candidate) => candidate.id === child.providerId);
        const reasoning = reasoningDisplayLabel(child.effort, { providerId: child.providerId, modelId: child.model, displayName: child.model });
        return <button type="button" key={child.id} data-session-id={child.id} onClick={() => { close(); onOpenChild(child); }}>
          <ProviderLogo providerId={child.providerId} {...(childProvider ? { provider: childProvider } : {})} size={28}/>
          <span><strong>{child.agentNickname || child.title}</strong><small className="session-subagent-metadata" aria-label={reasoning ? `${child.model}, reasoning ${reasoning}` : child.model}><span className="session-subagent-model">{child.model}</span>{reasoning ? <><span className="session-subagent-separator" aria-hidden="true">·</span><span className="session-subagent-reasoning">{reasoning}</span></> : null}</small></span>
          <span className="session-subagent-state">{child.state === "working" ? <span className="spinner" aria-hidden="true" /> : null}<span>{sidebarChildStateLabel(child.state)}</span></span><ChevronRightIcon />
        </button>;
      })}{!loading && children.length === 0 ? <p>{childMetadata.error ? "Sub-agents are unavailable. Try reopening this panel." : "No sub-agents available."}</p> : null}
    </section>, document.body) : null}
  </div>;
}

function SessionRow({ compact = false, session, provider, providers, selected, renaming, onRename, onCancelRename, onOpen, onOpenChild, onContextMenu }: { compact?: boolean; session: Session; provider?: Provider | undefined; providers: readonly Provider[]; selected: boolean; renaming: boolean; onRename: (title: string) => void; onCancelRename: () => void; onOpen: () => void; onOpenChild: (session: Session) => void; onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void }) {
  const location = session.workingDirectory || session.project;
  const projectLabel = projectDirectoryName(location, session.project);
  const scheduledLabel = session.schedule
    ? session.schedule.status === "failed"
      ? "Scheduled task failed"
      : session.schedule.status === "dispatching"
        ? "Starting scheduled task"
        : `Scheduled ${new Date(session.schedule.runAt).toLocaleString()}`
    : undefined;
  const scheduledIndicator = session.schedule
    ? <span className={compact ? "session-project-schedule-indicator" : "session-row-schedule-indicator"} data-status={session.schedule.status} aria-label={scheduledLabel} data-tooltip={scheduledLabel}>{session.schedule.status === "failed" ? <AlertIcon /> : <ClockIcon />}</span>
    : null;
  const content = compact ? <>
    <span className="session-project-harness">{session.draft ? <span className="session-draft-harness" aria-label="Unsent task" data-tooltip="Harness is set when the task starts"><ChatIcon /></span> : <ProviderLogo providerId={session.providerId} provider={provider} size={24}/>}</span>
    {renaming
      ? <TaskNameField value={session.title} onCommit={onRename} onCancel={onCancelRename} />
      : <OverflowReveal axis="horizontal" className="session-project-row-title"><strong>{session.title}</strong></OverflowReveal>}
    {session.state === "working" ? <span className="session-project-working-indicator" aria-label="Working" data-tooltip="Working"><i className="spinner session-project-working-spinner" aria-hidden="true" /></span> : scheduledIndicator}
  </> : <>
    <div className="session-row-top">
      {session.draft ? <span className="provider-logo session-draft-harness" aria-label="Unsent task" data-tooltip="Harness is set when the task starts"><ChatIcon /></span> : <ProviderLogo providerId={session.providerId} provider={provider} size={36}/>}
      {renaming
        ? <TaskNameField value={session.title} onCommit={onRename} onCancel={onCancelRename} />
        : <OverflowReveal axis="horizontal" className="session-row-title"><strong>{session.title}</strong></OverflowReveal>}
      <span className="session-row-trailing">{session.state === "working" ? null : scheduledIndicator ?? (session.pinned ? <PinIcon className="session-row-pin" /> : null)}<time>{relativeTime(session.updatedAt)}</time></span>
      {session.state === "working" ? <span className="session-row-working-indicator" aria-label="Working" data-tooltip="Working"><i className="spinner session-row-working-spinner" aria-hidden="true" /></span> : null}
    </div>
    <OverflowReveal axis="vertical" className={`session-row-preview ${session.previewKind === "realtime_voice" ? "session-row-preview-realtime" : ""}`} prefix={session.previewKind === "realtime_voice" ? <MicrophoneIcon /> : undefined}>{session.preview}</OverflowReveal>
    <div className="session-row-meta"><span className="session-location" title={location} aria-label={`${projectLabel}. Working directory: ${location}`}><FolderIcon />{projectLabel}</span>{session.pinned ? <span>Pinned</span> : null}{session.archived ? <span>Archived</span> : null}{session.unread ? <b className="unread-count">{session.unread}</b> : null}</div>
  </>;
  const className = `session-row ${compact ? "compact" : ""} ${selected ? "selected" : ""} ${session.archived ? "archived" : ""} ${renaming ? "renaming" : ""}`;
  return <div className="session-row-shell" data-session-id={session.id} onContextMenu={onContextMenu}>
    {renaming
      ? <div className={className}>{content}</div>
      : <button type="button" className={className} aria-current={selected ? "page" : undefined} onClick={onOpen}>{content}</button>}
    <SessionSubagentControl compact={compact} session={session} providers={providers} onOpenChild={onOpenChild}/>
  </div>;
}
