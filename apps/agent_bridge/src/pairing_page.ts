import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import QRCode from "qrcode";

const MAX_PAGE_LIFETIME_MS = 5 * 60 * 1_000;

export interface PairingPage {
  readonly url: string;
  readonly expiresAt: string;
  dispose(): Promise<void>;
}

export interface PairingPageOptions {
  readonly now?: () => number;
}

type BrowserLauncher = (command: string, args: readonly string[]) => Promise<void>;

export interface OpenDefaultBrowserOptions {
  readonly platform?: NodeJS.Platform;
  readonly launch?: BrowserLauncher;
}

export async function startPairingPage(
  qrText: string,
  payloadExpiresAt: string,
  options: PairingPageOptions = {},
): Promise<PairingPage> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const payloadDeadline = Date.parse(payloadExpiresAt);
  if (!Number.isFinite(payloadDeadline)) throw new Error("Pairing payload expiration is invalid");
  const deadline = Math.min(payloadDeadline, startedAt + MAX_PAGE_LIFETIME_MS);
  const route = `/pair/${randomBytes(24).toString("base64url")}`;
  const styleNonce = randomBytes(18).toString("base64url");
  let qrSvg: string | undefined = deadline > startedAt
    ? await QRCode.toString(qrText, { type: "svg", errorCorrectionLevel: "M", margin: 4 })
    : undefined;
  let expectedHost = "";
  let expectedOrigin = "";

  const server = createServer((request, response) => {
    handleRequest(request, response, {
      route,
      expectedHost,
      expectedOrigin,
      styleNonce,
      deadline,
      now,
      qrSvg: () => qrSvg,
      expire: () => { qrSvg = undefined; },
    });
  });
  server.maxHeadersCount = 40;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  expectedHost = `127.0.0.1:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;
  const url = `${expectedOrigin}${route}`;
  const expiryTimer = setTimeout(() => { qrSvg = undefined; }, Math.max(0, deadline - startedAt));
  expiryTimer.unref();
  let disposePromise: Promise<void> | undefined;

  return {
    url,
    expiresAt: new Date(deadline).toISOString(),
    dispose: () => {
      if (disposePromise !== undefined) return disposePromise;
      clearTimeout(expiryTimer);
      qrSvg = undefined;
      disposePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      return disposePromise;
    },
  };
}

export async function openDefaultBrowser(url: string, options: OpenDefaultBrowserOptions = {}): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser URL must use http or https");
  }
  const platform = options.platform ?? process.platform;
  const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open";
  await (options.launch ?? launchDetached)(command, [parsed.toString()]);
}

interface RequestContext {
  readonly route: string;
  readonly expectedHost: string;
  readonly expectedOrigin: string;
  readonly styleNonce: string;
  readonly deadline: number;
  readonly now: () => number;
  readonly qrSvg: () => string | undefined;
  readonly expire: () => void;
}

function handleRequest(request: IncomingMessage, response: ServerResponse, context: RequestContext): void {
  const host = firstHeader(request.headers.host)?.toLowerCase();
  if (host !== context.expectedHost) {
    send(response, request.method, 421, "Misdirected Request\n", context.styleNonce, "text/plain; charset=utf-8");
    return;
  }

  const fetchSite = firstHeader(request.headers["sec-fetch-site"])?.toLowerCase();
  const origin = firstHeader(request.headers.origin);
  if ((fetchSite !== undefined && fetchSite !== "none" && fetchSite !== "same-origin") ||
      (origin !== undefined && origin !== context.expectedOrigin)) {
    send(response, request.method, 403, "Forbidden\n", context.styleNonce, "text/plain; charset=utf-8");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    send(response, request.method, 405, "Method Not Allowed\n", context.styleNonce, "text/plain; charset=utf-8");
    return;
  }
  if (request.url !== context.route) {
    send(response, request.method, 404, "Not Found\n", context.styleNonce, "text/plain; charset=utf-8");
    return;
  }

  if (context.now() >= context.deadline) context.expire();
  const qrSvg = context.qrSvg();
  if (qrSvg === undefined) {
    send(response, request.method, 410, "This pairing page has expired.\n", context.styleNonce, "text/plain; charset=utf-8");
    return;
  }
  send(response, request.method, 200, pairingHtml(qrSvg, context.styleNonce), context.styleNonce, "text/html; charset=utf-8");
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function securityHeaders(styleNonce: string, contentType: string): Record<string, string> {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${styleNonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Expires": "0",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(
  response: ServerResponse,
  method: string | undefined,
  status: number,
  body: string,
  styleNonce: string,
  contentType: string,
): void {
  response.writeHead(status, {
    ...securityHeaders(styleNonce, contentType),
    "Content-Length": Buffer.byteLength(body).toString(),
  });
  response.end(method === "HEAD" ? undefined : body);
}

function pairingHtml(qrSvg: string, styleNonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Tethoq</title>
  <style nonce="${styleNonce}">
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #111318; color: #f5f7fb; }
    main { width: min(88vw, 28rem); text-align: center; }
    h1 { margin: 0 0 .55rem; font-size: clamp(1.8rem, 6vw, 2.5rem); }
    p { margin: 0 auto 1.25rem; color: #b8bfcc; line-height: 1.5; }
    .qr { box-sizing: border-box; margin: 0 auto 1.25rem; padding: 1rem; border-radius: 1.25rem; background: white; box-shadow: 0 1rem 3rem #0008; }
    .qr svg { display: block; width: 100%; height: auto; }
    small { color: #8e96a5; }
  </style>
</head>
<body>
  <main>
    <h1>Scan to connect</h1>
    <p>Open Tethoq on your phone and scan this one-time code.</p>
    <div class="qr">${qrSvg}</div>
    <small>This page and code expire in up to five minutes.</small>
  </main>
</body>
</html>`;
}

function launchDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
