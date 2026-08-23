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

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const defaultPreferences = {
  version: 1,
  experimentalFeatures: false,
  reasoningDisplay: 'compact',
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

function registerFakeModelIpc(window, host) {
  const handles = new Map();
  let preferences = JSON.parse(JSON.stringify(defaultPreferences));
  const handle = (channel, listener) => {
    handles.set(channel, listener);
    ipcMain.handle(channel, listener);
  };
  handle('tethoq:bootstrap', () => host.bootstrap());
  handle('tethoq:request', (_event, input) => {
    const record = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return host.handleRequest(typeof record.type === 'string' ? record.type : '', record.payload ?? {}, record.requestId);
  });
  handle('tethoq:select-directory', () => null);
  handle('tethoq:select-images', () => [{
    name: 'fake-attachment.png',
    path: 'C:\\FakeModel\\fake-attachment.png',
    mimeType: 'image/png',
    byteLength: 68,
    dataBase64: ONE_PIXEL_PNG_BASE64,
  }]);
  handle('tethoq:select-files', () => []);
  handle('tethoq:capture-screens', () => []);
  handle('tethoq:reveal-path', () => true);
  handle('tethoq:copy-text', () => true);
  handle('tethoq:local-open-handlers', () => localOpenState);
  handle('tethoq:open-local-target', () => ({ opened: true, handlerId: 'system', state: localOpenState }));
  handle('tethoq:open-dictation-setup-page', () => undefined);
  handle('tethoq:show-window', () => { if (!window.isDestroyed()) window.show(); });
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
    if (action?.type === 'set-experimental-features') preferences = { ...preferences, experimentalFeatures: action.enabled === true };
    if (action?.type === 'set-allow-foreign-subagents') preferences = { ...preferences, allowForeignSubagents: action.enabled === true };
    return preferences;
  });
  handle('tethoq:live-session-get-state', () => liveSessionIdleState);
  handle('tethoq:live-session-action', () => liveSessionIdleState);
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
  const point = await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.right < 0 || bounds.left > window.innerWidth || bounds.bottom < 0 || bounds.top > window.innerHeight) throw new Error('Element is outside the viewport or has no painted hit area: ' + ${JSON.stringify(selector)});
    const x = Math.round(bounds.left + bounds.width / 2);
    const y = Math.round(bounds.top + bounds.height / 2);
    if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Element is occluded at its click point: ' + ${JSON.stringify(selector)});
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
  const point = await evaluate(window, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0 || bounds.right < 0 || bounds.left > window.innerWidth || bounds.bottom < 0 || bounds.top > window.innerHeight) throw new Error('Element is outside the viewport or has no painted hit area: ' + ${JSON.stringify(selector)});
    return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
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
    button.scrollIntoView({ block: 'nearest' });
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
  await evaluate(window, `new Promise((resolve) => {
    const started = performance.now();
    let stableFrames = 0;
    let previousHeight = -1;
    const settle = () => {
      const scroller = document.querySelector('.conversation-scroll');
      if (!scroller) return resolve(false);
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (gap <= 2 && scroller.scrollHeight === previousHeight) stableFrames += 1;
      else stableFrames = 0;
      previousHeight = scroller.scrollHeight;
      if (stableFrames >= 4 || performance.now() - started >= 2_000) return resolve(true);
      requestAnimationFrame(settle);
    };
    settle();
  })`);
  await waitFor(window, `(() => { const s = document.querySelector('.conversation-scroll'); return s && s.scrollHeight - s.scrollTop - s.clientHeight <= 2; })()`, 'Could not reach the physical bottom');
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

async function scenarioContextThresholdLifecycle(window, captures, host) {
  const requestCount = () => host.stateForTests().requests.filter((entry) => entry.type === 'session.context.set_threshold').length;
  const initialRequests = requestCount();
  await openPopover(window, '.context-usage-trigger', '.context-usage-popover', 'context threshold');
  const initial = await evaluate(window, `(() => ({
    slider: Number(document.querySelector('input[aria-label="Automatic compaction threshold"]')?.value),
    heading: document.querySelector('.context-usage-heading b')?.textContent?.trim(),
    percent: document.querySelector('.context-usage-percent')?.textContent?.trim(),
  }))()`);
  assert.deepEqual(initial, { slider: 96_000, heading: '96.0k', percent: '4%' }, 'Context control did not open on the applied provider threshold');

  await evaluate(window, `(() => {
    const slider = document.querySelector('input[aria-label="Automatic compaction threshold"]');
    if (!(slider instanceof HTMLInputElement)) throw new Error('Context threshold slider is missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '40000');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(window, `document.querySelector('.context-usage-heading b')?.textContent?.trim() === '40.0k' && document.querySelector('.context-usage-percent')?.textContent?.trim() === '11%'`, 'Context draft did not preview its percentage');
  assert.equal(requestCount(), initialRequests, 'Dragging the context threshold applied before the user clicked Apply');
  await capture(window, '01-context-draft-preview', captures);

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(window, `!document.querySelector('.context-usage-popover')`, 'Escape did not dismiss context settings');
  assert.equal(await evaluate(window, `document.querySelector('.context-usage-percent')?.textContent?.trim()`), '4%', 'Escape left the unsaved context percentage painted as active');
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
  await waitFor(window, `!document.querySelector('.context-usage-popover') && document.querySelector('.context-usage-percent')?.textContent?.trim() === '11%'`, 'Applied context threshold did not update the compact meter');
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
    'context.draft-live-percentage': initial,
    'context.escape-discards-draft': true,
    'context.outside-click-discards-draft': true,
    'context.apply-once': applied.payload,
    'context.persist-on-reopen': 40_000,
    'context.success-is-silent': true,
  });
}

async function scenarioCommandContracts(window, captures, host) {
  await replaceComposerText(window, '/');
  const catalogue = await evaluate(window, `[...document.querySelectorAll('.slash-command-palette button strong')].map((node) => node.textContent?.trim())`);
  assert.deepEqual(catalogue, ['/simplify', '/mesh', '/ears', '/eyes'], 'The real composer command catalogue drifted');
  await capture(window, '01-command-catalogue', captures);

  await chooseSlashCommand(window, '/eyes');
  await waitFor(window, `Boolean(document.querySelector('.vision-eyes-picker'))`, '/eyes did not open the vision picker');
  const visionOptions = await evaluate(window, `(() => ({
    providers: [...document.querySelectorAll('select[aria-label="Vision provider"] option')].map((node) => node.textContent?.trim()),
    models: [...document.querySelectorAll('select[aria-label="Vision model"] option')].map((node) => node.textContent?.trim()),
  }))()`);
  assert.deepEqual(visionOptions.providers, ['Direct API', 'Codex', 'OpenCode', 'Grok']);
  assert.deepEqual(visionOptions.models, ['Direct Vision + Audio']);
  await evaluate(window, `(() => {
    const select = document.querySelector('select[aria-label="Vision provider"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('Vision provider select is missing');
    select.value = 'opencode';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(window, `document.querySelector('select[aria-label="Vision provider"]')?.value === 'opencode'`, '/eyes did not select OpenCode through keyboard input');
  assert.deepEqual(await evaluate(window, `[...document.querySelectorAll('select[aria-label="Vision model"] option')].map((node) => node.textContent?.trim())`), ['DeepSeek V4 Flash']);
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
  await clickMatchingButton(window, '.mesh-panel', 'OpenCode');
  await waitFor(window, `Boolean(document.querySelector('.mesh-model-picker'))`, '/mesh did not open OpenCode model selection');
  await clickSelector(window, '.mesh-model-picker-scroll section:nth-of-type(2) button:last-child');
  await clickMatchingButton(window, '.mesh-model-picker', 'Add to mesh');
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === '' && !document.querySelector('.mesh-model-picker')`, '/mesh did not settle after adding OpenCode');
  await delay(50);
  await chooseSlashCommand(window, '/mesh');
  await waitFor(window, `Boolean(document.querySelector('.mesh-panel'))`, '/mesh did not reopen the target picker');
  await clickMatchingButton(window, '.mesh-panel', 'Grok');
  await waitFor(window, `Boolean(document.querySelector('.mesh-model-picker'))`, '/mesh did not open Grok model selection');
  await clickSelector(window, '.mesh-model-picker-scroll section:nth-of-type(2) button:last-child');
  await clickMatchingButton(window, '.mesh-model-picker', 'Add to mesh');
  await replaceComposerText(window, 'Compare both harness implementations');
  await pressComposerEnter(window);
  await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ''`, '/mesh did not consume the submitted instruction');
  const meshRequest = host.stateForTests().requests.filter((entry) => entry.type === 'delegation.start').at(-1);
  assert.equal(meshRequest?.payload?.prompt, 'Compare both harness implementations');
  assert.deepEqual(meshRequest?.payload?.targets, [
    { providerId: 'opencode', modelId: 'deepseek/deepseek-v4-flash', reasoningEffort: 'max' },
    { providerId: 'grok', modelId: 'grok/vision', reasoningEffort: 'high' },
  ]);
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
  await clickSelector(window, 'button[aria-label="Stop recording"]');
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
  await waitFor(window, `document.querySelector('.desktop-app') && document.querySelector('.conversation-scroll') && document.querySelector('textarea[aria-label="Message"]')`, 'Renderer did not become ready', 15_000);
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
  try {
    await waitFor(window, `(() => { const reasoning = document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-reasoning"]`)}); const busy = reasoning?.matches('[aria-busy="true"]') || reasoning?.querySelector('[aria-busy="true"]'); const answer = document.querySelector(${JSON.stringify(`[data-scroll-anchor*="${runId}-fake-stream-answer"]`)}); return !busy && answer; })()`, 'Stream did not complete', 12_000);
  } catch (error) {
    const state = await evaluate(window, `({ members: [...document.querySelectorAll('[data-scroll-members]')].map((node) => node.getAttribute('data-scroll-members')).slice(-20), assistant: [...document.querySelectorAll('.message-assistant')].map((node) => node.textContent?.trim()).slice(-10), playing: ${JSON.stringify(host.stateForTests().playing)} })`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; stream state: ${JSON.stringify(state)}`);
  }
  await waitForSessionIdle(window);
  const settledCommandSelector = await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('.activity-row')].find((candidate) => candidate.textContent?.includes('npm run fake-check'));
    if (!(button instanceof HTMLElement)) throw new Error('Settled command disclosure is missing');
    button.dataset.fakeModelQaCommand = 'settled';
    return 'button[data-fake-model-qa-command="settled"]';
  })()`);
  await clickSelector(window, settledCommandSelector);
  await waitFor(window, `[...document.querySelectorAll('.activity-snippet')].some((node) => node.textContent?.includes('fake check passed'))`, 'Settled command disclosure did not reveal its concrete output');
  const identity = await evaluate(window, `(() => {
    const text = ${JSON.stringify(message)};
    const userRows = [...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes(text));
    const localEchoes = [...document.querySelectorAll('[data-scroll-anchor]')].filter((node) => String(node.dataset.scrollAnchor).startsWith('local-') && node.textContent?.includes(text));
    return {
      userRows: userRows.length,
      userRowDetails: userRows.map((node) => ({
        text: node.textContent?.trim() ?? '',
        anchor: node.closest('[data-scroll-anchor]')?.getAttribute('data-scroll-anchor') ?? null,
        members: node.closest('[data-scroll-members]')?.getAttribute('data-scroll-members') ?? null,
      })),
      localEchoes: localEchoes.length,
      reasoningGroups: document.querySelectorAll(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-reasoning"]`)}).length,
      toolMembers: document.querySelectorAll(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-tool"]`)}).length,
      commandMembers: document.querySelectorAll(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-command"]`)}).length,
      answerRows: document.querySelectorAll(${JSON.stringify(`[data-scroll-anchor*="${runId}-fake-stream-answer"]`)}).length,
      commandText: document.querySelector(${JSON.stringify(`[data-scroll-members*="${runId}-fake-stream-command"]`)})?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
      runningReasoningGroups: document.querySelectorAll('.reasoning-group[aria-busy="true"]').length,
      runningReasoningText: document.querySelectorAll('.reasoning-flow-running').length,
    };
  })()`);
  assert.equal(identity.userRows, 1, `Optimistic identity: expected one canonical user row, found ${identity.userRows}: ${JSON.stringify(identity.userRowDetails)}`);
  assert.equal(identity.localEchoes, 0, `Optimistic identity: the local-* echo row survived history insertion (${identity.localEchoes})`);
  assert.equal(identity.reasoningGroups, 1, `History insertion: reasoning group duplicated (${identity.reasoningGroups})`);
  assert.equal(identity.toolMembers, 1, `History insertion: tool activity duplicated (${identity.toolMembers})`);
  assert.equal(identity.commandMembers, 1, `History insertion: command activity duplicated (${identity.commandMembers})`);
  assert.equal(identity.answerRows, 1, `History insertion: final answer duplicated (${identity.answerRows})`);
  assert.match(identity.commandText, /npm run fake-check[\s\S]*fake check passed/u, `Settled command lost its command or output: ${identity.commandText}`);
  assert.equal(identity.runningReasoningGroups, 0, 'Settled reasoning kept an aria-busy shimmer owner');
  assert.equal(identity.runningReasoningText, 0, 'Settled reasoning text kept its running shimmer class');
  await evaluate(window, `document.querySelector(${JSON.stringify('button[data-fake-model-qa-command="settled"]')})?.removeAttribute('data-fake-model-qa-command')`);
  await capture(window, '02-stream-settled', captures);
  return scenarioOutcome('master-stream-identity', { activeReasoning, identity }, {
    'stream.reasoning-live-single-clickable': activeReasoning,
    'stream.reasoning-shimmer': { labelAnimation: activeReasoning.labelAnimation, flowAnimation: activeReasoning.flowAnimation },
    'stream.tool-command-details': { toolText: activeReasoning.toolText, commandText: identity.commandText },
    'stream.optimistic-user-reconciles-once': { userRows: identity.userRows, localEchoes: identity.localEchoes },
    'stream.history-insertion-no-duplicates': { reasoningGroups: identity.reasoningGroups, toolMembers: identity.toolMembers, commandMembers: identity.commandMembers, answerRows: identity.answerRows },
  });
}

async function scenarioTerminalHistoryRace(window, captures, host) {
  await ensureRendererReady(window);
  await clickTaskByTitle(window, 'Fake model main task');
  await submitComposer(window, 'restart mid-turn terminal history race');
  await waitFor(window, `[...document.querySelectorAll('.reasoning-group')].some((node) => node.textContent?.includes('Checking the persisted transcript'))`, 'Terminal history race did not show its running Reasoning row');
  await waitFor(window, `!document.querySelector('button[aria-label="Stop task"]')`, 'Terminal history race kept Stop visible after completion', 6_000);
  assert.equal(await evaluate(window, `[...document.querySelectorAll('.message-assistant')].filter((node) => node.textContent?.includes('The final reply arrived through persisted history')).length`), 0, 'Terminal history answer arrived before persisted history released it');

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Terminal history renderer reload timed out')), 8_000);
    window.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); });
    window.webContents.reload();
  });
  window.webContents.send('tethoq:runtime-state', { state: 'ready' });
  await ensureRendererReady(window);
  await clickTaskByTitle(window, 'Fake model main task');
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
  return scenarioOutcome('terminal-history-race', { reloadedMidTurn: true, ...settled }, {
    'history.terminal-before-final-recovers-after-reload': settled,
    'history.terminal-race-no-duplicate-or-stale-shimmer': settled,
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
  await clickSelector(window, 'button[aria-label="Stop recording"]');
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
  await clickSelector(window, settledReasoningSelector);
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
  assert.ok(await evaluate(window, `Boolean(document.querySelector('[data-scroll-members*="fake-attach-user-3"]'))`), 'Attachments: the file attachment row did not render');
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
  await waitFor(window, `[...document.querySelectorAll('.queued-message-row .queued-message-content > strong')].some((node) => node.textContent?.trim() === 'Queue management sibling B edited')`, 'Edited queue content did not render');
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

  const siblingD = enqueue('Queue management sibling D');
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
  await clickMatchingButton(window, '.queue-new-task-picker', 'Start task');
  await waitFor(window, `document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(siblingD.content)})`, 'Moved queue item did not open its new task', 8_000);
  const moveRequest = host.stateForTests().requests.filter((entry) => entry.type === 'message_queue.move_to_new_task').at(-1);
  assert.equal(moveRequest.payload.messageId, siblingD.id);
  assert.equal(moveRequest.payload.providerId, 'fake');
  assert.equal(moveRequest.payload.modelId, 'fake/deterministic-v1');
  assert.equal(moveRequest.payload.reasoningEffort, chosenSelection.effort);
  assert.deepEqual(host.stateForTests().queue.map((message) => message.id), [siblingA.id, siblingE.id], 'Move-to-task consumed or reordered a sibling');
  await waitFor(window, `[...document.querySelectorAll('.message-user')].filter((node) => node.textContent?.includes(${JSON.stringify(siblingD.content)})).length === 1`, 'Moved task did not receive the selected queued content', 8_000);
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
    ['boot-and-state-signals', (window, host) => scenarioBoot(window, captures, host)],
    ['context-threshold-lifecycle', (window, host) => scenarioContextThresholdLifecycle(window, captures, host)],
    ['command-contracts', (window, host) => scenarioCommandContracts(window, captures, host)],
    ['ears-transcription-send', (window, host) => scenarioEarsTranscriptionSend(window, captures, host)],
    ['response-annotation-journey', (window, host) => scenarioResponseAnnotationJourney(window, captures, host)],
    ['master-stream-identity', (window, host) => scenarioMasterStream(window, captures, host)],
    ['terminal-history-race', (window, host) => scenarioTerminalHistoryRace(window, captures, host)],
    ['compaction-once', (window, host) => scenarioCompaction(window, captures, host)],
    ['error', (window, host) => scenarioError(window, captures, host)],
    ['keyboard-core-actions', (window, host) => scenarioKeyboardCoreActions(window, captures, host)],
    ['approval', (window, host) => scenarioApproval(window, captures, host)],
    ['native-audio-sending', (window, host) => scenarioNativeAudioSending(window, captures, host)],
    ['queue-steer-and-viewport-stability', (window, host) => scenarioQueueSteerAndViewportStability(window, captures, host)],
    ['queue-management-journeys', (window, host) => scenarioQueueManagementJourneys(window, captures, host)],
    ['overlays-and-responsive', (window, host) => scenarioOverlaysAndResponsive(window, captures, host)],
    ['draft-restore-and-materialize', (window, host) => scenarioDraftRestoreAndMaterialize(window, captures, host)],
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
      const host = createFakeModelHost({
        dictationSources: [{ id: 'fake-stt', label: 'Fake local transcription', status: 'ready', setupEnvironmentVariable: '', capabilities: { batch: true, maxAudioBytes: 4 * 1024 * 1024 } }],
        onBatch: (batch) => { if (qaWindow && !qaWindow.isDestroyed()) qaWindow.webContents.send('tethoq:event-batch', batch); },
      });
      qaWindow = new BrowserWindow({
        x: -10_000,
        y: -10_000,
        width: 1100,
        height: 760,
        show: false,
        backgroundColor: '#0b0b0a',
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          preload: preloadPath,
        },
      });
      const cleanupIpc = registerFakeModelIpc(qaWindow, host);
      const keepAliveForReport = index === scenarios.length - 1;
      try {
        await qaWindow.loadFile(rendererPath);
        qaWindow.showInactive();
        if (!qaWindow.isDestroyed()) qaWindow.webContents.send('tethoq:runtime-state', { state: 'ready' });
        await ensureRendererReady(qaWindow);
        const outcome = await scenario(qaWindow, host);
        results[name] = { ...(outcome && typeof outcome === 'object' ? outcome : {}), passed: true };
        console.log(`fake-model-qa: ${name} passed`);
      } catch (error) {
        failures.push({ name, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
        console.error(`fake-model-qa: ${name} failed`, error);
      } finally {
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
