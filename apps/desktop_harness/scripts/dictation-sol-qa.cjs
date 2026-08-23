'use strict';

const assert = require('node:assert/strict');

const port = Number(process.argv[2] ?? 9338);
let socket;
let nextId = 0;
const pending = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(operation, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation().catch(() => undefined);
    if (result) return result;
    await delay(100);
  }
  throw new Error(`${description} timed out`);
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Renderer evaluation failed');
  return response.result?.value;
}

async function main() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.type === 'page' && /^file:/u.test(item.url ?? ''));
  }, 'packaged renderer');
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
  const model = await waitFor(() => evaluate(`(() => {
    const button = document.querySelector('button.model-picker-trigger');
    const label = button?.textContent?.trim() ?? '';
    return /5\\.6 Sol/iu.test(label) ? label : null;
  })()`), 'GPT-5.6 Sol composer');
  await evaluate(`(() => {
    if (document.querySelector('.dictation-direct-audio-option')) return true;
    const button = document.querySelector('button[aria-label="Choose dictation source"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  const option = await waitFor(() => evaluate(`(() => {
    const button = document.querySelector('.dictation-direct-audio-option');
    if (!(button instanceof HTMLButtonElement)) return null;
    return { disabled: button.disabled, text: button.textContent?.replace(/\\s+/gu, ' ').trim() ?? '' };
  })()`), 'MP3 dictation option');
  assert.equal(option.disabled, true, `MP3 was incorrectly enabled for ${model} without EARS`);
  assert.match(option.text, /^MP3\s*This model cannot hear a recording$/u);
  process.stdout.write(`${JSON.stringify({ model, mp3: option }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
