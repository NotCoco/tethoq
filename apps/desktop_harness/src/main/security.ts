import type { BrowserWindow, Session } from "electron";

export const SECURE_WEB_PREFERENCES = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: true,
} as const);

export function hardenSession(session: Session): void {
  session.setPermissionCheckHandler((_webContents, permission, _origin, details) =>
    permission === "media" && details.isMainFrame && details.mediaType === "audio" && isTrustedRendererUrl(details.requestingUrl),
  );
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const audioOnly = permission === "media" &&
      details.isMainFrame &&
      "mediaTypes" in details &&
      details.mediaTypes?.length === 1 &&
      details.mediaTypes[0] === "audio" &&
      isTrustedRendererUrl(details.requestingUrl);
    callback(audioOnly);
  });
  session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers["Content-Security-Policy"] = [
      process.env.ELECTRON_RENDERER_URL === undefined
        ? "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:* http://[::1]:*; connect-src 'none'; font-src 'self'; media-src 'self' blob:; worker-src 'none'"
        : "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:* http://[::1]:*; connect-src 'self' ws:; font-src 'self'; media-src 'self' blob:; worker-src 'none'",
    ];
    headers["X-Content-Type-Options"] = ["nosniff"];
    headers["Referrer-Policy"] = ["no-referrer"];
    callback({ responseHeaders: headers });
  });
}

function isTrustedRendererUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  if (value.startsWith("file://")) return true;
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl === undefined) return false;
  try {
    return new URL(value).origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

export function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
