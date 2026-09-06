import type { AddressInfo } from "node:net";
import QRCode from "qrcode";
import type { AgentBridge } from "../../../agent_bridge/src/bridge.js";
import { pairingQrText } from "../../../agent_bridge/src/pairing_qr.js";
import { startPhonePairTunnel, type PhonePairTunnel, type PhonePairTunnelReadinessOptions } from "../../../agent_bridge/src/phone_pair_tunnel.js";
import { BridgeSocketServer } from "../../../agent_bridge/src/transport.js";
import type { MobileConnectionDevice, MobileConnectionState } from "../shared/desktop_api.js";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PATH = "/bridge";
const MAX_QR_SVG_BYTES = 256 * 1024;

interface MobileConnectionRuntime {
  start(): Promise<void>;
  readonly bridge: AgentBridge;
  onPairingConfirmed(listener: () => void): () => void;
}

interface MobileSocketServer {
  listen(): Promise<void>;
  address(): string | AddressInfo | null;
  close(): Promise<void>;
  connectedDeviceIds(): readonly string[];
  onConnectedDevicesChanged(listener: () => void): () => void;
}

type SocketServerFactory = (bridge: AgentBridge) => MobileSocketServer;
type TunnelStarter = (originUrl: string, command?: string, options?: Pick<PhonePairTunnelReadinessOptions, "signal">) => Promise<PhonePairTunnel>;
type QrRenderer = (text: string) => Promise<string>;

export interface MobileConnectionManagerOptions {
  readonly runtime: MobileConnectionRuntime;
  readonly cloudflaredCommand?: string;
  readonly onState?: (state: MobileConnectionState) => void;
  readonly createSocketServer?: SocketServerFactory;
  readonly startTunnel?: TunnelStarter;
  readonly renderQr?: QrRenderer;
  readonly now?: () => number;
}

/**
 * Owns phone pairing inside the desktop main process. The renderer receives an
 * opaque QR image and safe device summaries, never a pairing secret, relay
 * token, public key, or caller-controlled endpoint.
 */
export class MobileConnectionManager {
  readonly #runtime: MobileConnectionRuntime;
  readonly #cloudflaredCommand: string | undefined;
  readonly #onState: ((state: MobileConnectionState) => void) | undefined;
  readonly #createSocketServer: SocketServerFactory;
  readonly #startTunnel: TunnelStarter;
  readonly #renderQr: QrRenderer;
  readonly #now: () => number;
  readonly #stopPairingListener: () => void;
  #stopRevocationListener: (() => void) | undefined;
  #stopConnectedDevicesListener: (() => void) | undefined;
  #server: MobileSocketServer | undefined;
  #tunnel: PhonePairTunnel | undefined;
  #publicBridgeUrl: string | undefined;
  #phase: MobileConnectionState["state"] = "idle";
  #devices: readonly MobileConnectionDevice[] = [];
  #qrDataUrl: string | undefined;
  #expiresAt: string | undefined;
  #message: string | undefined;
  #expiryTimer: NodeJS.Timeout | undefined;
  #startPromise: Promise<MobileConnectionState> | undefined;
  #startController: AbortController | undefined;
  #generation = 0;
  #disposed = false;

  public constructor(options: MobileConnectionManagerOptions) {
    this.#runtime = options.runtime;
    this.#cloudflaredCommand = options.cloudflaredCommand;
    this.#onState = options.onState;
    this.#createSocketServer = options.createSocketServer
      ?? ((bridge) => new BridgeSocketServer(bridge, { host: BRIDGE_HOST, port: 0, path: BRIDGE_PATH }));
    this.#startTunnel = options.startTunnel ?? startPhonePairTunnel;
    this.#renderQr = options.renderQr ?? renderPairingQr;
    this.#now = options.now ?? Date.now;
    this.#stopPairingListener = this.#runtime.onPairingConfirmed(() => this.#pairingConfirmed());
  }

  public state(): MobileConnectionState {
    return {
      state: this.#phase,
      devices: this.#devices,
      ...(this.#qrDataUrl !== undefined ? { qrDataUrl: this.#qrDataUrl } : {}),
      ...(this.#expiresAt !== undefined ? { expiresAt: this.#expiresAt } : {}),
      ...(this.#message !== undefined ? { message: this.#message } : {}),
    };
  }

  public async refreshState(): Promise<MobileConnectionState> {
    this.#assertOpen();
    await this.#runtime.start();
    this.#ensureRevocationListener();
    this.#syncDevices();
    this.#expireReadyCodeIfNeeded();
    return this.state();
  }

  public async startPairing(): Promise<MobileConnectionState> {
    this.#assertOpen();
    this.#expireReadyCodeIfNeeded();
    if (this.#phase === "ready") return this.state();
    if (this.#startPromise !== undefined) return await this.#startPromise;

    const generation = ++this.#generation;
    this.#phase = "starting";
    this.#qrDataUrl = undefined;
    this.#expiresAt = undefined;
    this.#message = undefined;
    this.#emit();
    const controller = new AbortController();
    this.#startController = controller;
    this.#startPromise = this.#startPairing(generation, controller.signal);
    try {
      return await this.#startPromise;
    } finally {
      if (this.#startController === controller) this.#startController = undefined;
      if (generation === this.#generation) this.#startPromise = undefined;
    }
  }

  public async revoke(connectionId: string): Promise<MobileConnectionState> {
    this.#assertOpen();
    await this.#runtime.start();
    this.#ensureRevocationListener();
    this.#syncDevices();
    if (!this.#devices.some((device) => device.id === connectionId)) return this.state();
    this.#runtime.bridge.revokeDevice(connectionId);
    this.#syncDevices();
    if (this.#devices.length === 0 && this.#phase === "paired") this.#phase = "idle";
    if (this.#devices.length === 0 && this.#phase !== "ready" && this.#phase !== "starting") {
      await this.#releaseTransport();
    }
    this.#emit();
    return this.state();
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    ++this.#generation;
    this.#startController?.abort(new Error("Phone pairing was cancelled"));
    this.#startController = undefined;
    this.#stopPairingListener();
    this.#stopRevocationListener?.();
    this.#stopRevocationListener = undefined;
    this.#stopConnectedDevicesListener?.();
    this.#stopConnectedDevicesListener = undefined;
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    this.#phase = "idle";
    this.#devices = [];
    this.#qrDataUrl = undefined;
    this.#expiresAt = undefined;
    this.#message = undefined;
    await this.#startPromise?.catch(() => undefined);
    await this.#releaseTransport();
  }

  async #startPairing(generation: number, signal: AbortSignal): Promise<MobileConnectionState> {
    try {
      await this.#runtime.start();
      this.#ensureRevocationListener();
      this.#assertGeneration(generation);
      this.#syncDevices();
      await this.#ensureTransport(signal);
      this.#assertGeneration(generation);
      const payload = this.#runtime.bridge.startPairing();
      const expiresAtMs = Date.parse(payload.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.#now()) {
        throw new Error("The phone pairing code expired before it could be displayed");
      }
      const qrDataUrl = await this.#renderQr(pairingQrText(payload, this.#publicBridgeUrl));
      this.#assertGeneration(generation);
      this.#phase = "ready";
      this.#qrDataUrl = qrDataUrl;
      this.#expiresAt = new Date(expiresAtMs).toISOString();
      this.#message = undefined;
      this.#scheduleExpiry(expiresAtMs);
      this.#emit();
      return this.state();
    } catch (error) {
      if (!this.#disposed && generation === this.#generation) {
        console.error("Tethoq could not prepare its phone connection", error);
        this.#phase = "error";
        this.#qrDataUrl = undefined;
        this.#expiresAt = undefined;
        this.#message = "Tethoq couldn't prepare a secure phone connection. Check that this computer is online, then try again.";
        await this.#releaseTransportIfUnused();
        this.#emit();
      }
      return this.state();
    }
  }

  async #ensureTransport(signal: AbortSignal): Promise<void> {
    if (this.#server === undefined) {
      const server = this.#createSocketServer(this.#runtime.bridge);
      await server.listen();
      this.#server = server;
      this.#stopConnectedDevicesListener = server.onConnectedDevicesChanged(() => this.#connectedDevicesChanged());
      this.#syncDevices();
    }
    if (this.#tunnel !== undefined && this.#publicBridgeUrl !== undefined) return;
    const address = this.#server.address();
    if (address === null || typeof address === "string" || !Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) {
      throw new Error("The local phone bridge did not bind to a safe port");
    }
    const tunnel = await this.#startTunnel(`http://${BRIDGE_HOST}:${address.port}`, this.#cloudflaredCommand, { signal });
    this.#tunnel = tunnel;
    this.#publicBridgeUrl = `${tunnel.publicWebSocketBaseUrl.replace(/\/$/u, "")}${BRIDGE_PATH}`;
  }

  #pairingConfirmed(): void {
    if (this.#disposed) return;
    this.#syncDevices();
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    this.#phase = "paired";
    this.#qrDataUrl = undefined;
    this.#expiresAt = undefined;
    this.#message = undefined;
    this.#emit();
  }

  #deviceRevoked(): void {
    if (this.#disposed) return;
    this.#syncDevices();
    if (this.#devices.length === 0 && this.#phase === "paired") this.#phase = "idle";
    if (this.#devices.length === 0 && this.#phase !== "ready" && this.#phase !== "starting") {
      void this.#releaseTransport().finally(() => this.#emit());
      return;
    }
    this.#emit();
  }

  #ensureRevocationListener(): void {
    this.#stopRevocationListener ??=
      this.#runtime.bridge.onDeviceRevoked(() => this.#deviceRevoked());
  }

  #connectedDevicesChanged(): void {
    if (this.#disposed) return;
    this.#syncDevices();
    this.#emit();
  }

  #syncDevices(): void {
    const connectedDeviceIds = new Set(this.#server?.connectedDeviceIds() ?? []);
    this.#devices = this.#runtime.bridge.pairedDevices().map((device) => ({
      id: device.credentialId,
      pairedAt: device.issuedAt,
      connected: connectedDeviceIds.has(device.deviceId),
    }));
  }

  #scheduleExpiry(expiresAtMs: number): void {
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = setTimeout(() => {
      this.#expiryTimer = undefined;
      this.#expireReadyCodeIfNeeded();
    }, Math.max(0, expiresAtMs - this.#now()));
    this.#expiryTimer.unref?.();
  }

  #expireReadyCodeIfNeeded(): void {
    if (this.#phase !== "ready" || this.#expiresAt === undefined || Date.parse(this.#expiresAt) > this.#now()) return;
    this.#phase = "idle";
    this.#qrDataUrl = undefined;
    this.#expiresAt = undefined;
    this.#message = undefined;
    void this.#releaseTransportIfUnused().finally(() => this.#emit());
  }

  async #releaseTransportIfUnused(): Promise<void> {
    if (this.#devices.length !== 0) return;
    await this.#releaseTransport();
  }

  async #releaseTransport(): Promise<void> {
    const tunnel = this.#tunnel;
    const server = this.#server;
    this.#stopConnectedDevicesListener?.();
    this.#stopConnectedDevicesListener = undefined;
    this.#tunnel = undefined;
    this.#server = undefined;
    this.#publicBridgeUrl = undefined;
    await Promise.allSettled([tunnel?.dispose(), server?.close()]);
  }

  #emit(): void {
    this.#onState?.(this.state());
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("The phone connection manager is closed");
  }

  #assertGeneration(generation: number): void {
    this.#assertOpen();
    if (generation !== this.#generation) throw new Error("Phone pairing was cancelled");
  }
}

async function renderPairingQr(text: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 3,
    color: { dark: "#10110f", light: "#ffffff" },
  });
  if (!svg.startsWith("<svg") || Buffer.byteLength(svg, "utf8") > MAX_QR_SVG_BYTES) {
    throw new Error("The phone pairing QR code was invalid");
  }
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
