'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const debugPort = Number(process.argv[2] ?? 9225);
const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'packaged-media-widgets.json');
const screenshotPath = path.join(artifactRoot, 'packaged-media-widgets.png');
const typingSuffix = 'media widget typing';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let socket;
let sequence = 0;
let stage = 'startup';
const pending = new Map();

function send(method, params = {}, timeoutMs = 10_000) {
  if (!socket) return Promise.reject(new Error('CDP is not connected'));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}

async function evaluate(expression, timeoutMs = 10_000) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Renderer evaluation failed');
  return response.result?.value;
}

async function waitFor(operation, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(80);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

async function connect() {
  const deadline = Date.now() + 10_000;
  let target;
  while (Date.now() < deadline && !target) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1_000) });
      const targets = await response.json();
      target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && /^file:/iu.test(item.url ?? ''));
    } catch {}
    if (!target) await delay(80);
  }
  if (!target) throw new Error(`No packaged renderer appeared on CDP ${debugPort}`);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket open timed out')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', (error) => { clearTimeout(timer); reject(error); }, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const response = JSON.parse(String(event.data));
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    response.error ? entry.reject(new Error(response.error.message)) : entry.resolve(response.result);
  });
  const rejectPending = () => {
    for (const entry of pending.values()) entry.reject(new Error('CDP disconnected'));
    pending.clear();
  };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('error', rejectPending);
  await send('Runtime.enable');
}

async function clickPoint(expression, description) {
  const point = await waitFor(() => evaluate(`(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return rect.width > 0 && rect.height > 0 && hit && element.contains(hit) ? { x, y } : null;
  })()`), description);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function selectSession(sessionId) {
  const expression = `document.querySelector('[data-session-id=${JSON.stringify(sessionId)}] > .session-row')`;
  let visible = await evaluate(`(() => { const element = ${expression}; if (!(element instanceof HTMLElement)) return false; const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })()`);
  if (!visible) {
    const title = await evaluate(`(async () => {
      const response = await window.tethoqDesktop.request('sessions.list');
      return response?.payload?.sessions?.find((session) => session.id === ${JSON.stringify(sessionId)})?.title ?? null;
    })()`);
    assert.ok(title, `Session ${sessionId} is not in the local catalogue`);
    const searchButton = await evaluate(`Boolean(document.querySelector('button[aria-label="Search tasks"]'))`);
    if (searchButton) await clickPoint(`document.querySelector('button[aria-label="Search tasks"]')`, 'task search button');
    await waitFor(() => evaluate(`Boolean(document.querySelector('input[aria-label="Search tasks"]'))`), 'task search field');
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Search tasks"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(title)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => evaluate(`Boolean(${expression})`), 'searched session row');
    visible = true;
  }
  if (visible) await clickPoint(expression, 'session row');
  await waitFor(() => evaluate(`${expression}?.classList.contains('selected') === true`), 'selected session');
}

async function main() {
  assert.ok(Number.isInteger(debugPort) && debugPort > 0, 'Debug port must be positive');
  await mkdir(artifactRoot, { recursive: true });
  stage = 'connect';
  await connect();
  stage = 'read local catalogue';
  const setup = await evaluate(`(async () => {
    const response = await window.tethoqDesktop.request('sessions.list');
    if (!response?.ok) throw new Error(response?.error?.message ?? 'sessions.list failed');
    const sessions = response.payload?.sessions ?? [];
    const selected = document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.getAttribute('data-session-id') ?? null;
    const target = sessions.find((session) => session.providerId === 'opencode' && session.sessionKind !== 'internal' && session.sessionKind !== 'side_chat');
    return { selected, targetId: target?.id ?? null };
  })()`);
  assert.ok(setup.targetId, 'No OpenCode task is available for file-widget QA');
  stage = 'select OpenCode task';
  await selectSession(setup.targetId);
  stage = 'read composer baseline';
  const baseline = await evaluate(`({
    draft: document.querySelector('textarea[aria-label="Message"]')?.value ?? '',
    attachments: document.querySelectorAll('.attachment-chips > *').length,
    attachmentNames: [...document.querySelectorAll('.attachment-chips strong')].map((node) => node.textContent?.trim() ?? ''),
  })`);
  if (baseline.attachments > 0) {
    assert.deepEqual(baseline.attachmentNames, ['sequence-video.mp4', 'sequence-notes.txt'], 'The target task has non-QA attachments; preserving them instead of running QA');
    await evaluate(`(() => {
      for (const button of [...document.querySelectorAll('.attachment-chips button[aria-label^="Remove "]')]) button.click();
      return true;
    })()`);
    await waitFor(() => evaluate(`document.querySelectorAll('.attachment-chips > *').length === 0`), 'stale QA attachment cleanup');
    baseline.attachments = 0;
    baseline.attachmentNames = [];
    if (baseline.draft.endsWith(typingSuffix)) baseline.draft = baseline.draft.slice(0, -typingSuffix.length);
  }

  stage = 'paste media and wait for widgets';
  const pasteStartedAt = performance.now();
  await evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Composer is unavailable');
    window.__tethoqMediaWidgetQa = { longTasks: [] };
    const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__tethoqMediaWidgetQa.longTasks.push(entry.duration); });
    try { observer.observe({ type: 'longtask' }); } catch {}
    window.__tethoqMediaWidgetQa.observer = observer;
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array(256 * 1024)], 'sequence-video.mp4', { type: 'video/mp4' }));
    clipboard.items.add(new File([new Uint8Array(128 * 1024)], 'sequence-notes.txt', { type: 'text/plain' }));
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: clipboard });
    textarea.dispatchEvent(paste);
    return true;
  })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.attachment-chips > *').length === 2
    && ![...document.querySelectorAll('.attachment-chips small')].some((node) => node.textContent?.includes('Preparing'))`), 'prepared media widgets', 5_000);
  const preparedMs = performance.now() - pasteStartedAt;
  const result = await evaluate(`(async () => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const typingStarted = performance.now();
    setter.call(textarea, ${JSON.stringify(`${baseline.draft}${typingSuffix}`)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    const inputCommitMs = performance.now() - typingStarted;
    window.__tethoqMediaWidgetQa?.observer?.disconnect?.();
    return {
      inputCommitMs,
      draft: textarea.value,
      widgets: [...document.querySelectorAll('.attachment-chips > *')].map((node) => ({
        kind: node.classList.contains('file-attachment-chip') ? 'file' : node.classList.contains('image-attachment-chip') ? 'image' : 'unknown',
        name: node.querySelector('strong')?.textContent?.trim() ?? '',
        text: node.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
      })),
      longTasks: window.__tethoqMediaWidgetQa?.longTasks ?? [],
      errors: [...document.querySelectorAll('.error-banner')].map((node) => node.textContent?.trim() ?? ''),
    };
  })()`);
  result.preparedMs = preparedMs;
  assert.deepEqual(result.widgets.map((widget) => widget.name), ['sequence-video.mp4', 'sequence-notes.txt']);
  assert.deepEqual(result.widgets.map((widget) => widget.kind), ['file', 'file']);
  assert.ok(result.inputCommitMs < 50, `Typing after mixed-file paste took ${result.inputCommitMs.toFixed(1)} ms to commit`);
  assert.ok(Math.max(0, ...result.longTasks) < 50, `Mixed-file paste created a ${Math.max(0, ...result.longTasks).toFixed(1)} ms long task`);
  assert.deepEqual(result.errors, []);
  stage = 'capture widget screenshot';
  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  stage = 'restore composer';
  await evaluate(`(() => {
    window.__tethoqMediaWidgetQa?.observer?.disconnect?.();
    delete window.__tethoqMediaWidgetQa;
    for (const button of [...document.querySelectorAll('.attachment-chips button[aria-label^="Remove "]')]) button.click();
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(baseline.draft)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.attachment-chips > *').length === 0`), 'attachment cleanup');
  const cleaned = await evaluate(`({
    attachments: document.querySelectorAll('.attachment-chips > *').length,
    draft: document.querySelector('textarea[aria-label="Message"]')?.value ?? null,
  })`);
  assert.deepEqual(cleaned, { attachments: 0, draft: baseline.draft });
  stage = 'restore selected task';
  if (setup.selected && setup.selected !== setup.targetId) await selectSession(setup.selected);
  await evaluate(`(() => {
    const search = document.querySelector('input[aria-label="Search tasks"]');
    if (!(search instanceof HTMLInputElement)) return true;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(search, '');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.blur();
    return true;
  })()`);
  const report = { ...result, cleaned, targetSessionId: setup.targetId, restoredSessionId: setup.selected, screenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Stage: ${stage}\n${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
