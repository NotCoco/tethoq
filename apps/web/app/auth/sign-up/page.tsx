import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { Brand } from "@/components/brand";
import { hasSupabaseConfig } from "@/lib/config";
import { signUp } from "../actions";

export const metadata: Metadata = { title: "Create account" };
export default function Page() { return <main className="auth-page"><div className="auth-brand"><Brand /></div><AuthForm action={signUp} kind="sign-up" configured={hasSupabaseConfig()} /></main>; }
