'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const threadId = process.argv[2];
const debugPort = Number(process.argv[3] ?? 9225);
const imageSizeMiB = Number(process.argv[4] ?? 4);
const noFocus = process.argv.includes('--no-focus');
assert.match(threadId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the Codex QA thread ID.');
assert.ok(Number.isFinite(imageSizeMiB) && imageSizeMiB >= 1 && imageSizeMiB <= 24, 'Image size must be between 1 and 24 MiB. Use 20 for the final stress run.');
const requestedImageBytes = Math.round(imageSizeMiB * 1024 * 1024);
const imageSizeLabel = `${Number.isInteger(imageSizeMiB) ? imageSizeMiB : imageSizeMiB.toFixed(1)} MiB`;
// Small routine runs finish faster than CDP can type and click. Gate only job
// dispatch for that cancellation race; the explicit 20 MiB stress run remains
// fully natural and measures typing while the real worker is encoding.
const gateWorkerForCancellation = imageSizeMiB < 20;

const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'packaged-composer-lag.json');
const screenshotPath = path.join(artifactRoot, 'packaged-composer-lag.png');
const reopenScreenshotPath = path.join(artifactRoot, 'packaged-composer-lag-reopened.png');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cdpTimeoutMs = 10_000;
let socket;
let nextId = 0;
let qaSessionId = null;
let originalSelectedId = null;
let originalTaskListMode = null;
let originalArchived = false;
const pending = new Map();

async function waitFor(operation, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

function send(method, params = {}, timeoutMs = cdpTimeoutMs) {
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
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function evaluate(expression, timeoutMs = cdpTimeoutMs) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Renderer evaluation failed');
  return response.result?.value;
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
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return rect.width > 0 && rect.height > 0 && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && hit && element.contains(hit)
      ? { x, y }
      : null;
  })()`), selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function clickSession(sessionId) {
  const selector = `[data-session-id="${sessionId}"] > .session-row`;
  await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  })()`);
  await click(selector);
}

async function press(key, code = key, modifiers = 0) {
  const virtual = { Backspace: 8, a: 65 }[key] ?? key.toUpperCase().charCodeAt(0);
  const text = modifiers === 0 && key.length === 1 ? key : undefined;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers });
  if (text) {
    await send('Input.dispatchKeyEvent', { type: 'char', key, code, text, unmodifiedText: text, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual });
  }
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers });
}

async function replaceFocused(value) {
  await press('a', 'KeyA', 2);
  await press('Backspace', 'Backspace');
  if (value) await send('Input.insertText', { text: value });
}

function summarize(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0;
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1) ?? 0,
  };
}

async function connect() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
    const targets = await response.json();
    return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
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
  await send('Runtime.enable');
  await send('Page.enable');
  if (noFocus) {
    // The caller must launch Tethoq with TETHOQ_PACKAGED_SMOKE=1. That makes
    // the window Chromium-visible but fully transparent, non-interactive, and
    // absent from the taskbar, so paint timings remain real without stealing
    // the user's foreground window.
    assert.equal(await evaluate('document.visibilityState'), 'visible', 'The no-focus stress window is still renderer-hidden.');
  } else {
    // Chromium pauses requestAnimationFrame for a hidden Electron renderer.
    // Bring the real window forward so the timing probe measures actual paint.
    await evaluate('window.tethoqDesktop.showWindow()');
    await send('Page.bringToFront');
  }
}

async function clearComposer() {
  await evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(textarea, '');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    return true;
  })()`);
}

async function cleanQaComposer() {
  if (!qaSessionId || socket?.readyState !== WebSocket.OPEN) return null;
  const selector = `[data-session-id="${qaSessionId}"] > .session-row`;
  const exists = await evaluate(`document.querySelector(${JSON.stringify(selector)}) instanceof HTMLElement`, 2_000).catch(() => false);
  if (!exists) return null;
  await clickSession(qaSessionId);
  await waitFor(
    () => evaluate(`document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected') === true`, 2_000),
    'QA task selection for cleanup',
    5_000,
  );
  return evaluate(`(async () => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) return null;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(textarea, '');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    for (let pass = 0; pass < 3; pass += 1) {
      const composer = document.querySelector('.composer-wrap');
      for (const button of composer?.querySelectorAll('button[aria-label^="Remove "]') ?? []) button.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return {
      selected: document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected') === true,
      draft: textarea.value,
      attachments: document.querySelectorAll('.composer-wrap .image-attachment-chip, .composer-wrap .file-attachment-chip, .composer-wrap .audio-attachment-chip').length,
    };
  })()`, 5_000);
}

async function sampleTyping(label, count = 36) {
  await click('textarea[aria-label="Message"]');
  const dispatchToPaint = [];
  const eventToPaint = [];
  await evaluate(`(() => {
    window.__tethoqTypingProbe?.cleanup?.();
    const samples = [];
    const probe = {
      pending: null,
      samples,
      cleanup: () => document.removeEventListener('input', onInput, true),
    };
    const onInput = (event) => {
      const textarea = event.target;
      if (!(textarea instanceof HTMLTextAreaElement) || textarea.getAttribute('aria-label') !== 'Message') return;
      const inputAt = performance.now();
      const pendingSample = probe.pending;
      probe.pending = null;
      requestAnimationFrame(() => {
        const paintedTextarea = document.querySelector('textarea[aria-label="Message"]');
        if (!(paintedTextarea instanceof HTMLTextAreaElement)) return;
        void paintedTextarea.getBoundingClientRect();
        samples.push({
          token: pendingSample?.token ?? null,
          value: paintedTextarea.value,
          dispatchToPaint: performance.now() - (pendingSample?.started ?? inputAt),
          eventToPaint: performance.now() - inputAt,
        });
      });
    };
    document.addEventListener('input', onInput, true);
    window.__tethoqTypingProbe = probe;
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Message composer is unavailable');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    return true;
  })()`);
  try {
    for (let index = 0; index < count; index += 1) {
      const key = String.fromCharCode(97 + index % 26);
      const token = `${label}:${index}:${Date.now()}`;
      const before = await evaluate(`(() => {
        const probe = window.__tethoqTypingProbe;
        const textarea = document.querySelector('textarea[aria-label="Message"]');
        if (!probe || !(textarea instanceof HTMLTextAreaElement)) throw new Error('Typing probe is unavailable');
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        probe.pending = { token: ${JSON.stringify(token)}, started: performance.now() };
        return textarea.value;
      })()`);
      await press(key, `Key${key.toUpperCase()}`);
      let measured;
      try {
        measured = await waitFor(() => evaluate(`(() => {
          const probe = window.__tethoqTypingProbe;
          return probe?.samples.find((sample) => sample.token === ${JSON.stringify(token)}) ?? null;
        })()`), `painted composer value for key ${index + 1}`, 5_000);
      } catch (error) {
        const diagnostic = await evaluate(`(() => {
          const textarea = document.querySelector('textarea[aria-label="Message"]');
          return {
            value: textarea?.value ?? null,
            disabled: textarea?.disabled ?? null,
            readOnly: textarea?.readOnly ?? null,
            active: document.activeElement === textarea,
            activeElement: document.activeElement?.outerHTML?.slice(0, 400) ?? null,
            pending: window.__tethoqTypingProbe?.pending ?? null,
            samples: window.__tethoqTypingProbe?.samples ?? null,
          };
        })()`).catch(() => null);
        throw new Error(`${error instanceof Error ? error.message : error}; state=${JSON.stringify(diagnostic)}`);
      }
      assert.equal(measured.value, `${before}${key}`, `Composer value diverged after real key ${index + 1}.`);
      dispatchToPaint.push(measured.dispatchToPaint);
      eventToPaint.push(measured.eventToPaint);
    }
  } finally {
    await evaluate(`(() => {
      window.__tethoqTypingProbe?.cleanup?.();
      delete window.__tethoqTypingProbe;
      return true;
    })()`, 2_000).catch(() => undefined);
  }
  return { label, dispatchToPaint: summarize(dispatchToPaint), eventToPaint: summarize(eventToPaint) };
}

async function sampleTypingBurst(label, count = 8) {
  await click('textarea[aria-label="Message"]');
  const keys = Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index % 26));
  const initialValue = await evaluate(`(() => {
    window.__tethoqTypingProbe?.cleanup?.();
    const samples = [];
    const probe = { pending: null, samples, cleanup: () => document.removeEventListener('input', onInput, true) };
    const onInput = (event) => {
      const textarea = event.target;
      if (!(textarea instanceof HTMLTextAreaElement) || textarea.getAttribute('aria-label') !== 'Message') return;
      const inputAt = performance.now();
      const pendingSample = probe.pending;
      probe.pending = null;
      const valueAtInput = textarea.value;
      requestAnimationFrame(() => {
        const paintedTextarea = document.querySelector('textarea[aria-label="Message"]');
        if (!(paintedTextarea instanceof HTMLTextAreaElement)) return;
        void paintedTextarea.getBoundingClientRect();
        samples.push({
          token: pendingSample?.token ?? null,
          valueAtInput,
          paintedValue: paintedTextarea.value,
          dispatchToPaint: performance.now() - (pendingSample?.started ?? inputAt),
          eventToPaint: performance.now() - inputAt,
        });
      });
    };
    document.addEventListener('input', onInput, true);
    window.__tethoqTypingProbe = probe;
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Message composer is unavailable');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    return textarea.value;
  })()`);
  try {
    for (let index = 0; index < keys.length; index += 1) {
      const token = `${label}:${index}:${Date.now()}`;
      await evaluate(`(() => {
        const probe = window.__tethoqTypingProbe;
        const textarea = document.querySelector('textarea[aria-label="Message"]');
        if (!probe || !(textarea instanceof HTMLTextAreaElement)) throw new Error('Typing probe is unavailable');
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        probe.pending = { token: ${JSON.stringify(token)}, started: performance.now() };
        return true;
      })()`);
      await press(keys[index], `Key${keys[index].toUpperCase()}`);
    }
    const samples = await waitFor(() => evaluate(`(() => {
      const samples = window.__tethoqTypingProbe?.samples ?? [];
      return samples.length >= ${count} ? samples : null;
    })()`), `${count} burst typing paint samples`, 5_000);
    const finalValue = await evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value ?? null`);
    assert.equal(finalValue, `${initialValue}${keys.join('')}`, 'Composer value diverged during the real-key burst.');
    return {
      label,
      dispatchToPaint: summarize(samples.map((sample) => sample.dispatchToPaint)),
      eventToPaint: summarize(samples.map((sample) => sample.eventToPaint)),
    };
  } finally {
    await evaluate(`(() => {
      window.__tethoqTypingProbe?.cleanup?.();
      delete window.__tethoqTypingProbe;
      return true;
    })()`, 2_000).catch(() => undefined);
  }
}

async function beginLargePaste(trailingBytes, holdWorkerJob = false) {
  return evaluate(`(async () => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Message composer is unavailable');
    const base = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([base, new Uint8Array(${trailingBytes})], 'large-pasted-image.png', { type: 'image/png' }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    const longTasks = [];
    const frameGaps = [];
    let widgetSeen = false;
    let removedAt = null;
    let previousFrame = performance.now();
    let frame = 0;
    const onFrame = (now) => { frameGaps.push(now - previousFrame); previousFrame = now; frame = requestAnimationFrame(onFrame); };
    frame = requestAnimationFrame(onFrame);
    const observer = typeof PerformanceObserver === 'function'
      ? new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(entry.duration); })
      : null;
    try { observer?.observe({ type: 'longtask' }); } catch { /* Optional Chromium metric. */ }
    const mutationObserver = new MutationObserver(() => {
      const present = Boolean(document.querySelector('.image-attachment-chip'));
      if (present) widgetSeen = true;
      else if (widgetSeen && removedAt === null) removedAt = performance.now();
    });
    mutationObserver.observe(document.querySelector('.composer-wrap') ?? document.body, { childList: true, subtree: true });
    const started = performance.now();
    const postMessage = Worker.prototype.postMessage;
    const workerJobs = [];
    const heldWorkerPosts = [];
    let workerPostsReleased = ${holdWorkerJob ? 'false' : 'true'};
    const releaseWorkerJobs = () => {
      if (workerPostsReleased) return 0;
      workerPostsReleased = true;
      const pendingPosts = heldWorkerPosts.splice(0);
      for (const post of pendingPosts) post();
      return pendingPosts.length;
    };
    Worker.prototype.postMessage = function (...args) {
      const message = args[0];
      if (message?.blob instanceof Blob && Number.isFinite(message.id)) {
        const worker = this;
        const job = {
          id: message.id,
          byteLength: message.blob.size,
          postedAt: performance.now(),
          actualPostedAt: null,
          completedAt: null,
          failedAt: null,
          error: null,
          worker: this,
          listener: null,
          errorListener: null,
          messageErrorListener: null,
        };
        const detach = () => {
          if (job.listener) job.worker.removeEventListener('message', job.listener);
          if (job.errorListener) job.worker.removeEventListener('error', job.errorListener);
          if (job.messageErrorListener) job.worker.removeEventListener('messageerror', job.messageErrorListener);
          job.listener = null;
          job.errorListener = null;
          job.messageErrorListener = null;
        };
        job.listener = (workerEvent) => {
          if (workerEvent.data?.id !== job.id) return;
          job.completedAt = performance.now();
          detach();
        };
        job.errorListener = (workerEvent) => {
          job.failedAt = performance.now();
          job.error = workerEvent.message || 'Attachment worker error';
          detach();
        };
        job.messageErrorListener = () => {
          job.failedAt = performance.now();
          job.error = 'Attachment worker message could not be decoded';
          detach();
        };
        this.addEventListener('message', job.listener);
        this.addEventListener('error', job.errorListener);
        this.addEventListener('messageerror', job.messageErrorListener);
        workerJobs.push(job);
        const post = () => {
          job.actualPostedAt = performance.now();
          return postMessage.apply(worker, args);
        };
        if (!workerPostsReleased) {
          heldWorkerPosts.push(post);
          return undefined;
        }
        return post();
      }
      return postMessage.apply(this, args);
    };
    window.__tethoqPasteProbe = {
      started,
      longTasks,
      frameGaps,
      get removedAt() { return removedAt; },
      observer,
      mutationObserver,
      workerJobs,
      workerJobGate: ${holdWorkerJob ? 'true' : 'false'},
      releaseWorkerJobs,
      stop: () => {
        releaseWorkerJobs();
        cancelAnimationFrame(frame);
        observer?.disconnect();
        mutationObserver.disconnect();
        Worker.prototype.postMessage = postMessage;
        for (const job of workerJobs) {
          if (job.listener) job.worker.removeEventListener('message', job.listener);
          if (job.errorListener) job.worker.removeEventListener('error', job.errorListener);
          if (job.messageErrorListener) job.worker.removeEventListener('messageerror', job.messageErrorListener);
          job.listener = null;
          job.errorListener = null;
          job.messageErrorListener = null;
        }
      },
    };
    textarea.dispatchEvent(event);
    while (!document.querySelector('.image-attachment-chip')) await new Promise((resolve) => requestAnimationFrame(resolve));
    widgetSeen = true;
    const widgetVisibleMs = performance.now() - started;
    return { widgetVisibleMs, preparing: (document.querySelector('.image-attachment-chip small')?.textContent ?? '').includes('Preparing') };
  })()`, 15_000);
}

async function finishPasteProbe() {
  const result = await evaluate(`(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const probe = window.__tethoqPasteProbe;
    probe?.stop();
    delete window.__tethoqPasteProbe;
    return probe ? {
      elapsedMs: performance.now() - probe.started,
      longTasks: probe.longTasks,
      maxFrameGapMs: Math.max(0, ...probe.frameGaps),
      removedAtMs: probe.removedAt === null ? null : probe.removedAt - probe.started,
      workerJobGate: probe.workerJobGate,
      workerJobs: probe.workerJobs.map((job) => ({
        id: job.id,
        byteLength: job.byteLength,
        postedAtMs: job.postedAt - probe.started,
        actualPostedAtMs: job.actualPostedAt === null ? null : job.actualPostedAt - probe.started,
        completedAtMs: job.completedAt === null ? null : job.completedAt - probe.started,
        failedAtMs: job.failedAt === null ? null : job.failedAt - probe.started,
        error: job.error,
      })),
    } : null;
  })()`);
  assert.ok(result, 'Paste performance probe was lost.');
  return result;
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  originalSelectedId = await evaluate("document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId ?? null");
  const preferences = await evaluate('window.tethoqDesktop.preferencesState()');
  originalTaskListMode = preferences.taskListMode;
  const remote = await waitFor(async () => {
    const listed = await bridgeRequest('sessions.list');
    return listed.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === threadId);
  }, 'real Codex QA task');
  qaSessionId = remote.id;
  originalArchived = preferences.taskOverrides?.[remote.id]?.archived === true;
  await evaluate("window.tethoqDesktop.preferencesAction({ type: 'set-task-list-mode', value: 'recent' })");
  await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: remote.id, override: { archived: false } })})`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${remote.id}"] > .session-row`)}))`), 'unarchived stress task row');
  await clickSession(remote.id);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${remote.id}"] > .session-row')?.classList.contains('selected') === true`), 'Codex QA task selection');
  await clearComposer();
  const baseline = await sampleTyping('text-only');
  await clearComposer();

  const pendingPasteBytes = requestedImageBytes;
  const pasteStart = await beginLargePaste(pendingPasteBytes, gateWorkerForCancellation);
  await waitFor(() => evaluate(`document.querySelectorAll('.image-attachment-chip').length === 1`), 'large pasted image widget');
  await waitFor(() => evaluate(`window.__tethoqPasteProbe?.workerJobs.some((job) => job.byteLength >= ${pendingPasteBytes}) === true`), 'large attachment worker job');
  assert.equal(pasteStart.preparing, true, 'The large image completed before the pending-state test began.');
  const duringPreparation = await sampleTypingBurst(`${imageSizeLabel} pasted image during preparation`, 1);
  await click('button[aria-label="Remove large-pasted-image.png"]');
  await waitFor(() => evaluate(`document.querySelectorAll('.image-attachment-chip').length === 0`), 'pending large image removal');
  await evaluate(`window.__tethoqPasteProbe?.releaseWorkerJobs() ?? 0`);
  try {
    await waitFor(() => evaluate(`window.__tethoqPasteProbe?.workerJobs.some((job) => job.byteLength >= ${pendingPasteBytes} && (job.completedAt !== null || job.failedAt !== null)) === true`), 'removed attachment worker completion', 30_000);
  } catch (error) {
    const workerState = await evaluate(`window.__tethoqPasteProbe?.workerJobs.map((job) => ({ id: job.id, byteLength: job.byteLength, postedAt: job.postedAt, completedAt: job.completedAt, failedAt: job.failedAt, error: job.error })) ?? []`);
    throw new Error(`${error instanceof Error ? error.message : error}; workerState=${JSON.stringify(workerState)}`);
  }
  const removedWorkerState = await evaluate(`window.__tethoqPasteProbe?.workerJobs.map((job) => ({ id: job.id, byteLength: job.byteLength, postedAt: job.postedAt, completedAt: job.completedAt, failedAt: job.failedAt, error: job.error })) ?? []`);
  assert.equal(removedWorkerState.some((job) => job.byteLength >= pendingPasteBytes && job.failedAt !== null), false, `The attachment worker failed after pending attachment removal: ${JSON.stringify(removedWorkerState)}`);
  assert.equal(await evaluate(`document.querySelectorAll('.image-attachment-chip').length`), 0, 'A removed pending image reappeared after worker completion.');
  const removedPaste = await finishPasteProbe();
  const removedWorker = removedPaste.workerJobs.find((job) => job.byteLength >= pendingPasteBytes);
  assert.ok(removedPaste.removedAtMs !== null, 'The pending image removal was not painted.');
  assert.ok(removedWorker?.actualPostedAtMs !== null && removedWorker?.actualPostedAtMs !== undefined, 'The attachment job was never dispatched to the worker.');
  assert.ok(removedWorker?.completedAtMs !== null && removedWorker?.completedAtMs !== undefined, 'The removed attachment worker did not complete.');
  if (gateWorkerForCancellation) {
    assert.ok(removedPaste.removedAtMs < removedWorker.actualPostedAtMs, `The routine cancellation gate released before the image was removed: ${JSON.stringify({ removedAtMs: removedPaste.removedAtMs, actualPostedAtMs: removedWorker.actualPostedAtMs })}`);
  }
  assert.ok(removedPaste.removedAtMs < removedWorker.completedAtMs, `The worker completed before the pending image was removed: ${JSON.stringify({ removedAtMs: removedPaste.removedAtMs, completedAtMs: removedWorker.completedAtMs })}`);
  await clearComposer();

  const secondPasteStart = await beginLargePaste(2 * 1024 * 1024);
  await waitFor(() => evaluate(`document.querySelectorAll('.image-attachment-chip').length === 1`), 'second pasted image widget');
  await waitFor(() => evaluate(`!document.querySelector('.image-attachment-chip small')?.textContent?.includes('Preparing')`), 'second pasted image preparation');
  const secondPaste = { ...secondPasteStart, ...(await finishPasteProbe()) };
  const withImage = await sampleTyping('2 MiB pasted image after preparation');
  const persistedDraft = await evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value ?? ''`);

  const alternateSessionId = await evaluate(`(() => {
    const current = ${JSON.stringify(remote.id)};
    const rows = [...document.querySelectorAll('[data-session-id] > .session-row')];
    const row = rows.find((candidate) => {
      if (candidate.parentElement?.getAttribute('data-session-id') === current) return false;
      const rect = candidate.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return rect.width > 0 && rect.height > 0 && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && hit && candidate.contains(hit);
    });
    return row?.parentElement?.getAttribute('data-session-id') ?? null;
  })()`);
  assert.ok(alternateSessionId, 'No second visible task was available for the task-switch test.');
  await clickSession(alternateSessionId);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${alternateSessionId}"] > .session-row')?.classList.contains('selected') === true`), 'alternate task selection');
  await clickSession(remote.id);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${remote.id}"] > .session-row')?.classList.contains('selected') === true`), 'return to Codex QA task');
  assert.equal(await evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value`), persistedDraft, 'The typed draft changed across task switching.');
  assert.equal(await evaluate(`document.querySelectorAll('.image-attachment-chip').length`), 1, 'The prepared image disappeared across task switching.');

  const visual = await evaluate(`(() => ({
    attachmentCount: document.querySelectorAll('.image-attachment-chip').length,
    attachmentName: document.querySelector('.image-attachment-chip')?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
    errors: [...document.querySelectorAll('.error-banner')].map((node) => node.textContent?.trim() ?? ''),
    composerRect: (() => { const rect = document.querySelector('.composer-wrap')?.getBoundingClientRect(); return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null; })(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null,
  }))()`);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  const finalToken = `COMPOSER_IMAGE_SEQUENCE_${Date.now()}`;
  const finalPrompt = `Reply with exactly ${finalToken}`;
  await click('textarea[aria-label="Message"]');
  await replaceFocused(finalPrompt);
  await click('button[aria-label="Send instruction"]');
  await waitFor(() => evaluate(`[...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(finalPrompt)}).length === 1`), 'one painted image prompt');
  await waitFor(() => evaluate(`[...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(finalToken)}).length === 1 && !document.querySelector('button[aria-label="Stop task"]')`), 'one painted image final', 180_000);
  await clickSession(alternateSessionId);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${alternateSessionId}"] > .session-row')?.classList.contains('selected') === true`), 'alternate task reopen selection');
  await clickSession(remote.id);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${remote.id}"] > .session-row')?.classList.contains('selected') === true`), 'reopened Codex QA task');
  const reopened = await evaluate(`(() => {
    const userRows = [...document.querySelectorAll('.message-user')].filter((node) => node.querySelector('.message-body')?.textContent?.trim() === ${JSON.stringify(finalPrompt)});
    const finals = [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(finalToken)});
    return {
      users: userRows.length,
      userImages: userRows.reduce((count, node) => count + node.querySelectorAll('img').length, 0),
      finals: finals.length,
      rawMetadata: /Files (?:mentioned|pasted) by the user|:codex-annotation\\{index=|<codex_delegation>|<source_thread_id>/iu.test(document.querySelector('.conversation')?.textContent ?? ''),
    };
  })()`);
  const reopenScreenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(reopenScreenshotPath, Buffer.from(reopenScreenshot.data, 'base64'));
  await clearComposer();
  const cleaned = await evaluate(`({ attachments: document.querySelectorAll('.image-attachment-chip').length, draft: document.querySelector('textarea[aria-label="Message"]')?.value ?? null })`);
  const report = { threadId, sessionId: remote.id, alternateSessionId, imageSizeMiB, imageSizeLabel, requestedImageBytes, gateWorkerForCancellation, noFocus, baseline, pasteStart, duringPreparation, removedPaste, secondPaste, withImage, visual, finalPrompt, finalToken, reopened, cleaned, screenshotPath, reopenScreenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(visual.attachmentCount, 1);
  assert.equal(visual.errors.length, 0);
  assert.ok(pasteStart.widgetVisibleMs < 100, `Image widget took ${pasteStart.widgetVisibleMs.toFixed(1)} ms to appear.`);
  assert.ok(duringPreparation.dispatchToPaint.p95 < 50, `Real typing during image preparation reached paint at p95 ${duringPreparation.dispatchToPaint.p95.toFixed(1)} ms.`);
  const longestPasteTask = Math.max(0, ...removedPaste.longTasks, ...secondPaste.longTasks);
  assert.ok(longestPasteTask < 50, `Image preparation created a ${longestPasteTask.toFixed(1)} ms renderer long task.`);
  assert.ok(Math.max(removedPaste.maxFrameGapMs, secondPaste.maxFrameGapMs) < 50, `Image preparation froze animation frames for ${Math.max(removedPaste.maxFrameGapMs, secondPaste.maxFrameGapMs).toFixed(1)} ms.`);
  assert.ok(withImage.dispatchToPaint.p95 < 50, `Real post-image typing reached paint at p95 ${withImage.dispatchToPaint.p95.toFixed(1)} ms.`);
  assert.ok(visual.composerRect && visual.composerRect.bottom <= visual.viewport.height, 'The painted composer was outside the viewport.');
  assert.deepEqual(reopened, { users: 1, userImages: 1, finals: 1, rawMetadata: false });
  assert.deepEqual(cleaned, { attachments: 0, draft: '' });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) {
    await cleanQaComposer().catch(() => undefined);
    await evaluate(`(() => {
      window.__tethoqTypingProbe?.cleanup?.();
      window.__tethoqPasteProbe?.stop?.();
      delete window.__tethoqTypingProbe;
      delete window.__tethoqPasteProbe;
      return true;
    })()`, 2_000).catch(() => undefined);
    if (qaSessionId) {
      await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: qaSessionId, override: { archived: false } })})`).catch(() => undefined);
      if (originalArchived) {
        await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: qaSessionId, override: { archived: true } })})`).catch(() => undefined);
      }
    }
    if (originalTaskListMode) {
      await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-list-mode', value: originalTaskListMode })})`).catch(() => undefined);
    }
    if (originalSelectedId) {
      await evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${originalSelectedId}"] > .session-row`)})?.click()`).catch(() => undefined);
    }
  }
  socket?.close();
});
