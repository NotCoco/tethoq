'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const unpackedRoot = path.resolve(process.argv[2] ?? path.join(appRoot, 'release', 'win-unpacked'));
const executable = path.join(unpackedRoot, 'Tethoq.exe');
const resources = path.join(unpackedRoot, 'resources');
const sdkRoot = path.join(resources, 'connector-sdk');
const asarUnpackedRoot = path.join(resources, 'app.asar.unpacked');
const { verifyEmbeddedBridge } = require('./verify-embedded-bridge.cjs');
// Port 4096 commonly belongs to the user's real `opencode serve` process.
// Let Windows choose an unused loopback port unless QA explicitly pins one so
// packaged smoke can never contend with or depend on that user-owned server.
let fixturePort = Number(process.env.TETHOQ_SMOKE_OPENCODE_PORT ?? 0);
const debugPort = Number(process.env.TETHOQ_SMOKE_DEBUG_PORT ?? 9327);
let runRoot;
let userData;
let projectDirectory;
let connectorDirectory;
let connectorMarkerPath;
let workflowRoot;
const reportPath = path.join(appRoot, 'qa-artifacts', 'packaged-smoke.json');
let appProcess;
let openCodeServer;
let cdp;
let appPid;
const browserFixtureRequests = [];
const appOutput = [];
const builtInProviders = ['codex', 'opencode', 'grok', 'pi', 'omp', 'qwen', 'goose', 'kimi', 'hermes', 'cline', 'copilot', 'direct'];

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

function processCommandLines() {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Unable to inspect smoke processes: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function tethoqProcessesForUserData() {
  const normalizedUserData = String(userData ?? '').toLowerCase();
  return processCommandLines().filter((process) => /Tethoq\.exe$/i.test(process.Name ?? '') && String(process.CommandLine ?? '').toLowerCase().includes(normalizedUserData));
}

function descendantPids(rootPid, processes = processCommandLines()) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) if (descendants.has(process.ParentProcessId) && !descendants.has(process.ProcessId)) {
      descendants.add(process.ProcessId);
      changed = true;
    }
  }
  descendants.delete(rootPid);
  return [...descendants];
}

async function startOpenCodeFixture() {
  const clients = new Set();
  const sessions = new Map();
  const messages = new Map();
  const statuses = new Map();
  const abortCalls = new Map();
  const reasoningRuns = new Map();
  const messageReads = new Map();
  const sendSse = (type, properties) => {
    const line = `data: ${JSON.stringify({ payload: { type, properties } })}\n\n`;
    for (const response of clients) response.write(line);
  };
  const beginReasoningRun = (sessionId, messageId, text) => {
    const now = Date.now();
    const assistantMessageId = `${messageId}-assistant`;
    const reasoningPartId = `${assistantMessageId}-reasoning`;
    const textPartId = `${assistantMessageId}-text`;
    const fullReasoning = 'Checking the reasoning stream.';
    const userInfo = { id: messageId, sessionID: sessionId, role: 'user', time: { created: now } };
    const userPart = { id: `${messageId}-text`, sessionID: sessionId, messageID: messageId, type: 'text', text };
    const assistantInfo = {
      id: assistantMessageId,
      sessionID: sessionId,
      parentID: messageId,
      role: 'assistant',
      time: { created: now + 1 },
    };
    const reasoningPart = {
      id: reasoningPartId,
      sessionID: sessionId,
      messageID: assistantMessageId,
      type: 'reasoning',
      text: '',
    };
    const finalTextPart = {
      id: textPartId,
      sessionID: sessionId,
      messageID: assistantMessageId,
      type: 'text',
      text: 'Done.',
    };
    const history = messages.get(sessionId);
    history?.push({ info: userInfo, parts: [userPart] });
    const status = { type: 'busy' };
    statuses.set(sessionId, status);

    let stage = 'first';
    let assistantStored = false;
    const storeAssistant = () => {
      if (assistantStored) return;
      assistantStored = true;
      history?.push({ info: assistantInfo, parts: [reasoningPart, finalTextPart] });
    };
    const run = {
      sessionId,
      messageId,
      assistantMessageId,
      reasoningPartId,
      fullReasoning,
      emitSecond() {
        if (stage !== 'first') throw new Error(`Reasoning smoke cannot emit its second chunk from ${stage}.`);
        stage = 'second';
        sendSse('message.part.delta', {
          sessionID: sessionId,
          messageID: assistantMessageId,
          partID: reasoningPartId,
          field: 'text',
          delta: 'reasoning stream.',
        });
      },
      finish() {
        if (stage !== 'second') throw new Error(`Reasoning smoke cannot finish from ${stage}.`);
        stage = 'finished';
        reasoningPart.text = fullReasoning;
        assistantInfo.finish = 'stop';
        assistantInfo.time.completed = Date.now();
        storeAssistant();
        // OpenCode republishes the completed cumulative part. It must not append
        // another copy after the two native deltas above.
        sendSse('message.part.updated', { part: reasoningPart });
        sendSse('message.part.updated', { part: finalTextPart });
        sendSse('message.updated', { info: assistantInfo });
        statuses.delete(sessionId);
        sendSse('session.idle', { sessionID: sessionId });
      },
      setHistoryReasoning(nextText) {
        if (stage !== 'finished') throw new Error(`Reasoning smoke cannot reconcile history from ${stage}.`);
        reasoningPart.text = nextText;
      },
    };
    reasoningRuns.set(sessionId, run);

    sendSse('message.updated', { info: userInfo });
    sendSse('session.status', { sessionID: sessionId, status });
    sendSse('session.diff', { sessionID: sessionId, diff: [] });
    sendSse('message.part.updated', {
      part: {
        id: `${assistantMessageId}-empty-patch`,
        sessionID: sessionId,
        messageID: assistantMessageId,
        type: 'patch',
        files: [],
      },
    });
    sendSse('message.updated', { info: assistantInfo });
    sendSse('message.part.updated', { part: reasoningPart });
    sendSse('message.part.delta', {
      sessionID: sessionId,
      messageID: assistantMessageId,
      partID: reasoningPartId,
      field: 'text',
      delta: 'Checking the ',
    });
    return run;
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${fixturePort}`);
    if (request.method === 'GET' && url.pathname.startsWith('/browser-smoke/')) {
      const pageName = url.pathname.split('/').filter(Boolean).at(-1) ?? 'start';
      browserFixtureRequests.push({ path: url.pathname, cookie: request.headers.cookie ?? '' });
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Set-Cookie': 'tethoq-browser-smoke=present; Path=/; HttpOnly; SameSite=Lax',
      });
      response.end(`<!doctype html><html><head><title>Tethoq browser smoke ${pageName}</title><style>html,body{min-height:100%;margin:0;background:#173c31;color:#eef8f3}main{padding:24px;font:16px system-ui}</style></head><body><main data-smoke-page="${pageName}">Browser smoke ${pageName}</main></body></html>`);
      return;
    }
    if (url.pathname === '/global/health') return json(response, { healthy: true, version: 'smoke-fixture' });
    if (url.pathname === '/global/event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(response);
      request.once('close', () => clients.delete(response));
      return;
    }
    if (url.pathname === '/provider') return json(response, { connected: ['fixture'], all: [], default: {} });
    if (url.pathname === '/session/status') return json(response, Object.fromEntries(statuses));
    if (request.method === 'GET' && url.pathname === '/session') return json(response, [...sessions.values()]);
    if (request.method === 'POST' && url.pathname === '/session') {
      const id = `opencode-smoke-${Date.now()}`;
      const now = Date.now();
      const session = { id, title: 'OpenCode smoke', directory: url.searchParams.get('directory') ?? projectDirectory, time: { created: now, updated: now } };
      sessions.set(id, session); messages.set(id, []); messageReads.set(id, 0); abortCalls.set(id, 0);
      // Match OpenCode's native creation notification after the create response
      // has had time to enter the Bridge cache. The renderer learns about tasks
      // created outside its own composer from this event and re-lists them.
      setTimeout(() => sendSse('session.created', { sessionID: id, info: session }), 20);
      return json(response, session);
    }
    const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (request.method === 'GET' && !match[2]) return json(response, sessions.get(id));
      if (request.method === 'GET' && match[2] === 'message') {
        messageReads.set(id, (messageReads.get(id) ?? 0) + 1);
        return json(response, messages.get(id) ?? []);
      }
      if (request.method === 'POST' && match[2] === 'prompt_async') {
        const body = await readJsonBody(request);
        const text = body?.parts?.find((part) => part?.type === 'text')?.text ?? '';
        if (text === 'hello from the reasoning smoke') {
          beginReasoningRun(id, body.messageID, text);
          return json(response, {}, 204);
        }
        if (text === 'hello from the retry smoke') {
          const now = Date.now();
          const info = { id: body.messageID, sessionID: id, role: 'user', time: { created: now } };
          const part = { id: `part-${now}`, sessionID: id, messageID: body.messageID, type: 'text', text };
          messages.get(id)?.push({ info, parts: [part] });
          sendSse('message.updated', { info });
          const status = {
            type: 'retry',
            attempt: 1,
            message: 'Weekly usage limit reached - https://fixture.invalid/raw-provider-link',
            action: {
              reason: 'account_rate_limit',
              provider: 'opencode-go',
              title: 'Go limit reached',
              message: 'Weekly usage limit reached. It will reset in 6 days. To continue using this model now, enable usage from your available balance.',
              label: 'open settings',
              link: 'https://fixture.invalid/settings',
            },
            next: now + 6 * 24 * 60 * 60 * 1000,
          };
          statuses.set(id, status);
          setTimeout(() => sendSse('session.status', { sessionID: id, status }), 20);
          return json(response, {}, 204);
        }
        const part = { id: `part-${Date.now()}`, sessionID: id, messageID: body.messageID, type: 'text', text: `Fixture: ${text}` };
        sendSse('message.part.updated', { part, delta: part.text });
        return json(response, {}, 204);
      }
      if (request.method === 'POST' && match[2] === 'abort') {
        abortCalls.set(id, (abortCalls.get(id) ?? 0) + 1);
        statuses.delete(id);
        sendSse('session.error', { sessionID: id, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });
        sendSse('session.status', { sessionID: id, status: { type: 'idle' } });
        sendSse('session.idle', { sessionID: id });
        return json(response, {});
      }
    }
    json(response, { error: 'not found', path: url.pathname }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(fixturePort, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('The packaged smoke fixture did not bind a TCP port.'));
        return;
      }
      fixturePort = address.port;
      resolve();
    });
  });
  return { server, clients, sessions, messages, statuses, abortCalls, reasoningRuns, messageReads };
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(status === 204 ? '' : JSON.stringify(value));
}

async function readJsonBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function connectCdp(port) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl && /^file:/i.test(item.url ?? ''));
  }, 'packaged renderer CDP target', 30_000);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (message) => {
    const value = JSON.parse(String(message.data));
    if (!value.id || !pending.has(value.id)) return;
    const entry = pending.get(value.id); pending.delete(value.id);
    value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('Packaged renderer CDP connection closed'));
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Packaged renderer CDP ${method} timed out`));
    }, 30_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
  await send('Runtime.enable');
  return {
    send,
    evaluate: async (expression, awaitPromise = true) => {
      let result;
      try {
        result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
      } catch (error) {
        throw new Error(`Packaged renderer evaluation failed for ${expression.slice(0, 120)}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed');
      return result.result?.value;
    },
    close: () => socket.close(),
  };
}

async function bridgeRequest(type, payload = {}, requestId) {
  const source = `window.tethoqDesktop.request(${JSON.stringify(type)}, ${JSON.stringify(payload)}${requestId ? `, ${JSON.stringify(requestId)}` : ''})`;
  const response = await cdp.evaluate(source);
  if (!response?.ok) throw new Error(response?.error?.message ?? `${type} failed`);
  return response.payload;
}

async function exerciseOpenCodeReasoningReconciliation() {
  await waitFor(() => openCodeServer?.clients.size > 0, 'OpenCode fixture event subscription');
  const created = await bridgeRequest('session.create', {
    providerId: 'opencode',
    workingDirectory: projectDirectory,
    title: 'Reasoning stream smoke',
  });
  const sessionId = created.session.id;
  const providerSessionId = created.session.providerSessionId;
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${sessionId}"]`)}))`), 'OpenCode reasoning smoke task row');
  await cdp.evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${sessionId}"] > .session-row`)})?.click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${sessionId}"] > .session-row`)})?.classList.contains('selected') === true`), 'OpenCode reasoning smoke task selection');

  const eventBatches = cdp.evaluate(`new Promise((resolve) => {
    const events = [];
    const stop = window.tethoqDesktop.onEventBatch((batch) => {
      events.push(...batch.events);
      if (events.some((event) => event.type === 'agent.completed' && event.sessionId === ${JSON.stringify(sessionId)})) {
        stop();
        resolve(events);
      }
    });
    setTimeout(() => { stop(); resolve(events); }, 10000);
  })`);
  const entered = await cdp.evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, 'hello from the reasoning smoke');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'hello from the reasoning smoke' }));
    return true;
  })()`);
  assert.equal(entered, true, 'The packaged reasoning smoke could not enter its message through the React textarea.');
  await waitFor(() => cdp.evaluate(`document.querySelector('button[aria-label="Send instruction"]')?.disabled === false`), 'OpenCode reasoning smoke send control');
  await cdp.evaluate(`document.querySelector('button[aria-label="Send instruction"]')?.click()`);

  const first = await waitFor(async () => {
    const state = await cdp.evaluate(`(() => {
      const root = document.querySelector('.conversation-scroll');
      const controls = [...(root?.querySelectorAll('.reasoning-disclosure') ?? [])];
      const buttons = [...(root?.querySelectorAll('button.reasoning-disclosure') ?? [])];
      const bodies = [...(root?.querySelectorAll('.reasoning-thinking-segment .rich-text') ?? [])].map((node) => node.textContent.trim());
      return {
        controls: controls.length,
        buttons: buttons.length,
        groups: root?.querySelectorAll('.reasoning-group').length ?? 0,
        workingPulses: root?.querySelectorAll('.working-pulse').length ?? 0,
        pulseAfterReasoning: Boolean(buttons[0] && root?.querySelector('.working-pulse') && (buttons[0].compareDocumentPosition(root.querySelector('.working-pulse')) & Node.DOCUMENT_POSITION_FOLLOWING)),
        headerRunning: buttons[0]?.classList.contains('reasoning-running'),
        activities: root?.querySelectorAll('.activity-disclosure').length ?? 0,
        expanded: buttons[0]?.getAttribute('aria-expanded'),
        bodies,
        transcript: root?.innerText ?? '',
      };
    })()`);
    return state.controls === 2
      && state.buttons === 1
      && state.groups === 2
      && state.workingPulses === 1
      && state.pulseAfterReasoning
      && state.headerRunning === false
      && state.expanded === 'true'
      && state.bodies.length === 1
      && state.bodies[0] === 'Checking the'
      ? state
      : null;
  }, 'live OpenCode reasoning disclosure');
  assert.equal(first.activities, 0, 'A pathless patch created visible file activity.');
  assert.doesNotMatch(first.transcript, /File changed/u, 'A pathless patch rendered a fake File changed row.');

  await cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.conversation-scroll .reasoning-detail')`), 'manual reasoning collapse');
  const run = openCodeServer?.reasoningRuns.get(providerSessionId);
  assert.ok(run, 'The OpenCode fixture did not retain the reasoning run controls.');
  // This smoke has already exercised enough packaged surfaces to exceed one
  // bounded sync page. Use the bridge's current high-water mark so the check
  // below observes the newly emitted chunk instead of repeatedly rereading the
  // first page from sequence zero.
  const beforeSecond = await bridgeRequest('sync.since', { sequence: 0 });
  const beforeSecondSequence = beforeSecond.latestSequence;
  assert.equal(Number.isInteger(beforeSecondSequence), true, 'The Bridge did not report a replay high-water mark.');
  run.emitSecond();
  await waitFor(async () => {
    const replay = await bridgeRequest('sync.since', { sequence: beforeSecondSequence });
    return replay.events?.some((event) => event.sessionId === sessionId
      && event.type === 'message.delta'
      && event.payload?.partType === 'reasoning'
      && event.payload?.text === 'reasoning stream.');
  }, 'second OpenCode reasoning delta');
  await delay(100);
  const stayedClosed = await cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.conversation-scroll .reasoning-detail')`);
  assert.equal(stayedClosed, true, 'Streaming output reopened reasoning after the reader closed it.');

  await cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.getAttribute('aria-expanded') === 'true' && document.querySelector('.conversation-scroll .reasoning-thinking-segment .rich-text')?.textContent.trim() === 'Checking the reasoning stream.'`), 'manual reasoning reopen with streamed text');
  run.finish();
  const events = await eventBatches;
  const reasoningEvents = events.filter((event) => event.sessionId === sessionId
    && event.type === 'message.delta'
    && event.payload?.partType === 'reasoning');
  assert.deepEqual(reasoningEvents.map((event) => event.payload.text), ['Checking the ', 'reasoning stream.']);
  assert.deepEqual([...new Set(reasoningEvents.map((event) => event.payload.partId))], [run.reasoningPartId]);
  assert.deepEqual([...new Set(reasoningEvents.map((event) => event.payload.messageId))], [run.assistantMessageId]);
  assert.equal(events.filter((event) => event.sessionId === sessionId && event.type === 'file.changed').length, 0);
  assert.equal(events.filter((event) => event.sessionId === sessionId && event.type === 'agent.completed').length, 1);
  assert.equal(events.filter((event) => event.sessionId === sessionId && event.type === 'agent.error').length, 0);

  const reconciledReasoning = `${run.fullReasoning} Reconciled once.`;
  run.setHistoryReasoning(reconciledReasoning);
  const readsBefore = openCodeServer.messageReads.get(providerSessionId) ?? 0;
  await cdp.evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${sessionId}"] > .session-row`)})?.click()`);
  await waitFor(() => (openCodeServer.messageReads.get(providerSessionId) ?? 0) > readsBefore, 'OpenCode reasoning history refresh');
  const reconciled = await waitFor(async () => {
    const state = await cdp.evaluate(`(() => {
      const root = document.querySelector('.conversation-scroll');
      const buttons = [...(root?.querySelectorAll('button.reasoning-disclosure') ?? [])];
      const controls = [...(root?.querySelectorAll('.reasoning-disclosure') ?? [])];
      const bodies = [...(root?.querySelectorAll('.reasoning-thinking-segment .rich-text') ?? [])].map((node) => node.textContent.trim());
      const transcript = root?.innerText ?? '';
      return {
        buttons: buttons.length,
        controls: controls.length,
        groups: root?.querySelectorAll('.reasoning-group').length ?? 0,
        segments: root?.querySelectorAll('.reasoning-thinking-segment').length ?? 0,
        expanded: buttons[0]?.getAttribute('aria-expanded'),
        bodies,
        baseOccurrences: transcript.split(${JSON.stringify(run.fullReasoning)}).length - 1,
        fileChangedVisible: transcript.includes('File changed'),
        agentErrorVisible: document.body.innerText.includes('Agent error'),
      };
    })()`);
    return state.buttons === 1
      && state.controls === 1
      && state.groups === 1
      && state.segments === 1
      && state.expanded === 'true'
      && state.bodies.length === 1
      && state.bodies[0] === reconciledReasoning
      ? state
      : null;
  }, 'reconciled OpenCode reasoning disclosure');
  assert.equal(reconciled.baseOccurrences, 1, 'Reasoning reconciliation duplicated the streamed thought.');
  assert.equal(reconciled.fileChangedVisible, false);
  assert.equal(reconciled.agentErrorVisible, false);

  await cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.getAttribute('aria-expanded') === 'false'`), 'settled reasoning collapse');
  await cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.conversation-scroll button.reasoning-disclosure')?.getAttribute('aria-expanded') === 'true'`), 'settled reasoning reopen');
  return {
    interactiveDisclosures: reconciled.buttons,
    reasoningGroups: reconciled.groups,
    reasoningSegments: reconciled.segments,
    reasoningDeltaCount: reasoningEvents.length,
    reasoningTextOccurrences: reconciled.baseOccurrences,
    pathlessFileChangedVisible: reconciled.fileChangedVisible,
    fileChangedEvents: 0,
    providerErrors: 0,
    completedEvents: 1,
    statePreservedThroughStreamingAndRefresh: true,
  };
}

async function exerciseOpenCodeRetryNotice() {
  const retryMessage = 'Weekly usage limit reached. It will reset in 6 days. To continue using this model now, enable usage from your available balance.';
  await waitFor(() => openCodeServer?.clients.size > 0, 'OpenCode fixture event subscription');
  const created = await bridgeRequest('session.create', {
    providerId: 'opencode',
    workingDirectory: projectDirectory,
    title: 'Retry status smoke',
  });
  const sessionId = created.session.id;
  try {
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(`[data-session-id="${sessionId}"]`)}))`), 'OpenCode retry smoke task row');
  } catch (error) {
    const listed = await bridgeRequest('sessions.list').catch(() => null);
    const replay = await bridgeRequest('sync.since', { sequence: 0 }).catch(() => null);
    const visibleRows = await cdp.evaluate(`[...document.querySelectorAll('[data-session-id]')].map((row) => row.getAttribute('data-session-id'))`);
    const events = replay?.events?.filter((event) => event.sessionId === sessionId) ?? [];
    throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify({ sessionId, listed, events, visibleRows })}`);
  }
  await cdp.evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${sessionId}"] > .session-row`)})?.click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector(${JSON.stringify(`[data-session-id="${sessionId}"] > .session-row`)})?.classList.contains('selected') === true`), 'OpenCode retry smoke task selection');

  const eventBatches = cdp.evaluate(`new Promise((resolve) => {
    const events = [];
    const stop = window.tethoqDesktop.onEventBatch((batch) => {
      events.push(...batch.events);
      if (events.some((event) => event.type === 'agent.interrupted' && event.sessionId === ${JSON.stringify(sessionId)})) {
        stop();
        resolve(events);
      }
    });
    setTimeout(() => { stop(); resolve(events); }, 10000);
  })`);
  const entered = await cdp.evaluate(`(() => {
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, 'hello from the retry smoke');
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'hello from the retry smoke' }));
    return true;
  })()`);
  assert.equal(entered, true, 'The packaged retry smoke could not enter its message through the React textarea.');
  await waitFor(() => cdp.evaluate(`document.querySelector('button[aria-label="Send instruction"]')?.disabled === false`), 'OpenCode retry smoke send control');
  await cdp.evaluate(`document.querySelector('button[aria-label="Send instruction"]')?.click()`);

  let visible;
  try {
    visible = await waitFor(async () => {
      const state = await cdp.evaluate(`(() => {
        const transcript = document.querySelector('.conversation-scroll')?.innerText ?? '';
        return {
          transcript,
          retryCount: transcript.split(${JSON.stringify(retryMessage)}).length - 1,
          hasGenericReasoning: /(^|\\n)Reasoning(?:…|\.\.\.)?(?:\\n|$)/u.test(transcript),
          stopAvailable: Boolean(document.querySelector('button[aria-label="Stop task"]')),
        };
      })()`);
      return state.retryCount === 1 && state.stopAvailable ? state : null;
    }, 'OpenCode provider retry notice');
  } catch (error) {
    const dom = await cdp.evaluate(`(() => ({
      transcript: document.querySelector('.conversation-scroll')?.innerText ?? '',
      title: document.querySelector('.workspace-title h1')?.textContent ?? '',
      textarea: document.querySelector('textarea[aria-label="Message"]')?.value ?? '',
      sendDisabled: document.querySelector('button[aria-label="Send instruction"]')?.disabled,
      stopAvailable: Boolean(document.querySelector('button[aria-label="Stop task"]')),
    }))()`);
    const listed = await bridgeRequest('sessions.list').catch(() => null);
    const replay = await bridgeRequest('sync.since', { sequence: 0 }).catch(() => null);
    const events = replay?.events?.filter((event) => event.sessionId === sessionId) ?? [];
    const fixture = {
      status: openCodeServer?.statuses.get(created.session.providerSessionId),
      messages: openCodeServer?.messages.get(created.session.providerSessionId),
    };
    throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify({ dom, listed, events, fixture })}`);
  }
  assert.equal(visible.hasGenericReasoning, false, 'Provider retry was duplicated as a generic Reasoning row.');
  assert.doesNotMatch(visible.transcript, /fixture\.invalid/u, 'Provider retry exposed a raw URL.');

  const stopAttempts = await cdp.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Stop task"]');
    if (!(button instanceof HTMLButtonElement)) return 0;
    button.click();
    button.click();
    return 2;
  })()`);
  assert.equal(stopAttempts, 2, 'The packaged Stop smoke did not attempt its same-tick double click.');
  const events = await eventBatches;
  const clean = await waitFor(async () => {
    const state = await cdp.evaluate(`(() => {
      const transcript = document.querySelector('.conversation-scroll')?.innerText ?? '';
      return {
        retryCount: transcript.split(${JSON.stringify(retryMessage)}).length - 1,
        stopAvailable: Boolean(document.querySelector('button[aria-label="Stop task"]')),
        agentErrorVisible: document.body.innerText.includes('Agent error'),
      };
    })()`);
    return state.retryCount === 0 && !state.stopAvailable ? state : null;
  }, 'clean OpenCode retry interruption');
  assert.equal(events.filter((event) => event.type === 'agent.interrupted' && event.sessionId === sessionId).length, 1);
  assert.equal(events.filter((event) => event.type === 'agent.error' && event.sessionId === sessionId).length, 0);
  assert.equal(events.filter((event) => event.type === 'agent.completed' && event.sessionId === sessionId).length, 0);
  assert.equal(clean.agentErrorVisible, false, 'Manual Stop rendered an Agent error despite a clean interruption.');
  const abortRequests = openCodeServer?.abortCalls.get(created.session.providerSessionId) ?? 0;
  assert.equal(abortRequests, 1, 'A same-tick double Stop issued more than one provider abort.');
  return {
    retryNoticeCount: visible.retryCount,
    genericReasoning: visible.hasGenericReasoning,
    interruptedEvents: 1,
    providerErrors: 0,
    completedEvents: 0,
    agentErrorVisible: clean.agentErrorVisible,
    abortRequests,
  };
}

async function scanForbidden(root) {
  const forbiddenNames = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (/claude|anthropic/i.test(entry.name)) forbiddenNames.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  const asar = await readFile(path.join(resources, 'app.asar'));
  // The trusted denylist intentionally contains the blocked provider names.
  // Scan only implementation/import/asset signatures, not that policy text.
  const forbiddenBundleText = ['provider_' + 'claude', 'Claude' + 'Adapter', '@anth' + 'ropic-ai/sdk', 'assets/providers/' + 'claude'].filter((token) => asar.includes(Buffer.from(token)));
  return { forbiddenNames, forbiddenBundleText };
}

async function installEchoConnector() {
  await mkdir(connectorDirectory, { recursive: true });
  await Promise.all(['connector.js', 'tethoq.connector.json', 'README.md'].map((name) => cp(path.join(sdkRoot, 'examples', 'echo', name), path.join(connectorDirectory, name))));
  await cp(path.join(sdkRoot, 'dist'), path.join(connectorDirectory, 'node_modules', '@tethoq', 'connector-sdk', 'dist'), { recursive: true });
  await cp(path.join(sdkRoot, 'package.json'), path.join(connectorDirectory, 'node_modules', '@tethoq', 'connector-sdk', 'package.json'));
  const entrypoint = path.join(connectorDirectory, 'connector.js');
  const source = await readFile(entrypoint, 'utf8');
  await writeFile(entrypoint, `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(connectorMarkerPath)}, "started");\n${source}`);
}

function connectorProcessesSince(baseline) {
  const processes = processCommandLines();
  const descendants = new Set(descendantPids(appPid, processes));
  return processes
    .filter((process) => descendants.has(process.ProcessId))
    .filter((process) => !baseline.some((existing) => existing.ProcessId === process.ProcessId))
    .filter((process) => /(?:^|[\\/\s])connector\.js(?:["\s]|$)/i.test(process.CommandLine ?? ''));
}

async function fileExists(candidate) {
  try { return (await stat(candidate)).isFile(); } catch { return false; }
}

async function verifyPackagedResources() {
  const bridge = verifyEmbeddedBridge(unpackedRoot);

  for (const legalFile of [
    path.join(resources, 'legal', 'TETHOQ-LICENSE.txt'),
    path.join(resources, 'legal', 'THIRD_PARTY_NOTICES.md'),
    path.join(resources, 'legal', 'third_party', 'uiohook-napi', 'LICENSE'),
    path.join(resources, 'legal', 'third_party', 'libuiohook', 'COPYING.md'),
    path.join(resources, 'legal', 'third_party', 'libuiohook', 'COPYING.LESSER.md'),
    path.join(resources, 'legal', 'third_party', 'libuiohook', 'README.md'),
  ]) {
    assert.ok((await stat(legalFile)).isFile(), `Missing packaged legal notice: ${legalFile}`);
  }

  const providerTools = [
    path.join(resources, 'provider-tools', 'opencode', 'uar_mesh.txt'),
    path.join(resources, 'provider-tools', 'pi', 'tethoq_tools.txt'),
  ];
  for (const providerTool of providerTools) {
    assert.ok((await stat(providerTool)).isFile(), `Missing packaged provider tool: ${providerTool}`);
  }

  const nativeModulePath = path.join(asarUnpackedRoot, 'node_modules', 'uiohook-napi', 'prebuilds', 'win32-x64', 'uiohook-napi.node');
  const nativeModuleStat = await stat(nativeModulePath);
  assert.ok(nativeModuleStat.isFile() && nativeModuleStat.size > 0, 'The Windows uiohook native module is not unpacked beside app.asar.');
  assert.ok(path.relative(asarUnpackedRoot, nativeModulePath).split(path.sep)[0] !== '..', 'The uiohook native module escaped app.asar.unpacked.');
  const nativeBuildRoot = path.join(asarUnpackedRoot, 'node_modules', 'uiohook-napi', 'build');
  const nativeBuildEntries = await readdir(nativeBuildRoot, { recursive: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of nativeBuildEntries) {
    if (!(await stat(path.join(nativeBuildRoot, entry))).isFile()) continue;
    assert.match(entry, /^Release[\\/][^\\/]+\.node$/u, `Generated native build artifact leaked into the package: ${entry}`);
  }
  for (const sourceFile of [
    path.join(asarUnpackedRoot, 'node_modules', 'uiohook-napi', 'binding.gyp'),
    path.join(asarUnpackedRoot, 'node_modules', 'uiohook-napi', 'src', 'lib', 'addon.c'),
    path.join(asarUnpackedRoot, 'node_modules', 'uiohook-napi', 'libuiohook', 'src', 'logger.c'),
  ]) {
    assert.ok((await stat(sourceFile)).isFile(), `Packaged uiohook source/relink input is missing: ${sourceFile}`);
  }

  return {
    bridge,
    providerTools: providerTools.map((providerTool) => path.relative(resources, providerTool)),
    uiohook: { path: path.relative(resources, nativeModulePath), sizeBytes: nativeModuleStat.size },
  };
}

async function exerciseBrowserWorkspace() {
  const initialUrl = `http://127.0.0.1:${fixturePort}/browser-smoke/start`;
  const createdUrl = `http://127.0.0.1:${fixturePort}/browser-smoke/created`;
  const navigatedUrl = `http://127.0.0.1:${fixturePort}/browser-smoke/navigated`;
  const initial = await cdp.evaluate('window.tethoqDesktop.browserState()');
  assert.equal(initial.partition, 'persist:tethoq-browser');
  assert.deepEqual(initial.profile, { persistent: true, appOwned: true, importsSystemProfile: false, clearing: false });
  assert.equal(initial.visible, false);
  assert.equal(initial.tabs.length, 1);
  assert.equal(initial.activeTabId, initial.tabs[0].id);
  await waitFor(async () => {
    const state = await cdp.evaluate('window.tethoqDesktop.browserState()');
    return state.tabs[0]?.url === initialUrl && !state.tabs[0]?.loading ? state : null;
  }, 'packaged browser initial fixture');

  const created = await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'create-tab', input: createdUrl, activate: false })})`);
  assert.equal(created.tabs.length, 2);
  assert.equal(created.activeTabId, initial.activeTabId);
  const createdTab = created.tabs.find((tab) => tab.url === createdUrl);
  assert.ok(createdTab, 'The packaged browser did not create the requested tab through preload.');

  const activated = await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'activate-tab', tabId: createdTab.id })})`);
  assert.equal(activated.activeTabId, createdTab.id);
  const navigated = await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'navigate', tabId: createdTab.id, input: navigatedUrl })})`);
  assert.equal(navigated.tabs.find((tab) => tab.id === createdTab.id)?.url, navigatedUrl);
  await waitFor(() => browserFixtureRequests.some((request) => request.path === '/browser-smoke/navigated' && request.cookie.includes('tethoq-browser-smoke=present')), 'app-owned Chromium profile cookie persistence');

  const bounds = { x: 24, y: 96, width: 640, height: 360 };
  const bounded = await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'set-bounds', bounds })})`);
  assert.deepEqual(bounded.bounds, bounds);
  const visible = await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'set-visible', visible: true })})`);
  assert.equal(visible.visible, true);
  await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'focus' })})`);
  const hidden = await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'set-visible', visible: false })})`);
  assert.equal(hidden.visible, false);

  const closed = await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'close-tab', tabId: createdTab.id })})`);
  assert.equal(closed.tabs.length, 1);
  assert.equal(closed.activeTabId, initial.activeTabId);
  const startRequestsBeforeClear = browserFixtureRequests.filter((request) => request.path === '/browser-smoke/start').length;
  const cleared = await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'clear-profile' })})`);
  assert.equal(cleared.profile.clearing, false);
  assert.equal(cleared.tabs.length, 1);
  assert.equal(cleared.tabs[0].url, initialUrl);
  assert.deepEqual(cleared.permissionDecisions, []);
  const resetRequest = browserFixtureRequests.filter((request) => request.path === '/browser-smoke/start').slice(startRequestsBeforeClear).at(-1);
  assert.ok(resetRequest, 'Clearing the browser profile did not reload the active tab.');
  assert.equal(resetRequest.cookie, '', 'Clearing the browser profile retained a cookie from the app-owned Chromium profile.');

  return { partition: initial.partition, initialUrl, createdUrl, navigatedUrl, bounds, profileCleared: true };
}

async function exerciseBrowserDownloadPopover() {
  const opened = await cdp.evaluate(`(() => {
    const actionsButton = document.querySelector('button[aria-label="More message actions"]');
    actionsButton?.click();
    return Boolean(actionsButton);
  })()`);
  assert.equal(opened, true, 'The packaged session actions button is missing.');
  await waitFor(() => cdp.evaluate(`Boolean([...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Open session browser')))`), 'packaged session Browser action');
  const selected = await cdp.evaluate(`(() => {
    const browserButton = [...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Open session browser'));
    browserButton?.click();
    return Boolean(browserButton);
  })()`);
  assert.equal(selected, true, 'The packaged session Browser action is missing.');
  await cdp.evaluate(`window.tethoqDesktop.browserAction(${JSON.stringify({ type: 'set-visible', visible: true })})`);
  await waitFor(async () => (await cdp.evaluate('window.tethoqDesktop.browserState()')).visible === true, 'visible packaged browser workspace');
  await waitFor(async () => {
    const value = await cdp.evaluate(`(() => {
      const downloads = document.querySelector('.browser-page .browser-downloads');
      return Boolean(document.querySelector('.browser-page')) && downloads && !downloads.disabled;
    })()`);
    return value;
  }, 'ready browser downloads button');
  const before = await cdp.evaluate(`(() => { const rect = document.querySelector('.browser-viewport')?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; })()`);
  assert.ok(before && before.width > 0 && before.height > 0, 'The packaged browser viewport is not laid out.');
  await cdp.evaluate(`(() => {
    const transition = { samples: [], popoverWithoutFreezeFrame: false, rendererWithoutDecodedFrame: false };
    const sample = () => {
      const trigger = document.querySelector('.browser-downloads');
      const value = {
        phase: document.querySelector('.browser-page')?.getAttribute('data-browser-overlay-phase') ?? null,
        busy: trigger?.getAttribute('aria-busy') ?? null,
        expanded: trigger?.getAttribute('aria-expanded') ?? null,
        popover: Boolean(document.querySelector('.browser-download-popover')),
        freezeFrame: Boolean(document.querySelector('.browser-freeze-frame')),
        frameDecoded: (() => {
          const frame = document.querySelector('.browser-freeze-frame');
          return frame instanceof HTMLImageElement && frame.complete && frame.naturalWidth > 0 && frame.naturalHeight > 0;
        })(),
      };
      if (value.popover && !value.freezeFrame) transition.popoverWithoutFreezeFrame = true;
      if (value.phase === 'renderer' && !value.frameDecoded) transition.rendererWithoutDecodedFrame = true;
      const serialized = JSON.stringify(value);
      if (transition.samples.at(-1)?.serialized !== serialized) transition.samples.push({ serialized, value });
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.querySelector('.browser-page'), { attributes: true, childList: true, subtree: true });
    transition.stop = () => observer.disconnect();
    sample();
    window.__tethoqDownloadTransition = transition;
  })()`);
  await cdp.evaluate(`(() => {
    const trigger = document.querySelector('.browser-downloads');
    if (!trigger) return false;
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    trigger.click();
    trigger.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  })()`);
  let lastPopoverState = null;
  const popoverStateHistory = [];
  const open = await waitFor(async () => {
    const value = await cdp.evaluate(`(() => {
      const popover = document.querySelector('.browser-download-popover')?.getBoundingClientRect();
      const viewport = document.querySelector('.browser-viewport')?.getBoundingClientRect();
      const freezeFrame = document.querySelector('.browser-freeze-frame');
      const trigger = document.querySelector('.browser-downloads');
      const diagnostic = {
        popover: Boolean(popover),
        viewport: viewport ? { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height } : null,
        freezeFrame: Boolean(freezeFrame),
        trigger: trigger ? { disabled: trigger.disabled, expanded: trigger.getAttribute('aria-expanded'), hasPopup: trigger.getAttribute('aria-haspopup') } : null,
        toast: document.querySelector('.toast')?.textContent?.trim() ?? null,
      };
      return popover && viewport && freezeFrame && trigger
        ? { ready: true, value: { popover: { x: popover.x, y: popover.y, width: popover.width, height: popover.height, rightGap: innerWidth - popover.right }, viewport: { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height }, freezeFrame: { naturalWidth: freezeFrame.naturalWidth, naturalHeight: freezeFrame.naturalHeight, complete: freezeFrame.complete }, trigger: { expanded: trigger.getAttribute('aria-expanded'), hasPopup: trigger.getAttribute('aria-haspopup') } } }
        : { ready: false, diagnostic };
    })()`);
    lastPopoverState = value;
    const serialized = JSON.stringify(value);
    if (popoverStateHistory.at(-1)?.state !== serialized) popoverStateHistory.push({ elapsedMs: Date.now(), state: serialized });
    return value.ready ? value.value : null;
  }, 'packaged download popover').catch((error) => {
    const startedAt = popoverStateHistory[0]?.elapsedMs ?? Date.now();
    const history = popoverStateHistory.map((entry) => ({ elapsedMs: entry.elapsedMs - startedAt, state: JSON.parse(entry.state) }));
    throw new Error(`${error.message}: ${JSON.stringify({ lastPopoverState, history })}`);
  });
  assert.ok(open.popover.width <= 380, 'The packaged download popover is not compact.');
  assert.ok(open.popover.rightGap <= 12, 'The packaged download popover is not anchored to the top right.');
  assert.ok(open.popover.x >= 0 && open.popover.y >= 0, 'The packaged download popover escapes the window.');
  assert.deepEqual(open.viewport, before, 'Opening packaged downloads shifted the Chromium viewport.');
  assert.deepEqual(open.trigger, { expanded: 'true', hasPopup: 'dialog' });
  assert.equal(open.freezeFrame.complete, true, 'The packaged Chromium freeze frame did not load.');
  assert.equal(open.freezeFrame.naturalWidth, Math.round(before.width), 'The packaged Chromium freeze frame width is cropped.');
  assert.equal(open.freezeFrame.naturalHeight, Math.round(before.height), 'The packaged Chromium freeze frame height is cropped.');
  const freezeFramePixels = await cdp.evaluate(`(async () => {
    const image = document.querySelector('.browser-freeze-frame');
    if (!(image instanceof HTMLImageElement)) return null;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(Math.floor(canvas.width * .1), Math.floor(canvas.height * .55), Math.max(1, Math.floor(canvas.width * .3)), Math.max(1, Math.floor(canvas.height * .25))).data;
    let white = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] >= 245 && pixels[index + 1] >= 245 && pixels[index + 2] >= 245 && pixels[index + 3] >= 240) white++;
    }
    return { whiteRatio: white / (pixels.length / 4) };
  })()`);
  assert.ok(freezeFramePixels && freezeFramePixels.whiteRatio < .01, `The packaged browser surrogate was blank or white: ${JSON.stringify(freezeFramePixels)}`);
  const openTransition = await cdp.evaluate(`(() => {
    const value = window.__tethoqDownloadTransition;
    return value ? { popoverWithoutFreezeFrame: value.popoverWithoutFreezeFrame, rendererWithoutDecodedFrame: value.rendererWithoutDecodedFrame, samples: value.samples.map((sample) => sample.value) } : null;
  })()`);
  assert.ok(openTransition, 'The packaged download transition tracker did not run.');
  assert.equal(openTransition.popoverWithoutFreezeFrame, false, `The packaged download panel exposed the viewport before its freeze frame painted: ${JSON.stringify(openTransition.samples)}`);
  assert.equal(openTransition.rendererWithoutDecodedFrame, false, `The renderer took browser ownership before its replacement frame decoded: ${JSON.stringify(openTransition.samples)}`);
  assert.ok(openTransition.samples.some((sample) => sample.phase === 'preparing' && sample.busy === 'true' && !sample.popover), 'The packaged download button did not own its prepare phase.');
  assert.ok(openTransition.samples.some((sample) => sample.phase === 'prepared' && sample.popover && sample.freezeFrame), 'The packaged download panel and freeze frame were not painted before native handoff.');
  assert.ok(openTransition.samples.some((sample) => sample.phase === 'renderer' && sample.expanded === 'true' && sample.popover && sample.freezeFrame), 'The renderer took browser ownership before the download panel and freeze frame were ready.');

  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(() => cdp.evaluate('!document.querySelector(".browser-download-popover")'), 'download popover Escape close');
  const closed = await waitFor(async () => {
    const value = await cdp.evaluate(`(() => { const trigger = document.querySelector('.browser-downloads'); return { freezeFrame: Boolean(document.querySelector('.browser-freeze-frame')), expanded: trigger?.getAttribute('aria-expanded'), focused: document.activeElement === trigger }; })()`);
    return !value.freezeFrame && value.expanded === 'false' && value.focused ? value : null;
  }, 'download popover native restoration');
  const transition = await cdp.evaluate(`(() => {
    const value = window.__tethoqDownloadTransition;
    value?.stop?.();
    return value ? { popoverWithoutFreezeFrame: value.popoverWithoutFreezeFrame, rendererWithoutDecodedFrame: value.rendererWithoutDecodedFrame, samples: value.samples.map((sample) => sample.value) } : null;
  })()`);
  assert.ok(transition, 'The packaged download transition tracker disappeared before close.');
  const rendererIndex = transition.samples.findIndex((sample) => sample.phase === 'renderer');
  const firstFrameRemoval = transition.samples.slice(rendererIndex + 1).find((sample) => !sample.freezeFrame);
  assert.ok(firstFrameRemoval, 'The packaged download freeze frame was not retired after close.');
  assert.equal(firstFrameRemoval.phase, 'native', `The packaged download freeze frame disappeared before Chromium ownership returned: ${JSON.stringify(transition.samples)}`);

  // Cancel one capture while it is preparing, then reopen. A stale capture or
  // generation token must never strand Chromium hidden or reject the next use.
  await cdp.evaluate(`document.querySelector('.browser-downloads')?.click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.browser-page')?.getAttribute('data-browser-overlay-phase') === 'preparing'`), 'download overlay rapid-cycle prepare');
  await cdp.evaluate(`document.querySelector('.browser-downloads')?.click()`);
  await waitFor(() => cdp.evaluate(`(() => {
    const page = document.querySelector('.browser-page');
    const trigger = document.querySelector('.browser-downloads');
    return page?.getAttribute('data-browser-overlay-phase') === 'native' && trigger?.getAttribute('aria-busy') === 'false' && !document.querySelector('.browser-freeze-frame') && !document.querySelector('.browser-download-popover');
  })()`), 'download overlay rapid-cycle cancellation');
  await cdp.evaluate(`document.querySelector('.browser-downloads')?.click()`);
  await waitFor(() => cdp.evaluate(`(() => {
    const frame = document.querySelector('.browser-freeze-frame');
    return document.querySelector('.browser-page')?.getAttribute('data-browser-overlay-phase') === 'renderer' && Boolean(document.querySelector('.browser-download-popover')) && frame instanceof HTMLImageElement && frame.complete && frame.naturalWidth > 0;
  })()`), 'download overlay rapid-cycle reopen');
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(() => cdp.evaluate(`document.querySelector('.browser-page')?.getAttribute('data-browser-overlay-phase') === 'native' && !document.querySelector('.browser-freeze-frame')`), 'download overlay rapid-cycle final close');
  return { ...open.popover, freezeFrame: open.freezeFrame, freezeFrameWhiteRatio: freezeFramePixels.whiteRatio, transitionSamples: transition.samples, viewportShifted: false, flashFree: true, escapeClosed: true, nativeRestored: !closed.freezeFrame, focusRestored: closed.focused, rapidCycle: true };
}

async function exerciseRecorder() {
  const idle = await cdp.evaluate('window.tethoqDesktop.recorderState()');
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.supported, true);
  assert.equal(idle.active, undefined);
  assert.equal(idle.privacy.localOnly, true);
  assert.equal(idle.privacy.neverUploadedAutomatically, true);

  const recording = await cdp.evaluate(`window.tethoqDesktop.recorderAction(${JSON.stringify({ type: 'start' })})`);
  assert.equal(recording.phase, 'recording');
  assert.equal(recording.active.phase, 'recording');
  assert.equal(recording.active.panicShortcut, 'CommandOrControl+Shift+F12');
  assert.equal(typeof recording.active.panicShortcutAvailable, 'boolean');
  assert.ok(path.resolve(recording.active.folderPath).startsWith(`${path.resolve(workflowRoot)}${path.sep}`), 'The packaged recorder did not use its isolated smoke storage directory.');
  assert.ok(await fileExists(path.join(recording.active.folderPath, 'workflow.json')));
  assert.ok(await fileExists(path.join(recording.active.folderPath, 'events.ndjson')));
  await delay(250);

  const stagedState = await cdp.evaluate(`window.tethoqDesktop.recorderAction(${JSON.stringify({ type: 'stop', reason: 'user' })})`);
  assert.equal(stagedState.phase, 'staged');
  assert.equal(stagedState.active, undefined);
  assert.equal(stagedState.staged.status, 'staged');
  assert.equal(stagedState.staged.stopReason, 'user');
  assert.ok(path.resolve(stagedState.staged.path).startsWith(`${path.resolve(workflowRoot)}${path.sep}`));
  assert.ok(await fileExists(stagedState.staged.manifestPath));
  assert.ok(await fileExists(stagedState.staged.eventsPath));

  const manifest = JSON.parse(await readFile(stagedState.staged.manifestPath, 'utf8'));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.status, 'staged');
  assert.equal(manifest.stopReason, 'user');
  assert.equal(manifest.privacy.localOnly, true);
  assert.equal(manifest.privacy.neverUploadedAutomatically, true);
  assert.ok(manifest.durationMs >= 0);
  const eventTypes = (await readFile(stagedState.staged.eventsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).type);
  assert.equal(eventTypes[0], 'recording-started');
  assert.equal(eventTypes.at(-1), 'recording-stopped');

  const listed = await cdp.evaluate(`window.tethoqDesktop.recorderAction(${JSON.stringify({ type: 'list' })})`);
  assert.ok(listed.some((workflow) => workflow.id === stagedState.staged.id && workflow.status === 'staged'));
  const stagedPath = stagedState.staged.path;
  const discarded = await cdp.evaluate(`window.tethoqDesktop.recorderAction(${JSON.stringify({ type: 'discard' })})`);
  assert.equal(discarded.phase, 'idle');
  assert.equal(await fileExists(path.join(stagedPath, 'workflow.json')), false, 'Discard left the staged workflow on disk.');
  const afterDiscard = await cdp.evaluate(`window.tethoqDesktop.recorderAction(${JSON.stringify({ type: 'list' })})`);
  assert.deepEqual(afterDiscard, []);

  return { id: stagedState.staged.id, eventTypes, durationMs: manifest.durationMs, discarded: true };
}

async function gracefulQuit() {
  if (!appPid) return;
  const available = await cdp.evaluate('typeof window.tethoqDesktop.quitForSmoke === "function"');
  assert.equal(available, true, 'The env-guarded packaged smoke quit hook was not exposed.');
  // Register before requesting quit. Synchronous PowerShell process polling blocks
  // this test's provider server and delays delivery of the child's actual exit.
  const child = appProcess;
  assert.equal(child.exitCode, null, 'The packaged app exited before the quit request.');
  let onExit;
  let timer;
  const exited = new Promise((resolve) => { onExit = resolve; child.once('exit', onExit); });
  try {
    await cdp.evaluate('void window.tethoqDesktop.quitForSmoke()');
    // An open debugging connection can retain Electron after its quit event.
    cdp.close();
    cdp = undefined;
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Graceful packaged app shutdown timed out')), 15_000); }),
    ]);
    assert.equal(code, 0, 'The packaged app did not exit cleanly.');
  } finally {
    clearTimeout(timer);
    child.removeListener('exit', onExit);
  }
}

async function launchPackagedApp() {
  const unavailableProviderCommand = path.join(runRoot, 'intentionally-unavailable-provider.exe');
  const isolatedHome = path.join(runRoot, 'home');
  const isolatedCodexHome = path.join(isolatedHome, '.codex');
  const isolatedEnvironment = { ...process.env };
  for (const name of Object.keys(isolatedEnvironment)) {
    const upperName = name.toUpperCase();
    if (/(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/u.test(upperName) || [
      'OPENCODE_SERVER_USERNAME',
      'TETHOQ_OPENCODE_USERNAME',
      'UAR_OPENCODE_USERNAME',
      'CODEX_HOME',
    ].includes(upperName)) delete isolatedEnvironment[name];
  }
  await Promise.all([
    isolatedHome,
    isolatedCodexHome,
    path.join(isolatedHome, 'Documents'),
    path.join(isolatedHome, 'Downloads'),
  ].map((directory) => mkdir(directory, { recursive: true })));
  appProcess = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`], {
    cwd: projectDirectory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...isolatedEnvironment,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      CODEX_HOME: isolatedCodexHome,
      TETHOQ_PACKAGED_SMOKE: '1',
      TETHOQ_PACKAGED_SMOKE_BROWSER_URL: `http://127.0.0.1:${fixturePort}/browser-smoke/start`,
      TETHOQ_PACKAGED_SMOKE_WORKFLOW_ROOT: workflowRoot,
      TETHOQ_PROJECT_DIRECTORY: projectDirectory,
      TETHOQ_OPENCODE_URL: `http://127.0.0.1:${fixturePort}/`,
      TETHOQ_OPENCODE_DB_PATH: path.join(runRoot, 'intentionally-unavailable-opencode.db'),
      TETHOQ_OPENCODE_COMMAND: unavailableProviderCommand,
      UAR_PROJECT_DIRECTORY: projectDirectory,
      UAR_OPENCODE_URL: `http://127.0.0.1:${fixturePort}/`,
      // Keep packaged QA deterministic and guarantee it never initializes a
      // real installed harness, reads the user's OpenCode database, or consumes
      // provider usage. OpenCode remains pointed at the local fixture above.
      TETHOQ_CODEX_COMMAND: unavailableProviderCommand,
      TETHOQ_GROK_COMMAND: unavailableProviderCommand,
      TETHOQ_PI_COMMAND: unavailableProviderCommand,
      TETHOQ_OMP_COMMAND: unavailableProviderCommand,
      TETHOQ_QWEN_COMMAND: unavailableProviderCommand,
      TETHOQ_GOOSE_COMMAND: unavailableProviderCommand,
      TETHOQ_KIMI_COMMAND: unavailableProviderCommand,
      TETHOQ_HERMES_COMMAND: unavailableProviderCommand,
      TETHOQ_CLINE_COMMAND: unavailableProviderCommand,
      TETHOQ_COPILOT_COMMAND: unavailableProviderCommand,
    },
  });
  appProcess.once('error', (error) => { throw error; });
  appProcess.stdout?.on('data', (chunk) => appOutput.push(`stdout: ${String(chunk)}`));
  appProcess.stderr?.on('data', (chunk) => appOutput.push(`stderr: ${String(chunk)}`));
  appPid = await waitFor(() => processCommandLines().some((process) => process.ProcessId === appProcess.pid) ? appProcess.pid : null, 'packaged app process');
  try {
    cdp = await connectCdp(debugPort);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${appOutput.length ? `\n${appOutput.slice(-20).join('')}` : ''}`);
  }
  await waitFor(() => cdp.evaluate('Boolean(window.tethoqDesktop && document.querySelector(".desktop-app"))'), 'real preload and renderer shell', 45_000);
  const shellHistory = await cdp.send('Page.getNavigationHistory');
  assert.equal(shellHistory.entries.length, 1, 'The packaged shell retained its temporary startup page in Back/Forward history.');
  const rendererUrl = await cdp.evaluate('location.href');
  await cdp.evaluate('history.back()');
  assert.equal(await cdp.evaluate('location.href'), rendererUrl, 'A Back command navigated the packaged shell away from the live renderer.');
  const smokeWindowState = await cdp.evaluate(`({ focused: document.hasFocus(), visibility: document.visibilityState })`);
  assert.equal(smokeWindowState.focused, false, 'The hidden packaged smoke window took foreground focus.');
}

async function quitPackagedApp() {
  await gracefulQuit();
  await waitFor(() => tethoqProcessesForUserData().length === 0, 'packaged process tree shutdown', 15_000);
  cdp?.close();
  cdp = undefined;
  appProcess?.kill();
  appProcess = undefined;
  appPid = undefined;
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
      return !response.ok;
    } catch {
      return true;
    }
  }, 'packaged debugging port shutdown', 10_000);
}

async function main() {
  runRoot = await mkdtemp(path.join(tmpdir(), 'tethoq-packaged-smoke-'));
  userData = path.join(runRoot, 'user-data');
  projectDirectory = path.join(runRoot, 'workspace');
  connectorDirectory = path.join(userData, 'connectors', 'community-echo');
  connectorMarkerPath = path.join(runRoot, 'connector-started.txt');
  workflowRoot = path.join(runRoot, 'workflows');
  const report = { packagedRoot: unpackedRoot, checks: {}, limitations: [] };
  try {
  assert.equal(process.platform, 'win32', 'The packaged smoke currently targets the Windows artifact.');
  assert.ok((await stat(executable)).isFile(), `Missing packaged executable: ${executable}`);
  report.resources = await verifyPackagedResources();
  for (const required of ['package.json', 'dist/index.js', 'dist/index.d.ts', 'tethoq.connector.schema.json', 'README.md', 'LICENSE', 'examples/echo/connector.js', 'examples/echo/tethoq.connector.json', 'examples/echo/README.md']) {
    assert.ok((await stat(path.join(sdkRoot, required))).isFile(), `Missing packaged connector SDK artifact: ${required}`);
  }
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await installEchoConnector();
  openCodeServer = await startOpenCodeFixture();
  const beforeProcesses = processCommandLines();
  await launchPackagedApp();
  const fixtureOff = await cdp.evaluate('!document.body.textContent.includes("Refactor the authentication boundary")');
  assert.equal(fixtureOff, true, 'Browser preview fixture leaked into packaged mode.');
  const pendingBootstrap = await cdp.evaluate('window.tethoqDesktop.bootstrap()');
  assert.equal(pendingBootstrap.app.packaged, true);
  assert.deepEqual(pendingBootstrap.allowedProviders, builtInProviders);
  assert.equal(pendingBootstrap.allowedProviders.includes('community.echo'), false, 'An unapproved connector entered the packaged provider allowlist.');
  assert.equal(pendingBootstrap.connectors.loaded.some((connector) => connector.id === 'community.echo'), false, 'An unapproved connector loaded on first launch.');
  const pendingConnector = pendingBootstrap.connectors.pending.find((connector) => connector.id === 'community.echo');
  assert.ok(pendingConnector, 'The packaged connector did not enter explicit review state.');
  assert.ok(path.isAbsolute(pendingConnector.runtime.command), 'Pending review did not show the exact resolved runtime executable.');
  assert.ok(/(?:^|[\\/])(?:node|electron|tethoq)(?:\.exe)?$/i.test(pendingConnector.runtime.command), `Unexpected packaged connector runtime: ${pendingConnector.runtime.command}`);
  assert.deepEqual(pendingConnector.runtime.args, ['./connector.js']);
  assert.deepEqual(pendingConnector.requestedEnvironmentNames, []);
  assert.deepEqual(pendingConnector.permissions, { filesystem: 'none', network: false, spawnProcesses: false });
  assert.equal(await fileExists(connectorMarkerPath), false, 'Unapproved connector code executed before review.');
  assert.deepEqual(connectorProcessesSince(beforeProcesses), [], 'An unapproved connector process started before review.');
  const pendingProviders = (await bridgeRequest('provider.list')).providers;
  assert.equal(pendingProviders.some((provider) => provider.providerId === 'community.echo'), false, 'An unapproved connector appeared in provider.list.');
  await cdp.evaluate('document.querySelector(".sidebar-task-filter")?.click()');
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".task-filter-popover"))'), 'pending connector task filters');
  const pendingTaskFilter = await cdp.evaluate(`[...document.querySelectorAll('.task-filter-popover .provider-options button')].some((button) => button.textContent.includes('Echo Connector'))`);
  assert.equal(pendingTaskFilter, false, 'An unapproved connector appeared in the task filter.');
  await cdp.evaluate('document.querySelector(".sidebar-task-filter")?.click()');
  await waitFor(() => cdp.evaluate('!document.querySelector(".task-filter-popover")'), 'pending connector task filters close');
  await cdp.evaluate('document.querySelector(".new-task-button")?.click()');
  try {
    await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-title h1')?.textContent === 'New task' && document.querySelector('textarea[aria-label="Message"]')?.placeholder.startsWith('Describe the task')`), 'pending connector local draft');
  } catch (error) {
    const draftState = await cdp.evaluate(`({ title: document.querySelector('.workspace-title h1')?.textContent ?? null, placeholder: document.querySelector('textarea[aria-label="Message"]')?.placeholder ?? null, selected: document.querySelector('[data-session-id] > .session-row.selected')?.parentElement?.getAttribute('data-session-id') ?? null, toast: document.querySelector('.toast')?.textContent ?? null, body: document.body.innerText.slice(0, 800), error: document.querySelector('.renderer-error-boundary')?.textContent ?? null })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(draftState)}`);
  }
  await cdp.evaluate('document.querySelector(".model-picker-trigger")?.click()');
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(".model-picker-dropup"))'), 'pending connector model catalog');
  const pendingModelCatalog = await cdp.evaluate(`Boolean(document.querySelector('.model-picker-dropup [data-provider-group="community.echo"]'))`);
  assert.equal(pendingModelCatalog, false, 'An unapproved connector appeared in the model catalog.');
  await cdp.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await waitFor(() => cdp.evaluate('!document.querySelector(".model-picker-dropup")'), 'pending connector model catalog close');
  const approval = await cdp.evaluate(`window.tethoqDesktop.connectorAction(${JSON.stringify({ type: 'approve', fingerprint: pendingConnector.fingerprint })})`);
  assert.equal(approval.restartRequired, true, 'Connector approval did not require a clean restart.');
  const beforeRestart = await cdp.evaluate('window.tethoqDesktop.bootstrap()');
  assert.equal(beforeRestart.allowedProviders.includes('community.echo'), false, 'Connector approval exposed the provider before restart.');
  assert.equal(beforeRestart.connectors.loaded.some((connector) => connector.id === 'community.echo'), false, 'Connector approval marked the connector loaded before restart.');
  assert.equal(await fileExists(connectorMarkerPath), false, 'Connector approval executed code before restart.');
  assert.deepEqual(connectorProcessesSince(beforeProcesses), [], 'Connector approval started a process before restart.');
  await quitPackagedApp();

  await launchPackagedApp();
  const bootstrap = await cdp.evaluate('window.tethoqDesktop.bootstrap()');
  assert.equal(bootstrap.app.packaged, true);
  assert.deepEqual(bootstrap.allowedProviders.slice(0, builtInProviders.length), builtInProviders);
  assert.ok(bootstrap.allowedProviders.includes('community.echo'));
  assert.ok(bootstrap.connectors.loaded.some((connector) => connector.id === 'community.echo'));
  assert.equal(bootstrap.connectors.pending.some((connector) => connector.id === 'community.echo'), false);
  await waitFor(() => fileExists(connectorMarkerPath), 'approved connector execution after restart');
  report.browser = await exerciseBrowserWorkspace();
  report.recorder = await exerciseRecorder();
  const providers = (await bridgeRequest('provider.list')).providers;
  assert.ok(builtInProviders.every((id) => providers.some((provider) => provider.providerId === id)));
  assert.ok(providers.some((provider) => provider.providerId === 'community.echo' && provider.state === 'online'));
  const models = (await bridgeRequest('models.list', { providerId: 'community.echo' })).models;
  assert.deepEqual(models.map((model) => model.id), ['echo-fast', 'echo-careful']);
  const hasPersistedTaskComposer = await cdp.evaluate(`(() => { const placeholder = document.querySelector('textarea[aria-label="Message"]')?.placeholder ?? ''; return placeholder.startsWith('Continue this task') || placeholder.startsWith('Add an instruction'); })()`);
  report.browserDownloadPopover = hasPersistedTaskComposer
    ? await exerciseBrowserDownloadPopover()
    : { skipped: 'The isolated smoke profile has no persisted task; browser workspace behavior is covered directly.' };
  report.openCodeReasoning = await exerciseOpenCodeReasoningReconciliation();
  report.openCodeRetry = await exerciseOpenCodeRetryNotice();
  await cdp.evaluate('document.querySelector(".new-task-button")?.click()');
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-title h1')?.textContent === 'New task' && document.querySelector('textarea[aria-label="Message"]')?.placeholder.startsWith('Describe the task')`), 'approved connector local draft');
  await cdp.evaluate('document.querySelector(".model-picker-trigger")?.click()');
  await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.model-picker-dropup [data-provider-group="community.echo"]'))`), 'approved connector model catalog');
  const picker = await cdp.evaluate(`(() => { const group = document.querySelector('.model-picker-dropup [data-provider-group="community.echo"]'); if (!group) return null; const heading = group.querySelector('h4'); return { provider: [...(heading?.childNodes ?? [])].at(-1)?.textContent.trim(), modelOptions: [...group.querySelectorAll('button strong')].map((label) => label.textContent.trim()) }; })()`);
  assert.equal(picker.provider, 'Echo Connector');
  assert.deepEqual(picker.modelOptions, ['Echo Fast', 'Echo Careful']);
  const selectedEchoModel = await cdp.evaluate(`(() => { const group = document.querySelector('.model-picker-dropup [data-provider-group="community.echo"]'); const button = [...(group?.querySelectorAll('button') ?? [])].find((candidate) => candidate.querySelector('strong')?.textContent.trim() === 'Echo Fast'); button?.click(); return Boolean(button); })()`);
  assert.equal(selectedEchoModel, true, 'The packaged draft could not select the Echo Connector model.');
  const draftSelection = await waitFor(async () => {
    const value = await cdp.evaluate(`(() => { const textarea = document.querySelector('textarea[aria-label="Message"]'); return { title: document.querySelector('.workspace-title h1')?.textContent, selectedModel: document.querySelector('.model-picker-trigger strong')?.textContent, pickerOpen: Boolean(document.querySelector('.model-picker-dropup')), draftPlaceholder: textarea?.placeholder, draftContent: textarea?.value, sendDisabled: document.querySelector('.send-button')?.disabled }; })()`);
    return value.selectedModel === 'Echo Fast' && !value.pickerOpen ? value : null;
  }, 'approved connector draft model selection');
  assert.equal(draftSelection.title, 'New task');
  assert.ok(draftSelection.draftPlaceholder.startsWith('Describe the task'));
  assert.equal(draftSelection.draftContent, '');
  assert.equal(draftSelection.sendDisabled, true, 'The local draft unexpectedly became sendable during the picker-only connector smoke.');
  const created = await bridgeRequest('session.create', { providerId: 'community.echo', workingDirectory: projectDirectory, title: 'Packaged smoke', modelId: 'echo-fast' });
  const sessionId = created.session.id;
  await bridgeRequest('session.open', { sessionId, limit: 20 });
  const eventBatches = cdp.evaluate(`new Promise((resolve) => { const events = []; const stop = window.tethoqDesktop.onEventBatch((batch) => { events.push(...batch.events); if (events.some((event) => event.type === 'agent.completed' && event.sessionId === ${JSON.stringify(sessionId)})) { stop(); resolve(events); } }); setTimeout(() => { stop(); resolve(events); }, 10000); })`);
  await bridgeRequest('session.send_message', { sessionId, content: 'packaged streaming' }, 'packaged-smoke-send');
  const events = await eventBatches;
  assert.ok(events.some((event) => event.type === 'message.delta' && event.payload.text === 'Echo: packaged streaming'));
  assert.ok(events.some((event) => event.type === 'message.completed'));
  const opened = await waitFor(async () => {
    const value = await bridgeRequest('session.open', { sessionId, limit: 20 });
    return value.messages?.some((message) => message.parts?.some((part) => part.type === 'text' && part.text === 'Echo: packaged streaming')) ? value : null;
  }, 'echo message history');
  assert.ok(opened.messages.length >= 2);
  const forbidden = await scanForbidden(resources);
  assert.deepEqual(forbidden, { forbiddenNames: [], forbiddenBundleText: [] });
  const processesBeforeQuit = processCommandLines();
  const childrenBeforeQuit = descendantPids(appPid, processesBeforeQuit).filter((pid) => !beforeProcesses.some((process) => process.ProcessId === pid));
  const connectorPidsBeforeQuit = processesBeforeQuit
    .filter((process) => !beforeProcesses.some((existing) => existing.ProcessId === process.ProcessId))
    .filter((process) => /(?:^|[\\/\s])connector\.js(?:["\s]|$)/i.test(process.CommandLine ?? ''))
    .map((process) => process.ProcessId);
  assert.ok(connectorPidsBeforeQuit.length > 0, 'The packaged Echo connector process was not observable before shutdown.');
  await gracefulQuit();
  await delay(1_000);
  const processesAfterQuit = processCommandLines();
  const remaining = processesAfterQuit.filter((process) => childrenBeforeQuit.includes(process.ProcessId));
  assert.deepEqual(remaining, [], `Packaged app left child processes running: ${JSON.stringify(remaining)}`);
  const remainingConnectors = processesAfterQuit.filter((process) => connectorPidsBeforeQuit.includes(process.ProcessId));
  assert.deepEqual(remainingConnectors, [], `Packaged app left connector processes running: ${JSON.stringify(remainingConnectors)}`);
  report.checks = {
    preload: true,
    fixtureOff: true,
    embeddedBridgeArchive: true,
    embeddedBridgeChecksum: true,
    unpackedUiohookNativeModule: true,
    nativeBuildArtifactsExcluded: true,
    browserPreloadLifecycle: true,
    browserPrivateProfileReset: true,
    browserCompactDownloadPopover: true,
    recorderNativeHookLifecycle: true,
    recorderStageDiscard: true,
    builtIns: true,
    connectorPendingBeforeApproval: true,
    connectorDormantBeforeApproval: true,
    connectorApprovalRequiresRestart: true,
    externalConnector: true,
    pickerModels: true,
    createSendRead: true,
    streaming: true,
    openCodeReasoningStreaming: true,
    openCodeReasoningReconciliation: true,
    openCodeReasoningDisclosure: true,
    openCodePathlessFileSuppression: true,
    openCodeRetryNotice: true,
    openCodeRetryStop: true,
    openCodeStopIdempotence: true,
    forbiddenProviderScan: true,
    gracefulChildShutdown: true,
  };
  report.processes = { appPid, childrenBeforeQuit, connectorPidsBeforeQuit };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Packaged smoke passed: ${reportPath}\n`);
  } catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  await mkdir(path.dirname(reportPath), { recursive: true }).catch(() => undefined);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  process.stderr.write(`${report.error}\n`);
  process.exitCode = 1;
  } finally {
  cdp?.close();
  if (appPid && processCommandLines().some((process) => process.ProcessId === appPid)) {
    spawnSync('taskkill.exe', ['/pid', String(appPid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  }
  appProcess?.kill();
  if (openCodeServer) {
    for (const client of openCodeServer.clients) client.end();
    openCodeServer.server.closeAllConnections?.();
    await Promise.race([
      new Promise((resolve) => openCodeServer.server.close(resolve)),
      delay(2_000),
    ]);
  }
    await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main();
