import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PairingPayload } from "../../../packages/protocol/src/index.js";
import { pairingQrText } from "./pairing_qr.js";
import { startPairingPage, type PairingPage } from "./pairing_page.js";
import { startPhonePairTunnel, type PhonePairTunnel } from "./phone_pair_tunnel.js";

const LOOPBACK = "127.0.0.1";

interface CompanionPairingBridge {
  startPairing(relayUrl?: string, relayToken?: string): PairingPayload;
  pairedDevices(): readonly unknown[];
}

export interface CompanionControlOptions {
  readonly token: string;
  readonly bridge: CompanionPairingBridge;
  readonly bridgePort: number;
  readonly bridgePath: string;
  readonly relayUrl?: string;
  readonly relayToken?: string;
  readonly startTunnel?: typeof startPhonePairTunnel;
  readonly startPage?: typeof startPairingPage;
  readonly onShutdown?: () => void;
}

export interface CompanionControlAddress {
  readonly host: typeof LOOPBACK;
  readonly port: number;
}

interface CompanionControlRequest {
  readonly remoteAddress?: string | undefined;
  readonly host?: string | undefined;
  readonly authorization?: string | undefined;
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly contentLength?: string | undefined;
  readonly transferEncoding?: string | undefined;
}

export function validateCompanionControlRequest(
  request: CompanionControlRequest,
  expectedHost: string,
  expectedToken: string,
): "ok" | "forbidden" | "request_too_large" {
  if (request.remoteAddress !== LOOPBACK && request.remoteAddress !== "::ffff:127.0.0.1") return "forbidden";
  if (request.host?.toLowerCase() !== expectedHost) return "forbidden";
  if (typeof request.authorization !== "string" || !request.authorization.startsWith("Bearer ")) return "forbidden";
  const supplied = Buffer.from(request.authorization.slice(7), "utf8");
  const token = Buffer.from(expectedToken, "utf8");
  if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) return "forbidden";
  if (request.transferEncoding !== undefined) return "request_too_large";
  if (request.method === "GET") {
    return request.contentLength === undefined || request.contentLength === "0" ? "ok" : "request_too_large";
  }
  return request.contentLength === "0" ? "ok" : "request_too_large";
}

/**
 * Authenticated loopback control plane for the trusted Bridge companion.
 * It never accepts a caller-provided endpoint and never exposes the token in
 * argv, logs, pairing payloads, or renderer IPC.
 */
export class CompanionControlServer {
  readonly #server: Server;
  readonly #startTunnel: typeof startPhonePairTunnel;
  readonly #startPage: typeof startPairingPage;
  #expectedHost = "";
  #page: PairingPage | undefined;
  #tunnel: PhonePairTunnel | undefined;
  #tunnelHasPairedDevice = false;
  #pairingState: "idle" | "ready" | "paired" = "idle";
  #operation: Promise<unknown> = Promise.resolve();
  #disposePromise: Promise<void> | undefined;

  public constructor(private readonly options: CompanionControlOptions) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(options.token)) {
      throw new Error("TETHOQ_COMPANION_CONTROL_TOKEN must be a 32-byte base64url token");
    }
    this.#startTunnel = options.startTunnel ?? startPhonePairTunnel;
    this.#startPage = options.startPage ?? startPairingPage;
    this.#server = createServer((request, response) => { void this.#handle(request, response); });
    this.#server.maxHeadersCount = 24;
    this.#server.requestTimeout = 5_000;
    this.#server.keepAliveTimeout = 1_000;
  }

  public async listen(): Promise<CompanionControlAddress> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(0, LOOPBACK, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
    const address = this.#server.address() as AddressInfo;
    this.#expectedHost = `${LOOPBACK}:${address.port}`;
    return { host: LOOPBACK, port: address.port };
  }

  public pairingConfirmed(): void {
    this.#pairingState = "paired";
    this.#tunnelHasPairedDevice = this.#tunnel !== undefined;
    const page = this.#page;
    this.#page = undefined;
    if (page !== undefined) void page.dispose().catch(() => undefined);
  }

  public async dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return await this.#disposePromise;
    this.#disposePromise = (async () => {
      await this.#operation.catch(() => undefined);
      const page = this.#page;
      const tunnel = this.#tunnel;
      this.#page = undefined;
      this.#tunnel = undefined;
      await Promise.allSettled([page?.dispose(), tunnel?.dispose()]);
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    })();
    return await this.#disposePromise;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const validation = validateCompanionControlRequest({
      remoteAddress: request.socket.remoteAddress,
      host: request.headers.host,
      authorization: request.headers.authorization,
      method: request.method,
      path: request.url,
      contentLength: request.headers["content-length"],
      transferEncoding: request.headers["transfer-encoding"],
    }, this.#expectedHost, this.options.token);
    if (validation === "forbidden") {
      sendJson(response, 403, { error: "forbidden" });
      request.resume();
      return;
    }
    if (validation === "request_too_large") {
      sendJson(response, 413, { error: "request_too_large" });
      request.resume();
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      sendJson(response, 200, this.#status());
      return;
    }
    if (request.method === "POST" && request.url === "/pair/start") {
      await this.#serialized(async () => {
        try {
          const result = await this.#startPairing();
          sendJson(response, 200, result);
        } catch (error) {
          sendJson(response, 503, { error: "pairing_failed", message: error instanceof Error ? error.message : String(error) });
        }
      });
      return;
    }
    if (request.method === "POST" && request.url === "/pair/cancel") {
      await this.#serialized(async () => {
        await this.#cancelPairing();
        sendJson(response, 200, this.#status());
      });
      return;
    }
    if (request.method === "POST" && request.url === "/shutdown") {
      sendJson(response, 202, { state: "stopping" });
      setImmediate(() => this.options.onShutdown?.());
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  #status(): Record<string, unknown> {
    return {
      state: "running",
      pairingState: this.#pairingState,
      pairedDeviceCount: this.options.bridge.pairedDevices().length,
      stableRelayConfigured: this.options.relayUrl !== undefined && this.options.relayToken !== undefined,
    };
  }

  async #startPairing(): Promise<{ readonly state: "ready"; readonly pageUrl: string; readonly expiresAt: string; readonly transport: "relay" | "temporary-tunnel" }> {
    await this.#page?.dispose();
    this.#page = undefined;

    const stableRelay = this.options.relayUrl !== undefined && this.options.relayToken !== undefined;
    let payload: PairingPayload;
    let directUrl: string | undefined;
    if (stableRelay) {
      payload = this.options.bridge.startPairing(this.options.relayUrl, this.options.relayToken);
    } else {
      this.#tunnel ??= await this.#startTunnel(`http://${LOOPBACK}:${this.options.bridgePort}`);
      const bridgePath = this.options.bridgePath.startsWith("/") ? this.options.bridgePath : `/${this.options.bridgePath}`;
      directUrl = `${this.#tunnel.publicWebSocketBaseUrl.replace(/\/$/u, "")}${bridgePath}`;
      payload = this.options.bridge.startPairing();
    }
    try {
      this.#page = await this.#startPage(pairingQrText(payload, directUrl), payload.expiresAt);
      this.#pairingState = "ready";
      return {
        state: "ready",
        pageUrl: this.#page.url,
        expiresAt: this.#page.expiresAt,
        transport: stableRelay ? "relay" : "temporary-tunnel",
      };
    } catch (error) {
      if (!this.#tunnelHasPairedDevice) {
        await this.#tunnel?.dispose().catch(() => undefined);
        this.#tunnel = undefined;
      }
      throw error;
    }
  }

  async #cancelPairing(): Promise<void> {
    await this.#page?.dispose();
    this.#page = undefined;
    if (!this.#tunnelHasPairedDevice) {
      await this.#tunnel?.dispose();
      this.#tunnel = undefined;
    }
    this.#pairingState = "idle";
  }

  async #serialized(action: () => Promise<void>): Promise<void> {
    const next = this.#operation.then(action, action);
    this.#operation = next.catch(() => undefined);
    await next;
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body).toString(),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
