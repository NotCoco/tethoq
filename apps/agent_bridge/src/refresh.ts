import { randomUUID } from "node:crypto";
import type { RefreshProviderResult, RefreshResult } from "../../../packages/protocol/src/index.js";
import { collectAllSessionPages, providerErrorFromUnknown, type AgentProviderAdapter } from "../../../packages/provider_contract/src/index.js";
import { SessionCache } from "./session_cache.js";

export class RefreshCoordinator {
  #inFlight: Promise<RefreshResult> | null = null;
  #lastSuccessfulRefreshAt: string | undefined;

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

  private async performRefresh(): Promise<RefreshResult> {
    const refreshId = `refresh_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const entries = [...this.adapters.values()];
    const results = await Promise.all(entries.map(async (adapter): Promise<RefreshProviderResult> => {
      try {
        const capabilities = await adapter.getCapabilities();
        if (!capabilities.listSessions) {
          return { providerId: adapter.providerId, status: "skipped", fetched: 0, pages: 0, newlyDiscovered: 0 };
        }
        const collected = await collectAllSessionPages(adapter, { limit: 100, sortKey: "updated_at", sortDirection: "desc" });
        const newlyDiscovered = this.cache.reconcileProvider(adapter.providerId, collected.sessions);
        return {
          providerId: adapter.providerId,
          status: "success",
          fetched: collected.sessions.length,
          pages: collected.pages,
          newlyDiscovered,
        };
      } catch (error) {
        this.cache.markProviderStale(adapter.providerId);
        return {
          providerId: adapter.providerId,
          status: "failed",
          fetched: 0,
          pages: 0,
          newlyDiscovered: 0,
          error: providerErrorFromUnknown(adapter.providerId, error),
        };
      }
    }));
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
