'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const outputDirectory = path.resolve(appRoot, '..', '..', 'local-artifacts', 'qa-opencode-queue-steer');
const screenshotPath = path.join(outputDirectory, 'queued-not-transcript.png');
const canary = 'Use DeepSeek V4 Flash subagents';

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function waitFor(window, expression, message) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const value = (${expression});
      if (value) return resolve(value);
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
    await window.loadFile(rendererPath, { hash: 'opencode-queue-steer' });
    await waitFor(window, "document.querySelector('.desktop-app')", 'Desktop preview did not render');
    await waitFor(window, "!document.body.textContent.includes('Loading your coding tools')", 'Desktop preview did not finish loading');
    window.showInactive();
    await window.webContents.executeJavaScript(`(() => {
      const task = [...document.querySelectorAll('.session-row')].find((row) => row.textContent?.includes('Add checkout end-to-end test'));
      if (!task) throw new Error('OpenCode preview task did not render');
      task.click();
    })()`, true);
    await waitFor(window, "document.querySelector('textarea[aria-label=\"Message\"]')", 'OpenCode composer did not render');
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea[aria-label="Message"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(canary)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    })()`, true);
    await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(canary)}`, 'Canary text did not reach the composer');
    await window.webContents.executeJavaScript("document.querySelector('.send-button').click()", true);
    await waitFor(window, `document.querySelector('.queued-message-content')?.textContent?.includes(${JSON.stringify(canary)})`, 'The in-flight message did not enter the queue');

    const queued = await window.webContents.executeJavaScript(`(() => ({
      transcriptOccurrences: [...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length,
      queueOccurrences: [...document.querySelectorAll('.queued-message-content')].filter((node) => node.textContent?.includes(${JSON.stringify(canary)})).length,
      actionText: document.querySelector('.queued-steer')?.textContent?.trim() ?? '',
      actionDisabled: document.querySelector('.queued-steer')?.disabled ?? true,
      composer: document.querySelector('textarea[aria-label="Message"]')?.value ?? null,
    }))()`, true);
    assert.equal(queued.transcriptOccurrences, 0, 'A pending OpenCode instruction was painted as a sent chat message.');
    assert.equal(queued.queueOccurrences, 1, 'The pending instruction was not represented exactly once in the queue.');
    assert.equal(queued.actionText, 'Steer');
    assert.equal(queued.actionDisabled, false);
    assert.equal(queued.composer, '');
    await writeFile(screenshotPath, (await window.capturePage()).toPNG());

    await window.webContents.executeJavaScript("document.querySelector('.queued-steer').click()", true);
    await waitFor(window, "!document.querySelector('.queued-message-row')", 'The steered instruction remained in the queue');
    const delivered = await window.webContents.executeJavaScript(`(() => ({
      errorToasts: [...document.querySelectorAll('.toast')].filter((node) => node.textContent?.trim()).map((node) => node.textContent.trim()),
      transcriptOccurrences: [...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length,
    }))()`, true);
    assert.deepEqual(delivered.errorToasts, [], 'Steering produced an error notification.');
    assert.equal(delivered.transcriptOccurrences, 0, 'The preview must not fabricate provider history after delivery.');

    process.stdout.write(`${JSON.stringify({
      pendingTranscriptOccurrences: queued.transcriptOccurrences,
      pendingQueueOccurrences: queued.queueOccurrences,
      deliveryAction: queued.actionText,
      deliveredWithoutError: true,
      screenshotPath,
    }, null, 2)}\n`);
  } finally {
    window.destroy();
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
