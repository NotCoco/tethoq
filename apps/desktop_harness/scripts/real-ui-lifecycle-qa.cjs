'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const threadId = process.argv[2];
const debugPort = Number(process.argv[3] ?? 9225);
assert.match(threadId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the Codex QA thread ID.');

const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'real-ui-lifecycle.json');
const screenshotPath = path.join(artifactRoot, 'real-ui-lifecycle.png');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pending = new Map();

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

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
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

async function pointFor(selector, text) {
  return waitFor(() => evaluate(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = ${text === undefined ? 'candidates[0]' : `candidates.find((node) => node.textContent?.trim().includes(${JSON.stringify(text)}))`};
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
  })()`), text ? `${selector} containing ${text}` : selector);
}

async function click(selector, text) {
  const point = await pointFor(selector, text);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function press(key, code = key, modifiers = 0) {
  const virtual = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ' ': 32, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, a: 65 }[key] ?? 0;
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

async function composerCommand(command, panelSelector) {
  await focusComposer();
  await replaceFocused(command);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(panelSelector)}))`), `${command} panel`);
}

async function tabToText(expected, maximum = 12) {
  for (let index = 0; index < maximum; index += 1) {
    if (await evaluate(`document.activeElement?.textContent?.trim() === ${JSON.stringify(expected)}`)) return;
    await press('Tab', 'Tab');
  }
  assert.equal(await evaluate("document.activeElement?.textContent?.trim()"), expected);
}

async function chooseNativeSelect(selector, direction, expected) {
  const changed = await evaluate(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!(select instanceof HTMLSelectElement)) return false;
    const index = ${JSON.stringify(direction)} === 'End' ? select.options.length - 1 : 0;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    select.focus();
    return true;
  })()`);
  assert.equal(changed, true, `${selector} is unavailable`);
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(expected)}`), `${selector}=${expected}`);
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const refresh = await bridgeRequest('sessions.refresh');
  const task = refresh.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === threadId);
  assert.ok(task, 'Real Codex QA task is missing.');

  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id="${task.id}"] > .session-row'))`), 'Codex QA task row');
  await click(`[data-session-id="${task.id}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${task.id}"] > .session-row')?.classList.contains('selected') === true`), 'Codex QA task selection');
  await waitFor(() => evaluate(`Boolean(document.querySelector('textarea[aria-label="Message"]'))`), 'composer');

  const startingPreferences = await evaluate('window.tethoqDesktop.preferencesState()');
  assert.deepEqual({
    experimentalFeatures: startingPreferences.experimentalFeatures,
    reasoningDisplay: startingPreferences.reasoningDisplay,
    taskListMode: startingPreferences.taskListMode,
    closeAction: startingPreferences.closeAction,
    launchAtLogin: startingPreferences.launchAtLogin,
    alerts: startingPreferences.alerts,
    allowForeignSubagents: startingPreferences.allowForeignSubagents,
  }, {
    experimentalFeatures: false,
    reasoningDisplay: 'compact',
    taskListMode: 'project',
    closeAction: 'tray',
    launchAtLogin: 'off',
    alerts: 'all',
    allowForeignSubagents: false,
  });

  const existingGoal = await bridgeRequest('session.goal.get', { sessionId: task.id });
  if (existingGoal.goal) await bridgeRequest('session.goal.clear', { sessionId: task.id });

  const objective = 'Real UI goal lifecycle QA 2026-08-25';
  await composerCommand('/goal', '[role="dialog"][aria-label="Task goal"]');
  await waitFor(() => evaluate('document.activeElement === document.querySelector(\'.composer-goal-panel textarea\')'), 'Goal objective focus');
  await replaceFocused(objective);
  await press('Enter', 'Enter');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Task goal"]\')'), 'goal save dismissal');
  const started = await waitFor(async () => {
    const result = await bridgeRequest('session.goal.get', { sessionId: task.id });
    return result.goal?.objective === objective && result.goal.status === 'active' ? result.goal : null;
  }, 'started goal');

  await composerCommand('/goal', '[role="dialog"][aria-label="Task goal"]');
  await waitFor(() => evaluate(`document.querySelector('.composer-goal-panel textarea')?.value === ${JSON.stringify(objective)}`), 'reopened goal objective');
  await tabToText('Pause');
  await press(' ', 'Space');
  await waitFor(async () => (await bridgeRequest('session.goal.get', { sessionId: task.id })).goal?.status === 'paused', 'paused goal');
  await press('Escape', 'Escape');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Task goal"]\')'), 'close paused goal');
  await composerCommand('/goal', '[role="dialog"][aria-label="Task goal"]');
  await waitFor(() => evaluate("document.querySelector('.composer-goal-panel textarea')?.value.length > 0"), 'paused goal load');
  await tabToText('Complete');
  await press(' ', 'Space');
  await waitFor(async () => (await bridgeRequest('session.goal.get', { sessionId: task.id })).goal?.status === 'complete', 'completed goal');
  await press('Escape', 'Escape');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Task goal"]\')'), 'close completed goal');
  await composerCommand('/goal', '[role="dialog"][aria-label="Task goal"]');
  await waitFor(() => evaluate("document.querySelector('.composer-goal-panel textarea')?.value.length > 0"), 'completed goal load');
  await tabToText('Reopen');
  await press(' ', 'Space');
  await waitFor(async () => (await bridgeRequest('session.goal.get', { sessionId: task.id })).goal?.status === 'active', 'reopened goal');
  await press('Escape', 'Escape');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Task goal"]\')'), 'close reopened goal');
  await composerCommand('/goal', '[role="dialog"][aria-label="Task goal"]');
  await waitFor(() => evaluate("document.querySelector('.composer-goal-panel textarea')?.value.length > 0"), 'active goal load');
  await tabToText('Clear');
  await press(' ', 'Space');
  await waitFor(async () => (await bridgeRequest('session.goal.get', { sessionId: task.id })).goal === null, 'cleared goal');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Task goal"]\') && document.activeElement === document.querySelector(\'textarea[aria-label="Message"]\')'), 'Goal clear composer focus');

  await composerCommand('/ears', '[role="dialog"][aria-label="EARS settings"]');
  await press('Escape', 'Escape');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="EARS settings"]\')'), 'EARS Escape dismissal');
  assert.equal(await evaluate('document.activeElement === document.querySelector(\'textarea[aria-label="Message"]\')'), true, 'EARS Escape did not restore focus.');

  await composerCommand('/eyes', '[role="dialog"][aria-label="Choose a vision model"]');
  await click('.workspace-title');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Choose a vision model"]\')'), 'EYES outside-click dismissal');

  await composerCommand('/mesh', '[role="dialog"][aria-label="Mesh delegation"]');
  assert.equal(await evaluate('document.querySelector(\'textarea[aria-label="Message"]\')?.value'), '/mesh');
  await focusComposer();
  await send('Input.insertText', { text: 'x' });
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Mesh delegation"]\')'), 'mesh partial-command dismissal');
  assert.equal(await evaluate('document.querySelector(\'textarea[aria-label="Message"]\')?.value'), '/meshx');
  await focusComposer();
  await replaceFocused('/mesh');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'[role="dialog"][aria-label="Mesh delegation"]\'))'), 'mesh reopen');
  await press('Escape', 'Escape');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Mesh delegation"]\')'), 'mesh Escape dismissal');
  assert.equal(await evaluate('document.querySelector(\'textarea[aria-label="Message"]\')?.value'), '/mesh', 'Mesh Escape discarded the typed command.');
  await focusComposer();
  await replaceFocused('');

  await click('button[aria-label="More message actions"]');
  const menuLabels = await waitFor(() => evaluate(`(() => {
    const menu = document.querySelector('[role="menu"][aria-label="More message actions"]');
    return menu ? [...menu.querySelectorAll('[role="menuitem"] strong')].map((node) => node.textContent?.trim() ?? '') : null;
  })()`), 'message actions menu');
  for (const label of ['Context Handoff', 'Branch in New Task', 'Open session browser', 'Open side chat', 'Delegate task', 'Goal', 'Manage workflows']) {
    assert.ok(menuLabels.includes(label), `Missing message action: ${label}`);
  }
  const existingSideChatIds = new Set(((await bridgeRequest('sessions.list')).sessions ?? [])
    .filter((session) => session.sessionKind === 'side_chat' && session.parentSessionId === task.id)
    .map((session) => session.id));
  for (const staleSideChatId of existingSideChatIds) {
    await evaluate(`window.tethoqDesktop.preferencesAction({ type: 'set-task-override', sessionId: ${JSON.stringify(staleSideChatId)}, override: { archived: true } })`);
  }
  await click('[role="menu"][aria-label="More message actions"] [role="menuitem"]', 'Open side chat');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'[role="dialog"][aria-label="Side chat"]\'))'), 'side chat open');
  assert.equal(await evaluate('document.activeElement === document.querySelector(\'textarea[aria-label="Side chat message"]\')'), true, 'Side chat did not focus its composer.');
  const sideSessionId = await waitFor(async () => {
    const sessions = (await bridgeRequest('sessions.refresh')).sessions ?? [];
    return sessions.find((session) => session.sessionKind === 'side_chat' && session.parentSessionId === task.id && !existingSideChatIds.has(session.id))?.id ?? null;
  }, 'persisted side chat');
  await press('Escape', 'Escape');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Side chat"]\')'), 'side chat Escape close');
  await click('button.sidebar-task-filter');
  await click('[role="dialog"][aria-label="Task filters"] [role="checkbox"]', 'Show side chats');
  await click('.workspace-title');
  const sideChatRow = `button[data-side-chat-id="${sideSessionId}"]`;
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(sideChatRow)}))`), 'opted-in side chat row');
  await click(sideChatRow);
  await waitFor(() => evaluate('document.activeElement === document.querySelector(\'textarea[aria-label="Side chat message"]\')'), 'reopened side chat focus');
  const beforePromotionIds = new Set((await bridgeRequest('sessions.list')).sessions.map((session) => session.id));
  await click('button[aria-label="Side chat actions"]');
  await click('[role="menuitem"]', 'Copy to full task');
  const promotedSessionId = await waitFor(async () => {
    const sessions = (await bridgeRequest('sessions.list')).sessions ?? [];
    return sessions.find((session) => session.sessionKind !== 'side_chat' && !beforePromotionIds.has(session.id))?.id ?? null;
  }, 'promoted full task');
  await waitFor(() => evaluate('!document.querySelector(\'[role="dialog"][aria-label="Side chat"]\')'), 'side chat promotion close');
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${task.id}"] > .session-row') !== null`), 'parent task after promotion');
  await click(`[data-session-id="${task.id}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${task.id}"] > .session-row')?.classList.contains('selected') === true`), 'parent task restoration');
  await click('button.sidebar-task-filter');
  await click('[role="dialog"][aria-label="Task filters"] [role="checkbox"]', 'Show side chats');
  await click('.workspace-title');

  await click('button[aria-label="More message actions"]');
  await click('[role="menu"][aria-label="More message actions"] [role="menuitem"]', 'Open session browser');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'button[aria-label="Return to task"]\'))'), 'session browser open');
  assert.equal(await evaluate('Boolean(document.querySelector(\'input[aria-label="Address and search"]\'))'), true, 'Session browser has no usable address field.');
  await click('button[aria-label="Return to task"]');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'textarea[aria-label="Message"]\'))'), 'return from session browser');

  await click('button[aria-label="Open settings"]');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'.settings-page\'))'), 'settings open');
  await click('.settings-compact-details summary', 'Desktop behavior');
  await chooseNativeSelect('select[aria-label="Close button"]', 'End', 'quit');
  await chooseNativeSelect('select[aria-label="Close button"]', 'Home', 'tray');
  await chooseNativeSelect('select[aria-label="Alerts"]', 'End', 'off');
  await chooseNativeSelect('select[aria-label="Alerts"]', 'Home', 'all');
  await chooseNativeSelect('select[aria-label="Startup"]', 'End', 'tray');
  await chooseNativeSelect('select[aria-label="Startup"]', 'Home', 'off');
  await chooseNativeSelect('select[aria-label="Reasoning display"]', 'End', 'expanded');
  await chooseNativeSelect('select[aria-label="Reasoning display"]', 'Home', 'compact');
  await click('button[aria-label="Enable experimental features"]');
  await waitFor(async () => (await evaluate('window.tethoqDesktop.preferencesState()')).experimentalFeatures === true, 'experimental enabled');
  await click('button[aria-label="Enable experimental features"]');
  await waitFor(async () => (await evaluate('window.tethoqDesktop.preferencesState()')).experimentalFeatures === false, 'experimental restored');
  await click('button[aria-label="Allow sub-agents from other coding tools"]');
  await waitFor(async () => (await evaluate('window.tethoqDesktop.preferencesState()')).allowForeignSubagents === true, 'foreign subagents enabled');
  await click('button[aria-label="Allow sub-agents from other coding tools"]');
  await waitFor(async () => (await evaluate('window.tethoqDesktop.preferencesState()')).allowForeignSubagents === false, 'foreign subagents restored');
  await click('button[aria-label="Close settings"]');
  await waitFor(() => evaluate('!document.querySelector(\'.settings-page\')'), 'settings close');

  await click('button[aria-label="Arrange tasks by recency"]');
  await waitFor(async () => (await evaluate('window.tethoqDesktop.preferencesState()')).taskListMode === 'recent', 'recency mode');
  await click('button[aria-label="Arrange tasks by project"]');
  await waitFor(async () => (await evaluate('window.tethoqDesktop.preferencesState()')).taskListMode === 'project', 'project mode restored');

  await evaluate(`window.tethoqDesktop.preferencesAction({ type: 'set-task-override', sessionId: ${JSON.stringify(sideSessionId)}, override: { archived: true } })`);
  await evaluate(`window.tethoqDesktop.preferencesAction({ type: 'set-task-override', sessionId: ${JSON.stringify(promotedSessionId)}, override: { archived: true } })`);
  const endingPreferences = await evaluate('window.tethoqDesktop.preferencesState()');
  assert.deepEqual({
    experimentalFeatures: endingPreferences.experimentalFeatures,
    reasoningDisplay: endingPreferences.reasoningDisplay,
    taskListMode: endingPreferences.taskListMode,
    closeAction: endingPreferences.closeAction,
    launchAtLogin: endingPreferences.launchAtLogin,
    alerts: endingPreferences.alerts,
    allowForeignSubagents: endingPreferences.allowForeignSubagents,
  }, {
    experimentalFeatures: false,
    reasoningDisplay: 'compact',
    taskListMode: 'project',
    closeAction: 'tray',
    launchAtLogin: 'off',
    alerts: 'all',
    allowForeignSubagents: false,
  });

  const visual = await evaluate(`(() => ({
    rawMetadata: /Files (?:mentioned|pasted) by the user|:codex-annotation\\{index=|<codex_delegation>|<source_thread_id>/iu.test(document.querySelector('.conversation')?.textContent ?? ''),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.getAttribute('aria-label')),
    composerFocused: document.activeElement === document.querySelector('textarea[aria-label="Message"]'),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    overflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }))()`);
  assert.equal(visual.rawMetadata, false);
  assert.equal(visual.dialogs.length, 0, `Dialogs left open: ${visual.dialogs.join(', ')}`);
  assert.equal(visual.overflowX, false);
  assert.equal(visual.overflowY, false);

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = { taskId: task.id, goal: { startedRevision: started.revision, cleared: true }, menuLabels, sideSessionId, promotedSessionId, settingsRestored: true, visual, screenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
