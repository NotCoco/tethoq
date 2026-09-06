'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const outputDirectory = path.resolve(process.argv[2] ?? path.join(appRoot, 'qa-artifacts', 'promo-media'));
const frameDirectory = path.join(outputDirectory, 'mesh-frames');
const width = 1920;
const height = 1080;
const fps = 30;
const frameDurationMs = 1000 / fps;
const capturePartition = `tethoq-promo-capture-${process.pid}`;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(window, expression, label, timeoutMs = 8_000) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      try {
        if (${expression}) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > ${timeoutMs}) return reject(new Error(${JSON.stringify(label)}));
      requestAnimationFrame(check);
    };
    check();
  })`, true);
}

async function settle(window) {
  await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
}

async function prepareWindow(hash) {
  const diagnostics = [];
  const window = new BrowserWindow({
    x: -10_000,
    y: -10_000,
    width,
    height,
    useContentSize: true,
    show: false,
    backgroundColor: '#070707',
    autoHideMenuBar: true,
    webPreferences: {
      partition: capturePartition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', (event) => {
    if (event.level >= 2) diagnostics.push(`${event.message ?? ''} (${event.sourceId ?? ''}:${event.lineNumber ?? 0})`);
  });
  window.webContents.on('render-process-gone', (_event, details) => diagnostics.push(`render-process-gone ${JSON.stringify(details)}`));
  await window.loadFile(rendererPath, { hash });
  try {
    await waitFor(window, "Boolean(document.querySelector('.desktop-app')) && !document.querySelector('.app-loading')", `${hash} renderer did not become ready`, 12_000);
    await window.webContents.executeJavaScript(`(() => {
      const style = document.createElement('style');
      style.dataset.promoCapture = 'true';
      style.textContent = '.preview-badge,.session-subagents-tooltip{display:none!important}';
      document.head.appendChild(style);
    })()`, true);
    await settle(window);
    await sleep(350);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostics.length ? `\n${diagnostics.join('\n')}` : ''}`);
  }
  return window;
}

async function openTask(window, sessionId = 'promo-atlas') {
  await waitFor(window, `Boolean(document.querySelector('[data-session-id="${sessionId}"] > .session-row'))`, `Task ${sessionId} did not appear`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-session-id="${sessionId}"] > .session-row')?.click()`, true);
  await waitFor(window, "Boolean(document.querySelector('.workspace'))", `Task ${sessionId} did not open`);
  await settle(window);
}

async function capturePng(window, filename) {
  window.webContents.invalidate();
  await settle(window);
  const image = await window.webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true });
  assert.equal(image.getSize().width, width, `${filename} width changed`);
  assert.equal(image.getSize().height, height, `${filename} height changed`);
  await writeFile(path.join(outputDirectory, filename), image.toPNG());
}

async function captureDashboard() {
  const window = await prepareWindow('promo-dashboard');
  try {
    await waitFor(window, "Boolean(document.querySelector('.dashboard-page'))", 'Promo dashboard did not appear');
    await capturePng(window, '01-dashboard.png');
  } finally {
    window.destroy();
  }
}

async function captureLiveWorkspace() {
  const window = await prepareWindow('promo-live');
  try {
    await openTask(window);
    await waitFor(window, "Boolean(document.querySelector('.reasoning-group, .reasoning-disclosure'))", 'Live reasoning state did not appear');
    await capturePng(window, '02-live-workspace.png');
  } finally {
    window.destroy();
  }
}

async function captureMeshJourney() {
  const window = await prepareWindow('promo-mesh');
  let frame = 0;
  const markers = {};
  const mark = (name) => { markers[name] = frame; };
  const captureFrame = async () => {
    window.webContents.invalidate();
    await sleep(frameDurationMs);
    const image = await window.webContents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true });
    await writeFile(path.join(frameDirectory, `frame-${String(frame).padStart(6, '0')}.png`), image.toPNG());
    frame += 1;
  };
  const hold = async (count) => {
    for (let index = 0; index < count; index += 1) await captureFrame();
  };
  const typeText = async (value) => {
    for (const character of value) {
      window.webContents.insertText(character);
      await captureFrame();
    }
  };
  const clickByText = async (containerSelector, text) => {
    const clicked = await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll(${JSON.stringify(containerSelector)} + ' button')].find((candidate) => candidate.textContent?.includes(${JSON.stringify(text)}));
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`, true);
    assert.equal(clicked, true, `Could not click ${text} in ${containerSelector}`);
    await settle(window);
  };

  try {
    await openTask(window);
    mark('workspace_ready');
    await hold(15);
    await window.webContents.executeJavaScript("document.querySelector('#composer-message')?.focus()", true);
    mark('mesh_typing');
    await typeText('/mesh');
    await waitFor(window, "Boolean(document.querySelector('.mesh-panel'))", 'Mesh panel did not open');
    mark('mesh_panel');
    await hold(18);
    await clickByText('.mesh-add', 'Grok Build');
    await waitFor(window, "Boolean(document.querySelector('.mesh-model-picker'))", 'Grok model picker did not open');
    mark('grok_picker');
    await hold(12);
    await clickByText('.mesh-model-picker-scroll', 'Grok 4.6');
    await clickByText('.mesh-model-picker-scroll', 'Extra high');
    await hold(10);
    const committed = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.mesh-model-picker footer .primary');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`, true);
    assert.equal(committed, true, 'Grok mesh target could not be committed');
    await waitFor(window, "Boolean(document.querySelector('.composer-inline-mesh'))", 'Inline Grok mesh target did not appear');
    mark('target_added');
    await hold(12);
    await window.webContents.executeJavaScript("document.querySelector('#composer-message')?.focus()", true);
    mark('prompt_typing');
    await typeText('Audit the dashboard and remove visual clutter.');
    mark('prompt_ready');
    await hold(8);
    const sent = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('button[aria-label="Send mesh delegation"]');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`, true);
    assert.equal(sent, true, 'Mesh delegation could not be sent');
    mark('sent');
    await hold(76);
    await waitFor(window, "Boolean(document.querySelector('.session-subagents-trigger'))", 'Grok child control did not appear');
    const childTriggerPoint = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.session-subagents-trigger');
      const bounds = button?.getBoundingClientRect();
      return bounds ? { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) } : null;
    })()`, true);
    assert.ok(childTriggerPoint, 'Grok child list trigger could not be located');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: childTriggerPoint.x, y: childTriggerPoint.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: childTriggerPoint.x, y: childTriggerPoint.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: childTriggerPoint.x, y: childTriggerPoint.y, button: 'left', clickCount: 1 });
    await waitFor(window, "Boolean(document.querySelector('.session-subagents-popover'))", 'Grok child list did not render');
    mark('child_picker');
    await hold(12);
    await clickByText('.session-subagents-popover', 'Grok interface review');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 900, y: 600 });
    await sleep(180);
    await waitFor(window, "document.body.textContent?.includes('The hierarchy is strong.') === true", 'Grok child result did not appear', 10_000);
    mark('child_result');
    await hold(45);
    await capturePng(window, '03-mesh-grok-result.png');
    await writeFile(path.join(outputDirectory, 'mesh-capture.json'), `${JSON.stringify({ fps, width, height, frames: frame, markers }, null, 2)}\n`);
  } finally {
    window.destroy();
  }
}

async function captureEyes() {
  const window = await prepareWindow('promo-eyes');
  try {
    await openTask(window);
    await waitFor(window, "document.body.textContent?.includes('EYES inspected the attached interface.') === true", 'EYES confirmation did not appear');
    await window.webContents.executeJavaScript("document.querySelector('.conversation-scroll')?.scrollTo({ top: document.querySelector('.conversation-scroll')?.scrollHeight ?? 0 })", true);
    await capturePng(window, '04-eyes-confirmed.png');
  } finally {
    window.destroy();
  }
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await mkdir(frameDirectory, { recursive: true });
    const captureSession = session.fromPartition(capturePartition);
    captureSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    await captureDashboard();
    await captureLiveWorkspace();
    await captureMeshJourney();
    await captureEyes();
    await writeFile(path.join(outputDirectory, 'capture-report.json'), `${JSON.stringify({
      renderer: 'built React renderer',
      privacy: 'promo-only fixtures; outbound HTTP(S) blocked',
      foregroundWindows: 0,
      computerUse: false,
      screenshots: ['01-dashboard.png', '02-live-workspace.png', '03-mesh-grok-result.png', '04-eyes-confirmed.png'],
      frameDirectory: 'mesh-frames',
    }, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ outputDirectory, screenshots: 4, frameDirectory }, null, 2)}\n`);
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  } finally {
    process.exitCode = exitCode;
    app.quit();
  }
});
