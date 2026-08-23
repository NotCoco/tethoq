import type { TimelineItem } from "./types";

/**
 * Folds one incoming row into the transcript.
 *
 * Providers that stream send only the newest text, so those rows extend what is
 * already shown. Providers that resend the whole message replace it instead.
 */
export function mergeTimeline(existing: TimelineItem[], incoming: TimelineItem): TimelineItem[] {
  const exact = existing.findIndex((item) => item.id === incoming.id);
  const providerPart = exact < 0
    ? existing.findIndex((item) => sameProviderPart(item, incoming))
    : -1;
  // A newly created side chat can hydrate its canonical user row before the
  // matching message.started event crosses the live event stream. User messages
  // are one visible row, so their provider message identity is sufficient to
  // adopt that late live echo instead of painting the queued instruction twice.
  const providerUserMessage = exact < 0 && providerPart < 0 && incoming.kind === "user" && incoming.messageId !== undefined
    ? existing.findIndex((item) => item.kind === "user" && item.messageId === incoming.messageId)
    : -1;
  const optimisticUserEcho = exact < 0 && providerPart < 0 && providerUserMessage < 0
    ? optimisticUserEchoIndex(existing, incoming)
    : -1;
  const found = exact >= 0 ? exact : providerPart >= 0 ? providerPart : providerUserMessage >= 0 ? providerUserMessage : optimisticUserEcho;
  if (found >= 0) return existing.map((item, index) => {
    if (index !== found) return item;
    // The composer row exists before the provider can echo the accepted prompt.
    // Adopt that canonical identity in place, retaining local attachment previews,
    // so one send never flashes as two user rows (or used to, as an assistant row).
    if (optimisticUserEcho >= 0) return {
      ...item,
      ...incoming,
      ...(incoming.images === undefined && item.images !== undefined ? { images: item.images } : {}),
      ...(incoming.audio === undefined && item.audio !== undefined ? { audio: item.audio } : {}),
      ...(incoming.workflows === undefined && item.workflows !== undefined ? { workflows: item.workflows } : {}),
      ...(incoming.annotations === undefined && item.annotations !== undefined ? { annotations: item.annotations } : {}),
    };
    // A replayed batch can deliver the same event twice. Re-appending its chunk
    // would silently duplicate text inside the streaming answer.
    if (incoming.sourceEventId !== undefined && incoming.sourceEventId === item.sourceEventId) return item;
    // Chunked providers send only the newest text, so every chunk appends even
    // when two consecutive chunks happen to be identical. Providers that resend
    // the whole message keep the older replace-unless-changed behaviour.
    const appendBody = incoming.streamDelta === true
      ? sameProviderMessage(item, incoming) && (providerPart >= 0 || item.streamDelta === true || item.state === "running")
      : incoming.streamDelta === false
        ? false
        : incoming.state === "running" && item.state === "running" && incoming.body !== item.body;
    return { ...item, ...incoming, body: appendBody ? `${item.body}${incoming.body}` : incoming.body };
  });
  return [...existing, incoming];
}

/** A hydrated row and its live stream can use different renderer ids for one part. */
function sameProviderPart(item: TimelineItem, incoming: TimelineItem): boolean {
  return incoming.providerPartId !== undefined
    && incoming.messageId !== undefined
    && item.providerPartId === incoming.providerPartId
    && item.messageId === incoming.messageId
    && item.kind === incoming.kind;
}

/**
 * A chunk belongs to the row it is extending.
 *
 * Rows are usually keyed by a provider part id, which is unique, but a provider
 * that names no part shares one fallback row per kind. Requiring the same
 * provider message is what stops a later turn's first chunk from being glued to
 * the end of the previous turn's text on those shared rows.
 */
function sameProviderMessage(item: TimelineItem, incoming: TimelineItem): boolean {
  if (item.messageId === undefined || incoming.messageId === undefined) return true;
  return item.messageId === incoming.messageId;
}

/**
 * Closes every live row of a finished turn so only genuinely current work animates.
 *
 * Settling stops the animation; it does not change how the row was built. A slow
 * model goes quiet for longer than the catch-up threshold between two chunks, and
 * an idle report arriving in that gap used to strip the streaming marker as well —
 * after which the next chunk was treated as a whole new body and threw away every
 * word the thought had produced so far. The text only reappeared when the finished
 * transcript reloaded, which is why live reasoning looked like it was missing most
 * of itself on a slow provider and correct on a fast one.
 */
export function settleRunningTimeline(items: readonly TimelineItem[]): TimelineItem[] {
  if (!items.some((item) => item.state === "running")) return items as TimelineItem[];
  return items.map((item) => item.state === "running" ? { ...item, state: "completed" as const } : item);
}


/** A row the composer shows the instant you send, before the harness echoes it back. */
const composerEchoRow = /^local-\d+$/u;
const maximumOptimisticEchoSkewMs = 120_000;

/** Attachment notes are added for the reader and are not part of what was sent. */
function sentBody(item: TimelineItem): string {
  const body = item.body.split(/\n\nAttached file:/u)[0]!.trim();
  if (body) return body;
  return item.annotations?.length
    ? `annotations:${JSON.stringify(item.annotations.map(({ text, annotation }) => ({ text, annotation })))}`
    : "";
}

function audioOnlyComposerEcho(item: TimelineItem): boolean {
  return item.kind === "user"
    && composerEchoRow.test(item.id)
    && !sentBody(item)
    && (item.audio?.length ?? 0) > 0;
}

function emptyCanonicalUser(item: TimelineItem): boolean {
  return item.kind === "user" && !sentBody(item);
}

function optimisticUserEchoIndex(existing: readonly TimelineItem[], incoming: TimelineItem): number {
  if (incoming.kind !== "user" || composerEchoRow.test(incoming.id)) return -1;
  const body = sentBody(incoming);
  const incomingAt = Date.parse(incoming.timestamp) || 0;
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const candidate = existing[index]!;
    const sameText = body && sentBody(candidate) === body;
    const audioOnly = !body && emptyCanonicalUser(incoming) && audioOnlyComposerEcho(candidate);
    if (candidate.kind !== "user" || !composerEchoRow.test(candidate.id) || (!sameText && !audioOnly)) continue;
    const candidateAt = Date.parse(candidate.timestamp) || 0;
    if (Math.abs(incomingAt - candidateAt) <= maximumOptimisticEchoSkewMs) return index;
  }
  return -1;
}

/**
 * Has the harness echoed this row back to us yet?
 *
 * Your message appears the moment you send it, under an id this app invents, and
 * the harness later returns the same message under an id of its own. Nothing about
 * the two rows matches - not the id, and not the message id, which the invented row
 * has never had - so both survived the reconcile and your message sat on screen
 * twice. The echo has to be at least as new as the row it replaces, or sending the
 * same words twice would let the older copy stand in for the newer one.
 */
function echoedBack(page: readonly TimelineItem[], row: TimelineItem): boolean {
  const body = sentBody(row);
  const sentAt = Date.parse(row.timestamp) || 0;
  return page.some((item) => item.kind === "user"
    && ((body && sentBody(item) === body) || (!body && audioOnlyComposerEcho(row) && emptyCanonicalUser(item)))
    && (Date.parse(item.timestamp) || 0) >= sentAt - 120_000);
}
function timelineSemanticKey(item: TimelineItem): string | null {
  if (item.messageId && (item.kind === "user" || item.kind === "assistant" || item.kind === "reasoning")) return `${item.kind}:${item.messageId}`;
  if (item.kind === "command" && item.messageId) return `command:${item.messageId}`;
  if (item.kind === "tool" && item.detail) return `tool:${item.detail}`;
  return null;
}

function sameOptionalJson(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Preserve React identity when a canonical refresh contains no visible change. */
function sameTimelineItem(left: TimelineItem, right: TimelineItem): boolean {
  return left === right || (
    left.id === right.id
    && left.messageId === right.messageId
    && left.providerPartId === right.providerPartId
    && left.kind === right.kind
    && left.phase === right.phase
    && left.title === right.title
    && left.body === right.body
    && left.detail === right.detail
    && left.state === right.state
    && left.timestamp === right.timestamp
    && left.streamDelta === right.streamDelta
    && left.sourceEventId === right.sourceEventId
    && sameOptionalJson(left.images, right.images)
    && sameOptionalJson(left.audio, right.audio)
    && sameOptionalJson(left.workflows, right.workflows)
    && sameOptionalJson(left.annotations, right.annotations)
    && sameOptionalJson(left.origin, right.origin)
  );
}

/** Keep live rows that authoritative provider history has not caught up with yet. */
export function reconcileTimelinePage(page: readonly TimelineItem[], live: readonly TimelineItem[]): TimelineItem[] {
  // A retried/reordered history response may contain the same canonical row
  // twice. Remove exact provider identities before reconciling with live state,
  // otherwise one delayed final answer is painted twice even though the store
  // itself contains only one message.
  const seenPageIds = new Set<string>();
  const deduplicatedPage = page.filter((item) => {
    if (seenPageIds.has(item.id)) return false;
    seenPageIds.add(item.id);
    return true;
  });
  const merged = [...deduplicatedPage];
  const consumedPageIndexes = new Set<number>();
  const pageTimes = deduplicatedPage.map((item) => Date.parse(item.timestamp) || 0);
  const oldestPageTime = pageTimes.length ? Math.min(...pageTimes) : 0;
  const newestPageTime = pageTimes.length ? Math.max(...pageTimes) : 0;
  const adopt = (target: TimelineItem, liveItem: TimelineItem): TimelineItem => {
    if (audioOnlyComposerEcho(liveItem) && emptyCanonicalUser(target)) {
      return {
        ...liveItem,
        ...target,
        ...(target.audio === undefined && liveItem.audio !== undefined ? { audio: liveItem.audio } : {}),
      };
    }
    if (liveItem.state === "running") {
      const body = liveItem.streamDelta !== false
        && liveItem.kind === "reasoning" && target.kind === "reasoning" && target.body.length > liveItem.body.length
        ? target.body
        : liveItem.body;
      return { ...target, ...liveItem, body };
    }
    // History can hold a shorter copy of a finished thought (storage keeps a
    // summary where the live stream carried every word). Never let a reconcile
    // shrink what was already fully shown.
    if (liveItem.kind === "reasoning" && target.kind === "reasoning" && liveItem.body.length > target.body.length) {
      return { ...target, body: liveItem.body };
    }
    return target;
  };
  const nextPageIndex = (predicate: (item: TimelineItem) => boolean): number => {
    for (let index = 0; index < deduplicatedPage.length; index += 1) {
      if (!consumedPageIndexes.has(index) && predicate(deduplicatedPage[index]!)) return index;
    }
    return -1;
  };
  const unmatched: TimelineItem[] = [];
  for (const liveItem of live) {
    // Once the harness has returned your message, the row this app invented to show
    // it immediately has done its job. Keeping both is what put it on screen twice.
    if (liveItem.kind === "user" && composerEchoRow.test(liveItem.id)
      && !audioOnlyComposerEcho(liveItem) && echoedBack(page, liveItem)) continue;
    let pageIndex = nextPageIndex((item) => item.id === liveItem.id);
    if (pageIndex < 0 && liveItem.providerPartId) {
      pageIndex = nextPageIndex((item) => item.providerPartId === liveItem.providerPartId);
    }
    if (pageIndex < 0) {
      const semanticKey = timelineSemanticKey(liveItem);
      if (semanticKey) pageIndex = nextPageIndex((item) => timelineSemanticKey(item) === semanticKey);
    }
    if (pageIndex < 0 && audioOnlyComposerEcho(liveItem)) {
      const liveAt = Date.parse(liveItem.timestamp) || 0;
      pageIndex = nextPageIndex((item) => emptyCanonicalUser(item)
        && Math.abs((Date.parse(item.timestamp) || 0) - liveAt) <= maximumOptimisticEchoSkewMs);
    }
    if (pageIndex >= 0) {
      consumedPageIndexes.add(pageIndex);
      merged[pageIndex] = adopt(merged[pageIndex]!, liveItem);
      continue;
    }
    unmatched.push(liveItem);
  }
  for (const liveItem of unmatched) {
    const liveTime = Date.parse(liveItem.timestamp) || 0;
    const keep = !deduplicatedPage.length
      || composerEchoRow.test(liveItem.id)
      || liveItem.state === "running"
      || liveTime > newestPageTime
      || liveTime < oldestPageTime;
    // A settled transient row inside the page's canonical time window has been
    // superseded by that page. Only current/newer rows and genuinely older paged
    // history survive, otherwise stale reasoning shells accumulate forever.
    if (!keep) continue;
    let insertIndex = 0;
    while (insertIndex < merged.length && (Date.parse(merged[insertIndex]!.timestamp) || 0) <= liveTime) insertIndex += 1;
    merged.splice(insertIndex, 0, liveItem);
  }
  const previousById = new Map(live.map((item) => [item.id, item]));
  const stable = merged.map((item) => {
    const previous = previousById.get(item.id);
    return previous && sameTimelineItem(previous, item) ? previous : item;
  });
  return stable.length === live.length && stable.every((item, index) => item === live[index])
    ? live as TimelineItem[]
    : stable;
}
