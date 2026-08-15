import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { connect as connectTls, type TLSSocket } from "node:tls";
import { tethoqEnvironmentValue } from "./environment.js";

type TunnelChild = ChildProcessByStdio<null, Readable, Readable>;

const quickTunnelUrlTimeoutMs = 30_000;
const tunnelReadinessTimeoutMs = 35_000;
const readinessRetryDelayMs = 750;
const webSocketAttemptTimeoutMs = 8_000;

export interface PhonePairTunnel {
  readonly publicWebSocketBaseUrl: string;
  dispose(): Promise<void>;
}

export interface TunnelFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type TunnelFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers: Readonly<Record<string, string>>; readonly cache: "no-store" },
) => Promise<TunnelFetchResponse>;

export interface TunnelProbeSocket {
  onOpen(listener: () => void): () => void;
  onMessage(listener: (text: string) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export type TunnelProbeSocketFactory = (url: string, address: string) => TunnelProbeSocket;

export interface PhonePairTunnelReadinessOptions {
  readonly fetch?: TunnelFetch;
  readonly socketFactory?: TunnelProbeSocketFactory;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly socketAttemptTimeoutMs?: number;
}

export async function startPhonePairTunnel(
  originUrl: string,
  command = tethoqEnvironmentValue(process.env, "TETHOQ_CLOUDFLARED_COMMAND") ?? "cloudflared",
  readinessOptions: PhonePairTunnelReadinessOptions = {},
): Promise<PhonePairTunnel> {
  const child = spawn(command, ["tunnel", "--url", originUrl, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    const publicHttpUrl = await waitForQuickTunnelUrl(child);
    await waitForQuickTunnelReadiness(publicHttpUrl, child, readinessOptions);
    return {
      publicWebSocketBaseUrl: publicHttpUrl.replace(/^https:/, "wss:"),
      dispose: () => stopChild(child),
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export function waitForQuickTunnelUrl(child: TunnelChild): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let recentOutput = "";
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for cloudflared to create the secure phone tunnel")), quickTunnelUrlTimeoutMs);
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error !== undefined) reject(error);
      else resolve(url!);
    };
    const onData = (chunk: Buffer) => {
      recentOutput = (recentOutput + chunk.toString("utf8")).slice(-8_000);
      const match = recentOutput.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match !== null) finish(undefined, match[0]);
    };
    const onError = (error: Error) => finish(new Error(`Could not start cloudflared: ${error.message}`));
    const onExit = (code: number | null) => finish(new Error(
      `cloudflared exited before creating a tunnel (code ${code ?? "unknown"})${recentOutput.trim() === "" ? "" : `: ${recentOutput.trim()}`}`,
    ));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function waitForQuickTunnelReadiness(
  publicHttpUrl: string,
  child: TunnelChild,
  options: PhonePairTunnelReadinessOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? tunnelReadinessTimeoutMs;
  const retryDelayMs = options.retryDelayMs ?? readinessRetryDelayMs;
  const socketAttemptTimeout = options.socketAttemptTimeoutMs ?? webSocketAttemptTimeoutMs;
  const fetchDns = options.fetch ?? defaultTunnelFetch;
  const socketFactory = options.socketFactory ?? defaultTunnelProbeSocketFactory;
  const publicUrl = new URL(publicHttpUrl);
  const webSocketUrl = new URL("/bridge", publicUrl);
  webSocketUrl.protocol = "wss:";

  const controller = new AbortController();
  const timeoutError = new Error(
    `Timed out after ${Math.ceil(timeoutMs / 1_000)}s waiting for the public phone tunnel. `
    + "Public DNS must resolve it and /bridge must return protocol.hello before a QR code is shown.",
  );
  let childError: Error | undefined;
  let lastProbeError: Error | undefined;
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const onError = (error: Error) => {
    childError = new Error(`cloudflared failed while verifying the public phone tunnel: ${error.message}`);
    controller.abort(childError);
  };
  const onExit = (code: number | null) => {
    childError = new Error(`cloudflared exited while verifying the public phone tunnel (code ${code ?? "unknown"})`);
    controller.abort(childError);
  };
  child.once("error", onError);
  child.once("exit", onExit);

  try {
    if (child.exitCode !== null || child.killed) {
      throw new Error(`cloudflared stopped before the public phone tunnel was ready (code ${child.exitCode ?? "unknown"})`);
    }
    let consecutiveDnsRounds = 0;
    while (true) {
      throwIfAborted(controller.signal);
      try {
        const address = await requirePublicDns(publicUrl.hostname, fetchDns, controller.signal);
        consecutiveDnsRounds += 1;
        if (consecutiveDnsRounds < 2) {
          await waitForRetry(retryDelayMs, controller.signal);
          continue;
        }
        await probeBridgeHello(webSocketUrl.toString(), address, socketFactory, socketAttemptTimeout, controller.signal);
        return;
      } catch (error) {
        if (controller.signal.aborted) throw abortReason(controller.signal);
        lastProbeError = asError(error);
        if (lastProbeError.message.includes("DNS")) consecutiveDnsRounds = 0;
        await waitForRetry(retryDelayMs, controller.signal);
      }
    }
  } catch (error) {
    if (childError !== undefined) throw childError;
    if (controller.signal.aborted && controller.signal.reason === timeoutError && lastProbeError !== undefined) {
      throw new Error(`${timeoutError.message} Last check: ${lastProbeError.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    child.off("error", onError);
    child.off("exit", onExit);
    if (!controller.signal.aborted) controller.abort();
  }
}

async function requirePublicDns(hostname: string, fetchDns: TunnelFetch, signal: AbortSignal): Promise<string> {
  const encodedHostname = encodeURIComponent(hostname);
  const resolvers = [
    ["Cloudflare", `https://cloudflare-dns.com/dns-query?name=${encodedHostname}&type=A`],
    ["Google", `https://dns.google/resolve?name=${encodedHostname}&type=A`],
  ] as const;
  const results = await Promise.allSettled(resolvers.map(async ([name, url]) => {
    const response = await abortable(fetchDns(url, {
      signal,
      headers: { Accept: "application/dns-json" },
      cache: "no-store",
    }), signal);
    if (!response.ok) throw new Error(`${name} DNS-over-HTTPS returned HTTP ${response.status}`);
    const payload = await abortable(response.json(), signal);
    const addresses = addressAnswers(payload);
    if (addresses.length === 0) throw new Error(`${name} DNS does not resolve ${hostname} yet`);
    return addresses;
  }));
  for (const result of results) {
    if (result.status === "fulfilled" && result.value[0] !== undefined) return result.value[0];
  }
  const failures = results.flatMap((result) => result.status === "rejected" ? [asError(result.reason).message] : []);
  throw new Error(`Public DNS does not resolve ${hostname} yet${failures.length === 0 ? "" : `: ${failures.join("; ")}`}`);
}

function addressAnswers(value: unknown): readonly string[] {
  if (!isRecord(value) || value.Status !== 0 || !Array.isArray(value.Answer)) return [];
  return value.Answer.flatMap((answer) => {
    if (!isRecord(answer) || (answer.type !== 1 && answer.type !== 28) || typeof answer.data !== "string") return [];
    const address = answer.data.trim();
    return isIP(address) === 0 ? [] : [address];
  });
}

function probeBridgeHello(
  url: string,
  address: string,
  socketFactory: TunnelProbeSocketFactory,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: TunnelProbeSocket;
    try {
      socket = socketFactory(url, address);
    } catch (error) {
      reject(asError(error));
      return;
    }
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const unsubscribers: Array<() => void> = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      for (const unsubscribe of unsubscribers) unsubscribe();
      try { socket.close(); } catch { /* The failed handshake may already own a closed socket. */ }
      if (error === undefined) resolve();
      else reject(error);
    };
    const onAbort = () => finish(abortReason(signal));
    timeout = setTimeout(() => finish(new Error("WSS /bridge opened no protocol.hello response")), timeoutMs);
    unsubscribers.push(socket.onOpen(() => undefined));
    unsubscribers.push(socket.onMessage((text) => {
      try {
        const message: unknown = JSON.parse(text);
        if (isRecord(message) && message.type === "protocol.hello") finish();
        else finish(new Error("WSS /bridge returned a message other than protocol.hello"));
      } catch {
        finish(new Error("WSS /bridge returned invalid JSON instead of protocol.hello"));
      }
    }));
    unsubscribers.push(socket.onError((error) => finish(new Error(`WSS /bridge connection failed: ${error.message}`))));
    unsubscribers.push(socket.onClose(() => finish(new Error("WSS /bridge closed before protocol.hello"))));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

const defaultTunnelFetch: TunnelFetch = async (url, init) => await fetch(url, init);

function defaultTunnelProbeSocketFactory(url: string, address: string): TunnelProbeSocket {
  return new DirectTlsWebSocketProbe(url, address);
}

class DirectTlsWebSocketProbe implements TunnelProbeSocket {
  readonly #events = new Map<"open" | "message" | "error" | "close", Set<(value?: string | Error) => void>>();
  readonly #socket: TLSSocket;
  readonly #key = randomBytes(16).toString("base64");
  #buffer = Buffer.alloc(0);
  #upgraded = false;
  #closed = false;

  public constructor(urlText: string, address: string) {
    const url = new URL(urlText);
    this.#socket = connectTls({
      host: address,
      port: Number(url.port || 443),
      servername: url.hostname,
      ALPNProtocols: ["http/1.1"],
      rejectUnauthorized: true,
    });
    this.#socket.setNoDelay(true);
    this.#socket.once("secureConnect", () => {
      const host = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
      this.#socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${this.#key}`,
        "Sec-WebSocket-Version: 13",
        "User-Agent: Tethoq-Tunnel-Readiness/1",
        "",
        "",
      ].join("\r\n"));
    });
    this.#socket.on("data", (chunk: Buffer) => this.receive(chunk));
    this.#socket.on("error", (error) => this.emit("error", error));
    this.#socket.on("close", () => this.emit("close"));
  }

  public onOpen(listener: () => void): () => void { return this.add("open", listener); }
  public onMessage(listener: (text: string) => void): () => void { return this.add("message", listener as (value?: string | Error) => void); }
  public onError(listener: (error: Error) => void): () => void { return this.add("error", listener as (value?: string | Error) => void); }
  public onClose(listener: () => void): () => void { return this.add("close", listener); }
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
  }

  private add(type: "open" | "message" | "error" | "close", listener: (value?: string | Error) => void): () => void {
    let listeners = this.#events.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.#events.set(type, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  private emit(type: "open" | "message" | "error" | "close", value?: string | Error): void {
    for (const listener of this.#events.get(type) ?? []) listener(value);
  }

  private receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    try {
      if (!this.#upgraded && !this.readUpgrade()) return;
      this.readFrames();
    } catch (error) {
      this.emit("error", asError(error));
    }
  }

  private readUpgrade(): boolean {
    const boundary = this.#buffer.indexOf("\r\n\r\n");
    if (boundary < 0) return false;
    const header = this.#buffer.subarray(0, boundary).toString("latin1");
    this.#buffer = this.#buffer.subarray(boundary + 4);
    const lines = header.split("\r\n");
    if (!/^HTTP\/1\.[01] 101\b/u.test(lines[0] ?? "")) {
      throw new Error(`WebSocket upgrade returned ${lines[0] ?? "an invalid HTTP response"}`);
    }
    const expectedAccept = createHash("sha1").update(`${this.#key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const accept = lines.find((line) => /^Sec-WebSocket-Accept:/iu.test(line))?.split(":", 2)[1]?.trim();
    if (accept !== expectedAccept) throw new Error("WebSocket upgrade returned an invalid accept key");
    this.#upgraded = true;
    this.emit("open");
    return true;
  }

  private readFrames(): void {
    while (this.#buffer.length >= 2) {
      const first = this.#buffer[0] ?? 0;
      const second = this.#buffer[1] ?? 0;
      const opcode = first & 0x0f;
      if ((first & 0x80) === 0) throw new Error("Fragmented readiness response is unsupported");
      if ((second & 0x80) !== 0) throw new Error("Server sent a masked WebSocket frame");
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const large = this.#buffer.readBigUInt64BE(2);
        if (large > 64n * 1024n) throw new Error("Readiness response is unexpectedly large");
        length = Number(large);
        offset = 10;
      }
      if (this.#buffer.length < offset + length) return;
      const payload = this.#buffer.subarray(offset, offset + length);
      this.#buffer = this.#buffer.subarray(offset + length);
      if (opcode === 0x1) this.emit("message", payload.toString("utf8"));
      else if (opcode === 0x8) this.emit("close");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Public phone tunnel readiness check was cancelled");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function stopChild(child: TunnelChild): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}
