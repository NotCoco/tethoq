import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentEventType, JsonObject } from "./models.js";

export interface EventReplaySlice {
  readonly events: readonly AgentEvent[];
  readonly requestedSequence: number;
  readonly oldestAvailableSequence: number | null;
  readonly latestSequence: number;
  /** True when the requested cursor cannot be continued without an authoritative resync. */
  readonly replayGap: boolean;
}

export class EventDeduper {
  readonly #seen = new Set<string>();
  readonly #order: string[] = [];

  public constructor(private readonly capacity = 10_000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("EventDeduper capacity must be a positive integer");
  }

  public accept(eventId: string): boolean {
    if (this.#seen.has(eventId)) return false;
    this.#seen.add(eventId);
    this.#order.push(eventId);
    while (this.#order.length > this.capacity) {
      const evicted = this.#order.shift();
      if (evicted !== undefined) this.#seen.delete(evicted);
    }
    return true;
  }

  public clear(): void {
    this.#seen.clear();
    this.#order.length = 0;
  }
}

export class EventReplayBuffer {
  readonly #events: AgentEvent[] = [];
  #sequence = 0;

  public constructor(
    private readonly hostId: string,
    private readonly capacity = 5_000,
  ) {
    if (!hostId) throw new Error("hostId is required");
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
  }

  public append(input: {
    readonly type: AgentEventType;
    readonly providerId?: string;
    readonly sessionId?: string;
    readonly payload?: JsonObject;
    readonly nativeEvent?: JsonObject;
    readonly eventId?: string;
    readonly occurredAt?: string;
  }): AgentEvent {
    const event: AgentEvent = {
      eventId: input.eventId ?? randomUUID(),
      sequence: ++this.#sequence,
      type: input.type,
      hostId: this.hostId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      payload: input.payload ?? {},
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.nativeEvent !== undefined ? { nativeEvent: input.nativeEvent } : {}),
    };
    this.#events.push(event);
    if (this.#events.length > this.capacity) this.#events.splice(0, this.#events.length - this.capacity);
    return event;
  }

  public since(sequence: number): readonly AgentEvent[] {
    let low = 0;
    let high = this.#events.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (this.#events[middle]!.sequence <= sequence) low = middle + 1;
      else high = middle;
    }
    return this.#events.slice(low);
  }

  public replaySince(sequence: number): EventReplaySlice {
    const oldestAvailableSequence = this.oldestSequence();
    const latestSequence = this.latestSequence();
    return {
      events: this.since(sequence),
      requestedSequence: sequence,
      oldestAvailableSequence,
      latestSequence,
      replayGap: sequence > latestSequence || (
        oldestAvailableSequence !== null && sequence < oldestAvailableSequence - 1
      ),
    };
  }

  public latestSequence(): number {
    return this.#sequence;
  }

  public oldestSequence(): number | null {
    return this.#events[0]?.sequence ?? null;
  }
}

export class RequestLedger<T> {
  readonly #entries = new Map<string, { readonly expiresAt: number; readonly value: T }>();

  public constructor(private readonly ttlMs = 10 * 60 * 1_000, private readonly capacity = 2_000) {}

  public get(requestId: string, now = Date.now()): T | undefined {
    this.prune(now);
    return this.#entries.get(requestId)?.value;
  }

  public set(requestId: string, value: T, now = Date.now()): void {
    this.prune(now);
    this.#entries.set(requestId, { value, expiresAt: now + this.ttlMs });
    while (this.#entries.size > this.capacity) {
      const first = this.#entries.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.#entries.delete(first);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(key);
  }
}
