'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const artifactDirectory = path.join(appRoot, 'qa-artifacts', 'compaction-dedupe');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Software compositing keeps hidden/off-screen QA capture deterministic on Windows.
app.disableHardwareAcceleration();

async function waitFor(window, expression, label, timeout = 8_000) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (${expression}) return resolve(true);
      if (Date.now() - started > ${timeout}) return reject(new Error(${JSON.stringify(label)}));
      setTimeout(check, 30);
    };
    check();
  })`, true);
}

async function run() {
  const window = new BrowserWindow({
    x: -10_000,
    y: -10_000,
    width: 1000,
    height: 720,
    show: false,
    backgroundColor: '#070707',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  await window.loadFile(rendererPath, { hash: 'trace-compacted-duplicate' });
  window.showInactive();
  await waitFor(window, `document.querySelectorAll('.timeline-compaction-disclosure').length > 0`, 'Session compacted control did not render');
  const collapsed = await window.webContents.executeJavaScript(`(() => {
    const disclosures = [...document.querySelectorAll('.timeline-compaction-disclosure')];
    const disclosure = disclosures.at(-1);
    return {
      disclosureCount: disclosures.length,
      label: disclosure.querySelector('.timeline-compaction-toggle span')?.textContent,
      expanded: disclosure.querySelector('.timeline-compaction-toggle')?.getAttribute('aria-expanded'),
      details: disclosure.querySelectorAll('.timeline-compaction-detail').length,
    };
  })()`, true);
  assert.equal(collapsed.label, 'Session compacted');
  assert.equal(collapsed.expanded, 'false', 'Compaction summary should rest collapsed');
  assert.equal(collapsed.details, 0, 'Collapsed compaction summary leaked its detail');
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(path.join(artifactDirectory, 'session-compacted-collapsed.png'), (await window.capturePage()).toPNG());
  const point = await window.webContents.executeJavaScript(`(() => {
    const controls = [...document.querySelectorAll('.timeline-compaction-toggle')];
    const bounds = controls.at(-1).getBoundingClientRect();
    return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
  })()`, true);
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await waitFor(window, `document.querySelectorAll('.timeline-compaction-detail').length > 0`, 'Compaction detail did not open');
  await delay(150);
  const state = await window.webContents.executeJavaScript(`(() => {
    const disclosures = [...document.querySelectorAll('.timeline-compaction-disclosure')];
    const disclosure = disclosures.at(-1);
    const detail = disclosure.querySelector('.timeline-compaction-detail');
    const content = detail.querySelector('.rich-text');
    const copy = detail.querySelector('.timeline-compaction-copy');
    const contentBounds = content.getBoundingClientRect();
    const copyBounds = copy.getBoundingClientRect();
    return {
      heading: content.querySelector('h2')?.textContent,
      compactionCount: disclosures.length,
      nestedCompactions: disclosure.querySelectorAll('.timeline-compaction-nested').length,
      reasoningParent: Boolean(disclosure.closest('.reasoning-group')),
      copyBelowContent: copyBounds.top >= contentBounds.bottom - 0.5,
      detailScrollRegions: [...disclosure.querySelectorAll('*')].filter((node) => {
        const style = getComputedStyle(node);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1;
      }).length,
    };
  })()`, true);
  assert.equal(state.heading, 'Current task progress', 'The formatted compaction summary was not retained');
  assert.equal(state.compactionCount, collapsed.disclosureCount, 'Opening compaction created another disclosure');
  assert.equal(state.nestedCompactions, 0, 'A duplicate nested Session compacted disclosure remained');
  assert.equal(state.reasoningParent, false, 'Compaction stayed nested behind an outer Reasoning disclosure');
  assert.equal(state.copyBelowContent, true, 'Copy control overlaps compaction text');
  assert.ok(state.detailScrollRegions <= 1, `Expected one compaction scroll region, found ${state.detailScrollRegions}`);
  await window.webContents.executeJavaScript(`document.querySelectorAll('.timeline-compaction-disclosure')[document.querySelectorAll('.timeline-compaction-disclosure').length - 1].scrollIntoView({ block: 'center' })`, true);
  await delay(100);
  writeFileSync(path.join(artifactDirectory, 'session-compacted-expanded.png'), (await window.capturePage()).toPNG());
  await window.close();
  console.log(`Compaction dedupe QA passed: ${artifactDirectory}`);
}

app.whenReady().then(async () => {
  try {
    await run();
  } finally {
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
