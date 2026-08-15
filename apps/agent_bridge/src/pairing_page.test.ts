import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import test from "node:test";
import { openDefaultBrowser, startPairingPage } from "./pairing_page.js";

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function requestPage(
  url: string,
  method = "GET",
  headers: OutgoingHttpHeaders = {},
): Promise<HttpResult> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("localhost pairing page serves only its opaque route with locked-down responses", async (context) => {
  const qrText = '{"secret":"SENSITIVE_PAIRING_VALUE"}';
  const page = await startPairingPage(qrText, new Date(Date.now() + 60_000).toISOString());
  context.after(() => page.dispose());

  const parsed = new URL(page.url);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.match(parsed.pathname, /^\/pair\/[A-Za-z0-9_-]{32}$/);

  const response = await requestPage(page.url);
  assert.equal(response.status, 200);
  assert.match(response.body, /<svg\b/);
  const moduleCount = Number(response.body.match(/viewBox="0 0 (\d+) \1"/)?.[1]);
  assert.equal(moduleCount, 37, "QR should retain the standard four-module quiet zone");
  assert.match(response.body, /Connect Tethoq/);
  assert.equal(response.body.includes(qrText), false);
  assert.equal(response.body.includes("SENSITIVE_PAIRING_VALUE"), false);
  assert.equal(response.headers["cache-control"], "no-store, max-age=0");
  assert.match(String(response.headers["content-security-policy"]), /default-src 'none'/);
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");

  const head = await requestPage(page.url, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(response.body));

  const missing = await requestPage(`${parsed.origin}/pair/not-the-token`);
  assert.equal(missing.status, 404);
  const method = await requestPage(page.url, "POST");
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "GET, HEAD");
  const wrongHost = await requestPage(page.url, "GET", { Host: "attacker.example" });
  assert.equal(wrongHost.status, 421);
  const crossSite = await requestPage(page.url, "GET", { "Sec-Fetch-Site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const crossOrigin = await requestPage(page.url, "GET", { Origin: "https://attacker.example" });
  assert.equal(crossOrigin.status, 403);
});

test("pairing page is capped at five minutes and stops serving the QR at expiry", async (context) => {
  let now = Date.now();
  const page = await startPairingPage(
    "pairing-data",
    new Date(now + 60 * 60 * 1_000).toISOString(),
    { now: () => now },
  );
  context.after(() => page.dispose());

  assert.equal(page.expiresAt, new Date(now + 5 * 60 * 1_000).toISOString());
  assert.equal((await requestPage(page.url)).status, 200);
  now += 5 * 60 * 1_000;
  const expired = await requestPage(page.url);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.includes("pairing-data"), false);
});

test("pairing page honors a payload expiry sooner than five minutes", async (context) => {
  let now = Date.now();
  const payloadExpiresAt = new Date(now + 30_000).toISOString();
  const page = await startPairingPage("short-lived-pairing-data", payloadExpiresAt, { now: () => now });
  context.after(() => page.dispose());

  assert.equal(page.expiresAt, payloadExpiresAt);
  now += 30_000;
  assert.equal((await requestPage(page.url)).status, 410);
});

test("disposing the pairing page closes its dedicated listener", async () => {
  const page = await startPairingPage("pairing-data", new Date(Date.now() + 60_000).toISOString());
  await page.dispose();
  await page.dispose();
  await assert.rejects(requestPage(page.url));
});

test("default-browser opener passes the URL as one argument and reports launcher failures", async () => {
  const launches: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  const url = "http://127.0.0.1:43210/pair/token?value=a&other=b";
  const launch = async (command: string, args: readonly string[]) => {
    launches.push({ command, args });
  };

  await openDefaultBrowser(url, { platform: "win32", launch });
  await openDefaultBrowser(url, { platform: "darwin", launch });
  await openDefaultBrowser(url, { platform: "linux", launch });
  assert.deepEqual(launches, [
    { command: "explorer.exe", args: [url] },
    { command: "open", args: [url] },
    { command: "xdg-open", args: [url] },
  ]);

  await assert.rejects(
    openDefaultBrowser(url, { launch: async () => { throw new Error("no browser"); } }),
    /no browser/,
  );
  await assert.rejects(openDefaultBrowser("javascript:alert(1)"), /http or https/);
});
