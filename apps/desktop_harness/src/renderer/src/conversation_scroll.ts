export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How close to the end counts as "following the conversation". */
export const BOTTOM_FOLLOW_GAP_PX = 72;
/** How far from the ceiling the next page of history is requested. */
export const HISTORY_PREFETCH_PX = 240;

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

export function shouldRequestOlder(metrics: ScrollMetrics): boolean {
  return metrics.scrollTop < HISTORY_PREFETCH_PX;
}
