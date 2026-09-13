import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseConfig } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const requestedNext = request.nextUrl.searchParams.get("next") ?? "/dashboard";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//") && !requestedNext.includes("\\")
    ? requestedNext
    : "/dashboard";

  if (code && hasSupabaseConfig()) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // URL parsing strips tabs and newlines, which can turn a local-looking
      // path into a protocol-relative URL. Check the resolved origin too.
      const destination = new URL(next, request.url);
      return NextResponse.redirect(destination.origin === request.nextUrl.origin
        ? destination
        : new URL("/dashboard", request.url));
    }
  }

  return NextResponse.redirect(new URL("/auth/sign-in?error=callback", request.url));
}
