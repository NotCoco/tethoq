export function hasSupabaseConfig(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
  );
}

export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/u, "") || "http://localhost:3000";
}

function securePublicUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function desktopWindowsDownloadUrl(): string | null {
  return securePublicUrl(process.env.NEXT_PUBLIC_DESKTOP_WINDOWS_DOWNLOAD_URL);
}

export function bridgeWindowsDownloadUrl(): string | null {
  return securePublicUrl(
    process.env.NEXT_PUBLIC_BRIDGE_WINDOWS_DOWNLOAD_URL ??
      process.env.NEXT_PUBLIC_WINDOWS_DOWNLOAD_URL,
  );
}

export function desktopChecksumUrl(): string | null {
  return securePublicUrl(process.env.NEXT_PUBLIC_DESKTOP_CHECKSUM_URL);
}

export function bridgeChecksumUrl(): string | null {
  return securePublicUrl(process.env.NEXT_PUBLIC_BRIDGE_CHECKSUM_URL);
}
