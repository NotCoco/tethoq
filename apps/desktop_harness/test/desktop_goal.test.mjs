import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-desktop-goal-${process.pid}-${Date.now()}`);
const bridgeBundle = join(outputDirectory, "bridge.mjs");
await mkdir(outputDirectory, { recursive: true });

const calls = [];
let storedGoal = null;
let goalRevision = 0;
globalThis.window = {
  tethoqDesktop: {
    request: async (type, payload = {}) => {
      calls.push({ type, payload });
      if (type === "session.goal.get") return { ok: true, payload: { goal: storedGoal } };
      if (type === "session.goal.set") {
        storedGoal = {
          sessionId: payload.sessionId,
          objective: payload.objective ?? storedGoal?.objective ?? "Keep working toward the task",
          status: payload.status ?? storedGoal?.status ?? "active",
          source: "tethoq",
          tokenBudget: payload.tokenBudget ?? storedGoal?.tokenBudget ?? null,
          tokensUsed: storedGoal?.tokensUsed ?? 0,
          timeUsedSeconds: storedGoal?.timeUsedSeconds ?? 0,
          createdAt: storedGoal?.createdAt ?? "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-23T00:01:00.000Z",
          revision: ++goalRevision,
        };
        return { ok: true, payload: { goal: storedGoal } };
      }
      if (type === "session.goal.clear") {
        const cleared = storedGoal !== null;
        storedGoal = null;
        return { ok: true, payload: { cleared, revision: cleared ? ++goalRevision : goalRevision } };
      }
      throw new Error(`Unexpected request: ${type}`);
    },
  },
};

await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "bridge.ts")],
  outfile: bridgeBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: { "@shared": join(appRoot, "src", "shared") },
});
const bridge = await import(`file:///${bridgeBundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("goal bridge reads, writes, and clears through non-turn RPCs", async () => {
  calls.length = 0;
  storedGoal = null;
  goalRevision = 0;

  assert.equal(await bridge.loadSessionGoal("goal-session"), null);
  const started = await bridge.setSessionGoal("goal-session", {
    objective: "Ship the renderer safely",
    status: "active",
    tokenBudget: 12_000,
  });
  assert.equal(started.objective, "Ship the renderer safely");
  assert.equal(started.tokenBudget, 12_000);
  assert.equal((await bridge.loadSessionGoal("goal-session"))?.revision, 1);
  await bridge.setSessionGoal("goal-session", { objective: "Ship and verify the renderer", status: "paused", tokenBudget: null });
  assert.deepEqual(await bridge.clearSessionGoal("goal-session"), { cleared: true, revision: 3 });

  assert.deepEqual(calls, [
    { type: "session.goal.get", payload: { sessionId: "goal-session" } },
    { type: "session.goal.set", payload: { sessionId: "goal-session", objective: "Ship the renderer safely", status: "active", tokenBudget: 12_000 } },
    { type: "session.goal.get", payload: { sessionId: "goal-session" } },
    { type: "session.goal.set", payload: { sessionId: "goal-session", objective: "Ship and verify the renderer", status: "paused", tokenBudget: null } },
    { type: "session.goal.clear", payload: { sessionId: "goal-session" } },
  ]);
  assert.equal(calls.some(({ type }) => type === "session.send_message"), false);
});

test("goal bridge rejects malformed data instead of inventing a visible goal", () => {
  assert.equal(bridge.mapSessionGoal({ sessionId: "goal-session", objective: "", status: "active" }), null);
  assert.equal(bridge.mapSessionGoal({ sessionId: "goal-session", objective: "Goal", status: "unknown" }), null);
  assert.equal(bridge.mapSessionGoal({ sessionId: "goal-session", objective: "Goal", status: "active", source: "other", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z", revision: 1 }), null);
  assert.equal(bridge.mapSessionGoal({ sessionId: "goal-session", objective: "Goal", status: "active", source: "tethoq", tokenBudget: 0, tokensUsed: 0, timeUsedSeconds: 0, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z", revision: 1 }), null);
  assert.equal(bridge.mapSessionGoal({ sessionId: "goal-session", objective: "Goal", status: "active", source: "tethoq", tokenBudget: null, tokensUsed: -1, timeUsedSeconds: 0, createdAt: "invalid", updatedAt: "2026-08-23T00:00:00.000Z", revision: 1 }), null);
  const mapped = bridge.mapSessionGoal({
    sessionId: "goal-session",
    objective: "Goal",
    status: "budgetLimited",
    source: "native",
    tokenBudget: 10_000,
    tokensUsed: 123,
    timeUsedSeconds: 8,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:01:00.000Z",
    revision: 4,
  });
  assert.deepEqual(mapped, {
    sessionId: "goal-session",
    objective: "Goal",
    status: "budgetLimited",
    source: "native",
    tokenBudget: 10_000,
    tokensUsed: 123,
    timeUsedSeconds: 8,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:01:00.000Z",
    revision: 4,
  });
});

test("goal bridge rejects a valid goal returned for a different task", async () => {
  storedGoal = {
    sessionId: "other-session",
    objective: "Wrong task",
    status: "active",
    source: "tethoq",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:01:00.000Z",
    revision: 1,
  };
  await assert.rejects(bridge.loadSessionGoal("goal-session"), /invalid goal/);
});
