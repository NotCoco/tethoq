'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const providerId = String(process.argv[2] ?? '');
const debugPort = Number(process.argv[3] ?? 9225);
const existingIndex = process.argv.indexOf('--existing');
const existingSessionId = existingIndex >= 0 ? process.argv[existingIndex + 1] : undefined;
const existingToken = existingIndex >= 0 ? process.argv[existingIndex + 2] : undefined;
const workdir = path.resolve(__dirname, '..', '..', '..', 'local-artifacts', 'real-provider-qa-2026-08-25', 'provider-selection-sandbox');
const artifactRoot = path.resolve(__dirname, '..', 'qa-artifacts');
const specs = {
  codex: { modelId: 'gpt-5.6-luna', effort: 'low', effortLabel: 'Light', label: 'Codex' },
  grok: { modelId: 'grok-4.5', effort: 'low', effortLabel: 'Low', label: 'Grok' },
  opencode: { modelId: 'opencode-go/deepseek-v4-pro', effort: 'high', effortLabel: 'High', label: 'OpenCode' },
};
const spec = specs[providerId];
assert.ok(spec, 'Pass codex, grok, or opencode as the provider.');
if (existingIndex >= 0) {
  assert.ok(existingSessionId && existingToken, '--existing needs the global session ID and expected final token.');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pending = new Map();
let createdSession;
let originalSessionId;
let originalRecentModelUses;

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

async function waitFor(operation, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(125);
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
  await Promise.all([send('Runtime.enable'), send('Page.enable')]);
}

async function pointFor(expression, description) {
  return await waitFor(() => evaluate(`(() => {
    const element = ${expression};
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
  })()`), description);
}

async function clickExpression(expression, description) {
  const point = await pointFor(expression, description);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function press(key, code = key, modifiers = 0) {
  const virtual = { Enter: 13, Escape: 27, Backspace: 8, a: 65 }[key] ?? 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers });
}

async function replaceFocused(value) {
  await press('a', 'KeyA', 2);
  await press('Backspace', 'Backspace');
  if (value) await send('Input.insertText', { text: value });
}

async function selectSession(sessionId) {
  const selector = `[data-session-id=${JSON.stringify(sessionId)}] > .session-row`;
  await clickExpression(`document.querySelector(${JSON.stringify(selector)})`, `${providerId} QA task row`);
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected') === true`), `${providerId} QA task selection`);
  await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]'))"), `${providerId} composer`);
}

async function chooseModel(model) {
  await clickExpression("document.querySelector('button[aria-label^=\"Choose model. Current model:\"]')", 'model picker trigger');
  await waitFor(() => evaluate("Boolean(document.querySelector('[role=\"dialog\"][aria-label=\"Choose model\"] input[aria-label=\"Search models\"]'))"), 'model picker');
  await evaluate("document.querySelector('[role=\"dialog\"][aria-label=\"Choose model\"] input[aria-label=\"Search models\"]')?.focus()");
  await replaceFocused(model.displayName);
  const candidateExpression = `(() => {
    const candidates = [...document.querySelectorAll('[role="dialog"][aria-label="Choose model"] .model-catalog-results button:not([disabled])')]
      .filter((button) => button.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(model.displayName)});
    return candidates.length === 1 ? candidates[0] : null;
  })()`;
  await clickExpression(candidateExpression, `${model.displayName} model choice`);
  await waitFor(() => evaluate(`document.querySelector('button[aria-label^="Choose model. Current model:"]')?.getAttribute('aria-label')?.includes(${JSON.stringify(model.displayName)}) === true`), `${model.displayName} selected`);
}

async function chooseEffort(label) {
  await clickExpression("document.querySelector('button[aria-label=\"Choose reasoning effort\"]')", 'reasoning picker trigger');
  const expression = `([...document.querySelectorAll('[role="menu"][aria-label="Choose reasoning effort"] button[role="menuitemradio"]')]
    .find((button) => button.querySelector('strong')?.textContent?.trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())}))`;
  await clickExpression(expression, `${label} reasoning choice`);
  await waitFor(() => evaluate(`document.querySelector('button[aria-label="Choose reasoning effort"] strong')?.textContent?.trim().toLowerCase() === ${JSON.stringify(label.toLowerCase())}`), `${label} reasoning selected`);
}

async function restoreSelection() {
  if (originalSessionId) {
    const exists = await evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${originalSessionId}"] > .session-row`)}))`);
    if (exists) await selectSession(originalSessionId);
  }
  if (createdSession) {
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: createdSession.id, override: { archived: true } })})`).catch(() => undefined);
  }
  await evaluate(`(() => {
    const value = ${JSON.stringify(originalRecentModelUses)};
    if (value === null) localStorage.removeItem('tethoq:recent-used-models:v1');
    else localStorage.setItem('tethoq:recent-used-models:v1', value);
  })()`).catch(() => undefined);
}

async function main() {
  await mkdir(workdir, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  originalSessionId = await evaluate("document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId ?? null");
  originalRecentModelUses = await evaluate("localStorage.getItem('tethoq:recent-used-models:v1')");

  const provider = await waitFor(async () => {
    const state = await bridgeRequest('provider.list');
    return state.providers?.find((entry) => entry.providerId === providerId && entry.state === 'online') ?? null;
  }, `${providerId} provider online`, 120_000);
  const models = (await bridgeRequest('models.list', { providerId })).models ?? [];
  const model = models.find((entry) => entry.id === spec.modelId);
  assert.ok(model, `${spec.modelId} is not advertised by ${providerId}.`);
  const variants = model.nativeMetadata?.variants;
  const advertisedEfforts = Array.isArray(model.nativeMetadata?.supportedReasoningEfforts)
    ? model.nativeMetadata.supportedReasoningEfforts.map((entry) => typeof entry === 'string' ? entry : entry?.reasoningEffort).filter(Boolean)
    : variants && typeof variants === 'object' ? Object.keys(variants) : [];
  assert.ok(advertisedEfforts.includes(spec.effort), `${model.displayName} does not advertise ${spec.effort} reasoning.`);

  let token;
  if (existingSessionId) {
    const refresh = await bridgeRequest('sessions.refresh');
    createdSession = refresh.sessions?.find((entry) => entry.id === existingSessionId);
    assert.ok(createdSession, `${providerId} existing QA task is unavailable.`);
    assert.equal(createdSession.providerId, providerId);
    token = existingToken;
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: existingSessionId, override: { archived: false } })})`);
  } else {
    const stamp = Date.now();
    token = `${providerId.toUpperCase()}_MODEL_REASONING_OK_${stamp}`;
    const title = `Tethoq ${spec.label} model reasoning QA ${stamp}`;
    createdSession = (await bridgeRequest('session.create', { providerId, workingDirectory: workdir, title })).session;
    assert.ok(createdSession?.id && createdSession?.providerSessionId, `${providerId} did not create a real task.`);
  }

  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${createdSession.id}"] > .session-row`)}))`), `${providerId} created task row`, 45_000);
  await selectSession(createdSession.id);
  if (!existingSessionId) {
    await chooseModel(model);
    await chooseEffort(spec.effortLabel);
  }

  const visibleSelection = await evaluate(`({
    model: document.querySelector('button[aria-label^="Choose model. Current model:"]')?.getAttribute('aria-label'),
    effort: document.querySelector('button[aria-label="Choose reasoning effort"] strong')?.textContent?.trim(),
  })`);
  assert.match(visibleSelection.model ?? '', new RegExp(model.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'));
  assert.equal(visibleSelection.effort?.toLowerCase(), spec.effortLabel.toLowerCase());

  if (!existingSessionId) {
    const prompt = `Reply with exactly ${token} and nothing else.`;
    await clickExpression("document.querySelector('textarea[aria-label=\"Message\"]')", 'message composer');
    await replaceFocused(prompt);
    await press('Enter', 'Enter');
  }

  const visibleFinal = await waitFor(async () => {
    const state = await bridgeRequest('sessions.refresh');
    const session = state.sessions?.find((entry) => entry.id === createdSession.id);
    const painted = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.message-assistant')]
        .filter((node) => node.textContent?.includes(${JSON.stringify(token)}));
      return { count: rows.length, text: rows[0]?.textContent?.trim() ?? '' };
    })()`);
    return painted.count === 1 && session && session.state !== 'working' ? { painted, session } : null;
  }, `${providerId} visible final`, 180_000);

  await delay(2_000);
  const stable = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.message-assistant')]
      .filter((node) => node.textContent?.includes(${JSON.stringify(token)}));
    return {
      count: rows.length,
      rawMetadata: /AGENTS\.md|files pasted by user|codex-annotation/i.test(document.querySelector('.timeline')?.textContent ?? ''),
      stopVisible: [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Stop' && button.getBoundingClientRect().width > 0),
    };
  })()`);
  assert.equal(stable.count, 1, `${providerId} final changed after settling.`);
  assert.equal(stable.rawMetadata, false, `${providerId} leaked provider metadata.`);
  assert.equal(stable.stopVisible, false, `${providerId} remained visibly active after its final.`);

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const screenshotPath = path.join(artifactRoot, `real-provider-selection-${providerId}.png`);
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = {
    provider: { id: providerId, state: provider.state },
    mode: existingSessionId ? 'reopen' : 'fresh-turn',
    task: { id: createdSession.id, providerSessionId: createdSession.providerSessionId },
    requested: { modelId: model.id, modelName: model.displayName, reasoningEffort: spec.effort },
    visibleSelection,
    visibleFinal,
    stable,
    token,
    screenshotPath,
  };
  await writeFile(path.join(artifactRoot, `real-provider-selection-${providerId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch(async (error) => {
  if (createdSession) {
    try {
      const state = await bridgeRequest('sessions.refresh');
      if (state.sessions?.find((entry) => entry.id === createdSession.id)?.state === 'working') {
        await bridgeRequest('session.interrupt', { sessionId: createdSession.id });
      }
    } catch { /* Best-effort cleanup of a disposable QA turn. */ }
  }
  throw error;
}).finally(async () => {
  try { await restoreSelection(); } catch { /* Report the original QA failure. */ }
  socket?.close();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
