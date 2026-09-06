'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const debugPort = Number(process.argv[2] ?? 9237);
const artifactRoot = path.resolve(__dirname, '..', 'qa-artifacts');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pending = new Map();

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

async function waitFor(operation, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(125);
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

const recentRowsExpression = `(() => {
  const sections = [...document.querySelectorAll('[role="dialog"][aria-label="Choose model"] .model-catalog-results > section')];
  const recent = sections.find((section) => section.querySelector('h4')?.textContent?.trim() === 'Recent');
  return [...(recent?.querySelectorAll('button') ?? [])].map((button) => ({
    name: button.querySelector('strong')?.textContent?.trim() ?? '',
    route: button.querySelector('.model-route-label')?.textContent?.trim() ?? '',
    selected: button.getAttribute('aria-current') === 'true',
    checked: Boolean(button.querySelector('.model-row-meta svg')),
  }));
})()`;

const modelSelectionExpression = `(() => {
  const dialog = document.querySelector('[role="dialog"][aria-label="Choose model"]');
  const sections = [...(dialog?.querySelectorAll('.model-catalog-results > section') ?? [])];
  const recent = sections.find((section) => section.querySelector('h4')?.textContent?.trim() === 'Recent');
  const canonical = sections.filter((section) => section !== recent);
  return {
    recentSelected: recent?.querySelectorAll('button[aria-current="true"]').length ?? 0,
    recentChecks: recent?.querySelectorAll('.model-row-meta svg').length ?? 0,
    canonicalSelected: canonical.reduce((count, section) => count + section.querySelectorAll('button[aria-current="true"]').length, 0),
    canonicalChecks: canonical.reduce((count, section) => count + section.querySelectorAll('.model-row-meta svg').length, 0),
  };
})()`;

async function openPicker() {
  if (!await evaluate("Boolean(document.querySelector('[role=\"dialog\"][aria-label=\"Choose model\"]'))")) {
    await clickExpression("document.querySelector('button[aria-label^=\"Choose model. Current model:\"]')", 'model picker trigger');
  }
  return await waitFor(async () => {
    const rows = await evaluate(recentRowsExpression);
    return Array.isArray(rows) && rows.length > 0 ? rows : null;
  }, 'painted Recent model rows');
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  await waitFor(() => evaluate("Boolean(document.querySelector('[data-session-id] > .session-row'))"), 'task list');
  if (!await evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]'))")) {
    await clickExpression("document.querySelector('[data-session-id] > .session-row')", 'first task row');
  }
  await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]'))"), 'task composer');

  const storageBefore = await waitFor(async () => {
    const value = await evaluate("localStorage.getItem('tethoq:recent-used-models:v1')");
    return value ? JSON.parse(value) : null;
  }, 'provider-backed recent usage history');
  assert.ok(Array.isArray(storageBefore) && storageBefore.length > 0, 'No provider-backed model use was persisted.');

  const oldClickHistoryBefore = await evaluate("localStorage.getItem('tethoq:recent-models')");
  await evaluate("localStorage.setItem('tethoq:recent-models', JSON.stringify(['poison:never-used']))");
  let initialRows = await openPicker();
  assert.ok(initialRows.length <= 5, 'Recent renders more than five rows.');
  assert.ok(initialRows.every((row) => row.name && !row.name.includes('never-used')), 'Legacy click history affected the Recent rows.');
  assert.ok(initialRows.every((row) => !row.selected && !row.checked), 'A Recent shortcut owns canonical selection styling.');
  assert.deepEqual(await evaluate(modelSelectionExpression), {
    recentSelected: 0,
    recentChecks: 0,
    canonicalSelected: 1,
    canonicalChecks: 1,
  }, 'Selection fill and check are not owned by exactly one canonical model row.');

  const findNonRecent = () => evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose model"]');
    const recent = [...dialog.querySelectorAll('.model-catalog-results > section')].find((section) => section.querySelector('h4')?.textContent?.trim() === 'Recent');
    const recentNames = new Set([...(recent?.querySelectorAll('strong') ?? [])].map((node) => node.textContent?.trim()));
    const buttons = [...dialog.querySelectorAll('.model-catalog-results button:not([disabled])')];
    const candidate = buttons.find((button) => !recent?.contains(button) && !recentNames.has(button.querySelector('strong')?.textContent?.trim()));
    return candidate ? { name: candidate.querySelector('strong')?.textContent?.trim() ?? '', index: buttons.indexOf(candidate) } : null;
  })()`);
  let nonRecent = await findNonRecent();
  if (!nonRecent?.name) {
    // A single-model Agent can legitimately have no alternative in an existing
    // task. A local unsent draft exposes every ready Agent without creating or
    // sending anything to a provider.
    await clickExpression("document.querySelector('button[aria-label^=\"Choose model. Current model:\"]')", 'close model picker');
    await clickExpression("document.querySelector('button[aria-label=\"New task\"]')", 'local new-task draft');
    await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]'))"), 'draft composer');
    initialRows = await openPicker();
    nonRecent = await findNonRecent();
  }
  assert.ok(nonRecent?.name, 'No non-recent model was available for an unsent-selection check.');
  await clickExpression(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Choose model"]');
    const recent = [...dialog.querySelectorAll('.model-catalog-results > section')].find((section) => section.querySelector('h4')?.textContent?.trim() === 'Recent');
    const recentNames = new Set([...(recent?.querySelectorAll('strong') ?? [])].map((node) => node.textContent?.trim()));
    return [...dialog.querySelectorAll('.model-catalog-results button:not([disabled])')].find((button) => !recent?.contains(button) && !recentNames.has(button.querySelector('strong')?.textContent?.trim()));
  })()`, 'unsent non-recent model choice');
  const afterUnsentRows = await openPicker();
  assert.deepEqual(afterUnsentRows.map((row) => [row.name, row.route]), initialRows.map((row) => [row.name, row.route]), 'An unsent picker choice reordered Recent.');
  assert.deepEqual(await evaluate(modelSelectionExpression), {
    recentSelected: 0,
    recentChecks: 0,
    canonicalSelected: 1,
    canonicalChecks: 1,
  }, 'Changing models duplicated selection styling into Recent.');
  assert.equal(await evaluate("localStorage.getItem('tethoq:recent-used-models:v1')"), JSON.stringify(storageBefore), 'An unsent picker choice mutated usage history.');

  await send('Page.reload', { ignoreCache: true });
  await waitFor(() => evaluate("Boolean(document.querySelector('[data-session-id] > .session-row'))"), 'task list after reload');
  if (!await evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]'))")) {
    await clickExpression("document.querySelector('[data-session-id] > .session-row')", 'task row after reload');
  }
  await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]'))"), 'composer after reload');
  const reloadedRows = await openPicker();
  assert.deepEqual(reloadedRows.map((row) => [row.name, row.route]), initialRows.map((row) => [row.name, row.route]), 'Recent ordering did not survive reload.');

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const screenshotPath = path.join(artifactRoot, 'recent-models-real.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await evaluate(`(() => {
    const value = ${JSON.stringify(oldClickHistoryBefore)};
    if (value === null) localStorage.removeItem('tethoq:recent-models');
    else localStorage.setItem('tethoq:recent-models', value);
  })()`);
  const report = { initialRows, afterUnsentRows, reloadedRows, persistedUses: storageBefore, screenshotPath };
  await writeFile(path.join(artifactRoot, 'recent-models-real.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().finally(() => socket?.close()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
