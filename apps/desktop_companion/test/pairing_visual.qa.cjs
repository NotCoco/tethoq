'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const QRCode = require('qrcode');
const { app, BrowserWindow, ipcMain } = require('electron');
const { SECURE_WEB_PREFERENCES } = require('../src/security.cjs');
const { pairingQrDataUrl } = require('../src/pairing_process.cjs');

const outputDirectory = path.resolve(process.argv[2] ?? path.join(__dirname, '..', 'qa-artifacts-compact'));
const sizes = [
  { name: 'summary-432x226', width: 432, height: 226, view: 'summary' },
  { name: 'pairing-432x518', width: 432, height: 518, view: 'pairing' },
  { name: 'pairing-scaled-360x420', width: 360, height: 420, view: 'pairing' },
];
let fixtureState = 'ready';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

async function installFixtureIpc() {
  const prefix = 'tethoq://pair?payload=';
  const payload = prefix + 'a'.repeat(495 - Buffer.byteLength(prefix));
  const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
  const qrDataUrl = pairingQrDataUrl(`<div class="qr">${svg}</div>`);
  const handlers = {
    'tethoq:get-preview-state': () => 'first-run',
    'tethoq:complete-preview': () => 'connected',
    'tethoq:reset-preview': () => 'first-run',
    'tethoq:get-app-meta': () => ({ name: 'Tethoq Bridge', version: '0.1.0', preview: true }),
    'tethoq:get-pairing-status': () => ({ state: 'idle' }),
    'tethoq:start-pairing': () => fixtureState === 'error'
      ? { state: 'error', message: 'The public connection could not be prepared. Generate a new code and try again.' }
      : { state: 'ready', expiresAt: new Date(Date.now() + 300_000).toISOString(), qrDataUrl },
    'tethoq:cancel-pairing': () => ({ state: 'idle' }),
    'tethoq:abort-pairing-start': () => ({ state: 'idle' }),
    'tethoq:set-window-mode': (_event, mode) => mode,
    'tethoq:window-minimize': () => undefined,
    'tethoq:window-hide': () => undefined,
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
}

async function waitFor(window, expression) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (${expression}) return resolve();
      if (Date.now() - started > 5000) return reject(new Error('UI did not settle'));
      setTimeout(check, 25);
    };
    check();
  })`, true);
}

async function capture(size, state = 'ready') {
  fixtureState = state;
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: path.resolve(__dirname, '..', 'src', 'preload.cjs') },
  });
  await window.loadFile(path.resolve(__dirname, '..', 'src', 'index.html'));
  await waitFor(window, `document.querySelector('#version-label').textContent === 'v0.1.0'`);
  if (size.view === 'pairing') {
    await window.webContents.executeJavaScript("document.querySelector('#show-pairing').click()", true);
    await waitFor(window, state === 'ready'
      ? `document.querySelector('#pairing-qr').complete && document.querySelector('#pairing-qr').naturalWidth > 0`
      : `!document.querySelector('#retry-pairing').hidden`);
  }
  const layout = await window.webContents.executeJavaScript(`(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector).getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom };
    };
    const controls = document.querySelector('.window-controls');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      companion: rect('.companion'),
      summaryHidden: document.querySelector('#summary').hidden,
      panelHidden: document.querySelector('#pairing-panel').hidden,
      qr: document.querySelector('.qr-frame') ? rect('.qr-frame') : null,
      retryHidden: document.querySelector('#retry-pairing').hidden,
      retryText: document.querySelector('#retry-pairing').textContent.trim(),
      controlsOpacity: getComputedStyle(controls).opacity,
      closeLabel: document.querySelector('#window-close').getAttribute('aria-label'),
      markSource: document.querySelector('#bridge-mark').getAttribute('src'),
    };
  })()`, true);
  const image = await window.webContents.capturePage();
  await writeFile(path.join(outputDirectory, `${state}-${size.name}.png`), image.toPNG());
  assert.ok(layout.document.width <= layout.viewport.width, `${size.name}: horizontal overflow`);
  assert.ok(layout.document.height <= layout.viewport.height, `${size.name}: vertical overflow`);
  assert.equal(layout.closeLabel, 'Close to tray');
  assert.equal(layout.controlsOpacity, '0');
  assert.equal(layout.markSource, 'assets/tethoq-bridge.png');
  if (size.view === 'summary') {
    assert.equal(layout.summaryHidden, false);
    assert.equal(layout.panelHidden, true);
  } else {
    assert.equal(layout.summaryHidden, true);
    assert.equal(layout.panelHidden, false);
    if (state === 'ready') {
      assert.ok(layout.qr.width >= 220, `${size.name}: QR became too small`);
      assert.ok(Math.abs(layout.qr.width - layout.qr.height) < 1, `${size.name}: QR is not square`);
      assert.equal(layout.retryHidden, true);
    } else {
      assert.equal(layout.retryHidden, false);
      assert.equal(layout.retryText, 'Generate a new code');
    }
  }
  process.stdout.write(`${state}-${size.name} ${JSON.stringify(layout)}\n`);
  window.destroy();
}

app.whenReady().then(async () => {
  try {
    await mkdir(outputDirectory, { recursive: true });
    await installFixtureIpc();
    for (const size of sizes) await capture(size, 'ready');
    for (const size of sizes.filter((candidate) => candidate.view === 'pairing')) await capture(size, 'error');
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  }
});
