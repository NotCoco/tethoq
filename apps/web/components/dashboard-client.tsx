"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Laptop, Phone } from "./icons";

export interface ComputerView {
  id: string;
  name: string;
  platform: string;
  bridgeVersion: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface Props {
  computers: ComputerView[];
  devices: DeviceView[];
  configured: boolean;
}

function relative(value: string | null): string {
  if (!value) return "Not connected yet";
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "Active now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function DashboardClient({ computers: initialComputers, devices: initialDevices, configured }: Props) {
  const [computers, setComputers] = useState(initialComputers);
  const [devices, setDevices] = useState(initialDevices);
  const [busy, setBusy] = useState<string | null>(null);

  async function revoke(kind: "computer" | "device", id: string) {
    if (!configured || !window.confirm(`Revoke this ${kind}? It will need to be enrolled again.`)) return;
    setBusy(id);
    const supabase = createClient();
    const { error } = await supabase.from(kind === "computer" ? "computers" : "devices").update({ revoked_at: new Date().toISOString() }).eq("id", id);
    if (!error) {
      if (kind === "computer") setComputers((items) => items.filter((item) => item.id !== id));
      else setDevices((items) => items.filter((item) => item.id !== id));
    }
    setBusy(null);
  }

  return (
    <div className="dashboard-grid">
      <section className="dashboard-panel" aria-labelledby="computers-heading">
        <div className="panel-heading"><div><p className="eyebrow">Bridge hosts</p><h2 id="computers-heading">Computers</h2></div><span className="count">{computers.length}</span></div>
        {computers.length === 0 ? (
          <div className="empty-state"><Laptop /><h3>No computers connected</h3><p>Install Tethoq Bridge on your computer, sign in, and it will appear here.</p><a className="button button-light button-small" href="/download">Get the bridge</a></div>
        ) : <div className="resource-list">{computers.map((computer) => <article className="resource" key={computer.id}><span className="resource-icon"><Laptop /></span><div><h3>{computer.name}</h3><p>{computer.platform}{computer.bridgeVersion ? ` · Bridge ${computer.bridgeVersion}` : ""}</p></div><span className="resource-status">{relative(computer.lastSeenAt)}</span><button className="danger-link" disabled={busy === computer.id} onClick={() => revoke("computer", computer.id)}>Revoke</button></article>)}</div>}
      </section>
      <section className="dashboard-panel" aria-labelledby="devices-heading">
        <div className="panel-heading"><div><p className="eyebrow">Mobile access</p><h2 id="devices-heading">Devices</h2></div><span className="count">{devices.length}</span></div>
        {devices.length === 0 ? (
          <div className="empty-state"><Phone /><h3>No phones enrolled</h3><p>Sign into the Tethoq mobile app with this account to add a device.</p></div>
        ) : <div className="resource-list">{devices.map((device) => <article className="resource" key={device.id}><span className="resource-icon"><Phone /></span><div><h3>{device.name}</h3><p>{device.platform}</p></div><span className="resource-status">{relative(device.lastSeenAt)}</span><button className="danger-link" disabled={busy === device.id} onClick={() => revoke("device", device.id)}>Revoke</button></article>)}</div>}
      </section>
    </div>
  );
}
