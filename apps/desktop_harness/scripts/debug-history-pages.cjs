'use strict';

const assert = require('node:assert/strict');

const providerSessionId = process.argv[2];
const port = Number(process.argv[3] ?? 9225);
const maximumPages = Number(process.argv[4] ?? 12);
assert.match(providerSessionId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the Codex provider session id.');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let socket;
let sequence = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result?.value;
}

async function main() {
  let target;
  for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.json()).catch(() => []);
    target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
    if (!target) await delay(100);
  }
  assert.ok(target, 'Tethoq renderer is unavailable.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data));
    const handler = pending.get(value.id);
    if (!handler) return;
    pending.delete(value.id);
    value.error ? handler.reject(new Error(value.error.message)) : handler.resolve(value.result);
  });

  const report = await evaluate(`(async () => {
    let task;
    for (let attempt = 0; attempt < 100 && !task; attempt += 1) {
      const listed = await window.tethoqDesktop.request('sessions.list');
      task = listed?.payload?.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === ${JSON.stringify(providerSessionId)});
      if (!task) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!task) throw new Error('Requested Codex task is unavailable.');
    const pages = [];
    const seen = new Set();
    let cursor;
    for (let index = 0; index < ${maximumPages}; index += 1) {
      const started = performance.now();
      const response = await window.tethoqDesktop.request('session.open', { sessionId: task.id, limit: 40, ...(cursor ? { cursor } : {}) });
      if (!response?.ok) throw new Error(response?.error?.message ?? 'session.open failed');
      const payload = response.payload ?? {};
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const summaries = messages.map((message) => ({
        id: message.id,
        role: message.role,
        status: message.status,
        phase: message.nativeMetadata?.phase,
        partType: message.nativeMetadata?.partType,
        partTypes: Array.isArray(message.parts) ? message.parts.map((part) => part.type) : [],
        workflows: Array.isArray(message.parts) ? message.parts.filter((part) => part.type === 'workflow').map((part) => part.workflow) : [],
        text: Array.isArray(message.parts) ? message.parts.find((part) => typeof part.text === 'string')?.text?.slice(0, 80) : undefined,
      }));
      const conversationAnchors = summaries.filter((message) => message.role === 'user'
        || message.status === 'failed'
        || message.phase === 'final_answer'
        || message.partType === 'compaction');
      pages.push({
        index,
        cursor: cursor ?? null,
        nextCursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
        elapsedMs: performance.now() - started,
        payloadBytes: JSON.stringify(payload).length,
        messageBytes: messages.reduce((total, message) => total + JSON.stringify(message).length, 0),
        maxMessageBytes: Math.max(0, ...messages.map((message) => JSON.stringify(message).length)),
        messageCount: messages.length,
        roles: Object.fromEntries([...new Set(summaries.map((message) => message.role))].map((role) => [role, summaries.filter((message) => message.role === role).length])),
        first: summaries.slice(0, 4),
        last: summaries.slice(-4),
        conversationAnchors,
      });
      const next = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return { taskId: task.id, pages };
  })()`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
