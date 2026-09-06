'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const debugPort = Number(process.argv[2] ?? 9225);
const audioPath = path.resolve(process.argv[3] ?? path.join(__dirname, '..', 'qa-artifacts', 'ears-qa-825.wav'));
const workingDirectory = path.resolve(__dirname, '../../..');
const title = 'Tethoq real Codex audio QA 2026-08-25';
const prompt = 'Listen to the attached recording and reply with only the words that are spoken, with no explanation.';
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

async function waitFor(operation, description, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

async function request(type, payload = {}) {
  const response = await evaluate(`window.tethoqDesktop.request(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
  if (!response?.ok) throw new Error(response?.error?.message ?? `${type} failed`);
  return response.payload;
}

async function connect() {
  const target = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
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
}

async function uploadAudio(bytes) {
  const started = await request('attachment.upload.begin', {
    name: path.basename(audioPath),
    mimeType: 'audio/wav',
    byteLength: bytes.byteLength,
  });
  assert.equal(typeof started.uploadId, 'string');
  const uploadId = started.uploadId;
  const requestedChunkBytes = typeof started.chunkBytes === 'number' ? started.chunkBytes : 192 * 1024;
  const chunkBytes = Math.max(3, Math.min(192 * 1024, requestedChunkBytes) - (Math.min(192 * 1024, requestedChunkBytes) % 3));
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes));
      await request('attachment.upload.chunk', { uploadId, offset, dataBase64: chunk.toString('base64') });
    }
    const completed = await request('attachment.upload.complete', { uploadId });
    assert.equal(typeof completed.attachmentId, 'string');
    return completed.attachmentId;
  } catch (error) {
    await request('attachment.upload.cancel', { uploadId }).catch(() => undefined);
    throw error;
  }
}

async function click(selector) {
  const point = await waitFor(() => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`), selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function main() {
  await connect();
  const bytes = await readFile(audioPath);
  const created = await request('session.create', {
    providerId: 'codex',
    workingDirectory,
    title,
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'low',
  });
  const session = created.session;
  assert.equal(typeof session?.id, 'string');
  const attachmentId = await uploadAudio(bytes);
  await request('session.send_message', {
    sessionId: session.id,
    content: prompt,
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'low',
    attachmentIds: [attachmentId],
  });

  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id="${session.id}"] > .session-row'))`), 'Codex audio QA task row');
  await click(`[data-session-id="${session.id}"] > .session-row`);
  const result = await waitFor(() => evaluate(`(() => {
    const row = document.querySelector('[data-session-id="${session.id}"]');
    const users = [...document.querySelectorAll('.message-user')].filter((node) => node.querySelector('.message-body')?.textContent?.trim() === ${JSON.stringify(prompt)});
    const answers = [...document.querySelectorAll('.message-assistant .message-body')].map((node) => node.textContent?.trim() ?? '').filter(Boolean);
    const audio = users[0]?.querySelectorAll('.message-audio audio,.message-audio .audio-playback-chip').length ?? 0;
    const errors = [...document.querySelectorAll('.error-banner,.timeline-error-notice')].map((node) => node.textContent?.trim() ?? '');
    if (row?.querySelector('.session-row-working-spinner') || users.length !== 1 || answers.length < 1) return null;
    return { users: users.length, answers, audioWidgets: audio, errors, conversation: (document.querySelector('.conversation')?.textContent ?? '').slice(-2000) };
  })()`), 'real Codex audio response');
  assert.equal(result.users, 1);
  assert.equal(result.audioWidgets, 1);
  assert.deepEqual(result.errors, []);
  process.stdout.write(`${JSON.stringify({ sessionId: session.id, providerSessionId: session.providerSessionId, audioPath, result }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
