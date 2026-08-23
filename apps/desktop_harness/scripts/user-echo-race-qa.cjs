'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const artifactRoot = path.resolve(appRoot, '..', '..', 'local-artifacts', 'qa-user-echo-race');
const screenshotPath = path.join(artifactRoot, 'canonical-user-echo.png');
const reportPath = path.join(artifactRoot, 'report.json');
const canary = `TETHOQ_USER_ECHO_QA_${Date.now()}`;

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function waitFor(window, expression, message, timeoutMs = 5_000) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const value = (${expression});
      if (value) return resolve(value);
      if (Date.now() - started > ${timeoutMs}) return reject(new Error(${JSON.stringify(message)}));
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadFile(rendererPath, { hash: 'user-echo-race' });
    await waitFor(window, "document.querySelector('.desktop-app')", 'Desktop preview did not render');
    await waitFor(window, "!document.body.textContent.includes('Loading your coding tools')", 'Desktop preview did not finish loading');
    window.showInactive();
    await window.webContents.executeJavaScript(`(() => {
      const task = document.querySelector('[data-session-id="desktop-harness"] > .session-row');
      if (!(task instanceof HTMLElement)) throw new Error('User echo fixture task did not render');
      task.click();
    })()`, true);
    await waitFor(window, "document.querySelector('[data-session-id=\"desktop-harness\"] > .session-row')?.classList.contains('selected') === true", 'User echo fixture task was not selected');
    await waitFor(window, "document.querySelector('.conversation-empty') || document.querySelector('.empty-state')", 'User echo fixture transcript did not become ready');

    await window.webContents.executeJavaScript(`(() => {
      const state = { startedAt: performance.now(), frames: [], mutations: [] };
      const read = () => ({
        atMs: Number((performance.now() - state.startedAt).toFixed(1)),
        users: [...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length,
        assistants: [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length,
      });
      const observer = new MutationObserver(() => state.mutations.push(read()));
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      const sampleFrame = () => {
        state.frames.push(read());
        if (performance.now() - state.startedAt < 1_000) requestAnimationFrame(sampleFrame);
      };
      state.observer = observer;
      window.__tethoqUserEchoQa = state;
      requestAnimationFrame(sampleFrame);
      const input = document.querySelector('textarea[aria-label="Message"]');
      if (!(input instanceof HTMLTextAreaElement)) throw new Error('Composer did not render');
      input.focus();
    })()`, true);

    window.webContents.insertText(canary);
    await waitFor(window, `document.querySelector('textarea[aria-label="Message"]')?.value === ${JSON.stringify(canary)}`, 'Canary text did not reach the real composer');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    await waitFor(window, `(() => {
      const users = [...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length;
      return users === 1 && document.querySelector('textarea[aria-label="Message"]')?.value === '';
    })()`, 'Submitted message did not settle as one user row');
    await new Promise((resolve) => setTimeout(resolve, 1_050));

    const trace = await window.webContents.executeJavaScript(`(() => {
      const state = window.__tethoqUserEchoQa;
      state.observer.disconnect();
      const current = {
        users: [...document.querySelectorAll('.message-user .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length,
        assistants: [...document.querySelectorAll('.message-assistant .message-body')].filter((node) => node.textContent?.trim() === ${JSON.stringify(canary)}).length,
        composer: document.querySelector('textarea[aria-label="Message"]')?.value ?? null,
      };
      return { current, frames: state.frames, mutations: state.mutations };
    })()`, true);

    const firstVisibleFrame = trace.frames.findIndex((frame) => frame.users === 1);
    const firstVisibleMutation = trace.mutations.findIndex((sample) => sample.users === 1);
    assert.ok(firstVisibleFrame >= 0, 'The submitted user row was never visible on an animation frame.');
    assert.ok(firstVisibleMutation >= 0, 'The submitted user row was never observed during DOM mutation sampling.');
    assert.equal(trace.current.users, 1, 'The canonical echo did not settle as exactly one user row.');
    assert.equal(trace.current.assistants, 0, 'The submitted text settled with assistant identity.');
    assert.equal(trace.current.composer, '', 'The composer did not clear after Enter submission.');
    assert.equal(trace.frames.every((frame) => frame.users <= 1), true, 'A duplicate user row reached an animation frame.');
    assert.equal(trace.frames.every((frame) => frame.assistants === 0), true, 'The submitted text reached an animation frame with assistant identity.');
    assert.equal(trace.frames.slice(firstVisibleFrame).every((frame) => frame.users === 1), true, 'The user row disappeared on an animation frame after first appearing.');
    assert.equal(trace.mutations.every((sample) => sample.users <= 1), true, 'A DOM mutation exposed duplicate user rows.');
    assert.equal(trace.mutations.every((sample) => sample.assistants === 0), true, 'A DOM mutation exposed the submitted text with assistant identity.');
    assert.equal(trace.mutations.slice(firstVisibleMutation).every((sample) => sample.users === 1), true, 'The user row disappeared during canonical echo reconciliation.');

    await writeFile(screenshotPath, (await window.capturePage()).toPNG());
    const report = {
      inputPath: 'focused composer + insertText + Enter',
      providerEvent: 'message.completed / role=user',
      animationFramesSampled: trace.frames.length,
      domMutationsSampled: trace.mutations.length,
      finalUserOccurrences: trace.current.users,
      finalAssistantOccurrences: trace.current.assistants,
      duplicateUserFrameObserved: false,
      assistantIdentityFrameObserved: false,
      disappearanceFrameObserved: false,
      screenshotPath,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const debug = await window.webContents.executeJavaScript(`(() => ({
      composer: document.querySelector('textarea[aria-label="Message"]')?.value ?? null,
      userMessages: [...document.querySelectorAll('.message-user .message-body')].map((node) => node.textContent?.trim() ?? ''),
      assistantMessages: [...document.querySelectorAll('.message-assistant .message-body')].map((node) => node.textContent?.trim() ?? ''),
      queueMessages: [...document.querySelectorAll('.queued-message-content')].map((node) => node.textContent?.trim() ?? ''),
      selectedTask: document.querySelector('.session-row.selected')?.textContent?.trim() ?? null,
      sendDisabled: document.querySelector('.send-button')?.disabled ?? null,
      trace: window.__tethoqUserEchoQa ? { frames: window.__tethoqUserEchoQa.frames, mutations: window.__tethoqUserEchoQa.mutations } : null,
    }))()`, true).catch(() => null);
    process.stderr.write(`runtime debug: ${JSON.stringify(debug, null, 2)}\n`);
    throw error;
  } finally {
    window.destroy();
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
