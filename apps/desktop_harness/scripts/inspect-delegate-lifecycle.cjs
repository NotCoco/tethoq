'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const providerSessionId = String(process.argv[2] ?? '');
const debugPort = Number(process.argv[3] ?? 9225);
assert.match(providerSessionId, /^[0-9a-f-]{36}$/iu, 'Pass a persisted provider-native task ID.');
const artifactRoot = path.resolve(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'delegate-lifecycle.json');
const screenshotPath = path.join(artifactRoot, 'delegate-lifecycle.png');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let socket;
let sequence = 0;
const pending = new Map();
let task;
let originalSelectedId;
let originalTaskListMode;
let originalArchived = false;

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

async function waitFor(operation, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

async function clickExpression(expression, description) {
  const point = await waitFor(() => evaluate(`(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
  })()`), description);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function pressEscape() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

async function openDelegate() {
  await clickExpression("document.querySelector('button[aria-label=\"More message actions\"]')", 'message actions');
  await clickExpression("[...document.querySelectorAll('[role=\"menu\"][aria-label=\"More message actions\"] [role=\"menuitem\"]')].find((node) => node.textContent?.includes('Delegate task'))", 'Delegate task');
  await waitFor(() => evaluate("Boolean(document.querySelector('.delegation-chat-picker'))"), 'Delegate dialog');
}

async function restore() {
  if (!task) return;
  await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: task.id, override: { archived: originalArchived } })})`).catch(() => undefined);
  if (originalTaskListMode) {
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-list-mode', value: originalTaskListMode })})`).catch(() => undefined);
  }
  if (originalSelectedId) {
    await evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${originalSelectedId}"] > .session-row`)})?.click()`).catch(() => undefined);
  }
}

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
  assert.ok(target, 'Packaged Tethoq renderer is unavailable.');
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
  await Promise.all([send('Runtime.enable'), send('Page.enable')]);

  originalSelectedId = await evaluate("document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId ?? null");
  const preferences = await evaluate('window.tethoqDesktop.preferencesState()');
  originalTaskListMode = preferences.taskListMode;
  task = await evaluate(`(async () => {
    const refreshed = await window.tethoqDesktop.request('sessions.refresh', {});
    return refreshed?.payload?.sessions?.find((entry) => entry.providerSessionId === ${JSON.stringify(providerSessionId)}) ?? null;
  })()`);
  assert.ok(task?.id, 'Requested task is unavailable.');
  originalArchived = preferences.taskOverrides?.[task.id]?.archived === true;
  await evaluate("window.tethoqDesktop.preferencesAction({ type: 'set-task-list-mode', value: 'recent' })");
  await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: task.id, override: { archived: false } })})`);
  const taskSelector = `[data-session-id="${task.id}"] > .session-row`;
  await clickExpression(`document.querySelector(${JSON.stringify(taskSelector)})`, 'Delegate QA task');
  await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]'))"), 'task composer');

  await openDelegate();
  const initialFocus = await waitFor(() => evaluate("document.activeElement === document.querySelector('.delegation-chat-picker textarea')"), 'Delegate prompt focus');
  await clickExpression("document.querySelector('.delegation-chat-picker textarea')", 'inside Delegate dialog');
  const insideClickKeptOpen = await evaluate("Boolean(document.querySelector('.delegation-chat-picker'))");
  await pressEscape();
  const escapeClosed = await waitFor(() => evaluate("!document.querySelector('.delegation-chat-picker') && document.activeElement === document.querySelector('textarea[aria-label=\"Message\"]')"), 'Delegate Escape focus return');

  await openDelegate();
  await clickExpression("document.querySelector('button[aria-label=\"More message actions\"]')", 'focusable outside target');
  const focusableOutside = await waitFor(() => evaluate(`(() => {
    const value = {
      closed: !document.querySelector('.delegation-chat-picker'),
      focused: document.activeElement?.getAttribute('aria-label') === 'More message actions',
    };
    return value.closed && value.focused ? value : null;
  })()`), 'focusable outside dismissal');
  assert.deepEqual(focusableOutside, { closed: true, focused: true });
  await pressEscape();

  await openDelegate();
  await clickExpression("document.querySelector('.workspace-title')", 'non-focusable outside target');
  const nonFocusableOutside = await waitFor(() => evaluate(`(() => {
    const value = {
      closed: !document.querySelector('.delegation-chat-picker'),
      composerFocused: document.activeElement === document.querySelector('textarea[aria-label="Message"]'),
    };
    return value.closed && value.composerFocused ? value : null;
  })()`), 'non-focusable outside dismissal');
  assert.deepEqual(nonFocusableOutside, { closed: true, composerFocused: true });

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const report = { task: { id: task.id, providerSessionId }, initialFocus, insideClickKeptOpen, escapeClosed, focusableOutside, nonFocusableOutside, screenshotPath };
  assert.equal(report.insideClickKeptOpen, true);
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().finally(async () => {
  await restore().catch(() => undefined);
  socket?.close();
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
