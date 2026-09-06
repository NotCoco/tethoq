'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const threadId = process.argv[2];
const expected = process.argv[3];
const debugPort = Number(process.argv[4] ?? 9338);
const expectedUser = process.argv[5] ?? 'why is it sending it twice...';
assert.match(threadId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the Codex thread ID.');
assert.ok(expected, 'Pass a unique visible final-answer marker.');

const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'codex-reopened-history.json');
const screenshotPath = path.join(artifactRoot, 'codex-reopened-history.png');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pending = new Map();

async function waitFor(operation, description, timeoutMs = 90_000) {
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

async function clickSelector(selector) {
  const point = await waitFor(() => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`), selector);
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

async function readState() {
  return evaluate(`(() => {
    const expected = ${JSON.stringify(expected)};
    const expectedUser = ${JSON.stringify(expectedUser)};
    const scroller = document.querySelector('.conversation-scroll');
    const matching = [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === expected);
    const matchingUser = [...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === expectedUser);
    return {
      matching: matching.length,
      matchingUser: matchingUser.length,
      messageCount: document.querySelectorAll('[data-scroll-anchor]').length,
      scrollTop: scroller?.scrollTop ?? null,
      scrollHeight: scroller?.scrollHeight ?? null,
      clientHeight: scroller?.clientHeight ?? null,
      olderAvailable: document.querySelector('.history-loading') !== null,
      loadingOlder: document.querySelector('.history-loading[data-busy="true"]') !== null,
    };
  })()`);
}

async function wheelUp() {
  const point = await evaluate(`(() => {
    const element = document.querySelector('.conversation-scroll');
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 180) };
  })()`);
  assert.ok(point, 'Conversation viewport is missing.');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -12_000 });
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const remote = await waitFor(async () => {
    const refresh = await bridgeRequest('sessions.refresh');
    return refresh.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === threadId);
  }, 'Codex history QA task');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id="${remote.id}"]'))`), 'QA task row');
  await clickSelector(`[data-session-id="${remote.id}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${remote.id}"] > .session-row')?.classList.contains('selected') === true`), 'QA task selection');
  await waitFor(async () => (await readState()).messageCount > 0, 'initial task history');

  const samples = [];
  let stagnant = 0;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const before = await readState();
    samples.push({ attempt, ...before });
    if (before.matching === 1 && before.matchingUser === 1) break;
    if (!before.olderAvailable && !before.loadingOlder) break;
    await wheelUp();
    await delay(350);
    const after = await readState();
    stagnant = after.messageCount > before.messageCount || after.scrollHeight > before.scrollHeight ? 0 : stagnant + 1;
    if (stagnant >= 8) break;
  }

  const found = await waitFor(async () => {
    const state = await readState();
    return state.matching === 1 && state.matchingUser === 1 ? state : null;
  }, 'affected final answer after progressive history loading', 10_000);
  await evaluate(`(() => {
    const expected = ${JSON.stringify(expected)};
    const node = [...document.querySelectorAll('.message-assistant .message-body')].find((candidate) => candidate.textContent?.trim() === expected);
    node?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(node);
  })()`);
  await delay(750);

  const inspection = await evaluate(`(() => {
    const expected = ${JSON.stringify(expected)};
    const expectedUser = ${JSON.stringify(expectedUser)};
    const matching = [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === expected);
    const matchingUser = [...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === expectedUser);
    const target = matching[0];
    const rect = target?.getBoundingClientRect();
    const visibleText = document.querySelector('.conversation')?.textContent ?? '';
    return {
      matchingFinalAnswers: matching.length,
      matchingUserMessages: matchingUser.length,
      finalAtConversationLevel: Boolean(target?.closest('.message-assistant')) && !target?.closest('.reasoning-group'),
      targetVisible: Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight),
      targetRect: rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null,
      imageWidgets: document.querySelectorAll('.message-user .message-images img, .message-user .message-image-unavailable').length,
      annotationWidgets: document.querySelectorAll('.message-annotations button').length,
      rawAnnotationDirectives: (visibleText.match(/:codex-annotation\\{index="[1-9]\\d*"\\}/gu) ?? []).length,
      rawAnnotationContexts: [...document.querySelectorAll('.message-body')]
        .filter((node) => /:codex-annotation\\{index="[1-9]\\d*"\\}/u.test(node.textContent ?? ''))
        .map((node) => ({ role: node.closest('.message')?.className ?? '', text: node.textContent?.slice(0, 500) ?? '' })),
      rawAttachmentHeadings: (visibleText.match(/Files (?:mentioned|pasted) by the user/giu) ?? []).length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentOverflow: {
        horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      },
    };
  })()`);
  process.stdout.write(`inspection: ${JSON.stringify(inspection, null, 2)}\n`);

  assert.equal(inspection.matchingFinalAnswers, 1, 'The affected final answer is missing or duplicated.');
  assert.equal(inspection.matchingUserMessages, 1, 'The affected user action is missing or rendered twice.');
  assert.equal(inspection.finalAtConversationLevel, true, 'The final answer is nested inside Reasoning.');
  assert.equal(inspection.targetVisible, true, 'The final answer did not become visibly inspectable.');
  assert.ok(inspection.imageWidgets > 0, 'Reopened user image widgets are missing from the loaded history.');
  assert.equal(inspection.rawAnnotationDirectives, 0, 'Raw annotation directives are visible.');
  assert.equal(inspection.rawAttachmentHeadings, 0, 'Raw attachment transport headings are visible.');
  assert.equal(inspection.documentOverflow.horizontal, false, 'The app shell overflows horizontally.');
  assert.equal(inspection.documentOverflow.vertical, false, 'The fixed app shell overflows vertically.');

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = { threadId, sessionId: remote.id, found, inspection, samples, screenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(async (error) => {
  try { process.stderr.write(`history state: ${JSON.stringify(await readState(), null, 2)}\n`); } catch {}
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
