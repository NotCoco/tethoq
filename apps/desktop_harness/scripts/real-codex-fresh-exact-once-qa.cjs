'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const debugPort = Number(process.argv[2] ?? 9225);
const workingDirectory = process.argv[3] ?? path.resolve(__dirname, '..', '..', '..');
const existingThreadId = process.argv[4];
const runToken = process.argv[5] ?? `CODEX_FRESH_${Date.now()}`;
const keepSelected = process.argv.includes('--keep-selected');
if (existingThreadId !== undefined) assert.match(existingThreadId, /^[0-9a-f-]{36}$/iu, 'The existing Codex thread ID is invalid.');
const turns = [
  { prompt: `Reply with exactly ${runToken}_ONE`, answer: `${runToken}_ONE` },
  { prompt: `Reply with exactly ${runToken}_TWO`, answer: `${runToken}_TWO` },
];
const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'real-codex-fresh-exact-once.json');
const screenshotPath = path.join(artifactRoot, 'real-codex-fresh-exact-once.png');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pending = new Map();

async function waitFor(operation, description, timeoutMs = 180_000) {
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

function send(method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
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
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
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
  const rejectPending = () => {
    for (const handler of pending.values()) handler.reject(new Error('CDP disconnected'));
    pending.clear();
  };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('error', rejectPending);
  await send('Runtime.enable');
  await send('Page.enable');
}

async function typePrompt(prompt) {
  const field = await pointFor('textarea[aria-label="Message"]');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: field.x, y: field.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: field.x, y: field.y, button: 'left', buttons: 0, clickCount: 1 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await send('Input.insertText', { text: prompt });
  await waitFor(() => evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(prompt)}`), 'prompt text');
}

async function visibleState(sessionId) {
  return evaluate(`(() => {
    const exact = (selector, text) => [...document.querySelectorAll(selector)].filter((node) => node.textContent?.trim() === text).length;
    return {
      turns: ${JSON.stringify(turns)}.map((turn) => ({
        prompt: turn.prompt,
        answer: turn.answer,
        users: exact('.message-user .message-body', turn.prompt),
        finals: exact('.message-assistant .message-body', turn.answer),
      })),
      spinner: document.querySelector('[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"] .session-row-working-spinner') !== null,
      stop: [...document.querySelectorAll('button[aria-label="Stop task"]')].some((node) => node.getBoundingClientRect().width > 0),
      errors: [...document.querySelectorAll('.error-banner, .timeline-error-notice')].map((node) => node.textContent?.trim() ?? ''),
      rawMetadata: /Files (?:mentioned|pasted) by the user|:codex-annotation\\{index=|<codex_delegation>|<source_thread_id>/iu.test(document.querySelector('.conversation')?.textContent ?? ''),
    };
  })()`);
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const previousSessionId = await evaluate(`document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.getAttribute('data-session-id') ?? null`);
  const session = existingThreadId === undefined
    ? (await bridgeRequest('session.create', {
      providerId: 'codex',
      workingDirectory,
      title: `Disposable real Codex exact-once QA ${runToken}`,
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'low',
      firstInstruction: turns[0].prompt,
    })).session
    : (await bridgeRequest('sessions.refresh')).sessions?.find((candidate) => candidate.providerId === 'codex' && candidate.providerSessionId === existingThreadId);
  assert.equal(session?.providerId, 'codex');
  assert.ok(session?.id, 'The real Codex task has no Tethoq session ID.');
  assert.match(session?.providerSessionId ?? '', /^[0-9a-f-]{36}$/iu, 'The real Codex task has no provider thread ID.');

  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id=${JSON.stringify(session.id)}]'))`), 'fresh Codex task row');
  await click(`[data-session-id=${JSON.stringify(session.id)}] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id=${JSON.stringify(session.id)}] > .session-row')?.classList.contains('selected') === true`), 'fresh Codex task selection');
  await waitFor(async () => {
    const state = await visibleState(session.id);
    return state.turns[0]?.users === 1 && state.turns[0]?.finals === 1 && !state.spinner && !state.stop ? state : null;
  }, 'first real Codex turn exactly once');

  if (existingThreadId === undefined) {
    await typePrompt(turns[1].prompt);
    await click('button[aria-label="Send instruction"]');
  }
  const settled = await waitFor(async () => {
    const state = await visibleState(session.id);
    return state.turns.every((turn) => turn.users === 1 && turn.finals === 1) && !state.spinner && !state.stop ? state : null;
  }, 'second real Codex turn exactly once');
  await delay(2_000);
  const stable = await visibleState(session.id);
  assert.deepEqual(stable.turns, turns.map((turn) => ({ ...turn, users: 1, finals: 1 })));
  assert.equal(stable.spinner, false);
  assert.equal(stable.stop, false);
  assert.equal(stable.rawMetadata, false);
  assert.deepEqual(stable.errors, []);

  const refreshed = await bridgeRequest('sessions.refresh');
  const canonical = refreshed.sessions?.find((candidate) => candidate.id === session.id);
  assert.ok(canonical, 'The fresh Codex task disappeared after its turns.');
  assert.match(canonical.modelId ?? '', /gpt-?5\.6.*sol|gpt-5\.6-sol/iu, 'The selected real model was not retained.');
  assert.equal(canonical.reasoningEffort?.toLowerCase(), 'low', 'The selected reasoning effort was not retained.');

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  if (!keepSelected && previousSessionId && await evaluate(`Boolean(document.querySelector('[data-session-id=${JSON.stringify(previousSessionId)}]'))`)) {
    await click(`[data-session-id=${JSON.stringify(previousSessionId)}] > .session-row`);
  }
  const report = { runToken, sessionId: session.id, providerSessionId: session.providerSessionId, modelId: canonical.modelId, reasoningEffort: canonical.reasoningEffort, turns, settled, stable, screenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
