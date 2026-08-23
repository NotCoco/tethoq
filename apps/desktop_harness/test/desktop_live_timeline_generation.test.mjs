import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const app = await readFile(join(appRoot, "src", "renderer", "src", "App.tsx"), "utf8");
const outputDirectory = join(tmpdir(), `tethoq-live-timeline-generation-${process.pid}-${Date.now()}`);
const helpersBundle = join(outputDirectory, "composer_helpers.mjs");
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "composer_helpers.ts")],
  outfile: helpersBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
const helpers = await import(`file:///${helpersBundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("late latest-history pages cannot replace a newer live transcript", () => {
  assert.match(app, /const liveTimelineGenerationBySession = useRef\(new Map<string, number>\(\)\)/u);
  assert.match(app, /const timelineItems = batch\.events\.map[\s\S]*liveTimelineGenerationBySession\.current\.set\(sessionId,[\s\S]*setSnapshot/u);

  // The calm selected-task catch-up starts only after a quiet window, then
  // guards both transcript and paging metadata against a newer generation or
  // a stream that resumed while session/load was in flight.
  assert.match(app, /const refreshSelectedView[\s\S]*?quietCatchUpDue\(selectedLastDelta\(sessionId\), Date\.now\(\), 2_000\)[\s\S]*?const generation = liveTimelineGenerationBySession\.current\.get\(sessionId\)[\s\S]*?loadSessionTimelinePage\(sessionId, undefined, 40, true\)/u);
  assert.match(app, /setSnapshot\(\(current\) => \{[\s\S]*?liveTimelineGenerationBySession\.current\.get\(sessionId\)[\s\S]*?!== generation[\s\S]*?quietCatchUpDue\(selectedLastDelta\(sessionId\), Date\.now\(\), 2_000\)[\s\S]*?reconcileTimelinePage/u);
  assert.match(app, /setTimelineWindows\(\(current\) => \{[\s\S]*?liveTimelineGenerationBySession\.current\.get\(sessionId\)[\s\S]*?!== generation[\s\S]*?quietCatchUpDue\(selectedLastDelta\(sessionId\), Date\.now\(\), 2_000\)[\s\S]*?retainedHistoryCursor/u);

  // A full refresh has a separate selected-page load and must apply the same
  // guard; otherwise a refresh triggered by turn completion can race its tail.
  assert.match(app, /const timelinePageGeneration = selected[\s\S]*loadSessionTimelinePage\(selected\)[\s\S]*liveTimelineGenerationBySession\.current\.get\(selected\)[\s\S]*=== timelinePageGeneration[\s\S]*setTimelineWindows/u);
  assert.match(app, /setTimelineWindows\(\(current\) => \{[\s\S]*const existing = current\[selected\];[\s\S]*\{ \.\.\.existing, nextCursor: retainedHistoryCursor\(existing\.nextCursor, timelinePage\.nextCursor\) \}[\s\S]*revealStart: initialTimelineRevealStart\(timelinePage\.items\)/u);

  // Visibility replay-gap recovery also fetches a canonical latest page.
  assert.match(app, /if \(replay\.replayGap === true && selected\)[\s\S]*const generation = liveTimelineGenerationBySession\.current\.get\(selected\)[\s\S]*loadSessionTimelinePage\(selected\)[\s\S]*=== generation/u);
  assert.match(app, /if \(replay\.replayGap === true && selected\)[\s\S]*setTimelineWindows\(\(current\) => \{[\s\S]*const existing = current\[selected\];[\s\S]*\{ \.\.\.existing, nextCursor: retainedHistoryCursor\(existing\.nextCursor, page\.nextCursor\) \}/u);
});

test("initial task loads and older-page prepends retain independent history", () => {
  // Opening a task reconciles the page against whatever live rows now exist;
  // it does not discard all prior history merely because the tail advanced.
  assert.match(app, /const openSession[\s\S]*loadSessionTimelinePage\(sessionId\)[\s\S]*reconcileTimelinePage\(page\.items, current\.timelines\[sessionId\] \?\? \[\]\)/u);
  // Loading an older cursor is independent of the live tail and remains usable
  // while a response streams at the bottom.
  assert.match(app, /loadSessionTimelinePage\(sessionId, windowState\.nextCursor, HISTORY_PAGE_LIMIT\)[\s\S]*prependTimelinePage\(current\.timelines\[sessionId\] \?\? \[\], page\.items\)/u);
});

test("native completion waits for quiet while the OpenCode runaway guard stays authoritative", () => {
  // The same state decision used by native completion rejects a completion next
  // to a live chunk and accepts it once the two-second quiet window has elapsed.
  assert.equal(helpers.shouldApplySessionState("completed", false), false);
  assert.equal(helpers.shouldApplySessionState("completed", true), true);

  // A rejected native completion is deferred, not dropped. A later live event
  // advances the generation and cancels it; an otherwise clean turn settles as
  // soon as the remaining quiet interval expires.
  assert.match(app, /const deferredAgentCompletionTimers = useRef\(new Map<string, number>\(\)\)/u);
  assert.match(app, /const deferAgentCompletionUntilQuiet[\s\S]*setTimeout\(settleWhenQuiet,[\s\S]*liveTimelineGenerationBySession\.current\.get\(sessionId\)[\s\S]*state: "completed"/u);
  assert.match(app, /authoritative \|\| shouldApplySessionState\("completed", quiet\)[\s\S]*deferAgentCompletionUntilQuiet/u);
  assert.match(app, /event\.type === "agent\.completed" && agentCompletionActions\.get\(eventIndex\) !== "apply"\) continue/u);

  // Raw native metadata is dropped before the renderer, so only an explicit
  // provider marker may identify the verified OpenCode runaway guard.
  assert.match(app, /event\.type === "agent\.completed" && event\.providerId === "opencode" && event\.payload\.completionReason === "runaway_guard"/u);
  assert.doesNotMatch(app, /event\.nativeEvent === undefined/u);
  const authorityExpression = /function isAuthoritativeOpenCodeGuardCompletion[\s\S]*?return ([^;]+);/u.exec(app)?.[1];
  assert.ok(authorityExpression);
  const isAuthoritative = Function("event", `return ${authorityExpression};`);
  assert.equal(isAuthoritative({ type: "agent.completed", providerId: "opencode", payload: {} }), false);
  assert.equal(isAuthoritative({ type: "agent.completed", providerId: "opencode", payload: {}, nativeEvent: undefined }), false);
  assert.equal(isAuthoritative({ type: "agent.completed", providerId: "opencode", payload: { completionReason: "runaway_guard" } }), true);
  assert.equal(isAuthoritative({ type: "agent.completed", providerId: "opencode", payload: { completionReason: "session_idle" } }), false);
  // After the quiet debounce, the provider's completion is authoritative even
  // for a genuinely empty answer; it must not leave the task working forever.
  assert.doesNotMatch(app, /currentTurnHasProviderOutput/u);
});
