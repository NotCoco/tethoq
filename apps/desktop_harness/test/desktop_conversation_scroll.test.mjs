import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
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
