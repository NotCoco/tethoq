'use strict';

const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');

const providerSessionId = process.argv[2];
const port = Number(process.argv[3] ?? 9225);
const screenshotPath = process.argv[4];
const reportPath = screenshotPath ? screenshotPath.replace(/\.[^.]+$/u, '.json') : undefined;
assert.match(providerSessionId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the Codex provider session id.');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let socket;
let sequence = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result?.value;
}

async function waitFor(operation, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await operation();
    if (latest) return latest;
    await delay(25);
  }
  throw new Error(`${description} timed out; latest=${JSON.stringify(latest)}`);
}

async function connect() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
    return (await response.json()).find((entry) => entry.type === 'page'
      && entry.webSocketDebuggerUrl
      && /^file:/iu.test(entry.url ?? ''));
  }, 'Tethoq renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data));
    const handler = pending.get(value.id);
    if (!handler) return;
    pending.delete(value.id);
    value.error ? handler.reject(new Error(value.error.message)) : handler.resolve(value.result);
  });
  await Promise.all([send('Runtime.enable'), send('Page.enable')]);
}

async function point(selector) {
  return waitFor(() => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`), selector);
}

async function click(selector) {
  const location = await point(selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: location.x, y: location.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: location.x, y: location.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function state() {
  return evaluate(`(() => {
    const scroller = document.querySelector('.conversation-scroll');
    if (!(scroller instanceof HTMLElement)) return null;
    const anchors = [...document.querySelectorAll('[data-scroll-anchor]')].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.getAttribute('data-scroll-anchor') ?? '',
        members: node.getAttribute('data-scroll-members') ?? '',
        top: rect.top,
        bottom: rect.bottom,
        text: node.textContent?.trim().replace(/\\s+/gu, ' ').slice(0, 160) ?? '',
      };
    });
    const ids = anchors.map((anchor) => anchor.id);
    return {
      anchors,
      duplicateAnchorIds: [...new Set(ids.filter((id, index) => id && ids.indexOf(id) !== index))],
      busy: document.querySelector('.history-loading')?.getAttribute('data-busy') === 'true',
      hasHistoryControl: Boolean(document.querySelector('.history-loading')),
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      topText: anchors.slice(0, 2).map((anchor) => anchor.text),
    };
  })()`);
}

function anchorContains(anchor, id) {
  if (anchor.id === id) return true;
  return anchor.members.split('|').some((member) => {
    try { return decodeURIComponent(member) === id; }
    catch { return false; }
  });
}

function anchorForId(anchors, id) {
  return anchors.find((anchor) => anchorContains(anchor, id));
}

async function main() {
  await connect();
  let refresh = await evaluate(`window.tethoqDesktop.request('sessions.refresh')`);
  let task = refresh?.payload?.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === providerSessionId);
  if (!task) {
    const sampleSessionId = refresh?.payload?.sessions?.[0]?.id;
    assert.equal(typeof sampleSessionId, 'string', 'No real session was available to identify the local host.');
    const encodedHostId = sampleSessionId.split('/')[0];
    const globalSessionId = `${encodedHostId}/codex/${encodeURIComponent(providerSessionId)}`;
    const opened = await evaluate(`window.tethoqDesktop.request('session.open', ${JSON.stringify({ sessionId: globalSessionId, limit: 40 })})`);
    assert.equal(opened?.ok, true, `Unable to warm the requested Codex task: ${opened?.error?.message ?? 'unknown error'}`);
    await send('Page.reload', { ignoreCache: false });
    socket.close();
    await delay(100);
    await connect();
    await waitFor(() => evaluate(`Boolean(window.tethoqDesktop && document.querySelector('.desktop-app'))`), 'Tethoq renderer reload');
    refresh = await evaluate(`window.tethoqDesktop.request('sessions.list')`);
    task = refresh?.payload?.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === providerSessionId);
  }
  assert.ok(task, 'Requested Codex task is unavailable.');
  const row = `[data-session-id="${task.id}"] > .session-row`;
  if (!await evaluate(`Boolean(document.querySelector(${JSON.stringify(row)}))`)) {
    await click('button[aria-label="Search tasks"]');
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Search tasks"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(task.title)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(row)}))`), 'requested task search result');
  }
  await click(row);
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(row)})?.classList.contains('selected') === true`), 'task selection');
  await waitFor(async () => {
    const value = await state();
    return value && value.anchors.length > 0 && !value.busy ? value : null;
  }, 'initial history');
  await delay(350);

  const before = await state();
  assert.equal(before.hasHistoryControl, true, 'The real long task must advertise older history.');
  assert.deepEqual(before.duplicateAnchorIds, [], 'Initial transcript contains duplicate stable anchor IDs.');
  const beforeIds = new Set(before.anchors.map((anchor) => anchor.id));
  const location = await point('.conversation-scroll');
  const scrollStarted = performance.now();
  let reachedTop = before;
  while (reachedTop.scrollTop > 1 && performance.now() - scrollStarted < 20_000) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: location.x, y: location.y, deltaX: 0, deltaY: -1200 });
    await delay(25);
    reachedTop = await state();
  }
  assert.ok(reachedTop.scrollTop <= 1, `Reader wheel did not reach the loaded-history top; latest=${JSON.stringify(reachedTop)}`);
  const historyStarted = performance.now();
  const reference = reachedTop.anchors[0];
  assert.ok(reference?.id, 'Loaded transcript has no stable oldest anchor at its ceiling.');
  const referenceCanStayFixed = reachedTop.scrollHeight - reachedTop.clientHeight > 3;
  let latestOlderState = reachedTop;
  let loaded;
  try {
    loaded = await waitFor(async () => {
      const value = await state();
      if (value) latestOlderState = value;
      const referenceIndex = value?.anchors.findIndex((anchor) => anchorContains(anchor, reference.id)) ?? -1;
      const addedBeforeReference = value?.anchors.filter(
        (anchor, index) => !beforeIds.has(anchor.id) && index < referenceIndex,
      ) ?? [];
      const preserved = value ? anchorForId(value.anchors, reference.id) : undefined;
      const referenceStayedFixed = preserved && Math.abs(preserved.top - reference.top) <= 3;
      return value && !value.busy && addedBeforeReference.length > 0 && preserved && (!referenceCanStayFixed || referenceStayedFixed) ? value : null;
    }, 'a distinct older conversation anchor becoming visible', 10_000);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; before=${JSON.stringify(before)}; reachedTop=${JSON.stringify(reachedTop)}; latest=${JSON.stringify(latestOlderState)}`);
  }
  const visibleMs = performance.now() - historyStarted;
  const scrollTravelMs = historyStarted - scrollStarted;
  const loadedIds = loaded.anchors.map((anchor) => anchor.id);
  const referenceIndex = loaded.anchors.findIndex((anchor) => anchorContains(anchor, reference.id));
  const addedAnchors = loaded.anchors.filter(
    (anchor, index) => !beforeIds.has(anchor.id) && index < referenceIndex,
  );
  const survivingBeforeIndexes = before.anchors.map((anchor) => loaded.anchors.findIndex((candidate) => anchorContains(candidate, anchor.id)));
  assert.deepEqual(loaded.duplicateAnchorIds, [], 'Older-history prepend produced duplicate stable anchor IDs.');
  assert.ok(addedAnchors.length > 0, `No older anchor was prepended before the previous oldest row: ${JSON.stringify({ reference: reference.id, loadedIds })}`);
  assert.ok(survivingBeforeIndexes.every((index) => index >= 0), `A previously visible row disappeared during prepend: ${JSON.stringify({ beforeIds: before.anchors.map((anchor) => anchor.id), survivingBeforeIndexes, loadedIds })}`);
  assert.ok(survivingBeforeIndexes.every((index, ordinal) => ordinal === 0 || index >= survivingBeforeIndexes[ordinal - 1]), `Previously visible rows changed order during prepend: ${JSON.stringify({ beforeIds: before.anchors.map((anchor) => anchor.id), survivingBeforeIndexes, loadedIds })}`);
  const referenceAfter = anchorForId(loaded.anchors, reference.id);
  assert.ok(referenceAfter, 'The reader anchor disappeared while older history loaded.');
  if (referenceCanStayFixed) {
    assert.ok(Math.abs(referenceAfter.top - reference.top) <= 3, `Reader anchor moved by ${Math.round(referenceAfter.top - reference.top)}px while older history loaded.`);
  } else {
    assert.ok(Math.abs(addedAnchors[0].top - reference.top) <= 3, `Older history did not fill the previously unused space at the reading edge: ${JSON.stringify({ oldTop: reference.top, olderTop: addedAnchors[0].top })}`);
  }
  assert.ok(visibleMs < 2_000, `Older conversation took ${Math.round(visibleMs)}ms to appear.`);
  if (screenshotPath) {
    const capture = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85, fromSurface: true });
    await writeFile(screenshotPath, Buffer.from(capture.data, 'base64'));
  }
  const report = {
    providerSessionId,
    visibleMs,
    scrollTravelMs,
    addedAnchorIds: addedAnchors.map((anchor) => anchor.id),
    referenceAnchorId: reference.id,
    referenceMovementPx: referenceAfter.top - reference.top,
    referenceCanStayFixed,
    before,
    reachedTop,
    loaded,
    ...(screenshotPath ? { screenshotPath } : {}),
  };
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    providerSessionId,
    visibleMs,
    scrollTravelMs,
    addedAnchorCount: addedAnchors.length,
    referenceMovementPx: referenceAfter.top - reference.top,
    duplicateAnchorIds: loaded.duplicateAnchorIds,
    ...(reportPath ? { reportPath } : {}),
    ...(screenshotPath ? { screenshotPath } : {}),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
