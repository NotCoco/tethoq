import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type DesktopEventBatch,
  type DesktopHarnessApi,
  type DesktopRuntimeState,
  type BrowserWorkspaceState,
  type BrowserNotice,
  type BrowserAction,
  type RecorderState,
  type RecorderAction,
  type RecorderProgressEvent,
  type ConnectorAction,
  type DesktopPreferencesState,
  type PreferencesAction,
  type LiveSessionState,
  type LiveSessionAction,
  type LiveSessionEvent,
} from "../shared/desktop_api.js";
import type { JsonObject } from "../../../../packages/protocol/src/index.js";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DesktopHarnessApi = Object.freeze({
  bootstrap: (): ReturnType<DesktopHarnessApi["bootstrap"]> => ipcRenderer.invoke(IPC_CHANNELS.bootstrap),
  request: (type: string, payload: JsonObject = {}, requestId?: string): ReturnType<DesktopHarnessApi["request"]> => ipcRenderer.invoke(IPC_CHANNELS.request, { type, payload, requestId }),
  selectDirectory: (defaultPath?: string): ReturnType<DesktopHarnessApi["selectDirectory"]> => ipcRenderer.invoke(IPC_CHANNELS.selectDirectory, { defaultPath }),
  selectImages: (): ReturnType<DesktopHarnessApi["selectImages"]> => ipcRenderer.invoke(IPC_CHANNELS.selectImages),
  selectFiles: (providerId: string): ReturnType<DesktopHarnessApi["selectFiles"]> => ipcRenderer.invoke(IPC_CHANNELS.selectFiles, { providerId }),
  captureScreens: (): ReturnType<DesktopHarnessApi["captureScreens"]> => ipcRenderer.invoke(IPC_CHANNELS.captureScreens),
  revealPath: (path: string): ReturnType<DesktopHarnessApi["revealPath"]> => ipcRenderer.invoke(IPC_CHANNELS.revealPath, { path }),
  localOpenHandlers: (): ReturnType<DesktopHarnessApi["localOpenHandlers"]> => ipcRenderer.invoke(IPC_CHANNELS.localOpenHandlers),
  openLocalTarget: (target: Parameters<DesktopHarnessApi["openLocalTarget"]>[0]): ReturnType<DesktopHarnessApi["openLocalTarget"]> => ipcRenderer.invoke(IPC_CHANNELS.openLocalTarget, target),
  openDictationSetupPage: (sourceId: Parameters<DesktopHarnessApi["openDictationSetupPage"]>[0]): ReturnType<DesktopHarnessApi["openDictationSetupPage"]> => ipcRenderer.invoke(IPC_CHANNELS.openDictationSetupPage, { sourceId }),
  showWindow: (): ReturnType<DesktopHarnessApi["showWindow"]> => ipcRenderer.invoke(IPC_CHANNELS.showWindow),
  hideWindow: (): ReturnType<DesktopHarnessApi["hideWindow"]> => ipcRenderer.invoke(IPC_CHANNELS.hideWindow),
  openCodeStatus: (): ReturnType<DesktopHarnessApi["openCodeStatus"]> => ipcRenderer.invoke(IPC_CHANNELS.openCodeStatus),
  restartOpenCode: (): ReturnType<DesktopHarnessApi["restartOpenCode"]> => ipcRenderer.invoke(IPC_CHANNELS.restartOpenCode),
  connectorAction: (action: ConnectorAction): ReturnType<DesktopHarnessApi["connectorAction"]> => ipcRenderer.invoke(IPC_CHANNELS.connectorAction, action),
  browserState: (): ReturnType<DesktopHarnessApi["browserState"]> => ipcRenderer.invoke(IPC_CHANNELS.browserGetState),
  browserAction: (action: BrowserAction): ReturnType<DesktopHarnessApi["browserAction"]> => ipcRenderer.invoke(IPC_CHANNELS.browserAction, action),
  recorderState: (): ReturnType<DesktopHarnessApi["recorderState"]> => ipcRenderer.invoke(IPC_CHANNELS.recorderGetState),
  recorderAction: (action: RecorderAction): ReturnType<DesktopHarnessApi["recorderAction"]> => ipcRenderer.invoke(IPC_CHANNELS.recorderAction, action),
  preferencesState: (): ReturnType<DesktopHarnessApi["preferencesState"]> => ipcRenderer.invoke(IPC_CHANNELS.preferencesGet),
  preferencesAction: (action: PreferencesAction): ReturnType<DesktopHarnessApi["preferencesAction"]> => ipcRenderer.invoke(IPC_CHANNELS.preferencesAction, action),
  liveSessionState: (): ReturnType<DesktopHarnessApi["liveSessionState"]> => ipcRenderer.invoke(IPC_CHANNELS.liveSessionGetState),
  liveSessionAction: (action: LiveSessionAction): ReturnType<DesktopHarnessApi["liveSessionAction"]> => ipcRenderer.invoke(IPC_CHANNELS.liveSessionAction, action),
  ...(process.env.TETHOQ_PACKAGED_SMOKE === "1" ? {
    quitForSmoke: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.smokeQuit),
  } : {}),
  onEventBatch: (listener: (batch: DesktopEventBatch) => void): (() => void) => subscribe<DesktopEventBatch>(IPC_CHANNELS.eventBatch, listener),
  onRuntimeState: (listener: (state: DesktopRuntimeState) => void): (() => void) => subscribe<DesktopRuntimeState>(IPC_CHANNELS.runtimeState, listener),
  onBrowserState: (listener: (state: BrowserWorkspaceState) => void): (() => void) => subscribe<BrowserWorkspaceState>(IPC_CHANNELS.browserState, listener),
  onBrowserNotice: (listener: (notice: BrowserNotice) => void): (() => void) => subscribe<BrowserNotice>(IPC_CHANNELS.browserNotice, listener),
  onRecorderState: (listener: (state: RecorderState) => void): (() => void) => subscribe<RecorderState>(IPC_CHANNELS.recorderState, listener),
  onRecorderEvent: (listener: (event: RecorderProgressEvent) => void): (() => void) => subscribe<RecorderProgressEvent>(IPC_CHANNELS.recorderEvent, listener),
  onPreferencesState: (listener: (state: DesktopPreferencesState) => void): (() => void) => subscribe<DesktopPreferencesState>(IPC_CHANNELS.preferencesState, listener),
  onLiveSessionState: (listener: (state: LiveSessionState) => void): (() => void) => subscribe<LiveSessionState>(IPC_CHANNELS.liveSessionState, listener),
  onLiveSessionEvent: (listener: (event: LiveSessionEvent) => void): (() => void) => subscribe<LiveSessionEvent>(IPC_CHANNELS.liveSessionEvent, listener),
});

contextBridge.exposeInMainWorld("tethoqDesktop", api);
