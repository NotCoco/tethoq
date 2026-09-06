import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteSession } from "../../../packages/protocol/src/index.js";
import { SessionCache } from "./session_cache.js";

function session(state: RemoteSession["state"], overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: "host/fake/session-one",
    hostId: "host",
    providerId: "fake",
    providerSessionId: "session-one",
    title: "Original title",
    state,
    lastActivityAt: "2026-08-10T10:00:00.000Z",
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
    ...overrides,
  };
}

test("refresh reconciliation preserves a known cached state when the provider reports unknown", () => {
  const cache = new SessionCache();
  cache.upsert(session("needs_approval"));

  cache.reconcileProvider("fake", [session("unknown", {
    title: "Refreshed title",
    lastActivityAt: "2026-08-10T11:00:00.000Z",
    stale: true,
  })]);

  const reconciled = cache.get("host/fake/session-one");
  assert.equal(reconciled?.state, "needs_approval");
  assert.equal(reconciled?.title, "Refreshed title");
  assert.equal(reconciled?.stale, false);
});

test("a working session settles through an unknown listing once its turn is no longer in flight", () => {
  const cache = new SessionCache();
  cache.upsert(session("working"));
  cache.reconcileProvider("fake", [session("unknown", { lastActivityAt: "2026-08-10T11:00:00.000Z" })]);
  assert.equal(cache.get("host/fake/session-one")?.state, "unknown", "stale working must not survive a listing that cannot report state");

  const busy = new SessionCache({ preserveWorking: () => true });
  busy.upsert(session("working"));
  busy.reconcileProvider("fake", [session("unknown", { lastActivityAt: "2026-08-10T11:00:00.000Z" })]);
  assert.equal(busy.get("host/fake/session-one")?.state, "working", "an in-flight turn must not be downgraded");
});

test("an uncontested direct provider read settles stale working state", () => {
  const cache = new SessionCache({ preserveWorking: () => true });
  cache.upsert(session("working"));
  const baseline = cache.get("host/fake/session-one");

  assert.equal(cache.reconcileAuthoritative(session("idle", {
    lastActivityAt: "2026-08-10T11:00:00.000Z",
  }), baseline), true);
  assert.equal(cache.get("host/fake/session-one")?.state, "idle",
    "a direct provider read must not use cached working state as circular proof of live work");
});

test("a provider event that lands during a direct read wins over its late response", () => {
  const cache = new SessionCache({ preserveWorking: () => true });
  cache.upsert(session("idle"));
  const baseline = cache.get("host/fake/session-one");

  cache.updateState("host/fake/session-one", "working", false, "2026-08-10T12:00:00.000Z");
  assert.equal(cache.reconcileAuthoritative(session("idle", {
    lastActivityAt: "2026-08-10T11:00:00.000Z",
  }), baseline), false);
  assert.equal(cache.get("host/fake/session-one")?.state, "working");
  assert.equal(cache.get("host/fake/session-one")?.lastActivityAt, "2026-08-10T12:00:00.000Z");
});

test("provider status follows canonical refreshes and supports an explicit clear", () => {
  const cache = new SessionCache();
  const retry = {
    kind: "retry" as const,
    message: "The provider is temporarily rate limited.",
    retryAt: "2026-08-10T10:00:05.000Z",
  };
  cache.upsert(session("working", { providerStatus: retry }));
  assert.deepEqual(cache.get("host/fake/session-one")?.providerStatus, retry);

  cache.updateProviderStatus("host/fake/session-one", null);
  assert.equal(cache.get("host/fake/session-one")?.providerStatus, undefined);

  cache.updateProviderStatus("host/fake/session-one", retry);
  cache.reconcileProvider("fake", [session("working")]);
  assert.equal(
    cache.get("host/fake/session-one")?.providerStatus,
    undefined,
    "a provider refresh that omits a transient status must clear the cached copy",
  );
});

test("runtime metadata survives a sparse refresh and cached child sessions survive root reconciliation", () => {
  const cache = new SessionCache();
  const parent = session("working", {
    id: "host/fake/parent",
    providerSessionId: "parent",
    modelId: "model-a",
    reasoningEffort: "high",
  });
  const child = session("working", {
    id: "host/fake/child",
    providerSessionId: "child",
    parentSessionId: parent.id,
    agentNickname: "Curie",
    agentRole: "explorer",
  });
  cache.upsert(parent);
  cache.upsert(child);
  cache.updateMetadata(parent.id, { modelId: "model-b", variantId: "careful" });
  cache.updateNativeMetadata(parent.id, {
    tethoqHandoffSummary: "Deterministic summary",
    tethoqHandoffPending: false,
  });

  cache.reconcileProvider("fake", [session("idle", {
    id: parent.id,
    providerSessionId: parent.providerSessionId,
  })]);

  assert.equal(cache.get(parent.id)?.modelId, "model-b");
  assert.equal(cache.get(parent.id)?.reasoningEffort, "high");
  assert.equal(cache.get(parent.id)?.variantId, "careful");
  assert.equal(cache.get(parent.id)?.nativeMetadata.tethoqHandoffSummary, "Deterministic summary");
  assert.equal(cache.get(parent.id)?.nativeMetadata.tethoqHandoffPending, false);
  assert.equal(cache.get(child.id)?.parentSessionId, parent.id);
  assert.equal(cache.get(child.id)?.agentNickname, "Curie");
  assert.equal(cache.get(child.id)?.relationship, undefined);
});

test("only explicit helper roles infer a hidden subagent relationship", () => {
  const cache = new SessionCache();
  const parent = session("idle", { id: "host/fake/parent", providerSessionId: "parent" });
  const helper = session("working", {
    id: "host/fake/helper",
    providerSessionId: "helper",
    parentSessionId: parent.id,
    agentRole: "cross_harness_delegate",
  });
  cache.upsert(parent);
  cache.upsert(helper);
  assert.deepEqual(cache.get(helper.id)?.relationship, {
    kind: "subagent",
    sourceSessionId: parent.id,
    strategy: "native",
  });
});

test("child reconciliation is scoped to one parent and handles reparenting and removal", () => {
  const cache = new SessionCache();
  const parentA = session("idle", { id: "host/fake/parent-a", providerSessionId: "parent-a" });
  const parentB = session("idle", { id: "host/fake/parent-b", providerSessionId: "parent-b" });
  const child = session("working", {
    id: "host/fake/child",
    providerSessionId: "child",
    parentSessionId: parentA.id,
  });
  const unrelated = session("idle", {
    id: "host/fake/unrelated",
    providerSessionId: "unrelated",
    parentSessionId: parentB.id,
  });
  cache.upsert(parentA);
  cache.upsert(parentB);
  cache.upsert(child);
  cache.upsert(unrelated);

  const reparented = { ...child, parentSessionId: parentB.id };
  cache.reconcileChildren(parentB.id, [reparented, unrelated]);
  cache.reconcileChildren(parentA.id, []);
  assert.equal(cache.get(child.id)?.parentSessionId, parentB.id);
  assert.equal(cache.get(unrelated.id)?.parentSessionId, parentB.id);

  cache.reconcileProvider("fake", [parentA, parentB]);
  assert.equal(cache.get(child.id)?.parentSessionId, parentB.id, "root refresh must preserve cached children");
  cache.reconcileChildren(parentB.id, [unrelated]);
  assert.equal(cache.get(child.id), undefined);
  assert.equal(cache.get(unrelated.id)?.parentSessionId, parentB.id);
});

test("what the harness reports it is running outranks anything remembered locally", () => {
  const cache = new SessionCache();
  cache.upsert(session("idle", { modelId: "grok-4.6" }));

  // Until the harness says otherwise, the dispatched choice stands in for it.
  cache.rememberRequestedSelection("host/fake/session-one", { modelId: "grok-4.6", reasoningEffort: "xhigh" });
  assert.equal(cache.get("host/fake/session-one")?.reasoningEffort, "xhigh");

  // The harness then reports the level it is actually running, which wins. A
  // remembered value that outranked this is how a level changed inside the
  // harness stayed invisible in Tethoq forever.
  cache.reconcileProvider("fake", [session("working", { modelId: "grok-4.6", reasoningEffort: "medium" })]);
  assert.equal(cache.get("host/fake/session-one")?.reasoningEffort, "medium");
});

test("a remembered effort fills the gap only while the harness reports none", () => {
  const cache = new SessionCache();
  cache.upsert(session("idle", { modelId: "grok-4.6" }));
  cache.rememberRequestedSelection("host/fake/session-one", { reasoningEffort: "xhigh" });

  cache.reconcileProvider("fake", [session("working", { modelId: "grok-4.6" })]);

  assert.equal(cache.get("host/fake/session-one")?.reasoningEffort, "xhigh");
});

test("switching model drops an effort chosen for the previous model", () => {
  const cache = new SessionCache();
  cache.upsert(session("idle"));

  cache.rememberRequestedSelection("host/fake/session-one", { modelId: "grok-4.6", reasoningEffort: "xhigh" });
  cache.rememberRequestedSelection("host/fake/session-one", { modelId: "grok-4.5" });

  const current = cache.get("host/fake/session-one");
  assert.equal(current?.modelId, "grok-4.5");
  assert.equal(current?.reasoningEffort, undefined);
});

test("a remembered selection is forgotten once the session leaves the provider listing", () => {
  const cache = new SessionCache();
  cache.upsert(session("idle"));
  cache.rememberRequestedSelection("host/fake/session-one", { reasoningEffort: "xhigh" });

  cache.reconcileProvider("fake", []);
  cache.upsert(session("idle", { reasoningEffort: "high" }));

  assert.equal(cache.get("host/fake/session-one")?.reasoningEffort, "high");
});

test("a partial provider page never deletes cached sessions before authoritative reconciliation", () => {
  const cache = new SessionCache();
  const newest = session("idle", { id: "host/fake/newest", providerSessionId: "newest" });
  const older = session("idle", { id: "host/fake/older", providerSessionId: "older" });
  const removed = session("idle", { id: "host/fake/removed", providerSessionId: "removed" });
  cache.upsert(older);
  cache.upsert(removed);

  cache.mergeProviderPage("fake", [newest]);
  assert.deepEqual(cache.all().map((item) => item.providerSessionId).sort(), ["newest", "older", "removed"]);

  cache.reconcileProvider("fake", [newest, older]);
  assert.deepEqual(cache.all().map((item) => item.providerSessionId).sort(), ["newest", "older"]);
});

test("a level learned from the harness is kept so the next start is not blind", () => {
  const written: Array<Readonly<Record<string, unknown>>> = [];
  const cache = new SessionCache({ onSelectionsChange: (selections) => written.push(selections) });

  // Opening the chat is when a harness like Grok finally reveals the level.
  cache.upsert(session("idle", { modelId: "grok-4.6", reasoningEffort: "xhigh" }));

  assert.equal(cache.knownSelections()["host/fake/session-one"]?.reasoningEffort, "xhigh");
  assert.equal(cache.knownSelections()["host/fake/session-one"]?.source, "reported");
  assert.ok(written.length > 0);
});

test("provider catalogue reconciliation publishes one complete selection snapshot", () => {
  const written: Array<Readonly<Record<string, unknown>>> = [];
  const cache = new SessionCache({ onSelectionsChange: (selections) => written.push(selections) });
  const sessions = Array.from({ length: 750 }, (_, index) => session("idle", {
    id: `host/fake/session-${index}`,
    providerSessionId: `session-${index}`,
    modelId: `model-${index % 3}`,
    reasoningEffort: index % 2 === 0 ? "high" : "medium",
  }));

  cache.reconcileProvider("fake", sessions);

  assert.equal(written.length, 1, "a bulk catalogue must not persist one growing snapshot per session");
  assert.equal(Object.keys(written[0] ?? {}).length, sessions.length);
});

test("a restart shows the last level the harness reported, before any chat is opened", () => {
  const learned = new SessionCache();
  learned.upsert(session("idle", { modelId: "grok-4.6", reasoningEffort: "xhigh" }));
  const persisted = learned.knownSelections();

  // Next run: the listing carries no level at all, which is exactly what Grok's
  // session/list returns. Without this the composer fell back to the default.
  const restarted = new SessionCache();
  restarted.restoreSelections(persisted);
  restarted.reconcileProvider("fake", [session("idle")]);

  assert.equal(restarted.get("host/fake/session-one")?.reasoningEffort, "xhigh");
  assert.equal(restarted.get("host/fake/session-one")?.modelId, "grok-4.6");
});

test("a level changed inside the harness replaces the remembered one", () => {
  const cache = new SessionCache();
  cache.upsert(session("idle", { modelId: "grok-4.6", reasoningEffort: "xhigh" }));

  // The user switches to low in Grok's own interface; it reports that next time.
  cache.reconcileProvider("fake", [session("idle", { modelId: "grok-4.6", reasoningEffort: "low" })]);

  assert.equal(cache.get("host/fake/session-one")?.reasoningEffort, "low");
  assert.equal(cache.knownSelections()["host/fake/session-one"]?.reasoningEffort, "low");
});

test("an explicit native-default report clears a previous level on the same model", () => {
  const cache = new SessionCache();
  cache.upsert(session("idle", { modelId: "opencode-go/glm-5.3-flash", reasoningEffort: "max" }));

  cache.rememberReportedSelection("host/fake/session-one", {
    modelId: "opencode-go/glm-5.3-flash",
    reasoningEffort: "default",
  });

  assert.equal(cache.get("host/fake/session-one")?.reasoningEffort, "default");
  assert.equal(cache.knownSelections()["host/fake/session-one"]?.reasoningEffort, "default");
});
