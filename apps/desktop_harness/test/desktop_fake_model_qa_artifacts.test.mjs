import assert from "node:assert/strict";
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cleanupOldScreenshotArtifacts } = require("../scripts/fake-model/artifact-cleanup.cjs");

test("fake model QA cleanup removes only stale direct PNG captures", async () => {
  const directory = join(process.cwd(), "local-artifacts", "fake-model-qa-cleanup-test");
  await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, "nested"), { recursive: true });
  await writeFile(join(directory, "old.png"), "old");
  await writeFile(join(directory, "fresh.png"), "fresh");
  await writeFile(join(directory, "report.json"), "report");
  await writeFile(join(directory, "nested", "old.png"), "nested");
  const now = Date.parse("2026-08-22T12:00:00.000Z");
  await utimes(join(directory, "old.png"), new Date(now - 10_000), new Date(now - 10_000));
  await utimes(join(directory, "fresh.png"), new Date(now - 1_000), new Date(now - 1_000));

  const result = await cleanupOldScreenshotArtifacts(directory, 5_000, now);
  assert.deepEqual(result, { scanned: 2, removed: 1, retained: 1, removedFiles: ["old.png"] });
  await assert.rejects(() => stat(join(directory, "old.png")));
  await stat(join(directory, "fresh.png"));
  await stat(join(directory, "report.json"));
  await stat(join(directory, "nested", "old.png"));
  await rm(directory, { recursive: true, force: true });
});
