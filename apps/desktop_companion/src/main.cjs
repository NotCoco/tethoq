'use strict';

const { existsSync } = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  screen,
  session,
} = require('electron');
const {
  SECURE_WEB_PREFERENCES,
  normalizePreviewState,
} = require('./security.cjs');
const {
  PairingProcessManager,
  resolveBridgeEntrypoint,
  resolveBridgeRuntime,
} = require('./pairing_process.cjs');
const {
  WINDOW_MODES,
  fitWindowBounds,
  normalizeWindowMode,
} = require('./window_lifecycle.cjs');

const assetsDirectory = path.join(__dirname, 'assets');
const canonicalIconPath = path.join(assetsDirectory, 'tethoq-icon.png');
const windowIconPath = canonicalIconPath;
const resolvedTrayIconPath = canonicalIconPath;
const startsInBackground = process.argv.includes('--background') || process.argv.includes('--tethoq-bridge');
const HIDDEN_RENDERER_RETENTION_MS = 30_000;
const bundledCloudflaredPath = path.join(process.resourcesPath, 'bridge', 'runtime', 'cloudflared.exe');

app.disableHardwareAcceleration();

let mainWindow;
let tray;
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise;
let hiddenRendererTimer;
let windowMode = 'summary';
let shouldShowWhenReady = !startsInBackground;
let rendererReady = false;
let previewState = normalizePreviewState(
  process.argv.find((argument) => argument.startsWith('--preview-state='))?.split('=')[1],
);

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

const pairing = new PairingProcessManager({
  executable: resolveBridgeRuntime({
    resourcesPath: process.resourcesPath,
    configuredPath: process.env.TETHOQ_BRIDGE_RUNTIME,
  }),
  entrypoint: resolveBridgeEntrypoint({
    resourcesPath: process.resourcesPath,
    configuredPath: process.env.TETHOQ_BRIDGE_ENTRYPOINT,
  }),
  cloudflaredPath: existsSync(bundledCloudflaredPath)
    ? bundledCloudflaredPath
    : process.env.TETHOQ_CLOUDFLARED_COMMAND ?? process.env.UAR_CLOUDFLARED_COMMAND,
  onProgress: (message) => sendToRenderer('tethoq:pairing-progress', message),
  onStateChange: (status) => sendToRenderer('tethoq:pairing-state', status),
});

function clearHiddenRendererTimer() {
  clearTimeout(hiddenRendererTimer);
  hiddenRendererTimer = undefined;
}

function displayForWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function applyWindowMode(mode) {
  windowMode = normalizeWindowMode(mode);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = fitWindowBounds(displayForWindow().workArea, windowMode);
  mainWindow.setBounds(bounds, false);
}

function scheduleHiddenRendererRelease() {
  clearHiddenRendererTimer();
  hiddenRendererTimer = setTimeout(() => {
    hiddenRendererTimer = undefined;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    mainWindow.destroy();
  }, HIDDEN_RENDERER_RETENTION_MS);
  hiddenRendererTimer.unref?.();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  mainWindow.setSkipTaskbar(true);
  scheduleHiddenRendererRelease();
}

function showMainWindow() {
  clearHiddenRendererTimer();
  shouldShowWhenReady = true;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindow || !rendererReady) return;
  applyWindowMode(windowMode);
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const preferred = WINDOW_MODES[windowMode];
  mainWindow = new BrowserWindow({
    title: 'Tethoq Bridge',
    width: preferred.width,
    height: preferred.height,
    minWidth: 340,
    minHeight: 194,
    maxWidth: 540,
    frame: false,
    transparent: true,
    thickFrame: false,
    roundedCorners: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    show: false,
    skipTaskbar: true,
    icon: windowIconPath,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      backgroundThrottling: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  rendererReady = false;

  applyWindowMode(windowMode);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => {
    rendererReady = true;
    if (shouldShowWhenReady) showMainWindow();
  });
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideMainWindow();
  });
  mainWindow.on('hide', scheduleHiddenRendererRelease);
  mainWindow.on('show', clearHiddenRendererTimer);
  mainWindow.on('closed', () => {
    clearHiddenRendererTimer();
    rendererReady = false;
    mainWindow = undefined;
  });
  void mainWindow.loadFile(path.join(__dirname, 'index.html'));
  return mainWindow;
}

function createTray() {
  tray = new Tray(resolvedTrayIconPath);
  tray.setToolTip('Tethoq Bridge — ready');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Tethoq Bridge', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Quit Tethoq Bridge',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showMainWindow);
}

function registerIpc() {
  ipcMain.handle('tethoq:get-preview-state', () => previewState);
  ipcMain.handle('tethoq:complete-preview', () => {
    previewState = 'connected';
    return previewState;
  });
  ipcMain.handle('tethoq:reset-preview', () => {
    previewState = 'first-run';
    return previewState;
  });
  ipcMain.handle('tethoq:get-app-meta', () => ({
    name: 'Tethoq Bridge',
    version: app.getVersion(),
    preview: true,
  }));
  ipcMain.handle('tethoq:get-pairing-status', () => pairing.status());
  ipcMain.handle('tethoq:start-pairing', async () => {
    try {
      const result = await pairing.start();
      return {
        state: 'ready',
        expiresAt: result.expiresAt,
        qrDataUrl: result.qrDataUrl,
      };
    } catch (error) {
      return {
        state: 'error',
        message: error instanceof Error ? error.message : 'Pairing could not be started.',
      };
    }
  });
  ipcMain.handle('tethoq:cancel-pairing', async () => {
    await pairing.cancel();
    return pairing.status();
  });
  ipcMain.handle('tethoq:abort-pairing-start', async () => pairing.abortStarting());
  ipcMain.handle('tethoq:set-window-mode', (_event, mode) => {
    applyWindowMode(mode);
    return windowMode;
  });
  ipcMain.handle('tethoq:window-minimize', () => mainWindow?.minimize());
  ipcMain.handle('tethoq:window-hide', hideMainWindow);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    registerIpc();
    createTray();
    if (!startsInBackground) createWindow();
    void pairing.startEngine().then(
      () => tray?.setToolTip('Tethoq Bridge — ready'),
      () => tray?.setToolTip('Tethoq Bridge — reconnecting'),
    );
  });

  app.on('activate', showMainWindow);
  app.on('before-quit', (event) => {
    isQuitting = true;
    clearHiddenRendererTimer();
    if (shutdownComplete) return;
    event.preventDefault();
    shutdownPromise ??= pairing.shutdown().finally(() => {
      shutdownComplete = true;
      tray?.destroy();
      app.quit();
    });
  });

  // Tray apps intentionally stay alive with no renderer window. The Bridge engine
  // is owned by the companion process and only stops through the explicit Quit action.
  app.on('window-all-closed', () => {});
}
