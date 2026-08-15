import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { Brand } from "@/components/brand";
import { hasSupabaseConfig } from "@/lib/config";
import { sendReset } from "../actions";

export const metadata: Metadata = { title: "Reset password" };
export default function Page() { return <main className="auth-page"><div className="auth-brand"><Brand /></div><AuthForm action={sendReset} kind="forgot" configured={hasSupabaseConfig()} /></main>; }
