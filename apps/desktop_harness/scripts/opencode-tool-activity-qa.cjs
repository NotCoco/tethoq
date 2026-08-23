'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const outputDirectory = path.resolve(appRoot, '..', '..', 'local-artifacts', 'qa-opencode-tool-activity');

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
  await mkdir(outputDirectory, { recursive: true });
  const window = new BrowserWindow({
    x: -10_000,
    y: -10_000,
    show: false,
    width: 1100,
    height: 900,
    backgroundColor: '#070707',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  try {
    await window.loadFile(rendererPath, { hash: 'opencode-tool-activity' });
    await waitFor(window, "document.querySelector('.desktop-app')", 'Desktop preview did not render');
    window.showInactive();
    await window.webContents.executeJavaScript(`(() => {
      const task = [...document.querySelectorAll('.session-row')].find((row) => row.textContent?.includes('Add checkout end-to-end test'));
      if (!task) throw new Error('OpenCode preview task did not render');
      task.click();
    })()`, true);
    await waitFor(window, "document.querySelectorAll('.activity-row').length === 3 || document.querySelector('.reasoning-disclosure')", 'OpenCode activity did not render');
    await window.webContents.executeJavaScript(`(() => {
      const disclosure = document.querySelector('.reasoning-disclosure[aria-expanded="false"]');
      if (disclosure) disclosure.click();
    })()`, true);
    await waitFor(window, "document.querySelectorAll('.activity-row').length === 3", 'Edit, write, and run rows did not render');

    const expected = [{ label: 'Edit', target: 'C:\\work\\src\\app.ts', detail: ['Replaced:', 'const old = true;', 'With:', 'const ready = true;'], file: 'edit.png' },
      { label: 'Write', target: 'C:\\work\\notes.md', detail: ['Written content:', '# Release notes', 'Ready for review.'], file: 'write.png' },
      { label: 'Run', target: 'npm test', detail: ['Command: npm test', 'Working directory: C:\\work', '12 tests passed'], file: 'run.png' }];
    const proof = [];
    for (let index = 0; index < expected.length; index += 1) {
      const state = await window.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.activity-row')];
        for (const [rowIndex, row] of rows.entries()) if (rowIndex !== ${index} && row.getAttribute('aria-expanded') === 'true') row.click();
        const row = rows[${index}];
        if (!row) throw new Error('Activity row ${index} is missing');
        if (row.getAttribute('aria-expanded') !== 'true') row.click();
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const detail = row.closest('.activity-disclosure')?.querySelector('.activity-snippet pre')?.textContent ?? '';
          row.scrollIntoView({ block: 'center' });
          resolve({
            label: row.querySelector('strong')?.textContent?.trim() ?? '',
            target: row.querySelector('.activity-target')?.textContent?.trim() ?? '',
            detail,
            generic: /(?:tool started|edit applied successfully|wrote file successfully)/i.test(detail),
          });
        })));
      })()`, true);
      assert.equal(state.label, expected[index].label);
      assert.equal(state.target, expected[index].target);
      for (const text of expected[index].detail) assert.match(state.detail, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(state.generic, false);
      proof.push(state);
      await writeFile(path.join(outputDirectory, expected[index].file), (await window.capturePage()).toPNG());
    }
    process.stdout.write(`${JSON.stringify({ proof, outputDirectory }, null, 2)}\n`);
  } finally {
    window.destroy();
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
