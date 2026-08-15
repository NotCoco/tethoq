import type { ClientToolDefinition } from "../../../../packages/provider_contract/src/index.js";
import type { JsonObject, JsonValue } from "../../../../packages/protocol/src/index.js";
import type {
  BrowserAgentActionResult,
  BrowserAgentPageSnapshot,
  BrowserAgentScreenshot,
  BrowserTabState,
  BrowserWorkspaceManager,
  BrowserWorkspaceState,
} from "./browser_workspace.js";

const MAX_TOOL_STRING = 20_000;
const MAX_QUESTION = 2_000;
const BROWSER_TOOL_NAMES = new Set([
  "browser_get_state", "browser_open", "browser_navigate", "browser_inspect",
  "browser_click", "browser_type", "browser_scroll", "browser_capture",
]);

export const browserToolDefinitions: readonly ClientToolDefinition[] = [
  {
    name: "browser_get_state",
    description: "List the tabs in this session's isolated Tethoq browser and identify the active tab.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_open",
    description: "Open an HTTP(S) address or web search in a new tab in this session's isolated Tethoq browser.",
    inputSchema: {
      type: "object",
      properties: {
        url_or_search: { type: "string", minLength: 1, maxLength: 8192, description: "An HTTP(S) URL, hostname, or search query." },
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
    description: "Read bounded visible page text and get semantic references for visible links, buttons, and fields. Inspect again after navigation or major page changes.",
    inputSchema: {
      type: "object",
      properties: { tab_id: { type: "string", description: "Optional tab ID from browser_get_state." } },
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
        return stateJson(this.#workspace.getState());
      }
      if (tool === "browser_open") {
        assertKnownKeys(input, ["url_or_search"]);
        const tab = await this.#workspace.createTab({ url: requiredString(input, "url_or_search", 8_192) }, true);
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
      throw new Error("Unsupported browser tool");
    } finally {
      this.#workspace.finishAgentActivity();
    }
  }
}

function stateJson(state: BrowserWorkspaceState): JsonValue {
  return {
    active_tab_id: state.activeTabId,
    visible: state.visible,
    tabs: state.tabs.map((tab) => tabJsonObject(tab)),
  };
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
