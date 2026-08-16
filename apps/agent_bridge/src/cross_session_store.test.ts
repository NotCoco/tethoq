import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CrossSessionInboxStore, defaultCrossSessionInboxStatePath } from "./cross_session_store.js";

const envelope = {
  version: 1 as const,
  id: "remote_one",
  requestId: "request-one",
  sourceSessionId: "host/fake/source",
  sourceTitle: "Source task",
  targetSessionId: "host/fake/target",
  content: "Please check the result.",
  createdAt: "2026-08-15T10:00:00.000Z",
};

test("cross-session inbox persists a bounded versioned envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-cross-session-"));
  const path = defaultCrossSessionInboxStatePath(join(root, "config.json"));
  try {
    const store = new CrossSessionInboxStore(path);
    assert.deepEqual(await store.read(), { version: 1, messages: [] });
    await store.scheduleWrite([{
      envelope,
      state: "delivered",
      attemptCount: 1,
      updatedAt: "2026-08-15T10:00:01.000Z",
      deliveredAt: "2026-08-15T10:00:01.000Z",
      providerMessageIds: ["cross_session_remote_one"],
    }]);
    await store.flush();
    assert.deepEqual((await new CrossSessionInboxStore(path).read()).messages[0]?.envelope, envelope);
    assert.match(await readFile(path, "utf8"), /"version": 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-session inbox preserves an interrupted delivery for history reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-cross-session-"));
  const path = defaultCrossSessionInboxStatePath(join(root, "config.json"));
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      messages: [{ envelope, state: "sending", attemptCount: 1, updatedAt: "2026-08-15T10:00:01.000Z" }],
    }), "utf8");
    const [restored] = (await new CrossSessionInboxStore(path).read()).messages;
    assert.equal(restored?.state, "sending");
    assert.equal(restored?.attemptCount, 1);
    assert.equal(restored?.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-session inbox rejects an envelope version it cannot validate", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-cross-session-"));
  const path = defaultCrossSessionInboxStatePath(join(root, "config.json"));
  try {
    await writeFile(path, JSON.stringify({
      version: 1,
      messages: [{ envelope: { ...envelope, version: 2 }, state: "pending", attemptCount: 0, updatedAt: envelope.createdAt }],
    }), "utf8");
    await assert.rejects(() => new CrossSessionInboxStore(path).read(), /envelope is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
