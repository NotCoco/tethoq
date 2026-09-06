'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const artifactRoot = path.resolve(appRoot, '..', '..', 'local-artifacts', 'qa-spinner-motion');
const screenshotPath = path.join(artifactRoot, 'shared-working-spinner.png');
const reportPath = path.join(artifactRoot, 'shared-working-spinner.json');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function waitFor(window, expression, message) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (${expression}) return resolve();
      if (Date.now() - started > 5000) return reject(new Error(${JSON.stringify(message)}));
      requestAnimationFrame(check);
    };
    check();
  })`, true);
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  const window = new BrowserWindow({
    x: -10_000,
    y: -10_000,
    show: false,
    width: 1100,
    height: 760,
    backgroundColor: '#070707',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  try {
    await window.loadFile(rendererPath, { hash: 'spinner-motion' });
    await waitFor(window, "document.querySelector('.desktop-app')", 'Desktop preview did not render');
    window.showInactive();
    await waitFor(window, "document.querySelector('.session-row-working-spinner') && document.querySelector('.workspace-title .spinner')", 'Both working spinners did not render');

    const result = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const row = document.querySelector('.session-row-working-spinner');
      const header = document.querySelector('.workspace-title .spinner');
      const indicator = document.querySelector('.session-row-working-indicator');
      if (!(row instanceof HTMLElement) || !(header instanceof HTMLElement) || !(indicator instanceof HTMLElement)) throw new Error('Working spinner geometry is unavailable');
      const style = (node) => {
        const computed = getComputedStyle(node);
        return {
          animationName: computed.animationName,
          animationDuration: computed.animationDuration,
          animationTimingFunction: computed.animationTimingFunction,
          animationIterationCount: computed.animationIterationCount,
          animationPlayState: computed.animationPlayState,
          borderTopColor: computed.borderTopColor,
          borderRightColor: computed.borderRightColor,
          width: node.offsetWidth,
          height: node.offsetHeight,
        };
      };
      const samples = [];
      const started = performance.now();
      const sample = (now) => {
        samples.push({ atMs: Number((now - started).toFixed(2)), transform: getComputedStyle(row).transform });
        if (now - started >= 300) {
          resolve({
            row: style(row),
            header: style(header),
            indicatorHasTooltip: indicator.getAttribute('data-tooltip') === 'Working',
            rotatingElementHasTooltip: row.hasAttribute('data-tooltip'),
            samples,
            distinctTransforms: new Set(samples.map((entry) => entry.transform)).size,
          });
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })`, true);

    assert.equal(result.row.animationName, result.header.animationName);
    assert.equal(result.row.animationDuration, result.header.animationDuration);
    assert.equal(result.row.animationTimingFunction, 'linear');
    assert.equal(result.row.animationTimingFunction, result.header.animationTimingFunction);
    assert.equal(result.row.animationIterationCount, 'infinite');
    assert.equal(result.row.animationPlayState, 'running');
    assert.equal(result.row.borderRightColor, result.header.borderRightColor);
    assert.notEqual(result.row.borderTopColor, result.row.borderRightColor);
    assert.notEqual(result.header.borderTopColor, result.header.borderRightColor);
    assert.equal(result.row.width, 12);
    assert.equal(result.row.height, 12);
    assert.equal(result.indicatorHasTooltip, true);
    assert.equal(result.rotatingElementHasTooltip, false);
    assert.ok(result.samples.length >= 10, `Only ${result.samples.length} animation frames were sampled`);
    assert.ok(result.distinctTransforms >= 8, `Spinner painted only ${result.distinctTransforms} distinct transforms in 300ms`);

    await writeFile(screenshotPath, (await window.capturePage()).toPNG());
    const report = { ...result, screenshotPath };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    window.destroy();
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
