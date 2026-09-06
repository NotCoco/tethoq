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

test("Mesh badges survive delayed provider history and repeated identical sends", () => {
  const mesh = {
    targets: [{ providerId: "grok", modelId: "Grok Code", reasoningEffort: "high" }],
    segments: [{ type: "text", text: "Ask " }, { type: "mesh", targetIndex: 0 }, { type: "text", text: " to review" }],
  };
  const local = { id: "local-123", presentationId: "local-123", delegationId: "local-123", kind: "user", body: "Ask  to review", timestamp: "2026-09-05T10:00:00Z", state: "completed", mesh };
  const pending = { ...local, id: "tethoq-mesh:local-123-0", messageId: "tethoq-mesh:local-123" };
  const canonical = { ...local, id: "canonical", messageId: "provider-message", timestamp: "2026-09-05T10:15:00Z" };
  for (const first of [local, pending]) {
    const rows = merge.reconcileTimelinePage([canonical], [first]);
    assert.equal(rows.length, 1, "a delayed echo must adopt its Mesh message by identity");
    assert.equal(rows[0].id, "canonical");
    assert.deepEqual(rows[0].mesh, mesh);
    assert.equal(rows[0].presentationId, "local-123");
  }
  assert.equal(mergeTimeline([local], pending).length, 1);
  const second = { ...local, id: "local-124", presentationId: "local-124", delegationId: "local-124" };
  assert.equal(mergeTimeline([local], second).length, 2, "identical text must not merge two different Mesh sends");
  const empty = { ...local, body: "", mesh: { ...mesh, segments: [{ type: "mesh", targetIndex: 0 }] } };
  assert.equal(mergeTimeline([empty], { ...empty, id: "mesh-only-history", messageId: "mesh-only" }).length, 1);
});

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

test("a bounded scheduled preview adopts the full canonical provider prompt exactly once", () => {
  const prefix = "Inspect the scheduled workspace carefully. ".repeat(6);
  const fullPrompt = `${prefix}Keep this authoritative tail.`;
  const preview = `${fullPrompt.slice(0, 177).trimEnd()}…`;
  const scheduled = {
    id: "local-1788012300125",
    presentationId: "local-1788012300125",
    scheduledTaskId: "scheduled-long-prompt",
    kind: "user",
    body: preview,
    timestamp: "2026-08-29T14:05:00.125Z",
    state: "completed",
  };
  const canonical = {
    id: "provider-scheduled-user-1",
    messageId: "provider-scheduled-message-1",
    kind: "user",
    body: fullPrompt,
    timestamp: "2026-08-29T14:05:00.375Z",
    state: "completed",
  };

  const live = mergeTimeline([scheduled], canonical);
  assert.equal(live.length, 1, "the full provider echo replaced the bounded schedule preview");
  assert.equal(live[0].id, canonical.id);
  assert.equal(live[0].presentationId, scheduled.presentationId);
  assert.equal(live[0].scheduledTaskId, scheduled.scheduledTaskId);
  assert.equal(live[0].body, fullPrompt);

  const hydrated = merge.reconcileTimelinePage([canonical], [scheduled]);
  assert.equal(hydrated.length, 1, "history hydration replaced the bounded schedule preview");
  assert.equal(hydrated[0].id, canonical.id);
  assert.equal(hydrated[0].presentationId, scheduled.presentationId);
  assert.equal(hydrated[0].body, fullPrompt);

  const unrelated = {
    ...canonical,
    id: "provider-unrelated-user",
    messageId: "provider-unrelated-message",
    body: "An unrelated user message already in this provider task.",
    timestamp: "2026-08-29T14:05:00.250Z",
  };
  const mixedHydration = merge.reconcileTimelinePage([unrelated, canonical], [scheduled]);
  assert.equal(mixedHydration.length, 2, "the unrelated provider row remains visible");
  assert.equal(mixedHydration.find((item) => item.id === unrelated.id)?.presentationId, undefined, "an unrelated row cannot consume the scheduled presentation");
  assert.equal(mixedHydration.find((item) => item.id === canonical.id)?.presentationId, scheduled.presentationId, "only the matching provider prompt adopts the scheduled presentation");

  const naturalEllipsis = {
    ...scheduled,
    id: "local-1788012300225",
    presentationId: "local-1788012300225",
    body: "Please wait…",
  };
  const ellipsisContinuation = {
    ...canonical,
    id: "provider-unrelated-ellipsis-user",
    messageId: "provider-unrelated-ellipsis-message",
    body: "Please wait… actually run an unrelated manual turn.",
  };
  const ellipsisResult = mergeTimeline([naturalEllipsis], ellipsisContinuation);
  assert.equal(ellipsisResult.length, 2, "a natural trailing ellipsis is not treated as a bounded schedule preview");
  assert.equal(ellipsisResult.find((item) => item.id === ellipsisContinuation.id)?.presentationId, undefined);

  const laterUser = { ...canonical, id: "provider-user-2", messageId: "provider-message-2", timestamp: "2026-08-29T14:05:05.000Z" };
  assert.equal(mergeTimeline(live, laterUser).length, 2, "the adopted row cannot consume a later user turn");

  const ordinaryTruncated = { ...scheduled, id: "local-1788012301125", presentationId: "local-1788012301125", scheduledTaskId: undefined };
  assert.equal(mergeTimeline([ordinaryTruncated], canonical).length, 2, "an ordinary optimistic row gets no schedule-only adoption rule");

  const delayedCanonical = { ...canonical, timestamp: "2026-08-29T14:05:00.375Z" };
  const delayedRetry = { ...scheduled, id: "local-1788026700125", presentationId: "local-1788026700125", timestamp: "2026-08-29T18:05:00.125Z" };
  const delayedHydration = merge.reconcileTimelinePage([delayedCanonical], [delayedRetry]);
  assert.equal(delayedHydration.length, 2, "an old provider row cannot consume a later bounded retry without stronger identity evidence");
  assert.equal(delayedHydration.some((item) => item.id === delayedCanonical.id), true);
  assert.equal(delayedHydration.some((item) => item.id === delayedRetry.id), true);

  const staleExactCanonical = {
    ...canonical,
    id: "provider-stale-exact-user",
    messageId: "provider-stale-exact-message",
    body: "check status",
    timestamp: "2026-08-29T14:05:00.375Z",
  };
  const laterExactRetry = {
    ...scheduled,
    id: "local-1788026700225",
    presentationId: "local-1788026700225",
    body: "check status",
    timestamp: "2026-08-29T18:05:00.125Z",
  };
  const staleExactResult = merge.reconcileTimelinePage([staleExactCanonical], [laterExactRetry]);
  assert.equal(staleExactResult.length, 2, "same text alone cannot identify a scheduled retry hours later");
  assert.equal(staleExactResult.find((item) => item.id === staleExactCanonical.id)?.presentationId, undefined);

  const retryAfterAdoption = mergeTimeline(live, delayedRetry);
  assert.equal(retryAfterAdoption.length, 1, "an acknowledged retry does not repaint a canonical scheduled row");
  assert.equal(retryAfterAdoption[0].id, canonical.id);
});

test("an accepted composer row adopts an echo that arrived before acknowledgement", () => {
  const accepted = {
    id: "local-1787734800000",
    kind: "user",
    body: "Inspect this image",
    timestamp: "2026-08-26T09:00:00.000Z",
    state: "completed",
    images: [{ name: "capture.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" }],
  };
  const canonical = {
    id: "provider-user-1",
    messageId: "provider-message-1",
    kind: "user",
    body: "Inspect this image",
    timestamp: "2026-08-26T09:00:01.000Z",
    state: "completed",
    images: [{ name: "capture.png", mimeType: "image/png", loading: true }],
  };

  const result = merge.mergeAcceptedComposerRow([canonical], accepted, new Set());
  assert.equal(result.length, 1, "one accepted send must remain one transcript row");
  assert.equal(result[0].id, canonical.id, "the provider identity wins");
  assert.equal(result[0].presentationId, accepted.id, "the mounted card keeps its local presentation identity");
  assert.equal(result[0].messageId, canonical.messageId);
  assert.equal(result[0].images[0].dataUrl, accepted.images[0].dataUrl, "the ready local preview enriches a canonical placeholder");
  assert.equal(result[0].images[0].loading, false);
});

test("an immediate composer row enriches in place and retracts by presentation identity on failure", () => {
  const provisional = {
    id: "local-1787937600000",
    presentationId: "local-1787937600000",
    kind: "user",
    body: "Send immediately",
    timestamp: "2026-08-28T12:00:00.000Z",
    state: "completed",
    images: [{ name: "capture.png", mimeType: "image/png", loading: true }],
  };
  const ready = {
    ...provisional,
    images: [{ name: "capture.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AQ==", loading: false }],
  };
  const enriched = merge.mergeAcceptedComposerRow([provisional], ready, new Set());
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].id, provisional.id);
  assert.equal(enriched[0].images[0].dataUrl, ready.images[0].dataUrl);

  const canonical = {
    id: "opencode-user-message",
    messageId: "opencode-user-message",
    kind: "user",
    body: provisional.body,
    timestamp: "2026-08-28T12:00:01.000Z",
    state: "completed",
  };
  const adopted = mergeTimeline(enriched, canonical);
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].id, canonical.id);
  assert.equal(adopted[0].presentationId, provisional.id);
  assert.deepEqual(merge.rollbackOptimisticComposerRow(adopted, provisional.id), []);
});

test("a side-chat echo arriving before acknowledgement adopts one stable card", () => {
  const older = {
    id: "older-user",
    messageId: "older-message",
    kind: "user",
    body: "Check this",
    timestamp: "2026-08-26T08:00:00.000Z",
    state: "completed",
  };
  const canonical = {
    id: "side-chat-user",
    messageId: "side-chat-message",
    kind: "user",
    body: "Check this",
    timestamp: "2026-08-26T09:00:01.000Z",
    state: "completed",
  };
  const accepted = {
    id: "local-1787734800200",
    presentationId: "local-1787734800200",
    kind: "user",
    body: "Check this",
    timestamp: "2026-08-26T09:00:00.000Z",
    state: "completed",
  };

  const result = merge.mergeAcceptedComposerRow([older, canonical], accepted, new Set([older.id]));
  assert.equal(result.length, 2, "the side chat keeps the older real message and one new accepted message");
  assert.equal(result[1].id, canonical.id);
  assert.equal(result[1].presentationId, accepted.presentationId, "the provider echo updates the mounted side-chat card in place");
});

test("canonical history adopts an optimistic image row without remounting its presentation", () => {
  const accepted = {
    id: "local-1787734800100",
    presentationId: "local-1787734800100",
    kind: "user",
    body: "Inspect this image",
    timestamp: "2026-08-26T09:00:00.100Z",
    state: "completed",
    images: [{ name: "capture.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" }],
  };
  const canonical = {
    id: "provider-user-history-1",
    messageId: "provider-message-history-1",
    kind: "user",
    body: accepted.body,
    timestamp: "2026-08-26T09:00:01.000Z",
    state: "completed",
    images: [{ name: "capture.png", mimeType: "image/png", loading: true }],
  };

  const result = merge.reconcileTimelinePage([canonical], [accepted]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, canonical.id, "provider identity remains authoritative for future hydration");
  assert.equal(result[0].presentationId, accepted.presentationId, "React presentation identity survives history replacement");
  assert.equal(result[0].images[0].dataUrl, accepted.images[0].dataUrl, "ready pixels survive the canonical placeholder");
  assert.equal(result[0].images[0].loading, false);
});

test("queued-new-task canonical adoption keeps attachment previews on the same presentation", () => {
  const optimistic = {
    id: "local-1787734800300",
    presentationId: "local-1787734800300",
    queuedNewTaskDeliveryId: "queue-new-task-delivery-preview",
    queuedNewTaskDeliveryState: "pending",
    kind: "user",
    body: "Start this queued instruction in a new task",
    timestamp: "2026-08-26T09:00:00.300Z",
    state: "completed",
    images: [{ name: "queued-proof.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AQID", loading: false }],
    audio: [{ name: "queued-note.mp3", mimeType: "audio/mpeg", dataUrl: "data:audio/mpeg;base64,BAUG", durationSeconds: 2 }],
  };
  const canonical = {
    id: "provider-queued-new-task-user",
    messageId: "provider-queued-new-task-message",
    kind: "user",
    body: optimistic.body,
    timestamp: "2026-08-26T09:00:01.000Z",
    state: "completed",
    images: [{ name: "queued-proof.png", mimeType: "image/png", loading: true }],
    audio: [{ name: "queued-note.mp3", mimeType: "audio/mpeg", dataUrl: "" }],
  };

  const adopted = merge.reconcileTimelinePage([canonical], [optimistic]);

  assert.equal(adopted.length, 1, "the queued handoff and its provider echo remain one user row");
  assert.equal(adopted[0].id, canonical.id, "the provider identity becomes authoritative");
  assert.equal(adopted[0].presentationId, optimistic.presentationId, "canonical adoption does not remount the optimistic presentation");
  assert.equal(adopted[0].images[0].dataUrl, optimistic.images[0].dataUrl, "the ready queued image preview survives canonical adoption");
  assert.equal(adopted[0].images[0].loading, false);
  assert.equal(adopted[0].audio[0].dataUrl, optimistic.audio[0].dataUrl, "the playable queued audio preview survives canonical adoption");
});

test("queued-new-task canonical echoes clear pending and failed delivery metadata", () => {
  for (const [index, deliveryState, deliveryError] of [
    [0, "pending", undefined],
    [1, "failed", "The new task did not accept the queued instruction"],
  ]) {
    const optimistic = {
      id: `local-${1787734800400 + index}`,
      presentationId: `local-${1787734800400 + index}`,
      queuedNewTaskDeliveryId: `queue-new-task-delivery-${deliveryState}`,
      queuedNewTaskDeliveryState: deliveryState,
      ...(deliveryError ? { queuedNewTaskDeliveryError: deliveryError } : {}),
      kind: "user",
      body: `Canonicalise the ${deliveryState} queued handoff`,
      timestamp: `2026-08-26T09:00:0${index}.400Z`,
      state: "completed",
    };
    const canonical = {
      id: `provider-queued-new-task-${deliveryState}`,
      messageId: `provider-queued-new-task-message-${deliveryState}`,
      kind: "user",
      body: optimistic.body,
      timestamp: `2026-08-26T09:00:0${index + 1}.000Z`,
      state: "completed",
    };

    for (const adopted of [
      mergeTimeline([optimistic], canonical)[0],
      merge.reconcileTimelinePage([canonical], [optimistic])[0],
    ]) {
      assert.equal(adopted.id, canonical.id, `${deliveryState} handoff adopts the provider identity`);
      assert.equal(adopted.presentationId, optimistic.presentationId, `${deliveryState} handoff retains its presentation identity`);
      assert.equal(adopted.queuedNewTaskDeliveryId, undefined, `${deliveryState} delivery id is local-only`);
      assert.equal(adopted.queuedNewTaskDeliveryState, undefined, `${deliveryState} delivery state clears after canonical adoption`);
      assert.equal(adopted.queuedNewTaskDeliveryError, undefined, `${deliveryState} delivery error clears after canonical adoption`);
    }
  }
});

test("an older identical user row cannot satisfy a new accepted send", () => {
  const old = {
    id: "provider-user-old",
    messageId: "provider-message-old",
    kind: "user",
    body: "repeat this",
    timestamp: "2026-08-26T09:00:00.000Z",
    state: "completed",
  };
  const accepted = {
    id: "local-1787734801000",
    kind: "user",
    body: "repeat this",
    timestamp: "2026-08-26T09:00:01.000Z",
    state: "completed",
  };

  const result = merge.mergeAcceptedComposerRow([old], accepted, new Set([old.id]));
  assert.deepEqual(result.map((item) => item.id), [old.id, accepted.id]);
});

test("Codex canonical history coalesces every delayed form of the same real user action", () => {
  const turnId = "01a037db-c6be-73d0-a2b9-84c15bf27495";
  const body = "Real QA turn two. Reply with exactly CODEX_REAL_QA_TURN_2";
  const canonical = {
    id: "codex/rollout/01a037db-ca4f-7481-bcbc-5c677c2e951b/text-0",
    messageId: "01a037db-ca4f-7481-bcbc-5c677c2e951b",
    turnId,
    canonicalUserMessage: true,
    kind: "user",
    body,
    timestamp: "2026-08-25T07:39:06.171Z",
    state: "completed",
  };
  const providerRepresentation = {
    id: "codex:user:msg_01a037db-ca3b-7d13-b76c-c4f073d15934",
    messageId: "msg_01a037db-ca3b-7d13-b76c-c4f073d15934",
    turnId,
    kind: "user",
    body,
    // Live delivery time can be much later than the rollout record time. The
    // canonical marker plus shared turn is what makes this join trustworthy.
    timestamp: "2026-08-25T07:39:09.500Z",
    state: "completed",
  };

  const delayedLive = mergeTimeline([canonical], providerRepresentation);
  assert.equal(delayedLive.length, 1, "canonical history then delayed live event renders once");
  assert.equal(delayedLive[0], canonical, "an unchanged canonical row keeps its React identity");

  const pageInternal = merge.reconcileTimelinePage([canonical, providerRepresentation], []);
  assert.equal(pageInternal.length, 1, "a page containing both persisted forms renders once");
  assert.equal(pageInternal[0].messageId, canonical.messageId);
  assert.equal(pageInternal[0].canonicalUserMessage, true);

  const pageVersusLive = merge.reconcileTimelinePage([canonical], [providerRepresentation]);
  assert.equal(pageVersusLive.length, 1, "canonical page versus delayed live form renders once");
  assert.equal(pageVersusLive[0].messageId, canonical.messageId);
});

test("persisted Codex user coalescing preserves real repeated actions and attachment differences", () => {
  const base = {
    kind: "user",
    body: "same prompt",
    timestamp: "2026-08-25T07:39:06.171Z",
    state: "completed",
  };
  const turnA = { ...base, id: "a", messageId: "a", turnId: "turn-a", canonicalUserMessage: true };
  const turnB = { ...base, id: "b", messageId: "b", turnId: "turn-b" };
  assert.equal(mergeTimeline([turnA], turnB).length, 2, "different provider turns never merge");

  const laterRepeat = { ...base, id: "later", messageId: "later", timestamp: "2026-08-25T07:39:07.171Z" };
  const earlierRepeat = { ...base, id: "earlier", messageId: "earlier" };
  assert.equal(mergeTimeline([earlierRepeat], laterRepeat).length, 2, "the same words outside the narrow fallback window stay separate");

  const canonicalWithPlaceholders = {
    ...turnA,
    images: [{ name: "proof.png", mimeType: "image/png", loading: true }],
    audio: [{ name: "note.mp3", mimeType: "audio/mpeg", dataUrl: "" }],
    files: [{ name: "details.txt", mimeType: "text/plain" }],
    workflows: [{ id: "workflow-1", name: "Flow", eventCount: 1, screenshotCount: 0 }],
    annotations: [{ id: "annotation-canonical", text: "selected", annotation: "comment" }],
  };
  const richProviderForm = {
    ...base,
    id: "rich",
    messageId: "rich",
    turnId: "turn-a",
    images: [{ name: "proof.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AQID" }],
    audio: [{ name: "note.mp3", mimeType: "audio/mpeg", dataUrl: "data:audio/mpeg;base64,AQID", durationSeconds: 2 }],
    files: [{ name: "details.txt", mimeType: "text/plain" }],
    workflows: [{ id: "workflow-1", name: "Flow", eventCount: 3, screenshotCount: 2, applications: ["Codex"] }],
    annotations: [{ id: "annotation-rich", text: "selected", annotation: "comment", audioAttachmentIndex: 0 }],
  };
  const rich = mergeTimeline([canonicalWithPlaceholders], richProviderForm);
  assert.equal(rich.length, 1);
  assert.equal(rich[0].messageId, turnA.messageId, "canonical provider identity wins");
  assert.equal(rich[0].images[0].dataUrl, "data:image/png;base64,AQID");
  assert.equal(rich[0].audio[0].dataUrl, "data:audio/mpeg;base64,AQID");
  assert.equal(rich[0].workflows[0].eventCount, 3);
  assert.equal(rich[0].annotations[0].audioAttachmentIndex, 0);

  const differentAttachment = {
    ...richProviderForm,
    id: "different-file",
    messageId: "different-file",
    images: [{ name: "other.png", mimeType: "image/png", dataUrl: "data:image/png;base64,BAUG" }],
  };
  assert.equal(mergeTimeline([canonicalWithPlaceholders], differentAttachment).length, 2, "genuinely different attachments stay separate");
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

test("OpenCode tool snapshots enrich one stable row without concatenating old states", () => {
  const tool = (body, state = "running") => ({
    id: "session:tool:tool_part_1",
    messageId: "assistant_1",
    providerPartId: "tool_part_1",
    kind: "tool",
    title: "Run npm test",
    body,
    timestamp: "2026-08-26T10:00:00.000Z",
    state,
    streamDelta: false,
  });

  let timeline = mergeTimeline([], tool("Running…"));
  timeline = mergeTimeline(timeline, tool("Command: npm test\n\nResult:\nRunning…"));
  timeline = mergeTimeline(timeline, tool("Command: npm test\n\nResult:\n12 tests passed", "completed"));

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].body, "Command: npm test\n\nResult:\n12 tests passed");
  assert.equal(timeline[0].state, "completed");
});

test("non-snapshot tool output keeps its existing chunk semantics", () => {
  const first = { id: "tool-stream", kind: "tool", title: "Shell", body: "line one\n", timestamp: "2026-08-26T10:00:00.000Z", state: "running" };
  const second = { ...first, body: "line two" };
  const timeline = mergeTimeline([first], second);

  assert.equal(timeline[0].body, "line one\nline two");
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

  const interrupted = settleRunningTimeline([chunk("unfinished tool")], "failed");
  assert.equal(interrupted[0].state, "failed", "interrupted work was mislabeled as completed");
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

test("canonical OpenCode tool history closes and enriches a stale running snapshot", () => {
  const history = [{
    id: "assistant_1-0",
    messageId: "assistant_1",
    providerPartId: "tool_part_1",
    kind: "tool",
    title: "Run npm test",
    body: "Command: npm test\n\nResult:\n12 tests passed",
    timestamp: "2026-08-26T10:00:00.000Z",
    state: "completed",
  }];
  const live = [{
    ...history[0],
    id: "session:tool:tool_part_1",
    body: "Running…",
    state: "running",
    streamDelta: false,
  }];

  const reconciled = merge.reconcileTimelinePage(history, live);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, live[0].id, "the progressively updated row keeps its React identity");
  assert.equal(reconciled[0].body, history[0].body);
  assert.equal(reconciled[0].state, "completed");
  assert.equal(reconciled[0].streamDelta, false);
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

test("a temporarily stale canonical page cannot erase a displayed final answer", () => {
  const user = { id: "user", messageId: "user", kind: "user", body: "Question", timestamp: "2026-08-20T10:00:10.000Z", state: "completed" };
  const final = { id: "live-final", messageId: "final-message", kind: "assistant", phase: "final_answer", body: "The persisted answer", timestamp: "2026-08-20T10:00:20.000Z", state: "completed" };
  const newerHeartbeat = { id: "heartbeat", messageId: "heartbeat", kind: "reasoning", body: "stale provider row", timestamp: "2026-08-20T10:00:25.000Z", state: "completed" };

  const staleRefresh = merge.reconcileTimelinePage([user, newerHeartbeat], [user, final]);
  assert.equal(staleRefresh.filter((item) => item.phase === "final_answer").length, 1);
  assert.equal(staleRefresh.find((item) => item.phase === "final_answer")?.body, final.body);

  const canonicalFinal = { ...final, id: "canonical-final", messageId: "canonical-final-message" };
  const caughtUp = merge.reconcileTimelinePage([user, canonicalFinal], staleRefresh);
  assert.equal(caughtUp.filter((item) => item.phase === "final_answer").length, 1, "the later canonical echo replaces the retained answer exactly once");
});

test("a partial newest-page refresh cannot erase an already hydrated user action", () => {
  const olderCanonical = { id: "older", messageId: "older", kind: "assistant", body: "Older canonical row", timestamp: "2026-08-20T10:00:00.000Z", state: "completed" };
  const user = { id: "hydrated-user", messageId: "hydrated-user", kind: "user", body: "The action that produced the answer", timestamp: "2026-08-20T10:00:10.000Z", state: "completed" };
  const final = { id: "final", messageId: "final", kind: "assistant", phase: "final_answer", body: "Visible answer", timestamp: "2026-08-20T10:00:20.000Z", state: "completed" };
  const newerCanonical = { id: "newer", messageId: "newer", kind: "reasoning", body: "Newer canonical row", timestamp: "2026-08-20T10:00:30.000Z", state: "completed" };

  const refreshed = merge.reconcileTimelinePage([olderCanonical, newerCanonical], [user, final]);

  assert.equal(refreshed.filter((item) => item.id === user.id).length, 1);
  assert.equal(refreshed.find((item) => item.id === user.id)?.body, user.body);

  const canonicalUser = { ...user, id: "canonical-user", messageId: "canonical-user", body: user.body };
  const caughtUp = merge.reconcileTimelinePage([canonicalUser, newerCanonical], refreshed);
  assert.equal(caughtUp.filter((item) => item.kind === "user").length, 1, "the renamed canonical echo replaces the retained row instead of duplicating it");
  assert.equal(caughtUp.find((item) => item.kind === "user")?.id, canonicalUser.id);

  const repeated = { ...user, id: "genuine-repeat", messageId: "genuine-repeat", timestamp: "2026-08-20T10:00:11.000Z" };
  const withRepeat = merge.reconcileTimelinePage([canonicalUser, newerCanonical], [...refreshed, repeated]);
  assert.deepEqual(withRepeat.filter((item) => item.kind === "user").map((item) => item.id), [canonicalUser.id, repeated.id], "a separately submitted repeat remains a separate action");

  const differentAttachment = { ...user, id: "different-attachment", messageId: "different-attachment", images: [{ name: "other.png", mimeType: "image/png" }] };
  const canonicalWithImage = { ...canonicalUser, images: [{ name: "original.png", mimeType: "image/png" }] };
  const withDifferentAttachment = merge.reconcileTimelinePage([canonicalWithImage, newerCanonical], [differentAttachment]);
  assert.deepEqual(withDifferentAttachment.filter((item) => item.kind === "user").map((item) => item.id), [canonicalWithImage.id, differentAttachment.id], "same text and time with a different attachment remains a separate action");
});

test("canonical Codex history upgrades one text-only attachment completion without duplicating the user turn", () => {
  const body = "The exact attachment-bearing request stays readable.";
  const live = {
    id: "codex:user:response-record",
    messageId: "response-record",
    turnId: "turn-with-image",
    kind: "user",
    body,
    timestamp: "2026-09-02T05:45:00.000Z",
    state: "completed",
    images: [{ name: "evidence.png", mimeType: "image/png", loading: true }],
  };
  const canonical = {
    id: "codex:user:canonical-record",
    messageId: "canonical-record",
    turnId: "turn-with-image",
    canonicalUserMessage: true,
    kind: "user",
    body,
    timestamp: "2026-09-02T05:45:00.050Z",
    state: "completed",
    images: [{ name: "evidence.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AQID", loading: false }],
  };

  const refreshed = merge.reconcileTimelinePage([canonical], [live]);

  assert.equal(refreshed.filter((item) => item.kind === "user").length, 1);
  assert.equal(refreshed[0].id, canonical.id);
  assert.equal(refreshed[0].body, body);
  assert.deepEqual(refreshed[0].images, canonical.images);
  assert.doesNotMatch(JSON.stringify(refreshed), /Files mentioned|<image|AppData|response_item/u);

  const reopened = merge.reconcileTimelinePage([canonical], refreshed);
  assert.equal(reopened.filter((item) => item.kind === "user").length, 1, "reconnect keeps one canonical user row");
  assert.equal(reopened[0].images.length, 1, "reconnect keeps one image widget");
});

test("a revealed transcript stays anchored when refresh reindexes earlier rows", () => {
  const rows = [
    { id: "old-reasoning", messageId: "old-reasoning", kind: "reasoning", body: "Old", timestamp: "2026-08-20T10:00:00.000Z", state: "completed" },
    { id: "visible-user", messageId: "visible-user", kind: "user", body: "Question", timestamp: "2026-08-20T10:00:10.000Z", state: "completed" },
    { id: "visible-final", messageId: "visible-final", kind: "assistant", phase: "final_answer", body: "Answer", timestamp: "2026-08-20T10:00:20.000Z", state: "completed" },
  ];
  const anchor = merge.timelineRevealAnchorKey(rows[1]);
  const refreshed = [
    { id: "new-earlier-row", messageId: "new-earlier-row", kind: "reasoning", body: "Earlier", timestamp: "2026-08-20T09:59:00.000Z", state: "completed" },
    ...rows,
  ];

  assert.equal(merge.anchoredTimelineRevealStart(refreshed, 1, anchor), 2);
  assert.deepEqual(refreshed.slice(merge.anchoredTimelineRevealStart(refreshed, 1, anchor)).map((item) => item.id), ["visible-user", "visible-final"]);
});

test("deferred image hydration enriches only the matching row", () => {
  const user = { id: "user", messageId: "user", kind: "user", body: "Inspect this", timestamp: "2026-08-25T10:00:00.000Z", state: "completed", images: [{ name: "screen.png", mimeType: "image/png" }] };
  const answer = { id: "answer", messageId: "answer", kind: "assistant", phase: "final_answer", body: "Done", timestamp: "2026-08-25T10:00:01.000Z", state: "completed" };
  const hydratedPage = [{ ...user, body: "stale text must not replace live text", images: [{ name: "screen.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AQID" }] }];

  const hydrated = merge.mergeTimelineImageHydration([user, answer], hydratedPage);

  assert.equal(hydrated[0].body, user.body);
  assert.equal(hydrated[0].images[0].dataUrl, "data:image/png;base64,AQID");
  assert.equal(hydrated[1], answer, "unrelated rows keep their identity");
  assert.equal(merge.mergeTimelineImageHydration(hydrated, hydratedPage), hydrated, "replaying the same hydration is a no-op");
});

test("stale image hydration never downgrades or removes a ready local preview", () => {
  const ready = {
    id: "user",
    kind: "user",
    body: "Inspect both",
    timestamp: "2026-08-25T10:00:00.000Z",
    state: "completed",
    images: [
      { name: "first.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AQID", loading: false },
      { name: "second.png", mimeType: "image/png", dataUrl: "data:image/png;base64,BAUG", loading: false },
    ],
  };
  const stale = [{ ...ready, images: [{ name: "first.png", mimeType: "image/png", loading: false }] }];
  const hydrated = merge.mergeTimelineImageHydration([ready], stale);
  assert.equal(hydrated[0].images.length, 2, "a stale short page cannot shrink the local gallery");
  assert.equal(hydrated[0].images[0].dataUrl, ready.images[0].dataUrl, "an unavailable retrieval cannot replace a ready preview");
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

test("a canonical interruption replaces its matching live terminal notice", () => {
  const live = { id: "live-interruption", messageId: "turn-1", kind: "error", title: "Task interrupted", body: "Task interrupted", timestamp: "2026-08-21T10:00:01.000Z", state: "failed" };
  const canonical = { ...live, id: "canonical-interruption", messageId: "turn-aborted-turn-1", timestamp: "2026-08-21T10:00:02.000Z" };
  const reconciled = merge.reconcileTimelinePage([canonical], [live]);

  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, "canonical-interruption");
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
