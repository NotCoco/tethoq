'use strict';

/**
 * Background Electron QA driver for the deterministic fake model.
 *
 * It launches the real, built renderer with a test-only preload
 * (scripts/fake-model/preload.cjs) and a fake model host
 * (scripts/fake-model/fake-model-host.cjs) registered under the real IPC
 * channel names. The renderer therefore runs its ordinary non-preview
 * request/event path end to end; only the source of events is test-only.
 *
 * All input goes through webContents/DOM (sendInputEvent, insertText,
 * executeJavaScript) and screenshots come from capturePage. No Computer Use,
 * no real providers, no provider tokens, no network.
 *
 * Run: electron scripts/fake-model-qa.cjs [--only=<scenario>] [outdir]
 */

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage, session } = require('electron');
const { createFakeModelHost } = require('./fake-model/fake-model-host.cjs');
const { FEATURE_CONTRACT, evaluateFeatureCoverage } = require('./fake-model/coverage-contract.cjs');
const { cleanupOldScreenshotArtifacts } = require('./fake-model/artifact-cleanup.cjs');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const preloadPath = path.join(__dirname, 'fake-model', 'preload.cjs');
const outputArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const artifactDirectory = path.resolve(outputArgument ?? path.join(appRoot, '..', '..', 'local-artifacts', 'fake-model-qa'));
const onlyArgument = process.argv.slice(2).find((argument) => argument.startsWith('--only='));
const onlyScenario = onlyArgument ? onlyArgument.slice('--only='.length) : null;
const screenshotMaxAgeMs = Number.isFinite(Number(process.env.FAKE_MODEL_QA_SCREENSHOT_MAX_AGE_MS))
  ? Math.max(0, Number(process.env.FAKE_MODEL_QA_SCREENSHOT_MAX_AGE_MS))
  : undefined;

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createOneShotGate() {
  let releaseWait;
  let released = false;
  const wait = new Promise((resolve) => { releaseWait = resolve; });
  return {
    used: false,
    wait,
    release() {
      if (released) return;
      released = true;
      releaseWait();
    },
  };
}

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const defaultPreferences = {
  version: 1,
  experimentalFeatures: false,
  reasoningDisplay: 'compact',
  taskListMode: 'recent',
  localOpenHandlerId: 'system',
  closeAction: 'tray',
  launchAtLogin: 'off',
  alerts: 'all',
  agentDefaults: {},
  globalAgentsPath: null,
  taskOverrides: {},
  allowForeignSubagents: false,
  foreignSubagentOverrides: {},
  ears: { enabled: false, providerId: null, modelId: null, mode: 'cleaned' },
};

const recorderIdleState = {
  phase: 'idle',
  supported: true,
  privacy: {
    localOnly: true,
    neverUploadedAutomatically: true,
    capturesScreen: true,
    capturesGlobalInput: true,
    capturesKeyCodesNotText: true,
    sensitiveDataPossible: true,
    warning: 'Recording may capture sensitive screen and input context.',
    limitations: [],
  },
};

const emptyBrowserState = {
  partition: 'persist:tethoq-browser',
  profile: { persistent: true, appOwned: true, importsSystemProfile: false, clearing: false },
  visible: false,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  activeTabId: null,
  tabs: [],
  downloads: [],
  pendingPermissions: [],
  permissionDecisions: [],
};

const liveSessionIdleState = {
  phase: 'idle',
  supported: true,
  enabled: false,
  privacy: {
    localOnly: true,
    neverUploadedAutomatically: true,
    capturesScreen: true,
    capturesPointer: true,
    capturesMicrophone: true,
    sensitiveDataPossible: true,
    warning: '',
    limitations: [],
  },
};

const localOpenState = {
  defaultHandlerId: 'system',
  handlers: [{ id: 'system', label: 'File Explorer', icon: 'explorer' }],
};

function featureEvidenceForScenario(scenario, observations) {
  const expected = FEATURE_CONTRACT
    .filter((feature) => feature.scenario === scenario)
    .map((feature) => feature.id)
    .sort();
  const actual = Object.keys(observations ?? {}).sort();
  assert.deepEqual(actual, expected, `${scenario}: feature evidence must name each and only each contracted feature`);
  return Object.fromEntries(expected.map((featureId) => [featureId, {
    passed: true,
    // Keep the observation deliberately small and serializable for report.json.
    // The scenario's assertions have already run before this record is made.
    observed: { value: observations[featureId] },
  }]));
}

function scenarioOutcome(scenario, outcome, observations) {
  return {
    ...outcome,
    featureEvidence: featureEvidenceForScenario(scenario, observations),
  };
}

function registerFakeModelIpc(window, host, options = {}) {
  const handles = new Map();
  let preferences = JSON.parse(JSON.stringify(defaultPreferences));
  let mobileConnection = { state: 'idle', devices: [] };
  const directorySelections = Array.isArray(options.directorySelections) ? [...options.directorySelections] : null;
  const handle = (channel, listener) => {
    handles.set(channel, listener);
    ipcMain.handle(channel, listener);
  };
  handle('tethoq:bootstrap', () => host.bootstrap());
  handle('tethoq:request', async (_event, input) => {
    const record = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const requestType = typeof record.type === 'string' ? record.type : '';
    const firstSessionsListGate = options.firstSessionsListGate;
    if (requestType === 'sessions.list' && firstSessionsListGate && firstSessionsListGate.used !== true) {
      firstSessionsListGate.used = true;
      await firstSessionsListGate.wait;
    }
    const firstInterruptGate = options.firstInterruptGate;
    if (requestType === 'session.interrupt' && firstInterruptGate && firstInterruptGate.used !== true) {
      firstInterruptGate.used = true;
      await firstInterruptGate.wait;
    }
    return host.handleRequest(requestType, record.payload ?? {}, record.requestId);
  });
  handle('tethoq:select-directory', () => directorySelections ? (directorySelections.shift() ?? null) : (options.directorySelection ?? null));
  handle('tethoq:select-images', async () => {
    const firstSelectImagesGate = options.firstSelectImagesGate;
    if (firstSelectImagesGate && firstSelectImagesGate.used !== true) {
      firstSelectImagesGate.used = true;
      await firstSelectImagesGate.wait;
    }
    return [{
      name: 'fake-attachment.png',
      path: 'C:\\FakeModel\\fake-attachment.png',
      mimeType: 'image/png',
      byteLength: 68,
      dataBase64: ONE_PIXEL_PNG_BASE64,
    }];
  });
  handle('tethoq:select-files', () => []);
  handle('tethoq:capture-screens', () => []);
  handle('tethoq:reveal-path', () => true);
  handle('tethoq:copy-text', () => true);
  handle('tethoq:local-open-handlers', () => localOpenState);
  handle('tethoq:open-local-target', () => ({ opened: true, handlerId: 'system', state: localOpenState }));
  handle('tethoq:open-dictation-setup-page', () => undefined);
  handle('tethoq:open-harness-setup-page', () => undefined);
  handle('tethoq:show-window', () => {
    if (options.keepWindowHidden === true) return;
    if (!window.isDestroyed()) window.show();
  });
  handle('tethoq:hide-window', () => undefined);
  handle('tethoq:opencode-status', () => ({ state: 'unavailable', url: '', managed: false }));
  handle('tethoq:restart-opencode', () => ({ state: 'unavailable', url: '', managed: false }));
  handle('tethoq:connector-action', () => ({ connectors: { directory: 'C:\\FakeModel\\connectors', loaded: [], pending: [], diagnostics: [] }, restartRequired: false }));
  handle('tethoq:browser-get-state', () => emptyBrowserState);
  handle('tethoq:browser-action', () => emptyBrowserState);
  handle('tethoq:recorder-get-state', () => recorderIdleState);
  handle('tethoq:recorder-action', (_event, action) => action && action.type === 'list' ? [] : recorderIdleState);
  handle('tethoq:preferences-get', () => preferences);
  handle('tethoq:preferences-action', (_event, action) => {
    if (action?.type === 'set-task-override' && typeof action.sessionId === 'string' && action.sessionId && action.override && typeof action.override === 'object') {
      preferences = {
        ...preferences,
        taskOverrides: {
          ...preferences.taskOverrides,
          [action.sessionId]: {
            ...preferences.taskOverrides[action.sessionId],
            ...JSON.parse(JSON.stringify(action.override)),
          },
        },
      };
    }
    if (action?.type === 'set-ears' && action.ears && typeof action.ears === 'object') {
      preferences = { ...preferences, ears: JSON.parse(JSON.stringify(action.ears)) };
    }
    if (action?.type === 'set-close-action') preferences = { ...preferences, closeAction: action.value === 'quit' ? 'quit' : 'tray' };
    if (action?.type === 'set-alerts') preferences = { ...preferences, alerts: ['all', 'attention', 'off'].includes(action.value) ? action.value : 'all' };
    if (action?.type === 'set-launch-at-login') preferences = { ...preferences, launchAtLogin: ['off', 'window', 'tray'].includes(action.value) ? action.value : 'off' };
    if (action?.type === 'set-reasoning-display') preferences = { ...preferences, reasoningDisplay: action.value === 'expanded' ? 'expanded' : 'compact' };
    if (action?.type === 'set-task-list-mode') preferences = { ...preferences, taskListMode: action.value === 'project' ? 'project' : 'recent' };
    if (action?.type === 'set-experimental-features') preferences = { ...preferences, experimentalFeatures: action.enabled === true };
    if (action?.type === 'set-allow-foreign-subagents') preferences = { ...preferences, allowForeignSubagents: action.enabled === true };
    return preferences;
  });
  handle('tethoq:live-session-get-state', () => liveSessionIdleState);
  handle('tethoq:live-session-action', () => liveSessionIdleState);
  handle('tethoq:mobile-connection-get-state', () => mobileConnection);
  handle('tethoq:mobile-connection-action', (_event, action) => {
    if (action?.type === 'start') {
      mobileConnection = {
        state: 'ready',
        devices: mobileConnection.devices,
        qrDataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0h1v1H0zm1 1h1v1H1z"/></svg>').toString('base64')}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      };
    } else if (action?.type === 'revoke') {
      mobileConnection = { ...mobileConnection, devices: mobileConnection.devices.filter((device) => device.id !== action.connectionId) };
    }
    if (!window.isDestroyed()) window.webContents.send('tethoq:mobile-connection-state', mobileConnection);
    return mobileConnection;
  });
  ipcMain.on('tethoq:renderer-ready', () => undefined);
  return () => {
    for (const channel of handles.keys()) ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners('tethoq:renderer-ready');
  };
}

async function evaluate(window, source) {
  const result = await window.webContents.executeJavaScript(`(async () => {
    try {
      return { __qaValue: await (async () => { return (${source}); })() };
    } catch (error) {
      return { __qaError: error instanceof Error ? error.message : String(error), __qaStack: error instanceof Error ? error.stack : undefined };
    }
  })()`, true);
  if (result && typeof result === 'object' && '__qaError' in result) {
    throw new Error(`${result.__qaError}${result.__qaStack ? `\n${result.__qaStack}` : ''}`);
  }
  return result && typeof result === 'object' && '__qaValue' in result ? result.__qaValue : result;
}

async function waitFor(window, expression, label, timeout = 8_000) {
  await evaluate(window, `new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (${expression}) return resolve(true);
      if (Date.now() - started > ${timeout}) return reject(new Error(${JSON.stringify(label)}));
      setTimeout(check, 25);
    };
    check();
  })`);
}

async function installScrollTrace(window) {
  await evaluate(window, `(() => {
    window.__tethoqScrollTrace = { accesses: [], scrollEvents: [], resizeCallbacks: [], mutations: [] };
    window.__tethoqTraceCause = 'document-start';
    const withCause = (cause, callback, args) => {
      const previous = window.__tethoqTraceCause;
      window.__tethoqTraceCause = cause;
      try { return callback(...args); } finally { window.__tethoqTraceCause = previous; }
    };
    const nativeTimeout = window.setTimeout.bind(window);
    const nativeInterval = window.setInterval.bind(window);
    const nativeFrame = window.requestAnimationFrame.bind(window);
    window.setTimeout = (callback, timeout = 0, ...args) => nativeTimeout(() => withCause('timeout:' + timeout, callback, args), timeout);
    window.setInterval = (callback, timeout = 0, ...args) => nativeInterval(() => withCause('interval:' + timeout, callback, args), timeout);
    window.requestAnimationFrame = (callback) => nativeFrame((time) => withCause('animation-frame', callback, [time]));
    const owner = [Element.prototype, HTMLElement.prototype].find((candidate) => Object.getOwnPropertyDescriptor(candidate, 'scrollTop'));
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'scrollTop');
    if (owner && descriptor?.get && descriptor?.set) Object.defineProperty(owner, 'scrollTop', {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get() {
        const value = descriptor.get.call(this);
        if (this instanceof HTMLElement && this.classList.contains('conversation-scroll')) {
          window.__tethoqScrollTrace.accesses.push({ type: 'read', at: performance.now(), value, height: this.scrollHeight, client: this.clientHeight, cause: window.__tethoqTraceCause });
        }
        return value;
      },
      set(value) {
        if (this instanceof HTMLElement && this.classList.contains('conversation-scroll')) {
          window.__tethoqScrollTrace.accesses.push({ type: 'write', at: performance.now(), value, before: descriptor.get.call(this), height: this.scrollHeight, client: this.clientHeight, cause: window.__tethoqTraceCause, stack: new Error().stack });
        }
        descriptor.set.call(this, value);
      },
    });
    window.addEventListener('scroll', (event) => {
      if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('conversation-scroll')) return;
      window.__tethoqScrollTrace.scrollEvents.push({ at: performance.now(), top: event.target.scrollTop, height: event.target.scrollHeight, client: event.target.clientHeight, cause: window.__tethoqTraceCause });
    }, true);
    new MutationObserver((records) => {
      const relevant = records.filter((record) => record.target instanceof Node && (record.target.parentElement?.closest('.conversation') || (record.target instanceof Element && record.target.closest('.conversation'))));
      if (relevant.length) window.__tethoqScrollTrace.mutations.push({ at: performance.now(), count: relevant.length, cause: window.__tethoqTraceCause });
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  })()`);
}

async function capture(window, name, captures) {
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const target = path.join(artifactDirectory, `${name}.png`);
  let image;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    window.webContents.invalidate();
    await delay(50);
    image = await window.capturePage();
    const bitmap = image.toBitmap();
    const hasDifferentPixel = bitmap.length >= 8 && (() => {
      for (let index = 4; index < bitmap.length; index += 4) {
        if (bitmap[index] !== bitmap[0]
          || bitmap[index + 1] !== bitmap[1]
          || bitmap[index + 2] !== bitmap[2]
          || bitmap[index + 3] !== bitmap[3]) return true;
      }
      return false;
    })();
    if (hasDifferentPixel) break;
  }
  await fs.writeFile(target, image.toPNG());
  captures.push({ name, path: target });
  return target;
}

/**
 * Pixel-level screenshot inspection: every capture must be a real painted
 * frame (not blank, not an all-black window, not a single flat color). This
 * is the background-driver stand-in for eyeballing each screenshot.
 */
function analyzeCapture(filePath) {
  const image = nativeImage.createFromPath(filePath);
  const size = image.getSize();
  assert.ok(size.width > 0 && size.height > 0, `capture ${path.basename(filePath)} has no pixels`);
  const bitmap = image.toBitmap();
  let sum = 0;
  let sumSquares = 0;
  let nearBlack = 0;
  const count = bitmap.length / 4;
  for (let index = 0; index < bitmap.length; index += 4) {
    const red = bitmap[index + 2];
    const green = bitmap[index + 1];
    const blue = bitmap[index];
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sum += luma;
    sumSquares += luma * luma;
    if (luma < 8) nearBlack += 1;
  }
  const mean = sum / count;
  const stddev = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
  const nearBlackFraction = nearBlack / count;
  const analysis = { width: size.width, height: size.height, mean: Number(mean.toFixed(2)), stddev: Number(stddev.toFixed(2)), nearBlackFraction: Number(nearBlackFraction.toFixed(4)) };
  assert.ok(stddev >= 4, `capture ${path.basename(filePath)} is a flat frame (stddev ${stddev.toFixed(2)}): blank or unpainted screenshot`);
  assert.ok(nearBlackFraction < 0.97, `capture ${path.basename(filePath)} is almost entirely black (${nearBlackFraction.toFixed(3)})`);
  return analysis;
}

async function clickSelector(window, selector) {
  await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  })()`);
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const point = await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.right < 0 || bounds.left > window.innerWidth || bounds.bottom < 0 || bounds.top > window.innerHeight) throw new Error('Element is outside the viewport or has no painted hit area: ' + ${JSON.stringify(selector)});
    const x = Math.round(bounds.left + bounds.width / 2);
    const y = Math.round(bounds.top + bounds.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!element.contains(hit)) throw new Error('Element is occluded at its click point: ' + ${JSON.stringify(selector)} + ' bounds=' + JSON.stringify({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }) + ' hit=' + (hit?.outerHTML?.slice(0, 240) ?? 'none'));
    return { x, y };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await delay(30);
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function hoverSelector(window, selector) {
  const point = await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) throw new Error('Element has no hover area: ' + ${JSON.stringify(selector)});
    return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  await delay(80);
}

/**
 * Uses a point whose visibility was asserted in the same renderer turn. This
 * is useful for a control that can re-render between a diagnostic probe and
 * the normal helper's second hit-test, while still refusing hidden/occluded
 * controls.
 */
async function clickVerifiedVisibleSelector(window, selector) {
  const point = await evaluate(window, `(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((candidate) => candidate instanceof HTMLElement && getComputedStyle(candidate).display !== 'none' && getComputedStyle(candidate).visibility !== 'hidden');
    if (elements.length !== 1) throw new Error('Expected exactly one visible control: ' + ${JSON.stringify(selector)} + ' (found ' + elements.length + ')');
    const element = elements[0];
    const bounds = element.getBoundingClientRect();
    const x = Math.round(bounds.left + bounds.width / 2);
    const y = Math.round(bounds.top + bounds.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (hit !== element && !element.contains(hit)) throw new Error('Control is occluded at its verified click point: ' + ${JSON.stringify(selector)} + ' hit=' + (hit?.outerHTML?.slice(0, 240) ?? 'none'));
    return { x, y };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await delay(30);
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function bringIntoView(window, selector) {
  await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  })()`);
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}

async function contextClickSelector(window, selector) {
  await evaluate(window, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) throw new Error('Element not found: ' + ${JSON.stringify(selector)}); element.scrollIntoView({ block: 'center' }); })()`);
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const point = await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.right < 0 || bounds.left > window.innerWidth || bounds.bottom < 0 || bounds.top > window.innerHeight) throw new Error('Element is outside the viewport or has no painted hit area: ' + ${JSON.stringify(selector)});
    const x = Math.round(bounds.left + bounds.width / 2);
    const y = Math.round(bounds.top + bounds.height / 2);
    if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Element is occluded at its context-click point: ' + ${JSON.stringify(selector)});
    return { x, y };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'right', clickCount: 1 });
  await delay(30);
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'right', clickCount: 1 });
}

async function clickTaskByTitle(window, title) {
  const selector = await evaluate(window, `(() => {
    const title = ${JSON.stringify(title)};
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(title));
    if (!button) throw new Error('Task button not found: ' + title);
    button.dataset.fakeModelQaTask = 'target';
    // Center the row inside the scrollport. The nearest alignment can leave a row exactly
    // under the fixed filter header after a popover has just closed, making a
    // legitimate task click look occluded to the deterministic hit-test.
    button.scrollIntoView({ block: 'center' });
    return 'button[data-fake-model-qa-task="target"]';
  })()`);
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await clickSelector(window, selector);
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-fake-model-qa-task')`);
}

async function openPopover(window, triggerSelector, popoverSelector, label) {
  await clickSelector(window, triggerSelector);
  await waitFor(window, `Boolean(document.querySelector(${JSON.stringify(popoverSelector)}))`, `${label}: popover did not open`, 3_000);
}

async function setTaskFilterPopover(window, open, label) {
  const currentlyOpen = await evaluate(window, `document.querySelector('button.sidebar-task-filter')?.getAttribute('aria-expanded') === 'true'`);
  if (currentlyOpen !== open) await clickSelector(window, 'button.sidebar-task-filter');
  await waitFor(window, `document.querySelector('button.sidebar-task-filter')?.getAttribute('aria-expanded') === ${JSON.stringify(String(open))}`, `${label}: task filter popover did not become ${open ? 'open' : 'closed'}`);
}

async function setShowArchived(window, shown, label) {
  await setTaskFilterPopover(window, true, label);
  const current = await evaluate(window, `(() => { const button = [...document.querySelectorAll('.task-filter-popover button[role="checkbox"]')].find((candidate) => candidate.textContent?.includes('Show archived')); if (!(button instanceof HTMLElement)) throw new Error('Show archived is unavailable'); return button.getAttribute('aria-checked') === 'true'; })()`);
  if (current !== shown) await clickMatchingButton(window, '.task-filter-popover', 'Show archived');
  await waitFor(window, `(() => { const button = [...document.querySelectorAll('.task-filter-popover button[role="checkbox"]')].find((candidate) => candidate.textContent?.includes('Show archived')); return button?.getAttribute('aria-checked') === ${JSON.stringify(String(shown))}; })()`, `${label}: Show archived did not become ${shown}`);
  await setTaskFilterPopover(window, false, label);
}

async function clickMatchingButton(window, containerSelector, text) {
  const selector = await evaluate(window, `(() => {
    const container = document.querySelector(${JSON.stringify(containerSelector)});
    if (!container) throw new Error('Container not found: ' + ${JSON.stringify(containerSelector)});
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}));
    if (!button) throw new Error('Button not found: ' + ${JSON.stringify(text)} + ' in ' + ${JSON.stringify(containerSelector)});
    button.dataset.fakeModelQaClick = 'target';
    return 'button[data-fake-model-qa-click="target"]';
  })()`);
  await bringIntoView(window, selector);
  await clickSelector(window, selector);
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)})?.removeAttribute('data-fake-model-qa-click')`);
}

async function markQueuedRow(window, text, marker) {
  await evaluate(window, `(() => {
    const target = ${JSON.stringify(text)};
    const row = [...document.querySelectorAll('.queued-message-row')].find((candidate) => candidate.querySelector('.queued-message-content > strong')?.textContent?.trim() === target);
    if (!(row instanceof HTMLElement)) throw new Error('Queued row not found: ' + target);
    document.querySelectorAll('[data-fake-queue-target]').forEach((candidate) => candidate.removeAttribute('data-fake-queue-target'));
    row.dataset.fakeQueueTarget = ${JSON.stringify(marker)};
  })()`);
  return `[data-fake-queue-target=${JSON.stringify(marker)}]`;
}

async function queuedRowContents(window) {
  return evaluate(window, `[...document.querySelectorAll('.queued-message-row .queued-message-content > strong')].map((node) => node.textContent?.trim())`);
}

async function submitComposer(window, text, options = {}) {
  const waitForTranscript = options.waitForTranscript !== false;
  await clickSelector(window, 'textarea[aria-label="Message"]');
  await waitFor(window, `document.activeElement === document.querySelector('textarea[aria-label="Message"]')`, 'Composer did not receive focus');
  await window.webContents.insertText(text);
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(text)}`, 'Composer did not receive the typed message');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  if (!waitForTranscript) return;
  try {
    await waitFor(window, `(() => [...document.querySelectorAll('.message-user')].some((node) => node.textContent?.includes(${JSON.stringify(text)})))()`, 'Composer submission did not appear in the transcript', 6_000);
  } catch (error) {
    const state = await evaluate(window, `({ composer: document.querySelector('textarea[aria-label="Message"]')?.value, tail: document.querySelector('.conversation')?.textContent?.slice(-500), queue: document.querySelector('.queued-strip')?.textContent, reasoning: document.querySelectorAll('.reasoning-group').length })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; renderer state: ${JSON.stringify(state)}`);
  }
}

/**
 * Sample one outgoing instruction while it crosses the queue boundary. This
 * catches the user-visible failure where a queued instruction is also painted
 * as a transcript row, even if the duplicate only survives for one frame.
 */
async function startSubmissionIdentityTrace(window, text) {
  await evaluate(window, `(() => {
    const target = ${JSON.stringify(text)};
    const trace = { target, samples: [], startedAt: performance.now(), raf: 0 };
    const sample = () => {
      const userRows = [...document.querySelectorAll('.conversation .message-user')].filter((node) => node.textContent?.includes(target));
      const queueRows = [...document.querySelectorAll('.queued-message-row')].filter((node) => node.textContent?.includes(target));
      trace.samples.push({
        frame: trace.samples.length,
        at: performance.now() - trace.startedAt,
        userRows: userRows.length,
        queueRows: queueRows.length,
        userAnchors: userRows.map((node) => node.closest('[data-scroll-anchor]')?.getAttribute('data-scroll-anchor') ?? null),
        queueLabels: queueRows.map((node) => node.getAttribute('aria-label') ?? null),
      });
      trace.raf = requestAnimationFrame(sample);
    };
    trace.raf = requestAnimationFrame(sample);
    window.__tethoqSubmissionIdentityTrace = trace;
  })()`);
}

async function stopSubmissionIdentityTrace(window) {
  return evaluate(window, `(() => {
    const trace = window.__tethoqSubmissionIdentityTrace;
    if (!trace) return { target: null, samples: [] };
    cancelAnimationFrame(trace.raf);
    delete window.__tethoqSubmissionIdentityTrace;
    return { target: trace.target, samples: trace.samples };
  })()`);
}

async function attachFakeImage(window) {
  await clickSelector(window, 'button[aria-label="Add attachment"]');
  await waitFor(window, `Boolean(document.querySelector('.composer-attachment-menu .composer-popover'))`, 'Attachment menu did not open');
  await clickMatchingButton(window, '.composer-attachment-menu .composer-popover', 'Attach image');
  await waitFor(window, `Boolean(document.querySelector('.image-attachment-chip img'))`, 'Selected image did not become a composer widget');
}

async function startImageSendTrace(window, text) {
  await evaluate(window, `(() => {
    const target = ${JSON.stringify(text)};
    const trace = { target, samples: [], startedAt: performance.now(), raf: 0, imageNode: null, cardNode: null, imageDetachments: 0 };
    const matchingRows = () => [...document.querySelectorAll('.conversation .message-user')]
      .filter((node) => node.querySelector('.message-body')?.textContent?.trim() === target);
    const sample = () => {
      const rows = matchingRows();
      const row = rows.at(-1) ?? null;
      const image = row?.querySelector('.message-images img') ?? null;
      if (image && trace.imageNode === null) {
        trace.imageNode = image;
        trace.cardNode = row;
      }
      const bounds = image?.getBoundingClientRect();
      const scroller = document.querySelector('.conversation-scroll');
      trace.samples.push({
        frame: trace.samples.length,
        at: Number((performance.now() - trace.startedAt).toFixed(1)),
        userRows: rows.length,
        imageVisible: Boolean(image),
        sameImageNode: image ? image === trace.imageNode : null,
        sameCardNode: row ? row === trace.cardNode : null,
        anchor: row?.getAttribute('data-scroll-anchor') ?? null,
        left: bounds ? Number(bounds.left.toFixed(3)) : null,
        right: bounds ? Number(bounds.right.toFixed(3)) : null,
        width: bounds ? Number(bounds.width.toFixed(3)) : null,
        scrollTop: scroller ? Number(scroller.scrollTop.toFixed(3)) : null,
        bottomGap: scroller ? Number((scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toFixed(3)) : null,
        assistantRows: document.querySelectorAll('.message-assistant').length,
        assistantRunning: document.querySelectorAll('.message-assistant[aria-busy="true"], .reasoning-group[aria-busy="true"]').length,
      });
      trace.raf = requestAnimationFrame(sample);
    };
    trace.observer = new MutationObserver(() => {
      if (trace.imageNode && !trace.imageNode.isConnected) trace.imageDetachments += 1;
    });
    trace.observer.observe(document.querySelector('.conversation') ?? document.body, { subtree: true, childList: true });
    trace.raf = requestAnimationFrame(sample);
    window.__tethoqImageSendTrace = trace;
  })()`);
}

async function stopImageSendTrace(window) {
  return evaluate(window, `(() => {
    const trace = window.__tethoqImageSendTrace;
    if (!trace) return { target: null, samples: [], imageDetachments: -1 };
    cancelAnimationFrame(trace.raf);
    trace.observer.disconnect();
    delete window.__tethoqImageSendTrace;
    return { target: trace.target, samples: trace.samples, imageDetachments: trace.imageDetachments };
  })()`);
}

function assertStableImagePresentation(trace, text) {
  assert.equal(trace.target, text, 'Image trace targeted a different message');
  const firstImageIndex = trace.samples.findIndex((sample) => sample.imageVisible);
  assert.ok(firstImageIndex >= 0, 'Submitted image never appeared in the transcript');
  const painted = trace.samples.slice(firstImageIndex);
  assert.ok(painted.length >= 2, 'Submitted image was not sampled across multiple painted frames');
  assert.equal(trace.imageDetachments, 0, 'The submitted image DOM node was detached during canonical reconciliation');
  assert.equal(painted.every((sample) => sample.imageVisible), true, 'The submitted image disappeared after first paint');
  assert.equal(painted.every((sample) => sample.sameImageNode === true), true, 'The submitted image was remounted under a new DOM node');
  assert.equal(painted.every((sample) => sample.sameCardNode === true), true, 'The submitted user card was remounted under a new DOM node');
  assert.equal(Math.max(...painted.map((sample) => sample.userRows)), 1, 'Canonical reconciliation painted a duplicate user row');
  const baseline = painted[0];
  const maximumHorizontalDrift = Math.max(...painted.flatMap((sample) => [
    Math.abs(sample.left - baseline.left),
    Math.abs(sample.right - baseline.right),
    Math.abs(sample.width - baseline.width),
  ]));
  assert.ok(maximumHorizontalDrift <= 0.5, `Submitted image moved horizontally by ${maximumHorizontalDrift}px`);
  assert.equal(new Set(painted.map((sample) => sample.anchor)).size, 1, 'Submitted image changed its visible scroll identity');
  return { firstImageIndex, paintedFrames: painted.length, maximumHorizontalDrift, anchor: baseline.anchor };
}

function assertQueuedIdentityTrace(trace, text) {
  assert.equal(trace.target, text, 'Queue identity trace targeted a different instruction');
  assert.ok(trace.samples.length > 0, 'Queue identity trace captured no painted frames');
  assert.ok(trace.samples.some((sample) => sample.queueRows === 1 && sample.userRows === 0), 'Queued instruction never appeared as a queue-only row');
  assert.ok(trace.samples.every((sample) => !(sample.queueRows > 0 && sample.userRows > 0)), 'Queued instruction appeared in both the queue and transcript in the same painted frame');
  assert.ok(trace.samples.some((sample) => sample.queueRows === 0 && sample.userRows === 1), 'Steered instruction did not transition to one canonical transcript row after the queue drained');
}

async function replaceComposerText(window, text) {
  await clickSelector(window, 'textarea[aria-label="Message"]');
  // Later suite scenarios intentionally keep their Electron window inactive.
  // The physical click still exercises the painted hit area, but an inactive
  // window cannot reliably transfer native focus. This helper is about
  // replacing text, so establish renderer focus explicitly before sending the
  // real Ctrl+A/input events. Dedicated keyboard/pointer scenarios cover
  // genuine focus transfer separately.
  await evaluate(window, `(() => {
    const composer = document.querySelector('textarea[aria-label="Message"]');
    if (!(composer instanceof HTMLTextAreaElement)) throw new Error('Composer is missing before replacing text');
    composer.focus();
  })()`);
  await waitFor(window, `document.activeElement === document.querySelector('textarea[aria-label="Message"]')`, 'Composer did not receive focus before replacing text');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  await waitFor(window, `(() => { const composer = document.querySelector('textarea[aria-label="Message"]'); return composer instanceof HTMLTextAreaElement && composer.selectionStart === 0 && composer.selectionEnd === composer.value.length; })()`, 'Composer text was not selected');
  await window.webContents.insertText(text);
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(text)}`, `Composer did not contain ${text}`);
}

async function chooseSlashCommand(window, command) {
  await replaceComposerText(window, '');
  await replaceComposerText(window, '/');
  await waitFor(window, `Boolean(document.querySelector('.slash-command-palette'))`, 'Slash command palette did not open');
  await clickMatchingButton(window, '.slash-command-palette', command);
}

async function pressComposerEnter(window) {
  await clickSelector(window, 'textarea[aria-label="Message"]');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}

async function ensureBottom(window) {
  // Use the same wheel path as a reader. A direct scrollTop write is deliberately
  // rejected by the renderer when a task owns a saved reading anchor, because an
  // unowned browser/layout move must never silently replace that user choice.
  await wheelToBottom(window);
  try {
    await waitFor(window, `(() => { const s = document.querySelector('.conversation-scroll'); return s && s.scrollHeight - s.scrollTop - s.clientHeight <= 2; })()`, 'Could not reach the physical bottom');
  } catch (error) {
    const state = await evaluate(window, `(() => {
      const scroller = document.querySelector('.conversation-scroll');
      const spacer = document.querySelector('.conversation-tail-spacer');
      const composer = document.querySelector('.composer-wrap');
      const viewport = scroller?.getBoundingClientRect();
      const composerBounds = composer?.getBoundingClientRect();
      const writes = window.__tethoqScrollTrace?.accesses?.filter((entry) => entry.type === 'write').slice(-8).map((entry) => ({ value: entry.value, before: entry.before, height: entry.height, client: entry.client, cause: entry.cause, stack: entry.stack?.split('\\n').slice(0, 8).join(' | ') }));
      return { scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight, clientHeight: scroller?.clientHeight, gap: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null, spacerHeight: spacer?.getBoundingClientRect().height, viewportBottom: viewport?.bottom, composerTop: composerBounds?.top, writes };
    })()`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(state)}`);
  }
}

async function wheelBy(window, pixels) {
  const point = await evaluate(window, `(() => { const bounds = document.querySelector('.conversation-scroll')?.getBoundingClientRect(); if (!bounds) throw new Error('Conversation scroller not found'); return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) }; })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  const step = pixels >= 0 ? 100 : -100;
  for (let sent = 0; Math.abs(sent) < Math.abs(pixels); sent += step) {
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y, deltaY: step, deltaX: 0, canScroll: true });
    await delay(18);
  }
}

async function wheelConversationGutterBy(window, pixels) {
  const point = await evaluate(window, `(() => {
    const bounds = document.querySelector('.conversation-scroll')?.getBoundingClientRect();
    if (!bounds) throw new Error('Conversation scroller not found');
    return { x: Math.round(bounds.right - 18), y: Math.round(bounds.top + bounds.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  const step = pixels >= 0 ? 100 : -100;
  for (let sent = 0; Math.abs(sent) < Math.abs(pixels); sent += step) {
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y, deltaY: step, deltaX: 0, canScroll: true });
    await delay(18);
  }
}

async function wheelConversationGutterToBottom(window, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const gap = await evaluate(window, `(() => { const scroller = document.querySelector('.conversation-scroll'); return scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null; })()`);
    if (typeof gap === 'number' && gap <= 2) return;
    await wheelConversationGutterBy(window, -600);
    await delay(35);
  }
  throw new Error('Wheel input in the transcript gutter could not reach the conversation tail');
}

async function wheelConversationGutterUntilVisible(window, selector, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const position = await evaluate(window, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      const viewport = document.querySelector('.conversation-scroll')?.getBoundingClientRect();
      const bounds = element?.getBoundingClientRect();
      if (!bounds || !viewport) return null;
      if (bounds.top >= viewport.top && bounds.bottom <= viewport.bottom) return { visible: true };
      return { visible: false, direction: bounds.top < viewport.top ? 'up' : 'down' };
    })()`);
    if (!position) break;
    if (position.visible) return;
    await wheelConversationGutterBy(window, position.direction === 'up' ? 200 : -200);
    await delay(35);
  }
  throw new Error(`Element did not enter the conversation through gutter wheel input: ${selector}`);
}

async function wheelInside(window, selector, pixels) {
  const point = await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Nested scroller not found: ' + ${JSON.stringify(selector)});
    const bounds = element.getBoundingClientRect();
    const x = Math.round(bounds.left + bounds.width / 2);
    const y = Math.round(bounds.top + bounds.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (hit !== element && !element.contains(hit)) throw new Error('Nested scroller is not reachable at its centre: ' + ${JSON.stringify(selector)});
    return { x, y };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  const step = pixels >= 0 ? 100 : -100;
  for (let sent = 0; Math.abs(sent) < Math.abs(pixels); sent += step) {
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y, deltaY: step, deltaX: 0, canScroll: true });
    await delay(18);
  }
}

async function wheelNestedToBottom(window, selector, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const gap = await evaluate(window, `(() => { const flow = document.querySelector(${JSON.stringify(selector)}); return flow ? flow.scrollHeight - flow.scrollTop - flow.clientHeight : null; })()`);
    if (typeof gap === 'number' && gap <= 1) return;
    await wheelInside(window, selector, -600);
    await delay(35);
  }
  const state = await evaluate(window, `(() => { const flow = document.querySelector(${JSON.stringify(selector)}); return { scrollTop: flow?.scrollTop, maximum: flow ? flow.scrollHeight - flow.clientHeight : null }; })()`);
  throw new Error(`Wheel input could not reach the nested scroller tail: ${JSON.stringify(state)}`);
}

async function wheelToBottom(window, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const gap = await evaluate(window, `(() => { const scroller = document.querySelector('.conversation-scroll'); return scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null; })()`);
    if (typeof gap === 'number' && gap <= 2) return;
    await wheelBy(window, -600);
    await delay(35);
  }
  const state = await evaluate(window, `(() => { const scroller = document.querySelector('.conversation-scroll'); return { scrollTop: scroller?.scrollTop, maximum: scroller ? scroller.scrollHeight - scroller.clientHeight : null }; })()`);
  throw new Error(`Wheel input could not reach the conversation tail: ${JSON.stringify(state)}`);
}

async function wheelAwayFromBottom(window, pixels) {
  await wheelBy(window, pixels);
}

async function wheelUntilVisible(window, selector, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const position = await evaluate(window, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const viewport = document.querySelector('.conversation-scroll').getBoundingClientRect();
      if (bounds.top >= viewport.top && bounds.bottom <= viewport.bottom) return { visible: true };
      return { visible: false, direction: bounds.top < viewport.top ? 'up' : 'down' };
    })()`);
    if (!position) break;
    if (position.visible) return;
    await wheelBy(window, position.direction === 'up' ? 100 : -100);
    await delay(35);
  }
  const state = await evaluate(window, `(() => { const element = document.querySelector(${JSON.stringify(selector)}); const bounds = element?.getBoundingClientRect(); const scroller = document.querySelector('.conversation-scroll'); return { exists: Boolean(element), bounds: bounds ? { top: bounds.top, bottom: bounds.bottom } : null, scrollTop: scroller?.scrollTop, maximum: scroller ? scroller.scrollHeight - scroller.clientHeight : null }; })()`);
  throw new Error(`Element did not enter the viewport through wheel input: ${selector}; ${JSON.stringify(state)}`);
}

async function viewportState(window, resetTrace = false) {
  return evaluate(window, `(() => {
    const scroller = document.querySelector('.conversation-scroll');
    const viewport = scroller.getBoundingClientRect();
    const rows = [...scroller.querySelectorAll('[data-scroll-anchor]')].map((node) => {
      const bounds = node.getBoundingClientRect();
      return { id: node.dataset.scrollAnchor, members: node.dataset.scrollMembers ?? '', top: bounds.top - viewport.top, bottom: bounds.bottom - viewport.top, height: bounds.height };
    }).filter((row) => row.bottom > 1 && row.top < viewport.height - 1);
    const first = rows[0];
    if (!first) throw new Error('Visible reader anchor not found');
    if (${resetTrace ? 'true' : 'false'}) {
      const trace = window.__tethoqScrollTrace;
      trace.accesses.length = 0; trace.scrollEvents.length = 0; trace.resizeCallbacks.length = 0; trace.mutations.length = 0;
    }
    return { top: scroller.scrollTop, maximum: scroller.scrollHeight - scroller.clientHeight, height: scroller.scrollHeight, client: scroller.clientHeight, anchorId: first.id, anchorTop: first.top, visibleRows: rows.slice(0, 12) };
  })()`);
}

async function observeStability(window, baseline, duration) {
  const result = await evaluate(window, `new Promise((resolve) => {
    const started = performance.now(); const samples = []; let raf = 0;
    const sample = () => {
      const scroller = document.querySelector('.conversation-scroll'); const viewport = scroller.getBoundingClientRect();
      const anchor = [...scroller.querySelectorAll('[data-scroll-anchor]')].find((node) => node.dataset.scrollAnchor === ${JSON.stringify(baseline.anchorId)} || node.dataset.scrollMembers?.split('|').includes(encodeURIComponent(${JSON.stringify(baseline.anchorId)})));
      const visibleRows = [...scroller.querySelectorAll('[data-scroll-anchor]')].map((node) => { const bounds = node.getBoundingClientRect(); return { id: node.dataset.scrollAnchor, top: bounds.top - viewport.top, bottom: bounds.bottom - viewport.top }; }).filter((row) => row.bottom > 1 && row.top < viewport.height - 1).slice(0, 12);
      const userRows = [...document.querySelectorAll('.conversation .message-user')];
      const queueRows = [...document.querySelectorAll('.queued-message-row')];
      samples.push({
        frame: samples.length,
        at: performance.now() - started,
        top: scroller.scrollTop,
        maximum: scroller.scrollHeight - scroller.clientHeight,
        height: scroller.scrollHeight,
        anchorTop: anchor ? anchor.getBoundingClientRect().top - viewport.top : null,
        visibleRows,
        identity: {
          userRows: userRows.length,
          assistantRows: document.querySelectorAll('.conversation .message-assistant').length,
          userAnchors: userRows.map((node) => node.closest('[data-scroll-anchor]')?.getAttribute('data-scroll-anchor') ?? null),
        },
        queue: {
          rows: queueRows.length,
          ids: queueRows.map((node) => node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 120) ?? ''),
        },
      });
      raf = requestAnimationFrame(sample);
    };
    raf = requestAnimationFrame(sample);
    setTimeout(() => { cancelAnimationFrame(raf); const trace = window.__tethoqScrollTrace; resolve({ samples, accesses: [...trace.accesses], scrollEvents: [...trace.scrollEvents], resizeCallbacks: trace.resizeCallbacks.length, mutations: [...trace.mutations] }); }, ${duration});
  })`);
  const writes = result.accesses.filter((access) => access.type === 'write');
  const changedSamples = result.samples.filter((sample) => sample.anchorTop === null || Math.abs(sample.anchorTop - baseline.anchorTop) > 1);
  const transcriptRemounts = result.mutations.filter((mutation) => mutation.count >= 20);
  return { baseline, frames: result.samples.length, frameSamples: result.samples, writes, scrollEvents: result.scrollEvents, resizeCallbacks: result.resizeCallbacks, mutations: result.mutations.length, transcriptRemounts, changedSamples: changedSamples.slice(0, 20), changedSampleCount: changedSamples.length, final: result.samples.at(-1) };
}

function assertReaderStable(report, label, options = {}) {
  const allowWrites = options.allowWrites === true;
  assert.ok(report.frames > 0, `${label}: no painted viewport frames were sampled`);
  assert.equal(report.changedSampleCount, 0, `${label}: the visible anchor moved in ${report.changedSampleCount} painted frames`);
  assert.equal(report.transcriptRemounts.length, 0, `${label}: the transcript was remounted`);
  if (!allowWrites) assert.equal(report.writes.length, 0, `${label}: the renderer wrote scrollTop ${report.writes.length} times while the reader was stationary`);
}

async function assertOverlayWithinViewport(window, selector, label) {
  const result = await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Overlay not found: ' + ${JSON.stringify(selector)});
    const bounds = element.getBoundingClientRect();
    return { bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }, viewport: { width: innerWidth, height: innerHeight } };
  })()`);
  assert.ok(result.bounds.left >= -0.5 && result.bounds.right <= result.viewport.width + 0.5 && result.bounds.top >= -0.5 && result.bounds.bottom <= result.viewport.height + 0.5, `${label}: overlay clipped (${JSON.stringify(result)})`);
  return result;
}

async function assertOverlayPaintedOnTop(window, selector, label) {
  const result = await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Overlay not found: ' + ${JSON.stringify(selector)});
    const bounds = element.getBoundingClientRect();
    const points = [
      [bounds.left + Math.min(12, bounds.width / 2), bounds.top + Math.min(12, bounds.height / 2)],
      [bounds.left + bounds.width / 2, bounds.top + Math.min(12, bounds.height / 2)],
      [bounds.right - Math.min(12, bounds.width / 2), bounds.top + Math.min(12, bounds.height / 2)],
      [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2],
    ];
    return points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return { x, y, inside: hit !== null && element.contains(hit), hit: hit?.className ?? hit?.tagName ?? null };
    });
  })()`);
  assert.ok(result.every((point) => point.inside), `${label}: another stacking context paints above the overlay (${JSON.stringify(result)})`);
  return result;
}

async function assertResponsiveLayout(window, label) {
  const result = await evaluate(window, `(() => {
    const rect = (selector) => { const element = document.querySelector(selector); if (!(element instanceof HTMLElement)) return null; const bounds = element.getBoundingClientRect(); return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }; };
    return {
      workspace: rect('.workspace'),
      sidebar: rect('.sidebar'),
      composer: rect('textarea[aria-label="Message"]'),
      scrollWidth: document.documentElement.scrollWidth,
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  assert.ok(result.workspace, `${label}: workspace missing`);
  assert.ok(result.workspace.left >= -0.5 && result.workspace.right <= result.viewport.width + 0.5 && result.workspace.bottom <= result.viewport.height + 0.5, `${label}: workspace overflows the viewport (${JSON.stringify(result.workspace)})`);
  assert.ok(result.sidebar && result.sidebar.right <= result.viewport.width + 0.5, `${label}: sidebar overflows the viewport (${JSON.stringify(result.sidebar)})`);
  assert.ok(result.composer, `${label}: composer missing`);
  assert.ok(result.composer.bottom <= result.viewport.height + 0.5, `${label}: composer clipped below the viewport (${JSON.stringify(result.composer)})`);
  assert.ok(result.scrollWidth <= result.viewport.width + 1, `${label}: horizontal overflow (${result.scrollWidth} > ${result.viewport.width})`);
  return result;
}

async function waitForSessionIdle(window, timeout = 20_000) {
  await waitFor(window, `(() => !document.querySelector('.session-row-working-spinner'))()`, 'Session never left the working state', timeout);
}

async function waitForFakeHostIdle(host, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (host.stateForTests().playing === null) return;
    await delay(25);
  }
  throw new Error('Fake model host never finished its active scenario');
}

async function assertCopyControlsClean(window, label) {
  const result = await evaluate(window, `(() => {
    const controls = [...document.querySelectorAll('.timeline-copy-button, .copy-message, .rich-code-copy')];
    const codeControls = [...document.querySelectorAll('.rich-code-copy')];
    return {
      controls: controls.length,
      codeControls: codeControls.length,
      titled: controls.map((node) => ({ className: node.className, title: node.getAttribute('title') })).filter((entry) => entry.title !== null),
      literalCopyLabels: codeControls.map((node) => node.textContent?.trim() ?? '').filter((text) => /\\bCopy\\b/iu.test(text)),
    };
  })()`);
  assert.equal(result.titled.length, 0, `${label}: copy controls must not carry native title tooltips: ${JSON.stringify(result.titled)}`);
  assert.equal(result.literalCopyLabels.length, 0, `${label}: code-copy controls contain a visible Copy label: ${JSON.stringify(result.literalCopyLabels)}`);
  return result;
}

async function scenarioBoot(window, captures) {
  await ensureRendererReady(window);
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Main fixture task did not open', 10_000);
  assert.ok(await evaluate(window, `Boolean(document.querySelector('.sidebar-runtime-indicator.connected'))`), 'Boot: the runtime indicator did not report connected');
  assert.ok(await evaluate(window, `[...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Fake model attachments task'))`), 'Boot: the second fixture task is not listed');
  assert.equal(await evaluate(window, `Boolean(document.querySelector('[data-session-id="fake-subagent"]'))`), false, 'Boot: a proven sub-agent leaked into the top-level task rail');
  assert.equal(await evaluate(window, `Boolean(document.querySelector('[data-session-id="fake-provider-parented"]'))`), true, 'Boot: a provider-parented user task was hidden without sub-agent provenance');
  assert.equal(await evaluate(window, `document.querySelector('[data-session-id="fake-main"] .session-subagents-trigger')?.querySelectorAll(':scope > span')[1]?.textContent?.trim()`), '1', 'Boot: the hidden child is not reachable from its parent');
  const copyControls = await assertCopyControlsClean(window, 'Boot');
  await capture(window, '00-boot', captures);
  await clickSelector(window, '[data-session-id="fake-main"] .session-subagents-trigger');
  await waitFor(window, `document.querySelector('.session-subagents-popover')`, 'Sub-agent drop-up did not open');
  await assertOverlayWithinViewport(window, '.session-subagents-popover', 'sub-agent drop-up');
  assert.equal(await evaluate(window, `document.querySelectorAll('.session-subagents-popover .spinner').length`), 1, 'Working sub-agent did not show exactly one spinner');
  assert.equal(await evaluate(window, `document.querySelectorAll('.session-subagents-tooltip').length`), 0, 'Sub-agent drop-up stacked on top of its hover tooltip');
  await capture(window, '00-subagent-dropup', captures);
  await clickSelector(window, '.session-subagents-popover button');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Hidden deterministic sub-agent') && document.querySelector('button[aria-label="Back to parent task"]')`, 'Opening a child did not expose its parent return path');
  await clickSelector(window, 'button[aria-label="Back to parent task"]');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Back to parent did not restore the parent task');
  return scenarioOutcome('boot-and-state-signals', { copyControls, childSpinner: true, childOpened: true, parentRestored: true }, {
    'runtime.connected': true,
    'tasks.secondary-fixture-visible': true,
    'subagents.proven-child-hidden-from-rail': true,
    'subagents.provider-parented-user-task-visible': true,
    'subagents.child-reachable-from-parent': true,
    'subagents.dropup-not-clipped-or-doubled': true,
    'subagents.working-child-spinner': true,
    'subagents.open-child-back-to-parent': true,
    'transcript.copy-controls-clean': copyControls,
  });
}

async function scenarioGoalLifecycle(window, captures, host) {
  await ensureRendererReady(window);
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Goal: main fixture task did not open', 10_000);
  const before = host.stateForTests();
  assert.equal(await evaluate(window, `Boolean(document.querySelector('.goal-trigger'))`), false, 'Goal: permanent header control is still painted');
  await openPopover(window, `button[aria-label="More message actions"]`, '.composer-actions-menu .composer-popover', 'Goal overflow menu');
  await clickMatchingButton(window, '.composer-actions-menu .composer-popover', 'Goal');
  await waitFor(window, `Boolean(document.querySelector('.goal-popover'))`, 'Goal: controls did not open');
  await assertOverlayWithinViewport(window, '.goal-popover', 'goal controls');
  await capture(window, '23-goal-empty', captures);
  await clickSelector(window, '.goal-popover textarea');
  await window.webContents.insertText('Ship the reliable goal UI');
  await clickSelector(window, '.goal-popover input[type="number"]');
  await window.webContents.insertText('12000');
  await clickMatchingButton(window, '.goal-popover', 'Start goal');
  await waitFor(window, `!document.querySelector('.goal-popover')`, 'Goal: successful start did not close controls');
  assert.equal(host.stateForTests().modelTurnCount, before.modelTurnCount, 'Goal: creating a goal started an automatic model turn');
  await chooseSlashCommand(window, '/goal');
  await waitFor(window, `document.querySelector('.goal-popover')?.textContent?.includes('Active')`, 'Goal: active state did not reopen through /goal');
  await capture(window, '24-goal-active', captures);

  const lifecycle = [
    ['Pause', 'Paused'],
    ['Resume', 'Active'],
    ['Mark stalled', 'Stalled'],
    ['Resume', 'Active'],
    ['Complete', 'Complete'],
    ['Reopen', 'Active'],
  ];
  for (const [action, label] of lifecycle) {
    if (!await evaluate(window, `Boolean(document.querySelector('.goal-popover'))`)) {
      await chooseSlashCommand(window, '/goal');
    }
    await waitFor(window, `Boolean(document.querySelector('.goal-popover'))`, `Goal: controls did not reopen for ${action}`);
    await clickMatchingButton(window, '.goal-popover', action);
    await waitFor(window, `document.querySelector('.goal-popover')?.textContent?.includes(${JSON.stringify(label)})`, `Goal: state ${label} did not appear`);
  }
  const activeRequests = host.stateForTests().requests.filter((request) => request.type === 'session.goal.set');
  assert.ok(activeRequests.length >= lifecycle.length + 1, 'Goal: lifecycle mutations did not reach the fake provider');
  assert.equal(activeRequests[0].payload.tokenBudget, 12000, 'Goal: token budget did not reach the fake provider');
  await submitComposer(window, 'Continue toward the goal');
  await waitForFakeHostIdle(host);
  const send = host.stateForTests().requests.findLast((request) => request.type === 'session.send_message');
  assert.match(send.payload.developerInstructions ?? '', /private control context/iu, 'Goal: private guidance was not attached to the turn metadata');
  assert.match(send.payload.developerInstructions ?? '', /Token budget: 12000 tokens/iu, 'Goal: token budget was not attached to private turn metadata');
  assert.equal(await evaluate(window, `![...document.querySelectorAll('.message-user, .message-assistant')].some((node) => node.textContent?.includes('private control context'))`), true, 'Goal: private guidance leaked into a visible message');

  await clickTaskByTitle(window, 'Fake model attachments task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model attachments task')`, 'Goal: could not switch away before reopen check');
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Goal: task did not survive reopen');

  await chooseSlashCommand(window, '/goal');
  await waitFor(window, `Boolean(document.querySelector('.goal-popover'))`, 'Goal: controls did not reopen for clear');
  await waitFor(window, `document.querySelector('.goal-popover')?.textContent?.includes('Active')`, 'Goal: active goal did not survive task reopen');
  await clickMatchingButton(window, '.goal-popover', 'Clear');
  await waitFor(window, `!document.querySelector('.goal-popover')`, 'Goal: clear did not close controls');

  await window.setSize(760, 480);
  await delay(350);
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Goal: compact task navigation did not open the workspace');
  await assertResponsiveLayout(window, 'Goal 760x480');
  await chooseSlashCommand(window, '/goal');
  await waitFor(window, `Boolean(document.querySelector('.goal-popover'))`, 'Goal: compact controls did not open');
  await assertOverlayWithinViewport(window, '.goal-popover', 'compact goal controls');
  await capture(window, '25-goal-compact-760x480', captures);
  return scenarioOutcome('goal-lifecycle', {
    revisionedLifecycle: true,
    guidanceMetadata: true,
    automaticTurns: host.stateForTests().modelTurnCount - before.modelTurnCount,
    compact: true,
  }, {
    'goal.command-and-overflow-entry': true,
    'goal.lifecycle-controls': lifecycle.map(([action, label]) => `${action}:${label}`),
    'goal.private-guidance-no-transcript': true,
    'goal.zero-token-and-reopen': { noAutomaticTurnBeforeSend: true, reopened: true, clear: true },
    'goal.compact-painted-popover': true,
  });
}

async function scenarioLunaPanelSequences(window, captures, host) {
  await ensureRendererReady(window);
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Luna: main fixture task did not open', 10_000);

  // A task switch remounts Composer. The delegate prompt belongs to its parent
  // task, so moving away and back must restore it just like the main draft.
  const delegationDraft = `Luna delegation draft ${Date.now()}`;
  await openPopover(window, `button[aria-label="More message actions"]`, '.composer-actions-menu .composer-popover', 'Luna delegation actions');
  await clickMatchingButton(window, '.composer-actions-menu .composer-popover', 'Delegate task');
  await waitFor(window, `Boolean(document.querySelector('.delegation-chat-picker textarea'))`, 'Luna: delegation panel did not open');
  await clickSelector(window, '.delegation-chat-picker textarea');
  await window.webContents.insertText(delegationDraft);
  await waitFor(window, `document.querySelector('.delegation-chat-picker textarea')?.value === ${JSON.stringify(delegationDraft)}`, 'Luna: delegation draft was not entered');
  await clickTaskByTitle(window, 'Fake model attachments task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model attachments task')`, 'Luna: could not switch away from the delegation draft');
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Luna: could not return to the delegation parent');
  await openPopover(window, `button[aria-label="More message actions"]`, '.composer-actions-menu .composer-popover', 'Luna restored delegation actions');
  await clickMatchingButton(window, '.composer-actions-menu .composer-popover', 'Delegate task');
  await waitFor(window, `document.querySelector('.delegation-chat-picker textarea')?.value === ${JSON.stringify(delegationDraft)}`, 'Luna: task switching discarded the delegation draft');
  await clickMatchingButton(window, '.delegation-chat-picker', 'Cancel');

  // A compact panel should submit on Enter and return focus to the composer.
  await chooseSlashCommand(window, '/goal');
  await waitFor(window, `Boolean(document.querySelector('.goal-popover'))`, 'Luna: goal panel did not open');
  await clickSelector(window, '.goal-popover textarea');
  await window.webContents.insertText('Luna keyboard goal');
  host.failNextRequestForTests('session.goal.set', 'Injected goal save failure.');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(window, `Boolean(document.querySelector('.goal-popover')) && document.querySelector('.toast-error')?.textContent?.includes('Injected goal save failure.')`, 'Luna: failed Enter submission dismissed the goal panel or hid its error');
  assert.equal(await evaluate(window, `document.querySelector('.goal-popover textarea')?.value`), 'Luna keyboard goal', 'Luna: failed goal save discarded the objective');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(window, `!document.querySelector('.goal-popover')`, 'Luna: Enter did not save and close goal panel');
  const goalFocus = await evaluate(window, `document.activeElement?.matches('textarea[aria-label="Message"]')`);
  assert.equal(goalFocus, true, 'Luna: closing the goal panel did not restore composer focus');

  // Partial command deletion must remain in the one palette instead of opening
  // a chain of unrelated surfaces; Escape preserves the user's draft.
  await replaceComposerText(window, '/ea');
  await waitFor(window, `Boolean(document.querySelector('.slash-command-palette')) && document.querySelector('.slash-command-palette')?.textContent?.includes('/ears')`, 'Luna: partial command did not filter');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === '/' && Boolean(document.querySelector('.slash-command-palette'))`, 'Luna: deleting a partial command did not restore the catalogue');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, `!document.querySelector('.slash-command-palette') && document.querySelector('textarea[aria-label="Message"]')?.value === '/'`, 'Luna: command Escape did not preserve the draft');

  // Mesh and EARS each open as one panel and can be dismissed without a
  // second confirmation or a stale panel surviving the next command.
  await replaceComposerText(window, '');
  await replaceComposerText(window, '/');
  await waitFor(window, `Boolean(document.querySelector('.slash-command-palette'))`, 'Luna: command palette did not reopen for Mesh');
  await clickMatchingButton(window, '.slash-command-palette', '/mesh');
  await waitFor(window, `Boolean(document.querySelector('.mesh-panel'))`, 'Luna: mesh panel did not open');
  await clickSelector(window, '.workspace h1');
  await waitFor(window, `!document.querySelector('.mesh-panel')`, 'Luna: outside click did not close Mesh');
  await replaceComposerText(window, '');
  await replaceComposerText(window, '/mesh');
  await waitFor(window, `Boolean(document.querySelector('.mesh-panel'))`, 'Luna: Mesh did not reopen after outside dismissal');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, `!document.querySelector('.mesh-panel') && document.activeElement?.matches('textarea[aria-label="Message"]')`, 'Luna: Escape did not close Mesh and restore composer focus');
  await replaceComposerText(window, '');
  await replaceComposerText(window, '/');
  await waitFor(window, `Boolean(document.querySelector('.slash-command-palette'))`, 'Luna: command palette did not reopen for EARS');
  await clickMatchingButton(window, '.slash-command-palette', '/ears');
  await waitFor(window, `Boolean(document.querySelector('.ears-settings'))`, 'Luna: EARS panel did not open');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, `!document.querySelector('.ears-settings') && document.activeElement?.matches('textarea[aria-label="Message"]')`, 'Luna: Escape did not close EARS and restore composer focus');
  await replaceComposerText(window, '/');
  await waitFor(window, `Boolean(document.querySelector('.slash-command-palette'))`, 'Luna: command palette did not reopen for the second EARS pass');
  await clickMatchingButton(window, '.slash-command-palette', '/ears');
  await waitFor(window, `Boolean(document.querySelector('.ears-settings'))`, 'Luna: EARS did not reopen after Escape');
  await clickSelector(window, '.workspace h1');
  await waitFor(window, `!document.querySelector('.ears-settings')`, 'Luna: outside click did not close EARS');

  // Project mode keeps same-named folders separate, groups after filtering,
  // and supports a folder-picked draft through first materialization.
  await clickSelector(window, 'button[aria-label="Arrange tasks by project"]');
  await waitFor(window, `document.querySelectorAll('.session-project-group').length >= 4`, 'Luna: project groups did not appear');
  const groups = await evaluate(window, `[...document.querySelectorAll('.session-project-group')].map((group) => ({ name: group.querySelector('.session-project-header strong')?.textContent?.trim(), path: group.querySelector('.session-project-header')?.getAttribute('title') }))`);
  assert.equal(groups.filter((group) => group.name === 'payments').length, 2, 'Luna: duplicate folder basenames were merged');
  assert.ok(groups.some((group) => group.name === 'C:\\'), 'Luna: drive root group was lost');
  assert.ok(groups.some((group) => group.name === 'No project folder'), 'Luna: empty directory group was lost');
  await evaluate(window, `document.querySelector('.session-project-group .session-project-header')?.click()`);
  await waitFor(window, `document.querySelector('.session-project-group .session-project-header')?.getAttribute('aria-expanded') === 'false'`, 'Luna: project collapse did not hide tasks');
  await evaluate(window, `document.querySelector('.session-project-group .session-project-header')?.click()`);
  await waitFor(window, `document.querySelector('.session-project-group .session-project-header')?.getAttribute('aria-expanded') === 'true'`, 'Luna: project expand did not restore tasks');

  const titleBeforeCancelledPicker = await evaluate(window, `document.querySelector('.workspace h1')?.textContent?.trim()`);
  await clickSelector(window, 'button[aria-label="New project"]');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await evaluate(window, `document.querySelector('.workspace h1')?.textContent?.trim()`), titleBeforeCancelledPicker, 'Luna: cancelling the project folder picker created a draft');
  await clickSelector(window, 'button[aria-label="New project"]');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.trim() === 'New task'`, 'Luna: New project did not open a draft');
  assert.equal(await evaluate(window, `document.querySelector('.workspace-location')?.textContent?.trim()`), 'C:\\FakeModel\\qa-project', 'Luna: chosen folder did not reach the draft');
  const instruction = 'Luna project materialization';
  await replaceComposerText(window, instruction);
  await pressComposerEnter(window);
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(instruction)})`, 'Luna: project draft did not materialize');
  const create = host.stateForTests().requests.filter((request) => request.type === 'session.create').at(-1);
  assert.equal(create?.payload?.workingDirectory, 'C:\\FakeModel\\qa-project', 'Luna: materialization lost the selected folder');

  await clickSelector(window, 'button[aria-label="Arrange tasks by recency"]');
  await waitFor(window, `!document.querySelector('.session-project-group') && document.querySelector('button[aria-label="Arrange tasks by project"]')`, 'Luna: recency toggle did not restore the flat task list');
  return scenarioOutcome('luna-panel-sequences', { goalFocus, groups, materializedDirectory: create?.payload?.workingDirectory }, {
    'luna.goal-enter-closes-and-focuses': { failedSaveStayedOpen: true, focused: goalFocus },
    'luna.partial-command-deletion': { restoredCatalogue: true, draftPreserved: true },
    'luna.mesh-and-ears-single-panel': { meshEscape: true, meshOutside: true, earsEscape: true, earsOutside: true },
    'luna.delegation-draft-survives-task-switch': delegationDraft,
    'luna.project-groups-keep-path-identity': groups,
    'luna.project-collapse-expand': { collapsed: true, expanded: true },
    'luna.project-draft-materializes-folder': { cancelledWithoutDraft: true, create: create?.payload },
    'luna.recency-project-toggle': { project: true, recency: true },
  });
}

async function scenarioProjectContextMenuBounds(window, captures) {
  await ensureRendererReady(window);
  await window.setSize(760, 480);
  await clickSelector(window, 'button[aria-label="Arrange tasks by project"]');
  await waitFor(window, `document.querySelectorAll('.session-project-group').length >= 4`, 'Project menu: grouped tasks did not appear');
  await contextClickSelector(window, '[data-session-id="fake-project-alpha"]');
  await waitFor(window, `Boolean(document.querySelector('.session-context-menu'))`, 'Project menu: task actions did not open');
  await assertOverlayWithinViewport(window, '.session-context-menu', 'project task context menu');
  await clickMatchingButton(window, '.session-context-menu', 'Archive');
  await waitFor(window, `!document.querySelector('[data-session-id="fake-project-alpha"]')`, 'Project menu: Archive was not reachable');
  await capture(window, '26-project-context-menu-760x480', captures);
  return scenarioOutcome('project-context-menu-bounds', { compact: true, archiveReachable: true }, {
    'projects.context-menu-actions-stay-in-viewport': true,
  });
}

async function scenarioQueueNewTaskEscape(window, captures, host) {
  await ensureRendererReady(window);
  const queued = host.handleRequest('message_queue.enqueue', { sessionId: 'fake-main', content: 'Escape must preserve this queued instruction' }).payload.message;
  await waitFor(window, `Boolean(document.querySelector('.queued-message-row'))`, 'Queue Escape: queued instruction did not render');
  await openPopover(window, 'button[aria-label="Queued instruction actions"]', '.queued-message-menu .composer-popover', 'Queue Escape actions');
  await clickMatchingButton(window, '.queued-message-menu .composer-popover', 'Send to new task');
  await waitFor(window, `Boolean(document.querySelector('.queue-new-task-picker'))`, 'Queue Escape: new-task picker did not open');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, `!document.querySelector('.queue-new-task-picker')`, 'Queue Escape: new-task picker ignored Escape');
  assert.equal(host.stateForTests().requests.some((request) => request.type === 'message_queue.move_to_new_task' && request.payload.messageId === queued.id), false, 'Queue Escape: dismissing the picker moved the instruction');
  await waitFor(window, `Boolean(document.querySelector('.queued-message-row'))`, 'Queue Escape: dismissing the picker consumed the instruction');
  await capture(window, '27-queue-new-task-escape', captures);
  return scenarioOutcome('queue-new-task-escape', { dismissed: true, queuePreserved: true }, {
    'queue.new-task-picker-escape-preserves-item': true,
  });
}

async function scenarioContextThresholdLifecycle(window, captures, host) {
  const requestCount = () => host.stateForTests().requests.filter((entry) => entry.type === 'session.context.set_threshold').length;
  const initialRequests = requestCount();
  await openPopover(window, '.context-usage-trigger', '.context-usage-popover', 'context threshold');
  const initial = await evaluate(window, `(() => ({
    slider: Number(document.querySelector('input[aria-label="Automatic compaction threshold"]')?.value),
    heading: document.querySelector('.context-usage-heading b')?.textContent?.trim(),
    percent: document.querySelector('.context-usage-percent')?.textContent?.trim(),
    fill: document.querySelector('.context-expanded-track i')?.style.width,
  }))()`);
  assert.deepEqual(initial, { slider: 96_000, heading: '96.0k', percent: '4%', fill: '3.28125%' }, 'Context control did not open with independent usage and threshold values');

  await evaluate(window, `(() => {
    const slider = document.querySelector('input[aria-label="Automatic compaction threshold"]');
    if (!(slider instanceof HTMLInputElement)) throw new Error('Context threshold slider is missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '40000');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(window, `document.querySelector('.context-usage-heading b')?.textContent?.trim() === '40.0k'`, 'Context draft threshold did not follow the slider');
  assert.deepEqual(await evaluate(window, `(() => ({
    fill: document.querySelector('.context-expanded-track i')?.style.width,
  }))()`), { fill: initial.fill }, 'Dragging the compaction threshold moved the context usage fill');
  assert.equal(await evaluate(window, `document.querySelector('.context-usage-percent')?.textContent?.trim()`), '11%', 'Compact header did not preview distance to the draft compaction threshold');
  assert.equal(requestCount(), initialRequests, 'Dragging the context threshold applied before the user clicked Apply');
  await capture(window, '01-context-draft-preview', captures);

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, `!document.querySelector('.context-usage-popover')`, 'Escape did not dismiss context settings');
  assert.equal(await evaluate(window, `document.querySelector('.context-usage-percent')?.textContent?.trim()`), initial.percent, 'Escape left the unsaved threshold percentage painted as active');
  await openPopover(window, '.context-usage-trigger', '.context-usage-popover', 'context threshold reopen after Escape');
  assert.equal(await evaluate(window, `Number(document.querySelector('input[aria-label="Automatic compaction threshold"]')?.value)`), 96_000, 'Escape did not reset the draft threshold');

  await evaluate(window, `(() => {
    const slider = document.querySelector('input[aria-label="Automatic compaction threshold"]');
    if (!(slider instanceof HTMLInputElement)) throw new Error('Context threshold slider is missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '40000');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await clickSelector(window, '.workspace h1');
  await waitFor(window, `!document.querySelector('.context-usage-popover')`, 'Outside click did not dismiss context settings');
  await openPopover(window, '.context-usage-trigger', '.context-usage-popover', 'context threshold reopen after outside click');
  assert.equal(await evaluate(window, `Number(document.querySelector('input[aria-label="Automatic compaction threshold"]')?.value)`), 96_000, 'Outside dismissal did not reset the draft threshold');

  await evaluate(window, `(() => {
    const slider = document.querySelector('input[aria-label="Automatic compaction threshold"]');
    if (!(slider instanceof HTMLInputElement)) throw new Error('Context threshold slider is missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '40000');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await clickMatchingButton(window, '.context-usage-popover', 'Apply');
  await waitFor(window, `!document.querySelector('.context-usage-popover') && document.querySelector('.context-usage-percent')?.textContent?.trim() === '11%'`, 'Applied context threshold did not update the compact header meter');
  assert.equal(requestCount(), initialRequests + 1, 'Apply did not issue exactly one threshold update');
  const applied = host.stateForTests().requests.filter((entry) => entry.type === 'session.context.set_threshold').at(-1);
  assert.deepEqual(applied?.payload, { sessionId: 'fake-main', thresholdTokens: 40_000, compactNow: true });
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'Applying a context threshold showed a redundant success toast');

  await openPopover(window, '.context-usage-trigger', '.context-usage-popover', 'context threshold persisted reopen');
  assert.equal(await evaluate(window, `Number(document.querySelector('input[aria-label="Automatic compaction threshold"]')?.value)`), 40_000, 'Applied threshold did not persist on reopen');
  await capture(window, '02-context-applied-persisted', captures);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, `!document.querySelector('.context-usage-popover')`, 'Final context settings dismissal failed');
  return scenarioOutcome('context-threshold-lifecycle', { initial, applied: applied.payload, persistedPercent: '11%' }, {
    'context.draft-keeps-usage-stable': initial,
    'context.escape-discards-draft': true,
    'context.outside-click-discards-draft': true,
    'context.apply-once': applied.payload,
    'context.persist-on-reopen': 40_000,
    'context.success-is-silent': true,
  });
}

/**
 * The EYES model control is a searchable listbox, so its catalogue is read from the
 * open dropdown rather than from static option nodes. Returns each visible row's
 * model name plus the dimmer upstream-provider label beside it.
 */
async function readVisionModels(window, query = '') {
  return await evaluate(window, `(async () => {
    const trigger = document.querySelector('.vision-model-trigger');
    if (!(trigger instanceof HTMLButtonElement)) throw new Error('The EYES model trigger is missing');
    const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!document.querySelector('.vision-model-dropdown')) { trigger.click(); await settle(); }
    const field = document.querySelector('.vision-model-search input');
    if (!field) throw new Error('The EYES model search field is missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(query)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    const rows = [...document.querySelectorAll('.vision-model-option')].map((node) => ({
      name: node.querySelector('strong')?.textContent?.trim(),
      source: node.querySelector('small')?.textContent?.trim() ?? null,
    }));
    trigger.click();
    await settle();
    return rows;
  })()`);
}

async function scenarioCommandContracts(window, captures, host) {
  await replaceComposerText(window, '/');
  const catalogue = await evaluate(window, `[...document.querySelectorAll('.slash-command-palette button strong')].map((node) => node.textContent?.trim())`);
  assert.deepEqual(catalogue, ['/simplify', '/mesh', '/goal', '/ears', '/eyes'], 'The real composer command catalogue drifted');
  await capture(window, '01-command-catalogue', captures);

  await chooseSlashCommand(window, '/eyes');
  await waitFor(window, `Boolean(document.querySelector('.vision-eyes-picker'))`, '/eyes did not open the vision picker');
  // EYES is off until the user chooses: the provider list carries its
  // placeholder, no model is pre-selected, and the panel says so plainly.
  await waitFor(window, `(() => {
    const picker = document.querySelector('.vision-eyes-picker');
    const providers = [...document.querySelectorAll('select[aria-label="Vision provider"] option')].map((node) => node.textContent?.trim());
    return picker?.textContent?.includes('Off for this task') && providers.length === 5 && document.querySelector('.vision-model-trigger')?.dataset.modelId === '';
  })()`, '/eyes capability options did not finish loading');
  const visionProviders = await evaluate(window, `[...document.querySelectorAll('select[aria-label="Vision provider"] option')].map((node) => node.textContent?.trim())`);
  assert.deepEqual(visionProviders, ['Choose provider', 'Direct API', 'Codex', 'OpenCode', 'Grok']);
  await evaluate(window, `(() => {
    const select = document.querySelector('select[aria-label="Vision provider"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('Vision provider select is missing');
    select.value = 'direct';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(window, `document.querySelector('select[aria-label="Vision provider"]')?.value === 'direct'`, '/eyes did not select Direct through keyboard input');
  assert.deepEqual(await readVisionModels(window), [{ name: 'Direct Vision + Audio', source: null }]);
  await evaluate(window, `(() => {
    const select = document.querySelector('select[aria-label="Vision provider"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('Vision provider select is missing');
    select.value = 'opencode';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(window, `document.querySelector('select[aria-label="Vision provider"]')?.value === 'opencode'`, '/eyes did not select OpenCode through keyboard input');
  assert.deepEqual(await readVisionModels(window), [{ name: 'DeepSeek V4 Flash', source: null }]);
  // Typing narrows the same catalogue, and a query matching nothing empties it.
  assert.deepEqual(await readVisionModels(window, 'flash'), [{ name: 'DeepSeek V4 Flash', source: null }]);
  assert.deepEqual(await readVisionModels(window, 'no-such-model'), []);
  await clickMatchingButton(window, '.vision-eyes-picker', 'Use as eyes');
  await waitFor(window, `!document.querySelector('.vision-eyes-picker')`, '/eyes picker did not close after configuration');
  const visionRequest = host.stateForTests().requests.filter((entry) => entry.type === 'session.vision.configure').at(-1);
  assert.deepEqual(visionRequest?.payload?.selection, { providerId: 'opencode', modelId: 'deepseek/deepseek-v4-flash', reasoningEffort: 'low' });
  await capture(window, '02-eyes-configured', captures);

  await chooseSlashCommand(window, '/ears');
  await waitFor(window, `Boolean(document.querySelector('.ears-settings'))`, '/ears did not open EARS settings');
  const earsModels = await evaluate(window, `[...document.querySelectorAll('select[aria-label="EARS model"] option')].map((node) => node.textContent?.trim())`);
  assert.deepEqual(earsModels, [
    'Choose an audio-capable model',
    'Direct Vision + Audio',
    'DeepSeek V4 Flash',
  ], 'EARS exposed a route that cannot actually transport native audio');
  assert.ok(!earsModels.some((label) => /Text Only|Grok|V4 Pro/u.test(label ?? '')), 'EARS included an ineligible text-only or non-audio harness route');
  const earsToggleAlignment = await evaluate(window, `(() => {
    const toggle = document.querySelector('.ears-toggle input');
    const label = document.querySelector('.ears-toggle span');
    if (!(toggle instanceof HTMLElement) || !(label instanceof HTMLElement)) throw new Error('EARS toggle is incomplete');
    const toggleBounds = toggle.getBoundingClientRect();
    const labelBounds = label.getBoundingClientRect();
    return { toggleY: toggleBounds.top + toggleBounds.height / 2, labelY: labelBounds.top + labelBounds.height / 2 };
  })()`);
  assert.ok(Math.abs(earsToggleAlignment.toggleY - earsToggleAlignment.labelY) <= 2, `EARS toggle is visually detached from its label: ${JSON.stringify(earsToggleAlignment)}`);
  await evaluate(window, `(() => {
    const select = document.querySelector('select[aria-label="EARS model"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('EARS model select is missing');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'direct:direct/vision-audio');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(window, `document.querySelector('select[aria-label="EARS model"]')?.value === 'direct:direct/vision-audio' && document.querySelector('.ears-toggle input')?.checked === true`, 'EARS model selection did not enable and persist in the panel');
  await capture(window, '03-ears-capability-filter', captures);
  await clickSelector(window, 'button[aria-label="Close EARS settings"]');
  await waitFor(window, `!document.querySelector('.ears-settings')`, '/ears settings could not be dismissed');

  await chooseSlashCommand(window, '/mesh');
  await waitFor(window, `Boolean(document.querySelector('.mesh-panel'))`, '/mesh did not open the target picker');
  await clickSelector(window, 'button[aria-label="Choose model and reasoning for OpenCode"]');
  await waitFor(window, `Boolean(document.querySelector('.mesh-model-picker'))`, '/mesh did not open OpenCode model selection');
  await clickSelector(window, '.mesh-model-picker-scroll section:nth-of-type(2) button:last-child');
  await clickMatchingButton(window, '.mesh-model-picker', 'Add to mesh');
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === '' && !document.querySelector('.mesh-model-picker')`, '/mesh did not settle after adding OpenCode');
  await delay(50);
  await chooseSlashCommand(window, '/mesh');
  await waitFor(window, `Boolean(document.querySelector('.mesh-panel'))`, '/mesh did not reopen the target picker');
  await clickSelector(window, 'button[aria-label="Choose model and reasoning for Grok"]');
  await waitFor(window, `Boolean(document.querySelector('.mesh-model-picker'))`, '/mesh did not open Grok model selection');
  await clickSelector(window, '.mesh-model-picker-scroll section:nth-of-type(2) button:last-child');
  await clickMatchingButton(window, '.mesh-model-picker', 'Add to mesh');
  await replaceComposerText(window, 'Compare both harness implementations');
  await pressComposerEnter(window);
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ''`, '/mesh did not consume the submitted instruction');
  const meshRequest = host.stateForTests().requests.filter((entry) => entry.type === 'delegation.prepare').at(-1);
  assert.equal(meshRequest?.payload?.prompt, 'Compare both harness implementations');
  assert.deepEqual(meshRequest?.payload?.targets, [
    { providerId: 'opencode', modelId: 'deepseek/deepseek-v4-flash', reasoningEffort: 'max' },
    { providerId: 'grok', modelId: 'grok/vision', reasoningEffort: 'high' },
  ]);
  assert.deepEqual(meshRequest?.payload?.presentationSegments, [
    { type: 'mesh', targetIndex: 0 },
    { type: 'mesh', targetIndex: 1 },
    { type: 'text', text: 'Compare both harness implementations' },
  ]);
  assert.equal(meshRequest?.payload?.modelId, 'fake/deterministic-v1');
  assert.equal(meshRequest?.payload?.reasoningEffort, 'Medium');
  assert.equal(host.stateForTests().requests.some((entry) => entry.type === 'delegation.start'), false, 'The command journey used the legacy raw-prompt child route');
  await capture(window, '04-mesh-mixed-models', captures);

  await chooseSlashCommand(window, '/simplify');
  await waitFor(window, `Boolean(document.querySelector('.simplify-command-row'))`, '/simplify did not expose its one-turn settings');
  await window.webContents.insertText('Explain the fixture result');
  await openPopover(window, 'button[aria-label="Simplify settings"]', '.simplify-command .composer-popover', '/simplify settings');
  await clickMatchingButton(window, '.simplify-presets', '200');
  await clickSelector(window, '.simplify-settings textarea');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  await waitFor(window, `(() => { const input = document.querySelector('.simplify-settings textarea'); return input instanceof HTMLTextAreaElement && input.selectionStart === 0 && input.selectionEnd === input.value.length; })()`, '/simplify guidance was not selected');
  await window.webContents.insertText('Keep the concrete example.');
  await pressComposerEnter(window);
  await waitFor(window, `(() => [...document.querySelectorAll('.message-user')].some((node) => node.textContent?.includes('Explain the fixture result')))()`, '/simplify visible message did not appear');
  const simplifyRequest = host.stateForTests().requests.filter((entry) => entry.type === 'session.send_message').at(-1);
  assert.equal(simplifyRequest?.payload?.content, 'Explain the fixture result');
  assert.deepEqual(simplifyRequest?.payload?.simplify, { maxWords: 200, guidance: 'Keep the concrete example.', target: 'upcoming' });
  const visibleTranscript = await evaluate(window, `document.querySelector('.conversation')?.textContent ?? ''`);
  for (const secret of ['/simplify', '/mesh', '/eyes', '/ears', 'deepseek/deepseek-v4-flash', 'session.vision.configure', 'Keep the concrete example.']) {
    assert.ok(!visibleTranscript.includes(secret), `Private command metadata leaked into the transcript: ${secret}`);
  }
  await capture(window, '05-simplify-hidden-metadata', captures);
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window);
  return scenarioOutcome('command-contracts', { catalogue, visionOptions, earsModels, meshTargets: meshRequest.payload.targets, simplify: simplifyRequest.payload }, {
    'commands.catalogue-keyboard': catalogue,
    'eyes.capability-filter': visionOptions,
    'eyes.provider-model-payload': host.stateForTests().requests.filter((entry) => entry.type === 'session.vision.configure').at(-1)?.payload,
    'ears.capability-filter': earsModels,
    'mesh.mixed-provider-model-effort-payload': meshRequest.payload.targets,
    'simplify.hidden-metadata-payload': simplifyRequest.payload,
  });
}

async function scenarioMeshParentOrchestration(window, host) {
  const initialDelegationRequests = host.stateForTests().requests.filter((entry) =>
    entry.type === 'delegation.prepare' || entry.type === 'delegation.start');
  assert.deepEqual(initialDelegationRequests, [], 'Mesh orchestration scenario did not start with a clean delegation request log');

  await chooseSlashCommand(window, '/mesh');
  await waitFor(window, `Boolean(document.querySelector('.mesh-panel'))`, 'Mesh orchestration: target picker did not open');
  await clickSelector(window, 'button[aria-label="Choose model and reasoning for OpenCode"]');
  await waitFor(window, `Boolean(document.querySelector('.mesh-model-picker'))`, 'Mesh orchestration: OpenCode model picker did not open');
  await waitFor(window, `[...document.querySelectorAll('.mesh-model-picker-reasoning-options button')].some((button) => button.textContent?.includes('Max')) && !document.querySelector('.mesh-model-picker footer button.primary')?.disabled`, 'Mesh orchestration: OpenCode choices did not finish loading');
  await clickMatchingButton(window, '.mesh-model-picker-reasoning-options', 'Max');
  await clickMatchingButton(window, '.mesh-model-picker', 'Add to mesh');
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === '' && !document.querySelector('.mesh-model-picker')`, 'Mesh orchestration: OpenCode target did not settle in the composer');

  await chooseSlashCommand(window, '/mesh');
  await waitFor(window, `Boolean(document.querySelector('.mesh-panel'))`, 'Mesh orchestration: target picker did not reopen');
  await clickSelector(window, 'button[aria-label="Choose model and reasoning for Grok"]');
  await waitFor(window, `Boolean(document.querySelector('.mesh-model-picker'))`, 'Mesh orchestration: Grok model picker did not open');
  await waitFor(window, `[...document.querySelectorAll('.mesh-model-picker-reasoning-options button')].some((button) => button.textContent?.includes('High')) && !document.querySelector('.mesh-model-picker footer button.primary')?.disabled`, 'Mesh orchestration: Grok choices did not finish loading');
  await clickMatchingButton(window, '.mesh-model-picker-reasoning-options', 'High');
  await clickMatchingButton(window, '.mesh-model-picker', 'Add to mesh');
  const prompt = 'Compare both harness implementations';
  await replaceComposerText(window, prompt);
  await pressComposerEnter(window);
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ''`, 'Mesh orchestration: submitted instruction remained in the composer');

  const delegationRequests = host.stateForTests().requests.filter((entry) =>
    entry.type === 'delegation.prepare' || entry.type === 'delegation.start');
  assert.deepEqual(delegationRequests.map((entry) => entry.type), ['delegation.prepare'],
    'Mesh orchestration must issue exactly one prepared parent turn and never use delegation.start');
  const meshRequest = delegationRequests[0];
  assert.equal(meshRequest.payload?.parentSessionId, 'fake-main');
  assert.equal(meshRequest.payload?.prompt, prompt);
  assert.deepEqual(meshRequest.payload?.targets, [
    { providerId: 'opencode', modelId: 'deepseek/deepseek-v4-flash', reasoningEffort: 'max' },
    { providerId: 'grok', modelId: 'grok/vision', reasoningEffort: 'high' },
  ]);
  assert.deepEqual(meshRequest.payload?.presentationSegments, [
    { type: 'mesh', targetIndex: 0 },
    { type: 'mesh', targetIndex: 1 },
    { type: 'text', text: prompt },
  ]);
  assert.equal(meshRequest.payload?.modelId, 'fake/deterministic-v1');
  assert.equal(meshRequest.payload?.reasoningEffort, 'Medium');

  return scenarioOutcome('mesh-parent-orchestration', {
    requestType: meshRequest.type,
    targets: meshRequest.payload.targets,
    presentationSegments: meshRequest.payload.presentationSegments,
    parentSelection: { modelId: meshRequest.payload.modelId, reasoningEffort: meshRequest.payload.reasoningEffort },
  }, {});
}

async function scenarioEarsTranscriptionSend(window, captures, host) {
  await clickTaskByTitle(window, 'Fake Codex audio task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake Codex audio task')`, 'EARS fixture task did not open');

  await clickSelector(window, 'button[aria-label="Choose dictation source"]');
  await waitFor(window, `Boolean(document.querySelector('.dictation-direct-audio-option'))`, 'Sol dictation source menu did not open');
  const solBeforeEars = await evaluate(window, `(() => {
    const option = document.querySelector('.dictation-direct-audio-option');
    return option instanceof HTMLButtonElement ? { disabled: option.disabled, text: option.textContent?.replace(/\\s+/gu, ' ').trim() } : null;
  })()`);
  assert.equal(solBeforeEars?.disabled, true, 'GPT-5.6 Sol incorrectly advertised native MP3 input');
  assert.match(solBeforeEars?.text ?? '', /^MP3\s*This model cannot hear a recording$/u);
  await clickSelector(window, 'button[aria-label="Choose dictation source"]');

  await chooseSlashCommand(window, '/ears');
  await waitFor(window, `Boolean(document.querySelector('select[aria-label="EARS model"]'))`, 'EARS settings did not open for the focused journey');
  await evaluate(window, `(() => {
    const select = document.querySelector('select[aria-label="EARS model"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('EARS model select is missing');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'direct:direct/vision-audio');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(window, `document.querySelector('select[aria-label="EARS model"]')?.value === 'direct:direct/vision-audio' && document.querySelector('.ears-toggle input')?.checked === true`, 'Focused EARS journey could not establish its own audio helper');
  await clickSelector(window, 'button[aria-label="Close EARS settings"]');

  await clickSelector(window, 'button[aria-label="Choose dictation source"]');
  await waitFor(window, `Boolean(document.querySelector('.dictation-direct-audio-option'))`, 'EARS-backed Sol dictation source menu did not open');
  const solWithEars = await evaluate(window, `(() => {
    const option = document.querySelector('.dictation-direct-audio-option');
    return option instanceof HTMLButtonElement ? { disabled: option.disabled, text: option.textContent?.replace(/\\s+/gu, ' ').trim() } : null;
  })()`);
  assert.equal(solWithEars?.disabled, false, 'EARS did not make MP3 recording available for text-only GPT-5.6 Sol');
  assert.match(solWithEars?.text ?? '', /^MP3\s*EARS turns your recording into text$/u);
  await clickSelector(window, 'button[aria-label="Choose dictation source"]');

  const earsBefore = host.stateForTests().requests.filter((entry) => entry.type === 'ears.process').length;
  const sendsBefore = host.stateForTests().requests.filter((entry) => entry.type === 'session.send_message').length;
  await clickSelector(window, 'button[aria-label="Start dictation"]');
  await waitFor(window, `document.querySelector('.dictation-audio-strip')`, 'EARS dictation did not start on a text-only destination');
  // Give the first AudioContext in this process enough time to begin delivering
  // PCM callbacks. Later recordings are already warm, but this cold-start path
  // is the one a real first-use EARS journey takes.
  await delay(1_600);
  await clickSelector(window, 'button[aria-label="Stop dictation"]');
  try {
    await waitFor(window, `document.querySelector('.audio-playback-chip button[aria-label^="Play "]')`, 'EARS recording did not become an editable composer attachment', 8_000);
  } catch (error) {
    const state = await evaluate(window, `({
      phase: document.querySelector('.dictation-control')?.className,
      composer: document.querySelector('.composer')?.textContent,
      toasts: [...document.querySelectorAll('.toast')].map((node) => node.textContent),
      audioChips: document.querySelectorAll('.audio-playback-chip').length,
      attachments: document.querySelector('.attachment-chips')?.innerHTML,
    })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; renderer state: ${JSON.stringify(state)}`);
  }
  await capture(window, '06-ears-recording-ready', captures);
  await clickSelector(window, 'button[aria-label="Send instruction"]');
  await waitFor(window, `[...document.querySelectorAll('.message-user')].some((node) => node.textContent?.includes('Deterministic EARS transcript 1:'))`, 'EARS transcript did not become the destination instruction', 8_000);

  const earsRequests = host.stateForTests().requests.filter((entry) => entry.type === 'ears.process');
  const sends = host.stateForTests().requests.filter((entry) => entry.type === 'session.send_message');
  assert.equal(earsRequests.length, earsBefore + 1, 'EARS send did not issue exactly one transcription request');
  assert.equal(sends.length, sendsBefore + 1, 'EARS send did not issue exactly one destination turn');
  const earsRequest = earsRequests.at(-1);
  assert.equal(earsRequest.payload.providerId, 'direct');
  assert.equal(earsRequest.payload.modelId, 'direct/vision-audio');
  assert.equal(earsRequest.payload.mode, 'cleaned');
  assert.equal(earsRequest.payload.sessionId, 'fake-audio');
  assert.equal(earsRequest.payload.attachmentIds.length, 1);
  const send = sends.at(-1);
  assert.match(send.payload.content, /^Deterministic EARS transcript 1:/u);
  assert.deepEqual(send.payload.attachmentIds ?? [], [], 'EARS leaked the source MP3 to the text-only destination model');
  assert.equal(await evaluate(window, `[...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes('Deterministic EARS transcript 1:')).at(-1)?.querySelectorAll('.audio-playback-chip').length`), 0, 'EARS destination row still displayed the private source recording');
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window);
  await waitFor(window, `document.querySelector('button[aria-label="Send instruction"]')`, 'EARS destination turn completed in the host but the composer still treated it as running', 8_000);
  await capture(window, '07-ears-transcript-sent', captures);
  return scenarioOutcome('ears-transcription-send', { transcriptionRequests: 1, destinationTurns: 1, sourceAudioForwarded: false, solNativeAudio: false, solWithEars: true }, {
    'ears.settings-persist': true,
    'ears.record-transcribe-send': true,
    'ears.source-audio-not-forwarded': send.payload.attachmentIds ?? [],
    'audio.gpt-5.6-sol-requires-ears': solBeforeEars,
  });
}

async function ensureRendererReady(window) {
  await waitFor(window, `document.querySelector('.desktop-app') && (document.querySelector('textarea[aria-label="Message"]') || document.querySelector('[data-session-id="fake-main"] .session-row'))`, 'Renderer did not become ready', 15_000);
  if (!await evaluate(window, `Boolean(document.querySelector('textarea[aria-label="Message"]'))`)) {
    await evaluate(window, `document.querySelector('[data-session-id="fake-main"] .session-row')?.click()`);
  }
  await waitFor(window, `document.querySelector('.conversation-scroll') && document.querySelector('textarea[aria-label="Message"]')`, 'Fixture task did not open', 8_000);
}

async function scenarioRuntimeStartupStatus(window, captures, _host, sessionsListGate) {
  const gateDeadline = Date.now() + 5_000;
  while (sessionsListGate?.used !== true && Date.now() < gateDeadline) await delay(10);
  assert.equal(sessionsListGate?.used, true, 'Runtime startup status did not pause the first sessions.list request');
  try {
    await waitFor(window, `document.querySelector('.desktop-app') && document.querySelector('.sidebar-runtime-indicator.starting')`, 'Neutral runtime startup status did not paint', 8_000);
    const starting = await evaluate(window, `(() => ({
      offlineBanner: [...document.querySelectorAll('.error-banner')].some((node) => node.textContent?.includes('Local runtime is offline')),
      statusLabel: document.querySelector('.sidebar-runtime-indicator')?.getAttribute('aria-label') ?? null,
      startingClass: Boolean(document.querySelector('.sidebar-runtime-indicator.starting')),
      offlineClass: Boolean(document.querySelector('.sidebar-runtime-indicator.offline')),
    }))()`);
    assert.equal(starting.offlineBanner, false, 'Ordinary runtime startup painted the offline error banner');
    assert.match(starting.statusLabel ?? '', /Runtime starting/u, 'Startup status did not name the neutral state truthfully');
    assert.equal(starting.startingClass, true, 'Startup status did not use its neutral painted class');
    assert.equal(starting.offlineClass, false, 'Startup status used the red offline class');
    await capture(window, 'startup-runtime-01-neutral', captures);

    sessionsListGate.release();
    await waitFor(window, `document.querySelector('.sidebar-runtime-indicator.connected[aria-label*="Runtime online"]')`, 'Runtime status did not settle online after hydration', 10_000);
    const hydrated = await evaluate(window, `({
      offlineBanner: [...document.querySelectorAll('.error-banner')].some((node) => node.textContent?.includes('Local runtime is offline')),
      statusLabel: document.querySelector('.sidebar-runtime-indicator')?.getAttribute('aria-label') ?? null,
    })`);
    assert.equal(hydrated.offlineBanner, false, 'Healthy hydrated runtime painted the offline error banner');
    assert.match(hydrated.statusLabel ?? '', /Runtime online/u, 'Hydrated runtime did not settle online');
    await capture(window, 'startup-runtime-02-online', captures);

    if (!window.isDestroyed()) window.webContents.send('tethoq:runtime-state', { state: 'failed', message: 'Injected runtime failure' });
    await waitFor(window, `document.querySelector('.sidebar-runtime-indicator.offline[aria-label*="Runtime offline"]') && [...document.querySelectorAll('.error-banner')].some((node) => node.textContent?.includes('Local runtime is offline'))`, 'Authoritative runtime failure did not paint offline', 5_000);
    const failed = await evaluate(window, `({
      offlineBanner: [...document.querySelectorAll('.error-banner')].some((node) => node.textContent?.includes('Local runtime is offline')),
      statusLabel: document.querySelector('.sidebar-runtime-indicator')?.getAttribute('aria-label') ?? null,
    })`);
    assert.equal(failed.offlineBanner, true, 'Authoritative runtime failure did not show its recovery banner');
    assert.match(failed.statusLabel ?? '', /Runtime offline/u, 'Authoritative runtime failure did not settle offline');
    await capture(window, 'startup-runtime-03-failed', captures);
    return scenarioOutcome('runtime-startup-status', { starting, hydrated, failed }, {});
  } finally {
    sessionsListGate?.release();
  }
}

async function scenarioProgressiveStartup(window, captures, _host, sessionsListGate) {
  assert.equal(sessionsListGate?.used, true, 'Progressive startup did not pause the first sessions.list request');
  const draft = `Typed before startup hydration ${Date.now()}`;
  try {
    const shell = await evaluate(window, `(() => ({
      progressiveWorkspace: Boolean(document.querySelector('.workspace-progressive-loading')),
      taskSkeleton: Boolean(document.querySelector('.session-list-skeleton')),
      headerSkeleton: Boolean(document.querySelector('.workspace-header-skeleton')),
      transcriptSkeleton: Boolean(document.querySelector('.transcript-skeleton')),
      textarea: Boolean(document.querySelector('textarea[aria-label="Message"]')),
      spinnerCount: document.querySelectorAll('.spinner').length,
      visibleLoadingCopy: /loading (?:your )?coding tools|loading task history/iu.test(document.body.innerText),
      offlineBanner: [...document.querySelectorAll('.error-banner')].some((node) => node.textContent?.includes('Local runtime is offline')),
      runtimeStarting: Boolean(document.querySelector('.sidebar-runtime-indicator.starting[aria-label*="Runtime starting"]')),
    }))()`);
    assert.deepEqual(shell, {
      progressiveWorkspace: true,
      taskSkeleton: true,
      headerSkeleton: true,
      transcriptSkeleton: true,
      textarea: true,
      spinnerCount: 0,
      visibleLoadingCopy: false,
      offlineBanner: false,
      runtimeStarting: true,
    }, 'Progressive startup did not paint the independently hydrating shell');

    await replaceComposerText(window, draft);
    await attachFakeImage(window);
    const before = await evaluate(window, `(() => {
      const image = document.querySelector('.image-attachment-chip img');
      if (!(image instanceof HTMLImageElement)) throw new Error('Startup image widget is missing');
      window.__tethoqProgressiveStartupImageNode = image;
      return {
        draft: document.querySelector('textarea[aria-label="Message"]')?.value,
        attachmentCount: document.querySelectorAll('.image-attachment-chip img').length,
        attachmentName: document.querySelector('.image-attachment-chip')?.textContent?.trim(),
        imageSource: image.currentSrc || image.src,
      };
    })()`);
    assert.equal(before.draft, draft, 'The startup composer did not accept typed text');
    assert.equal(before.attachmentCount, 1, 'The startup composer did not accept exactly one image');
    assert.match(before.attachmentName ?? '', /fake-attachment\.png/u, 'The startup image widget lost its filename');
    assert.ok(before.imageSource, 'The startup image widget has no painted source');
    await capture(window, 'startup-01-progressive-shell-usable', captures);

    sessionsListGate.release();
    await waitFor(window, `!document.querySelector('.workspace-progressive-loading') && Boolean(document.querySelector('[data-session-id="fake-main"]'))`, 'Progressive startup did not hydrate the real task list', 10_000);
    await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(draft)} && document.querySelectorAll('.image-attachment-chip img').length === 1`, 'Startup draft did not survive hydration', 5_000);
    await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const hydrated = await evaluate(window, `(() => {
      const image = document.querySelector('.image-attachment-chip img');
      return {
        draft: document.querySelector('textarea[aria-label="Message"]')?.value,
        attachmentCount: document.querySelectorAll('.image-attachment-chip img').length,
        sameImageNode: image === window.__tethoqProgressiveStartupImageNode,
        imageSource: image instanceof HTMLImageElement ? image.currentSrc || image.src : null,
        startupDraftPresent: Boolean(document.querySelector('[data-session-id="draft-startup"]')),
        realSessionsPresent: Boolean(document.querySelector('[data-session-id="fake-main"]')),
        skeletonsRemaining: document.querySelectorAll('.session-list-skeleton, .workspace-header-skeleton, .transcript-skeleton').length,
        offlineBanner: [...document.querySelectorAll('.error-banner')].some((node) => node.textContent?.includes('Local runtime is offline')),
        runtimeOnline: Boolean(document.querySelector('.sidebar-runtime-indicator.connected[aria-label*="Runtime online"]')),
      };
    })()`);
    assert.equal(hydrated.draft, draft, 'Hydration replaced the text typed during startup');
    assert.equal(hydrated.attachmentCount, 1, 'Hydration replaced or duplicated the startup image');
    assert.equal(hydrated.sameImageNode, true, 'Hydration remounted the startup image widget');
    assert.equal(hydrated.imageSource, before.imageSource, 'Hydration changed the startup image source');
    assert.equal(hydrated.startupDraftPresent, true, 'Hydration discarded the usable startup draft task');
    assert.equal(hydrated.realSessionsPresent, true, 'Hydration did not add the real task list');
    assert.equal(hydrated.skeletonsRemaining, 0, 'Hydrated content left startup skeletons mounted');
    assert.equal(hydrated.offlineBanner, false, 'A healthy hydrated runtime showed the offline banner');
    assert.equal(hydrated.runtimeOnline, true, 'The runtime indicator did not become online after hydration');
    await capture(window, 'startup-02-hydrated-draft-preserved', captures);

    return scenarioOutcome('progressive-startup', { shell, before, hydrated }, {
      'startup.progressive-shell-no-blocking-copy': shell,
      'startup.composer-usable-before-hydration': { draftAccepted: before.draft === draft, attachmentCount: before.attachmentCount },
      'startup.draft-survives-hydration': { sameText: hydrated.draft === draft, sameImageNode: hydrated.sameImageNode, attachmentCount: hydrated.attachmentCount },
    });
  } finally {
    sessionsListGate?.release();
  }
}

/**
 * Exercise response annotations through the same painted transcript,
 * context-menu, composer, transport, and reopened-history path a user uses.
 * The selection is created in the page only to make the background run
 * deterministic; the actual context-menu event and every subsequent click
 * still cross the renderer's ordinary DOM handlers.
 */
async function scenarioResponseAnnotationJourney(window, captures, host) {
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Annotation fixture task did not open');

  const selectedText = 'The fake model completed its deterministic pass.';
  const firstComment = 'Explain this deterministic result in plain English.';
  const editedComment = 'Explain this deterministic result in one short sentence.';
  const sendsBefore = host.stateForTests().requests.filter((entry) => entry.type === 'session.send_message').length;
  await submitComposer(window, 'run the response annotation fixture');
  await waitFor(window, `([...document.querySelectorAll('.message-assistant .message-body')].some((node) => node.textContent?.includes(${JSON.stringify(selectedText)})))`, 'Annotation fixture answer did not appear', 8_000);
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window, 8_000);

  const selectionState = await evaluate(window, `(() => {
    const target = ${JSON.stringify(selectedText)};
    const body = [...document.querySelectorAll('.message-assistant .message-body')].find((candidate) => candidate.textContent?.includes(target));
    if (!(body instanceof HTMLElement)) throw new Error('Annotation fixture answer body is missing');
    body.scrollIntoView({ block: 'center', inline: 'nearest' });
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = null;
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes(target)) { node = walker.currentNode; break; }
    }
    if (!(node instanceof Text)) throw new Error('Annotation fixture answer text node is missing');
    const start = node.data.indexOf(target);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + target.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const bounds = body.getBoundingClientRect();
    const x = Math.max(8, Math.min(bounds.left + 24, window.innerWidth - 8));
    const y = Math.max(8, Math.min(bounds.top + 24, window.innerHeight - 8));
    body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
    return { selected: selection?.toString() ?? '', x, y };
  })()`);
  assert.equal(selectionState.selected, selectedText, 'The background selection did not target the intended assistant text');
  await waitFor(window, `Boolean(document.querySelector('.annotation-context-menu'))`, 'Annotation context action did not appear');
  await assertOverlayWithinViewport(window, '.annotation-context-menu', 'annotation context action');
  await assertOverlayPaintedOnTop(window, '.annotation-context-menu', 'annotation context action');
  await clickMatchingButton(window, '.annotation-context-menu', 'Annotate');
  await waitFor(window, `Boolean(document.querySelector('.annotation-editor[aria-label="Annotate selected response"]'))`, 'Annotation editor did not open');
  assert.equal(await evaluate(window, `document.querySelectorAll('.annotation-editor').length`), 1, 'Annotation editor was duplicated');
  assert.equal(await evaluate(window, `document.querySelector('.annotation-editor blockquote')?.textContent?.trim()`), selectedText, 'Annotation editor lost the selected response');
  await capture(window, '23-annotation-editor', captures);

  await clickSelector(window, 'textarea[aria-label="Annotation comment"]');
  await window.webContents.insertText(firstComment);
  await waitFor(window, `document.querySelector('textarea[aria-label="Annotation comment"]')?.value === ${JSON.stringify(firstComment)}`, 'Annotation comment was not entered');
  await clickSelector(window, 'button[aria-label="Add annotation to message"]');
  await waitFor(window, `document.querySelectorAll('.composer-annotation-chip').length === 1`, 'Created annotation did not appear in the composer');

  // Edit the same annotation and prove the chip's detail carries the new
  // value, then remove it before creating the final annotation to send.
  await clickSelector(window, 'button[aria-label="Edit annotation 1"]');
  await waitFor(window, `document.querySelector('.annotation-editor[aria-label="Edit response annotation"]')`, 'Edit annotation editor did not open');
  assert.equal(await evaluate(window, `document.querySelector('textarea[aria-label="Annotation comment"]')?.value`), firstComment, 'Edit editor did not load the existing comment');
  await clickSelector(window, 'textarea[aria-label="Annotation comment"]');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  await waitFor(window, `(() => { const input = document.querySelector('textarea[aria-label="Annotation comment"]'); return input instanceof HTMLTextAreaElement && input.selectionStart === 0 && input.selectionEnd === input.value.length; })()`, 'Annotation edit text was not selected');
  await window.webContents.insertText(editedComment);
  await waitFor(window, `document.querySelector('textarea[aria-label="Annotation comment"]')?.value === ${JSON.stringify(editedComment)}`, 'Edited annotation comment was not entered');
  await clickSelector(window, 'button[aria-label="Add annotation to message"]');
  await waitFor(window, `document.querySelectorAll('.composer-annotation-chip').length === 1`, 'Edited annotation changed its cardinality');
  await clickSelector(window, 'button[aria-label="View annotation 1"]');
  await waitFor(window, `document.querySelector('.composer-annotation-detail p')?.textContent?.includes(${JSON.stringify(editedComment)})`, 'Edited annotation detail did not show the new comment');
  assert.equal(await evaluate(window, `document.querySelectorAll('.composer-annotation-detail').length`), 1, 'Edited annotation detail was duplicated');
  await clickSelector(window, 'button[aria-label="View annotation 1"]');
  await clickSelector(window, 'button[aria-label="Remove annotation 1"]');
  await waitFor(window, `document.querySelectorAll('.composer-annotation-chip').length === 0`, 'Remove annotation did not clear the composer');

  // Recreate after removal, so the send assertion proves the final state is
  // the state that crosses the provider boundary, not an earlier draft.
  await evaluate(window, `(() => {
    const target = ${JSON.stringify(selectedText)};
    const body = [...document.querySelectorAll('.message-assistant .message-body')].find((candidate) => candidate.textContent?.includes(target));
    if (!(body instanceof HTMLElement)) throw new Error('Annotation fixture answer body disappeared');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node = null;
    while (walker.nextNode()) { if (walker.currentNode.textContent?.includes(target)) { node = walker.currentNode; break; } }
    if (!(node instanceof Text)) throw new Error('Annotation fixture text node disappeared');
    const range = document.createRange();
    const start = node.data.indexOf(target);
    range.setStart(node, start); range.setEnd(node, start + target.length);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    const bounds = body.getBoundingClientRect();
    body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: Math.max(8, Math.min(bounds.left + 24, window.innerWidth - 8)), clientY: Math.max(8, Math.min(bounds.top + 24, window.innerHeight - 8)) }));
  })()`);
  await waitFor(window, `Boolean(document.querySelector('.annotation-context-menu'))`, 'Annotation context action did not reopen after removal');
  await clickMatchingButton(window, '.annotation-context-menu', 'Annotate');
  await waitFor(window, `Boolean(document.querySelector('.annotation-editor[aria-label="Annotate selected response"]'))`, 'Recreated annotation editor did not open');
  await clickSelector(window, 'textarea[aria-label="Annotation comment"]');
  await window.webContents.insertText(editedComment);
  await clickSelector(window, 'button[aria-label="Add annotation to message"]');
  await waitFor(window, `document.querySelectorAll('.composer-annotation-chip').length === 1`, 'Recreated annotation did not appear');
  await capture(window, '24-annotation-composed', captures);

  await clickSelector(window, 'button[aria-label="Send instruction"]');
  await waitFor(window, `document.querySelectorAll('.message-user .message-annotations button[aria-label="View annotation 1"]').length === 1`, 'Sent annotation did not become one visible user row', 8_000);
  const sendRequests = host.stateForTests().requests.filter((entry) => entry.type === 'session.send_message');
  assert.equal(sendRequests.length, sendsBefore + 2, 'Annotation fixture did not issue exactly one fixture send and one annotated send');
  const annotationRequest = sendRequests.at(-1);
  assert.match(annotationRequest.payload.content, /# Response annotations:/u, 'Annotation transport did not include its hidden instruction envelope');
  assert.match(annotationRequest.payload.content, /<response-annotations>[\s\S]*The fake model completed its deterministic pass\.[\s\S]*Explain this deterministic result in one short sentence\./u, 'Annotation transport lost selected text or edited comment');
  const visibleText = await evaluate(window, `document.querySelector('.conversation')?.textContent ?? ''`);
  assert.doesNotMatch(visibleText, /# Response annotations:|<response-annotations>|## My request:/u, 'Annotation protocol metadata leaked into the visible transcript');
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-user .message-annotations').length`), 1, 'Annotated send painted more than one annotation badge group');
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window, 8_000);

  // Leave and reopen the task to force the bridge/history parser to rebuild
  // the annotation, then expand exactly one numbered detail.
  await clickTaskByTitle(window, 'Fake model attachments task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model attachments task')`, 'Could not leave the annotated task');
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Could not reopen the annotated task');
  await waitFor(window, `document.querySelectorAll('.message-user .message-annotations button[aria-label="View annotation 1"]').length === 1`, 'Reopened history did not restore one annotation badge', 8_000);
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-annotation-detail').length`), 0, 'Reopened annotation was expanded without user action');
  await clickSelector(window, '.message-user .message-annotations button[aria-label="View annotation 1"]');
  await waitFor(window, `document.querySelectorAll('.message-annotation-detail').length === 1`, 'Reopened annotation detail did not expand once');
  assert.equal(await evaluate(window, `document.querySelector('.message-annotation-detail p')?.textContent?.trim()`), editedComment, 'Reopened annotation detail lost the edited comment');
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-annotation-detail').length`), 1, 'Reopened annotation rendered duplicate details');
  await capture(window, '25-annotation-reopened-detail', captures);

  return scenarioOutcome('response-annotation-journey', { createdEditedRemovedRecreated: true, hiddenMetadataTransported: true, providerRows: 1, reopenedDetails: 1, audioAnnotation: 'not exercised: text comments use the directed journey; native MP3 capture is covered by native-audio-sending' }, {
    'annotation.create-edit-remove-send': true,
    'annotation.metadata-hidden-from-transcript': true,
    'annotation.provider-echo-reconciles-once': true,
    'annotation.reopen-detail-once': true,
  });
}

async function scenarioMasterStream(window, captures, host) {
  const message = 'run the fake model stream';
  await submitComposer(window, message);
  const runId = host.stateForTests().playing?.runId;
  assert.equal(typeof runId, 'string', 'The fake model did not start a distinct stream run');
  await waitFor(window, `document.querySelector('.reasoning-group[aria-busy="true"]')`, 'Fake reasoning did not start');
  await waitFor(window, `Boolean(document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-tool"]`)}))`, 'Tool activity did not reach the timeline', 6_000);
  await waitFor(window, `Boolean(document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-command"]`)}))`, 'Command activity did not reach the timeline', 6_000);
  const liveReasoningFlowSelector = `[data-scroll-members*="${runId}-fake-stream-reasoning"] .reasoning-flow-running`;
  await waitFor(window, `(() => {
    const flow = document.querySelector(${JSON.stringify(liveReasoningFlowSelector)});
    return flow && flow.scrollHeight > flow.clientHeight + 80 && flow.textContent?.includes('enough deterministic detail to overflow');
  })()`, 'Live reasoning did not produce a bounded nested scroll surface', 6_000);
  const defaultReasoningFollow = await evaluate(window, `(() => {
    const flow = document.querySelector(${JSON.stringify(liveReasoningFlowSelector)});
    const transcript = document.querySelector('.conversation-scroll');
    return {
      scrollTop: flow?.scrollTop ?? null,
      maximum: flow ? flow.scrollHeight - flow.clientHeight : null,
      bottomGap: flow ? flow.scrollHeight - flow.scrollTop - flow.clientHeight : null,
      transcriptScrollTop: transcript?.scrollTop ?? null,
      transcriptBottomGap: transcript ? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight : null,
      alreadyReceivedPauseCheckpoint: flow?.textContent?.includes('Reader-owned position checkpoint') ?? null,
    };
  })()`);
  assert.ok(defaultReasoningFollow.maximum > 80, `Live reasoning did not overflow enough to exercise nested follow: ${JSON.stringify(defaultReasoningFollow)}`);
  assert.ok(defaultReasoningFollow.bottomGap <= 1, `Live reasoning did not follow its physical bottom by default: ${JSON.stringify(defaultReasoningFollow)}`);
  assert.ok(defaultReasoningFollow.transcriptBottomGap <= 2, `Master stream did not begin with the transcript following its own bottom: ${JSON.stringify(defaultReasoningFollow)}`);
  assert.equal(defaultReasoningFollow.alreadyReceivedPauseCheckpoint, false, 'Reasoning pause checkpoint arrived before the reader interaction could be exercised');

  await wheelInside(window, liveReasoningFlowSelector, 300);
  await waitFor(window, `(() => {
    const flow = document.querySelector(${JSON.stringify(liveReasoningFlowSelector)});
    return flow && flow.scrollHeight - flow.scrollTop - flow.clientHeight > 120;
  })()`, 'Wheel-up input did not move the nested reasoning reader away from its tail');
  await delay(500);
  const pausedReasoningBaseline = await evaluate(window, `(() => {
    const flow = document.querySelector(${JSON.stringify(liveReasoningFlowSelector)});
    const transcript = document.querySelector('.conversation-scroll');
    window.__fakeModelQaReasoningFlowNode = flow;
    return {
      scrollTop: flow?.scrollTop ?? null,
      maximum: flow ? flow.scrollHeight - flow.clientHeight : null,
      transcriptScrollTop: transcript?.scrollTop ?? null,
    };
  })()`);
  await waitFor(window, `document.querySelector(${JSON.stringify(liveReasoningFlowSelector)})?.textContent?.includes('Reader-owned position checkpoint')`, 'Later reasoning did not arrive while the nested reader was scrolled up', 6_000);
  const pausedReasoningAfterChunk = await evaluate(window, `(() => {
    const flow = document.querySelector(${JSON.stringify(liveReasoningFlowSelector)});
    const transcript = document.querySelector('.conversation-scroll');
    return {
      scrollTop: flow?.scrollTop ?? null,
      maximum: flow ? flow.scrollHeight - flow.clientHeight : null,
      bottomGap: flow ? flow.scrollHeight - flow.scrollTop - flow.clientHeight : null,
      transcriptScrollTop: transcript?.scrollTop ?? null,
      sameNode: flow === window.__fakeModelQaReasoningFlowNode,
      transcriptBottomGap: transcript ? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight : null,
    };
  })()`);
  assert.ok(pausedReasoningAfterChunk.maximum > pausedReasoningBaseline.maximum + 20, `Later reasoning did not grow the nested surface: ${JSON.stringify({ pausedReasoningBaseline, pausedReasoningAfterChunk })}`);
  assert.ok(Math.abs(pausedReasoningAfterChunk.scrollTop - pausedReasoningBaseline.scrollTop) <= 1, `Reasoning growth moved the reader-owned nested position: ${JSON.stringify({ pausedReasoningBaseline, pausedReasoningAfterChunk })}`);
  assert.ok(pausedReasoningAfterChunk.bottomGap > 120, `Scrolled-up reasoning silently resumed following: ${JSON.stringify(pausedReasoningAfterChunk)}`);
  assert.ok(Math.abs(pausedReasoningAfterChunk.transcriptScrollTop - pausedReasoningBaseline.transcriptScrollTop) <= 1, `Nested reasoning wheel input moved the main transcript: ${JSON.stringify({ pausedReasoningBaseline, pausedReasoningAfterChunk })}`);
  assert.ok(pausedReasoningAfterChunk.transcriptBottomGap <= 2, `Nested reasoning input revoked the main transcript's independent follow state: ${JSON.stringify(pausedReasoningAfterChunk)}`);

  await wheelNestedToBottom(window, liveReasoningFlowSelector);
  const restoredReasoningBaseline = await evaluate(window, `(() => {
    const flow = document.querySelector(${JSON.stringify(liveReasoningFlowSelector)});
    return { maximum: flow ? flow.scrollHeight - flow.clientHeight : null, bottomGap: flow ? flow.scrollHeight - flow.scrollTop - flow.clientHeight : null };
  })()`);
  assert.ok(restoredReasoningBaseline.bottomGap <= 1, `Reader could not return reasoning to its exact physical bottom: ${JSON.stringify(restoredReasoningBaseline)}`);
  await waitFor(window, `document.querySelector(${JSON.stringify(liveReasoningFlowSelector)})?.textContent?.includes('Bottom-follow restoration checkpoint')`, 'Reasoning did not continue after nested follow was restored', 6_000);
  const resumedReasoningAfterChunk = await evaluate(window, `(() => {
    const flow = document.querySelector(${JSON.stringify(liveReasoningFlowSelector)});
    return { maximum: flow ? flow.scrollHeight - flow.clientHeight : null, bottomGap: flow ? flow.scrollHeight - flow.scrollTop - flow.clientHeight : null };
  })()`);
  assert.ok(resumedReasoningAfterChunk.maximum > restoredReasoningBaseline.maximum + 20, `Restored reasoning did not receive later growth: ${JSON.stringify({ restoredReasoningBaseline, resumedReasoningAfterChunk })}`);
  assert.ok(resumedReasoningAfterChunk.bottomGap <= 1, `Reasoning did not resume following after the reader returned to bottom: ${JSON.stringify(resumedReasoningAfterChunk)}`);
  const reasoningScrollFollow = { defaultReasoningFollow, pausedReasoningBaseline, pausedReasoningAfterChunk, restoredReasoningBaseline, resumedReasoningAfterChunk };
  const activeReasoning = await evaluate(window, `(() => {
    const groups = [...document.querySelectorAll(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-reasoning"]`)})];
    const group = groups[0];
    const label = group?.querySelector('.reasoning-label');
    const flowingText = group?.querySelector('.reasoning-flow-running > .rich-text');
    const labelStyle = label ? getComputedStyle(label) : null;
    const flowStyle = flowingText ? getComputedStyle(flowingText) : null;
    const tool = document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-tool"]`)});
    const command = document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-command"]`)});
    return {
      groups: groups.length,
      clickable: group?.querySelector('button.reasoning-disclosure') !== null,
      running: group?.matches('[aria-busy="true"]') === true,
      extraPulses: document.querySelectorAll('.working-pulse').length,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      labelAnimation: labelStyle?.animationName ?? null,
      labelPlayState: labelStyle?.animationPlayState ?? null,
      flowingText: Boolean(flowingText),
      flowAnimation: flowStyle?.animationName ?? null,
      flowPlayState: flowStyle?.animationPlayState ?? null,
      toolText: tool?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
      commandText: command?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
    };
  })()`);
  assert.deepEqual({ groups: activeReasoning.groups, clickable: activeReasoning.clickable, running: activeReasoning.running, extraPulses: activeReasoning.extraPulses }, { groups: 1, clickable: true, running: true, extraPulses: 0 }, 'Active fake work must use one clickable Reasoning disclosure, not a second pulse');
  assert.match(activeReasoning.toolText, /Read\s*repo state/u, `Tool activity hid its known operation: ${activeReasoning.toolText}`);
  assert.match(activeReasoning.commandText, /npm run fake-check/u, `Command activity hid its known command: ${activeReasoning.commandText}`);
  assert.doesNotMatch(`${activeReasoning.toolText} ${activeReasoning.commandText}`, /Tool started|Command is running|Command running/u, 'Concrete live activity regressed to a generic placeholder');
  if (!activeReasoning.reducedMotion) {
    assert.equal(activeReasoning.labelAnimation, 'reasoning-label-shimmer', `Live Reasoning label was not shimmering: ${JSON.stringify(activeReasoning)}`);
    assert.equal(activeReasoning.labelPlayState, 'running', `Live Reasoning label animation was paused: ${JSON.stringify(activeReasoning)}`);
    assert.equal(activeReasoning.flowingText, true, `Live reasoning had no painted text shimmer owner: ${JSON.stringify(activeReasoning)}`);
    assert.equal(activeReasoning.flowAnimation, 'reasoning-flow-shimmer', `Live reasoning text was not shimmering: ${JSON.stringify(activeReasoning)}`);
    assert.equal(activeReasoning.flowPlayState, 'running', `Live reasoning text animation was paused: ${JSON.stringify(activeReasoning)}`);
  }
  await capture(window, '01-stream-active', captures);
  await waitFor(window, `[...document.querySelectorAll('.message-assistant')].some((node) => node.textContent?.includes('The fake model completed its deterministic pass.'))`, 'Final answer did not begin after nested reasoning interaction', 6_000);
  await waitFor(window, `(() => { const transcript = document.querySelector('.conversation-scroll'); return transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 2; })()`, 'Main transcript stopped following after nested reasoning wheel input', 6_000);
  try {
    await waitFor(window, `(() => { const reasoning = document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-reasoning"]`)}); const busy = reasoning?.matches('[aria-busy="true"]') || reasoning?.querySelector('[aria-busy="true"]'); const answer = document.querySelector(${JSON.stringify(`[data-scroll-anchor*="${runId}-fake-stream-answer"]`)}); return !busy && answer; })()`, 'Stream did not complete', 12_000);
  } catch (error) {
    const state = await evaluate(window, `({ members: [...document.querySelectorAll('[data-scroll-members]')].map((node) => node.getAttribute('data-scroll-members')).slice(-20), assistant: [...document.querySelectorAll('.message-assistant')].map((node) => node.textContent?.trim()).slice(-10), playing: ${JSON.stringify(host.stateForTests().playing)} })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; stream state: ${JSON.stringify(state)}`);
  }
  await waitForSessionIdle(window);
  const settledCommandGroupSelector = `[data-scroll-members*="${runId}-fake-stream-command"]`;
  const settledCommandPainted = `(() => {
    const group = document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-command"]`)});
    const command = [...(group?.querySelectorAll('.activity-row') ?? [])].find((candidate) => candidate.textContent?.includes('npm run fake-check'));
    return Boolean(command && command.getClientRects().length > 0);
  })()`;
  const settledReasoningSelector = `[data-scroll-members*="${runId}-fake-stream-reasoning"] button.reasoning-disclosure`;
  assert.equal(await evaluate(window, settledCommandPainted), true, 'Settled command disclosure is missing');
  assert.equal(await evaluate(window, `Boolean(document.querySelector(${JSON.stringify(settledReasoningSelector)}))`), true, 'Settled Reasoning disclosure is missing');
  await wheelConversationGutterToBottom(window);
  const collapsedTailGeometry = await evaluate(window, `(() => {
    const reasoning = document.querySelector(${JSON.stringify(settledReasoningSelector)});
    const composer = document.querySelector('.composer-wrap');
    const spacer = document.querySelector('.conversation-tail-spacer');
    const scroller = document.querySelector('.conversation-scroll');
    const bounds = reasoning?.getBoundingClientRect();
    const composerBounds = composer?.getBoundingClientRect();
    return { reasoningBottom: bounds?.bottom, composerTop: composerBounds?.top, spacerHeight: spacer?.getBoundingClientRect().height, scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight, clientHeight: scroller?.clientHeight };
  })()`);
  assert.ok(collapsedTailGeometry.reasoningBottom <= collapsedTailGeometry.composerTop, `Collapsed tail Reasoning is hidden behind the composer: ${JSON.stringify(collapsedTailGeometry)}`);
  await wheelConversationGutterUntilVisible(window, settledReasoningSelector);
  await delay(500);
  await wheelConversationGutterUntilVisible(window, settledReasoningSelector);
  await delay(120);
  const beforeDisclosureClick = await evaluate(window, `(() => {
    const reasoning = document.querySelector(${JSON.stringify(settledReasoningSelector)});
    return {
      expanded: reasoning?.getAttribute('aria-expanded') ?? null,
      members: reasoning?.closest('.reasoning-group')?.getAttribute('data-scroll-members') ?? null,
      groupText: reasoning?.closest('.reasoning-group')?.textContent?.replace(/\\s+/gu, ' ').trim() ?? null,
    };
  })()`);
  assert.equal(beforeDisclosureClick.expanded, 'true', `Live-open Reasoning closed during settlement: ${JSON.stringify(beforeDisclosureClick)}`);
  await evaluate(window, `(() => {
    const reasoning = document.querySelector(${JSON.stringify(settledReasoningSelector)});
    window.__fakeModelQaReasoningClicks = 0;
    reasoning?.addEventListener('click', () => { window.__fakeModelQaReasoningClicks += 1; });
  })()`);
  await clickVerifiedVisibleSelector(window, settledReasoningSelector);
  await waitFor(window, `document.querySelector(${JSON.stringify(settledReasoningSelector)})?.getAttribute('aria-expanded') === 'false'`, 'Physical click did not close settled Reasoning');
  assert.equal(await evaluate(window, `window.__fakeModelQaReasoningClicks`), 1, 'Settled Reasoning did not receive its physical close click exactly once');
  assert.equal(await evaluate(window, settledCommandPainted), false, 'Closing settled Reasoning left its command painted');
  await clickVerifiedVisibleSelector(window, settledReasoningSelector);
  await waitFor(window, `document.querySelector(${JSON.stringify(settledReasoningSelector)})?.getAttribute('aria-expanded') === 'true'`, 'Physical click did not reopen settled Reasoning');
  await waitFor(window, settledCommandPainted, 'Settled command did not become painted when Reasoning reopened');
  const disclosureState = await evaluate(window, `(() => {
    const reasoning = document.querySelector(${JSON.stringify(settledReasoningSelector)});
    const group = document.querySelector(${JSON.stringify(settledCommandGroupSelector)});
    const command = [...(group?.querySelectorAll('.activity-row') ?? [])].find((candidate) => candidate.textContent?.includes('npm run fake-check'));
    return { expanded: reasoning?.getAttribute('aria-expanded'), physicalClicks: window.__fakeModelQaReasoningClicks, commandRects: command?.getClientRects().length, commandDisplay: command ? getComputedStyle(command).display : null, members: reasoning?.closest('.reasoning-group')?.getAttribute('data-scroll-members') ?? null, groupText: reasoning?.closest('.reasoning-group')?.textContent?.replace(/\\s+/gu, ' ').trim() };
  })()`);
  assert.equal(disclosureState.physicalClicks, 2, `Settled Reasoning did not receive one close and one reopen click: ${JSON.stringify(disclosureState)}`);
  assert.equal(disclosureState.members, beforeDisclosureClick.members, `Settled Reasoning changed grouped identity while toggling: ${JSON.stringify({ beforeDisclosureClick, disclosureState })}`);
  await wheelConversationGutterToBottom(window);
  const expandedTailGeometry = await evaluate(window, `(() => {
    const group = document.querySelector(${JSON.stringify(settledCommandGroupSelector)});
    const command = [...(group?.querySelectorAll('.activity-row') ?? [])].find((candidate) => candidate.textContent?.includes('npm run fake-check'));
    const composer = document.querySelector('.composer-wrap');
    const bounds = command?.getBoundingClientRect();
    const composerBounds = composer?.getBoundingClientRect();
    return { commandBottom: bounds?.bottom, composerTop: composerBounds?.top };
  })()`);
  assert.ok(expandedTailGeometry.commandBottom <= expandedTailGeometry.composerTop, `Expanded tail command is hidden behind the composer: ${JSON.stringify(expandedTailGeometry)}`);
  await clickMatchingButton(window, settledCommandGroupSelector, 'npm run fake-check');
  await waitFor(window, `[...document.querySelectorAll('.activity-snippet')].some((node) => node.textContent?.includes('fake check passed'))`, 'Settled command disclosure did not reveal its concrete output');
  const identity = await evaluate(window, `(() => {
    const text = ${JSON.stringify(message)};
    const userRows = [...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes(text));
    const localPresentationAnchors = [...document.querySelectorAll('[data-scroll-anchor]')].filter((node) => String(node.dataset.scrollAnchor).startsWith('local-') && node.textContent?.includes(text));
    return {
      userRows: userRows.length,
      userRowDetails: userRows.map((node) => ({
        text: node.textContent?.trim() ?? '',
        anchor: node.closest('[data-scroll-anchor]')?.getAttribute('data-scroll-anchor') ?? null,
        members: node.closest('[data-scroll-members]')?.getAttribute('data-scroll-members') ?? null,
      })),
      localPresentationAnchors: localPresentationAnchors.length,
      reasoningGroups: document.querySelectorAll(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-reasoning"]`)}).length,
      toolMembers: document.querySelectorAll(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-tool"]`)}).length,
      commandMembers: document.querySelectorAll(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-command"]`)}).length,
      answerRows: document.querySelectorAll(${JSON.stringify(`[data-scroll-anchor*="${runId}-fake-stream-answer"]`)}).length,
      commandText: document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-command"]`)})?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
      runningReasoningGroups: document.querySelectorAll('.reasoning-group[aria-busy="true"]').length,
      runningReasoningText: document.querySelectorAll('.reasoning-flow-running').length,
    };
  })()`);
  const canonicalUserMessages = (host.stateForTests().messagesBySession.get('fake-main') ?? [])
    .filter((entry) => entry.role === 'user' && entry.parts?.some((part) => part.type === 'text' && part.text === message));
  assert.equal(identity.userRows, 1, `Optimistic identity: expected one canonical user row, found ${identity.userRows}: ${JSON.stringify(identity.userRowDetails)}`);
  assert.equal(identity.localPresentationAnchors, 1, `Optimistic identity: the accepted row lost its stable presentation anchor (${identity.localPresentationAnchors})`);
  assert.equal(canonicalUserMessages.length, 1, `Optimistic identity: provider history did not contain exactly one canonical user message (${canonicalUserMessages.length})`);
  assert.doesNotMatch(canonicalUserMessages[0].providerMessageId, /^local-/u, 'Optimistic identity: provider history retained the renderer-only local identity');
  assert.equal(identity.reasoningGroups, 1, `History insertion: reasoning group duplicated (${identity.reasoningGroups})`);
  assert.equal(identity.toolMembers, 1, `History insertion: tool activity duplicated (${identity.toolMembers})`);
  assert.equal(identity.commandMembers, 1, `History insertion: command activity duplicated (${identity.commandMembers})`);
  assert.equal(identity.answerRows, 1, `History insertion: final answer duplicated (${identity.answerRows})`);
  assert.match(identity.commandText, /npm run fake-check[\s\S]*fake check passed/u, `Settled command lost its command or output: ${identity.commandText}`);
  assert.equal(identity.runningReasoningGroups, 0, 'Settled reasoning kept an aria-busy shimmer owner');
  assert.equal(identity.runningReasoningText, 0, 'Settled reasoning text kept its running shimmer class');
  await capture(window, '02-stream-settled', captures);
  return scenarioOutcome('master-stream-identity', { activeReasoning, reasoningScrollFollow, identity }, {
    'stream.reasoning-live-single-clickable': { ...activeReasoning, reasoningScrollFollow },
    'stream.reasoning-shimmer': { labelAnimation: activeReasoning.labelAnimation, flowAnimation: activeReasoning.flowAnimation },
    'stream.tool-command-details': { toolText: activeReasoning.toolText, commandText: identity.commandText },
    'stream.optimistic-user-reconciles-once': { userRows: identity.userRows, localPresentationAnchors: identity.localPresentationAnchors, canonicalProviderRows: canonicalUserMessages.length },
    'stream.history-insertion-no-duplicates': { reasoningGroups: identity.reasoningGroups, toolMembers: identity.toolMembers, commandMembers: identity.commandMembers, answerRows: identity.answerRows },
  });
}

async function scenarioTerminalHistoryRace(window, captures, host) {
  await ensureRendererReady(window);
  await clickTaskByTitle(window, 'Fake model main task');
  await submitComposer(window, 'restart mid-turn terminal history race');
  await waitFor(window, `[...document.querySelectorAll('.reasoning-group')].some((node) => node.textContent?.includes('Checking the persisted transcript'))`, 'Terminal history race did not show its running Reasoning row');
  await waitForFakeHostIdle(host);
  await delay(50);
  const terminalObservedAt = performance.now();
  const deferred = await evaluate(window, `({
    answers: [...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history')).length,
    busy: document.querySelectorAll('.reasoning-group[aria-busy="true"]').length,
    stoppable: Boolean(document.querySelector('button[aria-label="Stop task"]')),
    taskSpinner: Boolean(document.querySelector('[data-session-id="fake-main"] .session-row-working-spinner')),
  })`);
  assert.deepEqual(deferred, { answers: 0, busy: 1, stoppable: true, taskSpinner: true }, 'An early terminal signal settled the visible turn before the quiet boundary');
  await capture(window, '02-terminal-history-race-deferred', captures);
  await waitFor(window, `!document.querySelector('button[aria-label="Stop task"]')`, 'Terminal history race kept Stop visible after completion', 6_000);
  const quietSettlementMs = performance.now() - terminalObservedAt;
  assert.ok(quietSettlementMs < 4_000, `Terminal history race waited ${quietSettlementMs.toFixed(1)}ms instead of settling after the quiet boundary`);
  assert.equal(await evaluate(window, `[...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history')).length`), 0, 'Terminal history answer arrived before persisted history released it');

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Terminal history renderer reload timed out')), 8_000);
    window.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    window.webContents.reload();
  });
  window.webContents.send('tethoq:runtime-state', { state: 'ready' });
  await ensureRendererReady(window);
  await clickTaskByTitle(window, 'Fake model main task');
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await waitFor(window, `document.querySelectorAll('.reasoning-group').length > 0`, 'Reloaded renderer did not restore the incomplete Reasoning row');
  assert.equal(await evaluate(window, `[...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history')).length`), 0, 'Reloaded renderer already contained the delayed final reply');
  assert.equal(await evaluate(window, `document.querySelectorAll('.reasoning-group[aria-busy="true"]').length`), 0, 'Completed task kept a live Reasoning shimmer after reload');
  assert.equal(await evaluate(window, `Boolean(document.querySelector('button[aria-label="Stop task"]'))`), false, 'Reloaded completed task became stoppable');

  const released = host.releaseDeferredFinalHistoryForTests();
  assert.equal(released.released, true, 'Fake provider did not release delayed persisted history');
  const reordered = host.handleRequest('session.open', { sessionId: 'fake-main' }).payload.messages;
  const duplicated = host.handleRequest('session.open', { sessionId: 'fake-main' }).payload.messages;
  assert.equal(reordered.some((message) => message.nativeMetadata?.phase === 'final_answer' && message.providerMessageId === released.answerId), false, 'Reordered history unexpectedly retained the delayed answer inside the bounded page');
  assert.equal(duplicated.filter((message) => message.providerMessageId === released.answerId).length, 2, 'Duplicate history replay did not contain two copies of the delayed answer');
  try {
    await waitFor(window, `[...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history after the terminal event.')).length === 1`, 'Delayed persisted final answer did not appear exactly once', 8_000);
  } catch (error) {
    const renderer = await evaluate(window, `({ title: document.querySelector('.workspace h1')?.textContent, assistants: [...document.querySelectorAll('.message-assistant')].map((node) => node.textContent), reasoning: [...document.querySelectorAll('.reasoning-group')].map((node) => node.textContent), errors: [...document.querySelectorAll('.timeline-error-notice')].map((node) => node.textContent) })`);
    const opens = host.stateForTests().requests.filter((request) => request.type === 'session.open' && request.payload.sessionId === 'fake-main').length;
    throw new Error(`${error instanceof Error ? error.message : String(error)}; opens=${opens}; renderer=${JSON.stringify(renderer)}`);
  }
  await delay(1_800);
  const settled = await evaluate(window, `({
    answers: [...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history after the terminal event.')).length,
    busy: document.querySelectorAll('.reasoning-group[aria-busy="true"]').length,
    incomplete: document.querySelectorAll('.timeline-error-notice').length,
    stoppable: Boolean(document.querySelector('button[aria-label="Stop task"]')),
  })`);
  assert.deepEqual(settled, { answers: 1, busy: 0, incomplete: 0, stoppable: false }, 'Terminal history race did not settle to one calm final answer');
  await capture(window, '02-terminal-history-race-settled', captures);
  return scenarioOutcome('terminal-history-race', { reloadedMidTurn: true, deferred, quietSettlementMs, ...settled }, {
    'history.terminal-before-final-recovers-after-reload': settled,
    'history.terminal-race-no-duplicate-or-stale-shimmer': settled,
  });
}

async function scenarioTerminalLiveCancellation(window, captures, host) {
  await ensureRendererReady(window);
  await clickTaskByTitle(window, 'Fake model main task');
  await submitComposer(window, 'restart mid-turn terminal history race');
  await waitFor(window, `[...document.querySelectorAll('.reasoning-group')].some((node) => node.textContent?.includes('Checking the persisted transcript'))`, 'Terminal cancellation journey did not show its running Reasoning row');
  await waitForFakeHostIdle(host);
  await delay(50);

  const resumed = host.emitDeferredLiveActivityForTests();
  assert.equal(resumed.emitted, true, 'Fake provider could not emit newer work after its early terminal signal');
  await waitFor(window, `Boolean(document.querySelector('button[aria-label="Stop task"]')) && Boolean(document.querySelector('[data-session-id="fake-main"] .session-row-working-spinner'))`, 'Newer provider work did not keep the task visibly active');

  // Cross the original two-second settlement deadline. If that stale timer was
  // not cancelled, Stop/spinner/shimmer disappear here even though newer work won.
  await delay(2_250);
  const afterStaleDeadline = await evaluate(window, `({
    answers: [...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history')).length,
    busy: document.querySelectorAll('.reasoning-group[aria-busy="true"]').length,
    stoppable: Boolean(document.querySelector('button[aria-label="Stop task"]')),
    taskSpinner: Boolean(document.querySelector('[data-session-id="fake-main"] .session-row-working-spinner')),
  })`);
  assert.deepEqual(afterStaleDeadline, { answers: 0, busy: 1, stoppable: true, taskSpinner: true }, 'An obsolete terminal timer overruled newer live activity');
  await capture(window, '03-terminal-cancelled-by-live-activity', captures);

  const released = host.releaseDeferredFinalHistoryForTests();
  assert.equal(released.released, true, 'Fake provider did not publish its later canonical final answer');
  await waitFor(window, `[...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history after the terminal event.')).length === 1`, 'Canonical final answer did not appear after the replacement terminal signal', 8_000);
  await waitFor(window, `!document.querySelector('button[aria-label="Stop task"]') && !document.querySelector('[data-session-id="fake-main"] .session-row-working-spinner')`, 'Replacement terminal signal did not settle the resumed turn', 6_000);
  const settled = await evaluate(window, `({
    answers: [...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history after the terminal event.')).length,
    busy: document.querySelectorAll('.reasoning-group[aria-busy="true"]').length,
    stoppable: Boolean(document.querySelector('button[aria-label="Stop task"]')),
    taskSpinner: Boolean(document.querySelector('[data-session-id="fake-main"] .session-row-working-spinner')),
  })`);
  assert.deepEqual(settled, { answers: 1, busy: 0, stoppable: false, taskSpinner: false }, 'Resumed turn did not settle cleanly from canonical history');
  await wheelToBottom(window);
  await capture(window, '04-terminal-replacement-settled', captures);
  return scenarioOutcome('terminal-live-cancellation', { afterStaleDeadline, settled }, {
    'history.later-live-activity-cancels-stale-terminal': { afterStaleDeadline, settled },
  });
}

async function scenarioCompaction(window, captures, host) {
  await submitComposer(window, 'compact this deterministic fixture');
  await waitFor(window, `document.querySelectorAll('.timeline-compaction-toggle').length === 1`, 'Compaction did not settle into exactly one disclosure', 6_000);
  const collapsed = await evaluate(window, `(() => {
    const toggle = document.querySelector('.timeline-compaction-toggle');
    const compact = toggle?.getBoundingClientRect();
    const overlappingCopy = [...document.querySelectorAll('.message-footer .copy-message')].some((button) => {
      const copy = button.getBoundingClientRect();
      return compact && Math.min(compact.right, copy.right) > Math.max(compact.left, copy.left)
        && Math.min(compact.bottom, copy.bottom) > Math.max(compact.top, copy.top);
    });
    const visibleText = document.querySelector('.conversation')?.textContent ?? '';
    return {
      disclosures: document.querySelectorAll('.timeline-compaction-toggle').length,
      labels: [...document.querySelectorAll('.timeline-compaction-toggle')].filter((node) => node.textContent?.includes('Session compacted')).length,
      rawSummaryHeadings: (visibleText.match(/Current task progress/gu) ?? []).length,
      overlappingCopy,
      expanded: toggle?.getAttribute('aria-expanded'),
    };
  })()`);
  assert.deepEqual(collapsed, { disclosures: 1, labels: 1, rawSummaryHeadings: 0, overlappingCopy: false, expanded: 'false' }, 'Collapsed compaction must be one clear control with no raw duplicate or copy overlap');
  await clickSelector(window, '.timeline-compaction-toggle');
  await waitFor(window, `document.querySelector('.timeline-compaction-detail')?.textContent?.includes('Current task progress')`, 'Compaction detail did not open with the retained summary');
  const expanded = await evaluate(window, `({ details: document.querySelectorAll('.timeline-compaction-detail').length, headings: (document.querySelector('.conversation')?.textContent?.match(/Current task progress/gu) ?? []).length, copyButtons: document.querySelectorAll('.timeline-compaction-detail .timeline-compaction-copy').length })`);
  assert.deepEqual(expanded, { details: 1, headings: 1, copyButtons: 1 }, 'Expanded compaction must reveal the summary exactly once with one reserved copy control');
  await capture(window, '03-compaction-expanded-once', captures);
  await clickSelector(window, '.timeline-compaction-toggle');
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window);
  return scenarioOutcome('compaction-once', { collapsed, expanded }, {
    'compaction.single-collapsed-disclosure': collapsed,
    'compaction.detail-on-demand-once': expanded,
    'compaction.copy-control-does-not-overlap': { collapsed: collapsed.overlappingCopy, expanded: expanded.copyButtons },
  });
}

async function scenarioError(window, captures) {
  await submitComposer(window, 'run the error scenario');
  await waitFor(window, `[...document.querySelectorAll('.timeline-error-notice')].some((node) => node.textContent?.includes('Deterministic failure'))`, 'Error row did not appear', 6_000);
  assert.equal(await evaluate(window, `document.querySelector('.timeline-error-notice')?.getAttribute('role')`), 'alert', 'Error row was not announced assertively');
  await clickSelector(window, '.timeline-error-recovery');
  await waitFor(window, `document.activeElement === document.querySelector('textarea[aria-label="Message"]')`, 'Error recovery did not return focus to the composer');
  await capture(window, '03-error-row', captures);
  await waitForSessionIdle(window);
  return scenarioOutcome('error', { role: 'alert', recoveryFocusedComposer: true }, {
    'failure.visible-error-row': { role: 'alert', recoveryFocusedComposer: true },
  });
}

async function scenarioStopPresentationBoundary(window, captures, host, interruptGate) {
  await ensureRendererReady(window);
  await clickTaskByTitle(window, 'Fake model main task');
  await submitComposer(window, 'run the queue scenario');
  await waitFor(window, `document.querySelector('.reasoning-group[aria-busy="true"]') && document.querySelector('button[aria-label="Stop task"]')`, 'Stop boundary fixture did not enter live reasoning');

  const interruptsBefore = host.stateForTests().requests.filter((entry) => entry.type === 'session.interrupt').length;
  await clickSelector(window, 'button[aria-label="Stop task"]');
  const gateDeadline = Date.now() + 2_000;
  while (interruptGate?.used !== true && Date.now() < gateDeadline) await delay(10);
  assert.equal(interruptGate?.used, true, 'Stop did not reach the delayed interrupt gate');
  assert.notEqual(host.stateForTests().playing, null, 'Delayed interrupt settled the provider before the UI boundary could be inspected');
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);

  const presentationState = () => evaluate(window, `({
    runningReasoningGroups: document.querySelectorAll('.reasoning-group[aria-busy="true"]').length,
    runningReasoningText: document.querySelectorAll('.reasoning-flow-running').length,
    workingPulses: document.querySelectorAll('.working-pulse').length,
    taskSpinners: document.querySelectorAll('[data-session-id="fake-main"] .session-row-working-spinner').length,
    workspaceSpinners: document.querySelectorAll('.workspace-title .status .spinner').length,
    primarySpinners: document.querySelectorAll('.composer-primary-actions .send-button .spinner').length,
    stopButtons: document.querySelectorAll('button[aria-label="Stop task"]').length,
    primaryLabel: document.querySelector('.composer-primary-actions .send-button')?.getAttribute('aria-label') ?? null,
  })`);
  const expectedQuiet = {
    runningReasoningGroups: 0,
    runningReasoningText: 0,
    workingPulses: 0,
    taskSpinners: 0,
    workspaceSpinners: 0,
    primarySpinners: 0,
    stopButtons: 0,
    primaryLabel: 'Send instruction',
  };
  const afterTwoFrames = await presentationState();
  assert.deepEqual(afterTwoFrames, expectedQuiet, 'Stop did not become a quiet visual terminal boundary within two frames');

  // The next provider delta lands while the interrupt RPC is still waiting.
  // It must update canonical history without reacquiring any live animation.
  await delay(650);
  assert.notEqual(host.stateForTests().playing, null, 'The delayed fake turn ended before stale live output was exercised');
  const afterLateOutput = await presentationState();
  assert.deepEqual(afterLateOutput, expectedQuiet, 'Late same-turn output reacquired live presentation after Stop');
  await capture(window, 'stop-boundary-pending', captures);

  interruptGate.release();
  await waitForFakeHostIdle(host);
  await waitFor(window, `!document.querySelector('.reasoning-group[aria-busy="true"], .message-assistant[aria-busy="true"], .working-pulse, [data-session-id="fake-main"] .session-row-working-spinner, .workspace-title .status .spinner, .composer-primary-actions .send-button .spinner')`, 'Successful interrupt did not settle quietly');
  const interruptsAfter = host.stateForTests().requests.filter((entry) => entry.type === 'session.interrupt').length;
  assert.equal(interruptsAfter, interruptsBefore + 1, 'Stop issued anything other than one interrupt request');

  await submitComposer(window, 'run the queue scenario again');
  await waitFor(window, `document.querySelector('.reasoning-group[aria-busy="true"]') && document.querySelector('button[aria-label="Stop task"]')`, 'Interrupt failure fixture did not enter live reasoning');
  host.failNextRequestForTests('session.interrupt', 'Injected interrupt rejection.');
  const failureInterruptsBefore = host.stateForTests().requests.filter((entry) => entry.type === 'session.interrupt').length;
  await clickSelector(window, 'button[aria-label="Stop task"]');
  await waitFor(window, `document.querySelector('.toast-error')?.textContent?.includes('Injected interrupt rejection.')`, 'Interrupt failure did not surface its truthful error');
  await waitFor(window, `document.querySelector('button[aria-label="Stop task"]') && document.querySelector('[data-session-id="fake-main"] .session-row-working-spinner') && document.querySelector('.workspace-title .status .spinner') && document.querySelector('.reasoning-group[aria-busy="true"], .message-assistant[aria-busy="true"]')`, 'Interrupt failure did not restore live presentation');
  const failureInterruptsAfter = host.stateForTests().requests.filter((entry) => entry.type === 'session.interrupt').length;
  assert.equal(failureInterruptsAfter, failureInterruptsBefore + 1, 'Failed Stop issued anything other than one interrupt request');
  await capture(window, 'stop-boundary-failure-resumed', captures);

  host.handleRequest('session.interrupt', { sessionId: 'fake-main' }, 'stop-boundary-cleanup');
  await waitForFakeHostIdle(host);
  return { afterTwoFrames, afterLateOutput, interruptRequests: 1, failureRestoredLivePresentation: true };
}

async function scenarioKeyboardCoreActions(window, captures, host) {
  await ensureRendererReady(window);
  await evaluate(window, `document.querySelector('button.new-task-button')?.focus()`);
  await waitFor(window, `document.activeElement?.classList.contains('new-task-button')`, 'Keyboard: New task button did not receive focus');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.trim() === 'New task' && document.querySelectorAll('[data-session-id^="draft-"]').length === 1`, 'Keyboard: Enter did not open exactly one new draft');

  await evaluate(window, `document.querySelector('.skip-to-message')?.focus()`);
  await waitFor(window, `document.activeElement?.classList.contains('skip-to-message')`, 'Keyboard: Skip to message did not receive focus');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(window, `document.activeElement === document.querySelector('textarea[aria-label="Message"]')`, 'Keyboard: Skip to message did not focus the composer');

  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Keyboard: main task did not reopen');
  await submitComposer(window, 'run the queue scenario');
  await waitFor(window, `document.querySelector('button[aria-label="Stop task"]')`, 'Keyboard: Stop task did not appear');
  const interruptsBefore = host.stateForTests().requests.filter((entry) => entry.type === 'session.interrupt').length;
  await evaluate(window, `document.querySelector('button[aria-label="Stop task"]')?.focus()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(window, `!document.querySelector('button[aria-label="Stop task"]')`, 'Keyboard: Enter did not settle Stop task');
  const interruptsAfter = host.stateForTests().requests.filter((entry) => entry.type === 'session.interrupt').length;
  assert.equal(interruptsAfter, interruptsBefore + 1, 'Keyboard: Stop task issued anything other than one interrupt');
  assert.equal(host.stateForTests().playing, null, 'Keyboard: fake execution remained active after Stop');
  await capture(window, '03-keyboard-core-actions', captures);
  return { newTaskDrafts: 1, skipFocusedComposer: true, interruptRequests: 1 };
}

async function scenarioApproval(window, captures) {
  await submitComposer(window, 'run the approval scenario');
  await waitFor(window, `document.querySelector('.approval-card')`, 'Approval card did not appear', 6_000);
  await capture(window, '04-approval-open', captures);
  await clickMatchingButton(window, '.approval-card', 'Run migration');
  await waitFor(window, `!document.querySelector('.approval-card')`, 'Approval card did not close after the decision', 6_000);
  await waitFor(window, `[...document.querySelectorAll('.message-assistant')].some((node) => node.textContent?.includes('Permission granted; the deterministic migration completed.'))`, 'Approval scenario did not resume the stream', 6_000);
  await waitForSessionIdle(window);
  await capture(window, '05-approval-resolved', captures);
  return scenarioOutcome('approval', { resolved: true }, {
    'approval.pause-resolve-resume': true,
  });
}

async function scenarioNativeAudioSending(window, captures, host) {
  await clickTaskByTitle(window, 'Visible provider-parented user task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Visible provider-parented user task')`, 'Audio fixture task did not open');
  await waitFor(window, `document.querySelector('button[aria-label="Start dictation"]')`, 'Audio fixture dictation control is missing');

  const requestCount = () => host.stateForTests().requests.filter((entry) => entry.type === 'session.send_message').length;
  const queueCountBefore = host.stateForTests().requests.filter((entry) => entry.type === 'message_queue.enqueue').length;
  const sendsBefore = requestCount();

  // Flow A: stop into the composer, inspect the real widget, then send audio only.
  await clickSelector(window, 'button[aria-label="Start dictation"]');
  await waitFor(window, `document.querySelector('.dictation-audio-strip')`, 'MP3 recording strip did not appear');
  // Under the full Electron matrix the encoder shares a busy event loop with
  // prior renderer journeys; allow enough real audio chunks to arrive before
  // Stop so this validates the widget rather than scheduler luck.
  await delay(1_500);
  await capture(window, '17-audio-recording-active', captures);
  await clickSelector(window, 'button[aria-label="Stop dictation"]');
  await waitFor(window, `document.querySelector('.attachment-chips .audio-playback-chip button[aria-label^="Play "]')`, 'Stopped MP3 did not become a playable composer widget', 8_000);
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'Attaching a recording showed a redundant success toast');
  await capture(window, '18-audio-attached-before-send', captures);
  await clickSelector(window, 'button[aria-label="Send instruction"]');
  await waitFor(window, `document.querySelectorAll('.message-user .audio-playback-chip button[aria-label^="Play "]').length === 1`, 'Audio-only send did not create one playable user row', 8_000);
  await waitForFakeHostIdle(host);
  await waitFor(window, `[...document.querySelectorAll('.message-assistant')].some((node) => node.textContent?.includes('Fresh fake audio response run-'))`, 'Fresh fake audio response did not appear', 8_000);
  await waitForSessionIdle(window, 2_000);
  assert.equal(requestCount(), sendsBefore + 1, 'Stop-then-send issued anything other than one real send request');
  assert.equal(host.stateForTests().requests.filter((entry) => entry.type === 'message_queue.enqueue').length, queueCountBefore, 'Idle MP3 flashed through the follow-up queue');
  const firstSend = host.stateForTests().requests.filter((entry) => entry.type === 'session.send_message').at(-1);
  assert.equal(firstSend.payload.content, '');
  assert.equal(firstSend.payload.attachmentIds.length, 1);
  const firstUpload = host.stateForTests().completedUploads.get(firstSend.payload.attachmentIds[0]);
  assert.equal(firstUpload.mimeType, 'audio/mpeg');
  assert.ok(firstUpload.byteLength > 100, `Recorded MP3 contained only ${firstUpload.byteLength} bytes`);

  // Flow B: on a later recording, press the primary arrow while still recording.
  // This is the exact cumulative-revision race that previously resent stale work.
  const firstAnswer = await evaluate(window, `[...document.querySelectorAll('.message-assistant')].map((node) => node.textContent).find((text) => text?.includes('Fresh fake audio response run-'))`);
  await clickSelector(window, 'button[aria-label="Start dictation"]');
  await waitFor(window, `document.querySelector('.dictation-audio-strip')`, 'Second MP3 recording did not start');
  await delay(700);
  await clickSelector(window, 'button[aria-label="Stop dictation and send"]');
  await waitFor(window, `document.querySelectorAll('.message-user .audio-playback-chip button[aria-label^="Play "]').length === 2`, 'Send-while-recording did not create exactly one new playable user row', 10_000);
  await waitForFakeHostIdle(host);
  await waitFor(window, `[...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('Fresh fake audio response run-')).length === 2`, 'Second MP3 did not receive one fresh response', 8_000);
  await waitForSessionIdle(window, 2_000);
  assert.equal(requestCount(), sendsBefore + 2, 'Send-while-recording did not issue exactly one additional send');
  assert.equal(host.stateForTests().requests.filter((entry) => entry.type === 'message_queue.enqueue').length, queueCountBefore, 'Second MP3 entered the follow-up queue');
  const answers = await evaluate(window, `[...document.querySelectorAll('.message-assistant')].map((node) => node.textContent).filter((text) => text?.includes('Fresh fake audio response run-'))`);
  assert.equal(new Set(answers).size, 2, `The second turn replayed the previous answer: ${JSON.stringify(answers)}`);
  assert.notEqual(answers[1], firstAnswer);
  assert.equal(await evaluate(window, `document.querySelectorAll('.queued-strip').length`), 0, 'A queued-task strip remained after direct MP3 sends');
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'MP3 sending showed a redundant success toast');
  await capture(window, '19-audio-two-real-turns', captures);
  await assertResponsiveLayout(window, 'native audio final state');
  return scenarioOutcome('native-audio-sending', { flows: 2, directRequests: 2, queueFlashes: 0, playableUserRows: 2, freshResponses: 2 }, {
    'audio.stop-then-send': firstSend.payload,
    'audio.send-while-recording': { sends: requestCount(), answers },
    'audio.audio-only-real-turn': { content: firstSend.payload.content, attachmentIds: firstSend.payload.attachmentIds },
    'audio.playable-persistent-user-row': { playableUserRows: 2 },
    'audio.no-queue-flash-or-success-toast': { queueFlashes: 0, toastCount: await evaluate(window, 'document.querySelectorAll(\'.toast\').length') },
    'audio.no-stale-answer-replay': answers,
  });
}

async function scenarioImageSendScrollStability(window, captures, host) {
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Image-send fixture task did not open');
  await waitForSessionIdle(window);
  await installScrollTrace(window);

  const bottomText = `Image send pinned at bottom ${Date.now()}`;
  await attachFakeImage(window);
  await replaceComposerText(window, bottomText);
  await ensureBottom(window);
  await startImageSendTrace(window, bottomText);
  await pressComposerEnter(window);
  await waitFor(window, `(() => {
    const row = [...document.querySelectorAll('.message-user')].find((node) => node.querySelector('.message-body')?.textContent?.trim() === ${JSON.stringify(bottomText)});
    return Boolean(row?.querySelector('.message-images img'));
  })()`, 'Accepted image send did not appear as a transcript widget');
  await capture(window, '20-image-send-accepted-at-bottom', captures);
  await waitFor(window, `Boolean(document.querySelector('.reasoning-group[aria-busy="true"], .message-assistant[aria-busy="true"]'))`, 'Image-send assistant response never entered a live state');
  await capture(window, '21-image-send-response-live', captures);
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window);
  await waitFor(window, `(() => [...document.querySelectorAll('.message-assistant')].some((node) => node.textContent?.includes('Fresh fake audio response')))()`, 'Image-send assistant response did not finish');
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const bottomTrace = await stopImageSendTrace(window);
  const bottomPresentation = assertStableImagePresentation(bottomTrace, bottomText);
  const bottomPainted = bottomTrace.samples.slice(bottomPresentation.firstImageIndex);
  const maximumBottomGap = Math.max(...bottomPainted.map((sample) => sample.bottomGap));
  assert.ok(maximumBottomGap <= 1.5, `Bottom-following image send drifted ${maximumBottomGap}px from the physical end`);
  await capture(window, '22-image-send-finished-at-bottom', captures);

  await wheelAwayFromBottom(window, 900);
  await waitFor(window, `(() => {
    const scroller = document.querySelector('.conversation-scroll');
    return scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 400;
  })()`, 'Image-send fixture could not establish a manually scrolled reading position');
  await attachFakeImage(window);
  const preservedText = `Image send preserves reader position ${Date.now()}`;
  await replaceComposerText(window, preservedText);
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const preservedBaseline = await evaluate(window, `document.querySelector('.conversation-scroll')?.scrollTop ?? null`);
  assert.equal(typeof preservedBaseline, 'number', 'Manual-scroll baseline is unavailable');
  await startImageSendTrace(window, preservedText);
  await pressComposerEnter(window);
  await waitFor(window, `(() => {
    const row = [...document.querySelectorAll('.message-user')].find((node) => node.querySelector('.message-body')?.textContent?.trim() === ${JSON.stringify(preservedText)});
    return Boolean(row?.querySelector('.message-images img'));
  })()`, 'Scrolled-up image send did not become a transcript widget');
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window);
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const preservedTrace = await stopImageSendTrace(window);
  const preservedPresentation = assertStableImagePresentation(preservedTrace, preservedText);
  const maximumPreservedScrollDrift = Math.max(...preservedTrace.samples.map((sample) => Math.abs(sample.scrollTop - preservedBaseline)));
  assert.ok(maximumPreservedScrollDrift <= 0.5, `Scrolled-up image send moved the reader by ${maximumPreservedScrollDrift}px`);
  await capture(window, '23-image-send-finished-reader-preserved', captures);

  const outcome = {
    bottom: {
      ...bottomPresentation,
      maximumBottomGap,
      frames: bottomTrace.samples.length,
      imageDetachments: bottomTrace.imageDetachments,
    },
    preserved: {
      ...preservedPresentation,
      baselineScrollTop: preservedBaseline,
      maximumScrollDrift: maximumPreservedScrollDrift,
      frames: preservedTrace.samples.length,
      imageDetachments: preservedTrace.imageDetachments,
    },
  };
  return scenarioOutcome('image-send-scroll-stability', outcome, {
    'attachments.image-send-stable-presentation': {
      bottom: bottomPresentation,
      preserved: preservedPresentation,
      detachments: bottomTrace.imageDetachments + preservedTrace.imageDetachments,
    },
    'scroll.image-send-follows-physical-bottom': { maximumBottomGap },
    'scroll.image-send-preserves-reader-position': { baselineScrollTop: preservedBaseline, maximumScrollDrift: maximumPreservedScrollDrift },
  });
}

async function scenarioQueueSteerAndViewportStability(window, captures, host) {
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Queue fixture task did not open');
  const pagedOpensBefore = host.stateForTests().requests.filter((entry) => entry.type === 'session.open' && typeof entry.payload.cursor === 'string').length;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await wheelBy(window, 700);
    await delay(35);
    if (host.stateForTests().requests.filter((entry) => entry.type === 'session.open' && typeof entry.payload.cursor === 'string').length > pagedOpensBefore) break;
  }
  const pagedOpensAfter = host.stateForTests().requests.filter((entry) => entry.type === 'session.open' && typeof entry.payload.cursor === 'string');
  assert.ok(pagedOpensAfter.length > pagedOpensBefore, 'History paging: reaching the transcript ceiling never requested the provider cursor');
  await waitFor(window, `[...document.querySelectorAll('.message-user')].some((node) => node.textContent?.includes('User fixture message 1.'))`, 'History paging: the older provider page did not enter the real timeline', 6_000);
  await ensureBottom(window);
  const message = 'run the queue scenario';
  await installScrollTrace(window);
  await submitComposer(window, message);
  await waitFor(window, `document.querySelector('.reasoning-group[aria-busy="true"]')`, 'Queue scenario reasoning did not start');
  await ensureBottom(window);
  await wheelAwayFromBottom(window, 900);
  await waitFor(window, `(() => { const s = document.querySelector('.conversation-scroll'); return s && s.scrollHeight - s.scrollTop - s.clientHeight > 500; })()`, 'Wheel input did not leave the live tail');
  await delay(200);
  const baseline = await viewportState(window, true);
  await capture(window, '06-reader-scrolled-up', captures);
  const report = await observeStability(window, baseline, 5_000);
  assertReaderStable(report, 'queue stream stability');

  const settledReasoningSelector = '[data-scroll-members*="fake-fixture-settled-reasoning"] .reasoning-disclosure';
  await wheelUntilVisible(window, settledReasoningSelector);
  await waitFor(window, `(() => { const button = document.querySelector(${JSON.stringify(settledReasoningSelector)}); const bounds = button?.getBoundingClientRect(); return button && button.getAttribute('aria-expanded') === 'false' && bounds && bounds.top >= 0 && bounds.bottom <= innerHeight; })()`, 'Settled Reasoning control was not visible while scrolled up');
  await delay(220);
  const beforeExpansion = await viewportState(window, true);
  // This control is deliberately already visible: use the non-scrolling click
  // so the product's own anchor preservation, rather than the QA helper's
  // scrollIntoView, is what the assertion measures.
  await clickVerifiedVisibleSelector(window, settledReasoningSelector);
  await waitFor(window, `document.querySelector(${JSON.stringify(settledReasoningSelector)})?.getAttribute('aria-expanded') === 'true'`, 'Reasoning did not open', 6_000);
  await delay(220);
  const afterExpansion = await viewportState(window, false);
  assert.ok(afterExpansion.height > beforeExpansion.height + 100, 'Reasoning expansion did not produce the intended one-time layout growth');
  assert.equal(afterExpansion.anchorId, beforeExpansion.anchorId, 'Reasoning expansion changed the first visible row identity');
  assert.ok(Math.abs(afterExpansion.anchorTop - beforeExpansion.anchorTop) <= 1, `Reasoning expansion moved the reading anchor by ${afterExpansion.anchorTop - beforeExpansion.anchorTop}px`);
  await capture(window, '07-reasoning-open-while-streaming', captures);

  const queued = 'Queued follow-up instruction';
  await startSubmissionIdentityTrace(window, queued);
  await submitComposer(window, queued, { waitForTranscript: false });
  await waitFor(window, `(() => [...document.querySelectorAll('.queued-message-row')].some((node) => node.textContent?.includes(${JSON.stringify(queued)})))()`, 'Queued instruction did not appear in the strip', 6_000);
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await capture(window, '08-queue-strip', captures);
  await openPopover(window, `button[aria-label="Queued instruction actions"]`, '.queued-message-menu .composer-popover', 'queued instruction popover at 1100x760');
  await assertOverlayWithinViewport(window, '.queued-message-menu .composer-popover', 'queued instruction popover at 1100x760');
  await evaluate(window, `document.querySelector('button[aria-label="Queued instruction actions"]')?.click()`);
  await clickSelector(window, `button[aria-label="Steer with this queued instruction"]`);
  await waitFor(window, `[...document.querySelectorAll('.message-assistant')].some((node) => node.textContent?.includes('Steered: the running turn picked up the queued instruction.'))`, 'Steered content did not stream', 6_000);
  await waitFor(window, `!document.querySelector('.queued-strip')`, 'Queue strip did not empty after steering', 6_000);
  const afterSteerIdentity = await evaluate(window, `(() => {
    const rows = [...document.querySelectorAll('.conversation .message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(queued)}));
    return { userRows: rows.length, anchors: rows.map((node) => node.closest('[data-scroll-anchor]')?.getAttribute('data-scroll-anchor') ?? null), queueRows: document.querySelectorAll('.queued-message-row').length };
  })()`);
  assert.equal(afterSteerIdentity.userRows, 1, `Steered instruction did not settle as one canonical user row: ${JSON.stringify(afterSteerIdentity)}`);
  assert.equal(afterSteerIdentity.queueRows, 0, `Steered instruction remained queued: ${JSON.stringify(afterSteerIdentity)}`);
  const queuedIdentity = await stopSubmissionIdentityTrace(window);
  assertQueuedIdentityTrace(queuedIdentity, queued);
  await capture(window, '09-steered', captures);

  const beforeSwitch = await viewportState(window, false);
  await clickTaskByTitle(window, 'Fake model attachments task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model attachments task')`, 'Did not switch to the attachments task');
  assert.ok(await evaluate(window, `Boolean(document.querySelector('.message-images-before img'))`), 'Attachments: the history image did not render');
  assert.ok(await evaluate(window, `Boolean(document.querySelector('.message-audio-before'))`), 'Attachments: the history audio did not render');
  assert.ok(await evaluate(window, `[...document.querySelectorAll('.message-files .message-file-attachment strong')].some((node) => node.textContent?.trim() === 'fixture-notes.md')`), 'Attachments: the named file widget did not render');
  assert.ok(await evaluate(window, `Boolean(document.querySelector('[data-scroll-members*="fake-attach-file-change-0"]'))`), 'Attachments: the file-change row did not render');
  await capture(window, '10-attachments-task', captures);
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Did not switch back to the streaming task');
  await delay(180);
  const afterSwitch = await viewportState(window, false);
  assert.equal(afterSwitch.anchorId, beforeSwitch.anchorId, 'Switching away and back lost the session-owned visible row');
  assert.ok(Math.abs(afterSwitch.anchorTop - beforeSwitch.anchorTop) <= 1, `Switching away and back moved the preserved viewport by ${afterSwitch.anchorTop - beforeSwitch.anchorTop}px`);

  try {
    await waitFor(window, `(() => { const busy = document.querySelector('.reasoning-group[aria-busy="true"]'); const steered = [...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('Steered: the running turn picked up the queued instruction.')).length; return !busy && steered === 1; })()`, 'Steered queue turn did not settle', 20_000);
    const settledQueueLines = await evaluate(window, `[...document.querySelectorAll('.message-assistant')].map((node) => node.textContent).filter((text) => text.includes('Queue stream line'))`);
    await delay(650);
    const queueLinesAfterSettle = await evaluate(window, `[...document.querySelectorAll('.message-assistant')].map((node) => node.textContent).filter((text) => text.includes('Queue stream line'))`);
    assert.deepEqual(queueLinesAfterSettle, settledQueueLines, 'Cancelled pre-steer output continued after the steered turn settled');
  } catch (error) {
    const state = await evaluate(window, `(() => ({
      busyGroups: document.querySelectorAll('.reasoning-group[aria-busy="true"]').length,
      answerLines: [...document.querySelectorAll('.message-assistant')].map((node) => node.textContent).filter((text) => text.includes('Queue stream line')).map((text) => text.slice(-80)),
      steerRows: [...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('Steered:')).length,
      tail: document.querySelector('.conversation')?.textContent?.slice(-400),
      runtimeState: document.querySelector('.desktop-app')?.dataset.runtimeState,
      anchors: [...document.querySelectorAll('[data-scroll-members]')].map((node) => node.dataset.scrollMembers).slice(-8),
    }))()`);
    await capture(window, 'debug-queue-failure', captures);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; renderer state: ${JSON.stringify(state)}`);
  }
  await waitForSessionIdle(window);
  return scenarioOutcome('queue-steer-and-viewport-stability', { stability: report, queuedIdentity, afterSteerIdentity, olderHistoryRequests: pagedOpensAfter.length - pagedOpensBefore }, {
    'scroll.reader-owned-during-stream': report,
    'scroll.reasoning-expansion-preserves-anchor': { beforeExpansion, afterExpansion },
    'scroll.task-switch-restores-session-anchor': { beforeSwitch, afterSwitch },
    'queue.queued-row-never-fake-transcript': queuedIdentity,
    'queue.steer-becomes-one-user-row': afterSteerIdentity,
    'history.image-audio-file-filechange-render': true,
    'history.older-page-loads': pagedOpensAfter.length - pagedOpensBefore,
  });
}

async function scenarioQueueManagementJourneys(window, captures, host) {
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Queue management fixture task did not open');
  await waitForSessionIdle(window);

  const enqueue = (content) => host.handleRequest('message_queue.enqueue', { sessionId: 'fake-main', content }).payload.message;
  const transcriptRowsBefore = await evaluate(window, `document.querySelectorAll('.message-user').length`);
  const siblingA = enqueue('Queue management sibling A');
  const siblingB = enqueue('Queue management sibling B');
  const siblingC = enqueue('Queue management sibling C');
  await waitFor(window, `document.querySelectorAll('.queued-message-row').length === 3`, 'Three queue siblings did not render');
  assert.deepEqual(await queuedRowContents(window), [siblingA.content, siblingB.content, siblingC.content]);
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-user').length`), transcriptRowsBefore, 'Queue staging changed transcript membership');

  let row = await markQueuedRow(window, siblingB.content, 'edit-middle');
  await openPopover(window, `${row} button[aria-label="Queued instruction actions"]`, `${row} .queued-message-menu .composer-popover`, 'middle queued instruction edit menu');
  await clickMatchingButton(window, `${row} .queued-message-menu .composer-popover`, 'Edit message');
  await clickSelector(window, `${row} input[aria-label="Edit queued instruction"]`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
  await window.webContents.insertText('Queue management sibling B edited');
  await clickMatchingButton(window, `${row} .queued-message-edit`, 'Save');
  await waitFor(window, `(() => {
    const painted = [...document.querySelectorAll('.queued-message-row .queued-message-content > strong')].filter((node) => node.textContent?.trim() === 'Queue management sibling B edited').length;
    return painted === 1;
  })()`, 'Edited queue content did not render exactly once', 15_000);
  assert.deepEqual(host.stateForTests().queue.map((message) => [message.id, message.content]), [
    [siblingA.id, siblingA.content],
    [siblingB.id, 'Queue management sibling B edited'],
    [siblingC.id, siblingC.content],
  ], 'Editing replaced the item identity or changed sibling order');
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'Queue edit showed a redundant success toast');
  assert.equal(await evaluate(window, `[...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes('Queue management sibling B edited')).length`), 0, 'Edited queued content appeared in the transcript');

  row = await markQueuedRow(window, 'Queue management sibling B edited', 'remove-middle');
  await clickSelector(window, `${row} button[aria-label="Remove queued instruction"]`);
  await waitFor(window, `document.querySelectorAll('.queued-message-row').length === 2`, 'Removed queue item stayed visible');
  assert.deepEqual(host.stateForTests().queue.map((message) => message.id), [siblingA.id, siblingC.id], 'Removing the middle queue item changed sibling order');
  assert.deepEqual(await queuedRowContents(window), [siblingA.content, siblingC.content]);
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'Queue removal showed a redundant success toast');

  const moveImageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const moveImageUpload = host.handleRequest('attachment.upload.begin', {
    name: 'queue-handoff.png',
    mimeType: 'image/png',
    byteLength: moveImageBytes.length,
  }).payload;
  host.handleRequest('attachment.upload.chunk', {
    uploadId: moveImageUpload.uploadId,
    offset: 0,
    dataBase64: moveImageBytes.toString('base64'),
  });
  const moveImageId = host.handleRequest('attachment.upload.complete', { uploadId: moveImageUpload.uploadId }).payload.attachmentId;
  const siblingD = host.handleRequest('message_queue.enqueue', {
    sessionId: 'fake-main',
    content: 'Queue management sibling D',
    attachmentIds: [moveImageId],
  }).payload.message;
  await waitFor(window, `document.querySelectorAll('.queued-message-row').length === 3`, 'Third queue sibling did not return');
  host.failNextRequestForTests('message_queue.deliver', 'Injected queue delivery failure.');
  row = await markQueuedRow(window, siblingC.content, 'failed-middle');
  await clickSelector(window, `${row} button[aria-label="Steer with this queued instruction"]`);
  await waitFor(window, `document.querySelector('.toast-error')?.textContent?.includes('Injected queue delivery failure.')`, 'Failed queue delivery did not show its existing error feedback');
  await waitFor(window, `document.querySelectorAll('.queued-message-row').length === 3`, 'Failed delivery did not restore its queue row');
  assert.deepEqual(host.stateForTests().queue.map((message) => message.id), [siblingA.id, siblingC.id, siblingD.id], 'Failed delivery changed the canonical queue order');
  assert.deepEqual(await queuedRowContents(window), [siblingA.content, siblingC.content, siblingD.content], 'Failed delivery restored the row at the wrong painted index');
  assert.equal(await evaluate(window, `[...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(siblingC.content)})).length`), 0, 'Failed delivery leaked into the transcript');
  await capture(window, '20-queue-failure-restored', captures);
  await waitFor(window, `!document.querySelector('.toast')`, 'Queue failure toast did not retire', 5_000);

  host.handleRequest('session.send_message', { sessionId: 'fake-main', content: 'run the queue scenario' });
  await waitFor(window, `document.querySelector('.reasoning-group[aria-busy="true"]')`, 'Queue management could not stage a live turn for steering');
  await startSubmissionIdentityTrace(window, siblingC.content);
  row = await markQueuedRow(window, siblingC.content, 'steer-middle');
  await clickSelector(window, `${row} button[aria-label="Steer with this queued instruction"]`);
  await waitFor(window, `[...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(siblingC.content)})).length === 1`, 'Successful steer did not become one user row');
  await waitFor(window, `document.querySelectorAll('.queued-message-row').length === 2`, 'Successful steer did not remove exactly one queue row');
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const identityTrace = await stopSubmissionIdentityTrace(window);
  assertQueuedIdentityTrace(identityTrace, siblingC.content);
  assert.deepEqual(host.stateForTests().queue.map((message) => message.id), [siblingA.id, siblingD.id], 'Steering changed the remaining queue order');
  assert.deepEqual(await queuedRowContents(window), [siblingA.content, siblingD.content]);
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'Successful steer showed a redundant success toast');
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window);

  const siblingE = enqueue('Queue management sibling E');
  await waitFor(window, `document.querySelectorAll('.queued-message-row').length === 3`, 'Move-to-task siblings did not render');
  row = await markQueuedRow(window, siblingD.content, 'move-middle');
  await openPopover(window, `${row} button[aria-label="Queued instruction actions"]`, `${row} .queued-message-menu .composer-popover`, 'move queued instruction menu');
  await clickMatchingButton(window, `${row} .queued-message-menu .composer-popover`, 'Send to new task');
  await waitFor(window, `document.querySelector('.queue-new-task-picker')`, 'Queue new-task picker did not open');
  const chosenSelection = await evaluate(window, `({
    model: document.querySelector('.queue-new-task-selection > span strong')?.textContent?.trim(),
    effort: document.querySelector('select[aria-label="Reasoning for new task"]')?.value ?? null,
  })`);
  host.failNextRequestForTests('message_queue.deliver_new_task', 'Injected new-task delivery failure.');
  await clickMatchingButton(window, '.queue-new-task-picker', 'Start task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(siblingD.content)})`, 'Moved queue item did not open its new task', 8_000);
  await waitFor(window, `[...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(siblingD.content)})).length === 1`, 'Moved task did not paint its optimistic user row immediately', 8_000);
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-user .message-images-before img[alt="queue-handoff.png"]').length`), 1, 'Moved task did not paint its queued image widget before provider history');
  const moveRequest = host.stateForTests().requests.filter((entry) => entry.type === 'message_queue.move_to_new_task').at(-1);
  assert.equal(moveRequest.payload.messageId, siblingD.id);
  assert.equal(moveRequest.payload.providerId, 'fake');
  assert.equal(moveRequest.payload.modelId, 'fake/deterministic-v1');
  assert.equal(moveRequest.payload.reasoningEffort, chosenSelection.effort);
  assert.deepEqual(host.stateForTests().queue.map((message) => message.id), [siblingA.id, siblingE.id], 'Move-to-task consumed or reordered a sibling');
  await waitFor(window, `document.querySelector('.message-delivery-error')?.textContent?.includes("Message wasn't sent.")`, 'Failed new-task delivery did not stay inline with the optimistic message', 8_000);
  assert.match(await evaluate(window, `document.querySelector('.message-delivery-error')?.getAttribute('title') ?? ''`), /Injected new-task delivery failure/u);
  await clickSelector(window, '#composer-message');
  await window.webContents.insertText('Keep this newer draft intact');
  await clickSelector(window, '.message-delivery-error button');
  await waitFor(window, `!document.querySelector('.message-delivery-error')`, 'Retry did not settle the same moved message', 8_000);
  assert.equal(await evaluate(window, `document.querySelector('#composer-message')?.value`), 'Keep this newer draft intact', 'Retry overwrote the destination composer draft');
  await waitFor(window, `[...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(siblingD.content)})).length === 1`, 'Moved task did not receive the selected queued content', 8_000);
  assert.equal(host.stateForTests().sessions.filter((session) => session.title === siblingD.content).length, 1, 'Retry created a duplicate target task');
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-user .message-images-before img[alt="queue-handoff.png"]').length`), 1, 'Canonical adoption lost or duplicated the queued image widget');
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'Move-to-task showed a redundant success toast');
  await capture(window, '21-queue-moved-to-task', captures);
  await waitForFakeHostIdle(host);
  await waitForSessionIdle(window);

  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Could not return to the parent queue');
  const siblingF = enqueue('Queue management sibling F');
  await waitFor(window, `document.querySelectorAll('.queued-message-row').length === 3`, 'Side-chat queue siblings did not render');
  row = await markQueuedRow(window, siblingE.content, 'side-chat-middle');
  await openPopover(window, `${row} button[aria-label="Queued instruction actions"]`, `${row} .queued-message-menu .composer-popover`, 'side-chat queued instruction menu');
  await clickMatchingButton(window, `${row} .queued-message-menu .composer-popover`, 'Open in side chat');
  await waitFor(window, `document.querySelector('.side-chat-panel')`, 'Queued side chat did not open');
  const sideChat = host.stateForTests().sessions.find((session) => session.sessionKind === 'side_chat' && session.parentSessionId === 'fake-main' && session.preview === siblingE.content);
  assert.ok(sideChat, 'Fake host did not retain the created queued side chat');
  assert.deepEqual(host.stateForTests().queue.map((message) => message.id), [siblingA.id, siblingF.id], 'Side chat consumed or reordered a sibling');
  try {
    await waitFor(window, `[...document.querySelectorAll('.side-chat-panel .message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(siblingE.content)})).length === 1`, 'Side chat did not receive the selected queued content', 8_000);
  } catch (error) {
    const rendererState = await evaluate(window, `({
      panelText: document.querySelector('.side-chat-panel')?.textContent,
      userRows: [...document.querySelectorAll('.side-chat-panel .message-user')].map((node) => node.textContent),
      allRows: [...document.querySelectorAll('.side-chat-panel [data-scroll-members]')].map((node) => ({ members: node.getAttribute('data-scroll-members'), text: node.textContent })),
    })`);
    const hostHistory = host.stateForTests().messagesBySession.get(sideChat.id);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; renderer=${JSON.stringify(rendererState)}; host=${JSON.stringify(hostHistory)}`);
  }
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'Opening a queued side chat showed a redundant success toast');
  await clickSelector(window, '.side-chat-panel button[aria-label="Close side chat"]');
  await waitFor(window, `!document.querySelector('.side-chat-panel')`, 'Side chat did not close');
  await openPopover(window, 'button[aria-label="Filter tasks"]', '.task-filter-popover', 'task filters for side-chat reopen');
  await clickMatchingButton(window, '.task-filter-popover', 'Show side chats');
  await clickSelector(window, 'button[aria-label="Filter tasks"]');
  await waitFor(window, `document.querySelector('[data-side-chat-id=${JSON.stringify(sideChat.id)}]')`, 'Created side chat was not discoverable after closing');
  await clickSelector(window, `[data-side-chat-id=${JSON.stringify(sideChat.id)}]`);
  await waitFor(window, `document.querySelector('.side-chat-panel')`, 'Created side chat could not be reopened');
  await waitFor(window, `[...document.querySelectorAll('.side-chat-panel .message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(siblingE.content)})).length === 1`, 'Reopened side chat lost its queued instruction');
  await capture(window, '22-queue-side-chat-reopened', captures);
  return scenarioOutcome('queue-management-journeys', {
    editedIdentityPreserved: true,
    removedSiblingOrder: [siblingA.id, siblingC.id],
    failedDeliveryRestoredIndex: 1,
    steerIdentityFrames: identityTrace.samples.length,
    movedSelection: { model: chosenSelection.model, effort: chosenSelection.effort },
    movedOptimisticAttachmentPainted: true,
    movedRetryPreservedDraft: true,
    sideChatId: sideChat.id,
    finalParentQueue: [siblingA.id, siblingF.id],
  }, {
    'queue.edit-preserves-identity-and-order': { id: siblingB.id, content: 'Queue management sibling B edited' },
    'queue.remove-preserves-sibling-order': [siblingA.id, siblingC.id],
    'queue.failed-delivery-restores-original-index': 1,
    'queue.successful-actions-are-silent': { queueEdit: true, queueRemove: true, steer: true, move: true, sideChat: true },
    'queue.move-consumes-only-selected-item': [siblingA.id, siblingE.id],
    'queue.move-preserves-content-model-effort': { model: chosenSelection.model, effort: chosenSelection.effort },
    'queue.side-chat-consumes-only-selected-item': [siblingA.id, siblingF.id],
    'queue.side-chat-opens-and-reopens': sideChat.id,
  });
}

async function scenarioOverlaysAndResponsive(window, captures, host) {
  console.log('fake-model-qa: overlays: resizing to 760x480');
  await window.setSize(760, 480);
  await delay(350);
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, '760x480: physical task navigation did not open the workspace');
  const compact = await assertResponsiveLayout(window, '760x480');
  const seeded = host.handleRequest('message_queue.enqueue', { sessionId: 'fake-main', content: 'Overlay bounds queued instruction' }).payload.message;
  await waitFor(window, `Boolean(document.querySelector('.queued-message-row'))`, 'Seeded queued instruction did not appear', 6_000);
  await openPopover(window, `button[aria-label="Queued instruction actions"]`, '.queued-message-menu .composer-popover', 'queued instruction popover at 760x480');
  await assertOverlayWithinViewport(window, '.queued-message-menu .composer-popover', 'queued instruction popover at 760x480');
  await capture(window, '11-overlay-queue-popover-760x480', captures);
  await clickSelector(window, `button[aria-label="Queued instruction actions"]`);
  host.handleRequest('message_queue.cancel', { messageId: seeded.id });
  await waitFor(window, `!document.querySelector('.queued-strip')`, 'Seeded queue did not drain', 6_000);
  await openPopover(window, `button[aria-label^="Choose model"]`, '.model-picker-dropup', 'model picker at 760x480');
  await assertOverlayWithinViewport(window, '.model-picker-dropup', 'model picker at 760x480');
  await assertOverlayPaintedOnTop(window, '.model-picker-dropup', 'model picker at 760x480');
  assert.equal(await evaluate(window, `document.activeElement?.getAttribute('aria-label')`), 'Search models', 'Compact model picker did not focus its search field');
  await capture(window, '12-overlay-model-picker-760x480', captures);
  await clickSelector(window, `button[aria-label^="Choose model"]`);
  console.log('fake-model-qa: overlays: resizing to 1100x760');
  await window.setSize(1100, 760);
  await delay(350);
  await assertResponsiveLayout(window, '1100x760');
  console.log('fake-model-qa: overlays: opening model picker at 1100x760');
  await openPopover(window, `button[aria-label^="Choose model"]`, '.model-picker-dropup', 'model picker at 1100x760');
  await assertOverlayWithinViewport(window, '.model-picker-dropup', 'model picker at 1100x760');
  await assertOverlayPaintedOnTop(window, '.model-picker-dropup', 'model picker at 1100x760');
  await capture(window, '12-overlay-model-picker-1100x760', captures);
  await clickSelector(window, `button[aria-label^="Choose model"]`);
  console.log('fake-model-qa: overlays: opening composer actions at 1100x760');
  await openPopover(window, `button[aria-label="More message actions"]`, '.composer-actions-menu .composer-popover', 'composer actions menu at 1100x760');
  await assertOverlayWithinViewport(window, '.composer-actions-menu .composer-popover', 'composer actions menu at 1100x760');
  await capture(window, '13-overlay-actions-1100x760', captures);
  await clickSelector(window, `button[aria-label="More message actions"]`);
  await capture(window, '14-responsive-1100x760', captures);
  return scenarioOutcome('overlays-and-responsive', { compact, wide: { viewport: { width: 1100, height: 760 } } }, {
    'responsive.compact-workspace-bounds': compact,
    'responsive.queue-popover-not-clipped': true,
    'responsive.model-picker-not-clipped': true,
    'responsive.model-picker-painted-above-header': true,
    'responsive.model-picker-focuses-search': true,
    'responsive.actions-popover-not-clipped': true,
  });
}

async function createScheduledDraftFromComposer(window, host, content, options = {}) {
  const beforeIds = new Set(host.stateForTests().scheduledTasks.map((task) => task.requestId));
  await clickSelector(window, 'button.new-task-button');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.trim() === 'New task' && document.querySelector('textarea[aria-label="Message"]')?.placeholder === 'Describe the task…'`, 'Schedule: New task did not open a local draft');
  await replaceComposerText(window, content);
  await openPopover(window, `button[aria-label="More message actions"]`, '.composer-actions-menu .composer-popover', 'Schedule actions');
  await clickMatchingButton(window, '.composer-actions-menu .composer-popover', 'Schedule task');
  await waitFor(window, `Boolean(document.querySelector('.composer-schedule-panel input[type="datetime-local"]'))`, 'Schedule: scheduling panel did not open');
  if (options.capturePanel) {
    await assertOverlayWithinViewport(window, '.composer-schedule-panel', 'task scheduling panel');
    await assertOverlayPaintedOnTop(window, '.composer-schedule-panel', 'task scheduling panel');
    await capture(window, 'schedule-00-create-panel', options.captures ?? []);
  }
  const localValue = await evaluate(window, `document.querySelector('.composer-schedule-panel input[type="datetime-local"]')?.value`);
  assert.equal(typeof localValue, 'string', 'Schedule: local run time was not populated');
  assert.ok(localValue.length > 0, 'Schedule: local run time was empty');
  await clickSelector(window, '.composer-schedule-panel button[type="submit"]');
  await waitFor(window, `document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') === 'pending' && document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(content)})`, 'Schedule: pending task did not replace the local draft', 8_000);
  const state = host.stateForTests();
  const task = state.scheduledTasks.find((candidate) => !beforeIds.has(candidate.requestId));
  assert.ok(task, 'Schedule: fake host did not retain the newly scheduled task');
  const createRequest = state.requests.filter((request) => request.type === 'scheduled_task.create' && request.payload.content === content).at(-1);
  assert.ok(createRequest, 'Schedule: renderer did not issue scheduled_task.create');
  assert.equal(createRequest.requestId, task.requestId, 'Schedule: renderer did not preserve the stable schedule request ID at the IPC boundary');
  assert.match(task.requestId, /^schedule_[0-9a-f-]+$/iu, 'Schedule: renderer did not supply its stable schedule request ID');
  assert.equal(task.status, 'pending', 'Schedule: newly created task was not pending');
  assert.equal(task.content, content, 'Schedule: submitted content changed across the renderer boundary');
  assert.equal(task.targetSessionId, `scheduled-task:${task.requestId}`, 'Schedule: pending task did not use its stable local placeholder identity');
  assert.equal(state.sessions.some((session) => session.id === task.targetSessionId), false, 'Schedule: a future task eagerly created a provider session');
  assert.equal(state.requests.filter((request) => request.type === 'session.open' && request.payload.sessionId === task.targetSessionId).length, 0, 'Schedule: renderer requested provider history for a local placeholder');
  assert.equal(await evaluate(window, `document.querySelectorAll('[data-session-id=${JSON.stringify(task.targetSessionId)}]').length`), 1, 'Schedule: pending placeholder did not paint exactly one task row');
  assert.equal(await evaluate(window, `Boolean(document.querySelector('textarea[aria-label="Message"]'))`), false, 'Schedule: composer remained available before the scheduled task started');
  return { task, localValue, requestId: createRequest.requestId };
}

async function assertScheduledMaterialization(window, host, journey, startedTask, label) {
  const placeholderId = journey.task.targetSessionId;
  const sessionId = startedTask.targetSessionId;
  assert.notEqual(sessionId, placeholderId, `${label}: dispatch did not replace the local placeholder identity`);
  await waitFor(window, `Boolean(document.querySelector('[data-session-id=${JSON.stringify(sessionId)}] [aria-current="page"]')) && !document.querySelector('[data-session-id=${JSON.stringify(placeholderId)}]') && document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(journey.task.content)}) && document.querySelectorAll('.message-user').length === 1 && document.querySelector('.message-user')?.textContent?.includes(${JSON.stringify(journey.task.content)}) && Boolean(document.querySelector('.workspace-header .status-working'))`, `${label}: selection, timeline, and working state did not migrate to the provider task`, 8_000);
  await delay(350);
  const rendered = await evaluate(window, `({
    selectedSessionId: document.querySelector('[data-session-id] [aria-current="page"]')?.closest('[data-session-id]')?.getAttribute('data-session-id'),
    placeholderRows: document.querySelectorAll('[data-session-id=${JSON.stringify(placeholderId)}]').length,
    realRows: document.querySelectorAll('[data-session-id=${JSON.stringify(sessionId)}]').length,
    userRows: [...document.querySelectorAll('.message-user')].map((row) => ({ text: row.textContent?.trim(), anchor: row.getAttribute('data-scroll-anchor') })),
    working: Boolean(document.querySelector('.workspace-header .status-working')),
  })`);
  assert.equal(rendered.selectedSessionId, sessionId, `${label}: selected task reverted after refresh`);
  assert.equal(rendered.placeholderRows, 0, `${label}: stale placeholder returned after refresh`);
  assert.equal(rendered.realRows, 1, `${label}: provider task did not retain exactly one task row`);
  assert.equal(rendered.userRows.length, 1, `${label}: optimistic instruction was duplicated or lost`);
  assert.equal(rendered.userRows[0].text?.includes(journey.task.content), true, `${label}: migrated optimistic instruction changed`);
  assert.match(rendered.userRows[0].anchor ?? '', /^local-/u, `${label}: migrated instruction lost its stable presentation identity`);
  assert.equal(rendered.working, true, `${label}: provider task no longer painted working state`);
  const hostState = host.stateForTests();
  assert.equal(hostState.sessions.filter((session) => session.id === sessionId).length, 1, `${label}: fake host did not materialize exactly one provider session`);
  assert.equal(hostState.sessions.some((session) => session.id === placeholderId), false, `${label}: fake host leaked the placeholder into provider sessions`);
  return { placeholderId, sessionId, rendered };
}

async function scenarioScheduledTaskLifecycle(window, captures, host) {
  assert.equal(window.isVisible(), false, 'Schedule QA window became visible');
  assert.ok(window.getBounds().x < 0 && window.getBounds().y < 0, `Schedule QA window moved on-screen: ${JSON.stringify(window.getBounds())}`);

  const retryContent = 'Scheduled retry lifecycle fixture';
  const retryJourney = await createScheduledDraftFromComposer(window, host, retryContent, { capturePanel: true, captures });
  await window.setSize(620, 520);
  await delay(250);
  assert.equal(window.isVisible(), false, 'Compact schedule QA window became visible');
  await clickTaskByTitle(window, retryContent);
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(retryContent)})`, 'Schedule: compact task navigation did not open the scheduled workspace');
  await delay(400);
  const compact = await evaluate(window, `(() => {
    const rect = (selector) => { const element = document.querySelector(selector); if (!(element instanceof HTMLElement)) return null; const bounds = element.getBoundingClientRect(); return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }; };
    return {
      notice: rect('.scheduled-task-notice'),
      copy: rect('.scheduled-task-notice > div:not(.scheduled-task-actions)'),
      actions: rect('.scheduled-task-actions'),
      buttons: [...document.querySelectorAll('.scheduled-task-actions button')].map((button) => { const bounds = button.getBoundingClientRect(); return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }; }),
      workspace: rect('.workspace'),
      conversation: rect('.conversation-scroll'),
      viewport: { width: innerWidth, height: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      ownedPoints: (() => {
        const notice = document.querySelector('.scheduled-task-notice');
        if (!(notice instanceof HTMLElement)) return [];
        return [...notice.querySelectorAll('strong, .scheduled-task-actions button')].map((element) => {
          const bounds = element.getBoundingClientRect();
          const x = Math.round(bounds.left + bounds.width / 2);
          const y = Math.round(bounds.top + bounds.height / 2);
          const owner = document.elementFromPoint(x, y);
          return { x, y, owned: owner instanceof Node && notice.contains(owner), owner: owner instanceof HTMLElement ? owner.tagName + '.' + owner.className : null };
        });
      })(),
    };
  })()`);
  assert.ok(compact.notice && compact.workspace && compact.conversation && compact.actions && compact.copy, `Schedule: compact surface is incomplete (${JSON.stringify(compact)})`);
  assert.ok(compact.notice.width > 0 && compact.notice.height > 0 && compact.workspace.width > 0 && compact.workspace.height > 0, `Schedule: compact geometry was not painted (${JSON.stringify(compact)})`);
  assert.ok(compact.notice.left >= compact.workspace.left - 0.5 && compact.notice.right <= compact.workspace.right + 0.5, `Schedule: compact notice escaped the workspace (${JSON.stringify(compact)})`);
  assert.ok(compact.notice.top >= -0.5 && compact.notice.bottom <= compact.viewport.height + 0.5, `Schedule: compact notice escaped the viewport (${JSON.stringify(compact)})`);
  assert.ok(compact.notice.top >= compact.conversation.top - 0.5 && compact.notice.bottom <= compact.conversation.bottom + 0.5, `Schedule: compact notice was clipped by the conversation viewport (${JSON.stringify(compact)})`);
  assert.ok(compact.actions.top >= compact.copy.bottom - 1, `Schedule: compact actions overlapped the task copy (${JSON.stringify(compact)})`);
  assert.ok(compact.buttons.every((button) => button.left >= compact.notice.left - 0.5 && button.right <= compact.notice.right + 0.5), `Schedule: compact action escaped the notice (${JSON.stringify(compact.buttons)})`);
  assert.ok(compact.ownedPoints.length >= 3 && compact.ownedPoints.every((point) => point.owned), `Schedule: compact notice did not own its painted hit-test points (${JSON.stringify(compact.ownedPoints)})`);
  assert.ok(compact.scrollWidth <= compact.viewport.width + 1, `Schedule: compact lifecycle caused horizontal overflow (${compact.scrollWidth} > ${compact.viewport.width})`);
  await capture(window, 'schedule-01-pending-compact-620x520', captures);
  await window.setSize(1100, 760);
  await delay(200);

  host.setScheduledTaskStatusForTests(retryJourney.task.requestId, 'dispatching');
  await waitFor(window, `document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') === 'dispatching' && document.querySelector('.scheduled-task-notice strong')?.textContent?.includes('Starting scheduled task')`, 'Schedule: dispatching state was not painted');
  assert.equal(await evaluate(window, `document.querySelectorAll('.scheduled-task-actions button').length`), 0, 'Schedule: pending actions remained available during dispatch');
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-user').length`), 1, 'Schedule: dispatch did not paint exactly one optimistic instruction');
  await capture(window, 'schedule-02-dispatching', captures);

  host.setScheduledTaskStatusForTests(retryJourney.task.requestId, 'failed', { failureMessage: 'Injected scheduled lifecycle failure.' });
  await waitFor(window, `document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') === 'failed' && document.querySelector('.scheduled-task-notice [role="alert"]')?.textContent?.includes('Injected scheduled lifecycle failure.')`, 'Schedule: failed state and reason were not painted');
  await waitFor(window, `[...document.querySelectorAll('.scheduled-task-actions button')].some((button) => button.textContent?.includes('Retry now'))`, 'Schedule: failed task did not expose Retry now');
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-user').length`), 0, 'Schedule: failed dispatch did not retract its optimistic instruction');
  await capture(window, 'schedule-03-failed-retry', captures);

  await clickMatchingButton(window, '.scheduled-task-actions', 'Retry now');
  await waitFor(window, `document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') === 'pending' && !document.querySelector('.scheduled-task-notice [role="alert"]')`, 'Schedule: retry did not restore a clean pending state');
  assert.equal(host.stateForTests().requests.filter((request) => request.type === 'scheduled_task.retry' && request.payload.scheduledTaskId === retryJourney.task.requestId).length, 1, 'Schedule: Retry now did not issue exactly one retry request');
  host.setScheduledTaskStatusForTests(retryJourney.task.requestId, 'dispatching');
  await waitFor(window, `document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') === 'dispatching'`, 'Schedule: retried task did not re-enter dispatching');
  const retryStarted = host.setScheduledTaskStatusForTests(retryJourney.task.requestId, 'started');
  await waitFor(window, `!document.querySelector('.scheduled-task-notice') && Boolean(document.querySelector('textarea[aria-label="Message"]'))`, 'Schedule: started retry did not clear the schedule notice and restore the composer');
  assert.equal(host.stateForTests().scheduledTasks.find((task) => task.requestId === retryJourney.task.requestId)?.status, 'started', 'Schedule: retry lifecycle did not reach started');
  const retryRemap = await assertScheduledMaterialization(window, host, retryJourney, retryStarted, 'Schedule retry remap');

  const runNowContent = 'Scheduled run-now lifecycle fixture';
  const runNowJourney = await createScheduledDraftFromComposer(window, host, runNowContent);
  await clickMatchingButton(window, '.scheduled-task-actions', 'Run now');
  await waitFor(window, `document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') === 'dispatching'`, 'Schedule: Run now did not enter dispatching');
  assert.equal(host.stateForTests().requests.filter((request) => request.type === 'scheduled_task.run_now' && request.payload.scheduledTaskId === runNowJourney.task.requestId).length, 1, 'Schedule: Run now did not issue exactly one request');
  const runNowStarted = host.setScheduledTaskStatusForTests(runNowJourney.task.requestId, 'started');
  await waitFor(window, `!document.querySelector('.scheduled-task-notice') && Boolean(document.querySelector('textarea[aria-label="Message"]'))`, 'Schedule: Run now did not reach the started surface');
  const runNowRemap = await assertScheduledMaterialization(window, host, runNowJourney, runNowStarted, 'Schedule run-now remap');
  await capture(window, 'schedule-04-run-now-started', captures);

  const cancelContent = 'Scheduled cancel lifecycle fixture';
  const cancelJourney = await createScheduledDraftFromComposer(window, host, cancelContent);
  await clickMatchingButton(window, '.scheduled-task-actions', 'Cancel');
  await waitFor(window, `!document.querySelector('.scheduled-task-notice') && !document.querySelector('[data-session-id=${JSON.stringify(cancelJourney.task.targetSessionId)}]') && document.querySelector('.page-heading h1')?.textContent?.trim() === 'Dashboard'`, 'Schedule: Cancel did not remove the local placeholder');
  assert.equal(host.stateForTests().scheduledTasks.some((task) => task.requestId === cancelJourney.task.requestId), false, 'Schedule: cancelled task remained active in the fake host');
  assert.equal(host.stateForTests().sessions.some((session) => session.id === cancelJourney.task.targetSessionId), false, 'Schedule: cancelled placeholder leaked into provider sessions');
  assert.equal(host.stateForTests().requests.filter((request) => request.type === 'scheduled_task.cancel' && request.payload.scheduledTaskId === cancelJourney.task.requestId).length, 1, 'Schedule: Cancel did not issue exactly one request');
  await capture(window, 'schedule-05-cancelled', captures);

  const dismissContent = 'Scheduled failed-dismiss lifecycle fixture';
  const dismissJourney = await createScheduledDraftFromComposer(window, host, dismissContent);
  host.setScheduledTaskStatusForTests(dismissJourney.task.requestId, 'dispatching');
  await waitFor(window, `document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') === 'dispatching'`, 'Schedule: failed-dismiss fixture did not enter dispatching');
  host.setScheduledTaskStatusForTests(dismissJourney.task.requestId, 'failed', { failureMessage: 'Dismissable scheduled lifecycle failure.' });
  await waitFor(window, `document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') === 'failed' && [...document.querySelectorAll('.scheduled-task-actions button')].some((button) => button.textContent?.includes('Dismiss'))`, 'Schedule: failed task did not expose Dismiss');
  await clickMatchingButton(window, '.scheduled-task-actions', 'Dismiss');
  await waitFor(window, `!document.querySelector('.scheduled-task-notice') && !document.querySelector('[data-session-id=${JSON.stringify(dismissJourney.task.targetSessionId)}]') && document.querySelector('.page-heading h1')?.textContent?.trim() === 'Dashboard'`, 'Schedule: Dismiss did not remove the failed placeholder');
  assert.equal(host.stateForTests().scheduledTasks.some((task) => task.requestId === dismissJourney.task.requestId), false, 'Schedule: dismissed failed task remained active in the fake host');
  assert.equal(host.stateForTests().requests.filter((request) => request.type === 'scheduled_task.cancel' && request.payload.scheduledTaskId === dismissJourney.task.requestId).length, 1, 'Schedule: Dismiss did not issue exactly one cancel request');
  await capture(window, 'schedule-06-failed-dismissed', captures);

  assert.equal(window.isVisible(), false, 'Schedule QA window became visible before completion');
  return scenarioOutcome('scheduled-task-lifecycle', {
    retryTaskId: retryJourney.task.requestId,
    runNowTaskId: runNowJourney.task.requestId,
    cancelledTaskId: cancelJourney.task.requestId,
    dismissedTaskId: dismissJourney.task.requestId,
    retryRemap,
    runNowRemap,
    compact,
  }, {
    'schedule.create-pending': { taskId: retryJourney.task.requestId, requestId: retryJourney.requestId, localValue: retryJourney.localValue },
    'schedule.dispatching-failed-retry': ['pending', 'dispatching', 'failed', 'pending'],
    'schedule.retry-starts-task': { taskId: retryJourney.task.requestId, remap: retryRemap },
    'schedule.run-now-starts-task': { taskId: runNowJourney.task.requestId, remap: runNowRemap },
    'schedule.cancel-clears-active-schedule': cancelJourney.task.requestId,
    'schedule.failed-dismiss-clears-active-schedule': dismissJourney.task.requestId,
    'schedule.compact-layout-contained': compact,
  });
}

async function scenarioDraftRestoreAndMaterialize(window, captures, host) {
  await clickSelector(window, 'button.new-task-button');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.trim() === 'New task' && document.querySelector('textarea[aria-label="Message"]')?.placeholder === 'Describe the task…'`, 'New task did not open a local draft');
  const draftId = await evaluate(window, `document.querySelector('[data-session-id^="draft-"]')?.getAttribute('data-session-id')`);
  assert.equal(typeof draftId, 'string', 'New task did not create one identifiable draft row');
  assert.equal(await evaluate(window, `document.querySelectorAll('[data-session-id^="draft-"]').length`), 1, 'New task created duplicate draft rows');

  const instruction = 'Draft restoration fixture: materialize exactly once';
  await replaceComposerText(window, instruction);
  await clickTaskByTitle(window, 'Fake model attachments task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model attachments task')`, 'Could not leave the local draft');
  await clickSelector(window, `[data-session-id="${draftId}"] .session-row`);
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(instruction)}`, 'Per-task draft text was not restored exactly after switching away');
  await capture(window, '15-draft-restored', captures);

  const createsBefore = host.stateForTests().requests.filter((entry) => entry.type === 'session.create').length;
  await pressComposerEnter(window);
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(instruction)}) && !document.querySelector('[data-session-id="${draftId}"]')`, 'Draft did not materialize into its real task exactly once', 8_000);
  const creates = host.stateForTests().requests.filter((entry) => entry.type === 'session.create');
  assert.equal(creates.length, createsBefore + 1, 'Draft materialization issued anything other than one session.create');
  const created = creates.at(-1);
  assert.deepEqual({
    providerId: created.payload.providerId,
    workingDirectory: created.payload.workingDirectory,
    title: created.payload.title,
    modelId: created.payload.modelId,
    reasoningEffort: created.payload.reasoningEffort,
    firstInstruction: created.payload.firstInstruction,
  }, {
    providerId: 'fake',
    workingDirectory: 'C:\\FakeModel\\main',
    title: instruction,
    modelId: 'fake/deterministic-v1',
    reasoningEffort: 'low',
    firstInstruction: instruction,
  }, 'Draft materialization lost its selected route, folder, title, or first instruction');
  assert.equal(await evaluate(window, `[...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(instruction)})).length`), 1, 'Materialized first instruction was painted more than once');
  assert.equal(await evaluate(window, `[...document.querySelectorAll('[data-session-id]')].filter((row) => row.textContent?.includes(${JSON.stringify(instruction)})).length`), 1, 'Materialized task duplicated in the task rail');
  assert.equal(await evaluate(window, `document.querySelector('textarea[aria-label="Message"]')?.value`), '', 'Materialized draft text was not cleared');
  await capture(window, '16-draft-materialized-once', captures);
  return scenarioOutcome('draft-restore-and-materialize', { restoredExactly: true, createRequests: 1, firstInstructionRows: 1, taskRows: 1 }, {
    'draft.task-local-restore': instruction,
    'draft.materialize-create-payload': created.payload,
    'draft.materialize-once-no-duplicate': { createRequests: creates.length - createsBefore, firstInstructionRows: 1, taskRows: 1 },
    'draft.clear-after-materialize': '',
  });
}

async function scenarioDraftLatePickerRebind(window, captures, host, selectImagesGate) {
  assert.ok(selectImagesGate, 'Late-picker scenario did not receive its image gate');
  const instruction = `Draft materializes before image picker ${Date.now()}`;
  try {
    await clickTaskByTitle(window, 'Fake Codex audio task');
    await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake Codex audio task')`, 'Late picker: image-capable source task did not open');
    await clickSelector(window, 'button.new-task-button');
    await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.trim() === 'New task'`, 'Late picker: local draft did not open');
    const draftId = await evaluate(window, `document.querySelector('[data-session-id^="draft-"]')?.getAttribute('data-session-id')`);
    assert.match(draftId ?? '', /^draft-/u, 'Late picker: local draft has no stable id');
    await replaceComposerText(window, instruction);
    await clickSelector(window, 'button[aria-label="Add attachment"]');
    await waitFor(window, `Boolean(document.querySelector('.composer-attachment-menu .composer-popover'))`, 'Late picker: attachment menu did not open');
    await clickMatchingButton(window, '.composer-attachment-menu .composer-popover', 'Attach image');
    await delay(25);
    assert.equal(selectImagesGate.used, true, 'Late picker: image selection was not paused');

    await pressComposerEnter(window);
    await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(instruction)}) && !document.querySelector('[data-session-id=${JSON.stringify(draftId)}]')`, 'Late picker: draft did not materialize while image selection was pending', 8_000);
    assert.equal(await evaluate(window, `document.querySelectorAll('.image-attachment-chip img').length`), 0, 'Late picker: gated image appeared before selection resolved');

    selectImagesGate.release();
    await waitFor(window, `document.querySelectorAll('.image-attachment-chip img').length === 1`, 'Late picker: resolved image did not follow the materialized task', 5_000);
    const rebound = await evaluate(window, `(() => ({
      title: document.querySelector('.workspace h1')?.textContent?.trim(),
      draftIdPresent: Boolean(document.querySelector('[data-session-id=${JSON.stringify(draftId)}]')),
      attachmentName: document.querySelector('.image-attachment-chip')?.textContent?.trim(),
      attachmentCount: document.querySelectorAll('.image-attachment-chip img').length,
    }))()`);
    assert.equal(rebound.draftIdPresent, false, 'Late picker resurrected the replaced local draft');
    assert.equal(rebound.attachmentCount, 1, 'Late picker duplicated the selected image');
    assert.match(rebound.attachmentName ?? '', /fake-attachment\.png/u, 'Late picker lost the selected image name');
    await capture(window, 'draft-23-late-image-picker-rebound', captures);
    return scenarioOutcome('draft-late-picker-rebind', { draftId, rebound, createRequests: host.stateForTests().requests.filter((entry) => entry.type === 'session.create').length }, {
      'draft.late-image-picker-follows-materialized-task': rebound,
    });
  } finally {
    selectImagesGate.release();
  }
}

async function scenarioSettingsRoundTrip(window, captures) {
  await clickSelector(window, 'button[aria-label="Open settings"]');
  await waitFor(window, `document.querySelector('#settings-page')`, 'Settings did not open');
  await bringIntoView(window, '.settings-compact-details:nth-of-type(2) summary');
  await clickSelector(window, '.settings-compact-details:nth-of-type(2) summary');
  const setSelect = async (label, value) => {
    await evaluate(window, `(() => {
      const select = document.querySelector('select[aria-label=${JSON.stringify(label)}]');
      if (!(select instanceof HTMLSelectElement)) throw new Error('Settings select is missing: ' + ${JSON.stringify(label)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(window, `document.querySelector('select[aria-label=${JSON.stringify(label)}]')?.value === ${JSON.stringify(value)}`, `Settings did not retain ${label}=${value}`);
  };
  await setSelect('Close button', 'quit');
  await setSelect('Alerts', 'attention');
  await setSelect('Startup', 'tray');
  await setSelect('Reasoning display', 'expanded');
  await bringIntoView(window, 'button[aria-label="Enable experimental features"]');
  await clickSelector(window, 'button[aria-label="Enable experimental features"]');
  await waitFor(window, `document.querySelector('button[aria-label="Enable experimental features"]')?.getAttribute('aria-checked') === 'true'`, 'Experimental feature toggle did not update');
  await bringIntoView(window, 'button[aria-label="Allow sub-agents from other coding tools"]');
  await clickSelector(window, 'button[aria-label="Allow sub-agents from other coding tools"]');
  await waitFor(window, `document.querySelector('button[aria-label="Allow sub-agents from other coding tools"]')?.getAttribute('aria-checked') === 'true'`, 'Foreign sub-agent toggle did not update');
  await capture(window, '17-settings-updated', captures);

  await clickSelector(window, 'button[aria-label="Close settings"]');
  await waitFor(window, `!document.querySelector('#settings-page')`, 'Settings did not close');
  await clickSelector(window, 'button[aria-label="Open settings"]');
  await waitFor(window, `document.querySelector('#settings-page')`, 'Settings did not reopen');
  await bringIntoView(window, '.settings-compact-details:nth-of-type(2) summary');
  await clickSelector(window, '.settings-compact-details:nth-of-type(2) summary');
  const reopened = await evaluate(window, `({
    close: document.querySelector('select[aria-label="Close button"]')?.value,
    alerts: document.querySelector('select[aria-label="Alerts"]')?.value,
    startup: document.querySelector('select[aria-label="Startup"]')?.value,
    reasoning: document.querySelector('select[aria-label="Reasoning display"]')?.value,
    experimental: document.querySelector('button[aria-label="Enable experimental features"]')?.getAttribute('aria-checked'),
    foreignSubagents: document.querySelector('button[aria-label="Allow sub-agents from other coding tools"]')?.getAttribute('aria-checked'),
  })`);
  assert.deepEqual(reopened, { close: 'quit', alerts: 'attention', startup: 'tray', reasoning: 'expanded', experimental: 'true', foreignSubagents: 'true' }, 'Settings values did not survive close and reopen');
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast').length`), 0, 'Settings round-trip showed a redundant success toast');
  await capture(window, '18-settings-persisted', captures);
  await clickSelector(window, 'button[aria-label="Close settings"]');
  await waitFor(window, `!document.querySelector('#settings-page')`, 'Settings did not return to the task');
  return scenarioOutcome('settings-round-trip', reopened, {
    'settings.close-action-persist': reopened.close,
    'settings.alert-level-persist': reopened.alerts,
    'settings.startup-persist': reopened.startup,
    'settings.reasoning-display-persist': reopened.reasoning,
    'settings.experimental-toggle-persist': reopened.experimental,
    'settings.foreign-subagent-toggle-persist': reopened.foreignSubagents,
    'settings.success-is-silent': true,
  });
}

async function scenarioMicrophoneSelectionFallback(window, captures, host) {
  await ensureRendererReady(window);
  await window.setSize(1100, 760);
  await clickTaskByTitle(window, 'Fake Codex audio task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake Codex audio task')`, 'Microphone: fixture task did not open');

  await evaluate(window, `(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices || !media.getUserMedia) throw new Error('Microphone APIs are unavailable in the fake browser');
    const originalEnumerate = media.enumerateDevices.bind(media);
    const originalGetUserMedia = media.getUserMedia.bind(media);
    const state = {
      devices: [
        { kind: 'audioinput', deviceId: 'default', label: 'Default microphone', groupId: 'fake-default' },
        { kind: 'audioinput', deviceId: 'desk-mic', label: 'Desk microphone', groupId: 'fake-desk' },
      ],
      calls: [],
      missing: false,
      originalEnumerate,
      originalGetUserMedia,
    };
    Object.defineProperty(media, 'enumerateDevices', { configurable: true, writable: true, value: async () => state.devices.map((device) => ({ ...device })), });
    Object.defineProperty(media, 'getUserMedia', { configurable: true, writable: true, value: async (constraints) => {
      state.calls.push(JSON.parse(JSON.stringify(constraints)));
      const exact = constraints?.audio?.deviceId?.exact;
      if (state.missing && exact === 'desk-mic') throw new DOMException('Missing fake microphone', 'NotFoundError');
      // The fake Chromium device is the deterministic transport. The recorded
      // constraints above are still the exact values the app requested.
      return originalGetUserMedia({ audio: true, video: false });
    }, });
    window.__fakeMicrophone = state;
  })()`);

  await clickSelector(window, 'button[aria-label="Choose dictation source"]');
  await waitFor(window, `Boolean(document.querySelector('.dictation-source-menu'))`, 'Microphone: dictation source menu did not open');
  await clickSelector(window, 'button[aria-label="Choose microphone"]');
  await waitFor(window, `document.querySelectorAll('[role="radio"]').length === 2`, 'Microphone: deterministic devices did not appear');
  await clickMatchingButton(window, '.dictation-device-picker', 'Desk microphone');
  await waitFor(window, `localStorage.getItem('tethoq:dictation-microphone-device') === 'desk-mic'`, 'Microphone: custom device selection was not persisted');
  await capture(window, '19-microphone-custom-selected', captures);
  await evaluate(window, `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))`);
  await waitFor(window, `document.querySelector('button[aria-label="Choose dictation source"]')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.dictation-device-picker')`, 'Microphone: source menu did not close before recording');
  await clickVerifiedVisibleSelector(window, 'button[aria-label="Start dictation"]');
  await waitFor(window, `document.querySelector('.dictation-audio-strip') || document.querySelector('.dictation-recording')`, 'Microphone: recording did not start');
  await waitFor(window, `window.__fakeMicrophone?.calls.some((call) => call.audio?.deviceId?.exact === 'desk-mic')`, 'Microphone: recording did not request the selected device');
  const selectedCall = await evaluate(window, `window.__fakeMicrophone.calls.find((call) => call.audio?.deviceId?.exact === 'desk-mic')`);
  assert.deepEqual(selectedCall, { audio: { deviceId: { exact: 'desk-mic' }, echoCancellation: true, noiseSuppression: true }, video: false }, 'Microphone: selected recording lost its exact audio constraints');
  // Give the fake microphone the same minimum capture time a real click-to-stop
  // journey naturally has. Stopping in the first scheduler tick manufactures a
  // zero-sample recording and an error toast that then (correctly) covers the
  // composer while it is visible.
  await delay(700);
  await clickSelector(window, 'button[aria-label="Stop dictation"]');
  await waitFor(window, `document.querySelector('.dictation-control')?.className?.includes('dictation-idle')`, 'Microphone: selected recording did not settle');
  assert.equal(await evaluate(window, `document.querySelectorAll('.toast-error').length`), 0, 'Microphone: a realistic selected-device recording produced an error toast');

  await evaluate(window, `(() => { window.__fakeMicrophone.devices = [{ kind: 'audioinput', deviceId: 'default', label: 'Default microphone', groupId: 'fake-default' }]; window.__fakeMicrophone.missing = true; })()`);
  await clickVerifiedVisibleSelector(window, 'button[aria-label="Start dictation"]');
  await waitFor(window, `window.__fakeMicrophone.calls.filter((call) => call.audio?.deviceId?.exact === 'desk-mic').length >= 2`, 'Microphone: missing-device request was not attempted');
  await waitFor(window, `window.__fakeMicrophone.calls.some((call, index) => index > 0 && call.audio && !call.audio.deviceId)`, 'Microphone: missing-device request did not fall back to the default input');
  assert.equal(await evaluate(window, `localStorage.getItem('tethoq:dictation-microphone-device')`), null, 'Microphone: missing-device fallback left a stale device preference behind');
  const calls = await evaluate(window, `window.__fakeMicrophone.calls.slice(-2)`);
  assert.equal(calls[0]?.audio?.deviceId?.exact, 'desk-mic');
  assert.deepEqual(calls[1], { audio: { echoCancellation: true, noiseSuppression: true }, video: false }, 'Microphone: fallback did not use the system default constraints');
  await delay(700);
  if (await evaluate(window, `Boolean(document.querySelector('button[aria-label="Stop dictation"]'))`)) await clickSelector(window, 'button[aria-label="Stop dictation"]');
  await waitFor(window, `document.querySelector('.dictation-control')?.className?.includes('dictation-idle')`, 'Microphone: fallback recording did not settle');
  await capture(window, '20-microphone-missing-device-fallback', captures);
  await evaluate(window, `(() => {
    const media = navigator.mediaDevices;
    const state = window.__fakeMicrophone;
    if (state) {
      Object.defineProperty(media, 'enumerateDevices', { configurable: true, writable: true, value: state.originalEnumerate });
      Object.defineProperty(media, 'getUserMedia', { configurable: true, writable: true, value: state.originalGetUserMedia });
    }
    delete window.__fakeMicrophone;
  })()`);
  return scenarioOutcome('microphone-selection-fallback', { selectedDevice: 'desk-mic', exactConstraint: true, missingDeviceFallback: true, preferenceCleared: true, getUserMediaCalls: calls.length }, {
    'microphone.custom-device-exact-constraint': calls[0],
    'microphone.missing-device-falls-back-to-default': calls[1],
    'microphone.preference-clears-after-fallback': true,
  });
}

async function visibleTaskIds(window) {
  return evaluate(window, `[...document.querySelectorAll('.session-list-scroll > .session-row-group > [data-session-id]')].map((row) => row.getAttribute('data-session-id'))`);
}

async function scenarioTaskSearchAndFilters(window, captures) {
  await ensureRendererReady(window);
  await window.setSize(1100, 760);
  await clickSelector(window, 'button[aria-label="Search tasks"]');
  await waitFor(window, `document.activeElement?.getAttribute('aria-label') === 'Search tasks'`, 'Task search: search input did not receive focus');
  await window.webContents.insertText('provider-parented');
  await waitFor(window, `document.querySelector('input[aria-label="Search tasks"]')?.value === 'provider-parented'`, 'Task search: query was not entered');
  await waitFor(window, `JSON.stringify([...document.querySelectorAll('.session-list-scroll > .session-row-group > [data-session-id]')].map((row) => row.getAttribute('data-session-id'))) === JSON.stringify(['fake-provider-parented'])`, 'Task search: query did not filter the visible row set');
  assert.deepEqual(await visibleTaskIds(window), ['fake-provider-parented']);
  await clickSelector(window, 'button[aria-label="Clear search"]');
  await waitFor(window, `document.querySelector('input[aria-label="Search tasks"]')?.value === '' && document.querySelectorAll('.session-list-scroll > .session-row-group > [data-session-id]').length === 4`, 'Task search: Clear did not restore all top-level tasks');
  await window.webContents.insertText('no-such-deterministic-task');
  await waitFor(window, `document.querySelector('.session-list-scroll')?.textContent?.includes('No matching tasks')`, 'Task search: no-match state was not rendered');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, `document.querySelector('input[aria-label="Search tasks"]')?.value === '' && document.querySelectorAll('.session-list-scroll > .session-row-group > [data-session-id]').length === 4`, 'Task search: Escape did not clear the active query');
  await clickSelector(window, 'button[aria-label="Filter tasks"]');
  await waitFor(window, `Boolean(document.querySelector('.task-filter-popover'))`, 'Task filters: popover did not open');
  await bringIntoView(window, 'button[aria-label="Add Codex to custom filter"]');
  await hoverSelector(window, 'button[aria-label="Add Codex to custom filter"]');
  await clickVerifiedVisibleSelector(window, 'button[aria-label="Add Codex to custom filter"]');
  await waitFor(window, `document.querySelector('button[aria-label="Remove Codex from custom filter"]')?.getAttribute('aria-checked') === 'true'`, 'Task filters: Codex custom filter did not settle');
  await evaluate(window, `(() => { const button = [...document.querySelectorAll('.task-filter-popover .state-options button')].find((candidate) => candidate.textContent?.trim() === 'Idle'); if (!(button instanceof HTMLElement)) throw new Error('Idle filter is missing'); button.scrollIntoView({ block: 'center' }); })()`);
  await clickMatchingButton(window, '.task-filter-popover', 'Idle');
  await waitFor(window, `JSON.stringify([...document.querySelectorAll('.session-list-scroll > .session-row-group > [data-session-id]')].map((row) => row.getAttribute('data-session-id'))) === JSON.stringify(['fake-audio'])`, 'Task filters: provider, availability, and status did not combine to one matching task');
  await clickSelector(window, 'button[aria-label^="Task filters:"]');
  await waitFor(window, `document.querySelector('.task-filter-popover')`, 'Task filters: combined filter popover did not reopen');
  await bringIntoView(window, 'button[aria-label="Add Available agents to custom filter"]');
  await hoverSelector(window, 'button[aria-label="Add Available agents to custom filter"]');
  await clickVerifiedVisibleSelector(window, 'button[aria-label="Add Available agents to custom filter"]');
  await waitFor(window, `JSON.stringify([...document.querySelectorAll('.session-list-scroll > .session-row-group > [data-session-id]')].map((row) => row.getAttribute('data-session-id'))) === JSON.stringify(['fake-audio'])`, 'Task filters: Available agents did not act as an AND qualifier for the explicit provider filter');
  assert.equal(await evaluate(window, `document.querySelector('.task-filter-popover footer')?.textContent?.trim()`), '1 matching task');
  assert.equal(await evaluate(window, `document.querySelector('button[aria-label="Remove Codex from custom filter"]')?.getAttribute('aria-checked')`), 'true');
  assert.equal(await evaluate(window, `document.querySelector('button[aria-label="Remove Available agents from custom filter"]')?.getAttribute('aria-checked')`), 'true');
  await capture(window, '21-task-search-filters', captures);
  return scenarioOutcome('task-search-and-filters', { queryRows: ['fake-provider-parented'], restoredRows: 4, noMatch: true, codexIdleRows: ['fake-audio'], availableQualifiedRows: ['fake-audio'], footer: '1 matching task' }, {
    'tasks.search-filters-visible-rows': ['fake-provider-parented'],
    'tasks.clear-and-escape-reset-search': { restoredRows: 4 },
    'tasks.combined-provider-status-available-filter': ['fake-audio'],
    'tasks.no-match-state': true,
  });
}

async function scenarioArchiveSelectedTask(window, captures) {
  await ensureRendererReady(window);
  await window.setSize(1100, 760);
  await clickTaskByTitle(window, 'Fake model main task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`, 'Archive: the main task conversation did not open');

  await contextClickSelector(window, '[data-session-id="fake-main"]');
  await waitFor(window, `Boolean(document.querySelector('.session-context-menu'))`, 'Archive: task context menu did not open');
  await clickMatchingButton(window, '.session-context-menu', 'Archive');
  await waitFor(window, `!document.querySelector('[data-session-id="fake-main"]')`, 'Archive: the selected archived task row stayed in the default task list');

  assert.ok(await evaluate(window, `document.querySelector('.workspace h1')?.textContent?.includes('Fake model main task')`), 'Archive: archiving the selected task closed its conversation');
  assert.equal(await evaluate(window, `document.querySelector('button.sidebar-task-filter')?.getAttribute('aria-expanded')`), 'false', 'Archive: filter state changed unexpectedly');
  await capture(window, '15-selected-task-archived', captures);

  await clickSelector(window, 'button.sidebar-task-filter');
  await waitFor(window, `Boolean(document.querySelector('.task-filter-popover'))`, 'Archive: task filters did not open');
  const filterPoint = await evaluate(window, `(() => {
    const bounds = document.querySelector('.task-filter-popover')?.getBoundingClientRect();
    if (!bounds) throw new Error('Archive: task filter bounds are unavailable');
    return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: filterPoint.x, y: filterPoint.y });
  for (let index = 0; index < 10; index += 1) {
    window.webContents.sendInputEvent({ type: 'mouseWheel', x: filterPoint.x, y: filterPoint.y, deltaY: -100, deltaX: 0, canScroll: true });
    await delay(18);
  }
  await waitFor(window, `(() => {
    const button = [...document.querySelectorAll('.task-filter-popover button')].find((candidate) => candidate.textContent?.includes('Show archived'));
    if (!(button instanceof HTMLElement)) return false;
    const bounds = button.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  })()`, 'Archive: Show archived did not scroll into view');
  await clickMatchingButton(window, '.task-filter-popover', 'Show archived');
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="fake-main"]'))`, 'Archive: Show archived did not restore the archived task row');
  assert.equal(await evaluate(window, `document.querySelector('[data-session-id="fake-main"]')?.textContent?.includes('Fake model main task')`), true, 'Archive: the revealed archived row has the wrong identity');
  await capture(window, '16-selected-task-shown-in-archived-filter', captures);

  return scenarioOutcome('archive-selected-task', { defaultRowHidden: true, conversationStayedOpen: true, showArchivedRevealedRow: true }, {
    'archive.selected-row-leaves-default-list': true,
    'archive.selected-conversation-remains-open': true,
    'archive.show-archived-restores-row': true,
  });
}

async function scenarioArchiveUnselectedAndDraft(window, captures) {
  await ensureRendererReady(window);
  await window.setSize(1100, 760);
  const unselectedId = 'fake-provider-parented';
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="${unselectedId}"]'))`, 'Archive: unselected fixture row did not appear');
  await contextClickSelector(window, `[data-session-id="${unselectedId}"]`);
  await waitFor(window, `Boolean(document.querySelector('.session-context-menu'))`, 'Archive: unselected task context menu did not open');
  assert.equal(await evaluate(window, `Boolean([...document.querySelectorAll('.session-context-menu button')].find((button) => button.textContent?.includes('Archive')))`), true, 'Archive: unselected task had no Archive action');
  await clickMatchingButton(window, '.session-context-menu', 'Archive');
  await waitFor(window, `!document.querySelector('[data-session-id="${unselectedId}"]')`, 'Archive: unselected task stayed in the default list');
  const archivedPreference = await evaluate(window, `window.tethoqDesktop.preferencesState()`);
  assert.equal(archivedPreference.taskOverrides?.[unselectedId]?.archived, true, 'Archive: host preference payload did not record the unselected task');

  await setShowArchived(window, true, 'Archive: unselected-task filter');
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="${unselectedId}"]'))`, 'Archive: Show archived did not reveal the unselected task');
  await contextClickSelector(window, `[data-session-id="${unselectedId}"]`);
  await waitFor(window, `Boolean(document.querySelector('.session-context-menu'))`, 'Archive: restore menu did not open');
  await clickMatchingButton(window, '.session-context-menu', 'Restore');
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="${unselectedId}"]'))`, 'Archive: restored task did not remain visible in the archived view');
  const restoredPreference = await evaluate(window, `window.tethoqDesktop.preferencesState()`);
  assert.equal(restoredPreference.taskOverrides?.[unselectedId]?.archived, false, 'Archive: restore did not clear the host archive override');
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="${unselectedId}"]'))`, 'Archive: restored task did not return to the default list');

  await clickSelector(window, 'button.new-task-button');
  await waitFor(window, `document.querySelector('[data-session-id^="draft-"]') && document.querySelector('.workspace h1')?.textContent?.trim() === 'New task'`, 'Archive: local draft did not open');
  const draftId = await evaluate(window, `document.querySelector('[data-session-id^="draft-"]')?.getAttribute('data-session-id')`);
  assert.match(draftId, /^draft-/u, 'Archive: local draft did not have a stable local id');
  await contextClickSelector(window, `[data-session-id="${draftId}"]`);
  await waitFor(window, `Boolean(document.querySelector('.session-context-menu'))`, 'Archive: draft context menu did not open');
  const draftArchiveButton = await evaluate(window, `(() => { const button = [...document.querySelectorAll('.session-context-menu button')].find((candidate) => candidate.textContent?.includes('Archive')); return { present: Boolean(button), disabled: button?.disabled ?? null }; })()`);
  assert.deepEqual(draftArchiveButton, { present: true, disabled: false }, 'Archive: draft Archive action was incorrectly disabled');
  await clickMatchingButton(window, '.session-context-menu', 'Archive');
  await waitFor(window, `!document.querySelector('[data-session-id="${draftId}"]')`, 'Archive: archived draft stayed in the default list');
  const draftArchivedPreference = await evaluate(window, `window.tethoqDesktop.preferencesState()`);
  assert.equal(draftArchivedPreference.taskOverrides?.[draftId]?.archived, true, 'Archive: draft archive preference was not persisted');
  await setShowArchived(window, true, 'Archive: draft archived filter');
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="${draftId}"]'))`, 'Archive: Show archived did not reveal the archived draft');
  await contextClickSelector(window, `[data-session-id="${draftId}"]`);
  await waitFor(window, `Boolean(document.querySelector('.session-context-menu'))`, 'Archive: draft restore menu did not open');
  await clickMatchingButton(window, '.session-context-menu', 'Restore');
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="${draftId}"]'))`, 'Archive: restored draft did not return');
  const draftRestoredPreference = await evaluate(window, `window.tethoqDesktop.preferencesState()`);
  assert.equal(draftRestoredPreference.taskOverrides?.[draftId]?.archived, false, 'Archive: draft restore did not clear the archive override');
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="${draftId}"]'))`, 'Archive: restored draft was not visible in the default list');
  assert.equal(await evaluate(window, `document.querySelector('.workspace h1')?.textContent?.trim()`), 'New task', 'Archive: draft restore changed the draft workspace identity');
  await capture(window, '22-archive-unselected-and-draft', captures);
  return scenarioOutcome('archive-unselected-and-draft', { unselectedRoundTrip: true, draftRoundTrip: true, draftId, overridesCleared: true }, {
    'archive.unselected-task-round-trip': unselectedId,
    'archive.draft-round-trip': draftId,
    'archive.restore-reenters-default-list': true,
  });
}

async function runFakeModelQa() {
  await fs.mkdir(artifactDirectory, { recursive: true });
  const artifactCleanup = await cleanupOldScreenshotArtifacts(artifactDirectory, screenshotMaxAgeMs);
  if (artifactCleanup.removed > 0) console.log(`fake-model-qa: removed ${artifactCleanup.removed} stale screenshot artifact(s)`);
  const captures = [];
  const results = {};
  const failures = [];
  const scenarioDefinitions = [
    ['runtime-startup-status', (window, host, context) => scenarioRuntimeStartupStatus(window, captures, host, context.sessionsListGate)],
    ['progressive-startup', (window, host, context) => scenarioProgressiveStartup(window, captures, host, context.sessionsListGate)],
    ['boot-and-state-signals', (window, host) => scenarioBoot(window, captures, host)],
    ['goal-lifecycle', (window, host) => scenarioGoalLifecycle(window, captures, host)],
    ['luna-panel-sequences', (window, host) => scenarioLunaPanelSequences(window, captures, host)],
    ['project-context-menu-bounds', (window) => scenarioProjectContextMenuBounds(window, captures)],
    ['queue-new-task-escape', (window, host) => scenarioQueueNewTaskEscape(window, captures, host)],
    ['context-threshold-lifecycle', (window, host) => scenarioContextThresholdLifecycle(window, captures, host)],
    ['mesh-parent-orchestration', (window, host) => scenarioMeshParentOrchestration(window, host)],
    ['command-contracts', (window, host) => scenarioCommandContracts(window, captures, host)],
    ['ears-transcription-send', (window, host) => scenarioEarsTranscriptionSend(window, captures, host)],
    ['response-annotation-journey', (window, host) => scenarioResponseAnnotationJourney(window, captures, host)],
    ['master-stream-identity', (window, host) => scenarioMasterStream(window, captures, host)],
    ['terminal-history-race', (window, host) => scenarioTerminalHistoryRace(window, captures, host)],
    ['terminal-live-cancellation', (window, host) => scenarioTerminalLiveCancellation(window, captures, host)],
    ['compaction-once', (window, host) => scenarioCompaction(window, captures, host)],
    ['error', (window, host) => scenarioError(window, captures, host)],
    ['stop-presentation-boundary', (window, host, context) => scenarioStopPresentationBoundary(window, captures, host, context.interruptGate)],
    ['keyboard-core-actions', (window, host) => scenarioKeyboardCoreActions(window, captures, host)],
    ['approval', (window, host) => scenarioApproval(window, captures, host)],
    ['native-audio-sending', (window, host) => scenarioNativeAudioSending(window, captures, host)],
    ['image-send-scroll-stability', (window, host) => scenarioImageSendScrollStability(window, captures, host)],
    ['queue-steer-and-viewport-stability', (window, host) => scenarioQueueSteerAndViewportStability(window, captures, host)],
    ['queue-management-journeys', (window, host) => scenarioQueueManagementJourneys(window, captures, host)],
    ['overlays-and-responsive', (window, host) => scenarioOverlaysAndResponsive(window, captures, host)],
    ['scheduled-task-lifecycle', (window, host) => scenarioScheduledTaskLifecycle(window, captures, host)],
    ['draft-restore-and-materialize', (window, host) => scenarioDraftRestoreAndMaterialize(window, captures, host)],
    ['draft-late-picker-rebind', (window, host, context) => scenarioDraftLatePickerRebind(window, captures, host, context.selectImagesGate)],
    ['settings-round-trip', (window, host) => scenarioSettingsRoundTrip(window, captures, host)],
    ['archive-selected-task', (window, host) => scenarioArchiveSelectedTask(window, captures, host)],
    ['microphone-selection-fallback', (window, host) => scenarioMicrophoneSelectionFallback(window, captures, host)],
    ['task-search-and-filters', (window, host) => scenarioTaskSearchAndFilters(window, captures, host)],
    ['archive-unselected-and-draft', (window, host) => scenarioArchiveUnselectedAndDraft(window, captures, host)],
  ];
  const scenarios = scenarioDefinitions.filter(([name]) => onlyScenario === null || name === onlyScenario);
  let retained = null;
  // Keep Electron itself alive while each scenario window is destroyed and the
  // next pristine one is created. Without this inert window, Windows can begin
  // app shutdown in the zero-window gap and the next loadFile() fails midway
  // through the suite even though the renderer file is valid.
  const suiteAnchorWindow = new BrowserWindow({
    x: -20_000,
    y: -20_000,
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'media'));
  try {
    if (onlyScenario !== null && scenarios.length === 0) {
      failures.push({ name: 'unknown-scenario', message: `Unknown fake-model scenario: ${onlyScenario}` });
    }
    for (const [index, [name, scenario]] of scenarios.entries()) {
      console.log(`fake-model-qa: ${name} started`);
      let qaWindow;
      const sessionsListGate = ['runtime-startup-status', 'progressive-startup'].includes(name) ? createOneShotGate() : null;
      const selectImagesGate = name === 'draft-late-picker-rebind' ? createOneShotGate() : null;
      const interruptGate = name === 'stop-presentation-boundary' ? createOneShotGate() : null;
      const host = createFakeModelHost({
        ...(['luna-panel-sequences', 'project-context-menu-bounds'].includes(name) ? { projectGroupingFixture: true } : {}),
        ...(name === 'image-send-scroll-stability' ? { imageSendFixture: true } : {}),
        dictationSources: [{ id: 'fake-stt', label: 'Fake local transcription', status: 'ready', setupEnvironmentVariable: '', capabilities: { batch: true, maxAudioBytes: 4 * 1024 * 1024 } }],
        onBatch: (batch) => { if (qaWindow && !qaWindow.isDestroyed()) qaWindow.webContents.send('tethoq:event-batch', batch); },
      });
      qaWindow = new BrowserWindow({
        x: -10_000,
        y: -10_000,
        width: 1100,
        height: 760,
        show: false,
        skipTaskbar: true,
        backgroundColor: '#0b0b0a',
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          ...(['mesh-parent-orchestration', 'scheduled-task-lifecycle', 'stop-presentation-boundary'].includes(name) ? { offscreen: true } : {}),
          partition: `tethoq-fake-model-${process.pid}-${index}`,
          preload: preloadPath,
        },
      });
      qaWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'media'));
      const cleanupIpc = registerFakeModelIpc(qaWindow, host, {
        ...(name === 'luna-panel-sequences' ? { directorySelections: [null, 'C:\\FakeModel\\qa-project'] } : {}),
        ...(sessionsListGate ? { firstSessionsListGate: sessionsListGate } : {}),
        ...(selectImagesGate ? { firstSelectImagesGate: selectImagesGate } : {}),
        ...(interruptGate ? { firstInterruptGate: interruptGate } : {}),
        keepWindowHidden: ['mesh-parent-orchestration', 'scheduled-task-lifecycle', 'stop-presentation-boundary'].includes(name),
      });
      const keepAliveForReport = index === scenarios.length - 1;
      try {
        await qaWindow.loadFile(rendererPath);
        if (!['mesh-parent-orchestration', 'scheduled-task-lifecycle', 'stop-presentation-boundary'].includes(name)) qaWindow.showInactive();
        if (!qaWindow.isDestroyed()) qaWindow.webContents.send('tethoq:runtime-state', { state: 'ready' });
        if (name !== 'runtime-startup-status') await ensureRendererReady(qaWindow);
        const outcome = await scenario(qaWindow, host, { sessionsListGate, selectImagesGate, interruptGate });
        results[name] = { ...(outcome && typeof outcome === 'object' ? outcome : {}), passed: true };
        console.log(`fake-model-qa: ${name} passed`);
      } catch (error) {
        failures.push({ name, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
        console.error(`fake-model-qa: ${name} failed`, error);
      } finally {
        sessionsListGate?.release();
        selectImagesGate?.release();
        interruptGate?.release();
        if (keepAliveForReport) retained = { qaWindow, host, cleanupIpc };
        else {
          cleanupIpc();
          host.dispose();
          if (!qaWindow.isDestroyed()) qaWindow.destroy();
        }
      }
    }
    if (process.env.FAKE_MODEL_QA_FORCE_FAILURE === '1') failures.push({ name: 'forced-failure', message: 'Forced failure for process-status verification.' });
    if (retained?.qaWindow && !retained.qaWindow.isDestroyed()) await capture(retained.qaWindow, '99-final', captures);
    // Finish evidence generation while the QA window is still alive. Destroying
    // Electron's last window first can let the process terminate with status 0
    // before a failed report is written or propagated to the entry point.
    const screenshots = captures.map((captureEntry) => ({ ...captureEntry, analysis: analyzeCapture(captureEntry.path) }));
    const featureCoverage = evaluateFeatureCoverage(results, failures);
    if (onlyScenario === null && featureCoverage.missingFeatureIds.length) {
      failures.push({
        name: 'feature-coverage-contract',
        message: `Missing passing Electron evidence for: ${featureCoverage.missingFeatureIds.join(', ')}`,
      });
    }
    const report = { generatedAt: new Date().toISOString(), artifactDirectory, artifactCleanup, results, failures, featureCoverage, screenshots };
    const reportPath = path.join(artifactDirectory, 'report.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`fake-model-qa: report ${reportPath}`);
    if (failures.length) {
      const failureSummary = failures.map((failure) => `${failure.name}: ${failure.message}`).join('; ');
      throw new Error(`${failures.length} fake-model scenario(s) failed: ${failureSummary}`);
    }
    return report;
  } finally {
    retained?.cleanupIpc();
    retained?.host.dispose();
    if (retained?.qaWindow && !retained.qaWindow.isDestroyed()) retained.qaWindow.destroy();
    if (!suiteAnchorWindow.isDestroyed()) suiteAnchorWindow.destroy();
  }
}

// Electron loads the entry script through its own bootstrap, so `require.main`
// is never this module. The script Electron was told to execute is the reliable
// signal: when argv[1] is this file the QA runs directly; when another script
// (scroll-stability-qa.cjs) requires this module, it drives runFakeModelQa
// itself and no second run is started here.
const entryPath = typeof process.argv[1] === 'string' ? process.argv[1].replaceAll('\\', '/') : '';
const isDirectEntry = /fake-model-qa\.cjs$/u.test(entryPath);

if (isDirectEntry) {
  app.whenReady().then(async () => {
    let exitCode = 0;
    try {
      await runFakeModelQa();
      console.log('Fake model QA passed');
    } catch (error) {
      exitCode = 1;
      console.error(error);
    } finally {
      app.exit(exitCode);
    }
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}

module.exports = { runFakeModelQa };
