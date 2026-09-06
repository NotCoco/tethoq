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
const inlineWorkerStubPlugin = {
  name: "inline-worker-stub",
  setup(buildContext) {
    buildContext.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, namespace: "inline-worker-stub" }));
    buildContext.onLoad({ filter: /.*/, namespace: "inline-worker-stub" }, () => ({
      contents: "export default class InlineWorkerStub { addEventListener() {} postMessage() {} terminate() {} }",
      loader: "js",
    }));
  },
};
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "composer_helpers.ts")],
  outfile: helpersBundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  plugins: [inlineWorkerStubPlugin],
});
const helpers = await import(`file:///${helpersBundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("late latest-history pages cannot replace a newer live transcript", () => {
  assert.match(app, /const liveTimelineGenerationBySession = useRef\(new Map<string, number>\(\)\)/u);
  assert.match(app, /const timelineItems = batch\.events\.map[\s\S]*liveTimelineGenerationBySession\.current\.set\(sessionId,[\s\S]*setSnapshot/u);

  // The calm selected-task catch-up starts only after a quiet window, then
  // guards both transcript and paging metadata against a newer generation or
  // a stream that resumed while session/load was in flight.
  assert.match(app, /const refreshSelectedView[\s\S]*?const incrementallyObserved = await watchSession\(sessionId\)[\s\S]*?terminalSessionNeedsCanonicalHistory[\s\S]*?const needsCanonicalHistory = forcedPass \|\| !incrementallyObserved \|\| terminalRepair[\s\S]*?quietCatchUpDue\(selectedLastDelta\(sessionId\), Date\.now\(\), 2_000\)[\s\S]*?const generation = liveTimelineGenerationBySession\.current\.get\(sessionId\)[\s\S]*?loadTimelinePage\(sessionId, undefined, 40, true\)/u);
  assert.match(app, /const generationBounded = incrementallyObserved && !terminalRepair[\s\S]*?generationBounded && canonicalHistoryGenerationBySession\.current\.get\(sessionId\) === generation\) break[\s\S]*?generationBounded\) canonicalHistoryGenerationBySession\.current\.set\(sessionId, generation\)[\s\S]*?loadTimelinePage\(sessionId, undefined, 40, true\)/u);
  assert.match(app, /setSnapshot\(\(current\) => \{[\s\S]*?liveTimelineGenerationBySession\.current\.get\(sessionId\)[\s\S]*?!== generation[\s\S]*?quietCatchUpDue\(selectedLastDelta\(sessionId\), Date\.now\(\), 2_000\)[\s\S]*?reconcileTimelinePage/u);
  assert.match(app, /const refreshSelectedView[\s\S]*?loadTimelinePage\(sessionId, undefined, 40, true\)[\s\S]*?liveTimelineGenerationBySession\.current\.get\(sessionId\)[\s\S]*?!== generation[\s\S]*?applyOpenedSessionRefresh\(current\.sessions, page\.session\)/u);
  assert.match(app, /setTimelineWindows\(\(current\) => \{[\s\S]*?liveTimelineGenerationBySession\.current\.get\(sessionId\)[\s\S]*?!== generation[\s\S]*?quietCatchUpDue\(selectedLastDelta\(sessionId\), Date\.now\(\), 2_000\)[\s\S]*?retainedHistoryCursor/u);

  // A full refresh has a separate selected-page load and must apply the same
  // guard for non-incremental providers. Incrementally watched Codex tasks must
  // not reread their complete transcript during a catalogue refresh.
  assert.match(app, /const incrementallyObserved = selected[\s\S]*watchSession\(selected\)[\s\S]*const timelinePage = selected && !selectedIsScheduled && !incrementallyObserved[\s\S]*loadTimelinePage\(selected\)/u);
  assert.match(app, /const timelinePageGeneration = selected[\s\S]*!incrementallyObserved[\s\S]*loadTimelinePage\(selected\)[\s\S]*liveTimelineGenerationBySession\.current\.get\(selected\)[\s\S]*=== timelinePageGeneration[\s\S]*setTimelineWindows/u);
  assert.match(app, /setTimelineWindows\(\(current\) => \{[\s\S]*const existing = current\[selected\];[\s\S]*\{ \.\.\.existing, nextCursor: retainedHistoryCursor\(existing\.nextCursor, timelinePage\.nextCursor\) \}[\s\S]*initialTimelineWindow\(timelinePage\.items, timelinePage\.nextCursor\)/u);
  assert.match(app, /const resolvedRevealStart = timelineWindow && presentationTimeline[\s\S]*anchoredTimelineRevealStart\(presentationTimeline, timelineWindow\.revealStart, timelineWindow\.revealAnchorKey\)/u);

  // Visibility replay-gap recovery also fetches a canonical latest page.
  assert.match(app, /if \(replay\.replayGap === true && selected\)[\s\S]*const generation = liveTimelineGenerationBySession\.current\.get\(selected\)[\s\S]*loadTimelinePage\(selected\)[\s\S]*=== generation/u);
  assert.match(app, /if \(replay\.replayGap === true && selected\)[\s\S]*setTimelineWindows\(\(current\) => \{[\s\S]*const existing = current\[selected\];[\s\S]*\{ \.\.\.existing, nextCursor: retainedHistoryCursor\(existing\.nextCursor, page\.nextCursor\) \}/u);
});

test("a visible Codex attachment completion forces canonical history immediately", () => {
  const expression = /export function eventRequiresCanonicalTranscriptRefresh\([^)]*\): boolean \{\s*return ([^;]+);/u.exec(app)?.[1];
  assert.ok(expression);
  const requiresRefresh = Function("event", `return ${expression};`);

  assert.equal(requiresRefresh({ type: "message.completed", payload: { requiresHistoryRefresh: true } }), true);
  assert.equal(requiresRefresh({ type: "message.completed", payload: { requiresHistoryRefresh: false } }), false);
  assert.equal(requiresRefresh({ type: "message.delta", payload: { requiresHistoryRefresh: true } }), false);

  assert.match(app, /const canonicalTranscriptRefreshSessionIds = new Set\(batch\.events\.flatMap\(\(event\) =>[\s\S]*visibleTimelineSessionIds\.has\(event\.sessionId\)[\s\S]*eventRequiresCanonicalTranscriptRefresh\(event\)/u);
  assert.match(app, /for \(const sessionId of canonicalTranscriptRefreshSessionIds\)[\s\S]*refreshSelectedView\(sessionId, true\)/u);
});

test("initial task loads and older-page prepends retain independent history", () => {
  // Opening a task reconciles the page against whatever live rows now exist;
  // it does not discard all prior history merely because the tail advanced.
  assert.match(app, /const openSession[\s\S]*loadTimelinePage\(sessionId\)[\s\S]*reconcileTimelinePage\(page\.items, current\.timelines\[sessionId\] \?\? \[\]\)/u);
  // Loading an older cursor is independent of the live tail and remains usable
  // while a response streams at the bottom.
  assert.match(app, /let cursor: string \| null = windowState\.nextCursor[\s\S]*loadTimelinePage\(sessionId, cursor, HISTORY_PAGE_LIMIT\)[\s\S]*prependTimelinePage\(current\.timelines\[sessionId\] \?\? \[\], loadedItems\)/u);
});

test("hidden tasks retain live state without accumulating invisible transcript rows", () => {
  assert.match(app, /const hiddenTimelineDirtySessionIds = useRef\(new Set<string>\(\)\)/u);
  assert.match(app, /event\.type === "session\.updated" \|\| event\.type === "session\.status_changed"\) && event\.payload\.state === "working"/u);
  assert.match(app, /const visibleTimelineSessionIds = visibleTimelineSessionIdsRef\.current;[\s\S]*?!visibleTimelineSessionIds\.has\(event\.sessionId\)[\s\S]*?hiddenTimelineDirtySessionIds\.current\.add\(event\.sessionId\)[\s\S]*?visibleTimelineSessionIds\.has\(event\.sessionId\)[\s\S]*?eventToTimelineItems\(event\)/u);
  assert.match(app, /const presentedOrganizedSessions[\s\S]*timeline === undefined \|\| hiddenTimelineDirtySessionIds\.current\.has\(session\.id\)[\s\S]*return session/u);
  assert.match(app, /const openSession[\s\S]*hiddenTimelineDirtySessionIds\.current\.has\(sessionId\)[\s\S]*reconcileHiddenTimeline\(sessionId\)/u);
  assert.match(app, /const openSideChatPanel[\s\S]*hiddenTimelineDirtySessionIds\.current\.has\(sessionId\)[\s\S]*reconcileHiddenTimeline\(sessionId\)/u);
  assert.match(app, /const reconcileHiddenTimeline[\s\S]*loadTimelinePage\(requestedSessionId, undefined, 40, true\)[\s\S]*hiddenTimelineDirtySessionIds\.current\.delete\(requestedSessionId\)[\s\S]*reconcileTimelinePage/u);
});

test("a hidden-history response is owned by its task, live generation, and newest request", () => {
  const expression = /export function hiddenTimelineRequestIsCurrent\([\s\S]*?\): boolean \{\s*return ([\s\S]*?);\s*\}/u.exec(app)?.[1];
  assert.ok(expression);
  const isCurrent = Function(
    "requestedSessionId",
    "loadedSessionId",
    "requestedLiveGeneration",
    "currentLiveGeneration",
    "requestedRequestGeneration",
    "currentRequestGeneration",
    `return ${expression};`,
  );

  assert.equal(isCurrent("task-a", "task-a", 7, 7, 3, 3), true);
  assert.equal(isCurrent("task-a", undefined, 7, 7, 3, 3), true, "older hosts may omit the page session");
  assert.equal(isCurrent("task-a", "task-b", 7, 7, 3, 3), false, "a response for another task is never applied");
  assert.equal(isCurrent("task-a", "task-a", 7, 8, 3, 3), false, "a live event invalidates the in-flight page");
  assert.equal(isCurrent("task-a", "task-a", 7, 7, 3, 4), false, "a newer read for the reopened task invalidates the older page");

  assert.match(app, /const hiddenTimelineRequestGenerationBySession = useRef\(new Map<string, number>\(\)\)/u);
  assert.match(app, /const reconcileHiddenTimeline[\s\S]*const requestedSessionId = sessionId[\s\S]*const liveGeneration = liveTimelineGenerationBySession\.current\.get\(requestedSessionId\)[\s\S]*const requestGeneration = \(hiddenTimelineRequestGenerationBySession\.current\.get\(requestedSessionId\)[\s\S]*const isCurrent = \(\) => hiddenTimelineRequestIsCurrent[\s\S]*if \(!isCurrent\(\)\) return[\s\S]*setSnapshot\(\(current\) => \{[\s\S]*!isCurrent\(\)[\s\S]*hiddenTimelineDirtySessionIds\.current\.delete\(requestedSessionId\)/u);
  assert.match(app, /const reconcileHiddenTimeline[\s\S]*loadTimelinePage\(requestedSessionId, undefined, 40, true\)[\s\S]*if \(!isCurrent\(\)\) return[\s\S]*applyOpenedSessionRefresh\(current\.sessions, page\.session\)/u);
  assert.match(app, /const invalidatedHiddenTimelineSessionIds = new Set<string>\(\)[\s\S]*hiddenTimelineDirtySessionIds\.current\.add\(event\.sessionId\)[\s\S]*invalidatedHiddenTimelineSessionIds\.add\(event\.sessionId\)[\s\S]*const advancedLiveSessions = new Set\(\[\.\.\.changedTimelines, \.\.\.liveTurnSessions, \.\.\.invalidatedHiddenTimelineSessionIds\]\)/u);
});

test("a failed context heartbeat preserves the last confirmed compaction state", () => {
  const failureBlock = /const poll = async \(\) => \{[\s\S]*?const context = await loadSessionContext\(session\.id\)[\s\S]*?\} catch \{([\s\S]*?)\n\s*\} finally/u.exec(app)?.[1];
  assert.ok(failureBlock);
  assert.match(failureBlock, /failures \+= 1/u);
  assert.doesNotMatch(failureBlock, /updateContextCompaction/u);
  assert.match(app, /const contextCompactionSessionKey = useRef<string \| null>\(null\)[\s\S]*const contextSessionKey = session && !session\.draft && !session\.schedule \? session\.id : null[\s\S]*if \(contextCompactionSessionKey\.current === contextSessionKey\) return[\s\S]*updateContextCompaction\(reportedCompaction\?\.isCompacting \?\? false, reportedCompaction\?\.kind \?\? null\)/u);
  assert.doesNotMatch(app, /updateContextCompaction\(false\);\s*void poll\(\)/u, "same-session state changes must not clear a last-known-good compaction before retry");
});

test("attention snapshots cannot erase newer request or resolution events", () => {
  const expression = /export function attentionResponseIsCurrent\([^)]*\): boolean \{\s*return ([^;]+);/u.exec(app)?.[1];
  assert.ok(expression);
  const isCurrent = Function("requestedRevision", "currentRevision", `return ${expression};`);
  assert.equal(isCurrent(4, 4), true);
  assert.equal(isCurrent(4, 5), false);

  assert.match(app, /const attentionRevision = useRef\(0\)/u);
  assert.match(app, /const attentionRevisionAtStart = attentionRevision\.current[\s\S]*attentionHydration[\s\S]*attentionResponseIsCurrent\(attentionRevisionAtStart, attentionRevision\.current\)/u);
  assert.match(app, /const attentionRevisionAtStart = attentionRevision\.current[\s\S]*refreshAttention\(\)[\s\S]*approvals: attentionResponseIsCurrent\(attentionRevisionAtStart, attentionRevision\.current\)/u);
  assert.match(app, /batch\.replayGap \|\| attentionChanged \|\| terminalChanged\) attentionRevision\.current \+= 1/u);
  assert.match(app, /const requestedAttentionRevision = attentionRevision\.current[\s\S]*refreshAttention\(\)[\s\S]*attentionResponseIsCurrent\(requestedAttentionRevision, attentionRevision\.current\)/u);
  assert.match(app, /event\.type === "user_input\.resolved"[\s\S]*next\.inputRequests = next\.inputRequests\.filter/u);
  assert.match(app, /const commitResumeBoundary = rejected \? null : prepareTurnResume\(\);[\s\S]*await request\("approval\.respond"[\s\S]*commitResumeBoundary\?\.\(\)/u);
  assert.match(app, /const commitResumeBoundary = prepareTurnResume\(\);[\s\S]*await request\("user_input\.respond"[\s\S]*commitResumeBoundary\(\)[\s\S]*onAttentionMutation\(\)[\s\S]*inputRequests: current\.inputRequests\.filter/u);
});

test("terminal state retires task controls immediately while transcript recovery stays independent", () => {
  assert.equal(helpers.shouldApplySessionState("completed", false), false);
  assert.equal(helpers.shouldApplySessionState("completed", true), true);

  assert.equal(helpers.terminalStateEventAction("idle", false, false), "apply");
  assert.equal(helpers.terminalStateEventAction("completed", false, false), "apply");
  assert.equal(helpers.terminalStateEventAction("completed", true, false), "apply");
  assert.equal(helpers.terminalStateEventAction("idle", false, true), "ignore");

  const previousFinal = [
    { id: "final-1", messageId: "message-1", kind: "assistant", phase: "final_answer", state: "completed" },
  ];
  const boundary = helpers.captureSessionWorkingBoundary(previousFinal);
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "working" }, previousFinal, boundary), true);
  assert.equal(helpers.sessionHoldsFollowUpQueue({ state: "completed" }, previousFinal, boundary), false, "Stop and queue retire at task completion");
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, previousFinal, boundary), true, "the delayed final is still recovered");
  const caughtUp = [...previousFinal, { id: "final-2", kind: "assistant", phase: "final_answer", state: "completed" }];
  assert.equal(helpers.sessionNeedsTranscriptCatchUp({ state: "completed" }, caughtUp, boundary), false, "the new visible final ends recovery");

  assert.doesNotMatch(app, /deferredSessionSettlement|deferSessionSettlementUntilQuiet/u);
  assert.match(app, /const terminalSessionStateActions = new Map<number, TerminalStateEventAction>\(\)[\s\S]*terminalStateEventAction\(state, false, hasLaterLiveEvent\)/u);
  assert.match(app, /\(event\.type === "session\.updated" \|\| event\.type === "session\.status_changed"\) && event\.payload\.state === "working"/u);
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
  // Provider completion is authoritative even for a genuinely empty answer;
  // it must not leave the task working forever.
  assert.doesNotMatch(app, /currentTurnHasProviderOutput/u);
});
