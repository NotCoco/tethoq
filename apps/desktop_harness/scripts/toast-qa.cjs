'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const outputDirectory = path.resolve(appRoot, '..', '..', 'local-artifacts', 'qa-error-only-toasts');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function waitFor(window, expression, failureMessage) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (${expression}) return resolve();
      if (Date.now() - started > 5000) return reject(new Error(${JSON.stringify(failureMessage)}));
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
    height: 760,
    backgroundColor: '#070707',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  try {
    await window.loadFile(rendererPath, { hash: 'workspace' });
    await waitFor(window, "document.querySelector('.workspace textarea[aria-label=\"Message\"]')", 'Message composer did not render');
    window.showInactive();
    await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
    await window.webContents.executeJavaScript(`(() => {
      const idleTask = [...document.querySelectorAll('.session-row')].find((row) => row.textContent?.includes('Add checkout end-to-end test'));
      if (!idleTask) throw new Error('Idle preview task did not render');
      idleTask.click();
    })()`, true);
    await waitFor(window, "document.querySelector('.send-button[aria-label=\"Send instruction\"]')", 'Idle task Send button did not render');

    await window.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
      if (!textarea) throw new Error('Message composer is unavailable');
      const transfer = new DataTransfer();
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (character) => character.charCodeAt(0));
      transfer.items.add(new File([png], 'pasted-image.png', { type: 'image/png' }));
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      textarea.dispatchEvent(event);
    })()`, true);
    await waitFor(window, "document.querySelector('.image-attachment-chip')", 'Pasted image did not attach');
    await new Promise((resolve) => setTimeout(resolve, 150));

    const positiveState = await window.webContents.executeJavaScript(`(() => {
      const send = document.querySelector('.send-button[aria-label="Send instruction"]');
      if (!send) throw new Error('Send button did not render');
      const bounds = send.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return {
        attachmentCount: document.querySelectorAll('.image-attachment-chip').length,
        toastCount: document.querySelectorAll('.toast').length,
        sendVisible: bounds.width > 0 && bounds.height > 0,
        sendHitTarget: hit === send || send.contains(hit),
      };
    })()`, true);
    assert.deepEqual(positiveState, { attachmentCount: 1, toastCount: 0, sendVisible: true, sendHitTarget: true });
    await writeFile(path.join(outputDirectory, 'pasted-image-no-toast.png'), (await window.capturePage()).toPNG());

    await window.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
      if (!textarea) throw new Error('Message composer is unavailable');
      const transfer = new DataTransfer();
      transfer.items.add(new File([], 'empty-image.png', { type: 'image/png' }));
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      textarea.dispatchEvent(event);
    })()`, true);
    await waitFor(window, "document.querySelector('.toast-error')", 'Existing paste error toast did not render');
    const errorState = await window.webContents.executeJavaScript(`(() => ({
      toastCount: document.querySelectorAll('.toast').length,
      errorToastCount: document.querySelectorAll('.toast-error').length,
      message: document.querySelector('.toast-error')?.textContent?.trim(),
    }))()`, true);
    assert.deepEqual(errorState, {
      toastCount: 1,
      errorToastCount: 1,
      message: 'Pasted images must be between 1 byte and 25 MiB.',
    });
    await writeFile(path.join(outputDirectory, 'existing-error-toast.png'), (await window.capturePage()).toPNG());
    process.stdout.write(`${JSON.stringify({ positiveState, errorState, outputDirectory }, null, 2)}\n`);
  } finally {
    window.destroy();
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
