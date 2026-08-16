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
});

test("older history is requested before the reader reaches the ceiling", () => {
  assert.equal(scroll.shouldRequestOlder(viewport(0, 4000)), true);
  assert.equal(scroll.shouldRequestOlder(viewport(239, 4000)), true);
  assert.equal(scroll.shouldRequestOlder(viewport(240, 4000)), false);
  assert.equal(scroll.shouldRequestOlder(viewport(3200, 4000)), false);
  // The old 48px trigger only fired once the reader had already hit the top.
  assert.ok(scroll.HISTORY_PREFETCH_PX > 48);
});

test("the conversation owns one scroll writer and holds its anchor across the load", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));

  // The anchor is taken before the load and re-applied on every commit it spans, so
  // the spinner arriving on its own commit cannot consume it ahead of the page.
  assert.match(app, /historyAnchor\.current = distanceFromEnd\(element\)/);
  assert.match(app, /applyScrollTop\(element, anchoredScrollTop\(element, historyAnchor\.current\)\)/);
  assert.match(app, /if \(anchoredSignature\.current !== timelineSignature && !loadingOlder\) releaseHistoryAnchor\(\)/);

  // The guard outlives the promise: releasing it when the promise settled let a
  // single flick to the top burn through several pages before any of them rendered.
  assert.match(app, /loadingOlderRef\.current = true;\s*\n\s*anchoredSignature\.current = signature\.current/);
  assert.match(app, /const releaseHistoryAnchor = useCallback\(\(\) => \{[\s\S]*?loadingOlderRef\.current = false;/);
  assert.doesNotMatch(app, /finally \{\s*\n\s*loadingOlderRef\.current = false;\s*\n\s*\}/);

  // Scrolling during an in-flight load re-bases the anchor rather than fighting it.
  assert.match(app, /if \(historyAnchor\.current !== null && !echoed\) historyAnchor\.current = distanceFromEnd\(element\)/);

  // Reading the wheel directly is the only un-pin signal that survives a streaming
  // reply, where following the tail writes the scroll offset every frame.
  assert.match(app, /onWheel=\{\(event\) => \{[\s\S]*?if \(event\.deltaY < 0\) pinnedToBottom\.current = false/);
  assert.match(app, /const echoed = writtenScrollTop\.current !== null && Math\.abs\(element\.scrollTop - writtenScrollTop\.current\) <= 1/);

  // Follow-the-tail and the anchor must never both write on one commit.
  assert.match(app, /if \(historyAnchor\.current === null && pinnedToBottom\.current\) scrollToLatest\(\)/);
  assert.match(app, /const shouldFollow = historyAnchor\.current === null && \(pinnedToBottom\.current \|\| isAtBottom\(element\)\)/);
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
