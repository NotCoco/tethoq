'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { running, stopTethoq } = require('./stop-unpacked.cjs');
const { cleanupOldScreenshotArtifacts } = require('./fake-model/artifact-cleanup.cjs');

const appRoot = path.resolve(__dirname, '..');
const executable = path.join(appRoot, 'release', 'win-unpacked', 'Tethoq.exe');
const artifactDirectory = path.join(appRoot, 'qa-artifacts');
const reportPath = path.join(artifactDirectory, 'real-subagents.json');
const screenshotPath = path.join(artifactDirectory, 'real-subagents.png');
const hoverScreenshotPath = path.join(artifactDirectory, 'real-subagents-hover.png');
const popoverScreenshotPath = path.join(artifactDirectory, 'real-subagents-popover.png');
const debugPort = 9347;
const sessionListPollMs = 1_000;
const anchorTolerancePx = 3;
const nonTailGapPx = 80;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, description, timeoutMs = 30_000, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(pollMs);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

async function connectCdp() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
  }, 'real unpacked renderer');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data));
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result);
  });
  socket.addEventListener('close', () => rejectPending(new Error('CDP socket closed while a command was pending.')));
  socket.addEventListener('error', () => rejectPending(new Error('CDP socket failed while a command was pending.')));
  const send = (method, params = {}, timeoutMs = 45_000) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`Cannot send ${method}; the CDP socket is not open.`));
      return;
    }
    const id = ++nextId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    const entry = {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    };
    pending.set(id, entry);
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) {
      pending.delete(id);
      entry.reject(error);
    }
  });
  await Promise.all([send('Runtime.enable'), send('Page.enable')]);
  const settlePaint = async () => {
    const result = await send('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        let settled = false;
        const finish = (source) => { if (!settled) { settled = true; resolve(source); } };
        const timer = setTimeout(() => finish('timer'), 250);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); finish('animation-frame'); }));
      })`,
      awaitPromise: true,
      returnByValue: true,
    }, 5_000);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Paint settle failed.');
    await send('Page.getLayoutMetrics', {}, 5_000);
    await delay(100);
  };
  const screenshot = async (label) => {
    const errors = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await settlePaint();
        const capture = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, optimizeForSpeed: true }, 15_000);
        if (typeof capture?.data !== 'string' || capture.data.length === 0) throw new Error('Page.captureScreenshot returned no PNG data.');
        return capture.data;
      } catch (error) {
        errors.push(new AggregateError([error], `${label} screenshot attempt ${attempt} of 2 failed.`));
        if (attempt < 2) await delay(400);
      }
    }
    throw new AggregateError(errors, `${label} screenshot failed after two bounded attempts.`);
  };
  return {
    evaluate: async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Renderer evaluation failed');
      return result.result?.value;
    },
    mouseMove: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }),
    mouseClick: async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    mouseDrag: async (from, to) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let step = 1; step <= 8; step += 1) {
        const ratio = step / 8;
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: from.x + (to.x - from.x) * ratio,
          y: from.y + (to.y - from.y) * ratio,
          button: 'left',
          buttons: 1,
        });
        await delay(20);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    },
    mouseWheel: (x, y, deltaY) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }),
    screenshot,
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('CDP socket close timed out.')), 2_000);
        socket.addEventListener('close', () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
      socket.close();
      await closed;
    },
  };
}

async function pointFor(cdp, selector) {
  return waitFor(() => cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 1 && bounds.height > 1 && style.display !== 'none' && style.visibility !== 'hidden'
      ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      : null;
  })()`), selector);
}

async function selectedTaskState(cdp) {
  return cdp.evaluate(`(() => {
    const row = document.querySelector('[data-session-id] > .session-row.selected');
    const shell = row?.closest('[data-session-id]');
    return {
      id: shell?.getAttribute('data-session-id') ?? null,
      rowTitle: row?.querySelector('.session-row-title strong, .session-project-row-title strong')?.textContent?.trim() ?? null,
      workspaceTitle: document.querySelector('.workspace-title h1')?.textContent?.trim() ?? null,
    };
  })()`);
}

async function setTaskListMode(cdp, mode) {
  const current = await cdp.evaluate('window.tethoqDesktop.preferencesState()');
  if (current?.taskListMode !== mode) {
    const updated = await cdp.evaluate(`window.tethoqDesktop.preferencesAction({ type: 'set-task-list-mode', value: ${JSON.stringify(mode)} })`);
    assert.equal(updated?.taskListMode, mode, `The desktop did not accept ${mode} task-list mode.`);
  }
  return waitFor(() => cdp.evaluate(`(async () => {
    const preferences = await window.tethoqDesktop.preferencesState();
    const toggle = document.querySelector('.task-list-mode > button');
    const expectedLabel = ${JSON.stringify(mode === 'project' ? 'Arrange tasks by recency' : 'Arrange tasks by project')};
    return preferences.taskListMode === ${JSON.stringify(mode)} && toggle?.getAttribute('aria-label') === expectedLabel
      ? { taskListMode: preferences.taskListMode, toggleLabel: expectedLabel }
      : null;
  })()`), `${mode} task-list mode`, 10_000);
}

async function conversationState(cdp, expectedAnchorId = null) {
  return cdp.evaluate(`(() => {
    const scroller = document.querySelector('.conversation-scroll');
    if (!(scroller instanceof HTMLElement)) return null;
    const viewport = scroller.getBoundingClientRect();
    const expected = ${JSON.stringify(expectedAnchorId)};
    const anchors = [...scroller.querySelectorAll('[data-scroll-anchor]')];
    const contains = (node, id) => {
      if (!id) return false;
      if (node.getAttribute('data-scroll-anchor') === id) return true;
      return (node.getAttribute('data-scroll-members') ?? '').split('|').some((member) => {
        try { return decodeURIComponent(member) === id; }
        catch { return false; }
      });
    };
    const anchor = expected
      ? anchors.find((node) => contains(node, expected))
      : anchors.find((node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.bottom > viewport.top + 1 && bounds.top < viewport.bottom - 1;
      });
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const bounds = anchor?.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      maxScrollTop,
      distanceFromTail: maxScrollTop - scroller.scrollTop,
      anchorCount: anchors.length,
      anchorId: expected ?? anchor?.getAttribute('data-scroll-anchor') ?? null,
      resolvedAnchorId: anchor?.getAttribute('data-scroll-anchor') ?? null,
      anchorOffset: bounds ? bounds.top - viewport.top : null,
      historyAvailable: Boolean(document.querySelector('.history-loading')),
      historyBusy: document.querySelector('.history-loading')?.getAttribute('data-busy') === 'true',
      historySignature: anchors.slice(0, 3).map((node) => node.getAttribute('data-scroll-anchor') ?? '').join('|'),
    };
  })()`);
}

async function beginReturnAnchorTrace(cdp, expectedAnchorId) {
  return cdp.evaluate(`(() => {
    const expected = ${JSON.stringify(expectedAnchorId)};
    const startedAt = performance.now();
    const samples = [];
    window.__tethoqQaReturnAnchorTrace = { samples };
    const sample = (reason) => {
      const scroller = document.querySelector('.conversation-scroll');
      const conversation = document.querySelector('.conversation');
      if (!(scroller instanceof HTMLElement)) return;
      const viewport = scroller.getBoundingClientRect();
      const anchor = [...scroller.querySelectorAll('[data-scroll-anchor]')].find((node) =>
        node.getAttribute('data-scroll-anchor') === expected
        || (node.getAttribute('data-scroll-members') ?? '').split('|').some((member) => {
          try { return decodeURIComponent(member) === expected; }
          catch { return false; }
        }));
      const anchorBounds = anchor?.getBoundingClientRect();
      const history = document.querySelector('.history-loading');
      const historyBounds = history?.getBoundingClientRect();
      const dateBounds = document.querySelector('.conversation-date')?.getBoundingClientRect();
      const relationshipBounds = document.querySelector('.task-relationship-notices')?.getBoundingClientRect();
      const conversationBounds = conversation?.getBoundingClientRect();
      const selected = document.querySelector('[data-session-id] > .session-row.selected')?.closest('[data-session-id]');
      const next = {
        elapsedMs: Math.round(performance.now() - startedAt),
        reason,
        selectedRailId: selected?.getAttribute('data-session-id') ?? null,
        workspaceTitle: document.querySelector('.workspace-title h1')?.textContent?.trim() ?? null,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        viewportTop: viewport.top,
        anchorOffset: anchorBounds ? anchorBounds.top - viewport.top : null,
        anchorTop: anchorBounds?.top ?? null,
        anchorHeight: anchorBounds?.height ?? null,
        conversationTop: conversationBounds?.top ?? null,
        conversationHeight: conversationBounds?.height ?? null,
        historyHeight: historyBounds?.height ?? null,
        historyBusy: history?.getAttribute('data-busy') ?? null,
        dateTop: dateBounds?.top ?? null,
        dateHeight: dateBounds?.height ?? null,
        relationshipHeight: relationshipBounds?.height ?? null,
      };
      const previous = samples.at(-1);
      const comparable = ({ elapsedMs, reason, ...value }) => JSON.stringify(value);
      if (reason !== 'frame' || !previous || comparable(previous) !== comparable(next)) samples.push(next);
      if (samples.length > 80) samples.shift();
    };
    const onScroll = () => sample('scroll');
    const scroller = document.querySelector('.conversation-scroll');
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    const mutation = new MutationObserver(() => sample('mutation'));
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true });
    const resize = new ResizeObserver(() => sample('resize'));
    if (scroller instanceof Element) resize.observe(scroller);
    const conversation = document.querySelector('.conversation');
    if (conversation instanceof Element) resize.observe(conversation);
    const frame = () => {
      sample('frame');
      if (performance.now() - startedAt < 5_000) requestAnimationFrame(frame);
      else {
        scroller?.removeEventListener('scroll', onScroll);
        mutation.disconnect();
        resize.disconnect();
      }
    };
    sample('start');
    requestAnimationFrame(frame);
    return true;
  })()`);
}

async function scrollConversationToward(cdp, point, targetScrollTop, description, timeoutMs = 8_000, tolerancePx = 12) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await conversationState(cdp);
    if (latest && Math.abs(latest.scrollTop - targetScrollTop) <= tolerancePx) return latest;
    const beforeScrollTop = latest?.scrollTop ?? 0;
    const delta = Math.max(-1_000, Math.min(1_000, targetScrollTop - beforeScrollTop));
    if (Math.abs(delta) < 1) return latest;
    await cdp.mouseWheel(point.x, point.y, delta);
    // A hidden Chromium renderer may apply CDP wheel input seconds after it was
    // dispatched. Queueing another wheel every 75 ms overshoots the requested
    // position once those inputs finally drain, then falsely looks like an app
    // scroll regression. Let each real input take effect before sending another.
    latest = await waitFor(async () => {
      const current = await conversationState(cdp);
      return current && (Math.abs(current.scrollTop - beforeScrollTop) > 1
        || Math.abs(current.scrollTop - targetScrollTop) <= tolerancePx)
        ? current
        : null;
    }, `${description} wheel step`, Math.min(6_000, Math.max(1_000, deadline - Date.now())), 100);
  }
  throw new Error(`${description} timed out: ${JSON.stringify(latest)}`);
}

async function stableAnchorWindow(cdp, baseline, description, durationMs) {
  const deadline = Date.now() + durationMs;
  const samples = [];
  while (Date.now() <= deadline) {
    const sample = await conversationState(cdp, baseline.anchorId);
    samples.push({
      elapsedMs: durationMs - Math.max(0, deadline - Date.now()),
      anchorOffset: sample?.anchorOffset ?? null,
      distanceFromTail: sample?.distanceFromTail ?? null,
      resolvedAnchorId: sample?.resolvedAnchorId ?? null,
    });
    await delay(125);
  }
  const missing = samples.filter((sample) => sample.anchorOffset === null);
  const moved = samples.filter((sample) => sample.anchorOffset !== null && Math.abs(sample.anchorOffset - baseline.anchorOffset) > anchorTolerancePx);
  const returnedToTail = samples.filter((sample) => sample.distanceFromTail === null || sample.distanceFromTail < nonTailGapPx);
  assert.deepEqual(missing, [], `${description}: the preserved anchor disappeared during the stability window.`);
  assert.deepEqual(moved, [], `${description}: the preserved anchor moved after it initially looked correct: ${JSON.stringify(moved)}.`);
  assert.deepEqual(returnedToTail, [], `${description}: the reader was pulled back to the conversation tail.`);
  return {
    durationMs,
    sampleCount: samples.length,
    maximumMovementPx: Math.max(0, ...samples.map((sample) => Math.abs((sample.anchorOffset ?? baseline.anchorOffset) - baseline.anchorOffset))),
    offsets: samples.map((sample) => sample.anchorOffset),
  };
}

async function probeNativeScrollbar(cdp, mode, baseline) {
  const geometry = await cdp.evaluate(`(() => {
    const scroller = document.querySelector('.conversation-scroll');
    if (!(scroller instanceof HTMLElement)) return null;
    const bounds = scroller.getBoundingClientRect();
    const scrollbarWidth = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (scrollbarWidth < 4 || maxScrollTop < 80) return null;
    const thumbHeight = Math.max(34, Math.min(bounds.height, bounds.height * scroller.clientHeight / scroller.scrollHeight));
    const travel = Math.max(1, bounds.height - thumbHeight);
    const thumbTop = bounds.top + travel * scroller.scrollTop / maxScrollTop;
    const start = {
      x: bounds.left + scroller.clientLeft + scroller.clientWidth + scrollbarWidth / 2,
      y: thumbTop + thumbHeight / 2,
    };
    const distance = Math.min(64, Math.max(28, travel * 0.2));
    return {
      start,
      end: { x: start.x, y: Math.max(bounds.top + thumbHeight / 2, start.y - distance) },
      scrollbarWidth,
      thumbHeight,
      travel,
      scrollTop: scroller.scrollTop,
      maxScrollTop,
    };
  })()`);
  assert.ok(geometry, `${mode}: the native conversation scrollbar was not draggable.`);
  await cdp.evaluate(`(() => {
    const events = window.__tethoqQaNativeScrollbarEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'scroll']) {
      window.addEventListener(type, (event) => {
        const target = event.target;
        events.push({
          type,
          target: target instanceof Element ? target.className : null,
          clientX: 'clientX' in event ? event.clientX : null,
          clientY: 'clientY' in event ? event.clientY : null,
          buttons: 'buttons' in event ? event.buttons : null,
          scrollTop: document.querySelector('.conversation-scroll')?.scrollTop ?? null,
        });
        if (events.length > 80) events.shift();
      }, { capture: true, once: false });
    }
    return true;
  })()`);
  await cdp.mouseDrag(geometry.start, geometry.end);
  let chosen;
  try {
    chosen = await waitFor(async () => {
      const current = await conversationState(cdp);
      return current?.anchorId && current.scrollTop < geometry.scrollTop - 12 && current.distanceFromTail >= nonTailGapPx
        ? current
        : null;
    }, `${mode} native scrollbar drag`, 10_000, 100);
  } catch (error) {
    const latest = await conversationState(cdp);
    const events = await cdp.evaluate('window.__tethoqQaNativeScrollbarEvents ?? []').catch(() => []);
    throw new Error(`${mode} native scrollbar drag failed: ${JSON.stringify({ geometry, latest, events })}`, { cause: error });
  }
  const stability = await stableAnchorWindow(cdp, chosen, `${mode} native scrollbar resting position`, 1_250);

  const point = await pointFor(cdp, '.conversation-scroll');
  await scrollConversationToward(cdp, point, baseline.scrollTop, `${mode} native scrollbar baseline restore`, 10_000, 2);
  const restored = await waitFor(async () => {
    const current = await conversationState(cdp, baseline.anchorId);
    return current?.anchorOffset !== null
      && Math.abs(current.anchorOffset - baseline.anchorOffset) <= anchorTolerancePx
      && current.distanceFromTail >= nonTailGapPx
      ? current
      : null;
  }, `${mode} native scrollbar exact baseline restore`, 8_000, 100);
  await stableAnchorWindow(cdp, baseline, `${mode} native scrollbar restored baseline`, 500);
  return { geometry, chosen, stability, restored };
}

async function waitForParentReturn(cdp, { mode, parent, workspaceTitle, baseline }) {
  let latest = null;
  const description = `${mode} direct return to parent ${parent.id}`;
  try {
    return await waitFor(async () => {
      const selected = await selectedTaskState(cdp);
      const restoredReading = await conversationState(cdp, baseline.anchorId);
      latest = {
        selectedRailId: selected?.id ?? null,
        workspaceTitle: selected?.workspaceTitle ?? null,
        expectedWorkspaceTitle: workspaceTitle,
        expectedAnchorId: baseline.anchorId,
        resolvedAnchorId: restoredReading?.resolvedAnchorId ?? null,
        expectedAnchorOffset: baseline.anchorOffset,
        currentAnchorOffset: restoredReading?.anchorOffset ?? null,
        anchorOffsetDelta: restoredReading?.anchorOffset === null || restoredReading?.anchorOffset === undefined
          ? null
          : restoredReading.anchorOffset - baseline.anchorOffset,
        distanceFromTail: restoredReading?.distanceFromTail ?? null,
        scrollTop: restoredReading?.scrollTop ?? null,
        maxScrollTop: restoredReading?.maxScrollTop ?? null,
        anchorCount: restoredReading?.anchorCount ?? null,
        historyBusy: restoredReading?.historyBusy ?? null,
      };
      return selected.id === parent.id
        && selected.workspaceTitle === workspaceTitle
        && restoredReading?.anchorOffset !== null
        && Math.abs(restoredReading.anchorOffset - baseline.anchorOffset) <= anchorTolerancePx
        && restoredReading.distanceFromTail >= nonTailGapPx
        ? { ...selected, ...restoredReading }
        : null;
    }, description);
  } catch (error) {
    const trace = await cdp.evaluate('window.__tethoqQaReturnAnchorTrace?.samples ?? []').catch(() => []);
    const nativeScrollbarEvents = await cdp.evaluate('window.__tethoqQaNativeScrollbarEvents ?? []').catch(() => []);
    throw new Error(`${description} failed: ${JSON.stringify({ latest, trace, nativeScrollbarEvents })}`, { cause: error });
  }
}

async function prepareNonTailReading(cdp, mode) {
  const point = await pointFor(cdp, '.conversation-scroll');
  let state = await waitFor(async () => {
    const current = await conversationState(cdp);
    return current?.anchorId && !current.historyBusy ? current : null;
  }, `${mode} parent history`);
  state = await scrollConversationToward(cdp, point, state.maxScrollTop, `${mode} conversation tail`);
  const beforeOlderHistory = state;
  let olderHistory = { available: state.historyAvailable, triggered: false, changed: false };
  if (state.historyAvailable) {
    let attempt = 0;
    do {
      await cdp.mouseWheel(point.x, point.y, -1_000);
      await delay(75);
      state = await conversationState(cdp);
      const changed = state.scrollHeight !== beforeOlderHistory.scrollHeight
        || state.anchorCount !== beforeOlderHistory.anchorCount
        || state.historySignature !== beforeOlderHistory.historySignature
        || !state.historyAvailable;
      if (changed) break;
      attempt += 1;
    } while (attempt < 30 && state.scrollTop >= 180 && !state.historyBusy);
    assert.ok(state.scrollTop < 180 || state.historyBusy || state.scrollHeight !== beforeOlderHistory.scrollHeight || !state.historyAvailable, `${mode}: upward scrolling did not reach the older-history trigger.`);
    const afterTrigger = await waitFor(async () => {
      const current = await conversationState(cdp);
      if (!current) return null;
      const changed = current.scrollHeight !== beforeOlderHistory.scrollHeight
        || current.anchorCount !== beforeOlderHistory.anchorCount
        || current.historySignature !== beforeOlderHistory.historySignature
        || !current.historyAvailable;
      return current.historyBusy || changed ? { current, changed } : null;
    }, `${mode} older-history trigger`, 12_000);
    state = afterTrigger.current.historyBusy
      ? await waitFor(async () => {
        const current = await conversationState(cdp);
        return current && !current.historyBusy ? current : null;
      }, `${mode} older-history load`, 20_000)
      : afterTrigger.current;
    olderHistory = { available: true, triggered: true, changed: afterTrigger.changed || state.scrollHeight !== beforeOlderHistory.scrollHeight };
  } else {
    await cdp.mouseWheel(point.x, point.y, -Math.max(500, Math.round(state.clientHeight * 0.75)));
    await delay(150);
    state = await conversationState(cdp);
  }
  assert.ok(state.maxScrollTop >= nonTailGapPx, `${mode}: the selected parent has no scrollable non-tail reading position.`);
  // Older-history insertion preserves the reader's anchor and therefore may
  // rebase scrollTop. Native wheel input is quantized as well. Neither exact
  // offset is user-visible; establish the actual requirement directly: a
  // visible, settled reading position at least 80 px away from the live tail.
  state = await waitFor(async () => {
    const current = await conversationState(cdp);
    if (current?.anchorId && !current.historyBusy && current.distanceFromTail >= nonTailGapPx) return current;
    if (current && !current.historyBusy) {
      await cdp.mouseWheel(point.x, point.y, -Math.max(240, Math.round(current.clientHeight * 0.45)));
    }
    return null;
  }, `${mode} stable non-tail reading position`, 8_000, 100);
  await delay(350);
  const baseline = await conversationState(cdp);
  assert.ok(baseline?.anchorId, `${mode}: no visible anchor was available after scrolling upward.`);
  assert.ok(baseline.distanceFromTail >= nonTailGapPx, `${mode}: the deliberate reading position was still at the conversation tail.`);
  const stability = await stableAnchorWindow(cdp, baseline, `${mode} pre-navigation anchor`, 500);
  return { baseline, olderHistory, stability };
}

function displayChildTitle(session) {
  return (session.displayTitle || session.agentNickname || session.title || '').trim();
}

function subagentChildrenFor(sessions, parentId) {
  return sessions.filter((session) => session.relationship?.kind === 'subagent'
    && (session.relationship?.sourceSessionId === parentId || session.parentSessionId === parentId));
}

function formatError(error) {
  if (!(error instanceof AggregateError)) return error instanceof Error ? error.stack ?? error.message : String(error);
  const causes = [...error.errors].map((cause, index) => `Cause ${index + 1}: ${formatError(cause)}`).join('\n');
  return `${error.stack ?? error.message}\n${causes}`;
}

async function activeTaskIdentity(cdp) {
  const trigger = await pointFor(cdp, '.task-details-trigger');
  await cdp.mouseClick(trigger.x, trigger.y);
  const identity = await waitFor(() => cdp.evaluate(`(() => {
    const heading = document.querySelector('.task-details-popover h2[id^="task-subagents-"]');
    const prefix = 'task-subagents-';
    return heading?.id.startsWith(prefix) ? {
      id: heading.id.slice(prefix.length),
      title: document.querySelector('.workspace-title h1')?.textContent?.trim() ?? '',
    } : null;
  })()`), 'active task identity');
  const close = await pointFor(cdp, '[aria-label="Close task details"]');
  await cdp.mouseClick(close.x, close.y);
  await waitFor(() => cdp.evaluate(`!document.querySelector('.task-details-popover')`), 'task details close', 5_000);
  return identity;
}

async function exerciseMode({ cdp, mode, parent, selectedChild, listSessions }) {
  const modeState = await setTaskListMode(cdp, mode);
  const parentSelector = `[data-session-id="${parent.id}"] > .session-row`;
  const parentPoint = await pointFor(cdp, parentSelector);
  await cdp.mouseClick(parentPoint.x, parentPoint.y);
  const openedParent = await waitFor(async () => {
    const selected = await selectedTaskState(cdp);
    const history = await conversationState(cdp);
    return selected.id === parent.id && selected.workspaceTitle && selected.workspaceTitle === selected.rowTitle
      && history?.anchorId && !history.historyBusy
      ? { ...selected, catalogueTitle: parent.title }
      : null;
  }, `${mode} exact parent task`);

  const reading = await prepareNonTailReading(cdp, mode);
  const nativeScrollbar = await probeNativeScrollbar(cdp, mode, reading.baseline);
  const visibleParent = await waitFor(() => cdp.evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(`[data-session-id="${parent.id}"]`)});
    const trigger = row?.querySelector('.session-subagents-trigger');
    return trigger ? { label: trigger.getAttribute('aria-label') ?? '' } : null;
  })()`), `${mode} grouped parent task row`);
  const triggerSelector = `[data-session-id="${parent.id}"] .session-subagents-trigger`;
  const triggerPoint = await pointFor(cdp, triggerSelector);
  await cdp.mouseMove(triggerPoint.x, triggerPoint.y);
  const hover = await waitFor(() => cdp.evaluate(`(() => {
    const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
    const tooltips = [...document.querySelectorAll('.session-subagents-tooltip')].filter((tooltip) => {
      const style = getComputedStyle(tooltip);
      const bounds = tooltip.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && bounds.width > 1 && bounds.height > 1;
    });
    const tooltip = tooltips[0];
    const bounds = tooltip?.getBoundingClientRect();
    return tooltip && bounds ? {
      visibleCount: tooltips.length,
      text: tooltip.textContent?.trim() ?? '',
      parentIsBody: tooltip.parentElement === document.body,
      nestedTooltipSources: trigger?.querySelectorAll('[data-tooltip]').length ?? -1,
      triggerHasTooltipSource: trigger?.hasAttribute('data-tooltip') ?? true,
      bounds: { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom },
      viewport: { width: innerWidth, height: innerHeight },
    } : null;
  })()`), `${mode} real sub-agent hover tooltip`);
  assert.equal(hover.visibleCount, 1, `${mode}: the real sub-agent hover painted more than one tooltip.`);
  assert.equal(hover.text, visibleParent.label, `${mode}: the real sub-agent hover label does not match its count.`);
  assert.equal(hover.parentIsBody, true, `${mode}: the real sub-agent tooltip is trapped inside the task rail.`);
  assert.equal(hover.nestedTooltipSources, 0, `${mode}: the real sub-agent trigger contains a nested tooltip source.`);
  assert.equal(hover.triggerHasTooltipSource, false, `${mode}: the real sub-agent trigger paints the clipped pseudo-tooltip.`);
  assert.ok(hover.bounds.x >= 8 && hover.bounds.y >= 8 && hover.bounds.right <= hover.viewport.width - 7 && hover.bounds.bottom <= hover.viewport.height - 7, `${mode}: the real sub-agent hover tooltip is clipped by the viewport.`);
  await writeFile(hoverScreenshotPath, Buffer.from(await cdp.screenshot(`${mode} hover`), 'base64'));

  await cdp.mouseClick(triggerPoint.x, triggerPoint.y);
  // The popover already performs the provider-backed child lookup. The QA side
  // polls only the cheap catalogue view, slowly, and uses it to bind the exact
  // rendered title that is clicked to a durable child ID.
  const visible = await waitFor(async () => {
    const sessions = await listSessions();
    const childSessions = subagentChildrenFor(sessions, parent.id);
    const rendered = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.session-subagents-popover');
      if (!panel || panel.querySelector(':scope > p .spinner')) return null;
      const bounds = panel.getBoundingClientRect();
      const childRows = [...panel.querySelectorAll(':scope > button')].map((button) => ({
        title: button.querySelector('strong')?.textContent?.trim() ?? '',
        stateLabel: button.querySelector('small')?.textContent?.trim() ?? '',
        spinnerCount: button.querySelectorAll('.spinner').length,
        spinnerAnimation: button.querySelector('.spinner') ? getComputedStyle(button.querySelector('.spinner')).animationName : 'none',
        height: button.getBoundingClientRect().height,
      }));
      const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
      return {
        childRows,
        topLevelIds: [...document.querySelectorAll('[data-session-id]')].map((row) => row.getAttribute('data-session-id')),
        bounds: { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        triggerLabel: trigger?.getAttribute('aria-label') ?? '',
      };
    })()`);
    if (!rendered || rendered.childRows.length !== childSessions.length || !childSessions.some((session) => session.id === selectedChild.id)) return null;
    const childAssociations = childSessions.map((session) => ({
      id: session.id,
      title: session.title ?? '',
      displayTitle: displayChildTitle(session),
      state: session.state,
      providerId: session.providerId,
      parentSessionId: session.parentSessionId ?? null,
      sourceSessionId: session.relationship?.sourceSessionId ?? null,
    }));
    const expectedSpinnerSignature = childAssociations.map((child) => `${child.displayTitle}\u0000${child.state === 'working'}`).sort();
    const renderedSpinnerSignature = rendered.childRows.map((row) => `${row.title}\u0000${row.spinnerCount > 0}`).sort();
    if (!expectedSpinnerSignature.every((entry, index) => renderedSpinnerSignature[index] === entry)) return null;
    return {
      ...rendered,
      childAssociations,
    };
  }, `${mode} sub-agent popover`, 30_000, sessionListPollMs);

  assert.ok(visible.childAssociations.length > 0, `${mode}: the real grouped parent returned no children.`);
  const renderedTitles = visible.childRows.map((row) => row.title).sort((left, right) => left.localeCompare(right));
  const associatedTitles = visible.childAssociations.map((child) => child.displayTitle).sort((left, right) => left.localeCompare(right));
  assert.deepEqual(renderedTitles, associatedTitles, `${mode}: the popover titles do not identify the catalogue children.`);
  assert.equal(visible.triggerLabel, `${visible.childAssociations.length} sub-agent${visible.childAssociations.length === 1 ? '' : 's'}`, `${mode}: the parent count did not update to the live child list.`);
  assert.equal(visible.childAssociations.some((child) => visible.topLevelIds.includes(child.id)), false, `${mode}: a grouped child remained in the top-level task list.`);
  assert.ok(visible.bounds.x >= 0 && visible.bounds.y >= 0 && visible.bounds.right <= visible.viewport.width + 1 && visible.bounds.bottom <= visible.viewport.height + 1, `${mode}: the real popover is clipped by the viewport.`);
  assert.equal(visible.childRows.every((row) => row.height >= 43), true, `${mode}: a real child row lost its usable hit height.`);

  const expectedWorkingByTitle = new Map();
  for (const child of visible.childAssociations) {
    const states = expectedWorkingByTitle.get(child.displayTitle) ?? [];
    states.push(child.state === 'working');
    expectedWorkingByTitle.set(child.displayTitle, states);
  }
  const renderedWorkingByTitle = new Map();
  for (const row of visible.childRows) {
    assert.ok(row.spinnerCount === 0 || row.spinnerCount === 1, `${mode}: ${row.title} painted duplicate working spinners.`);
    if (row.spinnerCount === 1) assert.notEqual(row.spinnerAnimation, 'none', `${mode}: ${row.title} working spinner is not animated.`);
    const states = renderedWorkingByTitle.get(row.title) ?? [];
    states.push(row.spinnerCount === 1);
    renderedWorkingByTitle.set(row.title, states);
  }
  for (const [title, expectedStates] of expectedWorkingByTitle) {
    const renderedStates = renderedWorkingByTitle.get(title) ?? [];
    assert.deepEqual(renderedStates.sort(), expectedStates.sort(), `${mode}: ${title} spinner disagrees with its current provider state.`);
  }

  const selectedAssociation = visible.childAssociations.find((child) => child.id === selectedChild.id);
  assert.ok(selectedAssociation, `${mode}: the selected child ID disappeared from its exact parent.`);
  assert.equal(selectedAssociation.title, selectedChild.title, `${mode}: the selected child ID changed title association.`);
  assert.equal(selectedAssociation.sourceSessionId ?? selectedAssociation.parentSessionId, parent.id, `${mode}: the selected child no longer belongs to the chosen parent.`);
  const selectedRowIndexes = visible.childRows.flatMap((row, index) => row.title === selectedAssociation.displayTitle ? [index] : []);
  assert.equal(selectedRowIndexes.length, 1, `${mode}: ${selectedAssociation.displayTitle} is not a unique clickable child identity.`);
  const selectedRowIndex = selectedRowIndexes[0];
  await writeFile(popoverScreenshotPath, Buffer.from(await cdp.screenshot(`${mode} popover`), 'base64'));
  const childPoint = await pointFor(cdp, `.session-subagents-popover > button:nth-of-type(${selectedRowIndex + 1})`);
  await cdp.mouseClick(childPoint.x, childPoint.y);
  const openedChild = await waitFor(() => cdp.evaluate(`(() => {
    const title = document.querySelector('.workspace-title h1')?.textContent?.trim() ?? '';
    const selected = document.querySelector('[data-session-id] > .session-row.selected')?.closest('[data-session-id]')?.getAttribute('data-session-id') ?? null;
    const hasParentBack = Boolean(document.querySelector('[aria-label="Back to parent task"]'));
    if (title !== ${JSON.stringify(selectedAssociation.title)} || !hasParentBack) return null;
    return {
      title,
      selectedTopLevelId: selected,
      hasParentBack,
      rawMetadata: ['<codex_delegation>', '<source_thread_id>', 'AGENTS.md instructions', ':codex-annotation{index='].some((marker) => (document.querySelector('.conversation')?.textContent ?? '').includes(marker)),
    };
  })()`), `${mode} exact child ${selectedAssociation.id}`);
  assert.notEqual(openedChild.selectedTopLevelId, parent.id, `${mode}: the parent row remained selected after opening its child.`);
  assert.equal(openedChild.rawMetadata, false, `${mode}: the opened child exposed raw delegation or instruction metadata.`);
  const openedChildIdentity = await activeTaskIdentity(cdp);
  assert.deepEqual(openedChildIdentity, { id: selectedAssociation.id, title: selectedAssociation.title }, `${mode}: the clicked title did not open its exact catalogue child ID.`);
  await writeFile(screenshotPath, Buffer.from(await cdp.screenshot(`${mode} opened child`), 'base64'));

  const backPoint = await pointFor(cdp, '[aria-label="Back to parent task"]');
  await beginReturnAnchorTrace(cdp, reading.baseline.anchorId);
  await cdp.mouseClick(backPoint.x, backPoint.y);
  const returned = await waitForParentReturn(cdp, {
    mode,
    parent,
    workspaceTitle: openedParent.workspaceTitle,
    baseline: reading.baseline,
  });
  const returnStability = await stableAnchorWindow(cdp, reading.baseline, `${mode} return-to-parent anchor`, 1_750);
  const returnTrace = await cdp.evaluate('window.__tethoqQaReturnAnchorTrace?.samples ?? []');
  const leakedChildRows = await cdp.evaluate(`(() => {
    const childIds = new Set(${JSON.stringify(visible.childAssociations.map((child) => child.id))});
    return [...document.querySelectorAll('[data-session-id]')]
      .map((row) => row.getAttribute('data-session-id'))
      .filter((id) => id && childIds.has(id));
  })()`);
  assert.deepEqual(leakedChildRows, [], `${mode}: opening a sub-agent leaked it into the top-level task list.`);

  return {
    mode,
    modeState,
    parent: { id: parent.id, catalogueTitle: parent.title, rowTitle: openedParent.rowTitle, workspaceTitle: openedParent.workspaceTitle, triggerLabel: visibleParent.label },
    selectedChild: { ...selectedAssociation, rowIndex: selectedRowIndex, renderedTitle: visible.childRows[selectedRowIndex].title },
    reading,
    nativeScrollbar,
    hover,
    childAssociations: visible.childAssociations,
    childRows: visible.childRows,
    popoverBounds: visible.bounds,
    viewport: visible.viewport,
    openedChild,
    openedChildIdentity,
    returned,
    returnStability,
    returnTrace,
    leakedChildRows,
  };
}

async function restoreQaState(cdp, state) {
  const errors = [];
  const result = {
    originalTaskListMode: state.originalTaskListMode,
    originalSelectedSession: state.originalSelectedSession,
    selectedSessionRestored: false,
    selectedSessionRestorationFeasible: Boolean(state.originalSelectedSession?.id),
    taskListModeRestored: false,
  };
  if (state.originalSelectedSession?.id) {
    try {
      const selector = `[data-session-id="${state.originalSelectedSession.id}"] > .session-row`;
      if (!await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) await setTaskListMode(cdp, 'recent');
      const point = await pointFor(cdp, selector);
      await cdp.mouseClick(point.x, point.y);
      const selected = await waitFor(async () => {
        const current = await selectedTaskState(cdp);
        return current.id === state.originalSelectedSession.id ? current : null;
      }, 'original selected task restoration', 15_000);
      result.selectedSessionRestored = true;
      result.restoredSelectedSession = selected;
    } catch (error) { errors.push(new Error(`Selected task restoration failed: ${formatError(error)}`)); }
  }
  if (state.originalTaskListMode) {
    try {
      const restoredMode = await setTaskListMode(cdp, state.originalTaskListMode);
      result.taskListModeRestored = restoredMode.taskListMode === state.originalTaskListMode;
    } catch (error) { errors.push(new Error(`Task-list mode restoration failed: ${formatError(error)}`)); }
  }
  if (errors.length) throw new AggregateError(errors, 'Tethoq QA state restoration failed.');
  return result;
}

async function main() {
  const artifactCleanup = await cleanupOldScreenshotArtifacts(artifactDirectory);
  assert.equal(stopTethoq({ debugPort }), true, 'A visible or ambiguous Tethoq process is already running; refusing to stop it for QA.');
  await mkdir(artifactDirectory, { recursive: true });

  let appProcess;
  let cdp;
  let primaryError;
  let qaResult;
  let stateRestoration;
  let processCleanup;
  const exitState = { exited: false, code: null, signal: null, launchError: null };
  const state = { originalTaskListMode: null, originalSelectedSession: null };
  try {
    appProcess = spawn(executable, ['--hidden', `--remote-debugging-port=${debugPort}`], {
      cwd: appRoot,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    appProcess.once('exit', (code, signal) => Object.assign(exitState, { exited: true, code, signal }));
    appProcess.once('error', (error) => { exitState.launchError = error; });
    appProcess.unref();
    assert.equal(Number.isInteger(appProcess.pid), true, 'The packaged hidden QA process did not start.');

    cdp = await connectCdp();
    await waitFor(() => cdp.evaluate('Boolean(window.tethoqDesktop && document.querySelector(".desktop-app"))'), 'Tethoq shell');
    const startingPreferences = await cdp.evaluate('window.tethoqDesktop.preferencesState()');
    assert.ok(startingPreferences?.taskListMode === 'recent' || startingPreferences?.taskListMode === 'project', 'The original task-list mode was unavailable.');
    state.originalTaskListMode = startingPreferences.taskListMode;
    const originalSelection = await selectedTaskState(cdp);
    state.originalSelectedSession = originalSelection.id ? originalSelection : null;

    const expectedAuditTitles = [...new Set((process.env.TETHOQ_QA_EXPECTED_SUBAGENT_TITLES ?? '')
      .split(/\r?\n/u)
      .map((title) => title.trim())
      .filter(Boolean))];
    // Refresh the provider catalogue exactly once. Everything after discovery
    // uses sessions.list, with an enforced one-second floor between reads.
    const catalogue = await cdp.evaluate(`window.tethoqDesktop.request('sessions.refresh', {})`);
    if (!catalogue?.ok) throw new Error(catalogue?.error?.message ?? 'sessions.refresh failed');
    let nextSessionListAt = 0;
    const listSessions = async () => {
      const waitMs = nextSessionListAt - Date.now();
      if (waitMs > 0) await delay(waitMs);
      nextSessionListAt = Date.now() + sessionListPollMs;
      const response = await cdp.evaluate(`window.tethoqDesktop.request('sessions.list', {})`);
      if (!response?.ok) throw new Error(response?.error?.message ?? 'sessions.list failed');
      return response.payload?.sessions ?? [];
    };

    const discovery = await waitFor(async () => {
      const sessions = await listSessions();
      const expectedMatches = expectedAuditTitles.map((title) => sessions.filter((session) => session.title === title));
      if (expectedMatches.some((matches) => matches.length === 0)) return null;
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const grouped = new Map();
      for (const child of sessions) {
        if (child.providerId !== 'opencode' || child.relationship?.kind !== 'subagent') continue;
        const parent = byId.get(child.relationship.sourceSessionId);
        if (!parent || parent.providerId !== 'codex') continue;
        const current = grouped.get(parent.id) ?? { id: parent.id, title: parent.title ?? '', openCodeChildren: [] };
        current.openCodeChildren.push(child);
        grouped.set(parent.id, current);
      }
      if (grouped.size === 0) return null;
      const expectedMetadataReady = expectedMatches.every((matches) => matches.length !== 1 || (
        matches[0].providerId === 'opencode'
        && matches[0].relationship?.kind === 'subagent'
        && typeof matches[0].relationship?.sourceSessionId === 'string'
        && grouped.has(matches[0].relationship.sourceSessionId)
      ));
      if (!expectedMetadataReady) return null;
      return { sessions, expectedMatches, groupedParents: [...grouped.values()] };
    }, 'Codex parents with confirmed OpenCode children', 60_000, sessionListPollMs);

    const expectedAudits = expectedAuditTitles.map((title, index) => {
      const matches = discovery.expectedMatches[index];
      assert.equal(matches.length, 1, `Expected sub-agent title ${JSON.stringify(title)} matched ${matches.length} sessions; refusing an ambiguous stale result.`);
      const session = matches[0];
      assert.equal(session.relationship?.kind, 'subagent', `${title} was not classified from its exact Codex launch evidence.`);
      assert.equal(typeof session.relationship?.sourceSessionId, 'string', `${title} has no owning Codex session.`);
      assert.equal(session.providerId, 'opencode', `${title} is not the expected OpenCode child.`);
      return {
        id: session.id,
        title: session.title,
        displayTitle: displayChildTitle(session),
        providerId: session.providerId,
        state: session.state,
        relationship: session.relationship,
        parentSessionId: session.parentSessionId ?? null,
      };
    });
    const groupedParents = discovery.groupedParents.map((group) => ({
      id: group.id,
      title: group.title,
      openCodeChildIds: group.openCodeChildren.map((child) => child.id),
      openCodeChildren: group.openCodeChildren.map((child) => ({ id: child.id, title: child.title ?? '', displayTitle: displayChildTitle(child), state: child.state })),
    }));

    let parent;
    let selectedChild;
    if (expectedAudits.length) {
      selectedChild = expectedAudits[0];
      parent = discovery.groupedParents.find((group) => group.id === selectedChild.relationship.sourceSessionId);
      assert.ok(parent, `Expected child ${selectedChild.id} is not grouped beneath its exact Codex parent.`);
      for (const audit of expectedAudits) {
        assert.equal(audit.relationship.sourceSessionId, parent.id, `Expected child ${audit.id} belongs to a different parent; one navigation proof cannot satisfy both filters.`);
      }
    } else {
      const ranked = discovery.groupedParents
        .map((group) => {
          const allChildren = subagentChildrenFor(discovery.sessions, group.id);
          const uniqueChildren = group.openCodeChildren.filter((child) => allChildren.filter((candidate) => displayChildTitle(candidate) === displayChildTitle(child)).length === 1);
          return { group, uniqueChildren };
        })
        .filter((candidate) => candidate.uniqueChildren.length > 0)
        .sort((left, right) => right.group.openCodeChildren.length - left.group.openCodeChildren.length);
      assert.ok(ranked.length > 0, 'No grouped parent has a uniquely identifiable OpenCode child to click without an expected-title filter.');
      parent = ranked[0].group;
      selectedChild = ranked[0].uniqueChildren[0];
    }
    const selectedSiblings = subagentChildrenFor(discovery.sessions, parent.id);
    assert.equal(selectedSiblings.filter((child) => displayChildTitle(child) === displayChildTitle(selectedChild)).length, 1, `Selected child title ${JSON.stringify(displayChildTitle(selectedChild))} is ambiguous beneath parent ${parent.id}.`);
    assert.equal(expectedAuditTitles.length === 0 || expectedAuditTitles.includes(selectedChild.title), true, 'The actual clicked child is outside the supplied expected-title filter.');

    const modes = [];
    for (const mode of ['recent', 'project']) {
      modes.push(await exerciseMode({ cdp, mode, parent, selectedChild, listSessions }));
    }
    qaResult = {
      artifactCleanup,
      launch: { executable, arguments: ['--hidden', `--remote-debugging-port=${debugPort}`], debugPort, processId: appProcess.pid },
      expectedAuditTitles,
      expectedTitleFilterApplied: expectedAuditTitles.length > 0,
      expectedAudits,
      groupedParents,
      selectedParent: { id: parent.id, title: parent.title },
      selectedChild: { id: selectedChild.id, title: selectedChild.title, displayTitle: displayChildTitle(selectedChild) },
      originalState: { taskListMode: state.originalTaskListMode, selectedSession: state.originalSelectedSession, selectedSessionRestorationFeasible: Boolean(state.originalSelectedSession?.id) },
      modes,
      providerRefreshCount: 1,
      sessionListMinimumPollMs: sessionListPollMs,
      modelTurnsSent: 0,
      tasksCreated: 0,
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (cdp && state.originalTaskListMode) {
    try { stateRestoration = await restoreQaState(cdp, state); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cdp) {
    try { await cdp.close(); }
    catch (error) { cleanupErrors.push(new Error(`CDP cleanup failed: ${formatError(error)}`)); }
  }
  if (appProcess) {
    try {
      assert.equal(stopTethoq({ debugPort }), true, 'The hidden QA Tethoq process did not stop cleanly.');
      if (Number.isInteger(appProcess.pid)) {
        await waitFor(() => exitState.exited ? exitState : null, `QA process ${appProcess.pid} exit`, 5_000, 100);
        assert.equal(running().includes(appProcess.pid), false, `QA process ${appProcess.pid} is still running after cleanup.`);
      }
      if (exitState.launchError) throw exitState.launchError;
      processCleanup = { processId: appProcess.pid ?? null, exited: exitState.exited, exitCode: exitState.code, signal: exitState.signal, noPackagedProcessRemaining: !running().includes(appProcess.pid) };
    } catch (error) { cleanupErrors.push(new Error(`QA process cleanup failed: ${formatError(error)}`)); }
  }

  if (primaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], 'Real sub-agent QA failed and cleanup also reported errors.');
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Real sub-agent QA cleanup reported multiple errors.');

  const report = { ...qaResult, stateRestoration, processCleanup };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Real sub-agent grouping QA passed: ${reportPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
