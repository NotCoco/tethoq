import type { OpenCodeProcessStatus } from "../shared/desktop_api.js";

const DEFAULT_INTERVAL_MS = 15_000;

export interface OpenCodeWatchdogOptions {
  readonly ensureRunning: () => Promise<OpenCodeProcessStatus>;
  readonly reconnect: () => Promise<void>;
  /** True when the provider's live subscription is already up. */
  readonly connected: () => boolean;
  readonly stopping?: () => boolean;
  readonly intervalMs?: number;
}

export class OpenCodeWatchdog {
  readonly #ensureRunning: () => Promise<OpenCodeProcessStatus>;
  readonly #reconnect: () => Promise<void>;
  readonly #connected: () => boolean;
  readonly #stopping: (() => boolean) | undefined;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #tickInFlight = false;
  #disposed = false;

  public constructor(options: OpenCodeWatchdogOptions) {
    this.#ensureRunning = options.ensureRunning;
    this.#reconnect = options.reconnect;
    this.#connected = options.connected;
    this.#stopping = options.stopping;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  public start(): void {
    if (this.#disposed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.tick();
      this.start();
    }, this.#intervalMs);
    this.#timer.unref();
  }

  public async tick(): Promise<void> {
    if (this.#disposed || this.#tickInFlight) return;
    if (this.#stopping?.() === true) return;
    this.#tickInFlight = true;
    try {
      const status = await this.#ensureRunning();
      const running = status.state === "managed" || status.state === "external";
      // Ask what is actually true rather than comparing status strings: a server
      // that died and was restarted reports "managed" both before and after, so a
      // transition test would restart the process and silently leave the provider
      // unsubscribed - running again, but with no live events and, until the next
      // refresh, no way to send.
      if (running && !this.#connected()) await this.#reconnect().catch(() => undefined);
    } finally {
      this.#tickInFlight = false;
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
