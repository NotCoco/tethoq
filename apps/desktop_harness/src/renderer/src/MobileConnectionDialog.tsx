import { useEffect, useMemo, useRef, useState } from "react";
import type { MobileConnectionState } from "@shared/desktop_api";
import { isBrowserPreview } from "./bridge";
import { Button, Modal } from "./components";
import { AlertIcon, BridgeIcon, CheckIcon } from "./icons";

const idleState: MobileConnectionState = { state: "idle", devices: [] };
const previewQr = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="white"/><path fill="#10110f" d="M3 3h7v7H3zm2 2v3h3V5zm14-2h7v7h-7zm2 2v3h3V5zM3 19h7v7H3zm2 2v3h3v-3zm8-18h3v3h-3zm0 6h3v4h4v3h-7zm9 4h4v4h-3v-2h-1zm-9 6h3v7h-3zm5 1h3v3h3v3h-6z"/></svg>`)}`;

const previewState: MobileConnectionState = {
  state: "ready",
  devices: [],
  qrDataUrl: previewQr,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};

export function MobileConnectionDialog({ onClose }: { onClose: () => void }) {
  const [connection, setConnection] = useState<MobileConnectionState>(idleState);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const startedAutomatically = useRef(false);

  useEffect(() => {
    if (isBrowserPreview) {
      setConnection(previewState);
      return;
    }
    let active = true;
    const receive = (state: MobileConnectionState) => { if (active) setConnection(state); };
    const unsubscribe = window.tethoqDesktop.onMobileConnectionState(receive);
    void window.tethoqDesktop.mobileConnectionState().then(async (state) => {
      if (!active) return;
      setConnection(state);
      if (state.state === "idle" && state.devices.length === 0 && !startedAutomatically.current) {
        startedAutomatically.current = true;
        receive(await window.tethoqDesktop.mobileConnectionAction({ type: "start" }));
      }
    }).catch(() => {
      if (active) setConnection({ state: "error", devices: [], message: "Tethoq couldn't open phone pairing. Try again." });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (connection.state !== "ready" || connection.expiresAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [connection.expiresAt, connection.state]);

  const remainingSeconds = useMemo(() => connection.expiresAt === undefined
    ? 0
    : Math.max(0, Math.ceil((Date.parse(connection.expiresAt) - now) / 1_000)), [connection.expiresAt, now]);

  const startPairing = async () => {
    if (isBrowserPreview) { setConnection(previewState); return; }
    setConnection((current) => ({ state: "starting", devices: current.devices }));
    try { setConnection(await window.tethoqDesktop.mobileConnectionAction({ type: "start" })); }
    catch { setConnection((current) => ({ state: "error", devices: current.devices, message: "Tethoq couldn't prepare a phone connection. Try again." })); }
  };

  const revoke = async (connectionId: string) => {
    if (isBrowserPreview) {
      setConnection((current) => ({ ...current, devices: current.devices.filter((device) => device.id !== connectionId) }));
      return;
    }
    setBusyConnectionId(connectionId);
    try { setConnection(await window.tethoqDesktop.mobileConnectionAction({ type: "revoke", connectionId })); }
    catch { setConnection((current) => ({ state: "error", devices: current.devices, message: "Tethoq couldn't remove that phone. Try again." })); }
    finally { setBusyConnectionId(null); }
  };

  const canStart = connection.state === "idle" || connection.state === "paired" || connection.state === "error";
  const hasConnectedPhone = connection.devices.some((device) => device.connected);
  const startLabel = connection.state === "error" ? "Try again" : hasConnectedPhone ? "Pair another phone" : "Pair a phone";

  return <Modal title="Connect your phone" eyebrow="Tethoq Bridge" onClose={onClose}>
    <div className="mobile-connection-dialog">
      <p className="mobile-connection-intro">Open Tethoq on your phone and scan the one-time code. Your coding tools stay on this computer.</p>

      {connection.state === "starting" ? <div className="mobile-connection-pending" role="status"><span className="spinner"/><span><strong>Preparing a secure connection…</strong><small>This can take a few moments the first time.</small></span></div> : null}

      {connection.state === "ready" && connection.qrDataUrl ? <div className="mobile-pairing-code">
        <img src={connection.qrDataUrl} alt="One-time Tethoq phone pairing code" draggable={false}/>
        <p>{remainingSeconds > 0 ? `Expires in ${formatRemaining(remainingSeconds)}` : "This code is expiring…"}</p>
      </div> : null}

      {connection.state === "paired" ? <div className="mobile-connection-success" role="status"><CheckIcon/><span><strong>{hasConnectedPhone ? "Phone connected" : "Phone paired"}</strong><small>{hasConnectedPhone ? "You can now use this computer's tasks from mobile." : "Pairing is saved. Waiting for the phone to connect."}</small></span></div> : null}

      {connection.state === "error" ? <div className="mobile-connection-error" role="alert"><AlertIcon/><span><strong>Connection unavailable</strong><small>{connection.message ?? "Tethoq couldn't prepare a secure phone connection."}</small></span></div> : null}

      {connection.devices.length > 0 ? <section className="paired-phones" aria-labelledby="paired-phones-title">
        <h3 id="paired-phones-title">Saved phones</h3>
        <div>{connection.devices.map((device, index) => <div className="paired-phone-row" key={device.id}>
          <BridgeIcon/>
          <span><strong>{connection.devices.length === 1 ? "Phone" : `Phone ${index + 1}`}</strong><small><span className={`paired-phone-status ${device.connected ? "connected" : "not-connected"}`}>{device.connected ? "Connected" : "Not connected"}</span><span className="paired-phone-date"> · {pairedDate(device.pairedAt)}</span></small></span>
          <Button type="button" variant="danger" disabled={busyConnectionId === device.id} onClick={() => void revoke(device.id)}>{busyConnectionId === device.id ? "Removing…" : "Remove"}</Button>
        </div>)}</div>
      </section> : null}

      <div className="modal-actions mobile-connection-actions">
        <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        {canStart ? <Button type="button" variant="primary" onClick={() => void startPairing()}>{startLabel}</Button> : null}
      </div>
    </div>
  </Modal>;
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function pairedDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Paired with this computer";
  return `Paired ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(timestamp)}`;
}
