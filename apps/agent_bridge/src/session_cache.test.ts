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
  cache.upsert(session("working"));

  cache.reconcileProvider("fake", [session("unknown", {
    title: "Refreshed title",
    lastActivityAt: "2026-08-10T11:00:00.000Z",
    stale: true,
  })]);

  const reconciled = cache.get("host/fake/session-one");
  assert.equal(reconciled?.state, "working");
  assert.equal(reconciled?.title, "Refreshed title");
  assert.equal(reconciled?.stale, false);
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
  assert.deepEqual(cache.get(child.id)?.relationship, {
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
