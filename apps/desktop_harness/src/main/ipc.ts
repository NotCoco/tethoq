import { lstat, readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, normalize, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import type { JsonObject } from "../../../../packages/protocol/src/index.js";
import {
  DESKTOP_PROVIDERS,
  IPC_CHANNELS,
  MAX_TASK_TITLE_CHARACTERS,
  type DesktopBootstrap,
  type TaskOverride,
  type ConnectorAction,
  type BrowserAction,
  type BrowserWorkspaceState,
  type RecorderAction,
  type RecorderState,
  type WorkflowAttachment,
  type WorkflowDescriptor,
  type WorkflowScreenshot,
  type WorkflowScreenshotImage,
  type SelectedFile,
  type SelectedImage,
  type ScreenCaptureSource,
  type LiveSessionAction,
  type LocalOpenHandlerId,
  type LocalOpenState,
  type PreferencesAction,
  type MobileConnectionAction,
} from "../shared/desktop_api.js";
import type { DesktopRuntime } from "./runtime.js";
import { HARNESS_GUIDES } from "../shared/harness_setup.js";
import type { MobileConnectionManager } from "./mobile_connection.js";
import type { DesktopPreferencesStore } from "./preferences.js";
import type { LiveSessionManager } from "./live_session/manager.js";
import { detectLocalOpenHandlers, existingLocalTarget, openExistingLocalTarget, publicLocalOpenHandlers } from "./local_open.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_SELECTED_IMAGES = 4;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SELECTED_FILES = 4;
const MAX_SELECTED_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CAPTURE_EDGE = 4_096;
/** A whole long answer copies comfortably; an unbounded renderer string does not. */
const MAX_CLIPBOARD_CHARACTERS = 2_000_000;
const EXECUTABLE_FILE_EXTENSIONS = new Set([
  ".apk", ".app", ".appx", ".appxbundle", ".com", ".cpl", ".deb", ".dll", ".dmg",
  ".exe", ".iso", ".jar", ".lnk", ".msi", ".msp", ".msix", ".msixbundle", ".node",
  ".ocx", ".pif", ".pkg", ".rpm", ".scf", ".scr", ".sys", ".wasm",
]);
const ALLOWED_REQUESTS = new Set([
  "host.get",
  "provider.list",
  "provider.reconnect",
  "provider.authenticate",
  "models.list",
  "wallet.get",
  "wallet.configure",
  "vision.targets",
  "sessions.bootstrap",
  "sessions.refresh",
  "sessions.list",
  "session.open",
  "session.watch",
  "session.unwatch",
  "session.image.get",
  "session.children",
  "session.context.get",
  "session.goal.get",
  "session.goal.set",
  "session.goal.clear",
  "session.context.set_threshold",
  "session.context.clear_threshold",
  "session.context.compact",
  "session.context_handoff",
  "session.branch",
  "side_chat.list",
  "side_chat.create",
  "side_chat.promote",
  "session.vision.get",
  "session.vision.configure",
  "session.vision.ask",
  "session.create",
  "scheduled_task.list",
  "scheduled_task.create",
  "scheduled_task.cancel",
  "scheduled_task.run_now",
  "scheduled_task.retry",
  "session.send_message",
  "session.continue",
  "session.steer_message",
  "session.edit_message",
  "session.interrupt",
  "message_queue.list",
  "message_queue.enqueue",
  "message_queue.edit",
  "message_queue.deliver",
  "message_queue.move_to_new_task",
  "message_queue.deliver_new_task",
  "message_queue.cancel",
  "delegation.list",
  "delegation.prepare",
  "delegation.start",
  "attachment.upload.begin",
  "attachment.upload.chunk",
  "attachment.upload.complete",
  "attachment.upload.cancel",
  "dictation.source.list",
  "dictation.source.configure",
  "dictation.transcribe",
  "ears.process",
  "ears.cancel",
  "approval.list",
  "approval.respond",
  "user_input.list",
  "user_input.respond",
  "device.list",
  "device.revoke",
  "sync.since",
]);

export interface RegisterDesktopIpcOptions {
  readonly window: BrowserWindow;
  readonly runtime: DesktopRuntime;
  readonly bootstrap: () => Promise<DesktopBootstrap>;
  readonly allowedProviderIds: () => ReadonlySet<string>;
  readonly browser?: {
    getState(): BrowserWorkspaceState;
    createTab(input?: { readonly url?: string }, activate?: boolean): Promise<unknown> | unknown;
    activateTab(tabId: string): Promise<unknown> | unknown;
    closeTab(tabId: string): Promise<unknown> | unknown;
    navigate(tabId: string, input: string): Promise<unknown> | unknown;
    goBack(tabId: string): Promise<unknown> | unknown;
    goForward(tabId: string): Promise<unknown> | unknown;
    reload(tabId: string): Promise<unknown> | unknown;
    stop(tabId: string): Promise<unknown> | unknown;
    setMuted(tabId: string, muted: boolean): Promise<unknown> | unknown;
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
    setVisible(visible: boolean): void;
    setVisibleForSession?(visible: boolean, sessionId?: string): Promise<BrowserWorkspaceState>;
    focus(): void;
    prepareOverlay(bounds: { x: number; y: number; width: number; height: number }): Promise<{ readonly snapshot: string; readonly token: number }>;
    openOverlay(token: number): void;
    closeOverlay(): void;
    resolvePermission(requestId: string, allow: boolean, rememberForSession?: boolean): void;
    clearProfileData(): Promise<unknown>;
    clearDownloadHistory(): void;
    pauseDownload(id: string): void;
    resumeDownload(id: string): void;
    cancelDownload(id: string): void;
  };
  readonly recorder?: {
    state(): RecorderState;
    start(options?: { readonly privacyConsent: true }): Promise<unknown>;
    stop(reason?: "user" | "panic-shortcut" | "duration-limit" | "app-shutdown" | "error"): Promise<unknown>;
    finalize(name: string): Promise<WorkflowDescriptor>;
    discard(): Promise<unknown>;
    list(): Promise<readonly WorkflowDescriptor[]>;
    screenshots(id: string): Promise<readonly WorkflowScreenshot[]>;
    screenshot(id: string, frameId: string, variant: "thumbnail" | "full"): Promise<WorkflowScreenshotImage>;
    delete(id: string): Promise<unknown>;
    reveal(id: string): Promise<unknown>;
    attachment(id: string): Promise<WorkflowAttachment>;
  };
  readonly preferences: DesktopPreferencesStore;
  readonly liveSession?: LiveSessionManager;
  readonly mobileConnection: MobileConnectionManager;
}

export function registerDesktopIpc(options: RegisterDesktopIpcOptions): () => void {
  const { window, runtime } = options;
  const localOpenHandlers = detectLocalOpenHandlers();
  const localOpenState = async (): Promise<LocalOpenState> => {
    const handlers = await localOpenHandlers;
    const preferred = options.preferences.value().localOpenHandlerId;
    return {
      defaultHandlerId: handlers.some((handler) => handler.id === preferred) ? preferred : "system",
      handlers: publicLocalOpenHandlers(handlers),
    };
  };
  const handle = <T extends unknown[]>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: T) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedSender(event, window);
      return listener(event, ...(args as T));
    });
  };

  handle(IPC_CHANNELS.bootstrap, async () => await options.bootstrap());
  handle(IPC_CHANNELS.request, async (_event, value: unknown) => {
    const input = record(value, "request");
    const type = nonEmptyString(input.type, "request type", 80);
    if (!ALLOWED_REQUESTS.has(type)) throw new Error(`Desktop request ${type} is not allowed`);
    let payload = jsonObject(input.payload ?? {}, "request payload");
    if (payload.workflowIds !== undefined) {
      if (!new Set(["session.send_message", "session.steer_message", "message_queue.enqueue"]).has(type)) throw new Error("Workflows can only be attached to a message");
      if (!options.recorder) throw new Error("Workflow recording is not available");
      if (!Array.isArray(payload.workflowIds) || payload.workflowIds.length === 0 || payload.workflowIds.length > 4
        || !payload.workflowIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 160)) {
        throw new Error("Choose between one and four valid workflows");
      }
      const workflows = await Promise.all(payload.workflowIds.map(async (id) => {
        const workflow = await options.recorder!.attachment(id as string);
        return {
          id: workflow.id,
          name: workflow.name,
          eventCount: workflow.summary.eventCount,
          screenshotCount: workflow.summary.screenshotCount,
          applications: [...workflow.summary.apps].slice(0, 8),
          promptReference: workflow.promptReference,
        };
      }));
      const { workflowIds: _workflowIds, ...rest } = payload;
      payload = { ...rest, workflows } as JsonObject;
    }
    const allowedProviderIds = options.allowedProviderIds();
    validateProviderTarget(payload, type === "wallet.get" || type === "wallet.configure" ? new Set([...allowedProviderIds, "direct"]) : allowedProviderIds);
    const requestId = input.requestId === undefined ? undefined : nonEmptyString(input.requestId, "request ID", 160);
    if (type === "provider.reconnect" && typeof payload.providerId === "string") {
      await runtime.setupProviderTools(payload.providerId);
      if (payload.providerId === "opencode") await runtime.ensureOpenCode();
    }
    return await runtime.request(type, payload, requestId);
  });
  handle(IPC_CHANNELS.selectDirectory, async (_event, value: unknown) => {
    const input = value === undefined ? {} : record(value, "directory options");
    const defaultPath = input.defaultPath === undefined ? undefined : safeAbsolutePath(input.defaultPath);
    const result = await dialog.showOpenDialog(window, {
      title: "Choose a project folder",
      properties: ["openDirectory", "createDirectory"],
      ...(defaultPath !== undefined ? { defaultPath } : {}),
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  handle(IPC_CHANNELS.selectImages, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: "Attach images",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (result.canceled) return [];
    return await Promise.all(result.filePaths.slice(0, MAX_SELECTED_IMAGES).map(readSelectedImage));
  });
  handle(IPC_CHANNELS.selectFiles, async (_event, value: unknown) => {
    const providerId = nonEmptyString(record(value, "file attachment options").providerId, "provider ID", 160);
    if (providerId !== "opencode") throw new Error("Generic file attachments are available only for OpenCode");
    const result = await dialog.showOpenDialog(window, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    return await readSelectedFiles(result.filePaths);
  });
  handle(IPC_CHANNELS.captureScreens, async () => await captureScreens());
  handle(IPC_CHANNELS.revealPath, async (_event, value: unknown) => {
    const path = safeAbsolutePath(record(value, "path options").path);
    const error = await shell.openPath(path);
    return error === "";
  });
  handle(IPC_CHANNELS.copyText, async (_event, value: unknown) => {
    const text = record(value, "clipboard text").text;
    if (typeof text !== "string") throw new Error("Clipboard text must be a string");
    const trimmed = text.slice(0, MAX_CLIPBOARD_CHARACTERS);
    if (trimmed === "") return false;
    clipboard.writeText(trimmed);
    return true;
  });
  handle(IPC_CHANNELS.localOpenHandlers, async () => await localOpenState());
  handle(IPC_CHANNELS.openLocalTarget, async (_event, value: unknown) => {
    const input = record(value, "local open target");
    const path = nonEmptyString(input.path, "path", 32_768);
    const line = optionalPositiveInteger(input.line, "line");
    const column = optionalPositiveInteger(input.column, "column");
    const handlers = await localOpenHandlers;
    const preferredId = input.handlerId === undefined
      ? options.preferences.value().localOpenHandlerId
      : localOpenHandlerId(input.handlerId);
    const handler = handlers.find((candidate) => candidate.id === preferredId) ?? (input.handlerId === undefined ? handlers[0] : undefined);
    if (!handler) throw new Error("That application is not installed");
    if (input.rememberAsDefault !== undefined && typeof input.rememberAsDefault !== "boolean") throw new Error("The default application setting is invalid");
    const target = await existingLocalTarget(path, line, column);
    await openExistingLocalTarget(target, handler, { shell });
    if (input.rememberAsDefault === true) await options.preferences.setLocalOpenHandler(handler.id);
    return { opened: true as const, handlerId: handler.id, state: await localOpenState() };
  });
  handle(IPC_CHANNELS.openDictationSetupPage, async (_event, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dictation source is invalid");
    const sourceId = (value as { readonly sourceId?: unknown }).sourceId;
    const url = sourceId === "openai-stt"
      ? "https://platform.openai.com/api-keys"
      : sourceId === "xai-stt"
        ? "https://console.x.ai/"
        : undefined;
    if (url === undefined) throw new Error("Dictation source is invalid");
    await shell.openExternal(url);
  });
  handle(IPC_CHANNELS.showWindow, () => { showWindow(window); });
  handle(IPC_CHANNELS.openHarnessSetupPage, async (_event, value: unknown) => {
    const input = record(value, "harness setup");
    const guide = HARNESS_GUIDES.find((item) => item.id === input.providerId);
    if (!guide?.documentation.startsWith("https://")) throw new Error("Harness setup page is unavailable");
    await shell.openExternal(guide.documentation);
  });
  handle(IPC_CHANNELS.hideWindow, () => { window.hide(); });
  handle(IPC_CHANNELS.openCodeStatus, () => runtime.openCode.status());
  handle(IPC_CHANNELS.restartOpenCode, async () => await runtime.restartOpenCode());
  handle(IPC_CHANNELS.connectorAction, async (_event, value: unknown) => await runtime.connectorAction(validateConnectorAction(value)));
  handle(IPC_CHANNELS.browserGetState, () => {
    if (!options.browser) throw new Error("The browser workspace is not available");
    return options.browser.getState();
  });
  handle(IPC_CHANNELS.browserAction, async (_event, value: unknown) => {
    if (!options.browser) throw new Error("The browser workspace is not available");
    const action = validateBrowserAction(value);
    switch (action.type) {
      case "create-tab": await options.browser.createTab(action.input === undefined ? {} : { url: action.input }, action.activate); break;
      case "activate-tab": await options.browser.activateTab(action.tabId); break;
      case "close-tab": await options.browser.closeTab(action.tabId); break;
      case "navigate": await options.browser.navigate(action.tabId, action.input); break;
      case "back": await options.browser.goBack(action.tabId); break;
      case "forward": await options.browser.goForward(action.tabId); break;
      case "reload": await options.browser.reload(action.tabId); break;
      case "stop": await options.browser.stop(action.tabId); break;
      case "set-muted": await options.browser.setMuted(action.tabId, action.muted); break;
      case "set-bounds": options.browser.setBounds(action.bounds); break;
      case "set-visible":
        if (options.browser.setVisibleForSession !== undefined) return await options.browser.setVisibleForSession(action.visible, action.sessionId);
        options.browser.setVisible(action.visible);
        break;
      case "focus": options.browser.focus(); break;
      case "prepare-overlay": {
        const prepared = await options.browser.prepareOverlay(action.bounds);
        return { ...options.browser.getState(), overlaySnapshotDataUrl: prepared.snapshot, overlayToken: prepared.token };
      }
      case "open-overlay": options.browser.openOverlay(action.token); break;
      case "close-overlay": options.browser.closeOverlay(); break;
      case "clear-profile": await options.browser.clearProfileData(); break;
      case "clear-download-history": options.browser.clearDownloadHistory(); break;
      case "permission": options.browser.resolvePermission(action.requestId, action.allow, action.rememberForSession); break;
      case "download": if (action.action === "pause") options.browser.pauseDownload(action.id); else if (action.action === "resume") options.browser.resumeDownload(action.id); else options.browser.cancelDownload(action.id); break;
    }
    return options.browser.getState();
  });
  handle(IPC_CHANNELS.recorderGetState, () => {
    if (!options.recorder) throw new Error("Workflow recording is not available");
    return options.recorder.state();
  });
  handle(IPC_CHANNELS.recorderAction, async (_event, value: unknown) => {
    if (!options.recorder) throw new Error("Workflow recording is not available");
    const action = validateRecorderAction(value);
    switch (action.type) {
      case "start": await options.recorder.start({ privacyConsent: true }); return options.recorder.state();
      case "stop": await options.recorder.stop(action.reason); return options.recorder.state();
      case "finalize": return await options.recorder.finalize(action.name);
      case "discard": await options.recorder.discard(); return options.recorder.state();
      case "list": return await options.recorder.list();
      case "screenshots": return await options.recorder.screenshots(action.id);
      case "screenshot-data": return await options.recorder.screenshot(action.id, action.frameId, action.variant);
      case "delete": await options.recorder.delete(action.id); return options.recorder.state();
      case "reveal": await options.recorder.reveal(action.id); return null;
      case "attachment": return await options.recorder.attachment(action.id);
    }
  });
  handle(IPC_CHANNELS.preferencesGet, () => options.preferences.value());
  handle(IPC_CHANNELS.preferencesAction, async (_event, value: unknown) => {
    const action = validatePreferencesAction(value);
    switch (action.type) {
      case "set-experimental-features": return await options.preferences.setExperimentalFeatures(action.enabled);
      case "set-reasoning-display": return await options.preferences.setReasoningDisplay(action.value);
      case "set-task-list-mode": return await options.preferences.setTaskListMode(action.value);
      case "save-project": return await options.preferences.saveProject(action.directory);
      case "use-project": return await options.preferences.useProject(action.directory);
      case "set-close-action": return await options.preferences.setCloseAction(action.value);
      case "set-launch-at-login": return await options.preferences.setLaunchAtLogin(action.value);
      case "set-alerts": return await options.preferences.setAlerts(action.value);
      case "choose-global-agents": {
        const result = await dialog.showOpenDialog(window, {
          title: "Choose global AGENTS.md",
          properties: ["openFile"],
          filters: [{ name: "AGENTS.md", extensions: ["md"] }],
        });
        if (result.canceled || result.filePaths[0] === undefined) return options.preferences.value();
        return await options.preferences.setGlobalAgentsPath(result.filePaths[0]);
      }
      case "clear-global-agents": return await options.preferences.setGlobalAgentsPath(null);
      case "set-task-override": return await options.preferences.setTaskOverride(action.sessionId, action.override);
      case "move-task-override": return await options.preferences.moveTaskOverride(action.fromSessionId, action.toSessionId);
      case "set-agent-default": return await options.preferences.setAgentDefault(action.providerId, {
        modelId: action.modelId,
        ...(action.reasoningEffort ? { reasoningEffort: action.reasoningEffort } : {}),
      });
      case "set-allow-foreign-subagents": return await options.preferences.setAllowForeignSubagents(action.enabled);
      case "set-session-foreign-subagents": return await options.preferences.setSessionForeignSubagents(action.sessionId, action.allowed);
      case "set-ears": return await options.preferences.setEars(action.ears);
    }
  });
  handle(IPC_CHANNELS.liveSessionGetState, () => {
    if (!options.liveSession) throw new Error("Instant sessions are not available");
    return options.liveSession.state();
  });
  handle(IPC_CHANNELS.liveSessionAction, async (_event, value: unknown) => {
    if (!options.liveSession) throw new Error("Instant sessions are not available");
    // The manager re-checks the experimental gate on every begin; this early
    // check makes the rejection identical and cheap for every action.
    if (!options.preferences.value().experimentalFeatures) throw new Error("Instant sessions require experimental features. Enable them in Tethoq Settings first.");
    const action = validateLiveSessionAction(value);
    switch (action.type) {
      case "begin": return await options.liveSession.begin();
      case "end": await options.liveSession.end(action.reason ?? "user"); return options.liveSession.state();
      case "evidence": return await options.liveSession.evidence(action);
    }
  });
  handle(IPC_CHANNELS.mobileConnectionGetState, async () => await options.mobileConnection.refreshState());
  handle(IPC_CHANNELS.mobileConnectionAction, async (_event, value: unknown) => {
    const action = validateMobileConnectionAction(value);
    if (action.type === "start") return await options.mobileConnection.startPairing();
    return await options.mobileConnection.revoke(action.connectionId);
  });
  if (process.env.TETHOQ_PACKAGED_SMOKE === "1") {
    handle(IPC_CHANNELS.smokeQuit, () => {
      setImmediate(() => app.quit());
      return true;
    });
  }

  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      if (channel !== IPC_CHANNELS.eventBatch && channel !== IPC_CHANNELS.runtimeState) ipcMain.removeHandler(channel);
    }
  };
}

function validateBrowserAction(value: unknown): BrowserAction {
  const input = record(value, "browser action");
  const type = nonEmptyString(input.type, "browser action type", 40);
  if (type === "create-tab") return { type, ...(input.input === undefined ? {} : { input: nonEmptyString(input.input, "address", 8_192) }), ...(typeof input.activate === "boolean" ? { activate: input.activate } : {}) };
  if (["activate-tab", "close-tab", "back", "forward", "reload", "stop"].includes(type)) return { type: type as "activate-tab", tabId: nonEmptyString(input.tabId, "tab ID", 160) };
  if (type === "set-muted") {
    if (typeof input.muted !== "boolean") throw new Error("Browser tab mute state must be true or false");
    return { type, tabId: nonEmptyString(input.tabId, "tab ID", 160), muted: input.muted };
  }
  if (type === "navigate") return { type, tabId: nonEmptyString(input.tabId, "tab ID", 160), input: nonEmptyString(input.input, "address", 8_192) };
  if (type === "set-visible") return {
    type,
    visible: input.visible === true,
    ...(input.sessionId === undefined ? {} : { sessionId: nonEmptyString(input.sessionId, "session ID", 320) }),
  };
  if (type === "set-bounds") {
    const bounds = record(input.bounds, "browser bounds");
    const number = (entry: unknown, name: string): number => { if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`${name} is invalid`); return Math.round(entry); };
    return { type, bounds: { x: number(bounds.x, "x"), y: number(bounds.y, "y"), width: Math.max(1, number(bounds.width, "width")), height: Math.max(1, number(bounds.height, "height")) } };
  }
  if (type === "prepare-overlay") {
    const bounds = record(input.bounds, "browser overlay bounds");
    const number = (entry: unknown, name: string): number => { if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`${name} is invalid`); return Math.round(entry); };
    return { type, bounds: { x: number(bounds.x, "x"), y: number(bounds.y, "y"), width: Math.max(1, number(bounds.width, "width")), height: Math.max(1, number(bounds.height, "height")) } };
  }
  if (type === "open-overlay") {
    if (typeof input.token !== "number" || !Number.isSafeInteger(input.token) || input.token < 1) throw new Error("browser overlay token is invalid");
    return { type, token: input.token };
  }
  if (["focus", "clear-profile", "clear-download-history", "close-overlay"].includes(type)) return { type: type as "focus" };
  if (type === "permission") return { type, requestId: nonEmptyString(input.requestId, "permission request ID", 160), allow: input.allow === true, ...(typeof input.rememberForSession === "boolean" ? { rememberForSession: input.rememberForSession } : {}) };
  if (type === "download" && ["pause", "resume", "cancel"].includes(String(input.action))) return { type, id: nonEmptyString(input.id, "download ID", 160), action: input.action as "pause" };
  throw new Error("Unknown browser action");
}

function validateConnectorAction(value: unknown): ConnectorAction {
  const input = record(value, "connector action");
  const type = nonEmptyString(input.type, "connector action type", 20);
  const fingerprint = nonEmptyString(input.fingerprint, "connector fingerprint", 80);
  if (type !== "approve" && type !== "revoke") throw new Error("Unknown connector action");
  if (!/^sha256:[0-9a-f]{64}$/u.test(fingerprint)) throw new Error("Connector fingerprint is invalid");
  return { type, fingerprint };
}

function validateRecorderAction(value: unknown): RecorderAction {
  const input = record(value, "recorder action");
  const type = nonEmptyString(input.type, "recorder action type", 40);
  if (type === "start" || type === "discard" || type === "list") return { type };
  if (type === "stop") return { type, ...(input.reason === "panic-shortcut" || input.reason === "app-shutdown" || input.reason === "user" ? { reason: input.reason } : {}) };
  if (type === "finalize") return { type, name: nonEmptyString(input.name, "workflow name", 120).trim() };
  if (type === "delete" || type === "reveal" || type === "attachment" || type === "screenshots") return { type, id: nonEmptyString(input.id, "workflow ID", 160) };
  if (type === "screenshot-data") {
    const variant = input.variant === "thumbnail" || input.variant === "full" ? input.variant : undefined;
    if (variant === undefined) throw new Error("Unknown workflow screenshot size");
    const frameId = nonEmptyString(input.frameId, "workflow screenshot ID", 32);
    if (!/^frame-\d{6}$/u.test(frameId)) throw new Error("Invalid workflow screenshot ID");
    return { type, id: nonEmptyString(input.id, "workflow ID", 160), frameId, variant };
  }
  throw new Error("Unknown recorder action");
}

function validatePreferencesAction(value: unknown): PreferencesAction {
  const input = record(value, "preferences action");
  if (input.type === "set-experimental-features") {
    if (typeof input.enabled !== "boolean") throw new Error("The experimental features setting must be true or false");
    return { type: "set-experimental-features", enabled: input.enabled };
  }
  if (input.type === "set-reasoning-display") {
    if (input.value !== "compact" && input.value !== "expanded") throw new Error("The reasoning display setting must be compact or expanded");
    return { type: "set-reasoning-display", value: input.value };
  }
  if (input.type === "set-task-list-mode") {
    if (input.value !== "recent" && input.value !== "project") throw new Error("The task list mode must be recent or project");
    return { type: "set-task-list-mode", value: input.value };
  }
  if (input.type === "save-project" || input.type === "use-project") {
    return { type: input.type, directory: nonEmptyString(input.directory, "project folder", 32_768) };
  }
  if (input.type === "set-close-action") {
    if (input.value !== "tray" && input.value !== "quit") throw new Error("The close setting must be tray or quit");
    return { type: "set-close-action", value: input.value };
  }
  if (input.type === "set-launch-at-login") {
    if (input.value !== "off" && input.value !== "window" && input.value !== "tray") throw new Error("The startup setting must be off, window, or tray");
    return { type: "set-launch-at-login", value: input.value };
  }
  if (input.type === "set-alerts") {
    if (input.value !== "all" && input.value !== "attention" && input.value !== "off") throw new Error("The alerts setting must be all, attention, or off");
    return { type: "set-alerts", value: input.value };
  }
  if (input.type === "choose-global-agents" || input.type === "clear-global-agents") return { type: input.type };
  if (input.type === "set-task-override") {
    const sessionId = nonEmptyString(input.sessionId, "task ID", 400).trim();
    const patch = record(input.override, "task override");
    const title = patch.title === undefined || patch.title === "" ? undefined : nonEmptyString(patch.title, "task name", MAX_TASK_TITLE_CHARACTERS).trim();
    const override: TaskOverride = {
      // An explicit empty title clears the local name and restores the provider's own.
      ...(patch.title === undefined ? {} : { title: title ?? "" }),
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned === true }),
      ...(patch.archived === undefined ? {} : { archived: patch.archived === true }),
    };
    return { type: "set-task-override", sessionId, override };
  }
  if (input.type === "move-task-override") {
    const fromSessionId = nonEmptyString(input.fromSessionId, "source task ID", 400).trim();
    const toSessionId = nonEmptyString(input.toSessionId, "destination task ID", 400).trim();
    return { type: "move-task-override", fromSessionId, toSessionId };
  }
  if (input.type === "set-agent-default") {
    const providerId = nonEmptyString(input.providerId, "provider ID", 160).trim();
    const modelId = nonEmptyString(input.modelId, "model ID", 320).trim();
    const reasoningEffort = input.reasoningEffort === undefined ? undefined : nonEmptyString(input.reasoningEffort, "reasoning effort", 80).trim();
    return { type: "set-agent-default", providerId, modelId, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }
  if (input.type === "set-allow-foreign-subagents") {
    if (typeof input.enabled !== "boolean") throw new Error("The foreign sub-agent setting must be true or false");
    return { type: "set-allow-foreign-subagents", enabled: input.enabled };
  }
  if (input.type === "set-session-foreign-subagents") {
    const sessionId = nonEmptyString(input.sessionId, "task ID", 400).trim();
    if (typeof input.allowed !== "boolean") throw new Error("The foreign sub-agent choice must be true or false");
    return { type: "set-session-foreign-subagents", sessionId, allowed: input.allowed };
  }
  if (input.type === "set-ears") {
    const ears = record(input.ears, "EARS settings");
    const providerId = ears.providerId === null || ears.providerId === undefined || ears.providerId === ""
      ? null
      : nonEmptyString(ears.providerId, "EARS provider", 160).trim();
    const modelId = ears.modelId === null || ears.modelId === undefined || ears.modelId === ""
      ? null
      : nonEmptyString(ears.modelId, "EARS model", 320).trim();
    const mode = ears.mode === "verbatim" ? "verbatim" : "cleaned";
    return { type: "set-ears", ears: { enabled: ears.enabled === true, providerId, modelId, mode } };
  }
  throw new Error("Unknown preferences action");
}

function validateLiveSessionAction(value: unknown): LiveSessionAction {
  const input = record(value, "live session action");
  const type = nonEmptyString(input.type, "live session action type", 40);
  if (type === "begin") return { type };
  if (type === "end") return { type, ...(input.reason === "user" || input.reason === "settings-disabled" ? { reason: input.reason } : {}) };
  if (type === "evidence") {
    const startedAtWallMs = input.startedAtWallMs;
    const endedAtWallMs = input.endedAtWallMs;
    if (typeof startedAtWallMs !== "number" || !Number.isFinite(startedAtWallMs)) throw new Error("The utterance start time is invalid");
    if (typeof endedAtWallMs !== "number" || !Number.isFinite(endedAtWallMs)) throw new Error("The utterance end time is invalid");
    return { type, utteranceId: nonEmptyString(input.utteranceId, "utterance ID", 160), startedAtWallMs, endedAtWallMs };
  }
  throw new Error("Unknown live session action");
}

function validateMobileConnectionAction(value: unknown): MobileConnectionAction {
  const input = record(value, "mobile connection action");
  if (input.type === "start") return { type: "start" };
  if (input.type === "revoke") {
    return { type: "revoke", connectionId: nonEmptyString(input.connectionId, "phone connection ID", 160) };
  }
  throw new Error("Unknown mobile connection action");
}

export function validateProviderTarget(payload: JsonObject, allowedProviderIds: ReadonlySet<string>): void {
  const providerId = payload.providerId;
  if (providerId !== undefined && (typeof providerId !== "string" || !allowedProviderIds.has(providerId))) {
    throw new Error("That provider is not available in Tethoq desktop");
  }
  const selection = payload.selection;
  if (selection !== undefined && selection !== null) {
    if (typeof selection !== "object" || Array.isArray(selection) || typeof selection.providerId !== "string" || !allowedProviderIds.has(selection.providerId)) {
      throw new Error("Visual support contains an unavailable provider");
    }
  }
  const targets = payload.targets;
  if (targets !== undefined) {
    if (!Array.isArray(targets)) throw new Error("Delegation targets must be an array");
    for (const target of targets) {
      if (typeof target !== "object" || target === null || Array.isArray(target) || typeof target.providerId !== "string" || !allowedProviderIds.has(target.providerId)) {
        throw new Error("Delegation contains an unavailable provider");
      }
    }
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Untrusted IPC sender");
  const url = event.senderFrame.url;
  if (url.startsWith("file://")) return;
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined && new URL(url).origin === new URL(devServerUrl).origin) return;
  throw new Error("IPC sender origin is not allowed");
}

function showWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown, name: string): JsonObject {
  return JSON.parse(JSON.stringify(record(value, name))) as JsonObject;
}

function nonEmptyString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100_000_000) throw new Error(`${name} is invalid`);
  return value;
}

function localOpenHandlerId(value: unknown): LocalOpenHandlerId {
  if (value === "system" || value === "vscode" || value === "cursor" || value === "windsurf" || value === "sublime" || value === "notepadpp" || value === "zed") return value;
  throw new Error("That application is not available");
}

function safeAbsolutePath(value: unknown): string {
  const path = nonEmptyString(value, "path", 32_768);
  if (path.includes("\0") || !isAbsolute(path)) throw new Error("Path must be absolute");
  return normalize(resolve(path));
}

async function readSelectedImage(path: string): Promise<SelectedImage> {
  const file = await stat(path);
  if (!file.isFile() || file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new Error("Selected image must be between 1 byte and 25 MiB");
  const mimeType = imageMimeType(extname(path));
  const data = await readFile(path);
  return { name: basename(path), path, mimeType, byteLength: data.byteLength, dataBase64: data.toString("base64") };
}

async function readSelectedFiles(paths: readonly string[]): Promise<readonly SelectedFile[]> {
  if (paths.length > MAX_SELECTED_FILES) throw new Error("Choose up to four files at a time");
  const selected: Array<{ path: string; byteLength: number }> = [];
  let totalBytes = 0;
  for (const value of paths) {
    const path = safeAbsolutePath(value);
    if (EXECUTABLE_FILE_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error(`${basename(path)} is an executable file and cannot be attached`);
    const file = await lstat(path);
    if (file.isSymbolicLink() || !file.isFile()) throw new Error("Only individual files can be attached");
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) throw new Error("Files must be between 1 byte and 25 MiB");
    totalBytes += file.size;
    if (totalBytes > MAX_SELECTED_FILE_BYTES) throw new Error("Selected files cannot exceed 50 MiB in total");
    selected.push({ path, byteLength: file.size });
  }
  return await Promise.all(selected.map(async ({ path, byteLength }) => {
    const data = await readFile(path);
    if (data.byteLength !== byteLength) throw new Error(`${basename(path)} changed while it was being attached`);
    if (hasExecutableSignature(data)) throw new Error(`${basename(path)} contains an executable and cannot be attached`);
    return {
      kind: "file",
      name: basename(path),
      path,
      mimeType: genericMimeType(path),
      byteLength: data.byteLength,
      dataBase64: data.toString("base64"),
    };
  }));
}

function hasExecutableSignature(data: Buffer): boolean {
  if (data.byteLength >= 2 && data[0] === 0x4d && data[1] === 0x5a) return true;
  if (data.byteLength < 4) return false;
  const signature = data.readUInt32BE(0);
  return signature === 0x7f454c46
    || signature === 0x0061736d
    || signature === 0xfeedface
    || signature === 0xcefaedfe
    || signature === 0xfeedfacf
    || signature === 0xcffaedfe
    || signature === 0xcafebabe
    || signature === 0xbebafeca;
}

function genericMimeType(path: string): string {
  const filename = basename(path).toLowerCase();
  const extension = extname(filename);
  if (filename === ".env" || filename.startsWith(".env.") || filename === "dockerfile" || filename === "makefile") return "text/plain";
  switch (extension) {
    case ".json": return "application/json";
    case ".pdf": return "application/pdf";
    case ".csv": return "text/csv";
    case ".txt":
    case ".md":
    case ".log":
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".py":
    case ".rs":
    case ".go":
    case ".java":
    case ".kt":
    case ".kts":
    case ".dart":
    case ".cs":
    case ".cpp":
    case ".c":
    case ".h":
    case ".hpp":
    case ".css":
    case ".scss":
    case ".html":
    case ".xml":
    case ".yaml":
    case ".yml":
    case ".toml":
    case ".ini":
    case ".ps1":
    case ".sh":
    case ".bat":
    case ".sql": return "text/plain";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

async function captureScreens(): Promise<readonly ScreenCaptureSource[]> {
  const displays = screen.getAllDisplays();
  const largestWidth = Math.max(1, ...displays.map((display) => Math.round(display.size.width * display.scaleFactor)));
  const largestHeight = Math.max(1, ...displays.map((display) => Math.round(display.size.height * display.scaleFactor)));
  const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(largestWidth, largestHeight));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    fetchWindowIcons: false,
    thumbnailSize: {
      width: Math.max(1, Math.round(largestWidth * scale)),
      height: Math.max(1, Math.round(largestHeight * scale)),
    },
  });
  return sources.map((source) => {
    const size = source.thumbnail.getSize();
    return {
      id: source.id,
      name: source.name,
      displayId: source.display_id,
      width: size.width,
      height: size.height,
      dataUrl: `data:image/jpeg;base64,${source.thumbnail.toJPEG(88).toString("base64")}`,
    };
  }).filter((source) => source.width > 0 && source.height > 0);
}

function imageMimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: throw new Error("Unsupported image type");
  }
}

export { ALLOWED_REQUESTS, DESKTOP_PROVIDERS };
