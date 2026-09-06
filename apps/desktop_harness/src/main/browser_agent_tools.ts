import type { ClientToolDefinition } from "../../../../packages/provider_contract/src/index.js";
import type { JsonObject, JsonValue } from "../../../../packages/protocol/src/index.js";
import type {
  BrowserAgentActionResult,
  BrowserAgentPageSnapshot,
  BrowserAgentScreenshot,
  BrowserAgentWorkspaceSnapshot,
  BrowserTabState,
  BrowserWorkspaceManager,
  BrowserWorkspaceState,
} from "./browser_workspace.js";

const MAX_TOOL_STRING = 20_000;
const MAX_QUESTION = 2_000;
const BROWSER_TOOL_NAMES = new Set([
  "browser_get_state", "browser_open", "browser_navigate", "browser_inspect",
  "browser_inspect_all", "browser_click", "browser_type", "browser_scroll",
  "browser_capture", "browser_activate", "browser_close", "browser_back",
  "browser_forward", "browser_reload", "browser_stop", "browser_set_muted",
]);

export const browserToolDefinitions: readonly ClientToolDefinition[] = [
  {
    name: "browser_get_state",
    description: "Read this session's isolated Tethoq browser lifecycle state plus a bounded semantic snapshot of the active page. Use browser_inspect_all only when content from every tab is needed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open",
    description: "Open an HTTP(S) address or web search in a new background tab without changing the user's selected tab.",
    inputSchema: {
      type: "object",
      properties: {
        url_or_search: { type: "string", minLength: 1, maxLength: 8192, description: "An HTTP(S) URL, hostname, or search query." },
        activate: { type: "boolean", default: false, description: "Prefer false. True switches the user's visible browser tab to the new page." },
      },
      required: ["url_or_search"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate the active browser tab, or a specified tab, to an HTTP(S) address or web search.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: "Optional tab ID from browser_get_state." },
        url_or_search: { type: "string", minLength: 1, maxLength: 8192, description: "An HTTP(S) URL, hostname, or search query." },
      },
      required: ["url_or_search"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_inspect",
    description: "Read bounded visible page text and semantic references for every visible link, button, field, and other actionable control. Inspect again after navigation or major page changes.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: "Optional tab ID from browser_get_state." } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_inspect_all",
    description: "Read bounded visible text and semantic controls from every browser tab. Use browser_get_state for lightweight lifecycle/audio state and this when the task needs cross-tab page content.",
    inputSchema: {
      type: "object",
      properties: {
        max_text_per_tab: { type: "integer", minimum: 250, maximum: MAX_TOOL_STRING, default: 2500, description: "Visible-text limit per tab. The whole result is additionally bounded." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: "Click one visible page control by the semantic reference returned by browser_inspect. Arbitrary selectors and scripts are not accepted.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: "Optional tab ID from browser_get_state." },
        ref: { type: "string", description: "A semantic element reference returned by browser_inspect." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description: "Replace the contents of a referenced text field, text area, select box, or editable region. Password and file fields are intentionally unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: "Optional tab ID from browser_get_state." },
        ref: { type: "string", description: "A semantic element reference returned by browser_inspect." },
        text: { type: "string", maxLength: MAX_TOOL_STRING, description: "Text to enter, or an exact option label/value for a select box." },
        submit: { type: "boolean", default: false, description: "Submit the containing form after entering text." },
      },
      required: ["ref", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the current page by bounded horizontal and vertical pixel deltas, then return the new scroll position.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: "Optional tab ID from browser_get_state." },
        delta_x: { type: "integer", minimum: -4000, maximum: 4000, default: 0 },
        delta_y: { type: "integer", minimum: -4000, maximum: 4000, default: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_capture",
    description: "Capture a bounded screenshot of the active page. When visual support is configured, the host routes it to that model and returns only the visual answer.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: "Optional tab ID from browser_get_state." },
        question: { type: "string", minLength: 1, maxLength: MAX_QUESTION, description: "Optional focused question for the visual-support model." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_activate",
    description: "Make a specified browser tab the active tab.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: "Tab ID from browser_get_state." } },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_close",
    description: "Close a specified browser tab.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: "Tab ID from browser_get_state." } },
      required: ["tab_id"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_back",
    description: "Go back in a browser tab's history.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: "Optional tab ID from browser_get_state." } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_forward",
    description: "Go forward in a browser tab's history.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: "Optional tab ID from browser_get_state." } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_reload",
    description: "Reload a browser tab.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: "Optional tab ID from browser_get_state." } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_stop",
    description: "Stop loading a browser tab.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: "Optional tab ID from browser_get_state." } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_set_muted",
    description: "Mute or unmute audio for a browser tab.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: "Optional tab ID from browser_get_state." },
        muted: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
] as const;

export interface BrowserAgentWorkspace {
  getState(): BrowserWorkspaceState;
  prepareAgentSession(sessionId: string, materializeTab?: boolean): Promise<BrowserWorkspaceState>;
  finishAgentActivity(): void;
  createTab(input?: { readonly url?: string }, activate?: boolean): Promise<BrowserTabState>;
  navigate(tabId: string, input: string): Promise<BrowserTabState>;
  inspectForAgent(tabId?: string): Promise<BrowserAgentPageSnapshot>;
  clickForAgent(ref: string, tabId?: string): Promise<BrowserAgentActionResult>;
  typeForAgent(ref: string, text: string, submit?: boolean, tabId?: string): Promise<BrowserAgentActionResult>;
  scrollForAgent(deltaX: number, deltaY: number, tabId?: string): Promise<BrowserAgentActionResult>;
  captureForAgent(tabId?: string): Promise<BrowserAgentScreenshot>;
  activateTab(tabId: string): BrowserTabState;
  closeTab(tabId: string): Promise<BrowserWorkspaceState>;
  goBack(tabId: string): BrowserTabState;
  goForward(tabId: string): BrowserTabState;
  reload(tabId: string): BrowserTabState;
  stop(tabId: string): BrowserTabState;
  setMuted(tabId: string, muted: boolean): BrowserTabState;
  inspectAllForAgent(options?: { readonly maxTextPerTab?: number }): Promise<BrowserAgentWorkspaceSnapshot>;
}

export type BrowserAgentCaptureHandler = (
  parentSessionId: string,
  capture: BrowserAgentScreenshot,
  question: string,
) => Promise<JsonValue>;

export interface BrowserAgentToolsOptions {
  readonly onCapture?: BrowserAgentCaptureHandler;
}

/**
 * Provider-neutral executor suitable for composing into MeshToolGateway's
 * executor. Operations are serialized so two providers cannot switch the one
 * native browser workspace between sessions mid-action.
 */
export class BrowserAgentTools {
  readonly #workspace: BrowserAgentWorkspace;
  readonly #onCapture: BrowserAgentCaptureHandler | undefined;
  #tail: Promise<void> = Promise.resolve();

  public constructor(workspace: BrowserWorkspaceManager | BrowserAgentWorkspace, options: BrowserAgentToolsOptions = {}) {
    this.#workspace = workspace;
    this.#onCapture = options.onCapture;
  }

  public execute(parentSessionId: string, tool: string, input: JsonObject): Promise<JsonValue> {
    const operation = this.#tail.then(async () => await this.#executeNow(parentSessionId, tool, input));
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #executeNow(parentSessionId: string, tool: string, input: JsonObject): Promise<JsonValue> {
    if (!BROWSER_TOOL_NAMES.has(tool)) throw new Error(`Unsupported browser tool: ${boundedErrorText(tool)}`);
    const materializeTab = tool !== "browser_open";
    await this.#workspace.prepareAgentSession(parentSessionId, materializeTab);
    try {
      if (tool === "browser_get_state") {
        assertKnownKeys(input, []);
        const state = this.#workspace.getState();
        if (state.activeTabId === null) return stateJson(state, null, null);
        try {
          const activePage = await this.#workspace.inspectForAgent(state.activeTabId);
          return stateJson(this.#workspace.getState(), activePage, null);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "The active page could not be inspected";
          return stateJson(this.#workspace.getState(), null, boundedErrorText(message));
        }
      }
      if (tool === "browser_open") {
        assertKnownKeys(input, ["url_or_search", "activate"]);
        const tab = await this.#workspace.createTab(
          { url: requiredString(input, "url_or_search", 8_192) },
          optionalBoolean(input, "activate") ?? false,
        );
        return tabJson(tab);
      }
      if (tool === "browser_navigate") {
        assertKnownKeys(input, ["tab_id", "url_or_search"]);
        const state = this.#workspace.getState();
        const tabId = optionalString(input, "tab_id", 100) ?? requireActiveTab(state);
        return tabJson(await this.#workspace.navigate(tabId, requiredString(input, "url_or_search", 8_192)));
      }
      if (tool === "browser_inspect") {
        assertKnownKeys(input, ["tab_id"]);
        return jsonValue(await this.#workspace.inspectForAgent(optionalString(input, "tab_id", 100)));
      }
      if (tool === "browser_inspect_all") {
        assertKnownKeys(input, ["max_text_per_tab"]);
        const maxTextPerTab = optionalInteger(input, "max_text_per_tab");
        return jsonValue(await this.#workspace.inspectAllForAgent(maxTextPerTab === undefined ? {} : { maxTextPerTab }));
      }
      if (tool === "browser_click") {
        assertKnownKeys(input, ["tab_id", "ref"]);
        return jsonValue(await this.#workspace.clickForAgent(requiredString(input, "ref", 100), optionalString(input, "tab_id", 100)));
      }
      if (tool === "browser_type") {
        assertKnownKeys(input, ["tab_id", "ref", "text", "submit"]);
        return jsonValue(await this.#workspace.typeForAgent(
          requiredString(input, "ref", 100),
          requiredString(input, "text", MAX_TOOL_STRING, true),
          optionalBoolean(input, "submit") ?? false,
          optionalString(input, "tab_id", 100),
        ));
      }
      if (tool === "browser_scroll") {
        assertKnownKeys(input, ["tab_id", "delta_x", "delta_y"]);
        return jsonValue(await this.#workspace.scrollForAgent(
          optionalInteger(input, "delta_x") ?? 0,
          optionalInteger(input, "delta_y") ?? 0,
          optionalString(input, "tab_id", 100),
        ));
      }
      if (tool === "browser_capture") {
        assertKnownKeys(input, ["tab_id", "question"]);
        const capture = await this.#workspace.captureForAgent(optionalString(input, "tab_id", 100));
        const question = optionalString(input, "question", MAX_QUESTION)
          ?? "Describe the visible page and answer what is most important for the current task.";
        if (this.#onCapture !== undefined) return await this.#onCapture(parentSessionId, capture, question);
        return jsonValue(capture);
      }
      if (tool === "browser_activate") {
        assertKnownKeys(input, ["tab_id"]);
        return tabJson(this.#workspace.activateTab(requiredString(input, "tab_id", 100)));
      }
      if (tool === "browser_close") {
        assertKnownKeys(input, ["tab_id"]);
        await this.#workspace.closeTab(requiredString(input, "tab_id", 100));
        return stateJson(this.#workspace.getState());
      }
      if (["browser_back", "browser_forward", "browser_reload", "browser_stop"].includes(tool)) {
        assertKnownKeys(input, ["tab_id"]);
        const state = this.#workspace.getState();
        const tabId = optionalString(input, "tab_id", 100) ?? requireActiveTab(state);
        if (tool === "browser_back") return tabJson(this.#workspace.goBack(tabId));
        if (tool === "browser_forward") return tabJson(this.#workspace.goForward(tabId));
        if (tool === "browser_reload") return tabJson(this.#workspace.reload(tabId));
        return tabJson(this.#workspace.stop(tabId));
      }
      if (tool === "browser_set_muted") {
        assertKnownKeys(input, ["tab_id", "muted"]);
        const state = this.#workspace.getState();
        const tabId = optionalString(input, "tab_id", 100) ?? requireActiveTab(state);
        return tabJson(this.#workspace.setMuted(tabId, optionalBoolean(input, "muted") ?? true));
      }
      throw new Error("Unsupported browser tool");
    } finally {
      this.#workspace.finishAgentActivity();
    }
  }
}

function stateJson(
  state: BrowserWorkspaceState,
  activePage?: BrowserAgentPageSnapshot | null,
  activePageError?: string | null,
): JsonValue {
  const result: JsonObject = {
    active_tab_id: state.activeTabId,
    visible: state.visible,
    tabs: state.tabs.map((tab) => tabJsonObject(tab)),
    downloads: state.downloads.map((download) => ({
      id: download.id,
      tab_id: download.tabId,
      filename: download.filename,
      url: download.url,
      state: download.state,
      mime_type: download.mimeType,
      received_bytes: download.receivedBytes,
      total_bytes: download.totalBytes,
      bytes_per_second: download.bytesPerSecond,
      paused: download.paused,
      started_at: download.startedAt,
      finished_at: download.finishedAt,
    })),
    pending_permissions: state.pendingPermissions.map((permission) => ({
      id: permission.id,
      tab_id: permission.tabId,
      permission: permission.permission,
      origin: permission.origin,
      requesting_url: permission.requestingUrl,
      requested_at: permission.requestedAt,
    })),
    permission_decisions: state.permissionDecisions.map((decision) => ({ ...decision })),
  };
  if (activePage !== undefined) result.active_page = activePage === null ? null : jsonValue(activePage);
  if (activePageError !== undefined) result.active_page_error = activePageError;
  return result;
}

function tabJson(tab: BrowserTabState): JsonValue {
  return tabJsonObject(tab);
}

function tabJsonObject(tab: BrowserTabState): JsonObject {
  return {
    tab_id: tab.id,
    title: tab.title,
    url: tab.url,
    loading: tab.loading,
    can_go_back: tab.canGoBack,
    can_go_forward: tab.canGoForward,
    crashed: tab.crashed,
    error: tab.error,
    muted: tab.muted,
    audible: tab.audible,
  };
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function requireActiveTab(state: BrowserWorkspaceState): string {
  if (state.activeTabId === null) throw new Error("The browser session has no active tab; open one first");
  return state.activeTabId;
}

function assertKnownKeys(input: JsonObject, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`Unexpected browser tool field: ${boundedErrorText(unknown)}`);
}

function requiredString(input: JsonObject, key: string, maximum: number, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maximum || value.includes("\0")) {
    throw new Error(`Browser tool field ${key} is invalid`);
  }
  return value;
}

function optionalString(input: JsonObject, key: string, maximum: number): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`Browser tool field ${key} is invalid`);
  }
  return value;
}

function optionalBoolean(input: JsonObject, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Browser tool field ${key} must be a boolean`);
  return value;
}

function optionalInteger(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Browser tool field ${key} must be an integer`);
  return value;
}

function boundedErrorText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 100);
}
