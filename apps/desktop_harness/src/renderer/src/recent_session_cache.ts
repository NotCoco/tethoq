export interface SessionCacheSnapshot<T> {
  readonly data?: T;
  readonly loading: boolean;
  readonly error?: unknown;
}

interface PendingRead<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  started: boolean;
}

interface Entry<T> {
  id: string;
  snapshot: SessionCacheSnapshot<T>;
  usedAt: number;
  checkedAt: number;
  bytes: number;
  revision: number;
  pending?: PendingRead<T>;
}

const emptySnapshot = Object.freeze({ loading: false });

/** Small metadata only. Reads share work; inactive tasks expire in LRU order. */
export class RecentSessionCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly retained = new Map<string, number>();
  private running = 0;

  constructor(
    private readonly fetch: (sessionId: string) => Promise<T>,
    private readonly options: {
      maxEntries: number;
      maxBytes: number;
      freshMs: number;
      idleMs: number;
      concurrency: number;
      now?: () => number;
    },
  ) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  getSnapshot = (id: string): SessionCacheSnapshot<T> => this.entries.get(id)?.snapshot ?? emptySnapshot;

  subscribe = (id: string, listener: () => void): (() => void) => {
    let listeners = this.listeners.get(id);
    if (!listeners) this.listeners.set(id, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  };

  private publish(entry: Entry<T>, snapshot: SessionCacheSnapshot<T>): void {
    entry.snapshot = snapshot;
    this.listeners.get(entry.id)?.forEach((listener) => listener());
  }

  retain(id: string): () => void {
    this.retained.set(id, (this.retained.get(id) ?? 0) + 1);
    this.touch(id);
    return () => {
      const count = (this.retained.get(id) ?? 1) - 1;
      if (count) this.retained.set(id, count);
      else this.retained.delete(id);
      this.touch(id);
      this.sweep();
    };
  }

  private touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.usedAt = this.now();
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  load = (id: string, force = false): Promise<T> => {
    this.sweep();
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { id, snapshot: emptySnapshot, usedAt: this.now(), checkedAt: -Infinity, bytes: 0, revision: 0 };
      this.entries.set(id, entry);
    }
    this.touch(id);
    if (entry.pending) return entry.pending.promise;
    if (!force && entry.snapshot.data !== undefined && this.now() - entry.checkedAt < this.options.freshMs) {
      return Promise.resolve(entry.snapshot.data);
    }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
    entry.pending = { promise, resolve, reject, started: false };
    this.publish(entry, { ...entry.snapshot, loading: true, error: undefined });
    this.sweep();
    this.drain();
    return promise;
  };

  invalidate(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.revision += 1;
    entry.checkedAt = -Infinity;
  }

  invalidateAll(): void {
    for (const id of this.entries.keys()) this.invalidate(id);
  }

  /** Visit retained metadata without making every sidebar row recently used. */
  forEach(visit: (data: T, id: string) => void): void {
    for (const entry of this.entries.values()) {
      if (entry.snapshot.data !== undefined) visit(entry.snapshot.data, entry.id);
    }
  }

  private remove(entry: Entry<T>): void {
    this.entries.delete(entry.id);
    if (entry.pending && !entry.pending.started) entry.pending.reject(new Error("Task metadata read was evicted"));
    this.listeners.get(entry.id)?.forEach((listener) => listener());
  }

  sweep = (): void => {
    const now = this.now();
    let bytes = 0;
    for (const entry of this.entries.values()) {
      if (!this.retained.has(entry.id) && now - entry.usedAt >= this.options.idleMs) this.remove(entry);
      else bytes += entry.bytes;
    }
    for (const entry of this.entries.values()) {
      if (this.entries.size <= this.options.maxEntries && bytes <= this.options.maxBytes) break;
      // A currently displayed list stays readable even if it alone exceeds the
      // budget. Releasing that view immediately makes it eligible for eviction.
      if (this.retained.has(entry.id)) continue;
      bytes -= entry.bytes;
      this.remove(entry);
    }
  };

  clear(): void {
    for (const entry of this.entries.values()) this.remove(entry);
  }

  private drain(): void {
    // Most recently requested tasks go first. Evicted queued reads never start.
    for (const entry of [...this.entries.values()].reverse()) {
      if (this.running >= this.options.concurrency) return;
      const pending = entry.pending;
      if (!pending || pending.started) continue;
      pending.started = true;
      this.running += 1;
      void this.run(entry, pending);
    }
  }

  private async run(entry: Entry<T>, pending: PendingRead<T>): Promise<void> {
    const revision = entry.revision;
    try {
      const data = await this.fetch(entry.id);
      if (this.entries.get(entry.id) === entry && revision !== entry.revision) {
        // A live event or reconnect overtook this read. All consumers wait for
        // the replacement; the older response cannot repopulate the cache.
        delete entry.pending;
        this.load(entry.id, true).then(pending.resolve, pending.reject);
        return;
      }
      if (this.entries.get(entry.id) === entry) {
        entry.checkedAt = this.now();
        entry.bytes = JSON.stringify(data).length * 2;
        this.publish(entry, { data, loading: false });
      }
      pending.resolve(data);
    } catch (error) {
      if (this.entries.get(entry.id) === entry) this.publish(entry, { ...entry.snapshot, loading: false, error });
      pending.reject(error);
    } finally {
      if (entry.pending === pending) delete entry.pending;
      this.running -= 1;
      this.sweep();
      this.drain();
    }
  }
}
