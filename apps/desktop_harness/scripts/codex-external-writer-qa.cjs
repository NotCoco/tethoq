'use strict';

const assert = require('node:assert/strict');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const threadId = process.argv[2];
const rolloutPath = process.argv[3];
const debugPort = Number(process.argv[4] ?? 9338);
const selectOnly = process.argv[5] === '--select-only';
assert.match(threadId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the externally owned Codex thread ID.');
assert.ok(path.isAbsolute(rolloutPath ?? ''), 'Pass the absolute Codex rollout path.');

const canary = `TETHOQ_EXTERNAL_WRITER_QA_${Date.now()}`;
const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const screenshotPath = path.join(artifactRoot, 'codex-external-writer-queued.png');
const reportPath = path.join(artifactRoot, 'codex-external-writer.json');
let socket;
let nextId = 0;
const pending = new Map();

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(operation, description, timeoutMs = 15_000) {
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
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`), selector);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function canaryQueueMessages(sessionId) {
  const payload = await bridgeRequest('message_queue.list', { sessionId });
  return (payload.messages ?? []).filter((message) => message.content === canary);
}

async function startContinuityTrace() {
  return evaluate(`(() => {
    window.__tethoqExternalWriterQa?.observer?.disconnect();
    const state = { startedAt: performance.now(), samples: [] };
    const read = () => ({
      atMs: Number((performance.now() - state.startedAt).toFixed(1)),
      userOccurrences: [...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length,
      assistantOccurrences: [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length,
      queueOccurrences: [...document.querySelectorAll('.queued-message-content')].filter((node) => node.textContent?.includes(${JSON.stringify(canary)})).length,
      toasts: [...document.querySelectorAll('.toast')].map((node) => node.textContent?.trim() ?? ''),
      composer: document.querySelector('textarea[aria-label="Message"]')?.value ?? null,
    });
    const sample = () => {
      const next = read();
      const previous = state.samples.at(-1);
      if (!previous || previous.userOccurrences !== next.userOccurrences || previous.assistantOccurrences !== next.assistantOccurrences || previous.queueOccurrences !== next.queueOccurrences || previous.composer !== next.composer || JSON.stringify(previous.toasts) !== JSON.stringify(next.toasts)) {
        state.samples.push(next);
      }
    };
    state.observer = new MutationObserver(sample);
    state.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    state.read = read;
    state.sample = sample;
    window.__tethoqExternalWriterQa = state;
    sample();
    return true;
  })()`);
}

async function continuityTrace() {
  return evaluate(`(() => {
    const state = window.__tethoqExternalWriterQa;
    state?.sample?.();
    return state ? { current: state.read(), samples: state.samples } : null;
  })()`);
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const initialRollout = await readFile(rolloutPath, 'utf8');
  assert.equal(initialRollout.includes(canary), false);

  const refresh = await bridgeRequest('sessions.refresh');
  const remote = refresh.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === threadId);
  assert.ok(remote, 'The externally owned Codex task was not listed in the packaged app.');
  assert.equal(remote.externalWriter, true, `The packaged provider did not expose external writer ownership: ${JSON.stringify(remote)}`);
  if (!selectOnly) assert.equal(remote.state, 'idle', 'The no-flash canary requires an idle task; active work has a genuine visible follow-up queue.');
  assert.equal((await canaryQueueMessages(remote.id)).length, 0, 'The canary already existed before the QA submission.');

  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id="${remote.id}"]'))`), 'target task row');
  await clickSelector(`[data-session-id="${remote.id}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${remote.id}"] > .session-row')?.classList.contains('selected') === true`), 'target task selection');
  if (selectOnly) {
    process.stdout.write(`${JSON.stringify({ selectedSessionId: remote.id }, null, 2)}\n`);
    return;
  }
  await clickSelector('textarea[aria-label="Message"]');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await send('Input.insertText', { text: canary });
  await waitFor(() => evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(canary)}`), 'canary composer text');
  await startContinuityTrace();
  await clickSelector('.send-button');

  await waitFor(async () => {
    const trace = await continuityTrace();
    return trace?.current?.userOccurrences === 1 && trace.current.composer === '' ? trace.current : null;
  }, 'immediate optimistic transcript row');

  const queued = await waitFor(async () => {
    const messages = await canaryQueueMessages(remote.id);
    return messages.length === 1 ? messages : null;
  }, 'one native Desktop queue record');
  await delay(1_500);
  assert.equal((await canaryQueueMessages(remote.id)).length, 1, 'One submit produced repeated Desktop queue records.');
  const visibleState = await evaluate(`(() => ({
    composer: document.querySelector('textarea[aria-label="Message"]')?.value,
    activeWriterError: document.body.textContent.includes('already has an active writer'),
    queueOccurrences: [...document.querySelectorAll('*')].filter((node) => node.childElementCount === 0 && node.textContent === ${JSON.stringify(canary)}).length,
  }))()`);
  assert.equal(visibleState.composer, '', 'The real composer did not settle after the queue submission.');
  assert.equal(visibleState.activeWriterError, false, 'The packaged composer still attempted the direct active-writer path.');

  const cancel = await bridgeRequest('message_queue.cancel', { messageId: queued[0].id });
  assert.equal(cancel.cancelled, true, 'The QA canary could not be removed from Codex Desktop.');
  await waitFor(async () => (await canaryQueueMessages(remote.id)).length === 0, 'canary queue removal');
  await waitFor(async () => (await continuityTrace())?.current?.queueOccurrences === 0, 'queued-strip removal');
  await delay(300);
  assert.equal((await canaryQueueMessages(remote.id)).length, 0, 'The canary reappeared after cancellation.');
  const trace = await continuityTrace();
  assert.equal(trace.current.userOccurrences, 1, 'The transcript row disappeared when the queue record was removed.');
  const firstShownIndex = trace.samples.findIndex((sample) => sample.userOccurrences === 1);
  assert.ok(firstShownIndex >= 0, 'The optimistic transcript row was never observed.');
  assert.equal(trace.samples.slice(firstShownIndex).every((sample) => sample.userOccurrences === 1), true, 'The transcript row disappeared after first becoming visible.');
  assert.equal(trace.samples.every((sample) => sample.userOccurrences <= 1), true, 'One submission rendered duplicate transcript rows.');
  assert.equal(trace.samples.every((sample) => sample.assistantOccurrences === 0), true, 'The submitted user text briefly rendered with assistant identity.');
  assert.equal(trace.samples.every((sample) => sample.queueOccurrences === 0), true, 'The transport-only native queue record flashed as a visible queued follow-up.');
  assert.equal(trace.samples.flatMap((sample) => sample.toasts).some((toast) => /^Instruction (?:queued|sent)$/iu.test(toast)), false, 'An ordinary instruction confirmation toast was shown.');

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const finalRollout = await readFile(rolloutPath, 'utf8');
  assert.equal(finalRollout.includes(canary), false, 'The QA canary reached the Codex rollout and could have consumed usage.');

  const report = {
    threadId,
    sessionId: remote.id,
    externalWriter: remote.externalWriter,
    queueRecordsAfterOneSubmit: 1,
    queueRecordsAfterCancellation: 0,
    directWriterErrorVisible: false,
    canaryReachedRollout: false,
    optimisticTranscriptLatencyMs: trace.samples[firstShownIndex].atMs,
    transcriptContinuousThroughQueueRemoval: true,
    transportQueueFramesVisible: 0,
    duplicateTranscriptRows: false,
    userTextRenderedAsAssistant: false,
    instructionConfirmationToastVisible: false,
    trace: trace.samples,
    screenshotPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await evaluate(`location.reload()`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(async (error) => {
  try {
    const trace = await continuityTrace();
    process.stderr.write(`continuity trace: ${JSON.stringify(trace, null, 2)}\n`);
  } catch {}
  try {
    const refresh = await bridgeRequest('sessions.refresh');
    const remote = refresh.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === threadId);
    if (remote) {
      for (const message of await canaryQueueMessages(remote.id)) {
        await bridgeRequest('message_queue.cancel', { messageId: message.id }).catch(() => undefined);
      }
    }
  } catch {}
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
