import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-conversation-scroll-${process.pid}-${Date.now()}`);
await mkdir(outputDirectory, { recursive: true });
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

async function bundle(entry, name) {
  const outfile = join(outputDirectory, `${name}.mjs`);
  await build({
    entryPoints: [join(appRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    alias: { "@shared": join(appRoot, "src", "shared") },
  });
  return await import(`file:///${outfile.replaceAll("\\", "/")}`);
}

const source = async (relative) => await readFile(join(appRoot, relative), "utf8");
const scroll = await bundle("src/renderer/src/conversation_scroll.ts", "conversation-scroll");

const viewport = (scrollTop, scrollHeight, clientHeight = 800) => ({ scrollTop, scrollHeight, clientHeight });

test("distance from the end survives a prepend of any height", () => {
  const before = viewport(120, 4000);
  const anchor = scroll.distanceFromEnd(before);

  for (const added of [0, 24, 480, 5200, 41_000]) {
    const after = viewport(before.scrollTop, before.scrollHeight + added, before.clientHeight);
    // The reader was 3880px from the end; they must still be 3880px from the end,
    // which is the same content on the same line.
    assert.equal(scroll.distanceFromEnd({ ...after, scrollTop: scroll.anchoredScrollTop(after, anchor) }), anchor);
    assert.equal(scroll.anchoredScrollTop(after, anchor), 120 + added);
  }
});

test("anchoring never lands outside the scrollable range", () => {
  const shrunk = viewport(0, 900, 800);
  assert.equal(scroll.anchoredScrollTop(shrunk, 5000), 0);
  assert.equal(scroll.anchoredScrollTop(shrunk, 0), 100);
  assert.equal(scroll.clampScrollTop(shrunk, -40), 0);
  assert.equal(scroll.clampScrollTop(shrunk, 99_999), 100);
  // A viewport taller than its content has nowhere to scroll at all.
  assert.equal(scroll.maxScrollTop(viewport(0, 400, 800)), 0);
});

test("a stale height delta is what makes the view teleport, and is no longer used", async () => {
  const previousHeight = 4000;
  const previousTop = 120;
  const after = viewport(previousTop, previousHeight + 5200);

  // The replaced approach measured the growth after the fact. Read a frame early --
  // before the page commits -- it corrects by nothing and the viewport slides down
  // by the full height of the page that lands next.
  const staleDelta = Math.max(0, previousHeight - previousHeight);
  assert.equal(previousTop + staleDelta, previousTop);
  assert.equal(scroll.distanceFromEnd({ ...after, scrollTop: previousTop + staleDelta }), 9080);

  // Anchoring reads only the current height, so there is no frame at which it is wrong.
  assert.equal(scroll.anchoredScrollTop(after, 3880), 5320);

  const app = await source(join("src", "renderer", "src", "App.tsx"));
  assert.doesNotMatch(app, /scrollHeight - previousHeight/);
});

test("following the tail tolerates the trailing gap without ignoring a real scroll away", () => {
  assert.equal(scroll.isAtBottom(viewport(3200, 4000)), true);
  assert.equal(scroll.isAtBottom(viewport(3140, 4000)), true);
  assert.equal(scroll.isAtBottom(viewport(3128, 4000)), false);
  assert.equal(scroll.isAtBottom(viewport(0, 4000)), false);
  assert.equal(scroll.isAtPhysicalBottom(viewport(3200, 4000)), true);
  assert.equal(scroll.isAtPhysicalBottom(viewport(3199, 4000)), true);
  assert.equal(scroll.isAtPhysicalBottom(viewport(3198, 4000)), false);
  assert.equal(scroll.isAtPhysicalBottom(viewport(3140, 4000)), false);
});

test("older history is requested before the reader reaches the ceiling", () => {
  assert.equal(scroll.shouldRequestOlder(viewport(0, 4000)), true);
  assert.equal(scroll.shouldRequestOlder(viewport(239, 4000)), true);
  assert.equal(scroll.shouldRequestOlder(viewport(240, 4000)), false);
  assert.equal(scroll.shouldRequestOlder(viewport(3200, 4000)), false);
  // The old 48px trigger only fired once the reader had already hit the top.
  assert.ok(scroll.HISTORY_PREFETCH_PX > 48);
});

test("history refreshes retain the furthest cursor and rebase impossible exhaustion", () => {
  assert.equal(scroll.retainedHistoryCursor("46", "83"), "46");
  assert.equal(scroll.retainedHistoryCursor("83", "46"), "46");
  assert.equal(scroll.retainedHistoryCursor(null, "83"), null);
  assert.equal(scroll.retainedHistoryCursor("46", null), "46");
  assert.equal(scroll.retainedHistoryCursor("provider-page:old:codex-rollout-byte%3A100", "provider-page:new:codex-rollout-byte%3A200"), "provider-page:new:codex-rollout-byte%3A200");
  assert.equal(scroll.retainedHistoryCursor("message:old", "message:new"), "message:old");
  assert.equal(scroll.historyPageNeedsRebase("86", null), true);
  assert.equal(scroll.historyPageNeedsRebase("40", null), false);
  assert.equal(scroll.historyPageNeedsRebase("86", "46"), false);
  assert.equal(scroll.isHistoryPageExpired(new Error("Message history page expired; reopen the session")), true);
  assert.equal(scroll.isHistoryPageExpired(new Error("network unavailable")), false);
});

test("the conversation owns one scroll writer and holds its anchor across the load", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  // The anchor is taken before the load and re-applied on every commit it spans, so
  // the spinner arriving on its own commit cannot consume it ahead of the page.
  assert.match(app, /historyAnchor\.current = distanceFromEnd\(element\)/);
  assert.match(app, /anchoredSignature\.current !== timelineSignature[\s\S]*restoreReaderAnchor\(true\)/);
  assert.match(app, /applyScrollTop\(element, anchoredScrollTop\(element, historyAnchor\.current\)\)/);
  assert.match(app, /if \(anchoredSignature\.current !== timelineSignature && !loadingOlder\) releaseHistoryAnchor\(\)/);

  // The guard outlives the promise: releasing it when the promise settled let a
  // single flick to the top burn through several pages before any of them rendered.
  assert.match(app, /loadingOlderRef\.current = true;[\s\S]*?scrollMode\.current\.anchor === null \|\| readerHasCurrentScrollIntent\(\)\) captureReaderAnchor\(\);\s*\n\s*anchoredSignature\.current = signature\.current/);
  assert.match(app, /const releaseHistoryAnchor = useCallback\(\(\) => \{[\s\S]*?loadingOlderRef\.current = false;/);
  assert.doesNotMatch(app, /finally \{\s*\n\s*loadingOlderRef\.current = false;\s*\n\s*\}/);

  // Scrolling during an in-flight load re-bases the anchor rather than fighting it.
  assert.match(app, /if \(historyAnchor\.current !== null && readerInitiated\) historyAnchor\.current = distanceFromEnd\(element\)/);

  // Opaque provider cursors can expire after a newest-page refresh. The older
  // history load must rebase once and retry internally rather than strand the
  // reader at the ceiling.
  assert.match(app, /isHistoryPageExpired\(error\)[\s\S]*?loadTimelinePage\(sessionId, undefined, HISTORY_PAGE_LIMIT, true\)[\s\S]*?rebased = true[\s\S]*?continue;/);

  // Reading the wheel directly is the only un-pin signal that survives a streaming
  // reply, where following the tail writes the scroll offset every frame.
  assert.match(app, /onWheel=\{\(event\) => \{[\s\S]*?if \(event\.deltaY < 0 && scrollMode\.current\.kind === "follow_tail"\) setScrollMode\(\{ kind: "preserve_view", anchor: null \}\)/);
  assert.match(app, /const echoed = writtenScrollTop\.current !== null && Math\.abs\(element\.scrollTop - writtenScrollTop\.current\) <= 1/);
  assert.match(app, /const readerInitiated = !echoed && \(readerHasCurrentScrollIntent\(\) \|\| scrollbarHeld\.current\)/);
  assert.doesNotMatch(app, /geometryStable/);
  assert.match(app, /if \(!echoed && !readerInitiated\) \{[\s\S]*?historyAnchor\.current !== null[\s\S]*?anchoredScrollTop[\s\S]*?follow_tail[\s\S]*?restoreReaderAnchor\(\);[\s\S]*?return;/);
  assert.match(app, /const readerAboveEnd = readerInitiated && !isAtPhysicalBottom\(element\)/);
  assert.match(app, /if \(readerAboveEnd \|\| steppedOffEnd\) \{[\s\S]*setScrollMode\(\{ kind: "preserve_view", anchor \}\)/);
  assert.match(app, /else if \(returnedToEnd\) \{[\s\S]*setScrollMode\(followTailScrollMode\)/);
  assert.match(app, /const timelineChanged = signature\.current !== timelineSignature;\s*\n\s*signature\.current = timelineSignature;\s*\n\s*if \(scrollMode\.current\.kind === "follow_tail"\) followTail\(\);[\s\S]*?else if \(timelineChanged\) restoreReaderAnchor\(\);\s*\n\s*\}, \[applyScrollTop, followTail/);

  // Only transcript/session commits run the layout scroll writer. Unrelated
  // workspace state (such as a context heartbeat) must not touch scrollTop.
  assert.match(app, /\}, \[applyScrollTop, followTail, loadingOlder, releaseHistoryAnchor, restoreReaderAnchor, scheduleSessionAnchorRestore, scrollToLatest, session\.id, timelineSignature\]\);/);

  // A delayed destination timeline gets one non-forced restore after its rows
  // actually commit; unrelated workspace renders still never touch scrollTop.
  assert.match(app, /else if \(timelineChanged\) restoreReaderAnchor\(\)/);

  // Resize is the only generic passive path that may need an anchor correction.
  assert.match(app, /if \(historyAnchor\.current !== null\) return;\s*\n\s*if \(scrollMode\.current\.kind === "follow_tail"\) followTail\(\);\s*\n\s*else restoreReaderAnchor\(\)/);
  assert.match(app, /const shouldFollow = historyAnchor\.current === null && scrollMode\.current\.kind === "follow_tail"/);
  assert.match(app, /type ConversationScrollMode =[\s\S]*kind: "follow_tail"[\s\S]*kind: "preserve_view"; readonly anchor: ConversationReaderAnchor \| null/);
  assert.match(app, /const sessionScrollModes = useRef\(new Map<string, ConversationScrollMode>\(\)\)/);
});

test("leaving the end un-follows, and the follow gap only decides arriving back", () => {
  // The gesture that carries the reader away starts inside the follow gap. Asking
  // "are they near the bottom" first answered yes for those frames, re-pinned them
  // mid-scroll, and the next streamed commit wrote them straight back to the tail.
  const away = viewport(3180, 4000);
  assert.equal(scroll.isAtBottom(away), true);
  assert.equal(scroll.movedOffEnd(away, 3200), true);

  // Every step of the way off the end keeps reading as the reader's own movement.
  for (const top of [3190, 3100, 2400, 0]) {
    assert.equal(scroll.movedOffEnd(viewport(top, 4000), top + 10), true);
  }

  // Sitting on the end is never leaving it, whichever way the offset was reached.
  assert.equal(scroll.movedOffEnd(viewport(3200, 4000), 3200), false);
  assert.equal(scroll.movedOffEnd(viewport(3200, 4000), 3400), false);
  // A settling turn drops rows and the browser clamps the offset down with them.
  // The reader never moved and is still on the end, so following must survive it.
  assert.equal(scroll.movedOffEnd(viewport(1200, 2000), 3200), false);
  // Content shorter than the viewport has no end to step off.
  assert.equal(scroll.movedOffEnd(viewport(0, 400), 0), false);

  // Scrolling back down is not a step away; the gap alone re-attaches the reader.
  assert.equal(scroll.movedOffEnd(viewport(3000, 4000), 2400), false);
  assert.equal(scroll.isAtBottom(viewport(3000, 4000)), false);
  assert.equal(scroll.isAtBottom(viewport(3140, 4000)), true);
});

test("submission resamples physical-bottom consent before the composer collapses", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));
  const composer = await source(join("src", "renderer", "src", "Composer.tsx"));

  assert.match(app, /interface ConversationHandle \{\s*prepareForSubmission: \(\) => void;/);
  assert.match(app, /const prepareForSubmission = useCallback\(\(\) => \{[\s\S]*?if \(isAtPhysicalBottom\(element\)\) \{[\s\S]*?releaseHistoryAnchor\(\);[\s\S]*?scrollToLatest\(\);[\s\S]*?setScrollMode\(\{ kind: "preserve_view", anchor: null \}\);[\s\S]*?captureReaderAnchor\(\);/);
  assert.match(app, /<Conversation ref=\{conversationHandle\}/);
  assert.match(app, /onBeforeSubmit=\{\(\) => \{\s*onStopPresentation\(session\.id, false\);\s*conversationHandle\.current\?\.prepareForSubmission\(\);\s*\}\}/);
  assert.match(app, /timelinePresentationSignature\(timeline\)/);
  assert.match(composer, /const deliveryToken = beginComposerDelivery\(session\.id\);\s*\n\s*if \(deliveryToken === null\) return;\s*\n[\s\S]*?onBeforeSubmit\?\.\(\);[\s\S]*?commitContent\(""\);\s*\n\s*commitAttachments\(\[\]\);/);
});

test("only the reader can re-enable bottom follow", () => {
  // A completed reasoning span can collapse thousands of pixels above the reader.
  // The browser clamps scrollTop as a consequence, but that passive move must not
  // count as the reader returning to the end.
  assert.equal(scroll.readerReturnedToEnd(viewport(1200, 2000), 3200, false), false);
  assert.equal(scroll.readerReturnedToEnd(viewport(3200, 4000), 3000, false), false);
  assert.equal(scroll.readerReturnedToEnd(viewport(3140, 4000), 3140, true), false);

  // The wider display gap is not consent to finish moving the thumb. Only the
  // physical end deliberately restores live follow.
  assert.equal(scroll.readerReturnedToEnd(viewport(3140, 4000), 3000, true), false);
  assert.equal(scroll.readerReturnedToEnd(viewport(3199, 4000), 3000, true), true);
  assert.equal(scroll.readerReturnedToEnd(viewport(3200, 4000), 3000, true), true);
  assert.equal(scroll.readerReturnedToEnd(viewport(3000, 4000), 2400, true), false);
});

test("Reasoning anchors survive canonical replacement, history reveal, and row folding", () => {
  const liveGroup = {
    id: "reasoning:part:thought-7:0",
    memberToken: scroll.firstScrollMemberToken(`${encodeURIComponent("live-thought-row")}|${encodeURIComponent("live-tool-row")}`),
  };

  // Canonical history can replace every concrete row id while retaining the
  // semantic Reasoning key.
  assert.equal(scroll.scrollAnchorMatches(
    liveGroup,
    "reasoning:part:thought-7:0",
    encodeURIComponent("canonical-thought-row"),
  ), true);

  // Revealing an earlier raw slice can give the same group a different primary
  // key. Its previously visible member remains, so the saved viewport still has
  // an unambiguous fallback target.
  assert.equal(scroll.scrollAnchorMatches(
    liveGroup,
    "reasoning:activity:tool:older-call:0",
    `${encodeURIComponent("older-tool-row")}|${encodeURIComponent("live-thought-row")}|${encodeURIComponent("live-tool-row")}`,
  ), true);

  // A standalone row that later folds into Reasoning continues to use the
  // original raw-id fallback even though it had no group member token to save.
  assert.equal(scroll.scrollAnchorMatches(
    { id: "commentary-row" },
    "reasoning:part:thought-8:0",
    `${encodeURIComponent("commentary-row")}|${encodeURIComponent("thought-row")}`,
  ), true);
  assert.equal(scroll.scrollAnchorMatches(
    liveGroup,
    "reasoning:part:unrelated:0",
    encodeURIComponent("unrelated-row"),
  ), false);
});

test("native scrollbar movement owns its resting position", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  assert.match(app, /if \(!element \|\| !anchor \|\| \(!force && \(readerHasCurrentScrollIntent\(\) \|\| scrollbarHeld\.current\)\)\) \{/);
  assert.match(app, /if \(readerInitiated\) markReaderScrollIntent\(\)/);
  assert.match(app, /if \(readerInitiated && scrollMode\.current\.kind === "preserve_view"\) captureReaderAnchor\(\)/);
  assert.doesNotMatch(app, /if \(!echoed && scrollMode\.current\.kind === "preserve_view"\) captureReaderAnchor\(\)/);
  assert.match(app, /const scrollbarHeld = useRef\(false\)/);
  assert.match(app, /const pressScrollbar = \(event: PointerEvent\) => \{[\s\S]*?event\.target !== element[\s\S]*?scrollbarStart = bounds\.left \+ element\.clientLeft \+ element\.clientWidth[\s\S]*?pointerHeld\.current = true;[\s\S]*?scrollbarHeld\.current = true;[\s\S]*?markReaderScrollIntent\(\)/);
  assert.match(app, /const release = \(\) => \{\s*scrollbarHeld\.current = false;[\s\S]*?pointerHeld\.current = false;/);
  assert.match(app, /window\.addEventListener\("pointerdown", pressScrollbar, true\)[\s\S]*?window\.removeEventListener\("pointerdown", pressScrollbar, true\)/);
  assert.match(app, /const markReaderScrollIntent = useCallback\(\(\) => \{[\s\S]*?writtenScrollTop\.current = null;[\s\S]*?readerScrollIntent\.current =/);
  assert.match(app, /\["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "\]\.includes\(event\.key\)[\s\S]*?markReaderScrollIntent\(\)/);
  assert.match(app, /const memberToken = firstScrollMemberToken\(anchor\.dataset\.scrollMembers\)/);
  assert.match(app, /scrollAnchorMatches\(anchor, candidate\.dataset\.scrollAnchor, candidate\.dataset\.scrollMembers\)/);
  assert.match(app, /const foldedIntoGroup = target\.dataset\.scrollAnchor !== anchor\.id[\s\S]*desiredOffset = foldedIntoGroup && anchor\.offset < 0/);
});

test("a press inside the transcript holds the offset until the reader releases", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  // Following the tail between a press and its release slides the pressed row out
  // from under the pointer. A release over different content is not a click at
  // all, so the disclosure the reader aimed at never opens.
  assert.match(app, /const followTail = useCallback\(\(\) => \{[\s\S]*?pointerHeld\.current\) return;[\s\S]*?scrollToLatest\(\)/);
  assert.match(app, /onPointerDown=\{\(event\) => \{[\s\S]*?if \(event\.button === 0\) \{\s*\n\s*pointerHeld\.current = true;/);
  assert.match(app, /pointerHeld\.current = false;[\s\S]{0,100}pointerOrigin\.current = null;[\s\S]{0,100}followTail\(\)/);

  // A press whose release the window never sees must not strand the tail: a right
  // press opens a menu instead of reporting one, and a window that loses focus
  // mid-press reports one nowhere at all.
  assert.match(app, /window\.addEventListener\("pointerup", release\);[\s\S]{0,200}window\.addEventListener\("pointermove", move\);[\s\S]{0,100}window\.addEventListener\("blur", release\)/);
  assert.match(app, /window\.removeEventListener\("blur", release\)/);

  // Switching tasks restores the destination task's own atomic scroll policy.
  assert.match(app, /activeSession\.current = session\.id;[\s\S]*?readerScrollIntent\.current = null;[\s\S]*?writtenScrollTop\.current = null;[\s\S]*?lastScrollTop\.current = element\.scrollTop;[\s\S]*?sessionScrollModes\.current\.get\(session\.id\) \?\? followTailScrollMode[\s\S]*?restoreReaderAnchor\(true\);[\s\S]*?scheduleSessionAnchorRestore\(session\.id\)/);

  // The destination rows can land one paint after the task itself changes. A
  // bounded frame retry closes that race without introducing polling or relaxing
  // the saved offset. It survives an early successful restore, but stops as soon
  // as the task changes or the destination reader genuinely moves.
  assert.match(app, /const SESSION_ANCHOR_RESTORE_FRAMES = 3/);
  assert.match(app, /const scheduleSessionAnchorRestore = useCallback\(\(sessionId: string\) => \{[\s\S]*?attemptsRemaining = SESSION_ANCHOR_RESTORE_FRAMES[\s\S]*?activeSession\.current !== sessionId[\s\S]*?readerHasCurrentScrollIntent\(\)[\s\S]*?restoreReaderAnchor\(\);[\s\S]*?attemptsRemaining -= 1[\s\S]*?requestAnimationFrame\(attempt\)/);
  assert.doesNotMatch(app, /scheduleSessionAnchorRestore[\s\S]{0,600}restoreReaderAnchor\(true\)/);
  assert.match(app, /if \(sessionRestoreFrame\.current !== undefined\) window\.cancelAnimationFrame\(sessionRestoreFrame\.current\)/);
});

test("the earlier-history row keeps its space so revealing it cannot shift the reader", async () => {
  const [app, styles] = await Promise.all([
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
  ]);

  // Mounting and unmounting a 24px row above the reader moved everything under it.
  assert.match(app, /\{olderAvailable \|\| loadingOlder \? <div className="history-loading" data-busy=/);
  assert.match(styles, /\.history-loading \{[^}]*height: 24px[^}]*opacity: 0/);
  assert.match(styles, /\.history-loading\[data-busy="true"\] \{ opacity: 1; \}/);

  // Our own anchoring replaces the browser's, so its scroll anchoring stays off.
  assert.match(styles, /\.conversation-scroll \{[^}]*overflow-anchor: none[^}]*overscroll-behavior: contain/);
});
