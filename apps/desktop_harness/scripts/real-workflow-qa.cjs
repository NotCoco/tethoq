'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const providerSessionId = String(process.argv[2] ?? '');
const debugPort = Number(process.argv[3] ?? 9225);
assert.match(providerSessionId, /^[0-9a-f-]{36}$/iu, 'Pass the provider-native ID of a disposable Codex task.');

const artifactRoot = path.resolve(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'real-workflow.json');
const screenshotPath = path.join(artifactRoot, 'real-workflow.png');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let socket;
let sequence = 0;
const pending = new Map();
let task;
let originalSelectedId;
let originalTaskListMode;
let originalArchived = true;

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

async function request(type, payload = {}) {
  const response = await evaluate(`window.tethoqDesktop.request(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
  if (!response?.ok) throw new Error(response?.error?.message ?? `${type} failed`);
  return response.payload;
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

async function pointFor(expression, description) {
  return await waitFor(() => evaluate(`(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
  })()`), description);
}

async function clickExpression(expression, description) {
  const point = await pointFor(expression, description);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function clickText(selector, text, description = text) {
  await clickExpression(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent?.includes(${JSON.stringify(text)}))`, description);
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

async function selectSession(sessionId) {
  const selector = `[data-session-id=${JSON.stringify(sessionId)}] > .session-row`;
  await clickExpression(`document.querySelector(${JSON.stringify(selector)})`, 'workflow QA task row');
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected') === true`), 'workflow QA task selection');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'textarea[aria-label="Message"]\'))'), 'workflow QA composer');
}

async function openWorkflowPicker() {
  await clickExpression('document.querySelector(\'button[aria-label="Add attachment"]\')', 'attachment menu');
  await clickText('[role="menu"][aria-label="Add attachment"] [role="menuitem"]', 'Attach workflow');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'[role="dialog"][aria-label="Choose a recorded workflow"]\'))'), 'workflow picker');
}

async function restore() {
  if (task) {
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: task.id, override: { archived: originalArchived } })})`).catch(() => undefined);
  }
  if (originalTaskListMode) {
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-list-mode', value: originalTaskListMode })})`).catch(() => undefined);
  }
  if (originalSelectedId) {
    const exists = await evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${originalSelectedId}"] > .session-row`)}))`).catch(() => false);
    if (exists) await selectSession(originalSelectedId).catch(() => undefined);
  }
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  originalSelectedId = await evaluate("document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId ?? null");
  const preferences = await evaluate('window.tethoqDesktop.preferencesState()');
  originalTaskListMode = preferences.taskListMode;
  const refreshed = await request('sessions.refresh');
  task = refreshed.sessions?.find((entry) => entry.providerId === 'codex' && entry.providerSessionId === providerSessionId);
  assert.ok(task?.id, 'Disposable Codex workflow task is unavailable.');
  originalArchived = preferences.taskOverrides?.[task.id]?.archived === true;
  const workflows = await evaluate("window.tethoqDesktop.recorderAction({ type: 'list' })");
  assert.ok(Array.isArray(workflows) && workflows.length > 0, 'No local recorded workflow is available for the real journey.');
  const workflow = workflows.find((item) => item?.summary?.screenshotCount > 0) ?? workflows[0];
  assert.ok(typeof workflow?.id === 'string' && workflow.id, 'The selected workflow has no stable ID.');

  await evaluate("window.tethoqDesktop.preferencesAction({ type: 'set-task-list-mode', value: 'recent' })");
  await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: task.id, override: { archived: false } })})`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${task.id}"] > .session-row`)}))`), 'unarchived workflow task row', 45_000);
  await selectSession(task.id);
  const emptyDraft = await evaluate(`(() => ({
    text: document.querySelector('textarea[aria-label="Message"]')?.value ?? '',
    workflowChips: document.querySelectorAll('.workflow-attachment-chip').length,
  }))()`);
  assert.deepEqual(emptyDraft, { text: '', workflowChips: 0 }, 'Use a disposable task with no unsent draft or workflow attachment.');

  await openWorkflowPicker();
  await waitFor(() => evaluate(`document.activeElement?.getAttribute('data-workflow-id') === ${JSON.stringify(workflow.id)}`), 'first workflow focus');
  await press('Escape', 'Escape');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Choose a recorded workflow"]\') && document.activeElement === document.querySelector(\'textarea[aria-label="Message"]\')'), 'workflow Escape focus return');

  await openWorkflowPicker();
  await clickExpression('document.querySelector(\'button[aria-label="More message actions"]\')', 'focusable outside action');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Choose a recorded workflow"]\') && document.activeElement?.getAttribute("aria-label") === "More message actions"'), 'workflow outside-click focus ownership');
  await press('Escape', 'Escape');

  await openWorkflowPicker();
  await clickExpression(`document.querySelector(${JSON.stringify(`button[data-workflow-id="${workflow.id}"]`)})`, 'workflow row');
  await waitFor(() => evaluate(`(() => {
    const chip = document.querySelector('.workflow-attachment-chip');
    return document.querySelectorAll('.workflow-attachment-chip').length === 1
      && chip?.textContent?.includes(${JSON.stringify(workflow.name ?? 'Unnamed workflow')})
      && document.activeElement === document.querySelector('textarea[aria-label="Message"]');
  })()`), 'attached workflow chip and composer focus');

  await clickExpression("document.querySelector('.workflow-chip-link')", 'workflow draft detail link');
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`#workflow-detail-${workflow.id}`)}))`), 'selected workflow settings detail');
  let screenshotLifecycle = { available: false };
  if ((workflow.summary?.screenshotCount ?? 0) > 0) {
    await clickExpression("document.querySelector('.workflow-detail .workflow-capture-details summary')", 'workflow capture details');
    const screenshotButton = await waitFor(() => evaluate(`(() => {
      if (document.querySelector('.workflow-screenshot-empty')) return { available: false };
      const button = document.querySelector('.workflow-screenshot-item');
      return button ? { available: true } : null;
    })()`), 'workflow screenshot list');
    if (screenshotButton.available) {
      await clickExpression("document.querySelector('.workflow-screenshot-item')", 'workflow screenshot thumbnail');
      await waitFor(() => evaluate("Boolean(document.querySelector('.workflow-screenshot-lightbox'))"), 'workflow screenshot lightbox');
      await waitFor(() => evaluate("document.activeElement?.getAttribute('aria-label') === 'Close screenshot preview'"), 'workflow screenshot close focus');
      await press('Escape', 'Escape');
      await waitFor(() => evaluate("!document.querySelector('.workflow-screenshot-lightbox') && document.activeElement?.classList.contains('workflow-screenshot-item')"), 'workflow screenshot Escape return');
      screenshotLifecycle = { available: true, escapeClosed: true, focusReturned: true };
    }
  }
  await clickExpression("document.querySelector('button[aria-label=\"Close settings\"]')", 'close workflow settings');
  await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]')) && document.querySelectorAll('.workflow-attachment-chip').length === 1"), 'workflow draft after settings');

  const token = `WORKFLOW_QA_${Date.now()}`;
  const prompt = `Reply with exactly ${token} and nothing else.`;
  await clickExpression("document.querySelector('textarea[aria-label=\"Message\"]')", 'workflow prompt composer');
  await replaceFocused(prompt);
  await press('Enter', 'Enter');
  await waitFor(() => evaluate(`(() => {
    const rows = [...document.querySelectorAll('.message-user')].filter((row) => row.textContent?.includes(${JSON.stringify(token)}));
    return rows.length === 1 && rows[0].querySelectorAll('.message-workflow-chip').length === 1;
  })()`), 'sent workflow message widget', 60_000);
  await waitFor(() => evaluate(`(() => {
    const finals = [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(token)});
    return finals.length === 1;
  })()`), 'real workflow final response', 180_000);

  await clickExpression(`[...document.querySelectorAll('.message-user')].find((row) => row.textContent?.includes(${JSON.stringify(token)}))?.querySelector('.message-workflow-chip')`, 'sent workflow widget');
  await waitFor(() => evaluate("Boolean(document.querySelector('.message-workflow-panel'))"), 'sent workflow detail panel');
  await press('Escape', 'Escape');
  await waitFor(() => evaluate("!document.querySelector('.message-workflow-panel') && document.activeElement?.classList.contains('message-workflow-chip')"), 'sent workflow detail Escape focus return');

  await send('Page.reload', { ignoreCache: true });
  await waitFor(() => evaluate('Boolean(window.tethoqDesktop && document.querySelector(\'.desktop-app\'))'), 'renderer after workflow reopen', 60_000);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${task.id}"] > .session-row`)}))`), 'workflow task after reopen', 60_000);
  await selectSession(task.id);
  const reopened = await waitFor(() => evaluate(`(() => {
    const userRows = [...document.querySelectorAll('.message-user')].filter((row) => row.textContent?.includes(${JSON.stringify(token)}));
    const finals = [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(token)});
    const rawMetadata = /Files (?:mentioned|pasted) by the user|:codex-annotation\{index=|<codex_delegation>|<source_thread_id>|promptReference/iu.test(document.querySelector('.conversation')?.textContent ?? '');
    if (userRows.length !== 1 || finals.length !== 1 || userRows[0].querySelectorAll('.message-workflow-chip').length !== 1) return null;
    return { userCount: userRows.length, finalCount: finals.length, workflowCount: userRows[0].querySelectorAll('.message-workflow-chip').length, rawMetadata };
  })()`), 'reopened workflow message and final', 90_000);
  assert.deepEqual(reopened, { userCount: 1, finalCount: 1, workflowCount: 1, rawMetadata: false });

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = { task: { id: task.id, providerSessionId }, workflow: { id: workflow.id, name: workflow.name, eventCount: workflow.summary?.eventCount, screenshotCount: workflow.summary?.screenshotCount }, token, screenshotLifecycle, reopened, screenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().finally(async () => {
  try { await restore(); } catch { /* Preserve the original QA failure. */ }
  socket?.close();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
