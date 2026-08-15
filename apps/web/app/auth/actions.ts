"use server";

import { redirect } from "next/navigation";
import { hasSupabaseConfig, siteUrl } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";

export interface AuthState {
  message?: string;
  status?: "error" | "success";
}

function value(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function unavailable(): AuthState {
  return { status: "error", message: "Authentication is not configured on this deployment yet." };
}

export async function signIn(_state: AuthState, formData: FormData): Promise<AuthState> {
  if (!hasSupabaseConfig()) return unavailable();
  const email = value(formData, "email");
  const password = value(formData, "password");
  if (!email || !password) return { status: "error", message: "Enter your email and password." };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { status: "error", message: error.message };
  redirect("/dashboard");
}

export async function signUp(_state: AuthState, formData: FormData): Promise<AuthState> {
  if (!hasSupabaseConfig()) return unavailable();
  const email = value(formData, "email");
  const password = value(formData, "password");
  if (!email || password.length < 8) return { status: "error", message: "Use a valid email and at least 8 characters." };
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${siteUrl()}/auth/callback?next=/dashboard` },
  });
  if (error) return { status: "error", message: error.message };
  if (data.session) redirect("/dashboard");
  return { status: "success", message: "Check your inbox to confirm your account, then sign in." };
}

export async function sendReset(_state: AuthState, formData: FormData): Promise<AuthState> {
  if (!hasSupabaseConfig()) return unavailable();
  const email = value(formData, "email");
  if (!email) return { status: "error", message: "Enter your email address." };
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${siteUrl()}/auth/callback?next=/auth/update-password`,
  });
  if (error) return { status: "error", message: error.message };
  return { status: "success", message: "If that account exists, a reset link is on its way." };
}

export async function updatePassword(_state: AuthState, formData: FormData): Promise<AuthState> {
  if (!hasSupabaseConfig()) return unavailable();
  const password = value(formData, "password");
  if (password.length < 8) return { status: "error", message: "Use at least 8 characters." };
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { status: "error", message: error.message };
  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  if (hasSupabaseConfig()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/");
}
