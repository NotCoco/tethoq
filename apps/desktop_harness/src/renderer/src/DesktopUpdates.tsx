import { useEffect, useState } from "react";
import type { DesktopUpdateAction, DesktopUpdateState } from "@shared/desktop_api";
import { Button } from "./components";
import "./desktop-updates.css";

export function useDesktopUpdates(): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    const api = window.tethoqDesktop;
    if (!api?.updateState || !api.onUpdateState) return;
    let current = true;
    let receivedEvent = false;
    const unsubscribe = api.onUpdateState((value) => { receivedEvent = true; if (current) setState(value); });
    void api.updateState().then((value) => { if (current && !receivedEvent) setState(value); }).catch(() => {});
    return () => { current = false; unsubscribe(); };
  }, []);
  return state;
}

export function DesktopUpdates() {
  const state = useDesktopUpdates();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!state) return null;
  const busy = ["checking", "downloading", "installing"].includes(state.phase);
  const action: DesktopUpdateAction = state.phase === "available" ? "download" : state.phase === "downloaded" ? "install" : "check";
  const label = state.phase === "checking" ? "Checking…"
    : state.phase === "downloading" ? `Downloading ${state.percent ?? 0}%`
      : state.phase === "installing" ? "Restarting…"
        : action === "download" ? "Download update" : action === "install" ? "Restart to update" : "Check for updates";
  const description = state.message ?? (state.phase === "unavailable" ? "Updates are available in installed Windows releases."
    : state.phase === "available" ? `Tethoq ${state.version} is available.`
      : state.phase === "downloaded" ? `Tethoq ${state.version} is ready. Restart when your tasks are finished.`
        : state.phase === "downloading" ? `Downloading Tethoq ${state.version}. You can keep working.`
          : "Checks for new releases automatically. You choose when to download and restart.");
  const run = async () => {
    setError(null);
    setPending(true);
    try { await window.tethoqDesktop.updateAction(action); }
    catch { setError("Tethoq could not start the update. Try again."); }
    finally { setPending(false); }
  };
  return <section className="settings-block desktop-updates" aria-label="Tethoq updates">
    <header><h2>Updates</h2></header>
    <div className="desktop-update-row">
      <span><strong>Tethoq {state.currentVersion}</strong><small role="status">{error ?? description}</small></span>
      {state.phase !== "unavailable" ? <Button type="button" disabled={busy || pending} onClick={() => void run()}>{label}</Button> : null}
    </div>
  </section>;
}
