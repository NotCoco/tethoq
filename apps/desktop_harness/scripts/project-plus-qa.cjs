'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const threadId = process.argv[2];
const debugPort = Number(process.argv[3] ?? 9225);
assert.match(threadId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the Codex QA thread ID.');

const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'project-plus.json');
const screenshotPath = path.join(artifactRoot, 'project-plus.png');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
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

async function pointFor(selector) {
  return waitFor(() => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`), selector);
}

async function click(selector) {
  const point = await pointFor(selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
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
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  await evaluate(`(() => {
    const input = document.querySelector('#sidebar-task-search-input');
    if (!(input instanceof HTMLInputElement) || !input.value) return false;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(input, '');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    return true;
  })()`);
  const refreshBefore = await bridgeRequest('sessions.refresh');
  const remote = refreshBefore.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === threadId);
  assert.ok(remote, 'Real Codex QA task is missing.');
  const directory = remote.workingDirectory;
  assert.ok(directory, 'Real Codex QA task has no working directory.');

  const projectMode = await evaluate(`document.querySelector('button[aria-label="Arrange tasks by recency"]') !== null`);
  if (!projectMode) await click('button[aria-label="Arrange tasks by project"]');
  await waitFor(() => evaluate(`document.querySelector('button[aria-label="Arrange tasks by recency"]') !== null`), 'project mode');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id="${remote.id}"]'))`), 'real QA task row');

  const groupSelector = await evaluate(`(() => {
    const row = document.querySelector('[data-session-id="${remote.id}"]');
    const group = row?.closest('.session-project-group');
    return group?.getAttribute('data-project-key') ?? null;
  })()`);
  assert.ok(groupSelector, 'The QA task is not grouped by project.');
  const escapedGroup = JSON.stringify(groupSelector);
  const headingPoint = await waitFor(() => evaluate(`(() => {
    const group = [...document.querySelectorAll('.session-project-group')].find((node) => node.getAttribute('data-project-key') === ${escapedGroup});
    const heading = group?.querySelector('.session-project-heading');
    if (!(heading instanceof HTMLElement)) return null;
    const rect = heading.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`), 'project heading');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: headingPoint.x, y: headingPoint.y });

  const hover = await waitFor(() => evaluate(`(() => {
    const group = [...document.querySelectorAll('.session-project-group')].find((node) => node.getAttribute('data-project-key') === ${escapedGroup});
    const button = group?.querySelector('.session-project-new-task');
    if (!(button instanceof HTMLButtonElement)) return null;
    const style = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return Number(style.opacity) > 0 && style.pointerEvents !== 'none' ? { aria: button.getAttribute('aria-label'), opacity: style.opacity, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } } : null;
  })()`), 'project plus on hover');
  assert.match(hover.aria ?? '', /^New task in /u);

  const grouping = await evaluate(`(() => [...document.querySelectorAll('.session-project-group')].map((group) => ({
    key: group.getAttribute('data-project-key'),
    countText: group.querySelector('.session-project-header b')?.textContent?.trim() ?? '',
    visibleRows: group.querySelectorAll('[data-session-id]').length,
    showMore: group.querySelector('.session-project-show-more')?.getAttribute('aria-label') ?? null,
  })))()`);
  for (const group of grouping) {
    const count = Number.parseInt(group.countText, 10);
    if (!Number.isFinite(count)) continue;
    assert.ok(group.visibleRows <= 5, `Project ${group.key} shows ${group.visibleRows} rows before expansion.`);
    assert.equal(Boolean(group.showMore), count > 5, `Project ${group.key} has inconsistent Show more state.`);
  }

  const plusSelector = `.session-project-group[data-project-key=${JSON.stringify(groupSelector)}] .session-project-new-task`;
  const plusPoint = await pointFor(plusSelector);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: plusPoint.x, y: plusPoint.y });
  await delay(600);
  const tooltip = await waitFor(() => evaluate(`(() => {
    const tooltips = [...document.querySelectorAll('[role="tooltip"]')];
    if (tooltips.length !== 1) return { count: tooltips.length };
    const element = tooltips[0];
    const bounds = element.getBoundingClientRect();
    return {
      count: tooltips.length,
      bodyOwned: element.parentElement === document.body,
      text: element.textContent?.trim() ?? '',
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  })()`), 'project plus tooltip');
  assert.equal(tooltip.count, 1, 'Project plus hover painted more than one tooltip.');
  assert.equal(tooltip.bodyOwned, true, 'Project plus tooltip is trapped inside the task list instead of being owned by the document body.');
  assert.equal(tooltip.text, hover.aria, 'Project plus tooltip does not contain the complete accessible label.');
  assert.ok(
    tooltip.bounds.left >= 8
      && tooltip.bounds.top >= 8
      && tooltip.bounds.right <= tooltip.viewport.width - 8
      && tooltip.bounds.bottom <= tooltip.viewport.height - 8,
    `Project plus tooltip is clipped by the viewport: ${JSON.stringify(tooltip)}`,
  );
  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  await click(plusSelector);
  const draft = await waitFor(() => evaluate(`(() => {
    const title = document.querySelector('.workspace-title h1')?.textContent?.trim() ?? '';
    const location = document.querySelector('.draft-location span')?.textContent?.trim() ?? '';
    const placeholder = document.querySelector('textarea[aria-label="Message"]')?.getAttribute('placeholder') ?? '';
    return title === 'New task' && location ? { title, location, placeholder } : null;
  })()`), 'project-rooted draft');
  assert.equal(draft.location.toLocaleLowerCase(), directory.toLocaleLowerCase());
  assert.match(draft.placeholder, /Describe (?:a|the) task/u);
  const refreshAfter = await bridgeRequest('sessions.refresh');
  assert.equal(refreshAfter.sessions.length, refreshBefore.sessions.length, 'Clicking project plus materialized a provider task before send.');

  await click(`[data-session-id="${remote.id}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${remote.id}"] > .session-row')?.classList.contains('selected') === true`), 'restore original task');
  const report = { threadId, sessionId: remote.id, directory, hover, tooltip, grouping, draft, sessionCount: refreshBefore.sessions.length, screenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
