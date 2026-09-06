import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const toolsSource = async () => await readFile(new URL("../src/main/browser_agent_tools.ts", import.meta.url), "utf8");
const workspaceSource = async () => await readFile(new URL("../src/main/browser_workspace.ts", import.meta.url), "utf8");

function loadAgentTools(code) {
  const transformed = ts.transpileModule(`${code}\n;globalThis.__browserAgentTools = { BrowserAgentTools, browserToolDefinitions };`, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
  const sandbox = {};
  vm.runInNewContext(transformed.replace(/^export\s+/gm, ""), sandbox);
  return sandbox.__browserAgentTools;
}

function tab(id = "tab-1") {
  return {
    id,
    title: "Example",
    url: "https://example.com/",
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    error: null,
    muted: false,
    audible: false,
  };
}

function state(tabs = [tab()]) {
  return {
    partition: "persist:tethoq-browser",
    profile: { persistent: true, appOwned: true, importsSystemProfile: false, clearing: false },
    visible: false,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    activeTabId: tabs[0]?.id ?? null,
    tabs,
    downloads: [{ id: "download-1", tabId: tabs[0]?.id ?? null, filename: "page.pdf", url: "https://example.com/page.pdf", savePath: null, mimeType: "application/pdf", receivedBytes: 1, totalBytes: 2, bytesPerSecond: 0, paused: false, state: "progressing", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null }],
    pendingPermissions: [{ id: "permission-1", tabId: tabs[0]?.id ?? null, permission: "notifications", origin: "https://example.com", requestingUrl: "https://example.com/", requestedAt: "2026-01-01T00:00:00.000Z" }],
    permissionDecisions: [{ origin: "https://example.com", permission: "notifications", decision: "deny" }],
  };
}

test("provider-neutral browser tools expose only bounded semantic operations", async () => {
  const { browserToolDefinitions } = loadAgentTools(await toolsSource());
  const names = [...browserToolDefinitions].map(({ name }) => name);

  assert.deepEqual(names, [
    "browser_get_state", "browser_open", "browser_navigate", "browser_inspect",
    "browser_inspect_all", "browser_click", "browser_type", "browser_scroll",
    "browser_capture", "browser_activate", "browser_close", "browser_back",
    "browser_forward", "browser_reload", "browser_stop", "browser_set_muted",
  ]);
  for (const definition of browserToolDefinitions) {
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal("javascript" in definition.inputSchema.properties, false);
    assert.equal("selector" in definition.inputSchema.properties, false);
  }
});

test("browser tool executor scopes activity to the parent session and always releases it", async () => {
  const { BrowserAgentTools } = loadAgentTools(await toolsSource());
  const calls = [];
  const workspace = {
    getState: () => state(),
    prepareAgentSession: async (sessionId, materialize) => { calls.push(["prepare", sessionId, materialize]); return state(); },
    finishAgentActivity: () => calls.push(["finish"]),
    createTab: async (input, activate) => { calls.push(["create", input?.url, activate]); return tab("opened"); },
    navigate: async () => tab(),
    inspectForAgent: async () => ({ tabId: "tab-1", title: "Example", url: "https://example.com/", text: "", textTruncated: false, elements: [], elementsTruncated: false }),
    clickForAgent: async () => ({ tabId: "tab-1", url: "https://example.com/" }),
    typeForAgent: async () => ({ tabId: "tab-1", url: "https://example.com/" }),
    scrollForAgent: async () => ({ tabId: "tab-1", url: "https://example.com/" }),
    captureForAgent: async () => ({
      kind: "browser_screenshot", tabId: "tab-1", title: "Example", url: "https://example.com/", width: 800, height: 600,
      attachment: { name: "browser-page.jpg", mimeType: "image/jpeg", dataBase64: "AQID", byteLength: 3 },
    }),
  };
  const tools = new BrowserAgentTools(workspace);
  const result = await tools.execute("parent-session", "browser_open", { url_or_search: "example.com" });

  assert.equal(JSON.parse(JSON.stringify(result)).tab_id, "opened");
  const lifecycle = JSON.parse(JSON.stringify(await tools.execute("parent-session", "browser_get_state", {})));
  assert.equal(lifecycle.downloads[0].filename, "page.pdf");
  assert.equal(lifecycle.pending_permissions[0].permission, "notifications");
  assert.equal(lifecycle.permission_decisions[0].decision, "deny");
  assert.deepEqual(calls, [
    ["prepare", "parent-session", false], ["create", "example.com", false], ["finish"],
    ["prepare", "parent-session", true], ["finish"],
  ]);
  await assert.rejects(
    tools.execute("parent-session", "browser_click", { ref: "tq:00000000-0000-0000-0000-000000000000:1", selector: "body" }),
    /Unexpected browser tool field: selector/,
  );
  assert.deepEqual(calls.at(-1), ["finish"]);
});

test("browser agents can inspect every tab and control lifecycle and audio without raw selectors", async () => {
  const { BrowserAgentTools } = loadAgentTools(await toolsSource());
  const controls = [];
  const workspace = {
    getState: () => state([tab("second")]),
    prepareAgentSession: async () => state([tab("second")]),
    finishAgentActivity: () => {},
    inspectAllForAgent: async (options) => {
      controls.push(["inspect_all", options]);
      return { activeTabId: "second", tabs: [], textTruncated: false, tabsTruncated: false };
    },
    activateTab: (tabId) => controls.push(["activate", tabId]) && tab(tabId),
    closeTab: async (tabId) => { controls.push(["close", tabId]); return state(); },
    goBack: (tabId) => controls.push(["back", tabId]) && tab(tabId),
    goForward: (tabId) => controls.push(["forward", tabId]) && tab(tabId),
    reload: (tabId) => controls.push(["reload", tabId]) && tab(tabId),
    stop: (tabId) => controls.push(["stop", tabId]) && tab(tabId),
    setMuted: (tabId, muted) => controls.push(["muted", tabId, muted]) && tab(tabId),
  };
  const tools = new BrowserAgentTools(workspace);

  await tools.execute("parent", "browser_inspect_all", { max_text_per_tab: 500 });
  await tools.execute("parent", "browser_activate", { tab_id: "second" });
  await tools.execute("parent", "browser_close", { tab_id: "second" });
  await tools.execute("parent", "browser_set_muted", { tab_id: "second", muted: true });

  assert.deepEqual(JSON.parse(JSON.stringify(controls)), [
    ["inspect_all", { maxTextPerTab: 500 }],
    ["activate", "second"],
    ["close", "second"],
    ["muted", "second", true],
  ]);
  await assert.rejects(
    tools.execute("parent", "browser_back", { selector: "history" }),
    /Unexpected browser tool field: selector/,
  );
});

test("browser state includes a bounded semantic snapshot of the active page", async () => {
  const { BrowserAgentTools } = loadAgentTools(await toolsSource());
  const workspace = {
    getState: () => state(),
    prepareAgentSession: async () => state(),
    finishAgentActivity: () => {},
    inspectForAgent: async () => ({
      tabId: "tab-1",
      title: "Example",
      url: "https://example.com/",
      text: "Account settings",
      textTruncated: false,
      elements: [{ ref: "tq:00000000-0000-0000-0000-000000000000:1", role: "button", name: "Save", tag: "button" }],
      elementsTruncated: false,
    }),
  };
  const result = JSON.parse(JSON.stringify(await new BrowserAgentTools(workspace).execute("parent", "browser_get_state", {})));

  assert.equal(result.active_tab_id, "tab-1");
  assert.equal(result.active_page.text, "Account settings");
  assert.equal(result.active_page.elements[0].name, "Save");
  assert.equal(result.active_page_error, null);
});

test("capture handler receives a bridge-ready bounded image attachment instead of leaking base64 to the model", async () => {
  const { BrowserAgentTools } = loadAgentTools(await toolsSource());
  let received;
  const capture = {
    kind: "browser_screenshot", tabId: "tab-1", title: "Example", url: "https://example.com/", width: 800, height: 600,
    attachment: { name: "browser-page.jpg", mimeType: "image/jpeg", dataBase64: "AQID", byteLength: 3 },
  };
  const workspace = {
    getState: () => state(),
    prepareAgentSession: async () => state(),
    finishAgentActivity: () => {},
    createTab: async () => tab(),
    navigate: async () => tab(),
    inspectForAgent: async () => ({}),
    clickForAgent: async () => ({}),
    typeForAgent: async () => ({}),
    scrollForAgent: async () => ({}),
    captureForAgent: async () => capture,
  };
  const tools = new BrowserAgentTools(workspace, {
    onCapture: async (parentSessionId, image, question) => {
      received = { parentSessionId, image, question };
      return { answer: "visible answer" };
    },
  });
  const result = await tools.execute("parent-session", "browser_capture", { question: "What is selected?" });

  assert.equal(JSON.parse(JSON.stringify(result)).answer, "visible answer");
  assert.equal(received.image.attachment.mimeType, "image/jpeg");
  assert.equal(received.image.attachment.byteLength, 3);
  assert.equal(received.question, "What is selected?");
});

test("browser workspace keeps model input out of executable code and invalidates semantic refs", async () => {
  const code = await workspaceSource();

  assert.match(code, /scriptCall\(inspectPageForAgent/);
  assert.match(code, /scriptCall\(clickElementForAgent, ref\)/);
  assert.match(code, /args\.map\(\(value\) => JSON\.stringify\(value\)\)/);
  assert.match(code, /agentRefs\.has\(ref\)/);
  assert.match(code, /#clearAgentRefs\(tab\)/);
  assert.match(code, /MAX_AGENT_ELEMENTS\s*=\s*120/);
  assert.match(code, /MAX_AGENT_CAPTURE_BYTES\s*=\s*900_000/);
  assert.match(code, /MAX_AGENT_ALL_TEXT\s*=\s*60_000/);
  assert.match(code, /public setMuted\(tabId: string, muted: boolean\): BrowserTabState/);
  assert.match(code, /setAudioMuted\(muted\)/);
  assert.match(code, /public async inspectAllForAgent\(/);
  assert.match(code, /try \{[^]*?await this\.#inspectAgentPage\([^]*?\} catch \(error: unknown\) \{[^]*?pageError: boundedText\(message, 500\)/);
  assert.match(code, /pageError: boundedText\(message, 500\)/);
  assert.match(code, /audio-state-changed/);
  assert.match(code, /isAudioMuted\(\)/);
  assert.match(code, /isCurrentlyAudible\(\)/);
  assert.doesNotMatch(code, /media-started-playing|media-paused/);
  assert.match(code, /"file", "hidden", "image", "password"/);
  assert.doesNotMatch(code, /executeJavaScript\([^]*?\$\{ref\}/);
});
