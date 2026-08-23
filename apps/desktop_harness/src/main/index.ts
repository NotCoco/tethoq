import { isAbsolute, join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  Tray,
} from "electron";
import { desktopConfigPath, loadDesktopConfig } from "./config.js";
import { registerDesktopIpc } from "./ipc.js";
import { notifyForEvents } from "./notifications.js";
import { DesktopRuntime } from "./runtime.js";
import { BrowserWorkspaceManager, type BrowserWorkspaceNotice } from "./browser_workspace.js";
import { RecorderManager } from "./recorder/index.js";
import { DesktopPreferencesStore, readGlobalAgentInstructions } from "./preferences.js";
import { LiveSessionManager } from "./live_session/manager.js";
import { hardenSession, hardenWindow, SECURE_WEB_PREFERENCES } from "./security.js";
import { registerLocalMediaProtocol, registerLocalMediaScheme } from "./local_media.js";
import { clampWindowStateToDisplay, readWindowState, trackWindowState } from "./window_state.js";
import { startDesktopReadiness, type DesktopReadinessHandle } from "./desktop_readiness.js";
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
let cleanupIpc: (() => void) | undefined;
let flushWindowState: (() => Promise<void>) | undefined;
let desktopReadiness: DesktopReadinessHandle | undefined;
let quitting = false;
let shutdownPromise: Promise<void> | undefined;
let shutdownComplete = false;
let rendererRecoveryRequired = false;
let rendererRecoveryInFlight: Promise<void> | undefined;
let rendererCrashPromptOpen = false;

registerLocalMediaScheme();
app.setName("Tethoq");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// Windows DWM occlusion can mark a visible side-by-side window as hidden,
// which freezes paints until the next click. Live output must keep moving.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
// Packaged builds own app.tethoq.desktop. An unpackaged (dev) run must use a
// separate identity: Chromium auto-creates a Start Menu shortcut for unpackaged
// electron.exe runs, and a shortcut sharing the packaged AppUserModelID hijacks
// the real app's taskbar name and icon ("Electron").
if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? "app.tethoq.desktop" : "app.tethoq.desktop.dev");

export const HIDDEN_LAUNCH_ARGUMENT = "--hidden";
/**
 * A second launch carrying this argument asks the running instance to quit
 * cleanly. The ordinary quit path stops the managed OpenCode server, so
 * launchers that need a fresh app (scripts, updates) never orphan one.
 */
export const QUIT_INSTANCE_ARGUMENT = "--quit-other";
/** After Chromium says the window can paint, wait this long for the first populated snapshot. */
export const RENDERER_READY_REVEAL_MS = 4000;
/** If ready-to-show never arrives, still show a launched window so the process cannot sit invisible. */
export const STARTUP_REVEAL_FALLBACK_MS = 8000;

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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (argv.includes(QUIT_INSTANCE_ARGUMENT)) {
      quitting = true;
      app.quit();
      return;
    }
    if (!argv.includes(HIDDEN_LAUNCH_ARGUMENT)) showMainWindow();
  });
  app.whenReady().then(startApplication).catch((error: unknown) => {
    console.error("Tethoq desktop failed to start", error);
    dialog.showErrorBox("Tethoq could not start", "Tethoq could not open. Restart it and try again.");
    app.exit(1);
  });
}

async function startApplication(): Promise<void> {
  Menu.setApplicationMenu(null);
  registerLocalMediaProtocol(session.defaultSession);
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
  const remembered = await readWindowState(statePath);
  const display = screen.getDisplayMatching({
    x: remembered.x ?? 0,
    y: remembered.y ?? 0,
    width: remembered.width,
    height: remembered.height,
  });
  const saved = clampWindowStateToDisplay(remembered, display.workArea);
  const window = new BrowserWindow({
    title: "Tethoq",
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined ? { x: saved.x } : {}),
    ...(saved.y !== undefined ? { y: saved.y } : {}),
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#0b0b0a",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0b0b0a",
      symbolColor: "#c8cbc8",
      height: 46,
    },
    autoHideMenuBar: true,
    show: false,
    icon: appIconPath(),
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      // A visible unfocused window is still a live workspace. Chromium
      // background throttling delays IPC and timers until the next click.
      backgroundThrottling: false,
      preload: join(__dirname, "../preload/index.cjs"),
    },
  });
  hardenWindow(window);
  window.webContents.setBackgroundThrottling(false);
  flushWindowState = trackWindowState(window, statePath);
  if (saved.maximized) window.maximize();
  // First paint is not the same as being worth looking at: showing there put an empty
  // shell and its loading state on screen, and the unpainted frame behind the window
  // controls never matched the overlay drawn over it. Waiting for the renderer's first
  // snapshot means the window arrives already populated. The timer is a guarantee, not a
  // schedule - a renderer that never reports must still produce a usable window.
  let revealed = false;
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  let startupRevealTimer: ReturnType<typeof setTimeout> | undefined;
  const reveal = (): void => {
    if (revealed || window.isDestroyed()) return;
    revealed = true;
    if (revealTimer !== undefined) clearTimeout(revealTimer);
    if (startupRevealTimer !== undefined) clearTimeout(startupRevealTimer);
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
  const onRendererReady = (event: Electron.IpcMainEvent): void => {
    if (event.sender === window.webContents) reveal();
  };
  ipcMain.on(IPC_CHANNELS.rendererReady, onRendererReady);
  window.once("closed", () => { ipcMain.removeListener(IPC_CHANNELS.rendererReady, onRendererReady); });
  window.once("ready-to-show", () => {
    revealTimer = setTimeout(reveal, RENDERER_READY_REVEAL_MS);
  });
  startupRevealTimer = setTimeout(reveal, STARTUP_REVEAL_FALLBACK_MS);
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
        dialog.showErrorBox("Tethoq could not reload", "Close and reopen Tethoq, then try again.");
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
