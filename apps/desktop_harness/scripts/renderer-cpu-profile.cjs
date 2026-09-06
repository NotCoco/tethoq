'use strict';

const debugPort = Number(process.argv[2] ?? 9225);
const durationMs = Math.max(1_000, Math.min(30_000, Number(process.argv[3] ?? 8_000)));
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
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
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
  await send('Profiler.enable');
  const stateResponse = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => ({
      selectedSessionId: document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.getAttribute('data-session-id') ?? null,
      title: document.querySelector('.workspace-title h1')?.textContent?.trim() ?? null,
      anchors: document.querySelectorAll('[data-scroll-anchor]').length,
      conversationCharacters: document.querySelector('.conversation')?.textContent?.length ?? 0,
    }))()`,
  });
  const state = stateResponse.result?.value;
  await send('Profiler.setSamplingInterval', { interval: 1000 });
  await send('Profiler.start');
  await delay(durationMs);
  const { profile } = await send('Profiler.stop');
  const samples = new Map();
  for (const nodeId of profile.samples ?? []) samples.set(nodeId, (samples.get(nodeId) ?? 0) + 1);
  const rows = profile.nodes.map((node) => ({
    samples: samples.get(node.id) ?? 0,
    functionName: node.callFrame.functionName || '(anonymous)',
    url: node.callFrame.url,
    line: node.callFrame.lineNumber + 1,
    column: node.callFrame.columnNumber + 1,
  })).filter((row) => row.samples > 0).sort((left, right) => right.samples - left.samples);
  const totalSamples = rows.reduce((sum, row) => sum + row.samples, 0);
  process.stdout.write(`${JSON.stringify({ durationMs, state, totalSamples, top: rows.slice(0, 40).map((row) => ({ ...row, percent: Number((row.samples / totalSamples * 100).toFixed(2)) })) }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
