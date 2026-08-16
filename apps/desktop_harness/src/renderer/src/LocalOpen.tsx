import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LocalOpenHandler, LocalOpenHandlerIcon, LocalOpenHandlerId, LocalOpenState } from "@shared/desktop_api";
import { CheckIcon, ChevronDownIcon, CursorAppIcon, ExplorerIcon, NotepadPlusIcon, SublimeIcon, VSCodeIcon, WindsurfIcon, ZedIcon } from "./icons";

export interface LocalOpenLocation {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

interface LocalOpenContextValue {
  readonly state: LocalOpenState;
  readonly open: (location: LocalOpenLocation, handlerId?: LocalOpenHandlerId, rememberAsDefault?: boolean) => Promise<void>;
}

export const previewLocalOpenState: LocalOpenState = {
  defaultHandlerId: "system",
  handlers: [
    { id: "system", label: "File Explorer", icon: "explorer" },
    { id: "vscode", label: "Visual Studio Code", icon: "vscode" },
    { id: "cursor", label: "Cursor", icon: "cursor" },
  ],
};

const fallbackLocalOpenContext: LocalOpenContextValue = { state: previewLocalOpenState, open: async () => undefined };
const LocalOpenContext = createContext<LocalOpenContextValue>(fallbackLocalOpenContext);

export function LocalOpenProvider({ state, onOpen, children }: {
  state: LocalOpenState;
  onOpen: LocalOpenContextValue["open"];
  children: ReactNode;
}) {
  const value = useMemo(() => ({ state, open: onOpen }), [state, onOpen]);
  return <LocalOpenContext.Provider value={value}>{children}</LocalOpenContext.Provider>;
}

export function useLocalOpen(): LocalOpenContextValue {
  return useContext(LocalOpenContext);
}

export function LocalOpenHandlerGlyph({ icon }: { icon: LocalOpenHandlerIcon }) {
  if (icon === "vscode") return <VSCodeIcon />;
  if (icon === "cursor") return <CursorAppIcon />;
  if (icon === "windsurf") return <WindsurfIcon />;
  if (icon === "sublime") return <SublimeIcon />;
  if (icon === "notepadpp") return <NotepadPlusIcon />;
  if (icon === "zed") return <ZedIcon />;
  return <ExplorerIcon />;
}

function HandlerItems({ handlers, defaultHandlerId, onSelect }: {
  handlers: readonly LocalOpenHandler[];
  defaultHandlerId: LocalOpenHandlerId;
  onSelect: (handler: LocalOpenHandler) => void;
}) {
  return <>{handlers.map((handler) => <button type="button" role="menuitem" key={handler.id} onClick={() => onSelect(handler)}>
    <LocalOpenHandlerGlyph icon={handler.icon} />
    <span>{handler.label}</span>
    {handler.id === defaultHandlerId ? <CheckIcon /> : <i aria-hidden="true" />}
  </button>)}</>;
}

export function LocalPathAction({ location, children, className }: { location: LocalOpenLocation; children: ReactNode; className?: string }) {
  const localOpen = useLocalOpen();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);
  const openDefault = () => void localOpen.open(location);
  return <>
    <a href="#" className={className} onClick={(event) => { event.preventDefault(); openDefault(); }} onContextMenu={(event) => {
      event.preventDefault();
      setMenu({ x: Math.min(event.clientX, Math.max(8, window.innerWidth - 228)), y: Math.min(event.clientY, Math.max(8, window.innerHeight - 260)) });
    }}>{children}</a>
    {menu && typeof document !== "undefined" ? createPortal(<div className="local-open-menu local-open-context-menu" role="menu" aria-label="Open in" style={{ "--local-menu-x": `${menu.x}px`, "--local-menu-y": `${menu.y}px` } as CSSProperties} onMouseDown={(event) => event.stopPropagation()}>
      <header>Open in</header>
      <div><HandlerItems handlers={localOpen.state.handlers} defaultHandlerId={localOpen.state.defaultHandlerId} onSelect={(handler) => { setMenu(null); void localOpen.open(location, handler.id); }} /></div>
    </div>, document.body) : null}
  </>;
}

export function WorkspaceLocalOpenControl({ path }: { path: string }) {
  const localOpen = useLocalOpen();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const current = localOpen.state.handlers.find((handler) => handler.id === localOpen.state.defaultHandlerId) ?? localOpen.state.handlers[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", escape); };
  }, [open]);
  if (!current) return null;
  return <div className={`workspace-local-open ${open ? "open" : ""}`} ref={root}>
    <div className="workspace-local-open-split">
      <button type="button" className="workspace-local-open-primary" data-tooltip={`Open in ${current.label}`} aria-label={`Open task folder in ${current.label}`} onClick={() => void localOpen.open({ path })}><LocalOpenHandlerGlyph icon={current.icon} /></button>
      <button type="button" className="workspace-local-open-arrow" aria-label="Choose an application" aria-expanded={open} onClick={() => setOpen((value) => !value)}><ChevronDownIcon /></button>
    </div>
    {open ? <div className="local-open-menu workspace-local-open-menu" role="menu" aria-label="Open task folder in">
      <header>Open in</header>
      <div><HandlerItems handlers={localOpen.state.handlers} defaultHandlerId={localOpen.state.defaultHandlerId} onSelect={(handler) => { setOpen(false); void localOpen.open({ path }, handler.id, true); }} /></div>
    </div> : null}
  </div>;
}
