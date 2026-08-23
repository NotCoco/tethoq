import { protocol, type Session } from "electron";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { isLocalVideoPath, LOCAL_MEDIA_SCHEME, localMediaPathFromUrl, localMediaRange } from "../shared/local_media.js";
import { existingLocalTarget } from "./local_open.js";

function localVideoContentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".webm") return "video/webm";
  if (extension === ".mov") return "video/quicktime";
  if (extension === ".m4v") return "video/x-m4v";
  return "video/mp4";
}

export function registerLocalMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: LOCAL_MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

export function registerLocalMediaProtocol(targetSession: Session): void {
  targetSession.protocol.handle(LOCAL_MEDIA_SCHEME, async (request) => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const path = localMediaPathFromUrl(request.url);
    if (!path || !isLocalVideoPath(path)) return new Response(null, { status: 404 });
    try {
      const target = await existingLocalTarget(path);
      if (target.kind !== "file") return new Response(null, { status: 404 });
      const size = (await stat(target.path)).size;
      const range = localMediaRange(request.headers.get("range"), size);
      if (range.kind === "unsatisfiable") {
        return new Response(null, { status: 416, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}` } });
      }
      const start = range.kind === "partial" ? range.start : 0;
      const end = range.kind === "partial" ? range.end : Math.max(0, size - 1);
      const contentType = localVideoContentType(target.path);
      const file = await openAsBlob(target.path, { type: contentType });
      const body = size > 0 ? file.slice(start, end + 1, contentType) : null;
      const headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": String(size > 0 ? end - start + 1 : 0),
        "Content-Type": contentType,
        ...(range.kind === "partial" ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      };
      return new Response(body, { status: range.kind === "partial" ? 206 : 200, headers });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
