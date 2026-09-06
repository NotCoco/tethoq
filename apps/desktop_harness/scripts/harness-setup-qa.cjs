'use strict';
const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'qa-artifacts', 'harness-setup'));
app.setPath('userData', path.join(output, 'profile'));
app.on('window-all-closed', () => {});
async function waitFor(window, selector) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => document.querySelector(${JSON.stringify(selector)}) ? resolve() : Date.now() - started > 10000 ? reject(new Error('Missing ' + ${JSON.stringify(selector)})) : setTimeout(poll, 30);
    poll();
  })`, true);
}
app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const results = [];
  for (const [width, height] of [[1440, 900], [760, 480]]) {
    const window = new BrowserWindow({ width, height, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    try {
      await window.loadFile(path.join(root, 'out', 'renderer', 'index.html'), { hash: 'settings' });
      await waitFor(window, '.sidebar-footer');
      await window.webContents.executeJavaScript(`document.querySelector('.sidebar-footer button[aria-label="Settings"]')?.click() || [...document.querySelectorAll('.sidebar-footer button')].find(b => b.textContent.includes('Settings'))?.click()`, true);
      await waitFor(window, '#harness-connections');
      // Exercise copy through the rendered action, without changing the OS clipboard.
      await window.webContents.executeJavaScript(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__setupCopied = value; } } })`, true);
      const options = await window.webContents.executeJavaScript(`[...document.querySelectorAll('#harness-choice option')].map(o => o.value)`);
      assert.equal(options.length, 13);
      for (const id of options) {
        await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('#harness-choice'); select.value = ${JSON.stringify(id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`, true);
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await window.webContents.executeJavaScript(`[...document.querySelectorAll('.harness-connection-actions button')].find(b => b.textContent.includes('Copy setup prompt')).click()`, true);
        const copied = await window.webContents.executeJavaScript(`window.__setupCopied`);
        assert.match(copied, /provider_contract\/src\/types.ts/);
        assert.match(copied, /Verification|Verify the installed/);
        if (id === 'other') assert.match(copied, /context.executeHostTool/);
      }
      for (const id of ['opencode', 'grok', 'other']) {
        await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('#harness-choice'); select.value = ${JSON.stringify(id)}; select.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('.harness-setup-details').open = ${id === 'other'}; document.querySelector('#harness-connections').scrollIntoView({ block: 'start' }); })()`, true);
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const layout = await window.webContents.executeJavaScript(`(() => {
          const panel = document.querySelector('#harness-connections');
          const bounds = panel.getBoundingClientRect();
          return { width: innerWidth, panelWidth: bounds.width, left: bounds.left, right: bounds.right, overflow: document.documentElement.scrollWidth > innerWidth, text: panel.textContent, prompt: panel.querySelector('textarea').value };
        })()`);
        assert.equal(layout.overflow, false);
        assert.ok(layout.left >= 0 && layout.right <= layout.width + 1);
        assert.match(layout.text, /Retry connection|Open connector folder/);
        await writeFile(path.join(output, `${id}-${width}x${height}.png`), (await window.webContents.capturePage()).toPNG());
        results.push({ id, width, height, panelWidth: layout.panelWidth, overflow: layout.overflow });
      }
    } finally { window.destroy(); }
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: true, promptCopies: 26, captures: results }));
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
