import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonFileStore } from "./persistence.js";
import {
  SessionSelectionStore,
  type SessionSelection,
} from "./session_selection_store.js";

function selected(modelId: string, updatedAt: string): SessionSelection {
  return { modelId, reasoningEffort: "high", source: "reported", updatedAt };
}

test("selection persistence coalesces to the latest state and flush waits for an in-flight update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-session-selections-"));
  const path = join(directory, "session-selections.json");
  type WritableStorePrototype = { write(value: unknown): Promise<void> };
  const prototype = JsonFileStore.prototype as unknown as WritableStorePrototype;
  const originalWrite = prototype.write;
  const written: unknown[] = [];
  let firstWriteStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
  let releaseFirstWrite!: () => void;
  const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });

  prototype.write = async function write(value: unknown): Promise<void> {
    written.push(value);
    if (written.length === 1) {
      firstWriteStarted();
      await firstWriteGate;
    }
    await originalWrite.call(this, value);
  };

  try {
    const store = new SessionSelectionStore(path);
    store.scheduleWrite({ first: selected("model-first", "2026-08-25T10:00:00.000Z") });
    await firstStarted;

    // Shutdown may begin while the first write is still in flight. Updates
    // queued after flush starts must still be included before flush resolves.
    const flushing = store.flush();
    store.scheduleWrite({ middle: selected("model-middle", "2026-08-25T10:00:01.000Z") });
    store.scheduleWrite({ final: selected("model-final", "2026-08-25T10:00:02.000Z") });
    releaseFirstWrite();
    await flushing;

    assert.equal(written.length, 2, "the superseded middle snapshot must never be written");
    const restored = await new SessionSelectionStore(path).read();
    assert.deepEqual(Object.keys(restored.selections), ["final"]);
    assert.equal(restored.selections.final?.modelId, "model-final");
  } finally {
    prototype.write = originalWrite;
    releaseFirstWrite();
    await rm(directory, { recursive: true, force: true });
  }
});
