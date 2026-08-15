import { randomUUID } from "node:crypto";
import {
  Menu,
  WebContentsView,
  session,
  type BrowserWindow,
  type ContextMenuParams,
  type DownloadItem,
  type Event,
  type Input,
  type Rectangle,
  type SelectHidDeviceDetails,
  type SelectUsbDeviceDetails,
  type SerialPort,
  type Session,
  type WebContents,
} from "electron";
import { BrowserIdleLifecycle } from "./browser_idle_lifecycle.js";

/**
 * The browser deliberately uses only this named partition. It is owned by Tethoq
 * and is the only Chromium profile the workspace can read/write.
 */
export const BROWSER_PARTITION = "persist:tethoq-browser";
export const DEFAULT_BROWSER_URL = "https://www.google.com/";

const MAX_TABS = 24;
const MAX_DOWNLOAD_HISTORY = 100;
const MAX_PERMISSION_HISTORY = 100;
const MAX_SESSION_SNAPSHOTS = 32;
const MAX_NAVIGATION_INPUT = 8_192;
const MAX_AGENT_ELEMENTS = 120;
const MAX_AGENT_TEXT = 20_000;
const MAX_AGENT_LABEL = 500;
const MAX_AGENT_TYPE_TEXT = 20_000;
const MAX_AGENT_SCROLL_DELTA = 4_000;
const MAX_AGENT_CAPTURE_BYTES = 900_000;
const AGENT_VIEWPORT: Rectangle = { x: 0, y: 0, width: 1_280, height: 800 };
const SEARCH_ENDPOINT = "https://www.google.com/search?q=";

const BLOCKED_PERMISSION_TYPES = new Set([
  "display-capture",
  "fileSystem",
  "hid",
  "keyboardLock",
  "midiSysex",
  "openExternal",
  "pointerLock",
  "serial",
  "usb",
  "window-management",
]);

const ASKABLE_PERMISSION_TYPES = new Set([
  "clipboard-read",
  "fullscreen",
  "geolocation",
  "idle-detection",
  "media",
  "notifications",
  "speaker-selection",
]);

export type BrowserPermissionDecision = "allow" | "deny";
export type BrowserDownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

export interface BrowserTabState {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly faviconUrl: string | null;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly crashed: boolean;
  readonly error: string | null;
}

export interface BrowserDownloadStateEntry {
  readonly id: string;
  readonly tabId: string | null;
  readonly filename: string;
  readonly url: string;
  readonly savePath: string | null;
  readonly mimeType: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly bytesPerSecond: number;
  readonly paused: boolean;
  readonly state: BrowserDownloadState;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface BrowserPermissionRequestState {
  readonly id: string;
  readonly tabId: string;
  readonly permission: string;
  readonly origin: string;
  readonly requestingUrl: string;
  readonly requestedAt: string;
}

export interface BrowserPermissionDecisionState {
  readonly permission: string;
  readonly origin: string;
  readonly decision: BrowserPermissionDecision;
}

export interface BrowserProfileState {
  readonly persistent: true;
  readonly appOwned: true;
  readonly importsSystemProfile: false;
  readonly clearing: boolean;
}

export interface BrowserWorkspaceState {
  readonly partition: typeof BROWSER_PARTITION;
  readonly profile: BrowserProfileState;
  readonly visible: boolean;
  readonly bounds: Rectangle;
  readonly activeTabId: string | null;
  readonly tabs: readonly BrowserTabState[];
  readonly downloads: readonly BrowserDownloadStateEntry[];
  readonly pendingPermissions: readonly BrowserPermissionRequestState[];
  readonly permissionDecisions: readonly BrowserPermissionDecisionState[];
}

export interface BrowserAgentElement {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly type?: string;
  readonly value?: string;
  readonly href?: string;
}

export interface BrowserAgentPageSnapshot {
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly elements: readonly BrowserAgentElement[];
  readonly elementsTruncated: boolean;
}

export interface BrowserAgentActionResult {
  readonly tabId: string;
  readonly url: string;
  readonly ref?: string;
  readonly value?: string;
  readonly scrollX?: number;
  readonly scrollY?: number;
  readonly documentHeight?: number;
  readonly viewportHeight?: number;
}

/** The attachment shape is accepted directly by AgentBridge.askVisionProxy. */
export interface BrowserAgentScreenshot {
  readonly kind: "browser_screenshot";
  readonly tabId: string;
  readonly title: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly attachment: {
    readonly name: string;
    readonly mimeType: "image/jpeg";
    readonly dataBase64: string;
    readonly byteLength: number;
  };
}

export type BrowserWorkspaceNotice =
  | { readonly type: "blocked-navigation"; readonly tabId: string; readonly url: string }
  | { readonly type: "blocked-popup"; readonly tabId: string; readonly url: string }
  | { readonly type: "focus-address"; readonly tabId: string }
  | { readonly type: "permission-blocked"; readonly tabId: string; readonly permission: string; readonly origin: string }
  | { readonly type: "permission-expired"; readonly requestId: string }
  | { readonly type: "download-started"; readonly downloadId: string }
  | { readonly type: "download-finished"; readonly downloadId: string; readonly state: BrowserDownloadState };

export interface BrowserWorkspaceManagerOptions {
  readonly window: BrowserWindow;
  readonly downloadsDirectory: string;
  readonly initialUrl?: string;
  readonly onState: (state: BrowserWorkspaceState) => void;
  readonly onNotice?: (notice: BrowserWorkspaceNotice) => void;
}

interface TabRecord {
  readonly id: string;
  readonly view: WebContentsView;
  title: string;
  url: string;
  faviconUrl: string | null;
  loading: boolean;
  crashed: boolean;
  error: string | null;
  agentInspectionId: string | null;
  readonly agentRefs: Set<string>;
}

interface PendingPermission {
  readonly state: BrowserPermissionRequestState;
  readonly callback: (allowed: boolean) => void;
  readonly expires: NodeJS.Timeout;
}

interface PermissionDecisionRecord extends BrowserPermissionDecisionState {
  readonly key: string;
}

interface DownloadRecord {
  state: BrowserDownloadStateEntry;
  item: DownloadItem | null;
  updatedListener: (() => void) | null;
  doneListener: ((event: Event, state: BrowserDownloadState) => void) | null;
}

interface BrowserSessionSnapshot {
  readonly tabs: readonly { readonly url: string; readonly title: string; readonly faviconUrl: string | null }[];
  readonly activeIndex: number;
}

/**
 * Owns the browser's native Chromium WebContentsViews. Renderer code receives
 * immutable snapshots and can only request the explicit actions below.
 */
export class BrowserWorkspaceManager {
  readonly #window: BrowserWindow;
  readonly #downloadsDirectory: string;
  readonly #initialUrl: string;
  readonly #onState: (state: BrowserWorkspaceState) => void;
  readonly #onNotice: ((notice: BrowserWorkspaceNotice) => void) | undefined;
  readonly #session: Session;
  readonly #tabs = new Map<string, TabRecord>();
  readonly #downloads = new Map<string, DownloadRecord>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #permissionDecisions = new Map<string, PermissionDecisionRecord>();
  readonly #sessionSnapshots = new Map<string, BrowserSessionSnapshot>();
  readonly #idleLifecycle: BrowserIdleLifecycle;
  readonly #willDownloadListener: (event: Event, item: DownloadItem, webContents: WebContents) => void;
  readonly #selectHidDeviceListener = (event: Event, _details: SelectHidDeviceDetails, callback: (deviceId?: string | null) => void): void => { event.preventDefault(); callback(null); };
  readonly #selectSerialPortListener = (event: Event, _ports: SerialPort[], _contents: WebContents, callback: (portId: string) => void): void => { event.preventDefault(); callback(""); };
  readonly #selectUsbDeviceListener = (event: Event, _details: SelectUsbDeviceDetails, callback: (deviceId?: string) => void): void => { event.preventDefault(); callback(); };
  #activeTabId: string | null = null;
  #bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  #visible = false;
  #hostVisible: boolean;
  #requestedVisible = false;
  #activeSessionId: string | null = null;
  #overlayOpen = false;
  #overlayGeneration = 0;
  #overlayCaptureTabId: string | null = null;
  #clearing = false;
  #initialized = false;
  #disposed = false;
  #emitQueued = false;
  #agentActive = false;
  #suspendPromise: Promise<void> | undefined;

  public constructor(options: BrowserWorkspaceManagerOptions) {
    this.#window = options.window;
    this.#downloadsDirectory = options.downloadsDirectory;
    this.#initialUrl = normalizeNavigationInput(options.initialUrl ?? DEFAULT_BROWSER_URL);
    this.#onState = options.onState;
    this.#onNotice = options.onNotice;
    this.#hostVisible = options.window.isVisible();
    this.#session = session.fromPartition(BROWSER_PARTITION, { cache: true });
    this.#willDownloadListener = (_event, item, webContents) => this.#onDownload(item, webContents);
    this.#idleLifecycle = new BrowserIdleLifecycle({ onSuspend: async () => await this.#suspendInactiveBrowser() });
  }

  public async initialize(): Promise<BrowserWorkspaceState> {
    this.#assertAvailable();
    if (!this.#initialized) {
      this.#initialized = true;
      this.#configureSession();
    }
    const state = this.getState();
    this.#onState(state);
    return state;
  }

  public get initialized(): boolean {
    return this.#initialized;
  }

  public getState(): BrowserWorkspaceState {
    return {
      partition: BROWSER_PARTITION,
      profile: {
        persistent: true,
        appOwned: true,
        importsSystemProfile: false,
        clearing: this.#clearing,
      },
      visible: this.#visible,
      bounds: { ...this.#bounds },
      activeTabId: this.#activeTabId,
      tabs: [...this.#tabs.values()].map((tab) => this.#tabState(tab)),
      downloads: [...this.#downloads.values()].map(({ state }) => ({ ...state })),
      pendingPermissions: [...this.#pendingPermissions.values()].map(({ state }) => ({ ...state })),
      permissionDecisions: [...this.#permissionDecisions.values()].map(({ key: _key, ...decision }) => ({ ...decision })),
    };
  }

  public async createTab(input: { readonly url?: string } | undefined = {}, activate = true): Promise<BrowserTabState> {
    this.#assertAvailable();
    await this.initialize();
    const tab = this.#addTab(activate);

    const url = normalizeNavigationInput(input?.url ?? this.#initialUrl);
    try {
      await tab.view.webContents.loadURL(url);
    } catch (error: unknown) {
      if (!tab.view.webContents.isDestroyed()) {
        tab.loading = false;
        tab.error = errorMessage(error);
        this.#emitSoon();
      }
    }
    return this.#tabState(tab);
  }

  public activateTab(tabId: string): BrowserTabState {
    this.#assertAvailable();
    const tab = this.#tab(tabId);
    this.#activate(tab);
    this.#emitSoon();
    return this.#tabState(tab);
  }

  public async closeTab(tabId: string): Promise<BrowserWorkspaceState> {
    this.#assertAvailable();
    const tab = this.#tab(tabId);
    const orderedIds = [...this.#tabs.keys()];
    const index = orderedIds.indexOf(tabId);
    this.#tabs.delete(tabId);
    this.#window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });

    if (this.#activeTabId === tabId) {
      this.#activeTabId = null;
      const nextId = orderedIds[index + 1] ?? orderedIds[index - 1];
      const next = nextId === undefined ? undefined : this.#tabs.get(nextId);
      if (next !== undefined) this.#activate(next);
    }
    if (this.#tabs.size === 0) await this.createTab({ url: this.#initialUrl }, true);
    this.#emitSoon();
    return this.getState();
  }

  public async navigate(tabId: string, input: string): Promise<BrowserTabState> {
    const tab = this.#tab(tabId);
    const url = normalizeNavigationInput(input);
    tab.error = null;
    this.#clearAgentRefs(tab);
    await tab.view.webContents.loadURL(url);
    return this.#tabState(tab);
  }

  /**
   * Materializes a session-owned Chromium workspace for one bounded agent tool
   * operation without making the native view visible or importing another
   * browser profile. Call finishAgentActivity in a finally block.
   */
  public async prepareAgentSession(sessionId: string, materializeTab = true): Promise<BrowserWorkspaceState> {
    this.#assertAvailable();
    const boundedSessionId = boundedText(sessionId, 500);
    if (boundedSessionId.length === 0) throw new Error("Browser agent session ID is required");
    if (this.#visible && this.#activeSessionId !== null && boundedSessionId !== this.#activeSessionId) {
      throw new Error("The visible browser belongs to another session; close it before using this browser tool");
    }
    await this.initialize();
    this.#agentActive = true;
    this.#idleLifecycle.setInactive(false);
    if (boundedSessionId !== this.#activeSessionId) {
      this.#snapshotActiveSession();
      this.#closeAllTabs();
      this.#activeSessionId = boundedSessionId;
    } else {
      this.#touchSessionSnapshot(boundedSessionId);
    }
    if (this.#tabs.size === 0) {
      await this.#suspendPromise;
      const hasSnapshot = this.#sessionSnapshots.has(boundedSessionId);
      if (this.#tabs.size === 0 && (materializeTab || hasSnapshot)) await this.#restoreSession(boundedSessionId);
    }
    for (const tab of this.#tabs.values()) tab.view.setBounds(this.#effectiveViewBounds());
    this.#emitSoon();
    return this.getState();
  }

  public finishAgentActivity(): void {
    if (this.#disposed) return;
    this.#agentActive = false;
    for (const tab of this.#tabs.values()) tab.view.setBounds(this.#bounds);
    this.#idleLifecycle.setInactive(!this.#visible && this.#tabs.size > 0);
  }

  public async inspectForAgent(tabId?: string): Promise<BrowserAgentPageSnapshot> {
    const tab = this.#agentTab(tabId);
    const inspectionId = randomUUID();
    const value = await tab.view.webContents.executeJavaScript(
      scriptCall(inspectPageForAgent, inspectionId, MAX_AGENT_ELEMENTS, MAX_AGENT_TEXT, MAX_AGENT_LABEL),
      false,
    ) as AgentInspectionPayload;
    const refs = new Set(value.elements.map((element) => element.ref));
    tab.agentInspectionId = inspectionId;
    tab.agentRefs.clear();
    for (const ref of refs) tab.agentRefs.add(ref);
    return {
      tabId: tab.id,
      title: boundedText(value.title, 240) || tab.title,
      url: isAllowedWebUrl(value.url) ? value.url : tab.url,
      text: boundedText(value.text, MAX_AGENT_TEXT),
      textTruncated: value.textTruncated === true,
      elements: value.elements.slice(0, MAX_AGENT_ELEMENTS).map((element) => normalizeAgentElement(element)),
      elementsTruncated: value.elementsTruncated === true,
    };
  }

  public async clickForAgent(ref: string, tabId?: string): Promise<BrowserAgentActionResult> {
    const tab = this.#agentTabForRef(ref, tabId);
    const value = await tab.view.webContents.executeJavaScript(scriptCall(clickElementForAgent, ref), true) as AgentActionPayload;
    if (value.ok !== true) throw new Error(agentActionError(value.error));
    return { tabId: tab.id, url: currentAgentUrl(tab, value.url), ref };
  }

  public async typeForAgent(ref: string, text: string, submit = false, tabId?: string): Promise<BrowserAgentActionResult> {
    const tab = this.#agentTabForRef(ref, tabId);
    const boundedValue = text.slice(0, MAX_AGENT_TYPE_TEXT);
    if (boundedValue.length !== text.length) throw new Error(`Browser text is limited to ${MAX_AGENT_TYPE_TEXT} characters`);
    const value = await tab.view.webContents.executeJavaScript(scriptCall(typeIntoElementForAgent, ref, boundedValue, submit), true) as AgentActionPayload;
    if (value.ok !== true) throw new Error(agentActionError(value.error));
    return {
      tabId: tab.id,
      url: currentAgentUrl(tab, value.url),
      ref,
      value: boundedText(typeof value.value === "string" ? value.value : boundedValue, MAX_AGENT_LABEL),
    };
  }

  public async scrollForAgent(deltaX: number, deltaY: number, tabId?: string): Promise<BrowserAgentActionResult> {
    const tab = this.#agentTab(tabId);
    const x = boundedAgentScrollDelta(deltaX);
    const y = boundedAgentScrollDelta(deltaY);
    if (x === 0 && y === 0) throw new Error("Browser scroll needs a non-zero delta");
    const value = await tab.view.webContents.executeJavaScript(scriptCall(scrollPageForAgent, x, y), true) as AgentScrollPayload;
    return {
      tabId: tab.id,
      url: currentAgentUrl(tab, value.url),
      scrollX: finiteNonNegative(value.scrollX),
      scrollY: finiteNonNegative(value.scrollY),
      documentHeight: finiteNonNegative(value.documentHeight),
      viewportHeight: finiteNonNegative(value.viewportHeight),
    };
  }

  public async captureForAgent(tabId?: string): Promise<BrowserAgentScreenshot> {
    const tab = this.#agentTab(tabId);
    if (this.#overlayBusy()) throw new Error("Close the browser overlay before capturing the page");
    const viewBounds = this.#effectiveViewBounds();
    tab.view.setBounds(viewBounds);
    let image = await tab.view.webContents.capturePage({ x: 0, y: 0, width: viewBounds.width, height: viewBounds.height }, { stayHidden: true });
    let size = image.getSize();
    const scale = Math.min(1, 1_280 / Math.max(1, size.width), 960 / Math.max(1, size.height));
    if (scale < 1) {
      image = image.resize({ width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)), quality: "good" });
      size = image.getSize();
    }
    let data = image.toJPEG(82);
    while (data.byteLength > MAX_AGENT_CAPTURE_BYTES && size.width > 480 && size.height > 300) {
      image = image.resize({ width: Math.max(480, Math.floor(size.width * 0.8)), height: Math.max(300, Math.floor(size.height * 0.8)), quality: "good" });
      size = image.getSize();
      data = image.toJPEG(72);
    }
    if (data.byteLength > MAX_AGENT_CAPTURE_BYTES) throw new Error("Browser screenshot is too large for visual support");
    return {
      kind: "browser_screenshot",
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      width: size.width,
      height: size.height,
      attachment: {
        name: "browser-page.jpg",
        mimeType: "image/jpeg",
        dataBase64: data.toString("base64"),
        byteLength: data.byteLength,
      },
    };
  }

  public goBack(tabId: string): BrowserTabState {
    const tab = this.#tab(tabId);
    if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
    return this.#tabState(tab);
  }

  public goForward(tabId: string): BrowserTabState {
    const tab = this.#tab(tabId);
    if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
    return this.#tabState(tab);
  }

  public reload(tabId: string): BrowserTabState {
    const tab = this.#tab(tabId);
    tab.error = null;
    tab.view.webContents.reload();
    return this.#tabState(tab);
  }

  public stop(tabId: string): BrowserTabState {
    const tab = this.#tab(tabId);
    tab.view.webContents.stop();
    return this.#tabState(tab);
  }

  public setBounds(bounds: Rectangle): BrowserWorkspaceState {
    this.#assertAvailable();
    this.#bounds = normalizeBounds(bounds);
    for (const tab of this.#tabs.values()) tab.view.setBounds(this.#bounds);
    this.#emitSoon();
    return this.getState();
  }

  public setVisible(visible: boolean): BrowserWorkspaceState {
    this.#assertAvailable();
    this.#requestedVisible = visible;
    this.#visible = visible && this.#hostVisible;
    if (!this.#visible) this.#rejectPendingPermissions();
    this.#enableBrowserThrottling();
    this.#syncTabVisibility();
    this.#idleLifecycle.setInactive(!this.#visible && this.#tabs.size > 0);
    this.#emitSoon();
    return this.getState();
  }

  /** Tracks the native window separately from the renderer's per-session request. */
  public async setHostVisible(visible: boolean): Promise<BrowserWorkspaceState> {
    this.#assertAvailable();
    this.#hostVisible = visible;
    this.#visible = this.#requestedVisible && visible;
    if (this.#visible && this.#tabs.size === 0) {
      await this.#suspendPromise;
      if (this.#visible && this.#tabs.size === 0) await this.#restoreSession(this.#activeSessionId ?? undefined);
    }
    if (!this.#visible) this.#rejectPendingPermissions();
    this.#enableBrowserThrottling();
    this.#syncTabVisibility();
    this.#idleLifecycle.setInactive(!this.#visible && this.#tabs.size > 0);
    this.#emitSoon();
    return this.getState();
  }

  /**
   * Materializes Chromium only for a session that explicitly opens its browser.
   * State reads, app startup, and unrelated coding sessions remain view/process-free.
   */
  public async setVisibleForSession(visible: boolean, sessionId?: string): Promise<BrowserWorkspaceState> {
    if (!visible && !this.#initialized) return this.setVisible(false);
    await this.initialize();
    if (visible && sessionId !== undefined && sessionId !== this.#activeSessionId) {
      this.#snapshotActiveSession();
      this.#closeAllTabs();
      this.#activeSessionId = sessionId;
    } else if (visible && sessionId !== undefined) {
      this.#touchSessionSnapshot(sessionId);
    }
    if (visible && this.#hostVisible && this.#tabs.size === 0) {
      await this.#suspendPromise;
      if (this.#tabs.size === 0) await this.#restoreSession(sessionId);
    }
    return this.setVisible(visible);
  }

  /** Releases only lightweight navigation state; persistent profile data is untouched. */
  public releaseSession(sessionId: string): void {
    if (sessionId === this.#activeSessionId) {
      this.#closeAllTabs();
      this.#activeSessionId = null;
      this.setVisible(false);
    }
    this.#sessionSnapshots.delete(sessionId);
  }


  public focus(): void {
    this.#assertAvailable();
    const tab = this.#activeTabId === null ? undefined : this.#tabs.get(this.#activeTabId);
    if (tab !== undefined && this.#visible && !this.#overlayBusy()) tab.view.webContents.focus();
  }

  public async openOverlay(bounds: Rectangle): Promise<string> {
    this.#assertAvailable();
    if (this.#overlayBusy()) throw new Error("The browser overlay is already open");
    const tab = this.#activeTabId === null ? undefined : this.#tabs.get(this.#activeTabId);
    if (tab === undefined || !this.#visible) throw new Error("The browser workspace is not visible");
    const requested = normalizeBounds(bounds);
    const viewBounds = tab.view.getBounds();
    if (viewBounds.width < 1 || viewBounds.height < 1) throw new Error("The browser workspace has not been laid out");
    const captureBounds = {
      x: 0,
      y: 0,
      width: Math.min(requested.width, viewBounds.width),
      height: Math.min(requested.height, viewBounds.height),
    };
    const generation = ++this.#overlayGeneration;
    this.#overlayCaptureTabId = tab.id;
    try {
      const image = await tab.view.webContents.capturePage(captureBounds, { stayHidden: true });
      const snapshot = `data:image/png;base64,${image.toPNG().toString("base64")}`;
      if (this.#disposed || generation !== this.#overlayGeneration || this.#overlayCaptureTabId !== tab.id || !this.#visible || !this.#tabs.has(tab.id) || tab.view.webContents.isDestroyed()) {
        if (!this.#disposed && generation === this.#overlayGeneration && this.#overlayCaptureTabId === tab.id) {
          this.#overlayCaptureTabId = null;
          this.#restoreActiveTab();
        }
        throw new Error("The browser overlay request was cancelled");
      }
      this.#overlayCaptureTabId = null;
      this.#overlayOpen = true;
      this.#syncTabVisibility();
      this.#window.webContents.focus();
      return snapshot;
    } catch (error) {
      if (generation === this.#overlayGeneration && this.#overlayCaptureTabId === tab.id) {
        this.#overlayCaptureTabId = null;
        this.#restoreActiveTab();
      }
      throw error;
    }
  }

  public closeOverlay(): void {
    this.#assertAvailable();
    ++this.#overlayGeneration;
    const wasOpen = this.#overlayOpen;
    const wasCapturing = this.#overlayCaptureTabId !== null;
    if (!wasOpen && !wasCapturing) return;
    this.#overlayOpen = false;
    this.#overlayCaptureTabId = null;
    this.#restoreActiveTab();
  }

  public resolvePermission(requestId: string, allow: boolean, rememberForSession = true): BrowserWorkspaceState {
    this.#assertAvailable();
    const pending = this.#pendingPermissions.get(requestId);
    if (pending === undefined) throw new Error("Browser permission request is no longer pending");
    clearTimeout(pending.expires);
    this.#pendingPermissions.delete(requestId);
    if (rememberForSession) {
      const key = permissionKey(pending.state.origin, pending.state.permission);
      this.#permissionDecisions.set(key, {
        key,
        origin: pending.state.origin,
        permission: pending.state.permission,
        decision: allow ? "allow" : "deny",
      });
      this.#trimPermissionHistory();
    }
    pending.callback(allow);
    this.#emitSoon();
    return this.getState();
  }

  public async clearProfileData(): Promise<BrowserWorkspaceState> {
    this.#assertAvailable();
    if (this.#clearing) return this.getState();
    this.#clearing = true;
    this.#emitSoon();
    this.#rejectPendingPermissions();
    this.#permissionDecisions.clear();
    try {
      await this.#session.clearAuthCache();
      await this.#session.clearStorageData();
      await this.#session.clearCache();
      await this.#session.clearHostResolverCache();
      await this.#session.closeAllConnections();
      this.#session.flushStorageData();
      await Promise.all([...this.#tabs.values()].map(async (tab) => {
        tab.view.webContents.navigationHistory.clear();
        tab.title = "New tab";
        tab.faviconUrl = null;
        tab.error = null;
        try {
          await tab.view.webContents.loadURL(this.#initialUrl);
        } catch (error: unknown) {
          tab.error = errorMessage(error);
        }
      }));
    } finally {
      this.#clearing = false;
      this.#emitSoon();
    }
    return this.getState();
  }

  public clearDownloadHistory(): BrowserWorkspaceState {
    this.#assertAvailable();
    for (const [id, download] of this.#downloads) {
      if (download.state.state !== "progressing") this.#downloads.delete(id);
    }
    this.#emitSoon();
    return this.getState();
  }

  public pauseDownload(downloadId: string): BrowserDownloadStateEntry {
    const download = this.#download(downloadId);
    if (download.item === null) throw new Error("That download is already finished");
    download.item.pause();
    this.#updateDownload(download);
    return { ...download.state };
  }

  public resumeDownload(downloadId: string): BrowserDownloadStateEntry {
    const download = this.#download(downloadId);
    if (download.item === null) throw new Error("That download is already finished");
    if (!download.item.canResume()) throw new Error("That download cannot be resumed");
    download.item.resume();
    this.#updateDownload(download);
    return { ...download.state };
  }

  public cancelDownload(downloadId: string): BrowserDownloadStateEntry {
    const download = this.#download(downloadId);
    if (download.item === null) throw new Error("That download is already finished");
    download.item.cancel();
    this.#updateDownload(download);
    return { ...download.state };
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#idleLifecycle.dispose();
    ++this.#overlayGeneration;
    this.#overlayOpen = false;
    this.#overlayCaptureTabId = null;
    this.#rejectPendingPermissions();
    this.#session.setPermissionCheckHandler(null);
    this.#session.setPermissionRequestHandler(null);
    this.#session.setDisplayMediaRequestHandler(null);
    this.#session.setDevicePermissionHandler(null);
    this.#session.removeListener("will-download", this.#willDownloadListener);
    this.#session.removeListener("select-hid-device", this.#selectHidDeviceListener);
    this.#session.removeListener("select-serial-port", this.#selectSerialPortListener);
    this.#session.removeListener("select-usb-device", this.#selectUsbDeviceListener);
    this.#closeAllTabs();
    for (const download of this.#downloads.values()) {
      this.#detachDownloadListeners(download);
      download.item = null;
    }
    this.#downloads.clear();
    this.#sessionSnapshots.clear();
    this.#activeTabId = null;
  }

  #createView(): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        disableDialogs: false,
        spellcheck: true,
        plugins: false,
        autoplayPolicy: "document-user-activation-required",
        backgroundThrottling: true,
        devTools: false,
      },
    });
  }

  #addTab(activate: boolean): TabRecord {
    if (this.#tabs.size >= MAX_TABS) throw new Error(`Browser workspace supports at most ${MAX_TABS} tabs`);
    const id = randomUUID();
    const view = this.#createView();
    const tab: TabRecord = {
      id,
      view,
      title: "New tab",
      url: "about:blank",
      faviconUrl: null,
      loading: false,
      crashed: false,
      error: null,
      agentInspectionId: null,
      agentRefs: new Set<string>(),
    };
    this.#tabs.set(id, tab);
    this.#wireTab(tab);
    view.webContents.setBackgroundThrottling(true);
    this.#window.contentView.addChildView(view);
    view.setBounds(this.#effectiveViewBounds());
    view.setVisible(false);
    if (activate) this.#activate(tab);
    this.#emitSoon();
    return tab;
  }

  #configureSession(): void {
    this.#session.setDownloadPath(this.#downloadsDirectory);
    this.#session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    this.#session.setDevicePermissionHandler(() => false);
    this.#session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (!this.#visible || webContents === null || !this.#tabForContents(webContents)) return false;
      const origin = safeOrigin(requestingOrigin);
      if (origin === null || !isSecurePermissionOrigin(origin)) return false;
      const decision = this.#permissionDecisions.get(permissionKey(origin, permission));
      return decision?.decision === "allow";
    });
    this.#session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const tab = this.#tabForContents(webContents);
      const origin = requestOrigin(details.requestingUrl, webContents.getURL());
      if (!this.#visible || tab === undefined || origin === null || !isSecurePermissionOrigin(origin) || BLOCKED_PERMISSION_TYPES.has(permission) || !ASKABLE_PERMISSION_TYPES.has(permission)) {
        callback(false);
        this.#onNotice?.({ type: "permission-blocked", tabId: tab?.id ?? "unknown", permission, origin: origin ?? "unknown" });
        return;
      }
      const remembered = this.#permissionDecisions.get(permissionKey(origin, permission));
      if (remembered !== undefined) {
        callback(remembered.decision === "allow");
        return;
      }
      const id = randomUUID();
      const state: BrowserPermissionRequestState = {
        id,
        tabId: tab.id,
        permission,
        origin,
        requestingUrl: details.requestingUrl,
        requestedAt: new Date().toISOString(),
      };
      const expires = setTimeout(() => {
        const pending = this.#pendingPermissions.get(id);
        if (pending === undefined) return;
        this.#pendingPermissions.delete(id);
        pending.callback(false);
        this.#onNotice?.({ type: "permission-expired", requestId: id });
        this.#emitSoon();
      }, 30_000);
      expires.unref();
      this.#pendingPermissions.set(id, { state, callback: onceCallback(callback), expires });
      this.#emitSoon();
    });
    this.#session.on("will-download", this.#willDownloadListener);
    this.#session.on("select-hid-device", this.#selectHidDeviceListener);
    this.#session.on("select-serial-port", this.#selectSerialPortListener);
    this.#session.on("select-usb-device", this.#selectUsbDeviceListener);
  }

  #wireTab(tab: TabRecord): void {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler((details) => {
      if (!isAllowedPopupUrl(details.url)) {
        this.#onNotice?.({ type: "blocked-popup", tabId: tab.id, url: details.url });
        return { action: "deny" };
      }
      return {
        action: "allow",
        outlivesOpener: true,
        createWindow: () => this.#addTab(details.disposition !== "background-tab").view.webContents,
      };
    });
    contents.on("will-frame-navigate", (event) => {
      if (!event.isMainFrame && !isAllowedWebUrl(event.url)) event.preventDefault();
    });
    contents.on("will-navigate", (event, url) => this.#guardNavigation(event, tab, url));
    contents.on("will-redirect", (event, url) => this.#guardNavigation(event, tab, url));
    contents.on("did-start-loading", () => {
      this.#clearAgentRefs(tab);
      tab.loading = true;
      tab.crashed = false;
      tab.error = null;
      this.#emitSoon();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      tab.url = contents.getURL() || tab.url;
      this.#emitSoon();
    });
    contents.on("did-navigate", (_event, url) => {
      tab.url = url;
      tab.error = null;
      this.#emitSoon();
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) {
        tab.url = url;
        this.#clearAgentRefs(tab);
      }
      this.#emitSoon();
    });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = boundedText(title, 240) || hostnameTitle(tab.url);
      this.#emitSoon();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      tab.faviconUrl = favicons.find(isAllowedWebUrl) ?? null;
      this.#emitSoon();
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      tab.loading = false;
      tab.url = validatedUrl || tab.url;
      tab.error = boundedText(errorDescription, 500) || `Navigation failed (${errorCode})`;
      this.#emitSoon();
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.loading = false;
      tab.crashed = true;
      tab.error = `Browser tab stopped (${details.reason})`;
      this.#emitSoon();
    });
    contents.on("certificate-error", (event, _url, _error, _certificate, callback) => {
      event.preventDefault();
      callback(false);
    });
    contents.on("login", (event, _authenticationResponseDetails, _authInfo, callback) => {
      event.preventDefault();
      callback();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("select-bluetooth-device", (event, _devices, callback) => {
      event.preventDefault();
      callback("");
    });
    contents.on("before-input-event", (event, input) => this.#handleBrowserShortcut(event, input, tab));
    contents.on("context-menu", (_event, params) => this.#showContextMenu(tab, params));
  }

  #guardNavigation(event: Event, tab: TabRecord, url: string): void {
    if (isAllowedWebUrl(url)) return;
    event.preventDefault();
    this.#onNotice?.({ type: "blocked-navigation", tabId: tab.id, url });
  }

  #handleBrowserShortcut(event: Event, input: Input, tab: TabRecord): void {
    if (input.type !== "keyDown") return;
    const accelerator = input.control || input.meta;
    if (accelerator && input.key.toLowerCase() === "l") {
      event.preventDefault();
      this.#onNotice?.({ type: "focus-address", tabId: tab.id });
      return;
    }
    if (accelerator && input.key.toLowerCase() === "t") {
      event.preventDefault();
      void this.createTab({}, true);
      return;
    }
    if (accelerator && input.key.toLowerCase() === "r") {
      event.preventDefault();
      tab.view.webContents.reload();
      return;
    }
    if (accelerator && input.key.toLowerCase() === "w") {
      event.preventDefault();
      void this.closeTab(tab.id);
      return;
    }
    if (input.alt && input.key === "ArrowLeft") {
      event.preventDefault();
      this.goBack(tab.id);
      return;
    }
    if (input.alt && input.key === "ArrowRight") {
      event.preventDefault();
      this.goForward(tab.id);
    }
  }

  #showContextMenu(tab: TabRecord, params: ContextMenuParams): void {
    const contents = tab.view.webContents;
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.linkURL !== "" && isAllowedWebUrl(params.linkURL)) {
      template.push({ label: "Open link in new tab", click: () => { void this.createTab({ url: params.linkURL }, true); } });
      template.push({ type: "separator" });
    }
    if (params.isEditable) {
      template.push(
        { role: "undo", enabled: params.editFlags.canUndo },
        { role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
      );
    } else if (params.selectionText !== "") {
      template.push({ role: "copy", enabled: params.editFlags.canCopy });
    }
    if (template.length > 0 && template.at(-1)?.type !== "separator") template.push({ type: "separator" });
    template.push({ label: "Back", enabled: contents.navigationHistory.canGoBack(), click: () => this.goBack(tab.id) });
    template.push({ label: "Forward", enabled: contents.navigationHistory.canGoForward(), click: () => this.goForward(tab.id) });
    template.push({ label: "Reload", click: () => this.reload(tab.id) });
    Menu.buildFromTemplate(template).popup({ window: this.#window });
  }

  #onDownload(item: DownloadItem, webContents: WebContents): void {
    const id = randomUUID();
    const tabId = this.#tabForContents(webContents)?.id ?? null;
    const record: DownloadRecord = {
      item,
      updatedListener: null,
      doneListener: null,
      state: {
        id,
        tabId,
        filename: boundedText(item.getFilename(), 512),
        url: item.getURL(),
        savePath: item.getSavePath() || null,
        mimeType: item.getMimeType(),
        receivedBytes: 0,
        totalBytes: Math.max(0, item.getTotalBytes()),
        bytesPerSecond: 0,
        paused: false,
        state: "progressing",
        startedAt: new Date().toISOString(),
        finishedAt: null,
      },
    };
    this.#downloads.set(id, record);
    this.#idleLifecycle.setDownloadsActive(true);
    this.#trimDownloadHistory();
    const onUpdated = (): void => this.#updateDownload(record);
    const onDone = (_event: Event, state: BrowserDownloadState): void => {
      this.#updateDownload(record, state);
      this.#detachDownloadListeners(record);
      record.item = null;
      this.#trimDownloadHistory();
      this.#idleLifecycle.setDownloadsActive(this.#hasActiveDownloads());
      this.#onNotice?.({ type: "download-finished", downloadId: id, state });
    };
    record.updatedListener = onUpdated;
    record.doneListener = onDone;
    item.on("updated", onUpdated);
    item.on("done", onDone);
    this.#onNotice?.({ type: "download-started", downloadId: id });
    this.#emitSoon();
  }

  #updateDownload(record: DownloadRecord, terminalState?: BrowserDownloadState): void {
    const item = record.item;
    if (item === null) return;
    record.state = {
      ...record.state,
      savePath: item.getSavePath() || record.state.savePath,
      receivedBytes: Math.max(0, item.getReceivedBytes()),
      totalBytes: Math.max(0, item.getTotalBytes()),
      bytesPerSecond: Math.max(0, item.getCurrentBytesPerSecond()),
      paused: item.isPaused(),
      state: terminalState ?? item.getState(),
      finishedAt: terminalState === undefined ? record.state.finishedAt : new Date().toISOString(),
    };
    this.#emitSoon();
  }

  #activate(tab: TabRecord): void {
    this.#activeTabId = tab.id;
    this.#enableBrowserThrottling();
    this.#syncTabVisibility();
    tab.view.setBounds(this.#effectiveViewBounds());
    if (!this.#overlayBusy()) {
      this.#window.contentView.addChildView(tab.view);
      if (this.#visible) tab.view.webContents.focus();
    }
  }

  #syncTabVisibility(): void {
    const visibleTabId = this.#overlayCaptureTabId ?? this.#activeTabId;
    for (const tab of this.#tabs.values()) tab.view.setVisible(this.#visible && !this.#overlayOpen && tab.id === visibleTabId);
  }

  #restoreActiveTab(): void {
    const tab = this.#activeTabId === null ? undefined : this.#tabs.get(this.#activeTabId);
    if (tab !== undefined && this.#visible) this.#window.contentView.addChildView(tab.view);
    this.#syncTabVisibility();
  }

  #overlayBusy(): boolean {
    return this.#overlayOpen || this.#overlayCaptureTabId !== null;
  }

  #tabState(tab: TabRecord): BrowserTabState {
    const history = tab.view.webContents.navigationHistory;
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      faviconUrl: tab.faviconUrl,
      loading: tab.loading,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      crashed: tab.crashed,
      error: tab.error,
    };
  }

  #tab(tabId: string): TabRecord {
    this.#assertAvailable();
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) throw new Error("Browser tab does not exist");
    return tab;
  }

  #agentTab(tabId?: string): TabRecord {
    const resolvedId = tabId ?? this.#activeTabId;
    if (resolvedId === null || resolvedId === undefined) throw new Error("The browser session has no active tab");
    const tab = this.#tab(resolvedId);
    if (tab.view.webContents.isDestroyed()) throw new Error("The browser tab is no longer available");
    return tab;
  }

  #agentTabForRef(ref: string, tabId?: string): TabRecord {
    if (!/^tq:[0-9a-f-]{36}:\d{1,4}$/i.test(ref)) throw new Error("Browser element reference is invalid");
    const tab = this.#agentTab(tabId);
    if (tab.agentInspectionId === null || !tab.agentRefs.has(ref)) {
      throw new Error("Browser element reference is stale; inspect the page again");
    }
    return tab;
  }

  #clearAgentRefs(tab: TabRecord): void {
    tab.agentInspectionId = null;
    tab.agentRefs.clear();
  }

  #effectiveViewBounds(): Rectangle {
    return this.#agentActive && (this.#bounds.width < 1 || this.#bounds.height < 1)
      ? { ...AGENT_VIEWPORT }
      : { ...this.#bounds };
  }

  #tabForContents(contents: WebContents): TabRecord | undefined {
    for (const tab of this.#tabs.values()) if (tab.view.webContents === contents) return tab;
    return undefined;
  }

  #download(downloadId: string): DownloadRecord {
    this.#assertAvailable();
    const download = this.#downloads.get(downloadId);
    if (download === undefined) throw new Error("Browser download does not exist");
    return download;
  }

  #trimDownloadHistory(): void {
    if (this.#downloads.size <= MAX_DOWNLOAD_HISTORY) return;
    for (const [id, record] of this.#downloads) {
      if (this.#downloads.size <= MAX_DOWNLOAD_HISTORY) break;
      if (record.state.state !== "progressing") this.#downloads.delete(id);
    }
  }

  async #restoreSession(sessionId: string | undefined): Promise<void> {
    const snapshot = sessionId === undefined ? undefined : this.#takeSessionSnapshot(sessionId);
    if (snapshot === undefined || snapshot.tabs.length === 0) {
      await this.createTab({ url: this.#initialUrl }, true);
      return;
    }
    for (let index = 0; index < snapshot.tabs.length; index += 1) {
      const source = snapshot.tabs[index]!;
      const tab = this.#addTab(index === snapshot.activeIndex);
      tab.title = source.title;
      tab.faviconUrl = source.faviconUrl;
      try {
        await tab.view.webContents.loadURL(normalizeRestorableUrl(source.url, this.#initialUrl));
      } catch (error: unknown) {
        if (!tab.view.webContents.isDestroyed()) {
          tab.loading = false;
          tab.error = errorMessage(error);
        }
      }
    }
    if (this.#activeTabId === null && this.#tabs.size > 0) this.#activate(this.#tabs.values().next().value!);
  }

  #snapshotActiveSession(): void {
    if (this.#activeSessionId === null || this.#tabs.size === 0) return;
    const tabs = [...this.#tabs.values()];
    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === this.#activeTabId));
    this.#sessionSnapshots.delete(this.#activeSessionId);
    this.#sessionSnapshots.set(this.#activeSessionId, {
      tabs: tabs.map((tab) => ({ url: normalizeRestorableUrl(tab.url, this.#initialUrl), title: tab.title, faviconUrl: tab.faviconUrl })),
      activeIndex,
    });
    while (this.#sessionSnapshots.size > MAX_SESSION_SNAPSHOTS) {
      const oldest = this.#sessionSnapshots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#sessionSnapshots.delete(oldest);
    }
  }

  #touchSessionSnapshot(sessionId: string): void {
    const snapshot = this.#sessionSnapshots.get(sessionId);
    if (snapshot === undefined) return;
    this.#sessionSnapshots.delete(sessionId);
    this.#sessionSnapshots.set(sessionId, snapshot);
  }

  #takeSessionSnapshot(sessionId: string): BrowserSessionSnapshot | undefined {
    const snapshot = this.#sessionSnapshots.get(sessionId);
    if (snapshot !== undefined) this.#touchSessionSnapshot(sessionId);
    return snapshot;
  }

  async #suspendInactiveBrowser(): Promise<boolean> {
    if (this.#disposed || this.#visible || this.#hasActiveDownloads()) return false;
    this.#snapshotActiveSession();
    this.#rejectPendingPermissions();
    this.#closeAllTabs();
    const closing = this.#session.closeAllConnections();
    this.#suspendPromise = closing.then(() => undefined, () => undefined);
    let closed = true;
    try {
      await closing;
    } catch {
      closed = false;
    } finally {
      this.#suspendPromise = undefined;
    }
    this.#emitSoon();
    return closed;
  }

  #hasActiveDownloads(): boolean {
    return [...this.#downloads.values()].some((download) => download.state.state === "progressing");
  }

  #detachDownloadListeners(record: DownloadRecord): void {
    const item = record.item;
    if (item !== null && record.updatedListener !== null) item.removeListener("updated", record.updatedListener);
    if (item !== null && record.doneListener !== null) item.removeListener("done", record.doneListener);
    record.updatedListener = null;
    record.doneListener = null;
  }

  #enableBrowserThrottling(): void {
    for (const tab of this.#tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setBackgroundThrottling(true);
    }
  }

  #closeAllTabs(): void {
    ++this.#overlayGeneration;
    this.#overlayOpen = false;
    this.#overlayCaptureTabId = null;
    for (const tab of this.#tabs.values()) {
      this.#window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    }
    this.#tabs.clear();
    this.#activeTabId = null;
  }

  #trimPermissionHistory(): void {
    while (this.#permissionDecisions.size > MAX_PERMISSION_HISTORY) {
      const first = this.#permissionDecisions.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.#permissionDecisions.delete(first);
    }
  }

  #rejectPendingPermissions(): void {
    for (const pending of this.#pendingPermissions.values()) {
      clearTimeout(pending.expires);
      pending.callback(false);
    }
    this.#pendingPermissions.clear();
  }

  #emitSoon(): void {
    if (this.#disposed || this.#emitQueued) return;
    this.#emitQueued = true;
    queueMicrotask(() => {
      this.#emitQueued = false;
      if (!this.#disposed) this.#onState(this.getState());
    });
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new Error("Browser workspace is disposed");
  }
}

interface AgentInspectionPayload {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly textTruncated: boolean;
  readonly elements: readonly BrowserAgentElement[];
  readonly elementsTruncated: boolean;
}

interface AgentActionPayload {
  readonly ok?: boolean;
  readonly error?: string;
  readonly url?: string;
  readonly value?: string;
}

interface AgentScrollPayload {
  readonly url?: string;
  readonly scrollX?: number;
  readonly scrollY?: number;
  readonly documentHeight?: number;
  readonly viewportHeight?: number;
}

function scriptCall(fn: { toString(): string }, ...args: readonly unknown[]): string {
  return `(${fn.toString()})(${args.map((value) => JSON.stringify(value)).join(",")})`;
}

function inspectPageForAgent(inspectionId: string, maximumElements: number, maximumText: number, maximumLabel: number): AgentInspectionPayload {
  const refAttribute = "data-tethoq-agent-ref";
  const bounded = (value: string, maximum: number): string => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
  const visible = (element: Element): boolean => {
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  };
  const roleFor = (element: Element): string => {
    const explicit = bounded(element.getAttribute("role") ?? "", 80);
    if (explicit !== "") return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "summary") return "button";
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "radio") return "radio";
      if (element.type === "button" || element.type === "submit" || element.type === "reset") return "button";
      return "textbox";
    }
    return element.getAttribute("contenteditable") === "true" ? "textbox" : tag;
  };
  const nameFor = (element: Element): string => {
    const aria = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
    if (aria.trim() !== "") return bounded(aria, maximumLabel);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const labelText = [...element.labels ?? []].map((label) => label.innerText).join(" ");
      const candidate = labelText || element.placeholder || (element.type === "password" ? "" : element.value) || element.name;
      return bounded(candidate, maximumLabel);
    }
    if (element instanceof HTMLSelectElement) {
      const selected = element.selectedOptions.item(0)?.textContent ?? "";
      return bounded(selected || element.name, maximumLabel);
    }
    return bounded(element.textContent ?? "", maximumLabel);
  };
  const hrefFor = (element: Element): string | undefined => {
    const raw = element.getAttribute("href");
    if (raw === null) return undefined;
    try {
      const href = new URL(raw, location.href);
      return href.protocol === "http:" || href.protocol === "https:" ? href.href.slice(0, 2_000) : undefined;
    } catch {
      return undefined;
    }
  };

  for (const element of document.querySelectorAll(`[${refAttribute}]`)) element.removeAttribute(refAttribute);
  const elements: BrowserAgentElement[] = [];
  const root = document.body ?? document.documentElement;
  const interactive = "a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable=true],[role=button],[role=link],[role=checkbox],[role=radio],[role=menuitem],[role=option],[role=switch],[role=tab],[role=textbox]";
  const elementWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let scannedElements = 0;
  let elementsTruncated = false;
  while (elementWalker.nextNode()) {
    scannedElements += 1;
    if (scannedElements > 5_000) {
      elementsTruncated = true;
      break;
    }
    const element = elementWalker.currentNode as Element;
    if (!element.matches(interactive) || !visible(element)) continue;
    if (elements.length >= maximumElements) {
      elementsTruncated = true;
      break;
    }
    const ref = `tq:${inspectionId}:${elements.length + 1}`;
    element.setAttribute(refAttribute, ref);
    const type = element instanceof HTMLInputElement ? bounded(element.type, 40) : undefined;
    const value = element instanceof HTMLInputElement && element.type !== "password"
      ? bounded(element.value, maximumLabel)
      : element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? bounded(element.value, maximumLabel)
        : undefined;
    const href = hrefFor(element);
    elements.push({
      ref,
      role: roleFor(element),
      name: nameFor(element),
      tag: element.tagName.toLowerCase(),
      ...(type === undefined ? {} : { type }),
      ...(value === undefined ? {} : { value }),
      ...(href === undefined ? {} : { href }),
    });
  }

  const chunks: string[] = [];
  let textLength = 0;
  let scannedTextNodes = 0;
  let textTruncated = false;
  const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (textWalker.nextNode()) {
    scannedTextNodes += 1;
    if (scannedTextNodes > 5_000) {
      textTruncated = true;
      break;
    }
    const parent = textWalker.currentNode.parentElement;
    if (parent === null || !visible(parent) || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
    const chunk = bounded(textWalker.currentNode.textContent ?? "", Math.min(maximumLabel, maximumText - textLength));
    if (chunk === "") continue;
    if (textLength + chunk.length + 1 > maximumText) {
      textTruncated = true;
      break;
    }
    chunks.push(chunk);
    textLength += chunk.length + 1;
  }
  return {
    title: bounded(document.title, 240),
    url: location.href,
    text: chunks.join("\n"),
    textTruncated,
    elements,
    elementsTruncated,
  };
}

function clickElementForAgent(ref: string): AgentActionPayload {
  const candidates = document.querySelectorAll("[data-tethoq-agent-ref]");
  const element = [...candidates].find((candidate) => candidate.getAttribute("data-tethoq-agent-ref") === ref);
  if (!(element instanceof HTMLElement)) return { ok: false, error: "missing" };
  const style = getComputedStyle(element);
  const bounds = element.getBoundingClientRect();
  if (style.display === "none" || style.visibility === "hidden" || bounds.width <= 0 || bounds.height <= 0) return { ok: false, error: "hidden" };
  if (("disabled" in element && Boolean(element.disabled)) || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "disabled" };
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.focus({ preventScroll: true });
  element.click();
  return { ok: true, url: location.href };
}

function typeIntoElementForAgent(ref: string, text: string, submit: boolean): AgentActionPayload {
  const candidates = document.querySelectorAll("[data-tethoq-agent-ref]");
  const element = [...candidates].find((candidate) => candidate.getAttribute("data-tethoq-agent-ref") === ref);
  if (!(element instanceof HTMLElement)) return { ok: false, error: "missing" };
  if (("disabled" in element && Boolean(element.disabled)) || ("readOnly" in element && Boolean(element.readOnly))) return { ok: false, error: "disabled" };
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.focus({ preventScroll: true });
  let value = text;
  let form: HTMLFormElement | null = null;
  if (element instanceof HTMLSelectElement) {
    const option = [...element.options].find((candidate) => candidate.value === text || candidate.text.trim() === text.trim());
    if (option === undefined) return { ok: false, error: "option" };
    element.value = option.value;
    value = element.value;
    form = element.form;
  } else if (element instanceof HTMLInputElement) {
    if (["button", "checkbox", "file", "hidden", "image", "password", "radio", "reset", "submit"].includes(element.type)) return { ok: false, error: "unsupported" };
    value = element.maxLength > 0 ? text.slice(0, element.maxLength) : text;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) element.value = value;
    else setter.call(element, value);
    form = element.form;
  } else if (element instanceof HTMLTextAreaElement) {
    value = element.maxLength > 0 ? text.slice(0, element.maxLength) : text;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter === undefined) element.value = value;
    else setter.call(element, value);
    form = element.form;
  } else if (element.getAttribute("contenteditable") === "true") {
    element.textContent = text;
    value = element.textContent ?? "";
  } else {
    return { ok: false, error: "unsupported" };
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  if (submit && form !== null) form.requestSubmit();
  return { ok: true, url: location.href, value: value.slice(0, 500) };
}

function scrollPageForAgent(deltaX: number, deltaY: number): AgentScrollPayload {
  window.scrollBy({ left: deltaX, top: deltaY, behavior: "instant" });
  return {
    url: location.href,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    documentHeight: Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight),
    viewportHeight: window.innerHeight,
  };
}

function normalizeAgentElement(element: BrowserAgentElement): BrowserAgentElement {
  const base = {
    ref: boundedText(element.ref, 80),
    role: boundedText(element.role, 80) || "control",
    name: boundedText(element.name, MAX_AGENT_LABEL),
    tag: boundedText(element.tag, 40),
  };
  const type = typeof element.type === "string" ? boundedText(element.type, 40) : undefined;
  const value = typeof element.value === "string" ? boundedText(element.value, MAX_AGENT_LABEL) : undefined;
  const href = typeof element.href === "string" && isAllowedWebUrl(element.href) ? element.href.slice(0, 2_000) : undefined;
  return {
    ...base,
    ...(type === undefined ? {} : { type }),
    ...(value === undefined ? {} : { value }),
    ...(href === undefined ? {} : { href }),
  };
}

function currentAgentUrl(tab: TabRecord, reported: string | undefined): string {
  if (reported !== undefined && isAllowedWebUrl(reported)) return reported;
  const current = tab.view.webContents.getURL();
  return isAllowedWebUrl(current) ? current : tab.url;
}

function agentActionError(code: string | undefined): string {
  if (code === "hidden") return "Browser element is no longer visible; inspect the page again";
  if (code === "disabled") return "Browser element is disabled or read-only";
  if (code === "unsupported") return "Browser text entry supports text fields, text areas, select boxes, and editable regions only";
  if (code === "option") return "Browser select option was not found; inspect the page again";
  return "Browser element reference is stale; inspect the page again";
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function boundedAgentScrollDelta(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || Math.abs(value) > MAX_AGENT_SCROLL_DELTA) {
    throw new Error(`Browser scroll delta must be an integer from -${MAX_AGENT_SCROLL_DELTA} to ${MAX_AGENT_SCROLL_DELTA}`);
  }
  return value;
}

export function normalizeNavigationInput(value: string): string {
  const input = value.trim();
  if (input.length === 0) return DEFAULT_BROWSER_URL;
  if (input.length > MAX_NAVIGATION_INPUT || input.includes("\0")) throw new Error("Browser address is invalid");
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (!isAllowedWebUrl(url.href)) throw new Error("Only http and https pages can be opened");
    return url.href;
  }
  if (looksLikeHost(input)) {
    const url = new URL(`https://${input}`);
    if (!isAllowedWebUrl(url.href)) throw new Error("Browser address is invalid");
    return url.href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) throw new Error("Only http and https pages can be opened");
  return `${SEARCH_ENDPOINT}${encodeURIComponent(input)}`;
}

export function isAllowedWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeBounds(bounds: Rectangle): Rectangle {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Browser bounds are invalid");
  return {
    x: Math.max(0, Math.trunc(bounds.x)),
    y: Math.max(0, Math.trunc(bounds.y)),
    width: Math.max(0, Math.trunc(bounds.width)),
    height: Math.max(0, Math.trunc(bounds.height)),
  };
}

function requestOrigin(requestingUrl: string, fallbackUrl: string): string | null {
  return safeOrigin(requestingUrl) ?? safeOrigin(fallbackUrl);
}

function safeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!isAllowedWebUrl(url.href)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isSecurePermissionOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"));
}

function permissionKey(origin: string, permission: string): string {
  return `${origin}\n${permission}`;
}

function onceCallback(callback: (allowed: boolean) => void): (allowed: boolean) => void {
  let called = false;
  return (allowed) => {
    if (called) return;
    called = true;
    callback(allowed);
  };
}

function boundedText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

function hostnameTitle(value: string): string {
  try {
    return new URL(value).hostname || "New tab";
  } catch {
    return "New tab";
  }
}

function looksLikeHost(value: string): boolean {
  const firstSegment = value.split(/[/?#]/, 1)[0] ?? "";
  const withoutPort = firstSegment.replace(/:\d{1,5}$/, "");
  if (withoutPort.includes("@")) return false;
  return withoutPort === "localhost"
    || (withoutPort.includes(".") && !withoutPort.includes(":"))
    || /^\[[0-9a-f:]+\](?::\d+)?$/i.test(firstSegment)
    || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(firstSegment);
}

function isAllowedPopupUrl(value: string): boolean {
  return value === "about:blank" || isAllowedWebUrl(value);
}

function normalizeRestorableUrl(value: string, fallback: string): string {
  return isAllowedWebUrl(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : String(error), 500);
}
