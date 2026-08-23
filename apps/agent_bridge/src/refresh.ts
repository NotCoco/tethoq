import { randomUUID } from "node:crypto";
import type { RefreshProviderResult, RefreshResult } from "../../../packages/protocol/src/index.js";
import { collectAllSessionPages, providerErrorFromUnknown, type AgentProviderAdapter } from "../../../packages/provider_contract/src/index.js";
import { SessionCache } from "./session_cache.js";

export class RefreshCoordinator {
  #inFlight: Promise<RefreshResult> | null = null;
  #lastSuccessfulRefreshAt: string | undefined;
  readonly #providerRevisions = new Map<string, number>();

  public constructor(
    private readonly adapters: ReadonlyMap<string, AgentProviderAdapter>,
    private readonly cache: SessionCache,
  ) {}

  public refresh(): Promise<RefreshResult> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.performRefresh().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  public get inProgress(): boolean {
    return this.#inFlight !== null;
  }

  public get lastSuccessfulRefreshAt(): string | undefined {
    return this.#lastSuccessfulRefreshAt;
  }

  /** Marks provider-native state as newer than any listing already in flight. */
  public noteProviderEvent(providerId: string): void {
    this.#providerRevisions.set(providerId, (this.#providerRevisions.get(providerId) ?? 0) + 1);
  }

  /**
   * Re-lists a single provider. Providers can arrive after the first refresh --
   * OpenCode's server takes seconds to boot, so the startup pass marks it stale
   * and caches nothing. Reconnecting only resubscribes to the live event feed,
   * which carries new activity but never the sessions that already exist, so
   * without a re-list those stay invisible until something triggers a full
   * refresh.
   */
  public async refreshProvider(providerId: string): Promise<RefreshProviderResult | undefined> {
    const adapter = this.adapters.get(providerId);
    if (adapter === undefined) return undefined;
    const result = await this.refreshAdapter(adapter);
    if (result.status === "success") this.#lastSuccessfulRefreshAt = new Date().toISOString();
    return result;
  }

  private async refreshAdapter(adapter: AgentProviderAdapter): Promise<RefreshProviderResult> {
    const revision = this.#providerRevisions.get(adapter.providerId) ?? 0;
    try {
      const capabilities = await adapter.getCapabilities();
      if (!capabilities.listSessions) {
        return { providerId: adapter.providerId, status: "skipped", fetched: 0, pages: 0, newlyDiscovered: 0 };
      }
      const collected = await collectAllSessionPages(adapter, { limit: 100, sortKey: "updated_at", sortDirection: "desc" });
      // A provider event can clear retry state while its older listing is still
      // in flight. Never let that response overwrite the newer live cache.
      const unchanged = (this.#providerRevisions.get(adapter.providerId) ?? 0) === revision;
      const newlyDiscovered = unchanged ? this.cache.reconcileProvider(adapter.providerId, collected.sessions) : 0;
      return {
        providerId: adapter.providerId,
        status: "success",
        fetched: collected.sessions.length,
        pages: collected.pages,
        newlyDiscovered,
      };
    } catch (error) {
      if ((this.#providerRevisions.get(adapter.providerId) ?? 0) === revision) {
        this.cache.markProviderStale(adapter.providerId);
      }
      return {
        providerId: adapter.providerId,
        status: "failed",
        fetched: 0,
        pages: 0,
        newlyDiscovered: 0,
        error: providerErrorFromUnknown(adapter.providerId, error),
      };
    }
  }

  private async performRefresh(): Promise<RefreshResult> {
    const refreshId = `refresh_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const entries = [...this.adapters.values()];
    const results = await Promise.all(entries.map(async (adapter) => await this.refreshAdapter(adapter)));
    const completedAt = new Date().toISOString();
    if (results.some((result) => result.status === "success")) this.#lastSuccessfulRefreshAt = completedAt;
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
