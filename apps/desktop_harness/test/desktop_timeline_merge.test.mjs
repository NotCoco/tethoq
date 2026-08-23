import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-timeline-merge-${process.pid}-${Date.now()}`);
await mkdir(outputDirectory, { recursive: true });
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

const bundle = join(outputDirectory, "timeline_merge.mjs");
await build({
  entryPoints: [join(appRoot, "src", "renderer", "src", "timeline_merge.ts")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "neutral",
});
const merge = await import(`file://${bundle.replaceAll("\\", "/")}`);
const { mergeTimeline, settleRunningTimeline } = merge;

const chunk = (text, over = {}) => ({
  id: "session:reasoning:prt_1",
  messageId: "msg_1",
  kind: "reasoning",
  title: "Reasoning",
  body: text,
  timestamp: "2026-08-19T12:00:00.000Z",
  state: "running",
  streamDelta: true,
  sourceEventId: `evt_${text}`,
  ...over,
});

test("your message is not shown twice once the harness echoes it back", async () => {
  const sent = (id, body, at) => ({ id, kind: "user", body, timestamp: at, state: "completed" });

  // The composer shows your message immediately under an id this app invents; the
  // harness returns the same message later under an id of its own. Nothing about
  // the two rows matches, so both used to survive and your message sat there twice.
  const shownNow = sent("local-1750000000000", "test", "2026-08-20T09:00:00.000Z");
  const echoed = { ...sent("msg_1-0", "test", "2026-08-20T09:00:01.000Z"), messageId: "msg_1" };
  const reconciled = merge.reconcileTimelinePage([echoed], [shownNow]);
  assert.equal(reconciled.filter((item) => item.kind === "user").length, 1, "one send, one row");
  assert.equal(reconciled[0].messageId, "msg_1", "the harness's own row is the one kept");

  // Until the echo arrives the invented row must stay, or your message would vanish
  // between pressing send and the harness catching up.
  const notYet = merge.reconcileTimelinePage([], [shownNow]);
  assert.equal(notYet.length, 1);
  assert.equal(notYet[0].id, "local-1750000000000");

  // Queue state is a separate control surface. Codex may consume and remove its
  // queue record before provider history contains the user message, but a canonical
  // refresh with no echo must still leave the transcript row continuously visible.
  const afterQueueRemoval = merge.reconcileTimelinePage([], notYet);
  assert.equal(afterQueueRemoval.length, 1);
  assert.equal(afterQueueRemoval[0], shownNow);

  // A live persisted echo can arrive before the next history page. It adopts the
  // optimistic row in place and remains a user message throughout the race.
  const liveEcho = { ...echoed, id: "session:user:msg_1", sourceEventId: "codex:user-completed" };
  const liveReconciled = mergeTimeline([shownNow], liveEcho);
  assert.equal(liveReconciled.length, 1, "the live echo replaces rather than duplicates the optimistic row");
  assert.equal(liveReconciled[0].kind, "user");
  assert.equal(liveReconciled[0].id, liveEcho.id);

  // Side-chat creation can hydrate provider history first and deliver the same
  // message.started event a moment later. Provider message identity still
  // describes one user row; event timing must not paint the queued text twice.
  const lateLiveEcho = { ...echoed, id: "side-chat:user:msg_1", sourceEventId: "side-chat:user-started", streamDelta: true };
  const hydratedThenLive = mergeTimeline([echoed], lateLiveEcho);
  assert.equal(hydratedThenLive.length, 1, "a late live echo adopts the hydrated user row");
  assert.equal(hydratedThenLive[0].messageId, "msg_1");

  // Similar assistant prose is a real answer and must never be mistaken for a
  // user echo merely because its words happen to match.
  const assistantWithSameText = { ...liveEcho, id: "session:assistant:msg_2", messageId: "msg_2", kind: "assistant" };
  assert.equal(mergeTimeline([shownNow], assistantWithSameText).length, 2);

  // The answer can reach canonical history before the provider's user echo. The
  // optimistic row sits inside that page's time window, but it is not stale: it
  // must survive until a matching user row positively replaces it.
  const answerFirst = merge.reconcileTimelinePage([{
    id: "answer-1",
    messageId: "assistant-1",
    kind: "assistant",
    phase: "final_answer",
    body: "ok",
    timestamp: "2026-08-20T09:00:02.000Z",
    state: "completed",
  }], [shownNow]);
  assert.deepEqual(answerFirst.map((item) => item.id), [shownNow.id, "answer-1"]);

  // Attachment notes are for the reader, not part of what was sent, so they must
  // not stop the echo from matching.
  const withNotes = sent("local-1750000000001", "test\n\nAttached file: a.png", "2026-08-20T09:00:00.000Z");
  assert.equal(merge.reconcileTimelinePage([echoed], [withNotes]).filter((i) => i.kind === "user").length, 1);

  // Sending the same words again is a real second message: an older copy already in
  // history must not stand in for it and make the new one disappear.
  const older = { ...sent("msg_0-0", "test", "2026-08-20T08:00:00.000Z"), messageId: "msg_0" };
  const again = merge.reconcileTimelinePage([older], [sent("local-1750000900000", "test", "2026-08-20T09:15:00.000Z")]);
  assert.equal(again.filter((item) => item.kind === "user").length, 2, "the new message stays on screen");
});

test("an audio-only optimistic row adopts the provider echo and keeps its playable preview", () => {
  const optimistic = {
    id: "local-1750000000100",
    kind: "user",
    body: "",
    audio: [{ name: "tethoq-dictation.mp3", mimeType: "audio/mpeg", dataUrl: "data:audio/mpeg;base64,AQID", dictation: true }],
    timestamp: "2026-08-20T09:00:00.000Z",
    state: "completed",
  };
  const echoed = {
    id: "provider-audio-user",
    messageId: "provider-audio-user",
    kind: "user",
    body: "",
    timestamp: "2026-08-20T09:00:01.000Z",
    state: "completed",
  };

  const live = mergeTimeline([optimistic], echoed);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, echoed.id);
  assert.equal(live[0].audio?.[0]?.dataUrl, optimistic.audio[0].dataUrl);

  const reopened = merge.reconcileTimelinePage([echoed], [optimistic]);
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].id, echoed.id);
  assert.equal(reopened[0].audio?.[0]?.dataUrl, optimistic.audio[0].dataUrl);
});

test("streamed chunks build one body instead of replacing it", () => {
  let timeline = [];
  for (const text of ["The user ", "wants a ", "rate limiter."]) timeline = mergeTimeline(timeline, chunk(text));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].body, "The user wants a rate limiter.");
});

test("an authoritative live snapshot replaces instead of duplicating a running thought", () => {
  const current = chunk("Checking the first approach.");
  const replacement = {
    ...current,
    body: "Checking the corrected approach.",
    streamDelta: false,
    sourceEventId: undefined,
  };

  const timeline = mergeTimeline([current], replacement);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].body, "Checking the corrected approach.");
});

test("a hydrated provider part absorbs live chunks under one live-stable row id", () => {
  const hydrated = {
    ...chunk("Stored beginning. "),
    id: "history-message-0",
    providerPartId: "prt_1",
    state: "completed",
    streamDelta: undefined,
    sourceEventId: undefined,
  };
  const firstLive = chunk("Live continuation. ", {
    id: "session:reasoning:prt_1",
    providerPartId: "prt_1",
    sourceEventId: "evt_live_1",
  });
  let timeline = mergeTimeline([hydrated], firstLive);

  assert.equal(timeline.length, 1, "history and live forms of one provider part share a row");
  assert.equal(timeline[0].id, firstLive.id, "the row adopts the id subsequent live chunks use");
  assert.equal(timeline[0].body, "Stored beginning. Live continuation. ");

  timeline = mergeTimeline(timeline, chunk("Still streaming.", {
    id: firstLive.id,
    providerPartId: "prt_1",
    sourceEventId: "evt_live_2",
  }));
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].body, "Stored beginning. Live continuation. Still streaming.");

  const siblingMessage = chunk("Different message", {
    id: "session:reasoning:prt_1:other",
    providerPartId: "prt_1",
    messageId: "msg_2",
    sourceEventId: "evt_other",
  });
  assert.equal(mergeTimeline(timeline, siblingMessage).length, 2, "part id alone never crosses message boundaries");
  const siblingKind = chunk("Assistant sibling", {
    id: "session:assistant:prt_1",
    providerPartId: "prt_1",
    kind: "assistant",
    sourceEventId: "evt_assistant",
  });
  assert.equal(mergeTimeline(timeline, siblingKind).length, 2, "part id alone never crosses content kinds");
});

test("a replayed batch never appends the same chunk twice", () => {
  let timeline = mergeTimeline([], chunk("Once"));
  timeline = mergeTimeline(timeline, chunk("Once"));
  assert.equal(timeline[0].body, "Once");
});

test("an idle report between two chunks never throws the thought away", () => {
  // A slow model goes quiet for longer than the catch-up threshold, and an idle
  // report landing in that gap settles the row. The chunks that follow still belong
  // to the same thought: treating them as a fresh body dropped everything already
  // written and left a row that read as an empty "Thinking...", filling in only when
  // the finished transcript reloaded. A fast provider never paused long enough to
  // show it, which is why this looked provider-specific rather than general.
  let timeline = mergeTimeline([], chunk("A fair limiter needs "));
  timeline = mergeTimeline(timeline, chunk("per-tenant buckets. "));
  timeline = settleRunningTimeline(timeline);
  assert.equal(timeline[0].state, "completed", "the shimmer stops");
  assert.equal(timeline[0].streamDelta, true, "how the row was built is not forgotten");

  timeline = mergeTimeline(timeline, chunk("Then a global ceiling."));
  assert.equal(timeline[0].body, "A fair limiter needs per-tenant buckets. Then a global ceiling.");
  assert.equal(timeline[0].state, "running", "a further chunk means the thought is live again");
});

test("settling stops every animation without touching text", () => {
  const settled = settleRunningTimeline([
    chunk("live"),
    { ...chunk("done"), id: "other", state: "completed" },
    { ...chunk("broken"), id: "failed", state: "failed" },
  ]);
  assert.deepEqual(settled.map((item) => item.state), ["completed", "completed", "failed"]);
  assert.deepEqual(settled.map((item) => item.body), ["live", "done", "broken"]);
});

test("a chunk from a later turn starts a new body on a shared row", () => {
  // Providers that name no part share one fallback row per kind, so the guard that
  // lets a settled row keep extending must not let the next turn glue itself on.
  const shared = (text, messageId) => chunk(text, { id: "opencode-reasoning-stream", messageId, sourceEventId: `evt_${messageId}_${text}` });
  let timeline = mergeTimeline([], shared("First turn thinking.", "msg_1"));
  timeline = settleRunningTimeline(timeline);
  timeline = mergeTimeline(timeline, shared("Second turn thinking.", "msg_2"));
  assert.equal(timeline[0].body, "Second turn thinking.");
});

test("rows that carry no streaming marker are left exactly as they were", () => {
  // This path is untouched by the settling change; it is asserted so a regression in
  // it cannot hide behind the streamed-chunk tests above.
  const plain = (text, state) => ({ ...chunk(text), streamDelta: undefined, sourceEventId: undefined, state });
  let timeline = mergeTimeline([], plain("First plan", "running"));
  timeline = mergeTimeline(timeline, plain(" extended", "running"));
  assert.equal(timeline[0].body, "First plan extended");
  timeline = mergeTimeline(timeline, plain("Final wording", "completed"));
  assert.equal(timeline[0].body, "Final wording");
});

test("same-message provider parts reconcile one-to-one without duplicating reasoning", () => {
  const history = [
    { id: "history-a", providerPartId: "prt_a", messageId: "msg_1", kind: "reasoning", body: "First stored thought", timestamp: "2026-08-20T10:00:01.000Z", state: "completed" },
    { id: "history-b", providerPartId: "prt_b", messageId: "msg_1", kind: "reasoning", body: "Second stored thought", timestamp: "2026-08-20T10:00:02.000Z", state: "completed" },
  ];
  const live = [
    { ...history[0], id: "live-a", body: "First streamed thought, with its full detail", state: "completed" },
    { ...history[1], id: "live-b", body: "Second streamed thought, independently retained", state: "completed" },
  ];

  const reconciled = merge.reconcileTimelinePage(history, live);
  assert.equal(reconciled.length, 2);
  assert.deepEqual(reconciled.map((item) => item.providerPartId), ["prt_a", "prt_b"]);
  assert.deepEqual(reconciled.map((item) => item.body), live.map((item) => item.body));
});

test("a live Codex command reconciles with its canonical history row", () => {
  const history = [{
    id: "history-call-1-0",
    messageId: "call-1",
    kind: "command",
    title: "npm test",
    body: "tests passed",
    timestamp: "2026-08-21T10:00:01.000Z",
    state: "completed",
  }];
  const live = [{
    id: "session:command:call-1",
    messageId: "call-1",
    kind: "command",
    title: "npm test",
    body: "command started",
    timestamp: "2026-08-21T10:00:00.000Z",
    state: "running",
  }];

  const reconciled = merge.reconcileTimelinePage(history, live);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, live[0].id);
  assert.equal(reconciled[0].body, live[0].body);
});

test("reconcile preserves a longer cumulative thought while its provider part is still live", () => {
  const history = [{ ...chunk("The complete cumulative thought"), id: "history", providerPartId: "prt_1", state: "completed" }];
  const live = [{ ...chunk("thought"), id: "live", providerPartId: "prt_1" }];

  const reconciled = merge.reconcileTimelinePage(history, live);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].body, "The complete cumulative thought");
  assert.equal(reconciled[0].state, "running");
});

test("reconcile never revives stale text over an authoritative live replacement", () => {
  const history = [{ ...chunk("The old plan with substantially more stale detail"), id: "history", providerPartId: "prt_1", state: "completed" }];
  const live = [{ ...chunk("New plan"), id: "live", providerPartId: "prt_1", streamDelta: false }];

  const reconciled = merge.reconcileTimelinePage(history, live);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].body, "New plan");
  assert.equal(reconciled[0].streamDelta, false);
});

test("reconcile removes stale settled rows inside the canonical page window only", () => {
  const row = (id, timestamp, state = "completed") => ({ id, messageId: id, kind: "reasoning", body: id, timestamp, state });
  const page = [
    row("page-oldest", "2026-08-20T10:00:10.000Z"),
    row("page-newest", "2026-08-20T10:00:20.000Z"),
  ];
  const live = [
    row("genuinely-older", "2026-08-20T10:00:05.000Z"),
    row("stale-inside", "2026-08-20T10:00:15.000Z"),
    row("running-inside", "2026-08-20T10:00:16.000Z", "running"),
    row("newer", "2026-08-20T10:00:25.000Z"),
  ];

  const reconciled = merge.reconcileTimelinePage(page, live);
  assert.deepEqual(reconciled.map((item) => item.id), [
    "genuinely-older",
    "page-oldest",
    "running-inside",
    "page-newest",
    "newer",
  ]);
});

test("an unchanged canonical history refresh preserves the entire live timeline identity", () => {
  const live = [
    { id: "one", messageId: "one", kind: "user", body: "Question", timestamp: "2026-08-21T10:00:00.000Z", state: "completed", annotations: [{ id: "a", text: "Selected", annotation: "Note" }] },
    { id: "two", messageId: "two", kind: "assistant", body: "Answer", timestamp: "2026-08-21T10:00:01.000Z", state: "completed" },
  ];
  const page = structuredClone(live);
  assert.equal(merge.reconcileTimelinePage(page, live), live);
});

test("a duplicated canonical final answer is painted once", () => {
  const final = { id: "answer", messageId: "answer-message", kind: "assistant", phase: "final_answer", body: "Delayed answer", timestamp: "2026-08-21T10:00:01.000Z", state: "completed" };
  const reconciled = merge.reconcileTimelinePage([final, structuredClone(final)], []);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, "answer");
});

test("a changed canonical row preserves the identities of unchanged siblings", () => {
  const live = [
    { id: "one", messageId: "one", kind: "user", body: "Question", timestamp: "2026-08-21T10:00:00.000Z", state: "completed" },
    { id: "two", messageId: "two", kind: "assistant", body: "Old answer", timestamp: "2026-08-21T10:00:01.000Z", state: "completed" },
  ];
  const page = structuredClone(live);
  page[1].body = "New answer";
  const reconciled = merge.reconcileTimelinePage(page, live);
  assert.notEqual(reconciled, live);
  assert.equal(reconciled[0], live[0]);
  assert.notEqual(reconciled[1], live[1]);
  assert.equal(reconciled[1].body, "New answer");
});
