import { protocol, type Session } from "electron";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { isLocalImagePath, LOCAL_MEDIA_SCHEME, localMediaContentType, localMediaPathFromUrl, localMediaRange } from "../shared/local_media.js";
import { existingLocalTarget } from "./local_open.js";

const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024;

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
    if (!path || localMediaContentType(path) === null) return new Response(null, { status: 404 });
    try {
      const target = await existingLocalTarget(path);
      if (target.kind !== "file") return new Response(null, { status: 404 });
      const size = (await stat(target.path)).size;
      const contentType = localMediaContentType(target.path);
      if (contentType === null || (isLocalImagePath(target.path) && (size <= 0 || size > MAX_LOCAL_IMAGE_BYTES))) {
        return new Response(null, { status: 404 });
      }
      const range = localMediaRange(request.headers.get("range"), size);
      if (range.kind === "unsatisfiable") {
        return new Response(null, { status: 416, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}` } });
      }
      const start = range.kind === "partial" ? range.start : 0;
      const end = range.kind === "partial" ? range.end : Math.max(0, size - 1);
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
