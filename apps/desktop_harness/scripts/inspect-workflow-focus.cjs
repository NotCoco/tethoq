'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const providerSessionId = String(process.argv[2] ?? '');
const token = String(process.argv[3] ?? '');
const debugPort = Number(process.argv[4] ?? 9225);
assert.match(providerSessionId, /^[0-9a-f-]{36}$/iu, 'Pass the provider-native task ID.');
assert.ok(token, 'Pass text that uniquely identifies the existing workflow message.');
const artifactRoot = path.resolve(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'real-workflow.json');
const screenshotPath = path.join(artifactRoot, 'real-workflow.png');

let socket;
let sequence = 0;
const pending = new Map();
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  let latest;
  while (Date.now() < deadline) {
    latest = await operation().catch(() => undefined);
    if (latest) return latest;
    await delay(100);
  }
  throw new Error(`${description} timed out; latest=${JSON.stringify(latest)}`);
}

async function clickExpression(expression, description) {
  const point = await waitFor(() => evaluate(`(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`), description);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
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
    return refreshed?.payload?.sessions?.find((entry) => entry.providerId === 'codex' && entry.providerSessionId === ${JSON.stringify(providerSessionId)}) ?? null;
  })()`);
  assert.ok(task?.id, 'Existing workflow QA task is unavailable.');
  originalArchived = preferences.taskOverrides?.[task.id]?.archived === true;
  await evaluate("window.tethoqDesktop.preferencesAction({ type: 'set-task-list-mode', value: 'recent' })");
  await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: task.id, override: { archived: false } })})`);
  await clickExpression(`document.querySelector(${JSON.stringify(`[data-session-id="${task.id}"] > .session-row`)})`, 'workflow QA task');
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${task.id}"] > .session-row`)})?.classList.contains('selected')`), 'task selection');

  const workflowButton = `[...document.querySelectorAll('.message-user')].find((row) => row.textContent?.includes(${JSON.stringify(token)}))?.querySelector('.message-workflow-chip')`;
  await clickExpression(workflowButton, 'existing workflow widget');
  await waitFor(() => evaluate("Boolean(document.querySelector('.message-workflow-panel'))"), 'workflow detail');
  const before = await evaluate(`(() => {
    const element = document.activeElement;
    return { tag: element?.tagName ?? null, className: element?.className ?? null, ariaLabel: element?.getAttribute?.('aria-label') ?? null };
  })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await delay(500);
  const after = await evaluate(`(() => {
    const element = document.activeElement;
    const row = [...document.querySelectorAll('.message-user')].find((candidate) => candidate.textContent?.includes(${JSON.stringify(token)}));
    return {
      panelOpen: Boolean(document.querySelector('.message-workflow-panel')),
      tag: element?.tagName ?? null,
      className: element?.className ?? null,
      ariaLabel: element?.getAttribute?.('aria-label') ?? null,
      connected: element?.isConnected ?? false,
      workflowWidgets: row?.querySelectorAll('.message-workflow-chip').length ?? 0,
    };
  })()`);

  await send('Page.reload', { ignoreCache: true });
  await waitFor(() => evaluate("Boolean(window.tethoqDesktop && document.querySelector('.desktop-app'))"), 'renderer reload', 60_000);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${task.id}"] > .session-row`)}))`), 'workflow task after reload', 60_000);
  await clickExpression(`document.querySelector(${JSON.stringify(`[data-session-id="${task.id}"] > .session-row`)})`, 'workflow task after reload');
  let latestReopened;
  const reopened = await waitFor(async () => {
    latestReopened = await evaluate(`(() => {
    const userRows = [...document.querySelectorAll('.message-user')].filter((row) => row.textContent?.includes(${JSON.stringify(token)}));
    const finals = [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(token)});
    const visibleText = document.querySelector('.conversation')?.textContent ?? '';
    const rawMetadata = /Files (?:mentioned|pasted) by the user/iu.test(visibleText)
      || [':codex-annotation{index=', '<codex_delegation>', '<source_thread_id>', 'promptReference'].some((marker) => visibleText.includes(marker));
    return {
      selectedSessionId: document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId ?? null,
      userCount: userRows.length,
      finalCount: finals.length,
      workflowCount: userRows[0]?.querySelectorAll('.message-workflow-chip').length ?? 0,
      rawMetadata,
      bodies: [...document.querySelectorAll('.message-body')].map((node) => node.textContent?.trim().slice(0, 180)),
      conversationText: document.querySelector('.conversation')?.textContent?.trim().slice(0, 1_000) ?? '',
    };
  })()`);
    return latestReopened.userCount === 1 && latestReopened.finalCount === 1 && latestReopened.workflowCount === 1
      ? { userCount: 1, finalCount: 1, workflowCount: 1, rawMetadata: latestReopened.rawMetadata }
      : null;
  }, 'reopened exact-once workflow turn', 30_000).catch((error) => {
    throw new Error(`${error.message}; state=${JSON.stringify(latestReopened)}`);
  });
  assert.deepEqual(reopened, { userCount: 1, finalCount: 1, workflowCount: 1, rawMetadata: false });
  await evaluate(`(() => {
    const final = [...document.querySelectorAll('.message-assistant .message-body')].find((node) => node.textContent?.trim() === ${JSON.stringify(token)});
    final?.scrollIntoView({ block: 'center', inline: 'nearest' });
  })()`);
  await delay(300);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const report = { task: { id: task.id, providerSessionId }, token, before, after, reopened, screenshotPath };
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function restore() {
  if (!task) return;
  await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: task.id, override: { archived: false } })})`).catch(() => undefined);
  if (originalArchived) {
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: task.id, override: { archived: true } })})`).catch(() => undefined);
  }
  if (originalTaskListMode) {
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-list-mode', value: originalTaskListMode })})`).catch(() => undefined);
  }
  if (originalSelectedId) {
    await evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${originalSelectedId}"] > .session-row`)})?.click()`).catch(() => undefined);
  }
}

main().finally(async () => {
  await restore().catch(() => undefined);
  socket?.close();
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
