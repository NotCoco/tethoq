'use strict';

// Reusable, no-focus CDP journeys for real OpenCode-through-Tethoq edge QA.
// The script is inert unless --live is supplied. Launch the packaged app with
// its transparent smoke profile and a remote-debugging port before a live run.

const assert = require('node:assert/strict');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const artifactDirectory = path.resolve(__dirname, '..', '..', '..', 'local-artifacts', 'qa-opencode-edges');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const BROWSER_TOOL_NAMES = Object.freeze([
  'browser_get_state', 'browser_open', 'browser_navigate', 'browser_inspect',
  'browser_inspect_all', 'browser_click', 'browser_type', 'browser_scroll',
  'browser_capture', 'browser_activate', 'browser_close', 'browser_back',
  'browser_forward', 'browser_reload', 'browser_stop', 'browser_set_muted',
]);
const successfulTerminalStates = new Set(['completed', 'idle']);
const unsuccessfulTerminalStates = new Set(['failed', 'offline', 'needs_approval', 'needs_input']);

function futureLocalMinuteValue(now = new Date(), minimumLeadMilliseconds = 90_000) {
  assert.ok(Number.isFinite(minimumLeadMilliseconds) && minimumLeadMilliseconds >= 60_000,
    'Scheduled live QA needs at least one minute of lead time.');
  const target = new Date(now.getTime() + minimumLeadMilliseconds);
  target.setSeconds(0, 0);
  if (target.getTime() < now.getTime() + minimumLeadMilliseconds) target.setMinutes(target.getMinutes() + 1);
  const part = (value) => String(value).padStart(2, '0');
  return `${target.getFullYear()}-${part(target.getMonth() + 1)}-${part(target.getDate())}T${part(target.getHours())}:${part(target.getMinutes())}`;
}

function safeArtifactSegment(value) {
  return String(value).replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'state';
}

function normalizeVisibleText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function sessionRelationshipKind(session) {
  return session?.relationshipKind ?? session?.relationship?.kind;
}

function sessionModelId(session) {
  return session?.model ?? session?.modelId;
}

function sessionReasoningEffort(session) {
  return session?.effort ?? session?.reasoningEffort ?? session?.variantId;
}

function browserToolNames(value) {
  const names = [...String(value ?? '').toLowerCase().matchAll(
    /(?:^|[^a-z0-9_])(?:mcp__uar_mesh__|uar_mesh__?)?(browser_[a-z_]+)(?![a-z0-9_])/gu,
  )].map((match) => match[1]);
  return [...new Set(names)].sort();
}

function assertCompleteBrowserToolInventory(value) {
  assert.deepEqual(browserToolNames(value), [...BROWSER_TOOL_NAMES].sort(),
    'The terminal response did not contain exactly the complete 16-tool in-app Browser inventory.');
}

function assertSuccessfulBrowserGetStateActivity(activities) {
  const calls = (activities ?? []).filter((activity) =>
    browserToolNames(`${activity?.target ?? ''} ${activity?.details ?? ''}`).includes('browser_get_state'));
  assert.ok(calls.length > 0, 'The visible activity did not contain a browser_get_state result.');
  for (const call of calls) {
    const label = normalizeVisibleText(call.label);
    const details = String(call.details ?? '');
    assert.equal(call.failed === true || label.toLowerCase() === 'issue', false,
      `browser_get_state was painted as ${label || 'a failed activity'}.`);
    assert.doesNotMatch(`${call.target ?? ''}\n${details}`, /tool[-_ ]?error|\bENOENT\b/iu,
      'browser_get_state painted a tool error instead of a successful result.');
  }
  const successful = calls.find((call) => {
    const details = String(call.details ?? '');
    return /\bactive_tab_id\b/iu.test(details) && /\bvisible\b/iu.test(details) && /\btabs\b/iu.test(details);
  });
  assert.ok(successful,
    'browser_get_state was named in the visible activity, but no successful browser state result was shown.');
  return successful;
}

function assertScheduledParentSelection(scheduledTask, parent, {
  expectedModelId = 'opencode-go/deepseek-v4-flash-vision-exp',
  expectedReasoning = 'max',
} = {}) {
  const durableModel = normalizeVisibleText(sessionModelId(scheduledTask));
  const durableReasoning = normalizeVisibleText(sessionReasoningEffort(scheduledTask)).toLowerCase();
  assert.ok(durableModel, 'The durable scheduled task lost its selected OpenCode model.');
  assert.equal(durableModel.toLowerCase(), expectedModelId.toLowerCase(),
    `The durable scheduled task selected ${durableModel} instead of ${expectedModelId}.`);
  assert.equal(durableReasoning, expectedReasoning.toLowerCase(),
    `The durable scheduled task selected ${durableReasoning || 'no reasoning effort'} instead of ${expectedReasoning}.`);
  if (parent) {
    assert.equal(sessionModelId(parent), durableModel,
      `The materialized scheduled parent selected ${sessionModelId(parent) || 'no model'} instead of ${durableModel}.`);
    assert.equal(String(sessionReasoningEffort(parent) ?? '').toLowerCase(), durableReasoning,
      `The materialized scheduled parent selected ${sessionReasoningEffort(parent) || 'no reasoning effort'} instead of ${durableReasoning}.`);
  }
  return { modelId: durableModel, reasoningEffort: durableReasoning };
}

function parseArguments(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) continue;
    const name = current.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[name] = next;
      index += 1;
    } else flags.add(name);
  }
  return { values, flags };
}

class HiddenCdp {
  constructor(debugPort) {
    this.debugPort = debugPort;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
      const targets = await response.json();
      return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? '')) ?? null;
    }, 'hidden packaged Tethoq renderer', 20_000);
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (message) => {
      const response = JSON.parse(String(message.data));
      const handler = this.pending.get(response.id);
      if (!handler) return;
      this.pending.delete(response.id);
      response.error ? handler.reject(new Error(response.error.message)) : handler.resolve(response.result);
    });
    await Promise.all([this.send('Runtime.enable'), this.send('Page.enable'), this.send('DOM.enable')]);
    assert.equal(await this.evaluate('Boolean(window.tethoqDesktop && document.querySelector(".desktop-app"))'), true,
      'The CDP target is not Tethoq Desktop.');
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
    this.socket = null;
  }

  send(method, params = {}, timeoutMilliseconds = 10_000) {
    assert.ok(this.socket, 'CDP is not connected.');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMilliseconds} ms`));
      }, timeoutMilliseconds);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMilliseconds = 10_000) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMilliseconds);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Renderer evaluation failed');
    }
    return response.result?.value;
  }

  async request(type, payload = {}) {
    const response = await this.evaluate(`window.tethoqDesktop.request(${JSON.stringify(type)}, ${JSON.stringify(payload)})`, 20_000);
    if (!response?.ok) throw new Error(response?.error?.message ?? `${type} failed`);
    return response.payload;
  }

  async pointFor(selector, text) {
    return await waitFor(() => this.evaluate(`(() => {
      const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const element = ${text === undefined
        ? 'candidates[0]'
        : `candidates.find((candidate) => candidate.textContent?.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))`};
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`), `${selector}${text === undefined ? '' : ` containing ${JSON.stringify(text)}`}`);
  }

  async click(selector, text) {
    const point = await this.pointFor(selector, text);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async press(key, code = key, modifiers = 0) {
    const windowsVirtualKeyCode = { Enter: 13, Escape: 27, Backspace: 8, a: 65 }[key] ?? key.toUpperCase().charCodeAt(0);
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });
  }

  async fill(selector, value) {
    await this.click(selector);
    await this.press('a', 'KeyA', 2);
    await this.press('Backspace', 'Backspace');
    if (value) await this.send('Input.insertText', { text: value });
    await waitFor(() => this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`), `${selector} value`);
  }

  async dropFile(selector, filePath) {
    const absolute = path.resolve(filePath);
    await readFile(absolute);
    const point = await this.pointFor(selector);
    const data = { items: [], files: [absolute], dragOperationsMask: 1 };
    await this.send('Input.dispatchDragEvent', { type: 'dragEnter', x: point.x, y: point.y, data });
    await this.send('Input.dispatchDragEvent', { type: 'dragOver', x: point.x, y: point.y, data });
    await this.send('Input.dispatchDragEvent', { type: 'drop', x: point.x, y: point.y, data });
    const name = path.basename(absolute);
    await waitFor(() => this.evaluate(`document.querySelector('.attachment-chips')?.textContent?.includes(${JSON.stringify(name)}) === true`), `${name} attachment chip`);
  }

  async screenshot(name) {
    await mkdir(artifactDirectory, { recursive: true });
    let result;
    try {
      result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 8_000);
    } catch (error) {
      if (!(error instanceof Error) || !/^Page\.captureScreenshot timed out/u.test(error.message)) throw error;
      // A long-hidden Electron compositor can miss its first capture frame even
      // while Runtime and DOM requests remain responsive. That timed-out request
      // wakes the surface; retry the artifact capture once without replaying any
      // user interaction or model journey.
      result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20_000);
    }
    const output = path.join(artifactDirectory, `${name}.png`);
    await writeFile(output, Buffer.from(result.data, 'base64'));
    return output;
  }
}

async function waitFor(operation, description, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
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

async function sessions(cdp) {
  return (await cdp.request('sessions.refresh')).sessions ?? [];
}

async function selectTopLevelSession(cdp, sessionId) {
  const selector = `[data-session-id=${JSON.stringify(sessionId)}] > .session-row`;
  await cdp.click(selector);
  await waitFor(() => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.classList.contains('selected') === true`), `task ${sessionId} selection`);
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(\'textarea[aria-label="Message"]\'))'), 'task composer');
}

async function openDelegatedChild(cdp, child, availableSessions) {
  assert.equal(sessionRelationshipKind(child), 'subagent', `${child.id} is not a delegated child task.`);
  assert.ok(child.parentSessionId, `Delegated child ${child.id} has no parent task.`);
  const parent = availableSessions.find((session) => session.id === child.parentSessionId);
  assert.ok(parent, `Parent task ${child.parentSessionId} for delegated child ${child.id} was not found.`);
  await selectTopLevelSession(cdp, parent.id);
  const triggerSelector = `[data-session-id=${JSON.stringify(parent.id)}] .session-subagents-trigger`;
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(triggerSelector)}))`),
    `sub-agent control for ${parent.id}`, 30_000);
  await cdp.click(triggerSelector);
  const dialogSelector = '[role="dialog"][aria-label^="Sub-agents for"]';
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(dialogSelector)}))`),
    `sub-agent dialog for ${parent.id}`);
  const childIndex = await waitFor(() => cdp.evaluate(`(() => {
    const dialog = document.querySelector(${JSON.stringify(dialogSelector)});
    if (!(dialog instanceof HTMLElement)) return null;
    const wantedId = ${JSON.stringify(child.id)};
    const wantedNames = ${JSON.stringify([child.agentNickname, child.title].filter(Boolean).map(normalizeVisibleText))};
    const wantedModel = ${JSON.stringify(normalizeVisibleText(sessionModelId(child)))};
    const wantedProvider = ${JSON.stringify(String(child.providerId ?? ''))};
    const buttons = [...dialog.querySelectorAll(':scope > button')];
    const byId = buttons.findIndex((button) => button.dataset.sessionId === wantedId);
    if (byId >= 0) return byId + 1;
    const exact = buttons.findIndex((button) => {
      const name = (button.querySelector('strong')?.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const model = (button.querySelector('.session-subagent-model')?.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const provider = button.querySelector('.provider-logo')?.getAttribute('data-provider-id') ?? '';
      return (!wantedNames.length || wantedNames.includes(name))
        && (!wantedModel || model === wantedModel)
        && (!wantedProvider || provider === wantedProvider);
    });
    if (exact >= 0) return exact + 1;
    const modelAndProvider = buttons.findIndex((button) => {
      const model = (button.querySelector('.session-subagent-model')?.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const provider = button.querySelector('.provider-logo')?.getAttribute('data-provider-id') ?? '';
      return (!wantedModel || model === wantedModel) && (!wantedProvider || provider === wantedProvider);
    });
    return modelAndProvider >= 0 ? modelAndProvider + 1 : null;
  })()`), `delegated child ${child.id} in its parent dialog`, 30_000);
  await cdp.click(`${dialogSelector} > button:nth-of-type(${childIndex})`);
  await waitFor(() => cdp.evaluate(`(() => {
    const composer = document.querySelector('textarea[aria-label="Message"]');
    const back = document.querySelector('button[aria-label="Back to parent task"]');
    const provider = document.querySelector('.workspace-header > .provider-logo')?.getAttribute('data-provider-id') ?? '';
    const title = document.querySelector('.workspace-title h1')?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '';
    const expectedTitle = ${JSON.stringify(normalizeVisibleText(child.title))};
    const expectedPreview = ${JSON.stringify(normalizeVisibleText(child.preview))};
    const promptVisible = !expectedPreview || [...document.querySelectorAll('.message-user .message-body')]
      .some((message) => (message.textContent ?? '').replace(/\\s+/gu, ' ').trim() === expectedPreview);
    return Boolean(composer && back) && provider === ${JSON.stringify(String(child.providerId ?? ''))}
      && (title === expectedTitle || promptVisible);
  })()`), `delegated child ${child.id} workspace`, 30_000);
}

async function selectSession(cdp, sessionId, sessionHint) {
  const availableSessions = await sessions(cdp);
  const task = sessionHint ?? availableSessions.find((session) => session.id === sessionId);
  assert.ok(task, `Tethoq task ${sessionId} was not found.`);
  const hasTopLevelRow = await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id=${JSON.stringify(sessionId)}] > .session-row`)}))`);
  if (hasTopLevelRow) await selectTopLevelSession(cdp, sessionId);
  else await openDelegatedChild(cdp, task, availableSessions);
  return task;
}

async function transcriptSnapshot(cdp, rootSelector = '.conversation-scroll') {
  return await cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!(root instanceof HTMLElement)) return null;
    const painted = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0;
    };
    const messages = [...root.querySelectorAll('article.message')].map((message, index) => ({
      index,
      anchor: message.getAttribute('data-scroll-anchor') ?? '',
      kind: message.classList.contains('message-user') ? 'user' : message.classList.contains('message-assistant') ? 'assistant' : 'other',
      text: (message.querySelector('.message-body')?.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
      busy: message.getAttribute('aria-busy') === 'true',
      files: [...message.querySelectorAll('.message-file-attachment')].map((attachment) => ({
        name: (attachment.querySelector('strong')?.textContent ?? '').trim(),
        label: (attachment.querySelector('small')?.textContent ?? '').trim(),
      })),
    }));
    const primaryTranscript = ${JSON.stringify(rootSelector)} === '.conversation-scroll';
    const reasoningAnimations = [...root.querySelectorAll(
      '[aria-busy="true"], .reasoning-shimmer, .timeline-working-pulse, .working-pulse, .reasoning-running, .message-assistant .spinner',
    )].filter(painted).length;
    return {
      messages,
      alerts: [...root.querySelectorAll('[role="alert"], .timeline-error-notice')].map((node) => (node.textContent ?? '').replace(/\\s+/gu, ' ').trim()).filter(Boolean),
      workingIndicators: reasoningAnimations,
      livePresentation: {
        reasoningAnimations,
        workingStatus: primaryTranscript && painted(document.querySelector('.workspace-title .status[aria-label="Working"]')),
        stopAction: primaryTranscript && painted(document.querySelector('.send-button[aria-label="Stop task"]')),
        sideChatSending: !primaryTranscript && painted(document.querySelector('.side-chat-send .spinner')),
      },
    };
  })()`);
}

function exactUserRowCount(snapshot, prompt) {
  const expected = normalizeVisibleText(prompt);
  return snapshot?.messages.filter((message) => {
    if (message.kind !== 'user') return false;
    return normalizeVisibleText(message.text) === expected;
  }).length ?? 0;
}

function hasPaintedLiveState(snapshot) {
  return (snapshot?.workingIndicators ?? 0) > 0
    || Object.values(snapshot?.livePresentation ?? {}).some((value) => value === true || (Number.isFinite(value) && value > 0));
}

function matchingUserRows(snapshot, prompt) {
  const expected = normalizeVisibleText(prompt);
  return (snapshot?.messages ?? []).filter((message) => message.kind === 'user'
    && normalizeVisibleText(message.text) === expected);
}

function newMessages(snapshot, baseline, kind) {
  const anchors = new Set((baseline?.messages ?? []).map((message) => message.anchor).filter(Boolean));
  const baselineLength = baseline?.messages.length ?? 0;
  return (snapshot?.messages ?? []).filter((message) => message.kind === kind
    && ((message.anchor && !anchors.has(message.anchor)) || message.index >= baselineLength));
}

function assertSinglePdfPresentation(snapshot, baseline, prompt, fileName) {
  const newUsers = newMessages(snapshot, baseline, 'user');
  assert.equal(newUsers.some((message) => /(?:^|\s)Attached file:/u.test(message.text)), false,
    'The PDF send painted synthetic "Attached file:" prose instead of relying on its file card.');
  const expectedRows = exactUserRowCount(baseline, prompt) + 1;
  const matchingRows = matchingUserRows(snapshot, prompt);
  assert.equal(matchingRows.length, expectedRows, 'The PDF send did not paint exactly one new canonical user message.');
  const newRow = matchingRows.at(-1);
  const matchingCards = (newRow?.files ?? []).filter((file) => file.name === fileName);
  assert.equal(matchingCards.length, 1, `The PDF send did not paint exactly one ${fileName} card on its user message.`);
  const newMatchingCards = newUsers.flatMap((message) => message.files ?? []).filter((file) => file.name === fileName);
  assert.equal(newMatchingCards.length, 1, `The PDF send painted ${newMatchingCards.length} new ${fileName} cards instead of one.`);
  return newRow;
}

function newAssistantMessages(snapshot, baseline) {
  return newMessages(snapshot, baseline, 'assistant');
}

async function waitForTerminalResponse(cdp, {
  sessionId,
  baseline,
  expectedText,
  expectBrowserTools = false,
  expectedUserPrompt,
  rootSelector = '.conversation-scroll',
  timeoutMilliseconds = 180_000,
}) {
  const deadline = Date.now() + timeoutMilliseconds;
  let latestTranscript = null;
  let latestTask = null;
  let stableTerminalKey = null;
  while (Date.now() < deadline) {
    latestTranscript = await transcriptSnapshot(cdp, rootSelector);
    latestTask = (await sessions(cdp)).find((session) => session.id === sessionId) ?? null;
    assert.ok(latestTask, `Task ${sessionId} disappeared while waiting for its response.`);
    if (latestTranscript?.alerts.length) throw new Error(`Task ${sessionId} showed an error: ${latestTranscript.alerts.join(' | ')}`);
    if (unsuccessfulTerminalStates.has(latestTask.state)) throw new Error(`Task ${sessionId} stopped in ${latestTask.state}.`);
    const expectedRows = expectedUserPrompt ? exactUserRowCount(baseline, expectedUserPrompt) + 1 : null;
    const userRows = expectedUserPrompt ? matchingUserRows(latestTranscript, expectedUserPrompt) : [];
    const userBoundary = expectedUserPrompt && userRows.length === expectedRows ? userRows.at(-1)?.index ?? Number.POSITIVE_INFINITY : -1;
    const candidates = newAssistantMessages(latestTranscript, baseline)
      .filter((message) => !message.busy && message.text && message.index > userBoundary);
    const terminal = candidates.at(-1);
    const terminalKey = terminal && successfulTerminalStates.has(latestTask.state) && !hasPaintedLiveState(latestTranscript)
      ? `${terminal.anchor || terminal.index}\u0000${terminal.text}\u0000${latestTask.state}`
      : null;
    if (terminalKey && terminalKey === stableTerminalKey) {
      if (expectedText) assert.ok(terminal.text.includes(normalizeVisibleText(expectedText)),
        `Task ${sessionId} terminal response did not contain ${JSON.stringify(expectedText)}. Received: ${terminal.text}`);
      if (expectBrowserTools) assertCompleteBrowserToolInventory(terminal.text);
      if (expectedUserPrompt) {
        assert.equal(exactUserRowCount(latestTranscript, expectedUserPrompt), expectedRows,
          `Task ${sessionId} did not reconcile this send to exactly one new canonical user row.`);
      }
      return { task: latestTask, response: terminal, transcript: latestTranscript };
    }
    stableTerminalKey = terminalKey;
    await delay(500);
  }
  throw new Error(`Task ${sessionId} did not produce a visible terminal response within ${timeoutMilliseconds} ms. Last state: ${latestTask?.state ?? 'missing'}.`);
}

async function selectModel(cdp, modelQuery, reasoningQuery, sourceQuery) {
  await cdp.click('button.model-picker-trigger');
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(\'[role="dialog"][aria-label="Choose model"]\'))'), 'model picker');
  await cdp.fill('input[aria-label="Search models"]', modelQuery);
  const selected = await cdp.evaluate(`(() => {
    const model = ${JSON.stringify(modelQuery.toLowerCase())};
    const source = ${JSON.stringify(sourceQuery?.toLowerCase() ?? '')};
    const buttons = [...document.querySelectorAll('.model-picker-dropup [data-provider-group="opencode"] > button')];
    const button = buttons.find((candidate) => candidate.querySelector('strong')?.textContent?.trim().toLowerCase() === model
      && (!source || candidate.getAttribute('title')?.toLowerCase().includes(source)));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(selected, true, `${modelQuery}${sourceQuery ? ` from ${sourceQuery}` : ''} is not available in OpenCode.`);
  await waitFor(() => cdp.evaluate('!document.querySelector(\'[role="dialog"][aria-label="Choose model"]\')'), 'model picker close');
  if (!reasoningQuery) return;
  await cdp.click('button[aria-label="Choose reasoning effort"]');
  await cdp.click('.effort-choice [role="menuitemradio"]', reasoningQuery);
}

async function composerGeometry(cdp) {
  return await cdp.evaluate(`(() => {
    const read = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, borderRadius: style.borderRadius };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      selectedSessionId: document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId ?? null,
      workspaceTitle: document.querySelector('.workspace-title h1')?.textContent?.replace(/\\s+/gu, ' ').trim() ?? null,
      composer: read('.composer-box'),
      textarea: read('textarea[aria-label="Message"]'),
      send: read('.send-button'),
      conversation: read('.conversation-scroll'),
      sideChat: read('[role="dialog"][aria-label="Side chat"]'),
      sideChatComposer: read('.side-chat-composer'),
      sideChatTextarea: read('textarea[aria-label="Side chat message"]'),
      sideChatSend: read('button[aria-label="Send side chat message"]'),
      sideChatTranscript: read('.side-chat-transcript'),
      transcriptRows: document.querySelectorAll('.conversation-scroll article.message').length,
      scrollTop: document.querySelector('.conversation-scroll')?.scrollTop ?? null,
      scrollHeight: document.querySelector('.conversation-scroll')?.scrollHeight ?? null,
      queueRows: document.querySelectorAll('.queued-message-row').length,
      toastErrors: [...document.querySelectorAll('.toast.toast-error')].map((node) => node.textContent?.trim() ?? '').filter(Boolean),
    };
  })()`);
}

function assertHealthyComposer(snapshot) {
  assert.ok(snapshot.composer && snapshot.textarea && snapshot.send, 'The composer lost one of its structural elements.');
  assert.ok(snapshot.composer.width >= 280 && snapshot.composer.width <= snapshot.viewport.width, 'The composer width is invalid.');
  assert.ok(snapshot.composer.height >= 48 && snapshot.composer.height < snapshot.viewport.height * 0.6, 'The composer shape grew outside a usable range.');
  assert.ok(snapshot.composer.x >= 0 && snapshot.composer.x + snapshot.composer.width <= snapshot.viewport.width + 1, 'The composer escaped the viewport.');
  assert.ok(Number.parseFloat(snapshot.composer.borderRadius) >= 8, 'The composer lost its rounded shape.');
}

function assertNoHorizontalJump(before, after) {
  assertHealthyComposer(before);
  assertHealthyComposer(after);
  assert.ok(Math.abs(before.composer.x - after.composer.x) <= 1, 'The composer jumped horizontally.');
  assert.ok(Math.abs(before.composer.width - after.composer.width) <= 1, 'The composer width jumped.');
  const beforeBottomGap = before.viewport.height - before.composer.bottom;
  const afterBottomGap = after.viewport.height - after.composer.bottom;
  assert.ok(Math.abs(beforeBottomGap - afterBottomGap) <= 1, 'The composer jumped vertically away from its anchored bottom edge.');
  for (const [key, label] of [['textarea', 'Composer input'], ['send', 'Composer send control']]) {
    if (!before[key] || !after[key]) continue;
    const beforeInnerBottomGap = before.viewport.height - before[key].bottom;
    const afterInnerBottomGap = after.viewport.height - after[key].bottom;
    assert.ok(Math.abs(beforeInnerBottomGap - afterInnerBottomGap) < 0.1,
      `${label} snapped vertically inside the anchored composer.`);
  }
  assert.equal(after.composer.borderRadius, before.composer.borderRadius, 'The composer changed its corner shape.');
  if (before.conversation && after.conversation) {
    assert.ok(Math.abs(before.conversation.x - after.conversation.x) <= 1, 'The transcript rail jumped horizontally.');
    assert.ok(Math.abs(before.conversation.width - after.conversation.width) <= 1, 'The transcript width jumped.');
  }
}

function assertSettledComposerShape(before, after) {
  assertNoHorizontalJump(before, after);
  assert.ok(Math.abs(before.composer.height - after.composer.height) <= 1, 'The composer did not return to its original settled height.');
}

function assertStableSideChatShape(before, after) {
  for (const [key, label] of [
    ['sideChat', 'Side-chat panel'],
    ['sideChatComposer', 'Side-chat composer'],
    ['sideChatTextarea', 'Side-chat input'],
    ['sideChatSend', 'Side-chat send control'],
    ['sideChatTranscript', 'Side-chat transcript'],
  ]) {
    assert.ok(before?.[key] && after?.[key], `${label} disappeared during the side-chat transition.`);
    for (const edge of ['x', 'y', 'right', 'bottom', 'width', 'height']) {
      assert.ok(Math.abs(before[key][edge] - after[key][edge]) <= 1, `${label} ${edge} jumped during the side-chat transition.`);
    }
    assert.equal(after[key].borderRadius, before[key].borderRadius, `${label} changed its corner shape.`);
  }
}

class EvidenceRecorder {
  constructor(cdp, journey) {
    this.cdp = cdp;
    this.runId = `${safeArtifactSegment(journey)}-${Date.now()}`;
    this.states = [];
  }

  async capture(stage, details = {}) {
    const geometry = await composerGeometry(this.cdp);
    const screenshotPath = await this.cdp.screenshot(`${this.runId}-${safeArtifactSegment(stage)}`);
    const state = { stage, screenshotPath, geometry, ...details };
    this.states.push(state);
    return state;
  }
}

async function sendComposer(cdp, prompt, { expectUserRow = true } = {}) {
  const baseline = await transcriptSnapshot(cdp);
  const previousMatchingRows = exactUserRowCount(baseline, prompt);
  await cdp.fill('textarea[aria-label="Message"]', prompt);
  await waitFor(() => cdp.evaluate('document.querySelector(\'.send-button\')?.disabled === false'), 'enabled send control');
  await cdp.click('.send-button');
  await waitFor(() => cdp.evaluate('document.querySelector(\'textarea[aria-label="Message"]\')?.value === ""'), 'cleared composer');
  if (expectUserRow) {
    await waitFor(async () => exactUserRowCount(await transcriptSnapshot(cdp), prompt) === previousMatchingRows + 1,
      'one immediate optimistic user row');
  }
  return { baseline, optimistic: await transcriptSnapshot(cdp) };
}

function visibleSimplifyPrompt(value) {
  const simplifyCommand = /(^|[\s([{:;,])\/simplify(?=$|\s|[,:;.!?](?:\s|$))[,:;.!?]?/giu;
  const source = value.trim();
  if (!simplifyCommand.test(source)) {
    simplifyCommand.lastIndex = 0;
    return source;
  }
  simplifyCommand.lastIndex = 0;
  const content = source
    .replace(simplifyCommand, '$1')
    .replace(/[ \t]+([,.;!?])/gu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/^\s*[,;:]\s*/u, '')
    .trim();
  simplifyCommand.lastIndex = 0;
  return content || 'Simplify the previous answer.';
}

function scheduledMeshDraftPrompt(prompt) {
  return `${prompt.trim()} /mesh /schedule`;
}

async function simplifyJourney(cdp, sessionId, prompt, expectedText, evidence) {
  const before = await composerGeometry(cdp);
  const baseline = await transcriptSnapshot(cdp);
  await cdp.fill('textarea[aria-label="Message"]', prompt);
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".simplify-command-row"))'), '/simplify control');
  const first = await composerGeometry(cdp);
  await evidence?.capture('simplify-command-open');
  await delay(150);
  const settled = await composerGeometry(cdp);
  assertNoHorizontalJump(before, first);
  assertNoHorizontalJump(first, settled);
  assert.ok(Math.abs(first.composer.height - settled.composer.height) <= 1, 'The /simplify composer did not settle.');
  await cdp.click('.send-button');
  await waitFor(() => cdp.evaluate('document.querySelector(\'textarea[aria-label="Message"]\')?.value === ""'), 'cleared /simplify composer');
  await evidence?.capture('simplify-optimistic-send');
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId,
    baseline,
    expectedText,
    expectedUserPrompt: visibleSimplifyPrompt(prompt),
  });
  const after = await composerGeometry(cdp);
  assertSettledComposerShape(before, after);
  await evidence?.capture('simplify-terminal');
  return { before, active: first, settled, after, terminal };
}

async function openSideChat(cdp) {
  await cdp.click('button[aria-label="More message actions"]');
  await cdp.click('.composer-actions-menu [role="menuitem"]', 'Open side chat');
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(\'[role="dialog"][aria-label="Side chat"]\'))'), 'side chat panel');
}

async function setSideChatRowsVisible(cdp, visible) {
  await cdp.click('button.sidebar-task-filter');
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(\'.task-filter-popover\'))'), 'task filters');
  const wasVisible = await cdp.evaluate('document.querySelector(\'.side-chat-filter button[role="checkbox"]\')?.getAttribute("aria-checked") === "true"');
  if (wasVisible !== visible) await cdp.click('.side-chat-filter button[role="checkbox"]', 'Show side chats');
  await cdp.click('button.sidebar-task-filter');
  await waitFor(() => cdp.evaluate('!document.querySelector(\'.task-filter-popover\')'), 'task filters close');
  return wasVisible;
}

async function sideChatJourney(cdp, parentSessionId, prompt, expectedText, evidence) {
  const beforeIds = new Set((await sessions(cdp)).map((session) => session.id));
  await openSideChat(cdp);
  const panelOpen = await evidence?.capture('side-chat-open');
  const baseline = await transcriptSnapshot(cdp, '.side-chat-transcript');
  const baselinePromptRows = exactUserRowCount(baseline, prompt);
  await cdp.fill('textarea[aria-label="Side chat message"]', prompt);
  await cdp.click('button[aria-label="Send side chat message"]');
  await waitFor(async () => exactUserRowCount(await transcriptSnapshot(cdp, '.side-chat-transcript'), prompt) === baselinePromptRows + 1,
    'side chat optimistic message');
  const optimistic = await evidence?.capture('side-chat-optimistic-send');
  const optimisticGeometry = optimistic?.geometry ?? await composerGeometry(cdp);
  assert.ok(optimisticGeometry.sideChat && optimisticGeometry.sideChatComposer, 'The side-chat panel or composer disappeared during optimistic send.');
  if (panelOpen?.geometry.sideChat) assertStableSideChatShape(panelOpen.geometry, optimisticGeometry);
  const sideChat = await waitFor(async () => (await sessions(cdp)).find((session) => !beforeIds.has(session.id)
    && session.sessionKind === 'side_chat' && session.parentSessionId === parentSessionId) ?? null, 'persisted OpenCode side chat', 20_000);
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId: sideChat.id,
    baseline,
    expectedText,
    expectedUserPrompt: prompt,
    rootSelector: '.side-chat-transcript',
  });
  const terminalEvidence = await evidence?.capture('side-chat-terminal');
  if (panelOpen?.geometry.sideChat && terminalEvidence?.geometry.sideChat) assertStableSideChatShape(panelOpen.geometry, terminalEvidence.geometry);
  await cdp.click('button[aria-label="Close side chat"]');
  await waitFor(() => cdp.evaluate('!document.querySelector(\'[role="dialog"][aria-label="Side chat"]\')'), 'side chat close');
  const sideChatRowsWereVisible = await setSideChatRowsVisible(cdp, true);
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`button[data-side-chat-id="${sideChat.id}"]`)}))`),
    'persisted side chat row', 20_000);
  await cdp.click(`button[data-side-chat-id=${JSON.stringify(sideChat.id)}]`);
  await waitFor(async () => {
    const reopened = await transcriptSnapshot(cdp, '.side-chat-transcript');
    return exactUserRowCount(reopened, prompt) === 1
      && reopened?.messages.some((message) => message.kind === 'assistant' && message.text.includes(normalizeVisibleText(expectedText)));
  }, 'reopened side chat transcript', 20_000);
  const reopened = await transcriptSnapshot(cdp, '.side-chat-transcript');
  assert.equal(exactUserRowCount(reopened, prompt), 1, 'The reopened side chat duplicated its user row.');
  const reopenedEvidence = await evidence?.capture('side-chat-reopened');
  if (panelOpen?.geometry.sideChat && reopenedEvidence?.geometry.sideChat) assertStableSideChatShape(panelOpen.geometry, reopenedEvidence.geometry);
  if (!sideChatRowsWereVisible) await setSideChatRowsVisible(cdp, false);
  return { sideChat, terminal, transcript: reopened };
}

async function chooseMeshTarget(cdp, providerLabel, modelLabel, reasoningLabel) {
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".mesh-panel"))'), 'mesh picker');
  const rowSelector = '.mesh-panel .mesh-add-row';
  const rowNumber = await waitFor(() => cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})];
    const index = rows.findIndex((candidate) => candidate.textContent?.toLowerCase().includes(${JSON.stringify(providerLabel.toLowerCase())}));
    return index < 0 ? null : index + 1;
  })()`), `${providerLabel} mesh row`, 20_000);
  await cdp.click(`${rowSelector}[data-mesh-index="${rowNumber - 1}"] .mesh-add-details`);
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".mesh-model-picker"))'), `${providerLabel} model picker`);
  await cdp.click('.mesh-model-picker section button[role="radio"]', modelLabel);
  if (reasoningLabel) {
    const clicked = await cdp.evaluate(`(() => {
      const section = [...document.querySelectorAll('.mesh-model-picker section')].find((candidate) => candidate.querySelector('h4')?.textContent?.trim() === 'Reasoning');
      const button = [...(section?.querySelectorAll('button[role="radio"]') ?? [])].find((candidate) => candidate.textContent?.toLowerCase().includes(${JSON.stringify(reasoningLabel.toLowerCase())}));
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true, `${reasoningLabel} reasoning is not available for ${modelLabel}.`);
  }
  await waitFor(() => cdp.evaluate('document.querySelector(".mesh-model-picker footer button.primary")?.disabled === false'),
    `${providerLabel} Mesh catalogue readiness`, 20_000);
  await cdp.click('.mesh-model-picker footer button.primary');
  await waitFor(() => cdp.evaluate(`document.querySelector('.composer-mesh-widget')?.textContent?.toLowerCase().includes(${JSON.stringify(modelLabel.toLowerCase())}) === true`), `${modelLabel} mesh chip`);
}

function midMessageMeshPrompt(prompt) {
  const value = String(prompt ?? '').trim();
  if (/\S[\s\S]*\s\/mesh\s[\s\S]*\S/u.test(value)) return value;
  const instruction = value.replace(/(?:^|\s)\/mesh(?=\s|$)/gu, ' ').replace(/\s+/gu, ' ').trim() || 'Reply READY.';
  return `Delegate via /mesh ${instruction}`;
}

function matchingNewMeshChildren(availableSessions, beforeIds, parentSessionId, providerId) {
  return availableSessions.filter((session) => !beforeIds.has(session.id)
    && sessionRelationshipKind(session) === 'subagent' && session.parentSessionId === parentSessionId
    && (!providerId || session.providerId === providerId));
}

async function meshJourney(cdp, parentSessionId, {
  providerLabel,
  providerId,
  modelLabel,
  reasoningLabel,
  expectedModelId,
  expectedReasoning,
  prompt,
}, evidence) {
  const beforeIds = new Set((await sessions(cdp)).map((session) => session.id));
  const beforeGeometry = await composerGeometry(cdp);
  const livePrompt = midMessageMeshPrompt(prompt);
  assert.match(livePrompt, /\S[\s\S]*\s\/mesh\s[\s\S]*\S/u, 'Mesh live QA must place /mesh genuinely inside the message.');
  await cdp.fill('textarea[aria-label="Message"]', livePrompt);
  assert.equal(await cdp.evaluate(`document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(livePrompt)}`), true,
    'The mid-message /mesh prompt was not retained verbatim in the composer.');
  await evidence?.capture('mesh-command-open');
  await chooseMeshTarget(cdp, providerLabel, modelLabel, reasoningLabel);
  const configuredGeometry = await composerGeometry(cdp);
  await evidence?.capture('mesh-target-configured');
  assertNoHorizontalJump(beforeGeometry, configuredGeometry);
  await cdp.click('.send-button');
  await waitFor(() => cdp.evaluate('document.querySelector(\'textarea[aria-label="Message"]\')?.value === ""'), 'cleared Mesh composer');
  await evidence?.capture('mesh-optimistic-send');
  await waitFor(async () => matchingNewMeshChildren(await sessions(cdp), beforeIds, parentSessionId, providerId).length > 0,
    `${providerLabel} mesh child`, 30_000);
  await delay(250);
  const matchingChildren = matchingNewMeshChildren(await sessions(cdp), beforeIds, parentSessionId, providerId);
  assert.equal(matchingChildren.length, 1, `${providerLabel} Mesh created ${matchingChildren.length} matching delegated children instead of one.`);
  const child = matchingChildren[0];
  assert.equal(sessionRelationshipKind(child), 'subagent');
  assert.equal(child.parentSessionId, parentSessionId);
  if (expectedModelId) assert.equal(sessionModelId(child), expectedModelId,
    `${providerLabel} Mesh selected ${sessionModelId(child) || 'no model'} instead of ${expectedModelId}.`);
  if (expectedReasoning) assert.equal(String(sessionReasoningEffort(child) ?? '').toLowerCase(), expectedReasoning.toLowerCase(),
    `${providerLabel} Mesh selected ${sessionReasoningEffort(child) || 'no reasoning effort'} instead of ${expectedReasoning}.`);
  await selectSession(cdp, child.id, child);
  const childGeometry = await composerGeometry(cdp);
  assertHealthyComposer(childGeometry);
  assert.equal(await cdp.evaluate('Boolean(document.querySelector(\'button[aria-label="More message actions"]\'))'), true,
    'The delegated child did not expose the ordinary task composer actions.');
  await evidence?.capture('mesh-delegated-child-open');
  return { child, beforeGeometry, configuredGeometry, childGeometry };
}

async function forceQueueMode(cdp) {
  await cdp.click('button[aria-label="More message actions"]');
  const mode = await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')]
    .find((button) => button.textContent?.includes('Send behavior:'))?.textContent ?? ''`), 'send behavior menu item');
  assert.match(mode, /Send behavior: (Queue|Steer)/u, 'The composer did not expose its queue/steer mode.');
  if (mode.includes('Steer')) await cdp.click('.composer-actions-menu [role="menuitem"]', 'Send behavior: Steer');
  else await cdp.press('Escape', 'Escape');
  await waitFor(() => cdp.evaluate('!document.querySelector(".composer-actions-menu [role=menuitem]")'), 'message actions menu close');
}

function assertQueuePromotionSamples(samples, baselinePromptRows) {
  assert.ok(samples.length >= 2, 'Queue promotion was not sampled across multiple painted frames.');
  for (const sample of samples) {
    const promotedRows = sample.userRows - baselinePromptRows;
    assert.equal(sample.queueRows + promotedRows, 1,
      `Queue promotion painted ${sample.queueRows} queue rows and ${promotedRows} promoted user rows in one frame.`);
  }
  const final = samples.at(-1);
  assert.equal(final.queueRows, 0, 'The queue row was still painted after steering settled.');
  assert.equal(final.userRows, baselinePromptRows + 1, 'The steered message did not settle to exactly one optimistic user row.');
}

async function beginQueuePromotionProbe(cdp, prompt) {
  await cdp.evaluate(`(() => {
    const expected = ${JSON.stringify(normalizeVisibleText(prompt))};
    const probe = { active: true, samples: [] };
    window.__tethoqQueuePromotionProbe = probe;
    const normalized = (value) => String(value ?? '').replace(/\\s+/gu, ' ').trim();
    const sample = () => {
      if (!probe.active) return;
      probe.samples.push({
        queueRows: [...document.querySelectorAll('.queued-message-row')]
          .filter((row) => normalized(row.textContent).includes(expected)).length,
        userRows: [...document.querySelectorAll('.conversation-scroll .message-user .message-body')]
          .filter((row) => normalized(row.textContent) === expected).length,
      });
      requestAnimationFrame(sample);
    };
    sample();
  })()`);
}

async function finishQueuePromotionProbe(cdp) {
  return await cdp.evaluate(`new Promise((resolve) => {
    let remaining = 4;
    const finish = () => requestAnimationFrame(() => {
      remaining -= 1;
      if (remaining > 0) finish();
      else {
        const probe = window.__tethoqQueuePromotionProbe;
        if (probe) probe.active = false;
        resolve(probe?.samples ?? []);
      }
    });
    finish();
  })`);
}

async function queueSteerJourney(cdp, childSessionId, switchSessionId, queuedPrompt, evidence, {
  expectedText,
  expectBrowserTools = false,
  expectBrowserGetStateCall = false,
  primePrompt,
} = {}) {
  const child = await selectSession(cdp, childSessionId);
  assert.equal(sessionRelationshipKind(child), 'subagent', 'Queue/steer QA must target an ordinary delegated child task.');
  let paintedWorking = await cdp.evaluate(`document.querySelector('.workspace-title .status')?.getAttribute('aria-label') === 'Working'
    && document.querySelector('.send-button')?.getAttribute('aria-label') === 'Stop task'`);
  if (!paintedWorking && primePrompt) {
    await sendComposer(cdp, primePrompt);
    paintedWorking = await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-title .status')?.getAttribute('aria-label') === 'Working'
      && document.querySelector('.send-button')?.getAttribute('aria-label') === 'Stop task'`), 'primed delegated child turn', 20_000);
  }
  assert.ok(paintedWorking, `Delegated child ${childSessionId} must visibly be Working with a Stop action before queue/steer QA.`);
  const baseline = await transcriptSnapshot(cdp);
  const baselinePromptRows = exactUserRowCount(baseline, queuedPrompt);
  const initialGeometry = await composerGeometry(cdp);
  await forceQueueMode(cdp);
  await sendComposer(cdp, queuedPrompt, { expectUserRow: false });
  await waitFor(() => cdp.evaluate(`document.querySelector('.queued-message-row')?.textContent?.includes(${JSON.stringify(queuedPrompt)}) === true`), 'queued child instruction');
  assert.equal(await cdp.evaluate(`document.querySelector('.workspace-title .status')?.getAttribute('aria-label') === 'Working'
    && document.querySelector('.send-button')?.getAttribute('aria-label') === 'Stop task'`), true,
    'The delegated child settled before its queued instruction could be steered; the long-running QA setup was not retained.');
  assert.equal(exactUserRowCount(await transcriptSnapshot(cdp), queuedPrompt), baselinePromptRows,
    'A queued instruction appeared in the transcript before it was steered.');
  const queuedGeometry = await composerGeometry(cdp);
  assert.equal(queuedGeometry.queueRows, 1, 'Queueing the instruction did not create exactly one visible queue row.');
  assertNoHorizontalJump(initialGeometry, queuedGeometry);
  await evidence?.capture('queue-inserted');
  if (switchSessionId) {
    await selectSession(cdp, switchSessionId);
    await evidence?.capture('queue-switched-away');
    await selectSession(cdp, childSessionId, child);
    await waitFor(() => cdp.evaluate(`document.querySelector('.queued-message-row')?.textContent?.includes(${JSON.stringify(queuedPrompt)}) === true`), 'queue persistence after task switch');
    assert.equal(await cdp.evaluate(`document.querySelector('.workspace-title .status')?.getAttribute('aria-label') === 'Working'
      && document.querySelector('.send-button')?.getAttribute('aria-label') === 'Stop task'`), true,
      'The delegated child settled while switching away and back, so explicit Steer could no longer be tested.');
    await evidence?.capture('queue-returned');
  }
  await beginQueuePromotionProbe(cdp, queuedPrompt);
  await cdp.click('.queued-message-row .queued-steer');
  const immediateSteerTranscript = await transcriptSnapshot(cdp);
  assert.equal(exactUserRowCount(immediateSteerTranscript, queuedPrompt), baselinePromptRows + 1,
    'Steer did not paint exactly one optimistic user row immediately after the click.');
  await waitFor(() => cdp.evaluate('!document.querySelector(".queued-message-row")'), 'steered queue removal', 20_000);
  const promotionSamples = await finishQueuePromotionProbe(cdp);
  assertQueuePromotionSamples(promotionSamples, baselinePromptRows);
  const afterSteer = await composerGeometry(cdp);
  assert.deepEqual(afterSteer.toastErrors, [], 'Queue steering raised an error toast.');
  assertNoHorizontalJump(queuedGeometry, afterSteer);
  await evidence?.capture('queue-steered');
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId: childSessionId,
    baseline,
    expectedText,
    expectBrowserTools,
    expectedUserPrompt: queuedPrompt,
  });
  let browserGetStateEvidence = null;
  if (expectBrowserGetStateCall) {
    const activityNames = await latestReasoningToolNames(cdp);
    assert.ok(browserToolNames(activityNames.join(' ')).includes('browser_get_state'),
      `The steered turn did not visibly prove a browser_get_state call: ${activityNames.join(' | ')}`);
    browserGetStateEvidence = activityNames;
  }
  const after = await composerGeometry(cdp);
  assertSettledComposerShape(initialGeometry, after);
  assert.equal(after.queueRows, 0, 'The steered instruction left a ghost queue row behind.');
  assert.deepEqual(after.toastErrors, [], 'Queue steering ended with an error toast.');
  await evidence?.capture('queue-terminal');
  return { child, baseline, queuedGeometry, promotionSamples, afterSteer, after, terminal, browserGetStateEvidence };
}

async function modelPdfJourney(cdp, sessionId, {
  pdf,
  model,
  modelSource,
  reasoning,
  prompt,
  expectedText,
  expectBrowserTools = false,
}, evidence) {
  await selectModel(cdp, model, reasoning, modelSource);
  const before = await composerGeometry(cdp);
  await evidence?.capture('pdf-baseline');
  await cdp.dropFile('.composer-box', pdf);
  const staged = await composerGeometry(cdp);
  assertNoHorizontalJump(before, staged);
  await evidence?.capture('pdf-attachment-staged');
  const sent = await sendComposer(cdp, prompt);
  const pdfName = path.basename(path.resolve(pdf));
  assertSinglePdfPresentation(sent.optimistic, sent.baseline, prompt, pdfName);
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.message-user .message-file-attachment strong')]
    .some((node) => node.textContent?.trim() === ${JSON.stringify(pdfName)})`), 'PDF attachment in the optimistic user row');
  await evidence?.capture('pdf-optimistic-send');
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId,
    baseline: sent.baseline,
    expectedText,
    expectBrowserTools,
    expectedUserPrompt: prompt,
  });
  assertSinglePdfPresentation(terminal.transcript, sent.baseline, prompt, pdfName);
  const after = await composerGeometry(cdp);
  assertSettledComposerShape(before, after);
  await evidence?.capture('pdf-terminal');
  return { before, staged, after, terminal };
}

async function newModelPdfJourney(cdp, sourceSessionId, options, evidence) {
  const beforeIds = new Set((await sessions(cdp)).map((session) => session.id));
  await selectSession(cdp, sourceSessionId);
  await cdp.fill('textarea[aria-label="Message"]', '');
  await cdp.click('button.new-task-button');
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-title h1')?.textContent?.trim() === 'New task'
    && document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId?.startsWith('draft-') === true`),
  'new OpenCode draft workspace');
  await selectModel(cdp, options.model, options.reasoning, options.modelSource);
  const before = await composerGeometry(cdp);
  await evidence?.capture('pdf-new-task-baseline');
  await cdp.dropFile('.composer-box', options.pdf);
  const staged = await composerGeometry(cdp);
  assertNoHorizontalJump(before, staged);
  await evidence?.capture('pdf-new-task-attachment-staged');
  const sent = await sendComposer(cdp, options.prompt);
  const pdfName = path.basename(path.resolve(options.pdf));
  assertSinglePdfPresentation(sent.optimistic, sent.baseline, options.prompt, pdfName);
  await evidence?.capture('pdf-new-task-optimistic-send');
  const session = await waitFor(async () => (await sessions(cdp)).find((candidate) => !beforeIds.has(candidate.id)
    && candidate.providerId === 'opencode' && sessionRelationshipKind(candidate) !== 'subagent') ?? null,
  'materialized OpenCode PDF task', 30_000);
  if (options.expectedModelId) {
    assert.equal(sessionModelId(session), options.expectedModelId,
      `The fresh OpenCode task used ${sessionModelId(session) || 'no model'} instead of ${options.expectedModelId}.`);
  }
  if (options.expectedReasoning) {
    assert.equal(String(sessionReasoningEffort(session) ?? '').toLowerCase(), options.expectedReasoning.toLowerCase(),
      `The fresh OpenCode task used ${sessionReasoningEffort(session) || 'no reasoning effort'} instead of ${options.expectedReasoning}.`);
  }
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId: session.id,
    baseline: sent.baseline,
    expectedText: options.expectedText,
    expectBrowserTools: options.expectBrowserTools,
    expectedUserPrompt: options.prompt,
  });
  assertSinglePdfPresentation(terminal.transcript, sent.baseline, options.prompt, pdfName);
  const after = await composerGeometry(cdp);
  assertSettledComposerShape(before, after);
  await evidence?.capture('pdf-new-task-terminal');
  return { session, before, staged, after, terminal };
}

async function scheduledMeshJourney(cdp, sourceSessionId, {
  parentModelLabel = 'DeepSeek V4 Flash Vision Exp',
  parentModelSource = 'OpenCode Go',
  parentReasoningLabel = 'Max',
  expectedParentModelId = 'opencode-go/deepseek-v4-flash-vision-exp',
  expectedParentReasoning = 'max',
  providerLabel,
  providerId,
  modelLabel,
  reasoningLabel,
  expectedModelId,
  expectedReasoning,
  prompt,
  expectedText,
  dispatchMode = 'run-now',
  dueLeadMilliseconds = 90_000,
}, evidence) {
  const beforeSessions = await sessions(cdp);
  const beforeIds = new Set(beforeSessions.map((session) => session.id));
  const beforeSchedules = (await cdp.request('scheduled_task.list')).tasks ?? [];
  await selectSession(cdp, sourceSessionId);
  await cdp.fill('textarea[aria-label="Message"]', '');
  await cdp.click('button.new-task-button');
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-title h1')?.textContent?.trim() === 'New task'
    && document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.dataset.sessionId?.startsWith('draft-') === true`),
  'new OpenCode draft workspace');
  await selectModel(cdp, parentModelLabel, parentReasoningLabel, parentModelSource);
  const baseline = await composerGeometry(cdp);
  await cdp.click('textarea[aria-label="Message"]');
  await cdp.press('a', 'KeyA', 2);
  await cdp.press('Backspace', 'Backspace');
  await cdp.send('Input.insertText', { text: scheduledMeshDraftPrompt(prompt) });
  // The schedule state is already active here, but its panel deliberately stays
  // behind the Mesh picker until the target is chosen.
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".mesh-panel"))'), 'scheduled Mesh target picker');
  await chooseMeshTarget(cdp, providerLabel, modelLabel, reasoningLabel);
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".composer-schedule-panel"))'), 'schedule panel');
  assert.equal(await cdp.evaluate('document.querySelector(\'textarea[aria-label="Message"]\')?.value'), prompt.trim(),
    'Opening /schedule did not leave the authored prompt intact.');
  await evidence?.capture('scheduled-mesh-target-configured');
  let dueLocalValue;
  if (dispatchMode === 'due') {
    dueLocalValue = futureLocalMinuteValue(new Date(), dueLeadMilliseconds);
    const appliedValue = await cdp.evaluate(`(() => {
      const input = document.querySelector('.composer-schedule-panel input[type="datetime-local"]');
      if (!(input instanceof HTMLInputElement)) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, ${JSON.stringify(dueLocalValue)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    })()`);
    assert.equal(appliedValue, dueLocalValue, 'The due-time field did not accept the requested local minute.');
    await waitFor(() => cdp.evaluate(`document.querySelector('.composer-schedule-panel input[type="datetime-local"]')?.value === ${JSON.stringify(dueLocalValue)}`),
      'scheduled due time');
  }
  const scheduledPanelGeometry = await composerGeometry(cdp);
  assertNoHorizontalJump(baseline, scheduledPanelGeometry);
  await evidence?.capture('scheduled-mesh-panel');
  await cdp.click('.composer-schedule-panel footer button.primary');
  await waitFor(() => cdp.evaluate('document.querySelector(".scheduled-task-notice")?.getAttribute("data-status") === "pending"'),
    'pending scheduled Mesh placeholder', 30_000);
  const pendingSchedules = (await cdp.request('scheduled_task.list')).tasks ?? [];
  const beforeRequestIds = new Set(beforeSchedules.map((task) => task.requestId));
  const scheduledTask = pendingSchedules.find((task) => !beforeRequestIds.has(task.requestId));
  assert.ok(scheduledTask, 'Scheduling did not create exactly one new durable task.');
  assert.equal(pendingSchedules.filter((task) => !beforeRequestIds.has(task.requestId)).length, 1,
    'Scheduling created more than one durable task placeholder.');
  assert.equal(scheduledTask.status, 'pending');
  assert.equal(scheduledTask.meshTargets?.length, 1, 'The scheduled task did not retain exactly one Mesh target.');
  assert.equal(scheduledTask.meshTargets[0]?.providerId, providerId);
  const scheduledParentSelection = assertScheduledParentSelection(scheduledTask, undefined, {
    expectedModelId: expectedParentModelId,
    expectedReasoning: expectedParentReasoning,
  });
  await evidence?.capture('scheduled-mesh-pending');
  if (dispatchMode === 'run-now') await cdp.click('.scheduled-task-actions button', 'Run now');
  else assert.equal(dispatchMode, 'due', `Unknown scheduled Mesh dispatch mode ${dispatchMode}.`);
  const dispatchTimeoutMilliseconds = dispatchMode === 'due'
    ? Math.max(30_000, Date.parse(scheduledTask.runAt) - Date.now() + 45_000)
    : 20_000;
  let dispatchingPainted = false;
  await waitFor(async () => {
    dispatchingPainted = await cdp.evaluate('document.querySelector(".scheduled-task-notice")?.getAttribute("data-status") === "dispatching"');
    if (dispatchingPainted) return true;
    // A very fast due task can materialize and leave the durable pending list
    // between two renderer frames. Missing that transient label is not a
    // scheduler failure; the parent/child/terminal assertions below remain the
    // authoritative exactly-once proof.
    const tasks = (await cdp.request('scheduled_task.list')).tasks ?? [];
    return !tasks.some((task) => task.requestId === scheduledTask.requestId);
  }, 'scheduled Mesh dispatch', dispatchTimeoutMilliseconds);
  await evidence?.capture(dispatchingPainted ? 'scheduled-mesh-dispatching' : 'scheduled-mesh-dispatched');
  const child = await waitFor(async () => {
    const available = await sessions(cdp);
    return available.find((session) => !beforeIds.has(session.id)
      && sessionRelationshipKind(session) === 'subagent'
      && session.providerId === providerId) ?? null;
  }, 'scheduled Mesh child', 60_000);
  if (expectedModelId) assert.equal(sessionModelId(child), expectedModelId,
    `Scheduled Mesh selected ${sessionModelId(child) || 'no model'} instead of ${expectedModelId}.`);
  if (expectedReasoning) assert.equal(String(sessionReasoningEffort(child) ?? '').toLowerCase(), expectedReasoning.toLowerCase(),
    `Scheduled Mesh selected ${sessionReasoningEffort(child) || 'no reasoning effort'} instead of ${expectedReasoning}.`);
  const available = await sessions(cdp);
  const parent = available.find((session) => session.id === child.parentSessionId);
  assert.ok(parent, `Scheduled Mesh child ${child.id} has no materialized parent.`);
  assert.equal(parent.providerId, 'opencode');
  assert.equal(beforeIds.has(parent.id), false, 'Scheduled Mesh reused an existing parent task.');
  assertScheduledParentSelection(scheduledTask, parent, {
    expectedModelId: expectedParentModelId,
    expectedReasoning: expectedParentReasoning,
  });
  const newParents = available.filter((session) => !beforeIds.has(session.id)
    && session.providerId === 'opencode' && sessionRelationshipKind(session) !== 'subagent');
  assert.equal(newParents.length, 1, 'Scheduled Mesh did not materialize exactly one OpenCode parent.');
  await selectSession(cdp, child.id, child);
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId: child.id,
    baseline: { messages: [] },
    expectedText,
    expectedUserPrompt: prompt,
  });
  const after = await composerGeometry(cdp);
  assertHealthyComposer(after);
  assert.deepEqual(after.toastErrors, [], 'Scheduled Mesh completed with an error toast.');
  await evidence?.capture('scheduled-mesh-terminal');
  return { scheduledTask, scheduledParentSelection, parent, child, terminal, baseline, scheduledPanelGeometry, after, dispatchMode, dueLocalValue, dispatchingPainted };
}

async function latestReasoningToolNames(cdp, rootSelector = '.conversation-scroll') {
  const groupIndex = await cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const groups = [...(root?.querySelectorAll('.reasoning-group') ?? [])];
    const group = groups.at(-1);
    if (!(group instanceof HTMLElement)) return null;
    const disclosure = group.querySelector('.reasoning-disclosure');
    if (disclosure instanceof HTMLButtonElement && disclosure.getAttribute('aria-expanded') !== 'true') disclosure.click();
    return groups.length;
  })()`);
  assert.ok(groupIndex, 'The browser tool call did not produce a visible reasoning/activity group.');
  return await waitFor(() => cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const group = [...(root?.querySelectorAll('.reasoning-group') ?? [])].at(${groupIndex - 1});
    const names = [...(group?.querySelectorAll('.activity-target') ?? [])]
      .map((node) => node.textContent?.replace(/\\s+/gu, ' ').trim() ?? '').filter(Boolean);
    return names.length ? names : null;
  })()`), 'visible browser tool-call evidence');
}

async function latestReasoningActivities(cdp, rootSelector = '.conversation-scroll') {
  const groupIndex = await cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    const groups = [...(root?.querySelectorAll('.reasoning-group') ?? [])];
    const group = groups.at(-1);
    if (!(group instanceof HTMLElement)) return null;
    const disclosure = group.querySelector('.reasoning-disclosure');
    if (disclosure instanceof HTMLButtonElement && disclosure.getAttribute('aria-expanded') !== 'true') disclosure.click();
    return groups.length;
  })()`);
  assert.ok(groupIndex, 'The browser tool call did not produce a visible reasoning/activity group.');
  return await waitFor(async () => {
    const activities = await cdp.evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)});
      const group = [...(root?.querySelectorAll('.reasoning-group') ?? [])].at(${groupIndex - 1});
      const disclosures = [...(group?.querySelectorAll('.activity-disclosure') ?? [])];
      for (const disclosure of disclosures) {
        const target = disclosure.querySelector('.activity-target')?.textContent ?? '';
        const row = disclosure.querySelector('.activity-row');
        if (target.toLowerCase().includes('browser_get_state')
          && row instanceof HTMLButtonElement && row.getAttribute('aria-expanded') !== 'true') row.click();
      }
      return disclosures.map((disclosure) => {
        const row = disclosure.querySelector('.activity-row');
        return {
          label: (row?.querySelector('strong')?.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
          target: (row?.querySelector('.activity-target')?.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
          failed: disclosure.classList.contains('activity-failed'),
          expanded: row?.getAttribute('aria-expanded') === 'true',
          details: disclosure.querySelector('.activity-snippet pre')?.textContent ?? '',
        };
      });
    })()`);
    const calls = (activities ?? []).filter((activity) => activity.target.toLowerCase().includes('browser_get_state'));
    return calls.length > 0 && calls.every((activity) => activity.expanded) ? activities : null;
  }, 'visible browser_get_state result');
}

async function browserToolsJourney(cdp, sessionId, prompt, evidence, { expectBrowserGetStateCall = false } = {}) {
  const before = await composerGeometry(cdp);
  const sent = await sendComposer(cdp, prompt);
  await evidence?.capture('browser-tools-optimistic-send');
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId,
    baseline: sent.baseline,
    expectBrowserTools: true,
    expectedUserPrompt: prompt,
  });
  let browserGetStateEvidence = null;
  if (expectBrowserGetStateCall) {
    const activities = await latestReasoningActivities(cdp);
    browserGetStateEvidence = assertSuccessfulBrowserGetStateActivity(activities);
  }
  const after = await composerGeometry(cdp);
  assertSettledComposerShape(before, after);
  await evidence?.capture('browser-tools-terminal');
  return { before, after, terminal, browserGetStateEvidence };
}

async function commandLookalikeJourney(cdp, sessionId, evidence, {
  prompt = 'For /simplify.exe reply exactly ODD_COMMAND_OK.',
  expectedText = 'ODD_COMMAND_OK',
} = {}) {
  const values = ['https://x/mesh', 'x/mesh', '/simplified', '/simplify-extra', '/simplify.exe'];
  const before = await composerGeometry(cdp);
  const states = [];
  for (const value of values) {
    await cdp.fill('textarea[aria-label="Message"]', value);
    await delay(150);
    const active = await composerGeometry(cdp);
    assertNoHorizontalJump(before, active);
    assert.equal(await cdp.evaluate('Boolean(document.querySelector(".mesh-panel, .mesh-model-picker, .composer-mesh-widget, .simplify-command-row, .slash-command-palette"))'), false,
      `${value} incorrectly activated a Mesh or Simplify command surface.`);
    states.push(await evidence?.capture(`inert-${value}`) ?? { stage: value, geometry: active });
  }
  await cdp.fill('textarea[aria-label="Message"]', '');
  const cleared = await composerGeometry(cdp);
  assertSettledComposerShape(before, cleared);
  await evidence?.capture('inert-commands-cleared');
  const sent = await sendComposer(cdp, prompt);
  assert.equal(await cdp.evaluate('Boolean(document.querySelector(".mesh-panel, .mesh-model-picker, .composer-mesh-widget, .simplify-command-row, .slash-command-palette"))'), false,
    'The sent lookalike command activated a real command surface.');
  await evidence?.capture('inert-command-optimistic-send');
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId,
    baseline: sent.baseline,
    expectedText,
    expectedUserPrompt: prompt,
  });
  const after = await composerGeometry(cdp);
  assertSettledComposerShape(before, after);
  await evidence?.capture('inert-command-terminal');
  return { before, cleared, after, states, terminal };
}

async function runLive(options) {
  const debugPort = Number(options.port ?? 9248);
  assert.ok(Number.isInteger(debugPort) && debugPort > 0, '--port must be a valid CDP port.');
  const journey = options.journey;
  const sessionId = options.session;
  assert.ok(journey, '--journey is required with --live.');
  assert.ok(sessionId, '--session is required with --live.');
  const cdp = new HiddenCdp(debugPort);
  await cdp.connect();
  try {
    const availableSessions = await sessions(cdp);
    const task = availableSessions.find((session) => session.id === sessionId);
    assert.ok(task, `Tethoq task ${sessionId} was not found.`);
    if (sessionRelationshipKind(task) === 'subagent') {
      assert.ok(journey === 'queue-steer' || journey === 'browser-tools',
        'A delegated child may be supplied directly only to the queue-steer or browser-tools journey.');
      const parent = availableSessions.find((session) => session.id === task.parentSessionId);
      assert.ok(parent, `Delegated child ${task.id} has no available parent task.`);
      assert.equal(parent.providerId, 'opencode', 'The delegated child parent must be an OpenCode-through-Tethoq task.');
    } else assert.equal(task.providerId, 'opencode', 'The selected parent must be an OpenCode-through-Tethoq task.');
    await selectSession(cdp, sessionId, task);
    const evidence = new EvidenceRecorder(cdp, journey);
    await evidence.capture('initial');
    let result;
    if (journey === 'model-pdf') {
      assert.ok(options.pdf, '--pdf is required for model-pdf.');
      result = await modelPdfJourney(cdp, sessionId, {
        pdf: options.pdf,
        model: options.model ?? 'DeepSeek V4 Flash',
        modelSource: options['model-source'],
        reasoning: options.reasoning ?? 'Max',
        prompt: options.prompt ?? 'Quote the PDF sentence only.',
        expectedText: options.expected ?? 'The cobalt lantern is the PDF canary.',
        expectBrowserTools: options.assert === 'browser' || options.assert === 'both',
      }, evidence);
    } else if (journey === 'new-model-pdf') {
      assert.ok(options.pdf, '--pdf is required for new-model-pdf.');
      result = await newModelPdfJourney(cdp, sessionId, {
        pdf: options.pdf,
        model: options.model ?? 'DeepSeek V4 Flash Vision Exp',
        modelSource: options['model-source'] ?? 'OpenCode Go',
        reasoning: options.reasoning ?? 'Max',
        expectedModelId: options['model-id'] ?? 'opencode-go/deepseek-v4-flash-vision-exp',
        expectedReasoning: options['reasoning-id'] ?? 'max',
        prompt: options.prompt ?? 'Quote the PDF sentence only.',
        expectedText: options.expected ?? 'The cobalt lantern is the PDF canary.',
        expectBrowserTools: options.assert === 'browser' || options.assert === 'both',
      }, evidence);
    } else if (journey === 'simplify') {
      result = await simplifyJourney(cdp, sessionId, options.prompt ?? '/simplify Reply exactly SIMPLIFY_OK.', options.expected ?? 'SIMPLIFY_OK', evidence);
    } else if (journey === 'side-chat') {
      result = await sideChatJourney(cdp, sessionId, options.prompt ?? 'Reply exactly SIDE_CHAT_OK.', options.expected ?? 'SIDE_CHAT_OK', evidence);
    } else if (journey === 'mesh-grok') {
      result = await meshJourney(cdp, sessionId, {
        providerLabel: options.provider ?? 'Grok', providerId: 'grok', modelLabel: options.model ?? 'Grok 4.6',
        reasoningLabel: options.reasoning ?? 'Low',
        expectedModelId: options['model-id'] ?? 'grok-4.6',
        expectedReasoning: options['reasoning-id'] ?? 'low',
        prompt: options.prompt ?? 'Run PowerShell Start-Sleep -Seconds 120, then reply READY.',
      }, evidence);
      if (options.queue) result = { ...result, queueSteer: await queueSteerJourney(
        cdp,
        result.child.id,
        sessionId,
        options.queue,
        evidence,
        options.assert === 'text'
          ? { expectedText: options.expected ?? 'QUEUE_STEER_OK', primePrompt: options.prime ?? 'Run PowerShell Start-Sleep -Seconds 120, then reply PRIME_DONE.' }
          : { expectBrowserTools: true, expectBrowserGetStateCall: options.assert === 'both', primePrompt: options.prime ?? 'Run PowerShell Start-Sleep -Seconds 120, then reply PRIME_DONE.' },
      ) };
    } else if (journey === 'mesh-luna') {
      result = await meshJourney(cdp, sessionId, {
        providerLabel: options.provider ?? 'Codex', providerId: 'codex', modelLabel: options.model ?? 'GPT-5.6-Luna',
        reasoningLabel: options.reasoning ?? 'Max',
        expectedModelId: options['model-id'] ?? 'gpt-5.6-luna',
        expectedReasoning: options['reasoning-id'] ?? 'max',
        prompt: options.prompt ?? 'Run PowerShell Start-Sleep -Seconds 120, then reply READY.',
      }, evidence);
      if (options.queue) result = { ...result, queueSteer: await queueSteerJourney(
        cdp,
        result.child.id,
        sessionId,
        options.queue,
        evidence,
        options.assert === 'text'
          ? { expectedText: options.expected ?? 'QUEUE_STEER_OK', primePrompt: options.prime ?? 'Run PowerShell Start-Sleep -Seconds 120, then reply PRIME_DONE.' }
          : { expectBrowserTools: true, expectBrowserGetStateCall: options.assert === 'both', primePrompt: options.prime ?? 'Run PowerShell Start-Sleep -Seconds 120, then reply PRIME_DONE.' },
      ) };
    } else if (journey === 'queue-steer') {
      result = await queueSteerJourney(
        cdp,
        sessionId,
        options.switch ?? task.parentSessionId,
        options.queue ?? (options.assert === 'text' ? 'Reply exactly QUEUE_STEER_OK.' : 'List every Tethoq in-app browser_* tool name only, once each.'),
        evidence,
        options.assert === 'text'
          ? { expectedText: options.expected ?? 'QUEUE_STEER_OK' }
          : { expectBrowserTools: true, expectBrowserGetStateCall: options.assert === 'both', ...(options.prime ? { primePrompt: options.prime } : {}) },
      );
    } else if (journey === 'browser-tools') {
      const expectBrowserGetStateCall = options.assert === 'call' || options.assert === 'both';
      result = await browserToolsJourney(cdp, sessionId,
        options.prompt ?? (expectBrowserGetStateCall
          ? 'Call browser_get_state exactly once. Then reply with the full exact names of all 16 Tethoq in-app Browser tools. Include the browser_ prefix on every name, one name per line, with no abbreviations.'
          : 'List every Tethoq in-app browser_* tool name only, once each.'), evidence, { expectBrowserGetStateCall });
    } else if (journey === 'scheduled-mesh') {
      result = await scheduledMeshJourney(cdp, sessionId, {
        parentModelLabel: options['parent-model'] ?? 'DeepSeek V4 Flash Vision Exp',
        parentModelSource: options['parent-model-source'] ?? 'OpenCode Go',
        parentReasoningLabel: options['parent-reasoning'] ?? 'Max',
        expectedParentModelId: options['parent-model-id'] ?? 'opencode-go/deepseek-v4-flash-vision-exp',
        expectedParentReasoning: options['parent-reasoning-id'] ?? 'max',
        providerLabel: options.provider ?? 'Grok',
        providerId: options['provider-id'] ?? 'grok',
        modelLabel: options.model ?? 'Grok 4.6',
        reasoningLabel: options.reasoning ?? 'Low',
        expectedModelId: options['model-id'] ?? 'grok-4.6',
        expectedReasoning: options['reasoning-id'] ?? 'low',
        prompt: options.prompt ?? 'Reply exactly SCHEDULE_MESH_OK.',
        expectedText: options.expected ?? 'SCHEDULE_MESH_OK',
        dispatchMode: options.dispatch ?? 'run-now',
        dueLeadMilliseconds: Number(options['due-seconds'] ?? 90) * 1_000,
      }, evidence);
    } else if (journey === 'command-lookalikes') {
      result = await commandLookalikeJourney(cdp, sessionId, evidence, {
        prompt: options.prompt ?? 'For /simplify.exe reply exactly ODD_COMMAND_OK.',
        expectedText: options.expected ?? 'ODD_COMMAND_OK',
      });
    } else if (journey === 'geometry') {
      result = await composerGeometry(cdp);
      assertHealthyComposer(result);
    } else throw new Error(`Unknown journey: ${journey}`);
    const finalEvidence = await evidence.capture('final');
    const screenshotPath = finalEvidence.screenshotPath;
    await mkdir(artifactDirectory, { recursive: true });
    const reportPath = path.join(artifactDirectory, `${evidence.runId}.json`);
    const report = { journey, sessionId, screenshotPath, evidence: evidence.states, result };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return { ...report, reportPath };
  } finally {
    cdp.close();
  }
}

const dryRunPlan = {
  liveRequired: true,
  noModelWasCalled: true,
  journeys: {
    'model-pdf': 'Choose DeepSeek V4 Flash Vision Max, drag/drop the canary PDF, prove its exact sentence in a terminal reply, and capture staged/optimistic/settled geometry.',
    'new-model-pdf': 'Create a fresh OpenCode task through visible Tethoq controls, select DeepSeek V4 Flash Vision Max, attach the canary PDF, and prove the configured model plus its terminal answer.',
    simplify: 'Enter /simplify through the composer, prove its visible command state and terminal result, and assert the composer returns to its original shape.',
    'side-chat': 'Create, optimistically send, await a terminal answer, close, and reopen a deduplicated persisted OpenCode side chat through visible controls.',
    'mesh-grok': 'Use an anywhere-in-message /mesh token, choose Grok 4.6, open the hidden child through the parent sub-agent dialog, and optionally queue/steer with --queue.',
    'mesh-luna': 'Use an anywhere-in-message /mesh token, choose GPT-5.6-Luna Max, open the hidden child through the parent sub-agent dialog, and optionally queue/steer with --queue.',
    'queue-steer': 'Open an active Grok or Codex child through its OpenCode parent, queue, switch away and back, steer, prove one canonical user row, and validate the terminal Browser-tool result.',
    'browser-tools': 'Ask the selected OpenCode model for exactly all 16 Tethoq in-app Browser tool names and validate the terminal response.',
    'scheduled-mesh': 'Create an OpenCode draft through visible controls, retain one /mesh target in a durable scheduled task, dispatch it with Run now or a genuine due-time wake, and prove exactly one new parent, child, and terminal turn.',
    'command-lookalikes': 'Exercise URL/lookalike command text, send one inert odd command, prove one canonical terminal turn, and capture stable composer geometry.',
    geometry: 'Read-only composer/transcript geometry and viewport bounds.',
  },
};

if (require.main === module) {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.flags.has('live')) process.stdout.write(`${JSON.stringify(dryRunPlan, null, 2)}\n`);
  else runLive(parsed.values).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BROWSER_TOOL_NAMES,
  EvidenceRecorder,
  HiddenCdp,
  assertCompleteBrowserToolInventory,
  assertScheduledParentSelection,
  assertSuccessfulBrowserGetStateActivity,
  assertHealthyComposer,
  assertNoHorizontalJump,
  assertQueuePromotionSamples,
  assertSettledComposerShape,
  assertStableSideChatShape,
  assertSinglePdfPresentation,
  browserToolNames,
  chooseMeshTarget,
  commandLookalikeJourney,
  composerGeometry,
  futureLocalMinuteValue,
  hasPaintedLiveState,
  matchingNewMeshChildren,
  meshJourney,
  midMessageMeshPrompt,
  modelPdfJourney,
  newModelPdfJourney,
  openDelegatedChild,
  queueSteerJourney,
  scheduledMeshJourney,
  scheduledMeshDraftPrompt,
  selectModel,
  selectSession,
  sessionModelId,
  sessionReasoningEffort,
  sessionRelationshipKind,
  sideChatJourney,
  simplifyJourney,
  visibleSimplifyPrompt,
  transcriptSnapshot,
  waitForTerminalResponse,
  waitFor,
};
