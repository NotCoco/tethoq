import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { Brand } from "@/components/brand";
import { hasSupabaseConfig } from "@/lib/config";
import { signIn } from "../actions";

export const metadata: Metadata = { title: "Sign in" };
export default function Page() { return <main className="auth-page"><div className="auth-brand"><Brand /></div><AuthForm action={signIn} kind="sign-in" configured={hasSupabaseConfig()} /></main>; }
