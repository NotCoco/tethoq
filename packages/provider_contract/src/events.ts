import { randomUUID } from "node:crypto";
import type { ProviderEvent, ProviderEventSink, Subscription } from "./types.js";

interface Listener {
  readonly id: string;
  readonly providerSessionId: string | null;
  readonly sink: ProviderEventSink;
}

export class ProviderEventHub {
  readonly #listeners = new Map<string, Listener>();

  public subscribe(providerSessionId: string | null, sink: ProviderEventSink): Subscription {
    const id = randomUUID();
    this.#listeners.set(id, { id, providerSessionId, sink });
    return {
      id,
      unsubscribe: async () => {
        this.#listeners.delete(id);
      },
    };
  }

  public async emit(event: ProviderEvent): Promise<void> {
    const matching = [...this.#listeners.values()].filter((listener) => listener.providerSessionId === null || listener.providerSessionId === event.providerSessionId);
    const results = await Promise.allSettled(matching.map((listener) => listener.sink(event)));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected !== undefined) throw rejected.reason;
  }

  public clear(): void {
    this.#listeners.clear();
  }
}
