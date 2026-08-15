export const BROWSER_HIBERNATE_AFTER_MS = 30_000;
export const BROWSER_DOWNLOAD_RETRY_MS = 5_000;

export interface BrowserIdleTimer {
  readonly set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clear: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface BrowserIdleLifecycleOptions {
  readonly onSuspend: () => boolean | Promise<boolean>;
  readonly timer?: BrowserIdleTimer;
  readonly hibernateAfterMs?: number;
  readonly downloadRetryMs?: number;
}

const systemTimer: BrowserIdleTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (timer) => clearTimeout(timer),
};

/**
 * Keeps the browser cheap while it is not visible. A progressing download is
 * never interrupted; suspension is retried and becomes immediate when the
 * final active download completes.
 */
export class BrowserIdleLifecycle {
  readonly #onSuspend: BrowserIdleLifecycleOptions["onSuspend"];
  readonly #timerApi: BrowserIdleTimer;
  readonly #hibernateAfterMs: number;
  readonly #downloadRetryMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inactive = false;
  #downloadsActive = false;
  #overdue = false;
  #suspending = false;
  #disposed = false;

  public constructor(options: BrowserIdleLifecycleOptions) {
    this.#onSuspend = options.onSuspend;
    this.#timerApi = options.timer ?? systemTimer;
    this.#hibernateAfterMs = options.hibernateAfterMs ?? BROWSER_HIBERNATE_AFTER_MS;
    this.#downloadRetryMs = options.downloadRetryMs ?? BROWSER_DOWNLOAD_RETRY_MS;
  }

  public setInactive(inactive: boolean): void {
    if (this.#disposed) return;
    if (this.#inactive === inactive) return;
    this.#inactive = inactive;
    if (!inactive) {
      this.#overdue = false;
      this.#cancel();
      return;
    }
    this.#schedule(this.#overdue ? 0 : this.#hibernateAfterMs);
  }

  public setDownloadsActive(active: boolean): void {
    if (this.#disposed || this.#downloadsActive === active) return;
    this.#downloadsActive = active;
    if (!active && this.#inactive && this.#overdue) this.#schedule(0, true);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancel();
  }

  #schedule(delayMs: number, replace = false): void {
    if (this.#disposed || !this.#inactive || this.#suspending) return;
    if (this.#timer !== undefined) {
      if (!replace) return;
      this.#cancel();
    }
    this.#timer = this.#timerApi.set(() => {
      this.#timer = undefined;
      void this.#attemptSuspend();
    }, delayMs);
    this.#timer.unref?.();
  }

  async #attemptSuspend(): Promise<void> {
    if (this.#disposed || !this.#inactive) return;
    if (this.#downloadsActive) {
      this.#overdue = true;
      this.#schedule(this.#downloadRetryMs);
      return;
    }
    this.#suspending = true;
    try {
      const suspended = await this.#onSuspend();
      this.#overdue = !suspended;
    } catch {
      this.#overdue = true;
    } finally {
      this.#suspending = false;
    }
    if (this.#inactive && this.#overdue) this.#schedule(this.#downloadRetryMs);
  }

  #cancel(): void {
    if (this.#timer === undefined) return;
    this.#timerApi.clear(this.#timer);
    this.#timer = undefined;
  }
}
