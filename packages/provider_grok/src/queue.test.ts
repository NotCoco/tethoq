import assert from "node:assert/strict";
import test from "node:test";
import { grokQueueEditParams, grokQueueRemoveParams, isGrokQueueChangedMethod, parseGrokQueueChanged } from "./queue.js";

test("Grok queue/changed snapshots keep prompt entries and drop non-prompt rows", () => {
  const snapshot = parseGrokQueueChanged({
    sessionId: "session-1",
    runningPromptId: "running-1",
    entries: [
      { id: "q1", kind: "prompt", text: "Inspect the parser" },
      { id: "tool-1", kind: "tool", text: "hidden" },
      { text: "Follow up without an id" },
    ],
  }, new Date("2026-08-17T12:00:00.000Z"));
  assert.equal(snapshot?.sessionId, "session-1");
  assert.equal(snapshot?.runningPromptId, "running-1");
  assert.deepEqual(snapshot?.entries.map((entry) => [entry.id, entry.content]), [
    ["q1", "Inspect the parser"],
    ["grok-queue-2", "Follow up without an id"],
  ]);
});

test("Grok queue mutation params use the native ACP spellings", () => {
  assert.equal(isGrokQueueChangedMethod("_x.ai/queue/changed"), true);
  assert.deepEqual(grokQueueRemoveParams("session-1", "q1"), { sessionId: "session-1", id: "q1" });
  assert.deepEqual(grokQueueEditParams("session-1", "q1", "Revised"), {
    sessionId: "session-1",
    id: "q1",
    newText: "Revised",
  });
});
