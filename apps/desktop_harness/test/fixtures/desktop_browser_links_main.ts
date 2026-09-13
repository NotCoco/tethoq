import { app, BrowserWindow, ipcMain, shell, webContents } from "electron";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { BrowserWorkspaceManager } from "../../src/main/browser_workspace";
import { DesktopPreferencesStore } from "../../src/main/preferences";
import { registerDesktopIpc } from "../../src/main/ipc";
import { IPC_CHANNELS } from "../../src/shared/desktop_api";

app.commandLine.appendSwitch("disable-gpu");
app.setPath("userData", join(__dirname, "profile"));
const external: string[] = [];
shell.openExternal = async url => { external.push(url); };
app.whenReady().then(async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Browser QA</title><h1>Local browser test page</h1>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const preferencePath = join(__dirname, "preferences.json");
  await writeFile(preferencePath, JSON.stringify({ version: 1, alerts: "attention" }));
  const preferences = await DesktopPreferencesStore.load(preferencePath);
  assert.equal(preferences.value().openLinksInApp, false, "existing installs must default to external links");
  const window = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: {
    preload: join(__dirname, "preload.cjs"), offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true,
  } });
  const browser = new BrowserWorkspaceManager({ window, initialUrl: url + "/home", downloadsDirectory: __dirname,
    onState: state => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.browserState, state); },
    onNotice: notice => { if (notice.type === "closed") window.webContents.send(IPC_CHANNELS.browserNotice, { action: "return-to-task", message: "Browser closed", tone: "info" }); },
  });
  await browser.setHostVisible(true);
  await browser.initialize();
  assert.equal(browser.getState().tabs.length, 0, "startup must stay tab-free");
  // Restore an older task snapshot, close its last tab, and prove it cannot
  // resurrect that closed page on the next explicit browser open.
  await browser.setVisibleForSession(true, "a");
  await browser.navigate(browser.getState().activeTabId!, url + "/old-page");
  await browser.setVisibleForSession(true, "b");
  await browser.setVisibleForSession(true, "a");
  await browser.closeTab(browser.getState().activeTabId!);
  assert.equal(browser.getState().visible, false);
  assert.equal(browser.getState().tabs.length, 0);
  await browser.setVisibleForSession(true, "a");
  assert.equal(browser.getState().tabs[0]!.url, url + "/home");
  await browser.closeTab(browser.getState().activeTabId!);

  const unregister = registerDesktopIpc({ window, runtime: {} as never, bootstrap: async () => ({} as never), allowedProviderIds: () => new Set(), preferences, browser, mobileConnection: {} as never });
  const unsubscribe = preferences.onChange(value => window.webContents.send(IPC_CHANNELS.preferencesState, value));
  ipcMain.handle("qa:inspect", async () => ({ url, external, browser: browser.getState(), persisted: (await DesktopPreferencesStore.load(preferencePath)).value() }));
  ipcMain.handle("qa:keyboard", () => {
    const target = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(url));
    assert.ok(target, "native browser page must exist for keyboard closure");
    target.sendInputEvent({ type: "keyDown", keyCode: "W", modifiers: ["control"] });
    target.sendInputEvent({ type: "keyUp", keyCode: "W", modifiers: ["control"] });
  });
  ipcMain.handle("qa:capture", async (_event, name: string) => {
    const directory = process.env.TETHOQ_BROWSER_QA_OUTPUT;
    if (!directory) return;
    assert.match(name, /^[a-z-]+$/);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name + ".png"), (await window.capturePage()).toPNG());
  });
  await window.loadFile(join(__dirname, "index.html"));
  const rejected = await window.webContents.executeJavaScript(`Promise.all(["javascript:alert(1)", "file:///C:/test.txt", "data:text/html,hello"].map(url => window.qaBrowser.openExternalUrl(url).then(() => false, () => true)))`);
  assert.deepEqual(rejected, [true, true, true]);
  const result = await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const end=performance.now()+30000;const check=()=>{if(window.__browserLinksResult)return resolve(window.__browserLinksResult);if(performance.now()>end)return reject(new Error("Browser interaction timed out"));setTimeout(check,10);};check();})');
  console.log("BROWSER_LINKS_QA=" + JSON.stringify(result));
  unsubscribe(); unregister(); await browser.dispose(); window.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
