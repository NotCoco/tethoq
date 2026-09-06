'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const providerSessionId = process.argv[2];
const debugPort = Number(process.argv[3] ?? 9225);
const imageSizeMiB = Number(process.argv[4] ?? 8);
assert.match(providerSessionId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the Codex provider session id.');
assert.ok(Number.isFinite(imageSizeMiB) && imageSizeMiB >= 1 && imageSizeMiB <= 20, 'Image size must be between 1 and 20 MiB.');

const requestedImageBytes = Math.round(imageSizeMiB * 1024 * 1024);
const fixtureName = `large-task-composer-${Date.now()}.png`;
const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'packaged-large-task-composer.json');
const screenshotPath = path.join(artifactRoot, 'packaged-large-task-composer.png');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const pending = new Map();
let socket;
let nextId = 0;

function send(method, params = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, timeoutMs = 20_000) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Renderer evaluation failed');
  return response.result?.value;
}

async function waitFor(operation, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

async function connect() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
    return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
  }, 'packaged Tethoq renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (message) => {
    const response = JSON.parse(String(message.data));
    const handler = pending.get(response.id);
    if (!handler) return;
    pending.delete(response.id);
    response.error ? handler.reject(new Error(response.error.message)) : handler.resolve(response.result);
  });
  await Promise.all([send('Runtime.enable'), send('Page.enable'), send('Profiler.enable')]);
  await evaluate('window.tethoqDesktop.showWindow()');
  await send('Page.bringToFront');
}

async function bridgeRequest(type, payload = {}) {
  const response = await evaluate(`window.tethoqDesktop.request(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
  if (!response?.ok) throw new Error(response?.error?.message ?? `${type} failed`);
  return response.payload;
}

async function click(selector) {
  const point = await waitFor(() => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return rect.width > 0 && rect.height > 0 && hit && element.contains(hit) ? { x, y } : null;
  })()`), selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function selectSession(sessionId) {
  const selector = `[data-session-id="${sessionId}"] > .session-row`;
  await click(selector);
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected') === true`), `selection of ${sessionId}`);
  await waitFor(() => evaluate(`document.querySelector('textarea[aria-label="Message"]') instanceof HTMLTextAreaElement`), 'message composer');
}

async function restoreDraft(value) {
  await evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
    return true;
  })()`);
  await waitFor(() => evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(value)}`), 'draft restoration');
}

function summary(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const at = (fraction) => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
  return {
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    p50: at(0.5),
    p95: at(0.95),
    max: ordered.at(-1) ?? 0,
  };
}

async function sampleTyping(label, count = 18) {
  await click('textarea[aria-label="Message"]');
  const initialValue = await evaluate(`(() => {
    window.__tethoqLargeTaskTyping?.cleanup?.();
    const probe = { pending: null, samples: [] };
    const onInput = (event) => {
      const textarea = event.target;
      if (!(textarea instanceof HTMLTextAreaElement) || textarea.getAttribute('aria-label') !== 'Message') return;
      const inputAt = performance.now();
      const pendingSample = probe.pending;
      probe.pending = null;
      requestAnimationFrame(() => {
        const painted = document.querySelector('textarea[aria-label="Message"]');
        if (!(painted instanceof HTMLTextAreaElement)) return;
        void painted.getBoundingClientRect();
        probe.samples.push({
          token: pendingSample?.token ?? null,
          dispatchToPaint: performance.now() - (pendingSample?.started ?? inputAt),
          eventToPaint: performance.now() - inputAt,
          value: painted.value,
        });
      });
    };
    document.addEventListener('input', onInput, true);
    probe.cleanup = () => document.removeEventListener('input', onInput, true);
    window.__tethoqLargeTaskTyping = probe;
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Message composer is unavailable');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    return textarea.value;
  })()`);
  const dispatchToPaint = [];
  const eventToPaint = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const key = String.fromCharCode(97 + index % 26);
      const token = `${label}:${index}:${Date.now()}`;
      await evaluate(`(() => {
        const textarea = document.querySelector('textarea[aria-label="Message"]');
        const probe = window.__tethoqLargeTaskTyping;
        if (!(textarea instanceof HTMLTextAreaElement) || !probe) throw new Error('Typing probe is unavailable');
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        probe.pending = { token: ${JSON.stringify(token)}, started: performance.now() };
      })()`);
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
      await send('Input.dispatchKeyEvent', { type: 'char', key, code: `Key${key.toUpperCase()}`, text: key, unmodifiedText: key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
      const measured = await waitFor(() => evaluate(`window.__tethoqLargeTaskTyping?.samples.find((sample) => sample.token === ${JSON.stringify(token)}) ?? null`), `paint for key ${index + 1}`, 5_000);
      dispatchToPaint.push(measured.dispatchToPaint);
      eventToPaint.push(measured.eventToPaint);
    }
    const finalValue = await evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value ?? null`);
    assert.equal(finalValue, `${initialValue}${Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index % 26)).join('')}`, 'Real key input diverged.');
    return { label, dispatchToPaint: summary(dispatchToPaint), eventToPaint: summary(eventToPaint) };
  } finally {
    await evaluate(`(() => { window.__tethoqLargeTaskTyping?.cleanup?.(); delete window.__tethoqLargeTaskTyping; })()`).catch(() => undefined);
  }
}

async function beginPasteProbe() {
  return evaluate(`(async () => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Message composer is unavailable');
    const beforeCount = document.querySelectorAll('.image-attachment-chip, .file-attachment-chip, .audio-attachment-chip').length;
    const longTasks = [];
    const frameGaps = [];
    let priorFrame = performance.now();
    let frame = 0;
    const onFrame = (now) => { frameGaps.push(now - priorFrame); priorFrame = now; frame = requestAnimationFrame(onFrame); };
    frame = requestAnimationFrame(onFrame);
    const observer = typeof PerformanceObserver === 'function' ? new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }) : null;
    try { observer?.observe({ type: 'longtask' }); } catch {}
    const base = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([base, new Uint8Array(${requestedImageBytes})], ${JSON.stringify(fixtureName)}, { type: 'image/png' }));
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: transfer });
    const started = performance.now();
    textarea.dispatchEvent(paste);
    const dispatchReturnedMs = performance.now() - started;
    while (document.querySelectorAll('.image-attachment-chip, .file-attachment-chip, .audio-attachment-chip').length <= beforeCount) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const widgetVisibleMs = performance.now() - started;
    window.__tethoqLargeTaskPaste = {
      started, beforeCount, longTasks, frameGaps, observer,
      stop: () => { cancelAnimationFrame(frame); observer?.disconnect(); },
    };
    return { beforeCount, dispatchReturnedMs, widgetVisibleMs };
  })()`, 30_000);
}

async function finishPasteProbe() {
  return evaluate(`(async () => {
    const probe = window.__tethoqLargeTaskPaste;
    if (!probe) return null;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    probe.stop();
    delete window.__tethoqLargeTaskPaste;
    return {
      elapsedMs: performance.now() - probe.started,
      longTasks: probe.longTasks,
      maxFrameGapMs: Math.max(0, ...probe.frameGaps),
    };
  })()`);
}

function summarizeProfile(profile) {
  const samples = new Map();
  for (const id of profile.samples ?? []) samples.set(id, (samples.get(id) ?? 0) + 1);
  const rows = profile.nodes.map((node) => ({
    samples: samples.get(node.id) ?? 0,
    functionName: node.callFrame.functionName || '(anonymous)',
    url: node.callFrame.url,
    line: node.callFrame.lineNumber + 1,
  })).filter((row) => row.samples > 0).sort((left, right) => right.samples - left.samples);
  const totalSamples = rows.reduce((sum, row) => sum + row.samples, 0);
  return {
    totalSamples,
    top: rows.slice(0, 30).map((row) => ({ ...row, percent: Number((row.samples / Math.max(1, totalSamples) * 100).toFixed(2)) })),
  };
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const startingSessionId = await evaluate(`document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.getAttribute('data-session-id') ?? null`);
  const listed = await bridgeRequest('sessions.list');
  const target = listed.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === providerSessionId);
  assert.ok(target, 'The requested large Codex task is unavailable.');
  await selectSession(target.id);
  await delay(250);

  const original = await evaluate(`(() => {
    const scroller = document.querySelector('.conversation-scroll');
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    return {
      draft: textarea?.value ?? '',
      attachments: [...document.querySelectorAll('.composer-wrap .image-attachment-chip, .composer-wrap .file-attachment-chip, .composer-wrap .audio-attachment-chip')].map((node) => node.textContent?.replace(/\\s+/gu, ' ').trim() ?? ''),
      scrollTop: scroller instanceof HTMLElement ? scroller.scrollTop : null,
      title: document.querySelector('.workspace-title h1')?.textContent?.trim() ?? null,
      anchors: document.querySelectorAll('[data-scroll-anchor]').length,
      conversationCharacters: document.querySelector('.conversation')?.textContent?.length ?? 0,
      heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null,
    };
  })()`);
  assert.ok(original.attachments.length < 4, 'The task already has four attachments; refusing to disturb the user draft.');

  const baseline = await sampleTyping('large-task baseline');
  await restoreDraft(original.draft);
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start');
  const pasteStart = await beginPasteProbe();
  const duringPreparation = await sampleTyping('large-task during image preparation', 8);
  await restoreDraft(original.draft);
  await waitFor(() => evaluate(`(() => {
    const chips = [...document.querySelectorAll('.image-attachment-chip')];
    const chip = chips.find((node) => node.textContent?.includes(${JSON.stringify(fixtureName)}));
    return Boolean(chip && !chip.querySelector('small')?.textContent?.includes('Preparing'));
  })()`), 'large image preparation', 60_000);
  const afterPreparation = await sampleTyping('large-task after image preparation');
  await restoreDraft(original.draft);
  const paste = { ...pasteStart, ...(await finishPasteProbe()) };
  const { profile } = await send('Profiler.stop', {}, 30_000);
  const cpuProfile = summarizeProfile(profile);

  const capture = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(capture.data, 'base64'));
  const removed = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.composer-wrap button[aria-label^="Remove "]')].find((node) => node.getAttribute('aria-label') === ${JSON.stringify(`Remove ${fixtureName}`)});
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(removed, true, 'The QA image could not be removed safely.');
  await waitFor(() => evaluate(`![...document.querySelectorAll('.composer-wrap .image-attachment-chip')].some((node) => node.textContent?.includes(${JSON.stringify(fixtureName)}))`), 'QA attachment removal');
  await restoreDraft(original.draft);
  if (original.scrollTop !== null) await evaluate(`(() => { const node = document.querySelector('.conversation-scroll'); if (node instanceof HTMLElement) node.scrollTop = ${JSON.stringify(original.scrollTop)}; })()`);

  const restored = await evaluate(`(() => ({
    draft: document.querySelector('textarea[aria-label="Message"]')?.value ?? '',
    attachments: [...document.querySelectorAll('.composer-wrap .image-attachment-chip, .composer-wrap .file-attachment-chip, .composer-wrap .audio-attachment-chip')].map((node) => node.textContent?.replace(/\\s+/gu, ' ').trim() ?? ''),
    qaFixturePresent: [...document.querySelectorAll('.composer-wrap .image-attachment-chip')].some((node) => node.textContent?.includes(${JSON.stringify(fixtureName)})),
  }))()`);
  assert.equal(restored.draft, original.draft, 'The task draft was not restored.');
  assert.deepEqual(restored.attachments, original.attachments, 'The task attachments were not restored exactly.');
  assert.equal(restored.qaFixturePresent, false, 'The QA attachment remained in the user task.');

  if (startingSessionId && startingSessionId !== target.id) await selectSession(startingSessionId);
  const report = {
    providerSessionId,
    sessionId: target.id,
    startingSessionId,
    imageSizeMiB,
    requestedImageBytes,
    fixtureName,
    original,
    baseline,
    paste,
    duringPreparation,
    afterPreparation,
    cpuProfile,
    restored,
    screenshotPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) {
    await evaluate(`(() => {
      window.__tethoqLargeTaskTyping?.cleanup?.();
      window.__tethoqLargeTaskPaste?.stop?.();
      delete window.__tethoqLargeTaskTyping;
      delete window.__tethoqLargeTaskPaste;
    })()`).catch(() => undefined);
  }
  socket?.close();
});
