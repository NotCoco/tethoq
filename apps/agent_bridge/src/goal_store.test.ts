import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "./goal_store.js";

test("goal store persists only validated Tethoq-owned goals", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-goals-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "goals.json");
  const sessionId = "host/fake/session-one";
  const goal = {
    sessionId,
    objective: "Keep this goal after restart",
    status: "active" as const,
    source: "tethoq" as const,
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
    revision: 1,
  };
  const writer = new GoalStore(path);
  await writer.write({
    [sessionId]: goal,
    "host/codex/native": { ...goal, sessionId: "host/codex/native", source: "native" },
    "host/fake/fractional": { ...goal, sessionId: "host/fake/fractional", tokensUsed: 0.5 },
  });
  await writer.flush();
  const restored = await new GoalStore(path).read();
  assert.deepEqual(restored.goals, { [sessionId]: goal });
});
