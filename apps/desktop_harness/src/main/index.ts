import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  powerMonitor,
  screen,
  session,
  Tray,
} from "electron";
import { desktopConfigPath, loadDesktopConfig } from "./config.js";
import { registerDesktopIpc } from "./ipc.js";
import { notifyForEvents } from "./notifications.js";
import { DesktopRuntime } from "./runtime.js";
import { BrowserWorkspaceManager, isAllowedWebUrl, type BrowserWorkspaceNotice } from "./browser_workspace.js";
import { contextMenuTemplate } from "./context_menu.js";
import { RecorderManager } from "./recorder/index.js";
import { DesktopPreferencesStore, readGlobalAgentInstructions } from "./preferences.js";
import { LiveSessionManager } from "./live_session/manager.js";
import { hardenSession, hardenWindow, SECURE_WEB_PREFERENCES } from "./security.js";
import { registerLocalMediaProtocol, registerLocalMediaScheme } from "./local_media.js";
import { clampWindowStateToDisplay, readWindowState, trackWindowState } from "./window_state.js";
import { startDesktopReadiness, type DesktopReadinessHandle } from "./desktop_readiness.js";
import { MobileConnectionManager } from "./mobile_connection.js";
import electronUpdater from "electron-updater";
import { DesktopUpdateManager } from "./updates.js";
import { recordStartupProfile } from "../../../agent_bridge/src/startup_profile.js";
import {
  IPC_CHANNELS,
  type BrowserNotice,
  type DesktopBootstrap,
  type DesktopLaunchAtLogin,
  type DesktopRuntimeState,
} from "../shared/desktop_api.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let runtime: DesktopRuntime | undefined;
let browserWorkspace: BrowserWorkspaceManager | undefined;
let recorder: RecorderManager | undefined;
let preferences: DesktopPreferencesStore | undefined;
let liveSession: LiveSessionManager | undefined;
let mobileConnection: MobileConnectionManager | undefined;
let updates: DesktopUpdateManager | undefined;
let cleanupIpc: (() => void) | undefined;
let flushWindowState: (() => Promise<void>) | undefined;
let desktopReadiness: DesktopReadinessHandle | undefined;
let quitting = false;
let preserveOpenCodeForRestart = false;
let forceStopManagedOpenCode = false;
let shutdownPromise: Promise<void> | undefined;
let shutdownComplete = false;
let rendererRecoveryRequired = false;
let rendererRecoveryInFlight: Promise<void> | undefined;
let rendererCrashPromptOpen = false;

registerLocalMediaScheme();
app.setName("Tethoq");
// Packaged builds own app.tethoq.desktop. An unpackaged (dev) run must use a
// separate identity: Chromium auto-creates a Start Menu shortcut for unpackaged
// electron.exe runs, and a shortcut sharing the packaged AppUserModelID hijacks
// the real app's taskbar name and icon ("Electron").
if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? "app.tethoq.desktop" : "app.tethoq.desktop.dev");

export const HIDDEN_LAUNCH_ARGUMENT = "--hidden";
/**
 * A second launch carrying this argument asks the running instance to hand off
 * cleanly. The desktop shell restarts while any managed OpenCode runner stays
 * alive long enough for the replacement generation to reconnect.
 */
export const QUIT_INSTANCE_ARGUMENT = "--quit-other";
/** Test/maintenance callers may request a full stop instead of a restart handoff. */
export const STOP_MANAGED_OPENCODE_ARGUMENT = "--stop-managed-opencode";
const WINDOW_SURFACE_COLOR = "#0b0b0a";
const STARTUP_VISUAL_TEST_DELAY_ENV = "TETHOQ_STARTUP_VISUAL_TEST_DELAY_MS";

/** Registration arguments for each startup choice. `tray` starts without a window. */
export function loginItemSettingsFor(value: DesktopLaunchAtLogin): { openAtLogin: boolean; args: string[] } {
  return { openAtLogin: value !== "off", args: value === "tray" ? [HIDDEN_LAUNCH_ARGUMENT] : [] };
}

function startedHidden(): boolean {
  return process.argv.includes(HIDDEN_LAUNCH_ARGUMENT);
}

function applyLoginItem(value: DesktopLaunchAtLogin): void {
  // Only a packaged build has a real executable to register. In development the
  // preference is still stored, but pointing the Run key at electron.exe would
  // launch a bare runtime at login.
  if (!app.isPackaged || (process.platform !== "win32" && process.platform !== "darwin")) return;
  try { app.setLoginItemSettings(loginItemSettingsFor(value)); }
  catch (error: unknown) { console.error("Tethoq could not update its startup setting", error); }
}

recordStartupProfile({ type: "desktop-startup", phase: "single-instance.begin" });
if (!app.requestSingleInstanceLock()) {
  recordStartupProfile({ type: "desktop-startup", phase: "single-instance.rejected" });
  app.quit();
} else {
  recordStartupProfile({ type: "desktop-startup", phase: "single-instance.acquired" });
  app.on("second-instance", (_event, argv) => {
    if (argv.includes(QUIT_INSTANCE_ARGUMENT)) {
      forceStopManagedOpenCode = argv.includes(STOP_MANAGED_OPENCODE_ARGUMENT);
      preserveOpenCodeForRestart = !forceStopManagedOpenCode;
      quitting = true;
      app.quit();
      return;
    }
    if (!argv.includes(HIDDEN_LAUNCH_ARGUMENT)) showMainWindow();
  });
  app.whenReady().then(() => {
    recordStartupProfile({ type: "desktop-startup", phase: "electron.ready" });
    return startApplication();
  }).catch((error: unknown) => {
    recordStartupProfile({
      type: "desktop-startup",
      phase: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    console.error("Tethoq desktop failed to start", error);
    dialog.showErrorBox("Tethoq could not start", "Tethoq could not open. Restart it and try again.");
    app.exit(1);
  });
}

async function startApplication(): Promise<void> {
  recordStartupProfile({ type: "desktop-startup", phase: "application.begin" });
  Menu.setApplicationMenu(null);
  registerLocalMediaProtocol(session.defaultSession);
  hardenSession(session.defaultSession);

  const configPath = desktopConfigPath(app);
  const config = await loadDesktopConfig(configPath);
  recordStartupProfile({ type: "desktop-startup", phase: "config.loaded" });
  desktopReadiness = await startDesktopReadiness(join(app.getPath("userData"), "desktop-readiness.json"));
  recordStartupProfile({ type: "desktop-startup", phase: "readiness.started" });
  mainWindow = await createMainWindow();
  recordStartupProfile({ type: "desktop-startup", phase: "window.created" });
  const window = mainWindow;
  const smokeBrowserUrl = packagedSmokeBrowserUrl();
  browserWorkspace = new BrowserWorkspaceManager({
    window,
    downloadsDirectory: app.getPath("downloads"),
    ...(smokeBrowserUrl === undefined ? {} : { initialUrl: smokeBrowserUrl }),
    onState: (state) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.browserState, state); },
    onNotice: (notice) => {
      if (window.isDestroyed()) return;
      if (notice.type === "focus-address") window.webContents.focus();
      window.webContents.send(IPC_CHANNELS.browserNotice, browserNoticeMessage(notice));
    },
  });
  const browser = browserWorkspace;
  // Browser state is available immediately, but Chromium itself is created
  // only when a coding session explicitly opens its browser surface. Packaged
  // smoke can still opt in by supplying its guarded browser URL.
  if (smokeBrowserUrl !== undefined) {
    await browser.initialize();
    await browser.createTab(undefined, true);
  }
  recorder = new RecorderManager({
    rootDirectory: workflowStoragePath(),
    onState: (state) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.recorderState, state); },
    onEvent: (event) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.recorderEvent, event); },
    contextProvider: () => {
      if (!window.isFocused() || !browser.initialized) return undefined;
      const state = browser.getState();
      if (!state.visible) return undefined;
      const tab = state.tabs.find((item) => item.id === state.activeTabId);
      return tab ? { appName: "Tethoq", windowTitle: window.getTitle(), browser: { tabId: tab.id, title: tab.title, url: tab.url } } : undefined;
    },
  });
  const workflowRecorder = recorder;
  preferences = await DesktopPreferencesStore.load(join(app.getPath("userData"), "preferences.json"));
  const desktopPreferences = preferences;
  applyLoginItem(desktopPreferences.value().launchAtLogin);
  desktopPreferences.onChange((value) => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.preferencesState, value);
    applyLoginItem(value.launchAtLogin);
    // Turning experimental features off stops any live instant session
    // immediately; the renderer tears its microphone stream down on state.
    if (!value.experimentalFeatures) void liveSession?.end("settings-disabled");
  });
  liveSession = new LiveSessionManager({
    isEnabled: () => desktopPreferences.value().experimentalFeatures,
    onState: (state) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.liveSessionState, state); },
    onEvent: (event) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.liveSessionEvent, event); },
    contextProvider: () => {
      if (!window.isFocused() || !browser.initialized) return undefined;
      const state = browser.getState();
      if (!state.visible) return undefined;
      const tab = state.tabs.find((item) => item.id === state.activeTabId);
      return tab ? { appName: "Tethoq", windowTitle: window.getTitle(), browser: { tabId: tab.id, title: tab.title, url: tab.url } } : undefined;
    },
  });
  const instantSession = liveSession;
  runtime = new DesktopRuntime({
    config,
    configPath,
    connectorsDirectory: join(app.getPath("userData"), "connectors"),
    connectorTrustStorePath: join(app.getPath("userData"), "connector-trust.json"),
    appVersion: app.getVersion(),
    defaultWorkingDirectory: app.getPath("documents"),
    providerAssetsDirectory: app.isPackaged
      ? join(process.resourcesPath, "provider-tools")
      : join(app.getAppPath(), "..", "agent_bridge", "assets"),
    browserWorkspace: browser,
    globalAgentInstructions: async () => await readGlobalAgentInstructions(desktopPreferences.value().globalAgentsPath).catch(() => undefined),
    onEvents: (batch) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.eventBatch, batch);
        notifyForEvents(window, batch.events, desktopPreferences.value().alerts);
      }
    },
    onState: (state) => sendRuntimeState(window, state),
  });
  const harness = runtime;
  updates = new DesktopUpdateManager({
    currentVersion: app.getVersion(),
    ...(app.isPackaged && process.platform === "win32" && existsSync(join(process.resourcesPath, "app-update.yml"))
      ? { updater: electronUpdater.autoUpdater } : {}),
    onState: (state) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.updateState, state); },
    beforeInstall: async () => {
      // The standalone companion is part of the installer too. Its mapped
      // executable cannot be replaced while it is serving another workspace.
      const companionPath = join(process.resourcesPath, "bridge-companion", "Tethoq Bridge.exe").replaceAll("'", "''");
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name='Tethoq Bridge.exe'\" | Where-Object { $_.ExecutablePath -ieq '${companionPath}' } | Select-Object -First 1 | ForEach-Object { 'running' }`,
      ], { windowsHide: true, timeout: 5_000 }).catch(() => { throw new Error("Tethoq could not check whether its standalone Bridge is running. Try again."); });
      if (stdout.trim() === "running") throw new Error("Quit the standalone Tethoq Bridge before restarting for an update.");
      if ([...harness.allowedProviderIds()].some((providerId) => harness.bridge.providerActiveSessions(providerId).length > 0)
        || harness.bridge.sessions().some((task) => ["working", "needs_approval", "needs_input"].includes(task.state))) {
        throw new Error("Finish or stop running tasks before restarting for an update.");
      }
      if (workflowRecorder.state().phase === "recording") throw new Error("Stop the recording before restarting for an update.");
      // quitAndInstall uses the normal before-quit drain below. Preserve the
      // managed provider so the next app generation can adopt it.
      preserveOpenCodeForRestart = true;
    },
  });
  powerMonitor.on("resume", () => {
    void harness.reconcileScheduledTasks().catch((error: unknown) => {
      console.error("Tethoq could not reconcile scheduled tasks after resume", error);
    });
  });
  const cloudflaredCommand = mobileCloudflaredCommand();
  mobileConnection = new MobileConnectionManager({
    runtime: harness,
    ...(cloudflaredCommand !== undefined ? { cloudflaredCommand } : {}),
    onState: (state) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.mobileConnectionState, state); },
  });
  const phoneConnection = mobileConnection;
  cleanupIpc = registerDesktopIpc({
    window,
    runtime: harness,
    allowedProviderIds: () => harness.allowedProviderIds(),
    updates,
    browser,
    recorder: workflowRecorder,
    preferences: desktopPreferences,
    liveSession: instantSession,
    mobileConnection: phoneConnection,
    bootstrap: async (): Promise<DesktopBootstrap> => {
      await harness.start();
      return {
        app: { name: app.getName(), version: app.getVersion(), platform: process.platform, packaged: app.isPackaged },
        host: harness.bridge.host(),
        providers: await harness.bridge.providerConnections(),
        allowedProviders: [...harness.allowedProviderIds()],
        connectors: harness.connectorState,
        latestSequence: harness.bridge.latestSequence(),
        openCode: harness.openCode.status(),
        providerSetupIssues: harness.providerSetupIssues,
      };
    },
  });
  createTray(window);
  recordStartupProfile({ type: "desktop-startup", phase: "tray.created" });
  try {
    await loadRenderer(window);
    recordStartupProfile({ type: "desktop-startup", phase: "renderer.loaded" });
  } catch (error: unknown) {
    console.error("Tethoq renderer could not load", error);
    await loadStartupSurface(window, "failed");
    return;
  }
  void harness.start().catch((error: unknown) => {
    sendRuntimeState(window, { state: "failed", message: error instanceof Error ? error.message : String(error) });
  });
  updates.start();
}

async function createMainWindow(): Promise<BrowserWindow> {
  recordStartupProfile({ type: "desktop-startup", phase: "window-state.begin" });
  const statePath = join(app.getPath("userData"), "window-state.json");
  const remembered = await readWindowState(statePath);
  recordStartupProfile({ type: "desktop-startup", phase: "window-state.loaded" });
  const display = screen.getDisplayMatching({
    x: remembered.x ?? 0,
    y: remembered.y ?? 0,
    width: remembered.width,
    height: remembered.height,
  });
  const saved = clampWindowStateToDisplay(remembered, display.workArea);
  recordStartupProfile({ type: "desktop-startup", phase: "window.construct.begin" });
  const window = new BrowserWindow({
    title: "Tethoq",
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined ? { x: saved.x } : {}),
    ...(saved.y !== undefined ? { y: saved.y } : {}),
    minWidth: 760,
    minHeight: 480,
    backgroundColor: WINDOW_SURFACE_COLOR,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: WINDOW_SURFACE_COLOR,
      symbolColor: "#c8cbc8",
      height: 46,
    },
    autoHideMenuBar: true,
    show: false,
    icon: appIconPath(),
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      // Provider events and notifications stay main-process owned while this
      // pauses hidden or occluded renderer timers and paints. Visibility wake
      // replays sync.since before the user can depend on the transcript again.
      backgroundThrottling: true,
      preload: join(__dirname, "../preload/index.cjs"),
    },
  });
  recordStartupProfile({ type: "desktop-startup", phase: "window.construct.end" });
  hardenWindow(window);
  // Cut, copy, paste, and spelling corrections. Chromium suppresses this event
  // entirely when the page cancels its own contextmenu, so the app's object
  // menus - annotate a response, task actions, open a path in - keep their
  // right-click and never compete with this one.
  window.webContents.on("context-menu", (_event, params) => {
    const template = contextMenuTemplate(params, {
      replaceMisspelling: (word) => window.webContents.replaceMisspelling(word),
      learnSpelling: (word) => window.webContents.session.addWordToSpellCheckerDictionary(word),
      copyText: (text) => clipboard.writeText(text),
      copyImage: (x, y) => window.webContents.copyImageAt(x, y),
      allowWebUrl: isAllowedWebUrl,
    });
    if (template.length === 0 || window.isDestroyed()) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
  window.webContents.setBackgroundThrottling(true);
  flushWindowState = trackWindowState(window, statePath);
  if (saved.maximized) window.maximize();
  // The first visible frame is app-owned. Loading this tiny local document before any
  // provider/runtime setup means a slow start can show a truthful loading surface, but
  // can never expose Chromium's empty initial document beneath the native caption area.
  let revealed = false;
  const reveal = (): void => {
    if (revealed || window.isDestroyed()) return;
    revealed = true;
    if (process.env.TETHOQ_PACKAGED_SMOKE === "1") {
      window.setSkipTaskbar(true);
      window.setIgnoreMouseEvents(true);
      window.setOpacity(0);
      window.showInactive();
    } else if (!startedHidden()) {
      window.show();
      window.focus();
    }
  };
  recordStartupProfile({ type: "desktop-startup", phase: "startup-surface.begin" });
  await loadStartupSurface(window);
  recordStartupProfile({ type: "desktop-startup", phase: "startup-surface.loaded" });
  reveal();
  await delayStartupForVisualTest();
  window.on("close", (event) => {
    if (quitting) return;
    // Closing keeps Tethoq in the tray by default so running tasks and their
    // approval alerts survive a stray close. The user can choose to quit instead,
    // which routes through the ordinary quit path so window state and provider
    // processes are flushed while the window is still alive.
    event.preventDefault();
    if (preferences?.value().closeAction === "quit") {
      quitting = true;
      app.quit();
      return;
    }
    window.hide();
  });
  window.on("closed", () => {
    mainWindow = undefined;
    rendererRecoveryRequired = false;
  });
  window.on("show", () => {
    runtime?.setWindowVisible(true);
    void browserWorkspace?.setHostVisible(true).catch(() => undefined);
  });
  window.on("hide", () => {
    runtime?.setWindowVisible(false);
    void browserWorkspace?.setHostVisible(false).catch(() => undefined);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    runtime?.setWindowVisible(false);
    void browserWorkspace?.setHostVisible(false).catch(() => undefined);
    if (quitting || details.reason === "clean-exit") return;
    console.error(`Tethoq renderer stopped (${details.reason}, exit ${details.exitCode})`);
    rendererRecoveryRequired = true;
    void promptForRendererRecovery(window);
  });
  window.webContents.on("did-finish-load", () => {
    if (window.isVisible()) {
      runtime?.setWindowVisible(true);
      void browserWorkspace?.setHostVisible(true).catch(() => undefined);
    }
  });
  return window;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined) await window.loadURL(devServerUrl);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
  // The temporary startup skeleton is not a user navigation destination. Remove
  // it from the shell's history so mouse Back/Forward (including Alt mappings)
  // cannot replace the live app with that earlier full-window surface.
  window.webContents.navigationHistory.clear();
}

async function loadStartupSurface(window: BrowserWindow, state: "loading" | "failed" = "loading"): Promise<void> {
  const failed = state === "failed";
  const document = failed ? `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Tethoq</title><style>
:root,html,body{width:100%;height:100%;margin:0;background:${WINDOW_SURFACE_COLOR};color:#f0f2f0;color-scheme:dark}
body{display:grid;place-items:center;overflow:hidden;font-family:Inter,"Segoe UI",system-ui,sans-serif;-webkit-app-region:drag}
.startup{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
.startup-mark{width:28px;height:28px;margin-bottom:8px;display:grid;place-items:center;border:1px solid #55413f;border-radius:50%;color:#d8b0ac;font-weight:700}
strong{font-size:15px;line-height:1.3;font-weight:620}small{color:#969b96;font-size:12.5px;line-height:1.45}
</style></head><body><main class="startup" role="alert"><span class="startup-mark" aria-hidden="true">!</span><strong>Tethoq could not open this view</strong><small>Close and reopen Tethoq to try again.</small></main></body></html>` : `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="color-scheme" content="dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Tethoq</title><style>
:root,html,body{width:100%;height:100%;margin:0;background:${WINDOW_SURFACE_COLOR};color-scheme:dark}
body{overflow:hidden;font-family:Inter,"Segoe UI",system-ui,sans-serif}
.shell{width:100%;height:100%;display:grid;grid-template-rows:46px 1fr;background:${WINDOW_SURFACE_COLOR}}
.title{border-bottom:1px solid #252523;-webkit-app-region:drag}
.body{min-height:0;display:grid;grid-template-columns:248px 1fr}
.rail{min-height:0;display:grid;grid-template-rows:54px 1fr;border-right:1px solid #252523;background:#111110}
.rail-head{border-bottom:1px solid #252523}
.rows{padding:7px 6px}.row{height:88px;display:grid;grid-template-columns:36px 1fr;align-items:center;gap:10px;padding:8px 10px}.row>i,.workspace-head>i{width:36px;height:36px;border-radius:50%}
.lines{display:grid;gap:8px}.lines i{height:9px;border-radius:5px}.lines i:nth-child(1){width:58%}.lines i:nth-child(2){width:88%}.lines i:nth-child(3){width:42%}
.workspace{min-width:0;min-height:0;display:grid;grid-template-rows:64px 1fr auto;background:#0f0f0e}.workspace-head{display:grid;grid-template-columns:36px 220px;align-items:center;gap:10px;padding:0 20px;border-bottom:1px solid #252523}.workspace-head .lines i:first-child{height:12px;width:72%}
.messages{width:min(780px,calc(100% - 38px));margin:0 auto;padding:42px 0;display:grid;align-content:start;gap:26px}.message{width:72%;display:grid;grid-template-columns:27px 1fr;gap:10px}.message>i{width:27px;height:27px;border-radius:50%}.message.user{width:55%;grid-template-columns:1fr;justify-self:end;padding:14px 16px;border-radius:14px 14px 4px 14px;background:#1b1b19}.message.short{width:48%}
.composer{width:min(780px,calc(100% - 38px));height:82px;margin:0 auto 14px;border:1px solid #343431;border-radius:13px;background:#161615;box-shadow:0 12px 30px #0004}.composer:after{content:"";display:block;width:calc(100% - 30px);height:12px;margin:34px 15px 0;border-radius:7px;background:#242421}
.row>i,.row .lines i,.workspace-head>i,.workspace-head .lines i,.message>i,.message .lines i{background:#242421;background-image:linear-gradient(100deg,#22221f 12%,#2c2c28 46%,#22221f 80%);background-size:220% 100%;animation:sheen 1.8s ease-in-out infinite}
@keyframes sheen{0%,100%{background-position:100% 0;opacity:.72}50%{background-position:0 0;opacity:1}}@media(prefers-reduced-motion:reduce){.row>i,.row .lines i,.workspace-head>i,.workspace-head .lines i,.message>i,.message .lines i{animation:none}}
</style></head><body><main class="shell" role="status" aria-label="Tethoq is starting"><div class="title"></div><div class="body"><aside class="rail"><div class="rail-head"></div><div class="rows">${Array.from({ length: 5 }, () => '<div class="row"><i></i><span class="lines"><i></i><i></i><i></i></span></div>').join("")}</div></aside><section class="workspace"><header class="workspace-head"><i></i><span class="lines"><i></i><i></i></span></header><div class="messages"><div class="message"><i></i><span class="lines"><i></i><i></i><i></i></span></div><div class="message user"><span class="lines"><i></i><i></i></span></div><div class="message short"><i></i><span class="lines"><i></i><i></i></span></div></div><div class="composer"></div></section></div></main></body></html>`;
  await window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(document)}`);
}

async function delayStartupForVisualTest(): Promise<void> {
  if (app.isPackaged) return;
  const requested = process.env[STARTUP_VISUAL_TEST_DELAY_ENV];
  if (requested === undefined) return;
  const delayMs = Number(requested);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30_000) return;
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

function createTray(window: BrowserWindow): void {
  tray = new Tray(trayIconPath());
  tray.setToolTip("Tethoq");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Tethoq", click: () => showMainWindow() },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => {
    if (window.isVisible()) window.hide();
    else showMainWindow();
  });
  tray.on("double-click", () => showMainWindow());
}

function showMainWindow(): void {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return;
  if (rendererRecoveryRequired) {
    void recoverMainWindowRenderer(window);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function promptForRendererRecovery(window: BrowserWindow): Promise<void> {
  if (rendererCrashPromptOpen || quitting || window.isDestroyed()) return;
  rendererCrashPromptOpen = true;
  try {
    const result = await dialog.showMessageBox(window, {
      type: "error",
      title: "Reload Tethoq",
      message: "The Tethoq window stopped unexpectedly.",
      detail: "Reload the window to continue.",
      buttons: ["Reload window", "Close window"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) await recoverMainWindowRenderer(window);
    else if (!window.isDestroyed()) window.hide();
  } catch (error: unknown) {
    console.error("Tethoq could not show renderer recovery", error);
  } finally {
    rendererCrashPromptOpen = false;
  }
}

async function recoverMainWindowRenderer(window: BrowserWindow): Promise<void> {
  if (rendererRecoveryInFlight !== undefined) return rendererRecoveryInFlight;
  rendererRecoveryInFlight = (async () => {
    try {
      await loadRenderer(window);
      rendererRecoveryRequired = false;
      if (window.isDestroyed() || quitting) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    } catch (error: unknown) {
      console.error("Tethoq renderer could not reload", error);
      if (!window.isDestroyed() && !quitting) {
        await loadStartupSurface(window, "failed").catch((surfaceError: unknown) => {
          console.error("Tethoq could not display renderer recovery", surfaceError);
          dialog.showErrorBox("Tethoq could not reload", "Close and reopen Tethoq, then try again.");
        });
      }
    }
  })();
  try {
    await rendererRecoveryInFlight;
  } finally {
    rendererRecoveryInFlight = undefined;
  }
}

function appIconPath(): string {
  if (process.platform === "win32") {
    return app.isPackaged
      ? join(process.resourcesPath, "assets", "tethoq-icon.ico")
      : join(app.getAppPath(), "assets", "tethoq-icon.ico");
  }
  return app.isPackaged
    ? join(process.resourcesPath, "assets", "tethoq-icon.png")
    : join(app.getAppPath(), "assets", "tethoq-icon.png");
}

function trayIconPath(): string {
  if (process.platform === "win32") {
    return app.isPackaged
      ? join(process.resourcesPath, "assets", "tethoq-tray.ico")
      : join(app.getAppPath(), "assets", "tethoq-tray.ico");
  }
  return appIconPath();
}

function packagedSmokeBrowserUrl(): string | undefined {
  if (process.env.TETHOQ_PACKAGED_SMOKE !== "1") return undefined;
  return process.env.TETHOQ_PACKAGED_SMOKE_BROWSER_URL;
}

function workflowStoragePath(): string {
  const defaultPath = join(app.getPath("documents"), "Tethoq", "Workflows");
  if (process.env.TETHOQ_PACKAGED_SMOKE !== "1") return defaultPath;
  const override = process.env.TETHOQ_PACKAGED_SMOKE_WORKFLOW_ROOT;
  if (override === undefined) return defaultPath;
  if (!isAbsolute(override) || override.includes("\0")) throw new Error("The packaged smoke workflow path must be absolute");
  return resolve(override);
}

function sendRuntimeState(window: BrowserWindow, state: DesktopRuntimeState): void {
  if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.runtimeState, state);
}

app.on("activate", () => showMainWindow());
app.on("window-all-closed", () => {
  // Tethoq remains in the tray on Windows/macOS so active harness sessions and
  // approval notifications are not lost when the window is hidden.
});
app.on("before-quit", (event) => {
  recordStartupProfile({ type: "desktop-startup", phase: "before-quit", shutdownComplete });
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  shutdownPromise ??= shutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});
app.on("will-quit", () => {
  updates?.dispose();
  recordStartupProfile({ type: "desktop-startup", phase: "will-quit" });
});
app.on("quit", (_event, exitCode) => recordStartupProfile({ type: "desktop-startup", phase: "quit", exitCode }));

async function shutdown(): Promise<void> {
  cleanupIpc?.();
  cleanupIpc = undefined;
  tray?.destroy();
  tray = undefined;
  await mobileConnection?.dispose();
  await Promise.allSettled([
    recorder?.dispose(),
    liveSession?.dispose(),
    runtime?.dispose({
      preserveOpenCode: preserveOpenCodeForRestart,
      forceStopOpenCode: forceStopManagedOpenCode,
    }),
    flushWindowState?.(),
    desktopReadiness?.dispose(),
  ]);
  browserWorkspace?.dispose();
  browserWorkspace = undefined;
  recorder = undefined;
  liveSession = undefined;
  mobileConnection = undefined;
  preferences = undefined;
  desktopReadiness = undefined;
}

function mobileCloudflaredCommand(): string | undefined {
  const configured = process.env.TETHOQ_CLOUDFLARED_COMMAND ?? process.env.UAR_CLOUDFLARED_COMMAND;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "bridge-companion", "resources", "bridge", "runtime", "cloudflared.exe")]
    : [
        join(app.getAppPath(), "build", "bridge-companion", "resources", "bridge", "runtime", "cloudflared.exe"),
        join(app.getAppPath(), "..", "desktop_companion", "build", "bridge-runtime", "runtime", "cloudflared.exe"),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

function browserNoticeMessage(notice: BrowserWorkspaceNotice): BrowserNotice {
  switch (notice.type) {
    case "blocked-navigation": return { tone: "error", message: "That browser navigation was blocked for safety." };
    case "blocked-popup": return { tone: "info", message: "A popup was blocked." };
    case "tab-limit": return { tone: "info", message: "Close a browser tab before opening another." };
    case "focus-address": return { tone: "info", message: "Address bar focused.", action: "focus-address", tabId: notice.tabId };
    case "permission-blocked": return { tone: "info", message: `${notice.permission} access was blocked.` };
    case "permission-expired": return { tone: "info", message: "The browser permission request expired." };
    case "download-started": return { tone: "info", message: "Download started." };
    case "download-finished": return { tone: notice.state === "completed" ? "info" : "error", message: notice.state === "completed" ? "Download finished." : `Download ${notice.state}.` };
  }
  return { tone: "info", message: "Browser state changed." };
}
