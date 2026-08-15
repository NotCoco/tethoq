import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { DashboardClient, type ComputerView, type DeviceView } from "@/components/dashboard-client";
import { hasSupabaseConfig } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "../auth/actions";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  if (!hasSupabaseConfig()) redirect("/auth/sign-in");
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();
  if (!claimsData?.claims?.sub) redirect("/auth/sign-in");

  const [{ data: computerRows }, { data: deviceRows }] = await Promise.all([
    supabase.from("computers").select("id,name,platform,bridge_version,last_seen_at,revoked_at").is("revoked_at", null).order("created_at", { ascending: true }),
    supabase.from("devices").select("id,name,platform,last_seen_at,revoked_at").is("revoked_at", null).order("created_at", { ascending: true }),
  ]);
  const computers: ComputerView[] = (computerRows ?? []).map((row) => ({ id: row.id, name: row.name, platform: row.platform, bridgeVersion: row.bridge_version, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at }));
  const devices: DeviceView[] = (deviceRows ?? []).map((row) => ({ id: row.id, name: row.name, platform: row.platform, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at }));

  return (
    <main className="dashboard-page">
      <header className="dashboard-header"><Brand /><nav><Link href="/download">Get Tethoq Bridge</Link><form action={signOut}><button className="text-button" type="submit">Sign out</button></form></nav></header>
      <div className="dashboard-shell">
        <div className="dashboard-intro"><p className="eyebrow">Your Tethoq</p><h1>Connected access</h1><p>Manage the computers and phones allowed to reach your coding-agent sessions.</p></div>
        <DashboardClient computers={computers} devices={devices} configured />
        <aside className="dashboard-note"><strong>Pairing is not automatic yet.</strong><span>The account and revocation model is ready. Tethoq Bridge still needs its signed installer and cloud enrollment endpoint before computers can appear here outside development.</span></aside>
      </div>
    </main>
  );
}
