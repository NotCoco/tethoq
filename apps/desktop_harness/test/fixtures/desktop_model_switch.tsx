import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/navigation.css";
import "../../src/renderer/src/live-session.css";

window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
const frame = () => new Promise((resolve) => setTimeout(resolve, 10));
async function waitFor(read, label) {
  const until = performance.now() + 10_000;
  while (performance.now() < until) {
    const value = read();
    if (value) return value;
    await frame();
  }
  throw new Error(`${label} timed out`);
}
const check = (condition, message) => { if (!condition) throw new Error(message); };
const stamp = "2026-09-06T12:00:00.000Z";
const source = { id: "codex-source", hostId: "switch-qa", providerId: "codex", providerSessionId: "source", title: "Existing task", project: "qa", workingDirectory: "C:\\qa", state: "idle", createdAt: stamp, lastActivityAt: stamp, modelId: "gpt-6-astra", reasoningEffort: "medium", needsApproval: false, stale: false, nativeMetadata: {} };
const destination = { ...source, id: "opencode-next", providerId: "opencode", providerSessionId: "next", modelId: "opencode-go/deepseek-v4-pro", reasoningEffort: "high", relationship: { kind: "model_switch", sourceSessionId: source.id, strategy: "summary_bootstrap" } };
const messages = [
  { id: "old-user", sessionId: source.id, providerMessageId: "old-user", role: "user", createdAt: stamp, status: "completed", parts: [{ type: "text", text: "Keep the heading short." }], nativeMetadata: {} },
  { id: "old-answer", sessionId: source.id, providerMessageId: "old-answer", role: "assistant", createdAt: stamp, status: "completed", parts: [{ type: "text", text: "The README heading is updated." }], nativeMetadata: {} },
];
const providers = ["codex", "opencode"].map((providerId) => ({ providerId, displayName: providerId === "codex" ? "Codex" : "OpenCode", state: "online", detected: true, authenticated: true, nativeVersion: "qa", capabilities: { createSession: true, sendMessage: true, sessionHistory: true, interrupt: true, attachments: true, imageAttachments: true }, metadata: {} }));
const bootstrap = { app: { name: "Tethoq", version: "qa", platform: "win32", packaged: false }, host: { id: "switch-qa", displayName: "QA", platform: "windows", connectionState: "online", protocolVersion: 1, lastSeenAt: stamp, relayConnected: false }, providers, allowedProviders: ["codex", "opencode"], connectors: { directory: "C:\\qa\\connectors", loaded: [], pending: [], diagnostics: [] }, latestSequence: 0, openCode: { state: "external", url: "http://127.0.0.1:4096/", managed: false, message: "QA" } };
let preferences = { version: 1, experimentalFeatures: false, reasoningDisplay: "compact", taskListMode: "recent", savedProjectDirectories: [], localOpenHandlerId: "system", closeAction: "tray", launchAtLogin: "off", alerts: "all", agentDefaults: {}, globalAgentsPath: null, taskOverrides: {}, allowForeignSubagents: false, foreignSubagentOverrides: {}, ears: { enabled: false, providerId: null, modelId: null, mode: "cleaned" } };
const browser = { partition: "persist:qa", profile: { persistent: true, appOwned: true, importsSystemProfile: false, clearing: false }, visible: false, bounds: { x: 0, y: 0, width: 800, height: 600 }, tabs: [], activeTabId: null, downloads: [], pendingPermissions: [], canGoBack: false, canGoForward: false };
const recorder = { phase: "idle", supported: true, privacy: { localOnly: true, neverUploadedAutomatically: true, capturesScreen: true, capturesGlobalInput: true, capturesKeyCodesNotText: true, sensitiveDataPossible: true, warning: "QA", limitations: [] } };
const switches = [], sends = [];
const envelope = (payload) => ({ ok: true, payload });
const remove = () => undefined;
window.tethoqDesktop = {
  request: async (type, payload = {}) => {
    if (type === "sessions.list") return envelope({ sessions: [switches.length ? destination : source] });
    if (type === "models.list") {
      const codex = payload.providerId === "codex";
      return envelope({ models: [{ id: codex ? source.modelId : destination.modelId, providerId: payload.providerId, displayName: codex ? "6 Astra" : "DeepSeek V4 Pro", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: [codex ? "medium" : "high"], defaultReasoningEffort: codex ? "medium" : "high" } }] });
    }
    if (type === "session.open") {
      const session = payload.sessionId === destination.id ? destination : source;
      return envelope({ session, messages: messages.map((message) => ({ ...message, id: session.id + ":" + message.id, sessionId: session.id })), nextCursor: null });
    }
    if (type === "session.switch_model") { switches.push(structuredClone(payload)); await waitFor(() => window.__finishSwitch, "switch response"); return envelope({ session: destination }); }
    if (type === "session.send_message") { sends.push(structuredClone(payload)); return envelope({ accepted: true }); }
    if (type === "message_queue.list") return envelope({ messages: [] });
    if (type === "side_chat.list") return envelope({ sessions: [] });
    if (type === "approval.list") return envelope({ approvals: [] });
    if (type === "user_input.list") return envelope({ requests: [] });
    if (type === "scheduled_task.list") return envelope({ tasks: [] });
    if (type === "session.goal.get") return envelope({ goal: null });
    if (type === "session.vision.get") return envelope({ vision: { sessionId: payload.sessionId, primaryModelSupportsImageInput: true, configured: null } });
    if (type === "vision.targets") return envelope({ targets: [] });
    return envelope({});
  },
  bootstrap: async () => bootstrap, preferencesState: async () => preferences,
  preferencesAction: async (action) => {
    if (action.type === "move-task-override") preferences = { ...preferences, taskOverrides: { [action.toSessionId]: preferences.taskOverrides[action.fromSessionId] ?? {} } };
    return preferences;
  },
  notifyReady: remove, onEventBatch: () => remove, onRuntimeState: () => remove,
  browserState: async () => browser, browserAction: async () => browser,
  recorderState: async () => recorder, recorderAction: async (action) => action.type === "list" ? [] : recorder,
  localOpenHandlers: async () => ({ defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] }),
  onPreferencesState: () => remove, onBrowserState: () => remove, onBrowserNotice: () => remove, onRecorderState: () => remove, onRecorderEvent: () => remove,
  selectImages: async () => [], selectFiles: async () => [], connectorAction: async () => bootstrap,
};

try {
  const { default: App } = await import("../../src/renderer/src/App");
  const host = document.createElement("div"); host.id = "root"; document.body.append(host);
  createRoot(host).render(<App />);
  const row = await waitFor(() => document.querySelector('[data-session-id="codex-source"] > .session-row'), "source task");
  row.click();
  await waitFor(() => document.body.textContent.includes("The README heading is updated."), "source history");
  const field = await waitFor(() => document.getElementById("composer-message"), "composer");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, "Explain the next step.");
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Explain the next step." }));
  document.querySelector('button[aria-label^="Choose model. Current model:"]').click();
  const deepseek = await waitFor(() => [...document.querySelectorAll(".model-catalog-results button")].find((button) => button.textContent.includes("DeepSeek V4 Pro")), "DeepSeek model");
  check(!deepseek.disabled, "DeepSeek is disabled in the existing Codex task");
  deepseek.click();
  const notice = await waitFor(() => document.querySelector(".model-switch-notice"), "context warning");
  check(notice.title.includes("Some earlier details may be lost"), "the context-loss warning is missing");
  check(notice.getBoundingClientRect().width > 0, "the warning icon has no visible space");
  check(switches.length === 0 && sends.length === 0, "selecting a model changed the task before Send");
  check(document.getElementById("composer-message").value === "Explain the next step.", "choosing the model lost the draft");
  window.__modelSwitchReady = true;
  await waitFor(() => window.__modelSwitchContinue, "screenshot checkpoint");
  const send = document.querySelector(".send-button"); send.click(); send.click();
  await waitFor(() => switches.length === 1, "switch preparation");
  const dashboard = [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Dashboard");
  check(dashboard, "Dashboard navigation is missing");
  dashboard.click();
  await waitFor(() => !document.getElementById("composer-message"), "background navigation");
  window.__finishSwitch = true;
  await waitFor(() => sends.length === 1, "destination send");
  const continuedRow = await waitFor(() => document.querySelector('[data-session-id="opencode-next"] > .session-row'), "continued task");
  check(!document.getElementById("composer-message"), "the background send stole navigation");
  continuedRow.click();
  await waitFor(() => document.querySelector('[data-session-id="opencode-next"] > .session-row.selected'), "continued task selection");
  await waitFor(() => document.body.textContent.includes("The README heading is updated."), "retained history");
  check(switches.length === 1 && switches[0].sessionId === source.id && switches[0].providerId === "opencode", "switch did not use the selected destination once");
  check(sends[0].sessionId === destination.id && sends[0].modelId === destination.modelId && sends[0].reasoningEffort === "high", "the prompt used the old harness or selection");
  check(sends[0].content === "Explain the next step.", "the next prompt contains visible bootstrap text or lost the draft");
  check(document.body.textContent.includes("The README heading is updated."), "the previous conversation disappeared");
  check(!document.querySelector('[data-session-id="codex-source"]'), "the continued task duplicated in the sidebar");
  check(!document.querySelector(".model-switch-notice"), "a completed switch kept the pending warning");
  window.__modelSwitchResult = { ok: true };
} catch (error) {
  window.__modelSwitchResult = { ok: false, error: error.stack ?? String(error) };
}
