import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
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
const source = async (path) => await readFile(join(appRoot, path), "utf8");
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

test("goal lives in the command and overflow flow without permanent header UI", async () => {
  const [app, composer, styles, composerStyles] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "Composer.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  const goal = composer.match(/function GoalSettingsPanel[\s\S]*?(?=\nfunction EarsSettingsPanel)/u)?.[0] ?? "";

  assert.doesNotMatch(app, /<GoalControl/u);
  assert.doesNotMatch(styles, /\.goal-trigger/u);
  assert.match(app, /goal=\{snapshot\.goals\[session\.id\] \?\? null\}/u);
  assert.ok(composer.includes('if (draftSession || !hasSlashCommandToken(content, "/goal")) return;'));
  assert.ok(composer.includes('const next = removeSlashCommandToken(content, "/goal");'));
  assert.match(composer, /<strong>Goal<\/strong>/u);
  assert.match(composer, /setGoalOpen\(true\)/u);
  assert.match(app, /function reconcileGoalResult[\s\S]*?goal\.revision < currentGoal\.revision/u);
  assert.match(app, /clearRevision < currentGoal\.revision/u);
  assert.match(app, /currentGoal\.revision > expectedRevision/u);
  assert.match(goal, /className="goal-popover composer-goal-panel" role="dialog" aria-modal="false" aria-label="Task goal"/u);
  assert.match(goal, /<label><span>Objective<\/span><textarea/u);
  assert.match(goal, /advisoryBudget \? "Token target" : "Token budget"/u);
  assert.match(goal, /advisoryBudget \? "advisory" : "optional"/u);
  assert.match(goal, /goal\.source === "tethoq" \? "Advisory target" : "Budget"/u);
  assert.match(goal, /maxLength=\{4000\}/u);
  assert.match(goal, /goal \? "Save" : "Start goal"/u);
  assert.match(goal, /goal\.status === "active".*?Pause/u);
  assert.match(goal, /goal\.status === "complete" \? "Reopen" : "Resume"/u);
  assert.match(goal, /goal\.status !== "blocked".*?Mark stalled/u);
  assert.match(goal, /goal\.status !== "complete".*?Complete/u);
  assert.match(goal, /className="button button-danger"[^>]*onClick=\{\(\) => void clear\(\)\}/u);
  assert.match(goal, /const result = await clearSessionGoal\(session\.id\);[\s\S]*?const superseded = latestGoal\.current !== null && latestGoal\.current\.revision > result\.revision;[\s\S]*?if \(result\.cleared && !superseded\) onGoal\(null, result\.revision\);[\s\S]*?onClose\(\);/u);
  assert.match(styles, /\.goal-popover > header button[^\n]*width: 30px; height: 30px/iu);
  assert.match(composerStyles, /\.goal-popover\.composer-goal-panel[\s\S]*?position: static;[\s\S]*?max-height:/u);
});

test("goal panel restores composer focus and dismisses on keyboard or outside interaction", async () => {
  const composer = await source(join("src", "renderer", "src", "Composer.tsx"));
  const goal = composer.match(/function GoalSettingsPanel[\s\S]*?(?=\nfunction EarsSettingsPanel)/u)?.[0] ?? "";
  assert.match(goal, /requestAnimationFrame\(\(\) => objectiveInput\.current\?\.focus\(\)\)/u);
  assert.match(goal, /const outside = \(event: PointerEvent\) => \{ if \(!panelRef\.current\?\.contains\(event\.target as Node\)\) onClose\(\); \}/u);
  assert.match(goal, /event\.key === "Escape"/u);
  assert.match(goal, /window\.addEventListener\("pointerdown", outside\)/u);
  assert.match(goal, /window\.addEventListener\("keydown", escape\)/u);
  assert.match(goal, /window\.removeEventListener\("pointerdown", outside\)/u);
  assert.match(goal, /window\.removeEventListener\("keydown", escape\)/u);
  assert.match(composer, /const closeGoal = useCallback[\s\S]*?requestAnimationFrame\(\(\) => textarea\.current\?\.focus\(\)\)/u);
  assert.match(goal, /event\.key === "Enter" && !event\.shiftKey && !event\.nativeEvent\.isComposing/u);
  assert.match(goal, /event\.currentTarget\.form\?\.requestSubmit\(\)/u);
  assert.match(goal, /if \(await mutate\([\s\S]*?\) onClose\(\);/u);
  assert.match(goal, /catch \(error\) \{ notify\([\s\S]*?"error"\); return false; \}/u);
});

test("goal updates and clears ignore stale lifecycle events and stay inside the composer viewport", async () => {
  const [app, styles] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "composer.css")),
  ]);
  assert.match(app, /if \(event\.type === "session\.goal_updated"\) \{[\s\S]*?const clearedThrough = next\.goalClearRevisions\[event\.sessionId\] \?\? -1;[\s\S]*?goal\.revision > clearedThrough[\s\S]*?next\.goals\[event\.sessionId\] = goal;[\s\S]*?continue;/u);
  assert.match(app, /if \(event\.type === "session\.goal_cleared"\) \{[\s\S]*?if \(typeof revision !== "number" \|\| !Number\.isSafeInteger\(revision\) \|\| revision < 0\) continue;[\s\S]*?delete next\.goals\[event\.sessionId\];[\s\S]*?next\.goalClearRevisions\[event\.sessionId\] = Math\.max[\s\S]*?continue;/u);
  assert.match(styles, /\.goal-popover\.composer-goal-panel \{[\s\S]*?width: auto;[\s\S]*?max-height: min\(520px, calc\(100vh - 180px\)\);[\s\S]*?overflow: auto;/u);
});
