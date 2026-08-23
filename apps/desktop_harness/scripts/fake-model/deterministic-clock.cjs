'use strict';

/**
 * Test-only clock for the deterministic fake model.
 *
 * The manual clock records every scheduled callback and only fires it when the
 * test advances time, so a whole scenario play is reproducible: the same
 * scenario, session, and start time always produce the same events at the same
 * offsets. The Electron QA driver uses the real clock instead so its scenario
 * playback follows wall-clock time while the renderer paints.
 */

const FIXTURE_BASE_ISO = '2026-08-21T12:00:00.000Z';

function createManualClock(startIso = FIXTURE_BASE_ISO) {
  let nowMs = Date.parse(startIso);
  if (!Number.isFinite(nowMs)) throw new Error(`Fake model clock needs a parseable start time: ${startIso}`);
  const timers = [];
  let nextHandle = 1;
  return {
    kind: 'manual',
    nowMs: () => nowMs,
    nowIso: () => new Date(nowMs).toISOString(),
    schedule(callback, delayMs) {
      const handle = nextHandle++;
      timers.push({ handle, at: nowMs + delayMs, callback });
      return handle;
    },
    cancel(handle) {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    /** Advances the clock and fires every timer that came due, earliest first. */
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`Fake model clock advances by a non-negative duration: ${ms}`);
      nowMs += ms;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const due = timers.find((timer) => timer.at <= nowMs);
        if (!due) return;
        timers.splice(timers.indexOf(due), 1);
        due.callback();
      }
    },
    pendingCount: () => timers.length,
    cancelAll() {
      timers.length = 0;
    },
  };
}

function createRealClock() {
  return {
    kind: 'real',
    nowMs: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    schedule(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    cancel(handle) {
      clearTimeout(handle);
    },
  };
}

module.exports = { FIXTURE_BASE_ISO, createManualClock, createRealClock };
