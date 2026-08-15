export interface BackoffOptions {
  readonly initialMs?: number;
  readonly maximumMs?: number;
  readonly multiplier?: number;
  readonly jitterRatio?: number;
}

export class ExponentialBackoff {
  readonly #initialMs: number;
  readonly #maximumMs: number;
  readonly #multiplier: number;
  readonly #jitterRatio: number;
  #attempt = 0;

  public constructor(options: BackoffOptions = {}) {
    this.#initialMs = options.initialMs ?? 500;
    this.#maximumMs = options.maximumMs ?? 30_000;
    this.#multiplier = options.multiplier ?? 2;
    this.#jitterRatio = options.jitterRatio ?? 0.2;
  }

  public next(random = Math.random): number {
    const base = Math.min(this.#maximumMs, this.#initialMs * this.#multiplier ** this.#attempt++);
    const jitter = base * this.#jitterRatio * (random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  public reset(): void {
    this.#attempt = 0;
  }

  public get attempt(): number {
    return this.#attempt;
  }
}
