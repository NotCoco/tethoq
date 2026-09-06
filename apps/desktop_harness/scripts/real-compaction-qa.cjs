'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const providerSessionId = String(process.argv[2] ?? '');
const debugPort = Number(process.argv[3] ?? 9225);
assert.ok(providerSessionId, 'Pass the provider-native ID of a disposable Codex task.');

const artifactRoot = path.resolve(__dirname, '..', 'qa-artifacts');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const uiQuietWindowMs = 3_000;
const uiPollIntervalMs = 250;
const rawMetadataPattern = String.raw`(?:files\s+(?:mentioned|pasted)\s+(?:(?:in\s+)?attached\s+documents|(?:by|in)\s+(?:the\s+)?user)|agents?\.md|:codex-annotation\s*\{\s*index\s*=|<codex[_ -]?delegation>|<source[_ -]?thread[_ -]?id>|codex[_ -]?delegation|source[_ -]?thread[_ -]?id|oai-mem-citation)`;
let socket;
let sequence = 0;
const pending = new Map();
let session;
let originalSelectedId;
let originalTaskListMode;
let originalArchived = true;
let originalThreshold = null;

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = true) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Renderer evaluation failed');
  return response.result?.value;
}

async function request(type, payload = {}) {
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

async function visibleUiState(includeMetadata = false) {
  const rawMetadataExpression = includeMetadata
    ? `new RegExp(${JSON.stringify(rawMetadataPattern)}, 'iu').test(document.querySelector('.timeline')?.textContent ?? '')`
    : 'false';
  return await evaluate(`(() => {
    const rawMetadata = ${rawMetadataExpression};
    const compactSignature = (selector) => {
      const nodes = document.querySelectorAll(selector);
      const value = nodes.item(nodes.length - 1)?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '';
      return String(nodes.length) + ':' + String(value.length) + ':' + value.slice(-80);
    };
    return {
      compactionCount: document.querySelectorAll('.timeline-compaction-toggle').length,
      activeCompactionCount: document.querySelectorAll('.timeline-compaction-active').length,
      detailsCount: document.querySelectorAll('.timeline-compaction-detail').length,
      finalAnswerCount: document.querySelectorAll('.message-assistant .message-body').length,
      assistantSignature: compactSignature('.message-assistant .message-body'),
      userSignature: compactSignature('.message-user .message-body'),
      errorCount: document.querySelectorAll('.timeline-error-notice').length,
      busyReasoningCount: document.querySelectorAll('.reasoning-group[aria-busy=\"true\"]').length,
      rawMetadata,
    };
  })()`);
}

async function waitForStableUi(predicate, description, timeoutMs = 60_000, quietMs = uiQuietWindowMs) {
  const deadline = Date.now() + timeoutMs;
  let previousSerialized;
  let stableSince = 0;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await visibleUiState();
      if (predicate(state)) {
        const serialized = JSON.stringify(state);
        if (serialized !== previousSerialized) {
          previousSerialized = serialized;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= quietMs) {
          return { ...state, ...(await visibleUiState(true)) };
        }
      } else {
        previousSerialized = undefined;
        stableSince = 0;
      }
    } catch (error) { lastError = error; }
    await delay(uiPollIntervalMs);
  }
  throw new Error(`${description} did not remain stable for ${quietMs}ms${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
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
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`), description);
}

async function clickExpression(expression, description) {
  const point = await pointFor(expression, description);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
}

async function selectSession(sessionId) {
  const selector = `[data-session-id=${JSON.stringify(sessionId)}] > .session-row`;
  await clickExpression(`document.querySelector(${JSON.stringify(selector)})`, 'disposable compaction task row');
  await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected') === true`), 'compaction task selection');
  await waitFor(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Message\"]'))"), 'compaction task composer');
}

async function reloadRenderer() {
  await send('Page.reload', { ignoreCache: false });
  socket.close();
  await delay(100);
  await connect();
  await waitFor(() => evaluate("document.readyState === 'complete' && Boolean(window.tethoqDesktop)"), 'reloaded Tethoq renderer', 60_000);
  await waitFor(() => evaluate("Boolean(document.querySelector('.desktop-app'))"), 'reloaded Tethoq application surface', 60_000);
}

function immediateCompactionThreshold(context) {
  const minimum = context.minimumThresholdTokens;
  const maximum = context.contextWindowTokens;
  const used = context.usedTokens;
  assert.ok(Number.isSafeInteger(minimum) && minimum > 0, 'Provider omitted a valid minimum compaction threshold.');
  assert.ok(Number.isSafeInteger(maximum) && maximum >= minimum, 'Provider omitted a valid context window.');
  assert.ok(Number.isSafeInteger(used) && used >= 0, 'Provider omitted current context occupancy.');
  assert.ok(used >= minimum, 'This disposable task has not used enough context to trigger compaction through the visible threshold control.');
  const step = Math.max(1, Math.min(1_000, maximum - minimum));
  const atOrBelowUsed = minimum + Math.floor((Math.min(used, maximum) - minimum) / step) * step;
  const candidates = [atOrBelowUsed, atOrBelowUsed - step, minimum]
    .map((value) => Math.max(minimum, Math.min(maximum, value)))
    .filter((value, index, values) => value <= used && value !== context.compactionThresholdTokens && values.indexOf(value) === index);
  assert.ok(candidates.length, 'No visible threshold value can trigger compaction without reapplying the current setting.');
  return candidates[0];
}

async function setRangeWithPointer(selector, requestedValue) {
  const geometry = await waitFor(() => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return null;
    const rect = input.getBoundingClientRect();
    const minimum = Number(input.min);
    const maximum = Number(input.max);
    if (!(rect.width > 4) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return null;
    const ratio = (${Number(requestedValue)} - minimum) / (maximum - minimum);
    return {
      x: rect.left + Math.max(2, Math.min(rect.width - 2, ratio * rect.width)),
      y: rect.top + rect.height / 2,
    };
  })()`), 'automatic compaction slider geometry');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x, y: geometry.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x, y: geometry.y, button: 'left', buttons: 0, clickCount: 1 });
  return await waitFor(() => evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const value = input instanceof HTMLInputElement ? Number(input.value) : NaN;
    return Number.isFinite(value) ? value : null;
  })()`), 'automatic compaction slider value');
}

async function visibleConversation() {
  return await evaluate(`(() => ({
    users: [...document.querySelectorAll('.message-user .message-body')].map((node) => node.textContent?.replace(/\\s+/gu, ' ').trim() ?? ''),
    assistants: [...document.querySelectorAll('.message-assistant .message-body')].map((node) => node.textContent?.replace(/\\s+/gu, ' ').trim() ?? ''),
  }))()`);
}

async function restore() {
  if (session) {
    if (originalThreshold === null) {
      await request('session.context.clear_threshold', { sessionId: session.id }).catch(() => undefined);
    } else {
      await request('session.context.set_threshold', {
        sessionId: session.id,
        thresholdTokens: originalThreshold,
        compactNow: false,
      }).catch(() => undefined);
    }
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: session.id, override: { archived: originalArchived } })})`).catch(() => undefined);
  }
  if (originalTaskListMode) {
    await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-list-mode', value: originalTaskListMode })})`).catch(() => undefined);
  }
  if (originalSelectedId) {
    const exists = await evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${originalSelectedId}"] > .session-row`)}))`).catch(() => false);
    if (exists) await selectSession(originalSelectedId).catch(() => undefined);
  }
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await connect();
  originalSelectedId = await evaluate("document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId ?? null");
  const preferences = await evaluate('window.tethoqDesktop.preferencesState()');
  originalTaskListMode = preferences.taskListMode;

  const refreshed = await request('sessions.refresh');
  session = refreshed.sessions?.find((entry) => entry.providerId === 'codex' && entry.providerSessionId === providerSessionId);
  assert.ok(session?.id, 'Disposable Codex task is unavailable.');
  originalArchived = preferences.taskOverrides?.[session.id]?.archived === true;
  await evaluate("window.tethoqDesktop.preferencesAction({ type: 'set-task-list-mode', value: 'recent' })");
  await evaluate(`window.tethoqDesktop.preferencesAction(${JSON.stringify({ type: 'set-task-override', sessionId: session.id, override: { archived: false } })})`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${session.id}"] > .session-row`)}))`), 'unarchived compaction task row', 45_000);
  await selectSession(session.id);

  const before = (await request('session.context.get', { sessionId: session.id })).context;
  assert.equal(before.supportsManualCompaction, true, 'Codex did not expose manual compaction.');
  assert.equal(before.supportsThreshold, true, 'Codex did not expose an automatic threshold.');
  originalThreshold = before.compactionThresholdTokens;
  const requestedThreshold = immediateCompactionThreshold(before);
  const conversationBefore = await waitFor(async () => {
    const conversation = await visibleConversation();
    return conversation.users.length > 0 && conversation.assistants.length > 0 ? conversation : null;
  }, 'disposable task conversation', 60_000);
  const lastUser = conversationBefore.users.at(-1);
  const lastAssistant = conversationBefore.assistants.at(-1);

  await clickExpression("document.querySelector('.context-usage-trigger')", 'context settings trigger');
  await waitFor(() => evaluate("Boolean(document.querySelector('input[aria-label=\"Automatic compaction threshold\"]'))"), 'context threshold slider');
  const threshold = await setRangeWithPointer('input[aria-label="Automatic compaction threshold"]', requestedThreshold);
  assert.ok(threshold <= before.usedTokens, 'The visible slider did not select a threshold that triggers compaction.');
  assert.notEqual(threshold, originalThreshold, 'The visible slider did not change the threshold.');
  const beforeUi = await visibleUiState(true);
  assert.equal(beforeUi.compactionCount, 0, 'The disposable task already contains a compaction widget; use a fresh task so this check can prove the new widget was created.');
  assert.equal(beforeUi.rawMetadata, false, 'Raw provider metadata was already visible before compaction.');
  const expectedCompactionCount = beforeUi.compactionCount + 1;
  await evaluate(`(() => {
    const qa = { sawActive: Boolean(document.querySelector('.timeline-compaction-active')) };
    const observer = new MutationObserver(() => { qa.sawActive ||= Boolean(document.querySelector('.timeline-compaction-active')); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.__tethoqCompactionQa = { qa, observer };
  })()`);
  await clickExpression("[...document.querySelectorAll('.context-usage-popover button')].find((button) => button.textContent?.trim() === 'Apply')", 'apply automatic compaction threshold');
  const appliedContext = await waitFor(async () => {
    const context = (await request('session.context.get', { sessionId: session.id })).context;
    return context.compactionThresholdTokens === threshold && context.isCompacting === false ? context : null;
  }, 'visible threshold application and compaction completion', 180_000);
  const sawActive = await evaluate(`(() => {
    const result = window.__tethoqCompactionQa?.qa?.sawActive === true;
    window.__tethoqCompactionQa?.observer?.disconnect();
    delete window.__tethoqCompactionQa;
    return result;
  })()`);
  assert.equal(sawActive, true, 'The visible active compaction state never painted.');

  const stable = await waitForStableUi((state) => state.compactionCount === expectedCompactionCount
    && state.activeCompactionCount === 0
    && state.errorCount === 0
    && state.busyReasoningCount === 0, 'compaction UI', 60_000);
  const collapsed = await evaluate(`(() => ({
    count: document.querySelectorAll('.timeline-compaction-toggle').length,
    label: document.querySelector('.timeline-compaction-toggle')?.textContent?.replace(/\\s+/gu, ' ').trim(),
    rawMetadata: new RegExp(${JSON.stringify(rawMetadataPattern)}, 'iu').test(document.querySelector('.timeline')?.textContent ?? ''),
    finalAnswerCount: document.querySelectorAll('.message-assistant .message-body').length,
  }))()`);
  assert.equal(collapsed.count, expectedCompactionCount);
  assert.match(collapsed.label ?? '', /Session compacted/iu);
  assert.equal(collapsed.rawMetadata, false);
  assert.equal(collapsed.finalAnswerCount, beforeUi.finalAnswerCount, 'Compaction added or removed a visible final response.');
  await clickExpression("document.querySelector('.timeline-compaction-toggle')", 'compaction widget');
  await waitFor(() => evaluate("document.querySelectorAll('.timeline-compaction-detail').length === 1"), 'expanded compaction summary');
  const expanded = await evaluate(`(() => ({
    count: document.querySelectorAll('.timeline-compaction-detail').length,
    copy: document.querySelectorAll('.timeline-compaction-detail .timeline-compaction-copy').length,
    rawMetadata: new RegExp(${JSON.stringify(rawMetadataPattern)}, 'iu').test(document.querySelector('.timeline')?.textContent ?? ''),
  }))()`);
  assert.deepEqual(expanded, { count: 1, copy: 1, rawMetadata: false });

  await reloadRenderer();
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${session.id}"] > .session-row`)}))`), 'compaction task after renderer reload', 60_000);
  await selectSession(session.id);
  const reopened = await waitForStableUi((state) => state.compactionCount === expectedCompactionCount
    && state.activeCompactionCount === 0
    && state.errorCount === 0
    && state.busyReasoningCount === 0, 'reopened compaction UI', 60_000);
  assert.equal(reopened.compactionCount, expectedCompactionCount);
  assert.equal(reopened.detailsCount, 0, 'Reopened compaction unexpectedly retained the expanded disclosure.');
  assert.equal(reopened.rawMetadata, false);
  assert.equal((await request('session.context.get', { sessionId: session.id })).context.compactionThresholdTokens, threshold);
  const conversationAfter = await visibleConversation();
  assert.equal(conversationAfter.users.filter((text) => text === lastUser).length, 1, 'Compaction or reopen duplicated or lost the latest user message.');
  assert.equal(conversationAfter.assistants.filter((text) => text === lastAssistant).length, 1, 'Compaction or reopen duplicated or lost the visible final response.');

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const screenshotPath = path.join(artifactRoot, 'real-compaction.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const report = { task: { id: session.id, providerSessionId }, before, threshold, appliedContext, sawActive, beforeUi, stable, collapsed, expanded, reopened, conversationBefore, conversationAfter, screenshotPath };
  await writeFile(path.join(artifactRoot, 'real-compaction.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().finally(async () => {
  try { await restore(); } catch { /* Preserve the original QA failure. */ }
  socket?.close();
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
