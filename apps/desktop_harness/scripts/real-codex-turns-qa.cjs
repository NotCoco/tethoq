'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const threadId = process.argv[2];
const debugPort = Number(process.argv[3] ?? 9225);
assert.match(threadId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the Codex thread ID.');

const turns = [
  { prompt: 'Real QA turn two. Reply with exactly CODEX_REAL_QA_TURN_2', answer: 'CODEX_REAL_QA_TURN_2' },
  { prompt: 'Real QA turn three. Reply with exactly CODEX_REAL_QA_TURN_3', answer: 'CODEX_REAL_QA_TURN_3' },
];
const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'real-codex-turns.json');
const screenshotPath = path.join(artifactRoot, 'real-codex-turns.png');
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

async function typePrompt(prompt) {
  const fieldPoint = await pointFor('textarea[aria-label="Message"]');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fieldPoint.x, y: fieldPoint.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fieldPoint.x, y: fieldPoint.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await send('Input.insertText', { text: prompt });
  await waitFor(() => evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(prompt)}`), 'prompt text');
}

async function stateFor(turn, sessionId) {
  return evaluate(`(() => {
    const prompt = ${JSON.stringify(turn.prompt)};
    const answer = ${JSON.stringify(turn.answer)};
    const exact = (selector, text) => [...document.querySelectorAll(selector)].filter((node) => node.textContent?.trim() === text).length;
    return {
      user: exact('.message-user .message-body', prompt),
      assistant: exact('.message-assistant .message-body', answer),
      spinner: document.querySelector('[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"] .session-row-working-spinner') !== null,
      stop: [...document.querySelectorAll('button[aria-label="Stop task"]')].some((node) => node.getBoundingClientRect().width > 0),
      errors: [...document.querySelectorAll('.error-banner, .timeline-error-notice')].map((node) => node.textContent?.trim() ?? ''),
    };
  })()`);
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const remote = await waitFor(async () => {
    const refresh = await bridgeRequest('sessions.refresh');
    return refresh.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === threadId);
  }, 'real Codex QA task');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id="${remote.id}"]'))`), 'Codex QA task row');
  await click(`[data-session-id="${remote.id}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${remote.id}"] > .session-row')?.classList.contains('selected') === true`), 'Codex QA task selection');
  // Selection commits before canonical history finishes loading. Starting the
  // send loop against that temporary empty state can repeat a prompt that is
  // already persisted, so wait for the known first turn before deciding.
  await waitFor(() => evaluate(`[...document.querySelectorAll('.message-assistant .message-body')].some((node) => node.textContent?.trim() === 'CODEX_REAL_QA_READY')`), 'Codex QA task history');

  const results = [];
  for (const turn of turns) {
    const existing = await stateFor(turn, remote.id);
    if (existing.user === 0 && existing.assistant === 0) {
      await typePrompt(turn.prompt);
      await click('button[aria-label="Send instruction"]');
    }
    const visible = await waitFor(async () => {
      const state = await stateFor(turn, remote.id);
      return state.user === 1 && state.assistant === 1 && !state.spinner && !state.stop ? state : null;
    }, `${turn.answer} visible and settled`);
    await delay(1_000);
    const stable = await stateFor(turn, remote.id);
    assert.deepEqual({ user: stable.user, assistant: stable.assistant, spinner: stable.spinner, stop: stable.stop }, { user: 1, assistant: 1, spinner: false, stop: false });
    assert.equal(stable.errors.length, 0, `Visible error after ${turn.answer}: ${stable.errors.join(' | ')}`);
    results.push({ turn, visible, stable });
  }

  const inspection = await evaluate(`(() => {
    const text = document.querySelector('.conversation')?.textContent ?? '';
    return {
      rawMetadata: /Files (?:mentioned|pasted) by the user|:codex-annotation\\{index=|<codex_delegation>|<source_thread_id>/iu.test(text),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentOverflow: {
        horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      },
    };
  })()`);
  assert.equal(inspection.rawMetadata, false, 'Raw provider metadata is visible in the real task.');
  assert.equal(inspection.documentOverflow.horizontal, false, 'The app shell overflows horizontally.');
  assert.equal(inspection.documentOverflow.vertical, false, 'The app shell overflows vertically.');

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = { threadId, sessionId: remote.id, results, inspection, screenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
