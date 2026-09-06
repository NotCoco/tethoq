import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, makeGlobalSessionId, type RemoteSession } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { ListSessionsOptions, PaginatedSessions } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";

const hostId = "host-bootstrap-release";

function session(providerSessionId: string, lastActivityAt: string): RemoteSession {
  return {
    id: makeGlobalSessionId(hostId, "paged", providerSessionId),
    hostId,
    providerId: "paged",
    providerSessionId,
    title: providerSessionId,
    state: "idle",
    lastActivityAt,
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  };
}

class ReleaseSensitivePagedProvider extends FakeProviderAdapter {
  #releaseTail!: () => void;
  readonly #tail = new Promise<void>((resolve) => { this.#releaseTail = resolve; });
  public tailInFlight = false;
  public releasedDuringTail = false;
  public releaseCalls = 0;

  public constructor() {
    super({ hostId, providerId: "paged", sessionCount: 0 });
  }

  public releaseTail(): void { this.#releaseTail(); }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    if (options.cursor === undefined) {
      return { sessions: [session("newest", "2026-08-25T10:00:02.000Z")], nextCursor: "older" };
    }
    assert.equal(options.cursor, "older");
    this.tailInFlight = true;
    await this.#tail;
    this.tailInFlight = false;
    return { sessions: [session("older", "2026-08-25T10:00:01.000Z")], nextCursor: null };
  }

  public async releaseIdleResources(): Promise<void> {
    this.releaseCalls += 1;
    if (this.tailInFlight) this.releasedDuringTail = true;
  }
}

class LazyHistoryProvider extends FakeProviderAdapter {
  public historyScans = 0;
  public releaseCalls = 0;
  public readonly parent: RemoteSession;

  public constructor() {
    super({ hostId, providerId: "history", sessionCount: 0 });
    this.parent = {
      id: makeGlobalSessionId(hostId, this.providerId, "parent"),
      hostId,
      providerId: this.providerId,
      providerSessionId: "parent",
      title: "Historical parent",
      state: "idle",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      needsApproval: false,
      stale: false,
      nativeMetadata: {},
    };
  }

  public override async getCapabilities() {
    return { ...await super.getCapabilities(), sessionRelationships: true };
  }

  public override async listSessions(): Promise<PaginatedSessions> {
    return { sessions: [this.parent], nextCursor: null };
  }

  public async getExternalSessionLaunches(_providerSessionId: string, _since: string) {
    this.historyScans += 1;
    return [];
  }

  public async releaseIdleResources(): Promise<void> {
    this.releaseCalls += 1;
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("startup reconciliation never releases a provider beneath its background catalogue tail", async (t) => {
  const provider = new ReleaseSensitivePagedProvider();
  const bridge = new AgentBridge({
    version: 1,
    hostId,
    displayName: "Bootstrap release test",
    identity: createHostIdentity(),
    enabledProviders: [provider.providerId],
  }, [provider]);
  t.after(async () => { await bridge.dispose(); });

  await bridge.start();
  const bootstrap = await bridge.bootstrapSessions();
  assert.equal(bootstrap.backgroundInProgress, true);
  await waitFor(() => provider.tailInFlight, "older catalogue page to start");
  const releaseCallsBeforeTail = provider.releaseCalls;
  await bridge.providerConnections();
  assert.equal(
    provider.releaseCalls,
    releaseCallsBeforeTail,
    "withIdleRelease must use the same pagination guard as startup reconciliation",
  );
  await waitFor(
    () => bridge.eventsSince(0).some((event) => event.type === "session.catalog_changed" && event.providerId === undefined),
    "initial catalogue reconciliation",
  );
  assert.equal(provider.releasedDuringTail, false);

  provider.releaseTail();
  await waitFor(
    () => bridge.eventsSince(0).some((event) => event.type === "session.catalog_changed" && event.providerId === provider.providerId),
    "background provider catalogue completion",
  );
  assert.equal(provider.releasedDuringTail, false);
  await waitFor(() => provider.releaseCalls > releaseCallsBeforeTail, "idle release after background pagination");
});

test("startup releases a complete provider page without scanning historical rollouts", async (t) => {
  const provider = new LazyHistoryProvider();
  const bridge = new AgentBridge({
    version: 1,
    hostId,
    displayName: "Lazy history test",
    identity: createHostIdentity(),
    enabledProviders: [provider.providerId],
  }, [provider]);
  t.after(async () => { await bridge.dispose(); });

  await bridge.start();
  provider.releaseCalls = 0;
  await bridge.bootstrapSessions();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(provider.historyScans, 0, "startup catalogue work must not read old provider rollouts");
  assert.ok(provider.releaseCalls > 0, "a complete first page must re-arm idle provider release");

  await bridge.listChildSessions(provider.parent.id);
  assert.equal(provider.historyScans, 1, "opening child sessions scans only the requested parent rollout");
});
