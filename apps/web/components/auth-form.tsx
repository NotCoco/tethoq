"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { AuthState } from "@/app/auth/actions";
import { createClient } from "@/lib/supabase/browser";
import { GoogleMark } from "./icons";

type Action = (state: AuthState, formData: FormData) => Promise<AuthState>;

interface Props {
  action: Action;
  kind: "sign-in" | "sign-up" | "forgot" | "update";
  configured: boolean;
}

const copy = {
  "sign-in": { title: "Welcome back", subtitle: "Continue to your Tethoq workspace.", submit: "Sign in", password: true },
  "sign-up": { title: "Create your account", subtitle: "Set up Tethoq, then connect your first computer.", submit: "Create account", password: true },
  forgot: { title: "Reset your password", subtitle: "We’ll send a secure reset link if the account exists.", submit: "Send reset link", password: false },
  update: { title: "Choose a new password", subtitle: "Use at least 8 characters for your new password.", submit: "Update password", password: true },
} as const;

export function AuthForm({ action, kind, configured }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const [oauthPending, setOauthPending] = useState(false);
  const content = copy[kind];
  const email = kind !== "update";
  const showGoogle = kind === "sign-in" || kind === "sign-up";

  async function google() {
    if (!configured) return;
    setOauthPending(true);
    try {
      const supabase = createClient();
      const origin = window.location.origin;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${origin}/auth/callback?next=/dashboard` },
      });
      if (error) throw error;
    } catch {
      setOauthPending(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-heading">
        <p className="eyebrow">Tethoq account</p>
        <h1>{content.title}</h1>
        <p>{content.subtitle}</p>
      </div>
      {!configured && <div className="notice notice-warning">Account services are not configured on this preview deployment.</div>}
      {showGoogle && (
        <>
          <button className="oauth-button" type="button" onClick={google} disabled={!configured || oauthPending}>
            <GoogleMark /> {oauthPending ? "Opening Google…" : "Continue with Google"}
          </button>
          <div className="or"><span>or continue with email</span></div>
        </>
      )}
      <form action={formAction} className="auth-fields">
        {email && <label>Email<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label>}
        {content.password && <label>{kind === "update" ? "New password" : "Password"}<input name="password" type="password" minLength={8} autoComplete={kind === "sign-in" ? "current-password" : "new-password"} required /></label>}
        {kind === "sign-in" && <Link className="field-link" href="/auth/forgot-password">Forgot password?</Link>}
        {state.message && <p className={`form-message ${state.status === "success" ? "success" : "error"}`} role="status">{state.message}</p>}
        <button className="button button-primary button-block" type="submit" disabled={pending || !configured}>{pending ? "Please wait…" : content.submit}</button>
      </form>
      <div className="auth-switch">
        {kind === "sign-in" && <p>New to Tethoq? <Link href="/auth/sign-up">Create an account</Link></p>}
        {kind === "sign-up" && <p>Already have an account? <Link href="/auth/sign-in">Sign in</Link></p>}
        {(kind === "forgot" || kind === "update") && <p><Link href="/auth/sign-in">Back to sign in</Link></p>}
      </div>
    </div>
  );
}
