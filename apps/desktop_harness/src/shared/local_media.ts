export const LOCAL_MEDIA_SCHEME = "tethoq-media";

const LOCAL_VIDEO_EXTENSIONS = [".mp4", ".webm", ".m4v", ".mov"] as const;

export type LocalMediaRange =
  | { readonly kind: "full" }
  | { readonly kind: "partial"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

export function isLocalVideoPath(path: string): boolean {
  const lower = path.toLowerCase();
  return LOCAL_VIDEO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function localMediaUrl(path: string): string {
  return `${LOCAL_MEDIA_SCHEME}://local/${encodeURIComponent(path)}`;
}

export function localMediaPathFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== `${LOCAL_MEDIA_SCHEME}:` || url.hostname !== "local" || url.search || url.hash) return null;
    const encodedPath = url.pathname.slice(1);
    return encodedPath ? decodeURIComponent(encodedPath) : null;
  } catch {
    return null;
  }
}

export function localMediaRange(value: string | null, size: number): LocalMediaRange {
  if (value === null) return { kind: "full" };
  if (!Number.isSafeInteger(size) || size <= 0) return { kind: "unsatisfiable" };
  const match = value.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2])) return { kind: "unsatisfiable" };
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "partial", start, end: Math.min(requestedEnd, size - 1) };
}
