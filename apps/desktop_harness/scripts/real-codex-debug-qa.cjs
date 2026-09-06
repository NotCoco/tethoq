'use strict';

const { writeFile } = require('node:fs/promises');
const path = require('node:path');

const port = Number(process.argv[2] ?? 9225);
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

async function main() {
  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
    if (!target) await delay(100);
  }
  if (!target) throw new Error('Tethoq renderer is unavailable.');
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
  if (process.argv.includes('--click-send')) {
    const clicked = await send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const button = document.querySelector('button[aria-label="Send instruction"]');
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
    });
    if (clicked.exceptionDetails || clicked.result?.value !== true) throw new Error('Send button could not be invoked.');
    await delay(1000);
  }
  const response = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => ({
      selected: document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.getAttribute('data-session-id') ?? null,
      user: [...document.querySelectorAll('.message-user .message-body')].slice(-8).map((node) => node.textContent?.trim() ?? ''),
      assistant: [...document.querySelectorAll('.message-assistant .message-body')].slice(-8).map((node) => ({ text: node.textContent?.trim() ?? '', final: Boolean(node.closest('.final-answer-block')), reasoning: Boolean(node.closest('.reasoning-group')) })),
      anchors: [...document.querySelectorAll('[data-scroll-anchor]')].slice(-12).map((node) => ({ key: node.getAttribute('data-scroll-anchor'), text: node.textContent?.replace(/\\s+/gu, ' ').trim().slice(0, 240) ?? '' })),
      errors: [...document.querySelectorAll('.error-banner, .timeline-error-notice')].map((node) => node.textContent?.trim() ?? ''),
      toast: document.querySelector('.toast')?.textContent?.trim() ?? null,
      composer: document.querySelector('textarea[aria-label="Message"]')?.value ?? null,
      send: (() => {
        const node = document.querySelector('button[aria-label="Send instruction"], button[aria-label="Steer task"], button[aria-label="Stop task"]');
        if (!(node instanceof HTMLButtonElement)) return null;
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { label: node.getAttribute('aria-label'), disabled: node.disabled, title: node.title, text: node.textContent?.trim() ?? '', rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, hit: hit?.getAttribute('aria-label') ?? hit?.tagName ?? null, pointerEvents: getComputedStyle(node).pointerEvents };
      })(),
      buttons: [...document.querySelectorAll('button')].filter((node) => node.getBoundingClientRect().width > 0).map((node) => node.getAttribute('aria-label') || node.textContent?.replace(/\\s+/gu, ' ').trim()).filter(Boolean).slice(-30),
      conversationTextTail: (document.querySelector('.conversation')?.textContent ?? '').slice(-2000),
    }))()`,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  if (process.argv.includes('--screenshot')) {
    const capture = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(path.join(__dirname, '..', 'qa-artifacts', 'real-debug.png'), Buffer.from(capture.data, 'base64'));
  }
  process.stdout.write(`${JSON.stringify(response.result?.value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
