import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostIdentity, makeGlobalSessionId, type RemoteSession } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import {
  maximumSessionCatalogueEntries,
  SessionCatalogueStore,
} from "./session_catalogue_store.js";

function session(hostId: string, providerSessionId: string, activity = "2026-08-25T12:00:00.000Z"): RemoteSession {
  const providerId = "codex";
  return {
    id: makeGlobalSessionId(hostId, providerId, providerSessionId),
    hostId,
    providerId,
    providerSessionId,
    title: `Task ${providerSessionId}`,
    project: "Tethoq",
    workingDirectory: "C:\\example-repo",
    state: "working",
    providerStatus: { kind: "retry", message: "private retry detail" },
    createdAt: "2026-08-25T11:00:00.000Z",
    lastActivityAt: activity,
    preview: "Visible preview",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "max",
    variantId: "priority",
    sessionKind: "task",
    needsApproval: true,
    stale: false,
    externalWriter: true,
    nativeMetadata: { secret: ["must", "not", "persist"].join("-"), path: "C:\\private" },
  };
}

test("session catalogue persists only bounded display identity and hydrates as unknown stale", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-session-catalogue-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session-catalogue.json");
  const hostId = "catalogue-host";
  const store = new SessionCatalogueStore(path, hostId);
  store.scheduleWrite([session(hostId, "one")]);
  await store.flush();

  const text = await readFile(path, "utf8");
  const raw = JSON.parse(text) as { sessions: Record<string, unknown>[] };
  assert.equal(raw.sessions.length, 1);
  for (const forbidden of ["state", "providerStatus", "needsApproval", "stale", "externalWriter", "nativeMetadata", "contextHandoffSummary"]) {
    assert.equal(Object.hasOwn(raw.sessions[0]!, forbidden), false, `${forbidden} must not be persisted`);
  }
  assert.equal(text.includes("must-not-persist"), false);
  assert.equal(text.includes("private retry detail"), false);

  const [restored] = await new SessionCatalogueStore(path, hostId).read();
  assert.ok(restored);
  assert.equal(restored.state, "unknown");
  assert.equal(restored.stale, true);
  assert.equal(restored.needsApproval, false);
  assert.deepEqual(restored.nativeMetadata, {});
  assert.equal(restored.externalWriter, undefined);
  assert.equal(restored.providerStatus, undefined);
});

test("session catalogue ignores corrupt, unexpected, and cross-host cache data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-session-catalogue-corrupt-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session-catalogue.json");
  const hostId = "catalogue-host";
  await writeFile(path, "{not json", "utf8");
  assert.deepEqual(await new SessionCatalogueStore(path, hostId).read(), []);

  await writeFile(path, JSON.stringify({
    version: 1,
    sessions: [{ ...session(hostId, "one"), nativeMetadata: { injected: true } }],
  }), "utf8");
  assert.deepEqual(await new SessionCatalogueStore(path, hostId).read(), []);

  const otherStore = new SessionCatalogueStore(path, "other-host");
  assert.deepEqual(await otherStore.read(), []);
});

test("session catalogue coalesces writes and keeps only the newest bounded rows", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-session-catalogue-bounded-"));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session-catalogue.json");
  const hostId = "catalogue-host";
  const store = new SessionCatalogueStore(path, hostId);
  store.scheduleWrite([session(hostId, "obsolete", "2025-01-01T00:00:00.000Z")]);
  const latest = Array.from({ length: maximumSessionCatalogueEntries + 5 }, (_, index) =>
    session(hostId, `task-${index}`, new Date(Date.UTC(2026, 7, 25, 12, index)).toISOString()));
  store.scheduleWrite(latest);
  await store.flush();

  const restored = await new SessionCatalogueStore(path, hostId).read();
  assert.equal(restored.length, maximumSessionCatalogueEntries);
  assert.equal(restored.some((entry) => entry.providerSessionId === "obsolete"), false);
  assert.equal(restored.some((entry) => entry.providerSessionId === "task-0"), false);
  assert.equal(restored[0]?.providerSessionId, `task-${maximumSessionCatalogueEntries + 4}`);
});

test("bridge exposes hydrated catalogue immediately and persists only successful structural changes", async (t) => {
  const hostId = "catalogue-bridge-host";
  const config: BridgeConfig = {
    version: 1,
    hostId,
    displayName: "Catalogue bridge",
    identity: createHostIdentity(),
    enabledProviders: ["fake"],
  };
  const provider = new FakeProviderAdapter({ hostId, providerId: "fake", sessionCount: 0 });
  const cached = session(hostId, "cached");
  const writes: RemoteSession[][] = [];
  const bridge = new AgentBridge(config, [provider], {
    sessionCatalogue: [{ ...cached, state: "unknown", stale: true, needsApproval: false, nativeMetadata: {} }],
    onSessionCatalogueChange: (sessions) => writes.push([...sessions]),
  });
  t.after(async () => await bridge.dispose());

  assert.equal(bridge.sessions()[0]?.id, cached.id);
  assert.equal(bridge.sessions()[0]?.state, "unknown");
  const created = await bridge.createSession("fake", { workingDirectory: "C:\\example-repo", title: "Created task" });
  assert.ok(writes.at(-1)?.some((entry) => entry.id === created.id));

  const writesBeforeFailure = writes.length;
  provider.setFailListing(true);
  await bridge.refresh();
  assert.equal(writes.length, writesBeforeFailure, "failed listings must not replace the last-known catalogue");
});
