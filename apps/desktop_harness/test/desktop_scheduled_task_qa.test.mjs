import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  finishTopLevelWindowWatcher,
  startTopLevelWindowWatcher,
  waitForTopLevelWindowWatcherReady,
} = require("../scripts/real-scheduled-task-qa.cjs");

test("the hidden quit-helper watcher closes cleanly when its root already exited", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async () => {
  const watcher = startTopLevelWindowWatcher(2_147_483_647, "already-exited QA root");

  await waitForTopLevelWindowWatcherReady(watcher);
  const evidence = await finishTopLevelWindowWatcher(watcher);

  assert.equal(evidence.exitCode, 0);
  assert.equal(evidence.visibleWindows.length, 0);
  assert.ok(evidence.diagnostics.some((line) => line.includes("root=missing")));
});
