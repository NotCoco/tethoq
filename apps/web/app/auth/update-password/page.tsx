import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { Brand } from "@/components/brand";
import { hasSupabaseConfig } from "@/lib/config";
import { updatePassword } from "../actions";

export const metadata: Metadata = { title: "Update password" };
export default function Page() { return <main className="auth-page"><div className="auth-brand"><Brand /></div><AuthForm action={updatePassword} kind="update" configured={hasSupabaseConfig()} /></main>; }
