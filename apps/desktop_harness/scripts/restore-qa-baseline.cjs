'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const debugPort = Number(process.argv[2] ?? 9225);
const artifactRoot = path.resolve(__dirname, '..', 'qa-artifacts');
const reportPath = path.join(artifactRoot, 'restored-baseline.json');
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

async function waitFor(operation, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

function baselineView(value) {
  return {
    experimentalFeatures: value.experimentalFeatures,
    reasoningDisplay: value.reasoningDisplay,
    taskListMode: value.taskListMode,
    localOpenHandlerId: value.localOpenHandlerId,
    closeAction: value.closeAction,
    launchAtLogin: value.launchAtLogin,
    alerts: value.alerts,
    allowForeignSubagents: value.allowForeignSubagents,
    ears: value.ears,
  };
}

async function main() {
  const target = await waitFor(async () => {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.json()).catch(() => []);
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

  const before = await evaluate('window.tethoqDesktop.preferencesState()');
  const actions = [
    { type: 'set-experimental-features', enabled: false },
    { type: 'set-reasoning-display', value: 'compact' },
    { type: 'set-task-list-mode', value: 'project' },
    { type: 'set-close-action', value: 'tray' },
    { type: 'set-launch-at-login', value: 'off' },
    { type: 'set-alerts', value: 'all' },
    { type: 'set-allow-foreign-subagents', enabled: false },
    { type: 'set-ears', ears: { enabled: false, providerId: null, modelId: null, mode: 'cleaned' } },
  ];
  for (const action of actions) {
    const result = await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify(action)})`);
    assert.ok(result && typeof result === 'object', `Preference action failed: ${action.type}`);
  }
  const after = await evaluate('window.tethoqDesktop.preferencesState()');
  const expected = {
    experimentalFeatures: false,
    reasoningDisplay: 'compact',
    taskListMode: 'project',
    localOpenHandlerId: 'system',
    closeAction: 'tray',
    launchAtLogin: 'off',
    alerts: 'all',
    allowForeignSubagents: false,
    ears: { enabled: false, providerId: null, modelId: null, mode: 'cleaned' },
  };
  assert.deepEqual(baselineView(after), expected, 'QA baseline was not restored exactly.');
  const report = { before: baselineView(before), after: baselineView(after), expected };
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().finally(() => socket?.close()).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
