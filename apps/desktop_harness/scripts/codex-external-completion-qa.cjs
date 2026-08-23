'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const threadId = process.argv[2];
const expected = process.argv[3];
const debugPort = Number(process.argv[4] ?? 9338);
const settledReplay = process.argv[5] === '--settled';
assert.match(threadId ?? '', /^[0-9a-f-]{36}$/iu, 'Pass the externally owned Codex thread ID.');
assert.ok(expected, 'Pass the exact answer marker.');

const artifactRoot = path.join(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'codex-external-completion.json');
const screenshotPath = path.join(artifactRoot, 'codex-external-completion.png');
let socket;
let nextId = 0;
const pending = new Map();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(operation, description, timeoutMs = 60_000) {
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

async function startTrace(sessionId) {
  return evaluate(`(() => {
    window.__tethoqCompletionQa?.observer?.disconnect();
    const sessionId = ${JSON.stringify(sessionId)};
    const expected = ${JSON.stringify(expected)};
    const state = { startedAt: performance.now(), samples: [] };
    const read = () => ({
      atMs: Number((performance.now() - state.startedAt).toFixed(1)),
      answerOccurrences: [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.includes(expected)).length,
      selectedSpinner: document.querySelector('[data-session-id="' + CSS.escape(sessionId) + '"] .session-row-working-spinner') !== null,
      reasoningAnimations: document.querySelectorAll('.reasoning-running, .reasoning-flow-running, .working-pulse').length,
      stopVisible: [...document.querySelectorAll('button[aria-label="Stop task"]')].some((node) => node.getBoundingClientRect().width > 0),
    });
    const sample = () => {
      const next = read();
      const previous = state.samples.at(-1);
      if (!previous || previous.answerOccurrences !== next.answerOccurrences || previous.selectedSpinner !== next.selectedSpinner || previous.reasoningAnimations !== next.reasoningAnimations || previous.stopVisible !== next.stopVisible) state.samples.push(next);
    };
    state.read = read;
    state.sample = sample;
    state.observer = new MutationObserver(sample);
    state.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__tethoqCompletionQa = state;
    sample();
    return true;
  })()`);
}

async function trace() {
  return evaluate(`(() => { const state = window.__tethoqCompletionQa; state?.sample?.(); return state ? { current: state.read(), samples: state.samples } : null; })()`);
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  const remote = await waitFor(async () => {
    const refresh = await bridgeRequest('sessions.refresh');
    return refresh.sessions?.find((session) => session.providerId === 'codex' && session.providerSessionId === threadId);
  }, 'external Codex QA task');
  if (!settledReplay) assert.equal(remote.externalWriter, true, 'The QA task is not externally owned.');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-session-id="${remote.id}"]'))`), 'QA task row');
  await clickSelector(`[data-session-id="${remote.id}"] > .session-row`);
  await waitFor(() => evaluate(`document.querySelector('[data-session-id="${remote.id}"] > .session-row')?.classList.contains('selected') === true`), 'QA task selection');
  await startTrace(remote.id);
  const answer = await waitFor(async () => {
    const current = await trace();
    return current?.current?.answerOccurrences === 1 ? current.current : null;
  }, 'persisted final answer');
  await delay(3_000);
  const completed = await trace();
  assert.equal(completed.current.answerOccurrences, 1, 'The final answer disappeared or duplicated.');
  assert.equal(completed.current.selectedSpinner, false, 'The task-list spinner survived the final answer.');
  assert.equal(completed.current.reasoningAnimations, 0, 'Reasoning shimmer survived the final answer.');
  assert.equal(completed.current.stopVisible, false, 'Stop survived the final answer.');
  const firstAnswer = completed.samples.find((sample) => sample.answerOccurrences === 1);
  assert.ok(firstAnswer, 'The final answer was never sampled.');
  assert.equal(completed.samples.slice(completed.samples.indexOf(firstAnswer)).every((sample) => !sample.selectedSpinner && sample.reasoningAnimations === 0 && !sample.stopVisible), true, 'A working affordance remained after the final answer frame.');
  // Failed setup attempts deliberately preserve their drafts. This task is a
  // disposable QA surface, so clear that retained text before the visual artifact.
  await evaluate(`(() => {
    const field = document.querySelector('textarea[aria-label="Message"]');
    if (!(field instanceof HTMLTextAreaElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return field.value === '';
  })()`);
  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = {
    threadId,
    sessionId: remote.id,
    answerVisibleAtMs: answer.atMs,
    terminalUiSettledOnAnswerFrame: true,
    screenshotPath,
    trace: completed.samples,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(async (error) => {
  try { process.stderr.write(`completion trace: ${JSON.stringify(await trace(), null, 2)}\n`); } catch {}
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
