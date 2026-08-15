import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { EmptyState, ProviderLogo, providerDisplayName, relativeTime } from "./components";
import { BranchIcon, CheckIcon, FolderIcon, GridIcon, PlusIcon, SearchIcon, SettingsIcon, SlidersIcon, XIcon } from "./icons";
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
  onQuery: (value: string) => void;
  onFilter: (value: SessionFilter) => void;
  onProvider: (value: ProviderFilterSelection) => void;
  onOpen: (id: string) => void;
  onBranch: (id: string) => void;
  onOpenDirectory: (path: string) => void;
  onView: (view: NavigationView) => void;
  onNewTask: () => void;
  onCommandSearch: () => void;
}

export function Sidebar({ sessions, allSessions, providers, selected, selectedProvider, query, stateFilter, view, connected, hostName, onQuery, onFilter, onProvider, onOpen, onBranch, onOpenDirectory, onView, onNewTask, onCommandSearch }: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{ sessionId: string; title: string; workingDirectory: string; x: number; y: number } | null>(null);
  const searchRegion = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const sessionMenuElement = useRef<HTMLDivElement>(null);
  const selectedProviderKeys = providerFilterKeys(selectedProvider);
  const activeFilterCount = selectedProviderKeys.length + Number(stateFilter !== "all");
  const searchExpanded = searchOpen || Boolean(query) || filtersOpen || activeFilterCount > 0;
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
        searchInput.current?.focus();
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

  const chooseProvider = (value: ProviderFilter) => { onProvider(value); setFiltersOpen(false); };
  const toggleProvider = (value: ProviderId) => {
    const next = selectedProviderKeys.includes(value)
      ? selectedProviderKeys.filter((providerId) => providerId !== value)
      : [...selectedProviderKeys, value];
    onProvider(next.length ? next : "all");
  };
  const chooseState = (value: SessionFilter) => { onFilter(value); setFiltersOpen(false); };
  return <aside className={`sidebar sidebar-view-${view}`}>
    <div className="new-task-row">
      <button className="new-task-button" onClick={onNewTask} aria-label="New task"><PlusIcon /><span>New task</span></button>
      <button className="sidebar-command-search" type="button" onClick={onCommandSearch} aria-label="Search tasks or run a command" data-tooltip="Commands · Ctrl K"><SearchIcon /></button>
    </div>
    <nav className="primary-nav" aria-label="Primary">
      <button className={view === "dashboard" ? "active" : ""} onClick={() => onView("dashboard")}><GridIcon /><span>Dashboard</span></button>
    </nav>

    <section className="sidebar-tasks" aria-label="Tasks">
      <header className="sidebar-task-header">
        <h2>Tasks</h2>
        <button type="button" onClick={onNewTask} aria-label="New task" data-tooltip="New task"><PlusIcon /></button>
      </header>
      <div className="sidebar-task-tools" ref={searchRegion}>
        <div className="sidebar-task-search" data-expanded={searchExpanded} role="search">
          <button type="button" className="sidebar-task-search-trigger" aria-label="Search tasks" aria-expanded={searchExpanded} aria-controls="sidebar-task-search-input" data-tooltip={searchExpanded ? undefined : "Search tasks"} onClick={() => setSearchOpen(true)}><SearchIcon /></button>
          <input ref={searchInput} id="sidebar-task-search-input" tabIndex={searchExpanded ? 0 : -1} value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
          {query ? <button type="button" className="task-search-clear" aria-label="Clear search" data-tooltip="Clear" onClick={() => { onQuery(""); searchInput.current?.focus(); }}><XIcon /></button> : null}
          <button type="button" className={filtersOpen || activeFilterCount ? "filter-toggle active" : "filter-toggle"} tabIndex={searchExpanded ? 0 : -1} aria-label={filterSummary ? `Task filters: ${filterSummary}` : "Filter tasks"} aria-expanded={filtersOpen} data-tooltip={filterSummary || "Filter tasks"} onClick={() => setFiltersOpen((current) => !current)}><SlidersIcon />{activeFilterCount ? <b>{activeFilterCount}</b> : null}</button>
        </div>
        {filtersOpen ? <div className="task-filter-popover" role="dialog" aria-label="Task filters">
          <section><header><strong>Agent</strong>{selectedProviderKeys.length ? <button onClick={() => chooseProvider("all")}>Clear</button> : null}</header><div className="task-filter-options provider-options" role="group" aria-label="Agent filters">{providerOptions.map((option) => {
            const isSingleSelection = !Array.isArray(selectedProvider) && selectedProvider === option.id;
            const isIncluded = selectedProviderKeys.includes(option.id);
            const unavailable = option.kind === "provider" && !option.available;
            return <div key={option.id} className={`provider-filter-option ${option.available ? "available" : "unavailable"} ${isSingleSelection ? "selected" : ""} ${isIncluded ? "included" : ""}`}>
              <button className="provider-filter-primary" type="button" disabled={unavailable} aria-pressed={isSingleSelection} onClick={() => chooseProvider(option.id)}>
                {option.kind === "available" ? <AvailableAgentsIcon /> : <ProviderLogo providerId={option.id} {...(option.provider ? { provider: option.provider } : {})} size={22}/>}<span>{option.label}</span>
              </button>
              {option.kind !== "all" ? <button className="provider-filter-checkbox" type="button" role="checkbox" aria-checked={isIncluded} aria-label={`${isIncluded ? "Remove" : "Add"} ${option.label} ${isIncluded ? "from" : "to"} custom filter`} disabled={unavailable} onClick={() => toggleProvider(option.id)}><CheckIcon /></button> : null}
            </div>;
          })}</div></section>
          <section><header><strong>Status</strong>{stateFilter !== "all" ? <button onClick={() => chooseState("all")}>Clear</button> : null}</header><div className="task-filter-options state-options">{stateOrder.map((state) => <button key={state} className={stateFilter === state ? "selected" : ""} onClick={() => chooseState(state)}>{stateLabels[state]}</button>)}</div></section>
          <footer>{sessions.length} matching {sessions.length === 1 ? "task" : "tasks"}</footer>
        </div> : null}
      </div>
      <div className="session-list-scroll">
        {sessions.length ? sessions.map((session) => <SessionRow key={session.id} session={session} provider={providerFor(providers, session.providerId)} selected={session.id === selected} onOpen={() => { setSessionMenu(null); onOpen(session.id); }} onContextMenu={(event) => {
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
        }} />) : <EmptyState icon={<SearchIcon />} title="No matching tasks" description="Try another search or filter." />}
      </div>
      {sessionMenu ? <div ref={sessionMenuElement} className="session-context-menu" role="menu" aria-label={`Task actions for ${sessionMenu.title}`} style={{ left: sessionMenu.x, top: sessionMenu.y }}>
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
      </div> : null}
    </section>

    <div className="sidebar-footer">
      <button className={`sidebar-settings ${view === "settings" ? "active" : ""}`} onClick={() => onView("settings")}><SettingsIcon /><span>Settings</span></button>
      <span className={`sidebar-runtime-indicator ${connected ? "connected" : "offline"}`} role="status" aria-label={`${hostName}. Runtime ${connected ? "online" : "offline"}`} data-tooltip={`${hostName} · Runtime ${connected ? "online" : "offline"}`} />
    </div>
  </aside>;
}

function SessionRow({ session, provider, selected, onOpen, onContextMenu }: { session: Session; provider?: Provider | undefined; selected: boolean; onOpen: () => void; onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void }) {
  const location = session.workingDirectory || session.project;
  return <button className={`session-row ${selected ? "selected" : ""}`} onClick={onOpen} onContextMenu={onContextMenu}>
    <div className="session-row-top"><ProviderLogo providerId={session.providerId} provider={provider} size={23}/><span className="session-row-title"><strong>{session.title}</strong></span><span className="session-row-trailing"><time>{relativeTime(session.updatedAt)}</time><i className={`session-row-state session-row-state-${session.state}`} aria-label={stateLabels[session.state]} data-tooltip={stateLabels[session.state]} /></span></div>
    <p>{session.preview}</p>
    <div className="session-row-meta"><span className="session-location" title={location} aria-label={`${session.project}. Working directory: ${location}`}><FolderIcon />{session.project}</span>{session.unread ? <b className="unread-count">{session.unread}</b> : null}</div>
  </button>;
}
