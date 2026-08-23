import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { makeGlobalSessionId } from "../../../packages/protocol/src/index.js";
import {
  CompactionThresholdStore,
  maximumCompactionThresholds,
} from "./compaction_threshold_store.js";

test("compaction thresholds persist across store instances and stay bounded", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-compaction-thresholds-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "compaction-thresholds.json");
  const thresholds = Object.fromEntries(Array.from({ length: maximumCompactionThresholds + 2 }, (_, index) => [
    makeGlobalSessionId("host-threshold-store", "codex", `session-${index}`),
    10_000 + index,
  ]));

  await new CompactionThresholdStore(path).write(thresholds);
  const restored = await new CompactionThresholdStore(path).read();

  assert.equal(Object.keys(restored.thresholds).length, maximumCompactionThresholds);
  assert.equal(restored.thresholds[makeGlobalSessionId("host-threshold-store", "codex", "session-0")], undefined);
  assert.equal(restored.thresholds[makeGlobalSessionId("host-threshold-store", "codex", `session-${maximumCompactionThresholds + 1}`)], 10_000 + maximumCompactionThresholds + 1);
  assert.doesNotMatch(await readFile(path, "utf8"), /session-0\"/);
});
