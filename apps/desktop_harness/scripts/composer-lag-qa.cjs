'use strict';

/**
 * Focused, zero-provider renderer latency probe for the desktop composer.
 *
 * It drives the ordinary browser-preview composer, records input-handler and
 * next-task latency, then repeats with a large but valid pasted PNG attached.
 * The PNG is a real 1x1 image with inert trailing bytes, so Chromium can decode
 * it while the composer still exercises its multi-megabyte draft path.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function waitFor(window, expression, failureMessage, timeoutMs = 8_000) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      if (${expression}) return resolve();
      if (performance.now() - started > ${timeoutMs}) return reject(new Error(${JSON.stringify(failureMessage)}));
      requestAnimationFrame(check);
    };
    check();
  })`, true);
}

async function sampleTyping(window, label, count = 36) {
  return window.webContents.executeJavaScript(`(async () => {
    const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Message composer is unavailable');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const dispatch = [];
    const settled = [];
    for (let index = 0; index < ${count}; index += 1) {
      const next = textarea.value + String.fromCharCode(97 + index % 26);
      const started = performance.now();
      setValue.call(textarea, next);
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next.at(-1) }));
      const dispatched = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 0));
      dispatch.push(dispatched - started);
      settled.push(performance.now() - started);
    }
    const summarize = (values) => {
      const ordered = [...values].sort((left, right) => left - right);
      const percentile = (fraction) => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
      return {
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: ordered.at(-1),
      };
    };
    return { label: ${JSON.stringify(label)}, dispatch: summarize(dispatch), settled: summarize(settled) };
  })()`, true);
}

async function pasteLargePng(window, trailingBytes = 10 * 1024 * 1024) {
  await window.webContents.executeJavaScript(`(() => {
    const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Message composer is unavailable');
    const base = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([base, new Uint8Array(${trailingBytes})], 'large-pasted-image.png', { type: 'image/png' }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    textarea.dispatchEvent(event);
  })()`, true);
  await waitFor(window, "document.querySelector('.image-attachment-chip')", 'Large pasted image did not attach', 15_000);
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
}

async function main() {
  const window = new BrowserWindow({
    x: -10_000,
    y: -10_000,
    show: false,
    width: 1280,
    height: 860,
    backgroundColor: '#070707',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  try {
    await window.loadFile(rendererPath, { hash: 'workspace' });
    await waitFor(window, "document.querySelector('.workspace textarea[aria-label=\"Message\"]')", 'Message composer did not render');
    const idleTaskSelected = await window.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('.session-row')].find((candidate) => candidate.textContent?.includes('Add checkout end-to-end test'));
      row?.click();
      return Boolean(row);
    })()`, true);
    assert.equal(idleTaskSelected, true, 'Idle preview task did not render');
    await waitFor(window, "document.querySelector('.send-button[aria-label=\"Send instruction\"]')", 'Idle task composer did not render');

    const baseline = await sampleTyping(window, 'text-only');
    await pasteLargePng(window);
    const withImage = await sampleTyping(window, '10 MiB pasted image');
    const attachmentState = await window.webContents.executeJavaScript(`(() => ({
      count: document.querySelectorAll('.image-attachment-chip').length,
      heap: performance.memory ? {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.totalJSHeapSize,
      } : null,
    }))()`, true);
    process.stdout.write(`${JSON.stringify({ baseline, withImage, attachmentState }, null, 2)}\n`);
  } finally {
    window.destroy();
  }
}

app.whenReady().then(main).then(() => app.quit(), (error) => {
  console.error(error);
  app.exitCode = 1;
  app.quit();
});
