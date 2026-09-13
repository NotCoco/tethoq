'use strict';

/**
 * Test-only preload for the fake model QA driver.
 *
 * It exposes the exact same `window.tethoqDesktop` contract as the production
 * preload (src/preload/index.ts) so the ordinary renderer follows its normal
 * non-preview request/event path. The only difference is who answers: the
 * Electron QA driver process registers the same IPC channel names, backed by
 * scripts/fake-model/fake-model-host.cjs.
 *
 * Channel names below mirror IPC_CHANNELS in src/shared/desktop_api.ts; the
 * focused test suite asserts they stay in sync. Never import this file from
 * anything under src/.
 */

const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = {
  bootstrap: 'tethoq:bootstrap',
  request: 'tethoq:request',
  selectDirectory: 'tethoq:select-directory',
  selectImages: 'tethoq:select-images',
  selectFiles: 'tethoq:select-files',
  captureScreens: 'tethoq:capture-screens',
  revealPath: 'tethoq:reveal-path',
  copyText: 'tethoq:copy-text',
  localOpenHandlers: 'tethoq:local-open-handlers',
  openLocalTarget: 'tethoq:open-local-target',
  openExternalUrl: 'tethoq:open-external-url',
  openDictationSetupPage: 'tethoq:open-dictation-setup-page',
  openHarnessSetupPage: 'tethoq:open-harness-setup-page',
  showWindow: 'tethoq:show-window',
  hideWindow: 'tethoq:hide-window',
  rendererReady: 'tethoq:renderer-ready',
  openCodeStatus: 'tethoq:opencode-status',
  restartOpenCode: 'tethoq:restart-opencode',
  updateGetState: 'tethoq:update-get-state',
  updateAction: 'tethoq:update-action',
  updateState: 'tethoq:update-state',
  connectorAction: 'tethoq:connector-action',
  eventBatch: 'tethoq:event-batch',
  runtimeState: 'tethoq:runtime-state',
  browserState: 'tethoq:browser-state',
  browserNotice: 'tethoq:browser-notice',
  browserGetState: 'tethoq:browser-get-state',
  browserAction: 'tethoq:browser-action',
  recorderState: 'tethoq:recorder-state',
  recorderEvent: 'tethoq:recorder-event',
  recorderGetState: 'tethoq:recorder-get-state',
  recorderAction: 'tethoq:recorder-action',
  preferencesState: 'tethoq:preferences-state',
  preferencesGet: 'tethoq:preferences-get',
  preferencesAction: 'tethoq:preferences-action',
  liveSessionState: 'tethoq:live-session-state',
  liveSessionEvent: 'tethoq:live-session-event',
  liveSessionGetState: 'tethoq:live-session-get-state',
  liveSessionAction: 'tethoq:live-session-action',
  mobileConnectionState: 'tethoq:mobile-connection-state',
  mobileConnectionGetState: 'tethoq:mobile-connection-get-state',
  mobileConnectionAction: 'tethoq:mobile-connection-action',
};

function subscribe(channel, listener) {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = Object.freeze({
  bootstrap: () => ipcRenderer.invoke(CHANNELS.bootstrap),
  request: (type, payload = {}, requestId) => ipcRenderer.invoke(CHANNELS.request, { type, payload, requestId }),
  selectDirectory: (defaultPath) => ipcRenderer.invoke(CHANNELS.selectDirectory, { defaultPath }),
  selectImages: () => ipcRenderer.invoke(CHANNELS.selectImages),
  selectFiles: (providerId) => ipcRenderer.invoke(CHANNELS.selectFiles, { providerId }),
  captureScreens: () => ipcRenderer.invoke(CHANNELS.captureScreens),
  revealPath: (path) => ipcRenderer.invoke(CHANNELS.revealPath, { path }),
  copyText: (text) => ipcRenderer.invoke(CHANNELS.copyText, { text }),
  localOpenHandlers: () => ipcRenderer.invoke(CHANNELS.localOpenHandlers),
  openLocalTarget: (target) => ipcRenderer.invoke(CHANNELS.openLocalTarget, target),
  openExternalUrl: (url) => ipcRenderer.invoke(CHANNELS.openExternalUrl, url),
  openDictationSetupPage: (sourceId) => ipcRenderer.invoke(CHANNELS.openDictationSetupPage, { sourceId }),
  openHarnessSetupPage: (providerId) => ipcRenderer.invoke(CHANNELS.openHarnessSetupPage, { providerId }),
  showWindow: () => ipcRenderer.invoke(CHANNELS.showWindow),
  hideWindow: () => ipcRenderer.invoke(CHANNELS.hideWindow),
  notifyReady: () => { ipcRenderer.send(CHANNELS.rendererReady); },
  openCodeStatus: () => ipcRenderer.invoke(CHANNELS.openCodeStatus),
  restartOpenCode: () => ipcRenderer.invoke(CHANNELS.restartOpenCode),
  updateState: () => ipcRenderer.invoke(CHANNELS.updateGetState),
  updateAction: (action) => ipcRenderer.invoke(CHANNELS.updateAction, action),
  onUpdateState: (listener) => subscribe(CHANNELS.updateState, listener),
  connectorAction: (action) => ipcRenderer.invoke(CHANNELS.connectorAction, action),
  browserState: () => ipcRenderer.invoke(CHANNELS.browserGetState),
  browserAction: (action) => ipcRenderer.invoke(CHANNELS.browserAction, action),
  recorderState: () => ipcRenderer.invoke(CHANNELS.recorderGetState),
  recorderAction: (action) => ipcRenderer.invoke(CHANNELS.recorderAction, action),
  preferencesState: () => ipcRenderer.invoke(CHANNELS.preferencesGet),
  preferencesAction: (action) => ipcRenderer.invoke(CHANNELS.preferencesAction, action),
  liveSessionState: () => ipcRenderer.invoke(CHANNELS.liveSessionGetState),
  liveSessionAction: (action) => ipcRenderer.invoke(CHANNELS.liveSessionAction, action),
  mobileConnectionState: () => ipcRenderer.invoke(CHANNELS.mobileConnectionGetState),
  mobileConnectionAction: (action) => ipcRenderer.invoke(CHANNELS.mobileConnectionAction, action),
  onEventBatch: (listener) => subscribe(CHANNELS.eventBatch, listener),
  onRuntimeState: (listener) => subscribe(CHANNELS.runtimeState, listener),
  onBrowserState: (listener) => subscribe(CHANNELS.browserState, listener),
  onBrowserNotice: (listener) => subscribe(CHANNELS.browserNotice, listener),
  onRecorderState: (listener) => subscribe(CHANNELS.recorderState, listener),
  onRecorderEvent: (listener) => subscribe(CHANNELS.recorderEvent, listener),
  onPreferencesState: (listener) => subscribe(CHANNELS.preferencesState, listener),
  onLiveSessionState: (listener) => subscribe(CHANNELS.liveSessionState, listener),
  onLiveSessionEvent: (listener) => subscribe(CHANNELS.liveSessionEvent, listener),
  onMobileConnectionState: (listener) => subscribe(CHANNELS.mobileConnectionState, listener),
});

contextBridge.exposeInMainWorld('tethoqDesktop', api);
