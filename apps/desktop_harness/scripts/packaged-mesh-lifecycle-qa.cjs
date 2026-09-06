'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const providerSessionId = process.argv[2];
const debugPort = Number(process.argv[3] ?? 9241);
const requestedRestoreMode = process.argv[4];
assert.match(providerSessionId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass a Codex QA task ID.');
assert.ok(requestedRestoreMode === undefined || requestedRestoreMode === 'recent' || requestedRestoreMode === 'project', 'Restore mode must be recent or project.');

const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'packaged-mesh-lifecycle.json');
const screenshotPath = path.join(artifactRoot, 'packaged-mesh-lifecycle.png');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let socket;
let sequence = 0;
const pending = new Map();
let qaTaskId = null;
let qaStartingDraft = '';
let qaRestoreMode = requestedRestoreMode;
let qaStateRestored = false;

async function waitFor(operation, description, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
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

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Renderer evaluation failed');
  return response.result?.value;
}

async function bridgeRequest(type, payload = {}) {
  const response = await evaluate(`window.tethoqDesktop.request(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
  if (!response?.ok) throw new Error(response?.error?.message ?? `${type} failed`);
  return response.payload;
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
  await Promise.all([send('Runtime.enable'), send('Page.enable')]);
}

async function pointFor(selector) {
  return waitFor(() => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
  })()`), selector);
}

async function click(selector) {
  const point = await pointFor(selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function press(key, code = key, modifiers = 0) {
  const virtual = { Enter: 13, Escape: 27, Backspace: 8, a: 65 }[key] ?? 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers });
}

async function replaceFocused(value) {
  await press('a', 'KeyA', 2);
  await press('Backspace', 'Backspace');
  if (value) await send('Input.insertText', { text: value });
}

async function focusComposer() {
  await click('textarea[aria-label="Message"]');
}

async function openMesh() {
  await focusComposer();
  const current = await evaluate("document.querySelector('textarea[aria-label=Message]')?.value ?? ''");
  if (current) await replaceFocused('/mesh');
  else await send('Input.insertText', { text: '/mesh' });
  await waitFor(() => evaluate('Boolean(document.querySelector(\'[role="dialog"][aria-label="Mesh delegation"]\'))'), 'Mesh panel');
}

async function addFirstAvailableTarget(expectedCount) {
  await click('.mesh-add > button');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'.mesh-model-picker\'))'), 'Mesh model picker');
  await waitFor(() => evaluate("document.querySelector('.mesh-model-picker')?.contains(document.activeElement)"), 'Mesh model picker focus', 2_000);
  await waitFor(() => evaluate("!document.querySelector('.mesh-catalogue-status') && document.querySelector('.mesh-model-picker footer button.primary')?.disabled === false"), 'Mesh model catalogue', 10_000);
  const selectedModel = await evaluate("Boolean(document.querySelector('.mesh-model-picker button[role=radio][aria-checked=true]'))");
  if (!selectedModel && await evaluate("Boolean(document.querySelector('.mesh-model-picker button[role=radio]'))")) {
    await click('.mesh-model-picker button[role=radio]');
  }
  await click('.mesh-model-picker footer button.primary');
  try {
    await waitFor(() => evaluate(`document.querySelectorAll('.composer-mesh-widget').length === ${expectedCount}`), `Mesh target ${expectedCount}`, 5_000);
  } catch (error) {
    const diagnostic = await evaluate(`(() => ({
      targetCount: document.querySelectorAll('.composer-mesh-widget').length,
      targetLabels: [...document.querySelectorAll('.composer-mesh-widget-body')].map((node) => node.getAttribute('aria-label')),
      picker: Boolean(document.querySelector('.mesh-model-picker')),
      primaryDisabled: document.querySelector('.mesh-model-picker footer button.primary')?.disabled ?? null,
      catalogueLoading: Boolean(document.querySelector('.mesh-catalogue-status')),
      catalogueError: document.querySelector('.mesh-catalogue-error')?.textContent?.trim() ?? null,
      selectedModels: document.querySelectorAll('.mesh-model-picker button[role=radio][aria-checked=true]').length,
      composerValue: document.querySelector('textarea[aria-label=Message]')?.value ?? null,
    }))()`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`);
  }
  assert.equal(await evaluate("document.querySelector('textarea[aria-label=Message]')?.value"), '', 'The /mesh command leaked into the instruction.');
  await waitFor(() => evaluate("document.activeElement === document.querySelector('textarea[aria-label=Message]')"), 'composer focus after adding Mesh target', 2_000);
}

async function restoreQaState() {
  if (!socket) return;
  if (qaTaskId) {
    const selector = `[data-session-id="${qaTaskId}"] > .session-row`;
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
      await click(selector);
      await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=Message]'))"), 'composer restoration');
      for (let attempt = 0; attempt < 3 && await evaluate("Boolean(document.querySelector('.mesh-panel, .mesh-model-picker'))"); attempt += 1) {
        await press('Escape', 'Escape');
        await delay(50);
      }
      await focusComposer();
      await replaceFocused('');
      for (let remaining = Number(await evaluate("document.querySelectorAll('.composer-mesh-widget').length")); remaining > 0; remaining -= 1) {
        await press('Backspace', 'Backspace');
        await waitFor(() => evaluate(`document.querySelectorAll('.composer-mesh-widget').length === ${remaining - 1}`), `restore Mesh target ${remaining}`);
      }
      await replaceFocused(qaStartingDraft);
      assert.equal(await evaluate("document.querySelector('textarea[aria-label=Message]')?.value"), qaStartingDraft, 'The original task draft was not restored.');
    }
  }
  if (qaRestoreMode) {
    await evaluate(`window.tethoqDesktop.preferencesAction({ type: 'set-task-list-mode', value: ${JSON.stringify(qaRestoreMode)} })`);
    await waitFor(() => evaluate(`window.tethoqDesktop.preferencesState().then((value) => value.taskListMode === ${JSON.stringify(qaRestoreMode)})`), 'task mode restoration');
  }
  qaStateRestored = true;
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const startingPreferences = await evaluate('window.tethoqDesktop.preferencesState()');
  const startingMode = startingPreferences.taskListMode;
  qaRestoreMode ??= startingMode;
  if (startingMode !== 'recent') {
    await evaluate("window.tethoqDesktop.preferencesAction({ type: 'set-task-list-mode', value: 'recent' })");
    await waitFor(() => evaluate("window.tethoqDesktop.preferencesState().then((value) => value.taskListMode === 'recent')"), 'recent task mode');
  }

  const task = await waitFor(async () => {
    const sessions = (await bridgeRequest('sessions.refresh')).sessions ?? [];
    return sessions.find((session) => session.providerId === 'codex' && session.providerSessionId === providerSessionId) ?? null;
  }, 'Codex QA task');
  qaTaskId = task.id;
  const originalSessionId = await evaluate("document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId ?? null");
  await click(`[data-session-id="${task.id}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${task.id}"] > .session-row')?.classList.contains('selected') === true`), 'Codex QA task selection');
  await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=Message]'))"), 'composer');
  const startingDraft = await evaluate("document.querySelector('textarea[aria-label=Message]')?.value ?? ''");
  qaStartingDraft = startingDraft;
  await focusComposer();
  await replaceFocused('');

  await openMesh();
  const initiallyAvailable = await evaluate("document.querySelectorAll('.mesh-add > button').length");
  assert.ok(initiallyAvailable > 0, 'No real secondary coding tool was online for the packaged Mesh check.');
  const targetLimit = Math.min(4, initiallyAvailable);
  for (let target = 1; target <= targetLimit; target += 1) {
    await addFirstAvailableTarget(target);
    if (target < targetLimit) await openMesh();
  }

  await click('.composer-mesh-widget:last-child .composer-mesh-widget-body');
  await waitFor(() => evaluate("Boolean(document.querySelector('.mesh-model-picker'))"), 'fourth-or-last target editor');
  assert.equal(await evaluate("document.querySelector('.mesh-model-picker footer button.primary')?.textContent?.trim()"), 'Save target');
  await click('.mesh-model-picker footer button.primary');
  await waitFor(() => evaluate(`document.querySelectorAll('.composer-mesh-widget').length === ${targetLimit}`), 'edited target count');

  let fifthBlocked = null;
  if (targetLimit === 4) {
    await openMesh();
    fifthBlocked = await evaluate("document.querySelectorAll('.mesh-add > button').length === 0 && /Every available coding tool is referenced/u.test(document.querySelector('.mesh-panel-empty')?.textContent ?? '')");
    assert.equal(fifthBlocked, true, 'A fifth Mesh target remained available.');
  }

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  if (originalSessionId && originalSessionId !== task.id) {
    const originalSelector = `[data-session-id="${originalSessionId}"] > .session-row`;
    if (await evaluate(`Boolean(document.querySelector(${JSON.stringify(originalSelector)}))`)) await click(originalSelector);
  }
  await restoreQaState();
  const report = {
    initiallyAvailable,
    targetsAdded: targetLimit,
    editedLastTarget: true,
    fifthBlocked,
    draftRestored: true,
    preferencesRestored: true,
    screenshotPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  if (!qaStateRestored) {
    try { await restoreQaState(); }
    catch (error) {
      process.stderr.write(`Mesh QA state restoration failed: ${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    }
  }
  socket?.close();
});
