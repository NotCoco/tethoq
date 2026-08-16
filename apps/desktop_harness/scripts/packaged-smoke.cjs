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
const fixturePort = Number(process.env.TETHOQ_SMOKE_OPENCODE_PORT ?? 4096);
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
  const sendSse = (type, properties) => {
    const line = `data: ${JSON.stringify({ payload: { type, properties } })}\n\n`;
    for (const response of clients) response.write(line);
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
      response.end(`<!doctype html><html><head><title>Tethoq browser smoke ${pageName}</title></head><body><main data-smoke-page="${pageName}">Browser smoke ${pageName}</main></body></html>`);
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
    if (url.pathname === '/session/status') return json(response, {});
    if (request.method === 'GET' && url.pathname === '/session') return json(response, [...sessions.values()]);
    if (request.method === 'POST' && url.pathname === '/session') {
      const id = `opencode-smoke-${Date.now()}`;
      const now = Date.now();
      const session = { id, title: 'OpenCode smoke', directory: url.searchParams.get('directory') ?? projectDirectory, time: { created: now, updated: now } };
      sessions.set(id, session); messages.set(id, []);
      return json(response, session);
    }
    const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (request.method === 'GET' && !match[2]) return json(response, sessions.get(id));
      if (request.method === 'GET' && match[2] === 'message') return json(response, messages.get(id) ?? []);
      if (request.method === 'POST' && match[2] === 'prompt_async') {
        const body = await readJsonBody(request);
        const text = body?.parts?.find((part) => part?.type === 'text')?.text ?? '';
        const part = { id: `part-${Date.now()}`, sessionID: id, messageID: body.messageID, type: 'text', text: `Fixture: ${text}` };
        sendSse('message.part.updated', { part, delta: part.text });
        return json(response, {}, 204);
      }
    }
    json(response, { error: 'not found', path: url.pathname }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(fixturePort, '127.0.0.1', resolve);
  });
  return { server, clients };
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
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
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

  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(() => cdp.evaluate('!document.querySelector(".browser-download-popover")'), 'download popover Escape close');
  const closed = await waitFor(async () => {
    const value = await cdp.evaluate(`(() => { const trigger = document.querySelector('.browser-downloads'); return { freezeFrame: Boolean(document.querySelector('.browser-freeze-frame')), expanded: trigger?.getAttribute('aria-expanded'), focused: document.activeElement === trigger }; })()`);
    return !value.freezeFrame && value.expanded === 'false' && value.focused ? value : null;
  }, 'download popover native restoration');
  return { ...open.popover, freezeFrame: open.freezeFrame, viewportShifted: false, escapeClosed: true, nativeRestored: !closed.freezeFrame, focusRestored: closed.focused };
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
  await cdp.evaluate('void window.tethoqDesktop.quitForSmoke()');
  await waitFor(() => !processCommandLines().some((process) => process.ProcessId === appPid), 'graceful packaged app shutdown', 15_000);
}

async function launchPackagedApp() {
  const unavailableProviderCommand = path.join(runRoot, 'intentionally-unavailable-provider.exe');
  appProcess = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`], {
    cwd: projectDirectory,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TETHOQ_PACKAGED_SMOKE: '1',
      TETHOQ_PACKAGED_SMOKE_BROWSER_URL: `http://127.0.0.1:${fixturePort}/browser-smoke/start`,
      TETHOQ_PACKAGED_SMOKE_WORKFLOW_ROOT: workflowRoot,
      UAR_PROJECT_DIRECTORY: projectDirectory,
      UAR_OPENCODE_URL: `http://127.0.0.1:${fixturePort}/`,
      // Keep packaged QA deterministic and guarantee it never initializes a
      // real installed harness or consumes provider usage. OpenCode remains
      // pointed at the local fixture above.
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
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
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
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace-title h1')?.textContent === 'New task' && document.querySelector('textarea[aria-label="Message"]')?.placeholder.startsWith('Describe the task')`), 'pending connector local draft');
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
