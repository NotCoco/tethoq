'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const channels = Object.freeze({
  getState: 'tethoq:get-preview-state',
  completeSetup: 'tethoq:complete-preview',
  resetSetup: 'tethoq:reset-preview',
  getAppMeta: 'tethoq:get-app-meta',
  getPairingStatus: 'tethoq:get-pairing-status',
  startPairing: 'tethoq:start-pairing',
  cancelPairing: 'tethoq:cancel-pairing',
  abortPairingStart: 'tethoq:abort-pairing-start',
  setWindowMode: 'tethoq:set-window-mode',
  minimizeWindow: 'tethoq:window-minimize',
  hideWindow: 'tethoq:window-hide',
});

function invoke(channel) {
  if (!Object.values(channels).includes(channel)) {
    throw new Error('IPC channel is not allowed.');
  }

  return ipcRenderer.invoke(channel);
}

function onPairingProgress(listener) {
  if (typeof listener !== 'function') throw new TypeError('Pairing progress listener must be a function.');
  const channel = 'tethoq:pairing-progress';
  const handler = (_event, message) => listener(message);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function onPairingState(listener) {
  if (typeof listener !== 'function') throw new TypeError('Pairing state listener must be a function.');
  const channel = 'tethoq:pairing-state';
  const handler = (_event, state) => listener(state);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld(
  'tethoq',
  Object.freeze({
    getPreviewState: () => invoke(channels.getState),
    completePreviewSetup: () => invoke(channels.completeSetup),
    resetPreviewSetup: () => invoke(channels.resetSetup),
    getAppMeta: () => invoke(channels.getAppMeta),
    getPairingStatus: () => invoke(channels.getPairingStatus),
    startPairing: () => invoke(channels.startPairing),
    cancelPairing: () => invoke(channels.cancelPairing),
    abortPairingStart: () => invoke(channels.abortPairingStart),
    setWindowMode: (mode) => ipcRenderer.invoke(channels.setWindowMode, mode),
    minimizeWindow: () => invoke(channels.minimizeWindow),
    hideWindow: () => invoke(channels.hideWindow),
    onPairingProgress,
    onPairingState,
  }),
);
