'use strict';

const assert = require('node:assert/strict');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const requestedThreadId = process.argv[2];
const debugPort = Number(process.argv[3] ?? 9225);
const sourceImage = process.argv[4] ?? path.join(__dirname, '..', 'qa-artifacts', 'real-codex-turns.png');
const createDisposableTask = requestedThreadId === 'new';
const workingDirectory = process.argv[5] ?? path.resolve(__dirname, '..', '..', '..');
if (!createDisposableTask) assert.match(requestedThreadId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass a Codex QA thread ID or "new".');

const prompt = 'Read the attached screenshot. Reply with exactly the last visible all-caps QA token and nothing else.';
const answer = 'CODEX_REAL_QA_TURN_3';
const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'real-codex-image.json');
const screenshotPath = path.join(artifactRoot, 'real-codex-image.png');
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
  await send('Runtime.enable');
  await send('Page.enable');
}

async function selectTask(sessionId) {
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id="${sessionId}"]'))`), 'Codex QA task row');
  await click(`[data-session-id="${sessionId}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${sessionId}"] > .session-row')?.classList.contains('selected') === true`), 'Codex QA task selection');
  await waitFor(() => evaluate(`Boolean(document.querySelector('textarea[aria-label="Message"]'))`), 'selected task composer');
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const remote = createDisposableTask
    ? (await bridgeRequest('session.create', {
      providerId: 'codex',
      workingDirectory,
      title: `Disposable real Codex image QA ${Date.now()}`,
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'low',
    })).session
    : await waitFor(async () => {
      const refresh = await bridgeRequest('sessions.refresh');
      return refresh.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === requestedThreadId);
    }, 'real Codex QA task');
  assert.match(remote?.providerSessionId ?? '', /^[0-9a-f-]{36}$/iu, 'The Codex QA task has no provider thread ID.');
  await selectTask(remote.id);

  const imageBase64 = (await readFile(sourceImage)).toString('base64');
  const clean = await evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(textarea, '');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    return document.querySelectorAll('.image-attachment-chip').length === 0;
  })()`);
  assert.equal(clean, true, 'Composer was not clean before image QA.');

  const pasteStarted = Date.now();
  await evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Message composer is unavailable');
    const bytes = Uint8Array.from(atob(${JSON.stringify(imageBase64)}), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'real-codex-vision-proof.png', { type: 'image/png' }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    textarea.dispatchEvent(event);
  })()`);
  await waitFor(() => evaluate(`document.querySelectorAll('.image-attachment-chip').length === 1`), 'composer image widget');
  const pasteToWidgetMs = Date.now() - pasteStarted;

  const field = await pointFor('textarea[aria-label="Message"]');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: field.x, y: field.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: field.x, y: field.y, button: 'left', buttons: 0, clickCount: 1 });
  await send('Input.insertText', { text: prompt });
  await waitFor(() => evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(prompt)}`), 'vision prompt text');
  await click('button[aria-label="Send instruction"]');

  const visible = await waitFor(() => evaluate(`(() => {
    const users = [...document.querySelectorAll('.message-user')].filter((node) => node.querySelector('.message-body')?.textContent?.trim() === ${JSON.stringify(prompt)});
    const answers = [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(answer)});
    const latest = users.at(-1);
    const followingAnswers = latest ? answers.filter((node) => (latest.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) : [];
    return users.length === 1 && followingAnswers.length === 1 && latest?.querySelectorAll('.message-images-before img').length === 1
      ? { users: users.length, answers: answers.length, followingAnswers: followingAnswers.length, images: latest.querySelectorAll('.message-images-before img').length }
      : null;
  })()`), 'real Codex image turn');
  await delay(1000);
  const stable = await evaluate(`(() => {
    const users = [...document.querySelectorAll('.message-user')].filter((node) => node.querySelector('.message-body')?.textContent?.trim() === ${JSON.stringify(prompt)});
    const answers = [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(answer)});
    const latest = users.at(-1);
    const followingAnswers = latest ? answers.filter((node) => (latest.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) : [];
    const text = document.querySelector('.conversation')?.textContent ?? '';
    return { users: users.length, followingAnswers: followingAnswers.length, images: latest?.querySelectorAll('.message-images-before img').length ?? 0, rawMetadata: /Files (?:mentioned|pasted) by the user|:codex-annotation\\{index=/iu.test(text), errors: [...document.querySelectorAll('.error-banner, .timeline-error-notice')].map((node) => node.textContent?.trim() ?? '') };
  })()`);
  assert.deepEqual(stable, { users: 1, followingAnswers: 1, images: 1, rawMetadata: false, errors: [] });

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = { threadId: remote.providerSessionId, sessionId: remote.id, prompt, answer, pasteToWidgetMs, visible, stable, sourceImage, screenshotPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
