'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const outputDirectory = path.resolve(process.argv[2] ?? path.join(appRoot, 'qa-artifacts', 'annotations'));

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function evaluate(window, source) {
  return window.webContents.executeJavaScript(source, true);
}

async function waitFor(window, expression, label, timeout = 8_000) {
  await evaluate(window, `new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (${expression}) return resolve(true);
      if (Date.now() - started > ${timeout}) return reject(new Error(${JSON.stringify(label)}));
      setTimeout(check, 30);
    };
    check();
  })`);
}

async function setTextarea(window, selector, value) {
  await evaluate(window, `(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('Textarea not found: ' + ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function click(window, selector) {
  await evaluate(window, `(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLElement)) throw new Error('Control not found: ' + ${JSON.stringify(selector)});
    control.click();
  })()`);
}

async function clickInput(window, selector) {
  const point = await evaluate(window, `(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    if (!(control instanceof HTMLElement)) throw new Error('Control not found: ' + ${JSON.stringify(selector)});
    const bounds = control.getBoundingClientRect();
    return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function pressEscape(window) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function openTask(window, title) {
  await evaluate(window, `(() => {
    const row = [...document.querySelectorAll('.session-row')].find((candidate) => candidate.textContent?.includes(${JSON.stringify(title)}));
    if (!(row instanceof HTMLElement)) throw new Error('Task row not found: ' + ${JSON.stringify(title)});
    row.click();
  })()`);
  await waitFor(window, `document.querySelector('.workspace textarea[aria-label="Message"]')`, `Task did not open: ${title}`);
}

async function openAnnotationEditor(window, selectedText, actionCapture) {
  const releasePoint = await evaluate(window, `(() => {
    const body = [...document.querySelectorAll('.message-assistant .message-body')].find((candidate) => candidate.textContent?.includes(${JSON.stringify(selectedText)}));
    if (!(body instanceof HTMLElement)) throw new Error('Assistant text not found');
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent?.indexOf(${JSON.stringify(selectedText)}) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + ${selectedText.length});
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const bounds = range.getBoundingClientRect();
      const point = {
        x: Math.round(bounds.left + Math.min(bounds.width, 30)),
        y: Math.round(bounds.bottom),
      };
      body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: point.x, clientY: point.y }));
      return point;
    }
    throw new Error('Selected text node not found');
  })()`);
  const actionSelector = '.annotation-context-menu';
  await waitFor(window, `document.querySelector(${JSON.stringify(actionSelector + ' button')})`, 'Annotate context action did not open');
  const actionBounds = await evaluate(window, `(() => {
    const value = document.querySelector(${JSON.stringify(actionSelector)})?.getBoundingClientRect();
    return value ? { left: value.left, top: value.top, right: value.right, bottom: value.bottom } : null;
  })()`);
  const viewport = await evaluate(window, `({ width: innerWidth, height: innerHeight })`);
  assert.ok(actionBounds, 'Annotate context action has no bounds');
  assert.ok(actionBounds.left >= 0 && actionBounds.top >= 0 && actionBounds.right <= viewport.width && actionBounds.bottom <= viewport.height, 'Annotate context action escaped the viewport');
  // The menu is anchored at the right-click, not floated above the pointer.
  assert.ok(actionBounds.bottom >= releasePoint.y, 'The annotation menu did not anchor at the right-click');
  if (actionCapture) await capture(window, actionCapture);
  // Copy sits first in this menu, so the editor must be opened by name.
  await click(window, `${actionSelector} button[aria-label="Annotate selected response"]`);
  await waitFor(window, `document.querySelector('.annotation-editor textarea')`, 'Annotation editor did not open');
}

async function addAnnotation(window, selectedText, comment, editorCapture, actionCapture) {
  const previousCount = await evaluate(window, `document.querySelectorAll('.composer-annotation-chip').length`);
  await openAnnotationEditor(window, selectedText, actionCapture);
  await setTextarea(window, '.annotation-editor textarea', comment);
  const editorBounds = await evaluate(window, `(() => { const value = document.querySelector('.annotation-editor')?.getBoundingClientRect(); return value ? { left: value.left, top: value.top, right: value.right, bottom: value.bottom } : null; })()`);
  assert.ok(editorBounds && editorBounds.left >= 0 && editorBounds.top >= 0 && editorBounds.right <= await evaluate(window, 'innerWidth') && editorBounds.bottom <= await evaluate(window, 'innerHeight'), 'Annotation editor is clipped by the viewport');
  if (editorCapture) await capture(window, editorCapture);
  await click(window, '.annotation-editor-send');
  await waitFor(window, `!document.querySelector('.annotation-editor')`, 'Annotation editor did not close after add');
  await waitFor(window, `document.querySelectorAll('.composer-annotation-chip').length === ${previousCount + 1}`, 'Annotation chip did not reach the composer');
}

async function annotationChipLayout(window) {
  return evaluate(window, `(() => {
    const chip = document.querySelector('.composer-annotation-chip:first-child');
    const main = chip?.querySelector('.composer-annotation-main');
    const text = main?.querySelector('span');
    if (!(chip instanceof HTMLElement) || !(main instanceof HTMLElement) || !(text instanceof HTMLElement)) return null;
    const bounds = (node) => {
      const value = node.getBoundingClientRect();
      return { left: value.left, right: value.right };
    };
    const chipBounds = bounds(chip);
    const escaping = [...chip.querySelectorAll(':scope > button, .composer-annotation-main > *')]
      .filter((node) => {
        const value = bounds(node);
        return value.left < chipBounds.left - 1 || value.right > chipBounds.right + 1;
      })
      .map((node) => node.className || node.tagName);
    const style = getComputedStyle(text);
    return {
      chip: chipBounds,
      main: bounds(main),
      text: bounds(text),
      textClientWidth: text.clientWidth,
      textScrollWidth: text.scrollWidth,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      escaping,
    };
  })()`);
}

async function capture(window, name) {
  await evaluate(window, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const image = await window.capturePage();
  await writeFile(path.join(outputDirectory, `${name}.png`), image.toPNG());
}

async function layout(window) {
  return evaluate(window, `(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const value = node.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
    };
    const viewport = { width: innerWidth, height: innerHeight };
    const required = ['.workspace', '.composer-wrap', '.composer-annotation-chips', '.send-button'];
    const regions = Object.fromEntries(required.map((selector) => [selector, rect(selector)]));
    const clipped = Object.entries(regions).filter(([, value]) => value && (value.left < -1 || value.top < -1 || value.right > innerWidth + 1 || value.bottom > innerHeight + 1)).map(([selector]) => selector);
    return { viewport, regions, clipped, documentText: document.querySelector('.conversation')?.textContent ?? '' };
  })()`);
}

async function createWindow(width, height) {
  const window = new BrowserWindow({
    x: -10_000,
    y: -10_000,
    width,
    height,
    show: false,
    backgroundColor: '#070707',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadFile(rendererPath, { hash: 'annotation-qa' });
  await waitFor(window, `document.querySelector('.desktop-app')`, 'Renderer did not become ready');
  window.showInactive();
  if (!await evaluate(window, `Boolean(document.querySelector('.workspace textarea[aria-label="Message"]'))`)) {
    await openTask(window, 'Listen to my recording');
  } else {
    await openTask(window, 'Listen to my recording');
  }
  await evaluate(window, `new Promise((resolve) => setTimeout(resolve, 250))`);
  return window;
}

async function runNormalFlow() {
  const window = await createWindow(1100, 760);
  const firstText = 'I listened to your recording. The plan is to ship the direct-audio dictate option only for models whose input modalities include audio, and to keep the MP3 out of the visible message text.';
  const secondText = 'keep the MP3 out of the visible message text.';

  await addAnnotation(window, firstText, 'Make this sentence clearer.', 'normal-annotation-editor', 'normal-context-action');
  await addAnnotation(window, secondText, 'Explain why this matters.');
  assert.equal(await evaluate(window, `document.querySelectorAll('.composer-annotation-chip').length`), 2);

  const chipLayout = await annotationChipLayout(window);
  assert.ok(chipLayout, 'Long annotation chip was not rendered');
  assert.ok(chipLayout.textScrollWidth > chipLayout.textClientWidth, 'Long annotation text did not exercise clipping');
  assert.equal(chipLayout.overflow, 'hidden');
  assert.equal(chipLayout.textOverflow, 'ellipsis');
  assert.deepEqual(chipLayout.escaping, []);

  await click(window, '.composer-annotation-chip:first-child .composer-annotation-main');
  assert.match(await evaluate(window, `document.querySelector('.composer-annotation-detail')?.textContent ?? ''`), /Make this sentence clearer/u);
  await clickInput(window, '.composer-annotation-detail');
  assert.ok(await evaluate(window, `Boolean(document.querySelector('.composer-annotation-detail'))`), 'Clicking inside composer annotation detail closed it');
  await clickInput(window, '.workspace textarea[aria-label="Message"]');
  await waitFor(window, `!document.querySelector('.composer-annotation-detail')`, 'Composer annotation detail did not dismiss outside');
  await click(window, '.composer-annotation-chip:first-child .composer-annotation-main');
  await pressEscape(window);
  await waitFor(window, `!document.querySelector('.composer-annotation-detail')`, 'Composer annotation detail did not dismiss with Escape');
  await click(window, '.composer-annotation-chip:first-child .composer-annotation-edit');
  await waitFor(window, `document.querySelector('.annotation-editor textarea')?.value === 'Make this sentence clearer.'`, 'Edit did not restore the annotation');
  await setTextarea(window, '.annotation-editor textarea', 'Explain this in plain English.');
  await click(window, '.annotation-editor-send');
  await waitFor(window, `!document.querySelector('.annotation-editor')`, 'Edited annotation did not save');

  await click(window, '.composer-annotation-chip:nth-child(2) .composer-annotation-remove');
  assert.equal(await evaluate(window, `document.querySelectorAll('.composer-annotation-chip').length`), 1);
  await capture(window, 'normal-composer-chip');

  await click(window, '.send-button');
  await waitFor(window, `document.querySelectorAll('.message-user .message-annotation').length === 1`, 'Annotation-only message did not render');
  const rawText = await evaluate(window, `document.querySelector('.conversation')?.textContent ?? ''`);
  assert.doesNotMatch(rawText, /Response annotations|response-annotations|My request/u);
  assert.equal(await evaluate(window, `[...document.querySelectorAll('.message-user')].at(-1)?.querySelector('.message-body')?.textContent ?? ''`), '');
  await capture(window, 'normal-sent-annotation');

  await click(window, '.message-user:last-of-type .message-annotation button');
  const detail = await evaluate(window, `document.querySelector('.message-user:last-of-type .message-annotation-detail')?.textContent ?? ''`);
  assert.match(detail, /input modalities include audio/u);
  assert.match(detail, /Explain this in plain English\./u);
  await clickInput(window, '.message-user:last-of-type .message-annotation-detail');
  assert.ok(await evaluate(window, `Boolean(document.querySelector('.message-user:last-of-type .message-annotation-detail'))`), 'Clicking inside sent annotation detail closed it');
  await clickInput(window, '.workspace-header');
  await waitFor(window, `!document.querySelector('.message-user:last-of-type .message-annotation-detail')`, 'Sent annotation detail did not dismiss outside');
  await click(window, '.message-user:last-of-type .message-annotation button');
  await pressEscape(window);
  await waitFor(window, `!document.querySelector('.message-user:last-of-type .message-annotation-detail')`, 'Sent annotation detail did not dismiss with Escape');
  await click(window, '.message-user:last-of-type .message-annotation button');
  await capture(window, 'normal-sent-annotation-open');

  await openTask(window, 'Fix authentication regression');
  await openTask(window, 'Listen to my recording');
  assert.equal(await evaluate(window, `document.querySelectorAll('.message-user .message-annotation').length`), 1);
  await window.close();
}

async function runCompactFlow() {
  const window = await createWindow(760, 480);
  const selected = 'The plan is to ship the direct-audio dictate option';
  await addAnnotation(window, selected, 'Keep this note compact.', 'compact-annotation-editor', 'compact-context-action');
  await setTextarea(window, '.workspace textarea[aria-label="Message"]', 'Also add a short example.');
  await capture(window, 'compact-composer-chip');

  const before = await layout(window);
  assert.deepEqual(before.clipped, []);
  await click(window, '.send-button');
  await waitFor(window, `[...document.querySelectorAll('.message-user')].at(-1)?.textContent?.includes('Also add a short example.')`, 'Annotation plus message did not render');
  const rawText = await evaluate(window, `document.querySelector('.conversation')?.textContent ?? ''`);
  assert.doesNotMatch(rawText, /Response annotations|response-annotations|My request/u);
  await capture(window, 'compact-sent-annotation');
  const after = await layout(window);
  assert.deepEqual(after.clipped, []);
  await writeFile(path.join(outputDirectory, 'layout.json'), JSON.stringify({ before, after }, null, 2));
  await window.close();
}

app.whenReady().then(async () => {
  await mkdir(outputDirectory, { recursive: true });
  try {
    await runNormalFlow();
    await runCompactFlow();
    console.log(`Annotation QA passed: ${outputDirectory}`);
  } finally {
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
