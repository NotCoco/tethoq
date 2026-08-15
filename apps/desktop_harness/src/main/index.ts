import { isAbsolute, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  session,
  Tray,
} from "electron";
import { desktopConfigPath, loadDesktopConfig } from "./config.js";
import { registerDesktopIpc } from "./ipc.js";
import { notifyForEvents } from "./notifications.js";
import { DesktopRuntime } from "./runtime.js";
import { BrowserWorkspaceManager, type BrowserWorkspaceNotice } from "./browser_workspace.js";
import { RecorderManager } from "./recorder/index.js";
import { DesktopPreferencesStore } from "./preferences.js";
import { LiveSessionManager } from "./live_session/manager.js";
import { hardenSession, hardenWindow, SECURE_WEB_PREFERENCES } from "./security.js";
import { readWindowState, trackWindowState } from "./window_state.js";
import { startDesktopReadiness, type DesktopReadinessHandle } from "./desktop_readiness.js";
import {
  IPC_CHANNELS,
  type BrowserNotice,
  type DesktopBootstrap,
  type DesktopRuntimeState,
} from "../shared/desktop_api.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let runtime: DesktopRuntime | undefined;
let browserWorkspace: BrowserWorkspaceManager | undefined;
let recorder: RecorderManager | undefined;
let preferences: DesktopPreferencesStore | undefined;
let liveSession: LiveSessionManager | undefined;
let cleanupIpc: (() => void) | undefined;
let flushWindowState: (() => Promise<void>) | undefined;
let desktopReadiness: DesktopReadinessHandle | undefined;
let quitting = false;
let shutdownPromise: Promise<void> | undefined;
let shutdownComplete = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(startApplication).catch((error: unknown) => {
    console.error("Tethoq desktop failed to start", error);
    app.exit(1);
  });
}

async function startApplication(): Promise<void> {
  app.setAppUserModelId("app.tethoq.desktop");
  Menu.setApplicationMenu(null);
  hardenSession(session.defaultSession);

  const configPath = desktopConfigPath(app);
  const config = await loadDesktopConfig(configPath);
  desktopReadiness = await startDesktopReadiness(join(app.getPath("userData"), "desktop-readiness.json"));
  mainWindow = await createMainWindow();
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
  desktopPreferences.onChange((value) => {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.preferencesState, value);
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
    providerAssetsDirectory: app.isPackaged
      ? join(process.resourcesPath, "provider-tools")
      : join(app.getAppPath(), "..", "agent_bridge", "assets"),
    browserWorkspace: browser,
    onEvents: (batch) => {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.eventBatch, batch);
        notifyForEvents(window, batch.events);
      }
    },
    onState: (state) => sendRuntimeState(window, state),
  });
  const harness = runtime;
  cleanupIpc = registerDesktopIpc({
    window,
    runtime: harness,
    allowedProviderIds: () => harness.allowedProviderIds(),
    browser,
    recorder: workflowRecorder,
    preferences: desktopPreferences,
    liveSession: instantSession,
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
      };
    },
  });
  createTray(window);
  await loadRenderer(window);
  void harness.start().catch((error: unknown) => {
    sendRuntimeState(window, { state: "failed", message: error instanceof Error ? error.message : String(error) });
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const statePath = join(app.getPath("userData"), "window-state.json");
  const saved = await readWindowState(statePath);
  const window = new BrowserWindow({
    title: "Tethoq",
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined ? { x: saved.x } : {}),
    ...(saved.y !== undefined ? { y: saved.y } : {}),
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#070707",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0d0d0c",
      symbolColor: "#c8cbc8",
      height: 47,
    },
    autoHideMenuBar: true,
    show: false,
    icon: appIconPath(),
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      backgroundThrottling: true,
      preload: join(__dirname, "../preload/index.cjs"),
    },
  });
  hardenWindow(window);
  flushWindowState = trackWindowState(window, statePath);
  if (saved.maximized) window.maximize();
  window.once("ready-to-show", () => {
    if (process.env.TETHOQ_PACKAGED_SMOKE === "1") {
      window.setSkipTaskbar(true);
      window.setIgnoreMouseEvents(true);
      window.setOpacity(0);
      window.showInactive();
    } else {
      window.show();
    }
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => { mainWindow = undefined; });
  window.on("show", () => {
    runtime?.setWindowVisible(true);
    void browserWorkspace?.setHostVisible(true).catch(() => undefined);
  });
  window.on("hide", () => {
    runtime?.setWindowVisible(false);
    void browserWorkspace?.setHostVisible(false).catch(() => undefined);
  });
  window.webContents.on("render-process-gone", () => {
    runtime?.setWindowVisible(false);
    void browserWorkspace?.setHostVisible(false).catch(() => undefined);
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
}

function createTray(window: BrowserWindow): void {
  const icon = nativeImage.createFromPath(appIconPath());
  tray = new Tray(icon.resize({ width: 18, height: 18 }));
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
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "assets", "tethoq-icon.png")
    : join(app.getAppPath(), "assets", "tethoq-icon.png");
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
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  shutdownPromise ??= shutdown().finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

async function shutdown(): Promise<void> {
  cleanupIpc?.();
  cleanupIpc = undefined;
  tray?.destroy();
  tray = undefined;
  await Promise.allSettled([
    recorder?.dispose(),
    liveSession?.dispose(),
    runtime?.dispose(),
    flushWindowState?.(),
    desktopReadiness?.dispose(),
  ]);
  browserWorkspace?.dispose();
  browserWorkspace = undefined;
  recorder = undefined;
  liveSession = undefined;
  preferences = undefined;
  desktopReadiness = undefined;
}

function browserNoticeMessage(notice: BrowserWorkspaceNotice): BrowserNotice {
  switch (notice.type) {
    case "blocked-navigation": return { tone: "error", message: "That browser navigation was blocked for safety." };
    case "blocked-popup": return { tone: "info", message: "A popup was blocked." };
    case "focus-address": return { tone: "info", message: "Address bar focused.", action: "focus-address", tabId: notice.tabId };
    case "permission-blocked": return { tone: "info", message: `${notice.permission} access was blocked.` };
    case "permission-expired": return { tone: "info", message: "The browser permission request expired." };
    case "download-started": return { tone: "info", message: "Download started." };
    case "download-finished": return { tone: notice.state === "completed" ? "info" : "error", message: notice.state === "completed" ? "Download finished." : `Download ${notice.state}.` };
  }
  return { tone: "info", message: "Browser state changed." };
}
