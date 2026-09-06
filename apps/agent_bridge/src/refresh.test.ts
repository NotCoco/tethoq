import assert from "node:assert/strict";
import test from "node:test";
import type { RefreshProviderResult, RemoteSession } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { ListSessionsOptions, PaginatedSessions } from "../../../packages/provider_contract/src/index.js";
import { RefreshCoordinator } from "./refresh.js";
import { SessionCache } from "./session_cache.js";

function session(providerId: string, providerSessionId: string, updated = providerSessionId): RemoteSession {
  return {
    id: `host/${providerId}/${providerSessionId}`,
    hostId: "host",
    providerId,
    providerSessionId,
    title: providerSessionId,
    state: "idle",
    lastActivityAt: `2026-08-25T10:00:${updated.padStart(2, "0")}.000Z`,
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  };
}

class DeferredPagedProvider extends FakeProviderAdapter {
  readonly newest: RemoteSession;
  readonly older: RemoteSession;
  #releaseTail!: () => void;
  readonly #tail = new Promise<void>((resolve) => { this.#releaseTail = resolve; });

  public constructor(providerId = "paged") {
    super({ hostId: "host", providerId, sessionCount: 0 });
    this.newest = session(providerId, "newest", "03");
    this.older = session(providerId, "older", "02");
  }

  public releaseTail(): void { this.#releaseTail(); }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    if (options.cursor === undefined) return { sessions: [this.newest], nextCursor: "older-page" };
    assert.equal(options.cursor, "older-page");
    await this.#tail;
    // Repeating the newest item proves the cache remains exact-once by ID even
    // when provider pages overlap at their boundary.
    return { sessions: [this.newest, this.older], nextCursor: null };
  }
}

class FailingProvider extends FakeProviderAdapter {
  public override async listSessions(): Promise<PaginatedSessions> {
    throw new Error("catalogue unavailable");
  }
}

class IncompleteProvider extends FakeProviderAdapter {
  public readonly newest: RemoteSession;

  public constructor(providerId = "incomplete") {
    super({ hostId: "host", providerId, sessionCount: 0 });
    this.newest = session(providerId, "newest", "03");
  }

  public override async listSessions(): Promise<PaginatedSessions> {
    return { sessions: [this.newest], nextCursor: null, authoritative: false };
  }
}

class IncompleteTailProvider extends FakeProviderAdapter {
  public readonly newest: RemoteSession;
  public readonly older: RemoteSession;

  public constructor(providerId = "incomplete-tail") {
    super({ hostId: "host", providerId, sessionCount: 0 });
    this.newest = session(providerId, "newest", "03");
    this.older = session(providerId, "older", "02");
  }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    return options.cursor === undefined
      ? { sessions: [this.newest], nextCursor: "tail", authoritative: true }
      : { sessions: [this.older], nextCursor: null, authoritative: false };
  }
}

class BootstrapConcurrencyProvider extends FakeProviderAdapter {
  public constructor(
    providerId: string,
    private readonly state: { active: number; maximum: number },
    private readonly gate: Promise<void>,
  ) {
    super({ hostId: "host", providerId, sessionCount: 0 });
  }

  public override async listSessions(): Promise<PaginatedSessions> {
    this.state.active += 1;
    this.state.maximum = Math.max(this.state.maximum, this.state.active);
    await this.gate;
    this.state.active -= 1;
    return { sessions: [], nextCursor: null };
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("bootstrap returns after first pages, preserves older cache, then authoritatively reconciles the tail", async () => {
  const provider = new DeferredPagedProvider();
  const cache = new SessionCache();
  const obsolete = session(provider.providerId, "obsolete", "01");
  cache.upsert(provider.older);
  cache.upsert(obsolete);
  const settled: RefreshProviderResult[] = [];
  const coordinator = new RefreshCoordinator(new Map([[provider.providerId, provider]]), cache, (result) => { settled.push(result); });

  const bootstrap = await coordinator.bootstrap();
  assert.equal(bootstrap.backgroundInProgress, true);
  assert.deepEqual(bootstrap.sessions.map((item) => item.providerSessionId).sort(), ["newest", "obsolete", "older"]);
  assert.equal(settled.length, 1, "the newest page is visible before the blocked older page finishes");
  assert.equal(settled[0]?.pages, 1);

  provider.releaseTail();
  await coordinator.waitForBackground();

  assert.deepEqual(cache.all().map((item) => item.providerSessionId).sort(), ["newest", "older"]);
  assert.equal(new Set(cache.all().map((item) => item.id)).size, cache.all().length);
  assert.equal(settled.length, 2);
  assert.equal(settled[1]?.status, "success");
  assert.equal(settled[1]?.pages, 2);
});

test("ordinary refresh remains a truthful full refresh", async () => {
  const provider = new DeferredPagedProvider("manual");
  const coordinator = new RefreshCoordinator(new Map([[provider.providerId, provider]]), new SessionCache());
  let completed = false;
  const refresh = coordinator.refresh().then((result) => {
    completed = true;
    return result;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false, "manual refresh must still wait for the provider's final page");
  provider.releaseTail();
  const result = await refresh;
  assert.equal(result.providers[0]?.pages, 2);
  assert.equal(result.sessions.length, 2);
});

test("an incomplete ordinary refresh merges recent rows without deleting older cached sessions", async () => {
  const provider = new IncompleteProvider();
  const cache = new SessionCache();
  cache.upsert(session(provider.providerId, "cached-older", "01"));
  const coordinator = new RefreshCoordinator(new Map([[provider.providerId, provider]]), cache);

  const result = await coordinator.refresh();

  assert.equal(result.providers[0]?.status, "success");
  assert.deepEqual(cache.all().map((item) => item.providerSessionId).sort(), ["cached-older", "newest"]);
  assert.equal(coordinator.lastSuccessfulRefreshAt, undefined, "a bounded window is not a completed catalogue sync");
});

test("an incomplete background tail never deletes sessions absent from its bounded window", async () => {
  const provider = new IncompleteTailProvider();
  const cache = new SessionCache();
  cache.upsert(session(provider.providerId, "cached-older", "01"));
  const coordinator = new RefreshCoordinator(new Map([[provider.providerId, provider]]), cache);

  await coordinator.bootstrap();
  await coordinator.waitForBackground();

  assert.deepEqual(cache.all().map((item) => item.providerSessionId).sort(), ["cached-older", "newest", "older"]);
  assert.equal(coordinator.lastSuccessfulRefreshAt, undefined, "an incomplete tail cannot certify a full sync");
});

test("an authoritative provider still removes genuinely deleted top-level sessions", async () => {
  const provider = new FakeProviderAdapter({ hostId: "host", providerId: "authoritative", sessionCount: 1 });
  const cache = new SessionCache();
  cache.upsert(session(provider.providerId, "deleted", "01"));
  const coordinator = new RefreshCoordinator(new Map([[provider.providerId, provider]]), cache);

  await coordinator.refresh();

  assert.equal(cache.all().some((item) => item.providerSessionId === "deleted"), false);
  assert.notEqual(coordinator.lastSuccessfulRefreshAt, undefined);
});

test("one provider failure cannot block another provider's bootstrap page", async () => {
  const good = new FakeProviderAdapter({ hostId: "host", providerId: "good", sessionCount: 1 });
  const bad = new FailingProvider({ hostId: "host", providerId: "bad", sessionCount: 0 });
  const cache = new SessionCache();
  const coordinator = new RefreshCoordinator(new Map([
    [good.providerId, good],
    [bad.providerId, bad],
  ]), cache);

  const result = await coordinator.bootstrap();
  assert.equal(result.providers.find((item) => item.providerId === "good")?.status, "success");
  assert.equal(result.providers.find((item) => item.providerId === "bad")?.status, "failed");
  assert.equal(cache.all().some((item) => item.providerId === "good"), true);
});

test("bootstrap bounds concurrent provider catalogue materialization without dropping providers", async () => {
  const release = deferred();
  const state = { active: 0, maximum: 0 };
  const providers = Array.from({ length: 5 }, (_, index) =>
    new BootstrapConcurrencyProvider(`bounded-${index}`, state, release.promise));
  const coordinator = new RefreshCoordinator(
    new Map(providers.map((provider) => [provider.providerId, provider])),
    new SessionCache(),
  );

  const bootstrap = coordinator.bootstrap();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.active, 2);
  assert.equal(state.maximum, 2);

  release.resolve();
  const result = await bootstrap;
  assert.equal(result.providers.length, providers.length);
  assert.equal(result.providers.every((provider) => provider.status === "success"), true);
  assert.equal(state.maximum, 2);
});

test("a newer provider event suppresses an older queued tail notification", async () => {
  const provider = new DeferredPagedProvider("stale-tail");
  const firstCallback = deferred();
  const firstCallbackStarted = deferred();
  const settled: RefreshProviderResult[] = [];
  const coordinator = new RefreshCoordinator(
    new Map([[provider.providerId, provider]]),
    new SessionCache(),
    async (result) => {
      settled.push(result);
      if (result.pages === 1) {
        firstCallbackStarted.resolve();
        await firstCallback.promise;
      }
    },
  );

  const bootstrap = coordinator.bootstrap();
  await firstCallbackStarted.promise;
  provider.releaseTail();
  await new Promise<void>((resolve) => setImmediate(resolve));
  coordinator.noteProviderEvent(provider.providerId);
  firstCallback.resolve();
  await bootstrap;
  await coordinator.waitForBackground();

  assert.deepEqual(settled.map((result) => result.pages), [1]);
});

test("tail ownership remains held until provider reconciliation finishes", async () => {
  const provider = new DeferredPagedProvider("owned-tail");
  const finalCallback = deferred();
  const finalCallbackStarted = deferred();
  const tailFinished: string[] = [];
  const coordinator = new RefreshCoordinator(
    new Map([[provider.providerId, provider]]),
    new SessionCache(),
    async (result) => {
      if (result.pages > 1) {
        finalCallbackStarted.resolve();
        await finalCallback.promise;
      }
    },
    (providerId) => { tailFinished.push(providerId); },
  );

  await coordinator.bootstrap();
  provider.releaseTail();
  await finalCallbackStarted.promise;
  assert.equal(coordinator.hasBackgroundCatalogueTail(provider.providerId), true);
  assert.deepEqual(tailFinished, []);
  finalCallback.resolve();
  await coordinator.waitForBackground();

  assert.equal(coordinator.hasBackgroundCatalogueTail(provider.providerId), false);
  assert.deepEqual(tailFinished, [provider.providerId]);
});
