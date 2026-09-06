export const LOCAL_MEDIA_SCHEME = "tethoq-media";

const LOCAL_IMAGE_TYPES = [
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
] as const;

const LOCAL_VIDEO_TYPES = [
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".m4v", "video/x-m4v"],
  [".mov", "video/quicktime"],
] as const;

export type LocalMediaRange =
  | { readonly kind: "full" }
  | { readonly kind: "partial"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

export function isLocalVideoPath(path: string): boolean {
  const lower = path.toLowerCase();
  return LOCAL_VIDEO_TYPES.some(([extension]) => lower.endsWith(extension));
}

export function isLocalImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  return LOCAL_IMAGE_TYPES.some(([extension]) => lower.endsWith(extension));
}

export function localMediaContentType(path: string): string | null {
  const lower = path.toLowerCase();
  return [...LOCAL_IMAGE_TYPES, ...LOCAL_VIDEO_TYPES].find(([extension]) => lower.endsWith(extension))?.[1] ?? null;
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

function absoluteLocalPath(value: string): string | null {
  if (!value || value.length > 32_768 || value.includes("\0")) return null;
  if (/^[a-z]:[\\/]/iu.test(value)) return value;
  return value.startsWith("/") && !value.startsWith("//") ? value : null;
}

/** Converts a provider-supplied local reference without ever admitting a network share. */
export function localMediaPathFromReference(value: string): string | null {
  const encodedMediaPath = localMediaPathFromUrl(value);
  if (encodedMediaPath !== null) return absoluteLocalPath(encodedMediaPath);
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost") || url.search || url.hash) return null;
      let path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//iu.test(path)) path = path.slice(1);
      return absoluteLocalPath(path);
    } catch {
      return null;
    }
  }
  try {
    return absoluteLocalPath(decodeURIComponent(value));
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
