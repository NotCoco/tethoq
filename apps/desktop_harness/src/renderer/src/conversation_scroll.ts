export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Semantic row identity plus one concrete member retained across group reshapes. */
export interface ConversationScrollAnchorIdentity {
  readonly id: string;
  readonly memberToken?: string | undefined;
}

/** The first encoded member is enough to find a Reasoning group after a prepend rekeys it. */
export function firstScrollMemberToken(encodedMembers: string | undefined): string | undefined {
  return encodedMembers?.split("|").find((token) => token.length > 0);
}

/** Match either the stable row key, a row later folded into a group, or a retained group member. */
export function scrollAnchorMatches(
  anchor: ConversationScrollAnchorIdentity,
  candidateAnchorId: string | undefined,
  candidateMembers: string | undefined,
): boolean {
  if (candidateAnchorId === anchor.id) return true;
  if (!candidateMembers) return false;
  const members = candidateMembers.split("|");
  return members.includes(encodeURIComponent(anchor.id))
    || (anchor.memberToken !== undefined && members.includes(anchor.memberToken));
}

/** How close to the end counts as "following the conversation". */
export const BOTTOM_FOLLOW_GAP_PX = 72;
/** Re-follow only at the physical end; the wider gap is display tolerance, not consent. */
export const BOTTOM_REATTACH_GAP_PX = 1;
/** How far from the ceiling the next page of history is requested. */
export const HISTORY_PREFETCH_PX = 240;
export const HISTORY_PAGE_LIMIT = 40;

/** Keep the furthest older boundary when a newest-page refresh races the reader. */
export function retainedHistoryCursor(existing: string | null, refreshed: string | null): string | null {
  if (existing === null) return null;
  if (refreshed === null) return existing;
  const current = Number.parseInt(existing, 10);
  const next = Number.parseInt(refreshed, 10);
  if (!Number.isInteger(current) || !Number.isInteger(next)) {
    // Provider-page cursors carry the provider's snapshot boundary. A refresh
    // can replace that boundary (Codex uses an opaque byte-offset cursor), so
    // retaining the old string guarantees that the next older-page request is
    // rejected as expired. Stable message anchors remain safe to retain, but
    // once either side is provider-owned the refreshed boundary is authoritative.
    if (existing.startsWith("provider-page:") || refreshed.startsWith("provider-page:")) return refreshed;
    return existing;
  }
  return String(Math.min(current, next));
}

/** True when the bridge rejected a page because its snapshot boundary expired. */
export function isHistoryPageExpired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /message history page expired|history cursor expired/iu.test(message);
}

/** A reverse page above one full page cannot truthfully exhaust at this cursor. */
export function historyPageNeedsRebase(requestedCursor: string, nextCursor: string | null, limit = HISTORY_PAGE_LIMIT): boolean {
  const requested = Number.parseInt(requestedCursor, 10);
  return nextCursor === null && Number.isInteger(requested) && requested > limit;
}

export function maxScrollTop(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

export function clampScrollTop(metrics: ScrollMetrics, top: number): number {
  return Math.max(0, Math.min(top, maxScrollTop(metrics)));
}

/**
 * Distance from the reader to the end of the content. Prepending history leaves
 * this untouched, which is what makes it a stable anchor across a load: the
 * height of the arriving page never has to be known or measured.
 */
export function distanceFromEnd(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop;
}

/** Scroll offset that puts the reader back on the line the anchor was taken at. */
export function anchoredScrollTop(metrics: ScrollMetrics, anchor: number): number {
  return clampScrollTop(metrics, metrics.scrollHeight - anchor);
}

export function isAtBottom(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < BOTTOM_FOLLOW_GAP_PX;
}

/** The true end of the scrollbar, not the wider visual follow tolerance. */
export function isAtPhysicalBottom(metrics: ScrollMetrics): boolean {
  return maxScrollTop(metrics) - metrics.scrollTop <= BOTTOM_REATTACH_GAP_PX;
}

/**
 * The reader has stepped off the end of the content under their own power.
 *
 * `isAtBottom`'s gap is a tolerance for following, not a description of where the
 * reader is, so it cannot decide this: a wheel gesture crosses the first few
 * pixels of that gap before it crosses anything else, and re-following on it
 * alone re-attaches the reader in the opening frames of every scroll away, which
 * the next commit answers by writing them back down. Only leaving the true end
 * counts. A shrinking timeline clamps `scrollTop` down while the reader is still
 * sitting on that end, and that must keep following.
 */
export function movedOffEnd(metrics: ScrollMetrics, previousScrollTop: number): boolean {
  return metrics.scrollTop < previousScrollTop - 1 && maxScrollTop(metrics) - metrics.scrollTop > 1;
}

/**
 * Re-follow only when the reader moves down to the physical end themselves.
 *
 * Content collapsing can clamp an untouched viewport downward until it happens
 * to be inside the 72px display gap. Treating that passive layout change—or a
 * scrollbar thumb deliberately left just above the end—as a return to the end
 * makes the next render finish a move the reader never requested.
 */
export function readerReturnedToEnd(metrics: ScrollMetrics, previousScrollTop: number, readerInitiated: boolean): boolean {
  return readerInitiated
    && metrics.scrollTop > previousScrollTop + 1
    && isAtPhysicalBottom(metrics);
}

export function shouldRequestOlder(metrics: ScrollMetrics): boolean {
  return metrics.scrollTop < HISTORY_PREFETCH_PX;
}
