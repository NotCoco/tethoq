import { randomUUID } from "node:crypto";
import type { RefreshProviderResult, RefreshResult, RemoteSession } from "../../../packages/protocol/src/index.js";
import { collectAllSessionPages, providerErrorFromUnknown, type AgentProviderAdapter } from "../../../packages/provider_contract/src/index.js";
import { SessionCache } from "./session_cache.js";
import { recordStartupProfile } from "./startup_profile.js";

// A Codex thread row can carry substantial provider-owned history. Keep each
// transport response small and page the rest in the existing background tail;
// this changes batching only, not catalogue coverage.
const listingOptions = { limit: 20, sortKey: "updated_at", sortDirection: "desc" } as const;
const maximumCataloguePages = 10_000;
// Provider catalogues can each transiently own a native response, normalized
// rows, and a transport buffer. Starting every installed harness at once
// multiplies that peak without improving coverage, so keep discovery complete
// while bounding how many first pages materialize together.
const maximumConcurrentProviderListings = 2;

export interface SessionBootstrapResult {
  readonly bootstrapId: string;
  readonly startedAt: string;
  readonly initialPagesCompletedAt: string;
  readonly sessions: readonly RemoteSession[];
  readonly providers: readonly RefreshProviderResult[];
  readonly backgroundInProgress: boolean;
  readonly lastSuccessfulRefreshAt?: string;
}

interface ListingToken {
  readonly providerEventRevision: number;
  readonly listingGeneration: number;
}

interface CatalogueReadResult {
  readonly result: RefreshProviderResult;
  /** True only when the provider positively enumerated its complete catalogue. */
  readonly complete: boolean;
}

export class RefreshCoordinator {
  #inFlight: Promise<RefreshResult> | null = null;
  #bootstrapInFlight: Promise<SessionBootstrapResult> | null = null;
  #lastSuccessfulRefreshAt: string | undefined;
  readonly #providerRevisions = new Map<string, number>();
  readonly #listingGenerations = new Map<string, number>();
  readonly #backgroundTasks = new Set<Promise<void>>();
  readonly #backgroundProviderCounts = new Map<string, number>();
  readonly #providerNotifications = new Map<string, Promise<void>>();
  #disposed = false;

  public constructor(
    private readonly adapters: ReadonlyMap<string, AgentProviderAdapter>,
    private readonly cache: SessionCache,
    private readonly onBackgroundProviderSettled?: (result: RefreshProviderResult) => void | Promise<void>,
    private readonly onBackgroundProviderTailFinished?: (providerId: string) => void | Promise<void>,
  ) {}

  public refresh(): Promise<RefreshResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.performRefresh().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /**
   * Loads only each provider's newest page on the startup critical path. Any
   * remaining pages continue in the background and are reconciled as one
   * authoritative provider catalogue when they finish.
   */
  public bootstrap(): Promise<SessionBootstrapResult> {
    if (this.#bootstrapInFlight !== null) return this.#bootstrapInFlight;
    this.#bootstrapInFlight = this.performBootstrap().finally(() => {
      this.#bootstrapInFlight = null;
    });
    return this.#bootstrapInFlight;
  }

  public get inProgress(): boolean {
    return this.#inFlight !== null;
  }

  public get lastSuccessfulRefreshAt(): string | undefined {
    return this.#lastSuccessfulRefreshAt;
  }

  /** Test/lifecycle hook: waits only for already-scheduled catalogue tails. */
  public async waitForBackground(): Promise<void> {
    await Promise.allSettled([...this.#backgroundTasks]);
  }

  /** True while an older-page bootstrap request still owns this adapter. */
  public hasBackgroundCatalogueTail(providerId: string): boolean {
    return (this.#backgroundProviderCounts.get(providerId) ?? 0) > 0;
  }

  public dispose(): void {
    this.#disposed = true;
    for (const providerId of this.adapters.keys()) {
      this.#listingGenerations.set(providerId, (this.#listingGenerations.get(providerId) ?? 0) + 1);
    }
  }

  /** Marks provider-native state as newer than any listing already in flight. */
  public noteProviderEvent(providerId: string): void {
    this.#providerRevisions.set(providerId, (this.#providerRevisions.get(providerId) ?? 0) + 1);
  }

  /** Re-lists a single provider without involving the others. */
  public async refreshProvider(providerId: string): Promise<RefreshProviderResult | undefined> {
    const adapter = this.adapters.get(providerId);
    if (adapter === undefined) return undefined;
    const listing = await this.refreshAdapter(adapter);
    if (listing.complete && listing.result.status === "success") this.#lastSuccessfulRefreshAt = new Date().toISOString();
    return listing.result;
  }

  private beginListing(providerId: string): ListingToken {
    const listingGeneration = (this.#listingGenerations.get(providerId) ?? 0) + 1;
    this.#listingGenerations.set(providerId, listingGeneration);
    return {
      providerEventRevision: this.#providerRevisions.get(providerId) ?? 0,
      listingGeneration,
    };
  }

  private listingIsCurrent(providerId: string, token: ListingToken): boolean {
    return !this.#disposed
      && (this.#providerRevisions.get(providerId) ?? 0) === token.providerEventRevision
      && (this.#listingGenerations.get(providerId) ?? 0) === token.listingGeneration;
  }

  private async refreshAdapter(adapter: AgentProviderAdapter): Promise<CatalogueReadResult> {
    const token = this.beginListing(adapter.providerId);
    try {
      const capabilities = await adapter.getCapabilities();
      if (!capabilities.listSessions) {
        return {
          result: { providerId: adapter.providerId, status: "skipped", fetched: 0, pages: 0, newlyDiscovered: 0 },
          complete: false,
        };
      }
      const collected = await collectAllSessionPages(adapter, listingOptions);
      const newlyDiscovered = this.listingIsCurrent(adapter.providerId, token)
        ? collected.authoritative
          ? this.cache.reconcileProvider(adapter.providerId, collected.sessions)
          : this.cache.mergeProviderPage(adapter.providerId, collected.sessions)
        : 0;
      return {
        result: {
          providerId: adapter.providerId,
          status: "success",
          fetched: collected.sessions.length,
          pages: collected.pages,
          newlyDiscovered,
        },
        complete: collected.authoritative,
      };
    } catch (error) {
      if (this.listingIsCurrent(adapter.providerId, token)) this.cache.markProviderStale(adapter.providerId);
      return {
        result: {
          providerId: adapter.providerId,
          status: "failed",
          fetched: 0,
          pages: 0,
          newlyDiscovered: 0,
          error: providerErrorFromUnknown(adapter.providerId, error),
        },
        complete: false,
      };
    }
  }

  private async bootstrapAdapter(adapter: AgentProviderAdapter): Promise<CatalogueReadResult> {
    const token = this.beginListing(adapter.providerId);
    const startedAt = Date.now();
    const profile = (phase: string, details: Readonly<Record<string, unknown>> = {}) => {
      recordStartupProfile({ type: "provider-bootstrap", providerId: adapter.providerId, phase, durationMs: Date.now() - startedAt, ...details });
    };
    try {
      profile("capabilities.begin");
      const capabilities = await adapter.getCapabilities();
      profile("capabilities.end", { listSessions: capabilities.listSessions });
      if (!capabilities.listSessions) {
        return {
          result: { providerId: adapter.providerId, status: "skipped", fetched: 0, pages: 0, newlyDiscovered: 0 },
          complete: false,
        };
      }
      profile("list-first-page.begin");
      const firstPage = await adapter.listSessions(listingOptions);
      profile("list-first-page.end", { sessionCount: firstPage.sessions.length, hasNextPage: firstPage.nextCursor !== null });
      const current = this.listingIsCurrent(adapter.providerId, token);
      const complete = firstPage.nextCursor === null && firstPage.authoritative !== false;
      const newlyDiscovered = current
        ? complete
          ? this.cache.reconcileProvider(adapter.providerId, firstPage.sessions)
          : this.cache.mergeProviderPage(adapter.providerId, firstPage.sessions)
        : 0;
      if (current && complete) this.#lastSuccessfulRefreshAt = new Date().toISOString();
      if (current && firstPage.nextCursor !== null) {
        this.scheduleCatalogueTail(
          adapter,
          token,
          [...firstPage.sessions],
          firstPage.nextCursor,
          firstPage.authoritative !== false,
        );
      }
      const result: RefreshProviderResult = {
        providerId: adapter.providerId,
        status: "success",
        fetched: firstPage.sessions.length,
        pages: 1,
        newlyDiscovered,
      };
      // Publish each provider's newest page as soon as it settles. Startup no
      // longer waits for the slowest provider, and an empty authoritative page
      // can remove stale persisted rows. Older pages keep their existing tail
      // notification, so the renderer receives the final catalogue too.
      if (current) await this.notifyBackgroundProviderSettled(result, token);
      profile("end", { status: result.status, fetched: result.fetched });
      return { result, complete };
    } catch (error) {
      profile("failed", { message: error instanceof Error ? error.message : String(error) });
      if (this.listingIsCurrent(adapter.providerId, token)) this.cache.markProviderStale(adapter.providerId);
      return {
        result: {
          providerId: adapter.providerId,
          status: "failed",
          fetched: 0,
          pages: 0,
          newlyDiscovered: 0,
          error: providerErrorFromUnknown(adapter.providerId, error),
        },
        complete: false,
      };
    }
  }

  private scheduleCatalogueTail(
    adapter: AgentProviderAdapter,
    token: ListingToken,
    sessions: RemoteSession[],
    firstCursor: string,
    authoritative: boolean,
  ): void {
    this.#backgroundProviderCounts.set(
      adapter.providerId,
      (this.#backgroundProviderCounts.get(adapter.providerId) ?? 0) + 1,
    );
    let task!: Promise<void>;
    task = new Promise<void>((resolve) => {
      // Keep the scheduled turn alive so lifecycle callers can await the tail.
      setImmediate(() => {
        void this.runCatalogueTail(adapter, token, sessions, firstCursor, authoritative).then(resolve, resolve);
      });
    }).finally(() => {
      this.#backgroundTasks.delete(task);
    });
    this.#backgroundTasks.add(task);
  }

  private async runCatalogueTail(
    adapter: AgentProviderAdapter,
    token: ListingToken,
    sessions: RemoteSession[],
    firstCursor: string,
    authoritative: boolean,
  ): Promise<void> {
    let result: RefreshProviderResult | undefined;
    try {
      result = await this.finishCatalogueTail(adapter, token, sessions, firstCursor, authoritative);
      if (result !== undefined) await this.notifyBackgroundProviderSettled(result, token);
    } finally {
      // Listing ownership includes its post-list reconciliation. Releasing it
      // before the callback finished allowed an idle timer to close the same
      // provider transport while relationship restoration was still using it.
      const remaining = (this.#backgroundProviderCounts.get(adapter.providerId) ?? 1) - 1;
      if (remaining > 0) this.#backgroundProviderCounts.set(adapter.providerId, remaining);
      else this.#backgroundProviderCounts.delete(adapter.providerId);
      try {
        await this.onBackgroundProviderTailFinished?.(adapter.providerId);
      } catch {
        // Releasing an idle transport is an optimization, not catalogue state.
      }
    }
  }

  private async finishCatalogueTail(
    adapter: AgentProviderAdapter,
    token: ListingToken,
    sessions: RemoteSession[],
    firstCursor: string,
    authoritative: boolean,
  ): Promise<RefreshProviderResult | undefined> {
    let pages = 1;
    let cursor = firstCursor;
    const seenCursors = new Set<string>([cursor]);
    try {
      while (true) {
        if (!this.listingIsCurrent(adapter.providerId, token)) return;
        const page = await adapter.listSessions({ ...listingOptions, cursor });
        pages += 1;
        sessions.push(...page.sessions);
        authoritative = authoritative && page.authoritative !== false;
        if (page.nextCursor === null) break;
        if (seenCursors.has(page.nextCursor)) throw new Error(`${adapter.providerId} repeated pagination cursor ${page.nextCursor}`);
        if (pages >= maximumCataloguePages) throw new Error(`${adapter.providerId} exceeded maximum page count ${maximumCataloguePages}`);
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      if (!this.listingIsCurrent(adapter.providerId, token)) return;
      const newlyDiscovered = authoritative
        ? this.cache.reconcileProvider(adapter.providerId, sessions)
        : this.cache.mergeProviderPage(adapter.providerId, sessions);
      if (authoritative) this.#lastSuccessfulRefreshAt = new Date().toISOString();
      return {
        providerId: adapter.providerId,
        status: "success",
        fetched: sessions.length,
        pages,
        newlyDiscovered,
      };
    } catch (error) {
      if (!this.listingIsCurrent(adapter.providerId, token)) return;
      this.cache.markProviderStale(adapter.providerId);
      return {
        providerId: adapter.providerId,
        status: "failed",
        fetched: sessions.length,
        pages,
        newlyDiscovered: 0,
        error: providerErrorFromUnknown(adapter.providerId, error),
      };
    }
  }

  private async notifyBackgroundProviderSettled(result: RefreshProviderResult, token: ListingToken): Promise<void> {
    const providerId = result.providerId;
    const previous = this.#providerNotifications.get(providerId) ?? Promise.resolve();
    let notification!: Promise<void>;
    notification = previous.catch(() => undefined).then(async () => {
      // A live provider event or a newer listing can win while the page result
      // waits behind the prior callback. Never publish that obsolete result.
      if (!this.listingIsCurrent(providerId, token)) return;
      try {
        await this.onBackgroundProviderSettled?.(result);
      } catch {
        // The cache update has already committed. Notification failure must not
        // turn a successful provider read into an unhandled rejection.
      }
    }).finally(() => {
      if (this.#providerNotifications.get(providerId) === notification) {
        this.#providerNotifications.delete(providerId);
      }
    });
    this.#providerNotifications.set(providerId, notification);
    await notification;
  }

  private async performBootstrap(): Promise<SessionBootstrapResult> {
    const bootstrapId = `bootstrap_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const adapters = [...this.adapters.values()];
    const results = new Array<RefreshProviderResult>(adapters.length);
    let nextAdapter = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextAdapter;
        nextAdapter += 1;
        const adapter = adapters[index];
        if (adapter === undefined) return;
        results[index] = (await this.bootstrapAdapter(adapter)).result;
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(maximumConcurrentProviderListings, adapters.length) },
      async () => await worker(),
    ));
    const initialPagesCompletedAt = new Date().toISOString();
    return {
      bootstrapId,
      startedAt,
      initialPagesCompletedAt,
      sessions: this.cache.all(),
      providers: results,
      backgroundInProgress: this.#backgroundTasks.size > 0,
      ...(this.#lastSuccessfulRefreshAt !== undefined ? { lastSuccessfulRefreshAt: this.#lastSuccessfulRefreshAt } : {}),
    };
  }

  private async performRefresh(): Promise<RefreshResult> {
    const refreshId = `refresh_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const entries = [...this.adapters.values()];
    const listings = await Promise.all(entries.map(async (adapter) => await this.refreshAdapter(adapter)));
    const results = listings.map((listing) => listing.result);
    const completedAt = new Date().toISOString();
    if (listings.some((listing) => listing.complete && listing.result.status === "success")) {
      this.#lastSuccessfulRefreshAt = completedAt;
    }
    return {
      refreshId,
      startedAt,
      completedAt,
      sessions: this.cache.all(),
      providers: results,
      ...(this.#lastSuccessfulRefreshAt !== undefined ? { lastSuccessfulRefreshAt: this.#lastSuccessfulRefreshAt } : {}),
    };
  }
}
