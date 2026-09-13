import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/src/styles.css";
import "../../src/renderer/src/navigation.css";
import "../../src/renderer/src/workflow-settings.css";
import "../../src/renderer/src/live-session.css";

const check = (value, message) => { if (!value) throw new Error(message); };
async function waitFor(read, label) {
  const end = performance.now() + 10_000;
  while (performance.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(label + " timed out");
}
const native = window.qaBrowser;
const { url } = await native.inspect();
const stamp = "2026-09-08T12:00:00.000Z";
const source = { id: "browser-source", hostId: "browser-qa", providerId: "codex", providerSessionId: "source", title: "Browser link checks", project: "qa", workingDirectory: "C:\\qa", state: "idle", createdAt: stamp, lastActivityAt: stamp, modelId: "gpt-6-astra", reasoningEffort: "medium", needsApproval: false, stale: false, nativeMetadata: {} };
const messages = [{ id: "answer", sessionId: source.id, providerMessageId: "answer", role: "assistant", createdAt: stamp, status: "completed", parts: [{ type: "text", text: `[Read documentation](${url}/docs)` }], nativeMetadata: { phase: "final_answer" } }];
const providers = [{ providerId: "codex", displayName: "Codex", state: "online", detected: true, authenticated: true, nativeVersion: "qa", capabilities: { sendMessage: true, sessionHistory: true }, metadata: {} }];
const bootstrap = { app: { name: "Tethoq", version: "qa", platform: "win32", packaged: false }, host: { id: "browser-qa", displayName: "QA", platform: "windows", connectionState: "online", protocolVersion: 1, lastSeenAt: stamp }, providers, allowedProviders: ["codex"], connectors: { directory: "C:\\qa", loaded: [], pending: [], diagnostics: [] }, latestSequence: 0, openCode: { state: "external", url: "http://127.0.0.1:4096/", managed: false } };
const recorder = { phase: "idle", supported: false, privacy: { limitations: [] } };
const remove = () => undefined;
const envelope = payload => ({ ok: true, payload });
window.tethoqDesktop = {
  ...native,
  request: async (type, payload = {}) => {
    if (type === "sessions.list") return envelope({ sessions: [source] });
    if (type === "models.list") return envelope({ models: [{ id: source.modelId, providerId: "codex", displayName: "Astra", isDefault: true, nativeMetadata: {} }] });
    if (type === "session.open") return envelope({ session: source, messages, nextCursor: null });
    if (type === "session.vision.get") return envelope({ vision: { sessionId: source.id, primaryModelSupportsImageInput: true, configured: null } });
    return envelope({ messages: [], sessions: [], tasks: [], approvals: [], requests: [], targets: [], goal: null });
  },
  bootstrap: async () => bootstrap, notifyReady: remove, onEventBatch: () => remove, onRuntimeState: () => remove,
  recorderState: async () => recorder, recorderAction: async action => action.type === "list" ? [] : recorder,
  onRecorderState: () => remove, onRecorderEvent: () => remove,
  localOpenHandlers: async () => ({ defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] }),
  selectImages: async () => [], selectFiles: async () => [],
};

try {
  const { default: App } = await import("../../src/renderer/src/App");
  const host = document.createElement("div"); host.id = "root"; document.body.append(host);
  const root = createRoot(host);
  root.render(<App />);
  (await waitFor(() => document.querySelector('[data-session-id="browser-source"] > .session-row'), "task row")).click();
  const link = () => document.querySelector('.message-body a[href$="/docs"]');
  (await waitFor(link, "chat link")).click();
  await waitFor(async () => (await native.inspect()).external.length === 1, "external open");
  let state = await native.inspect();
  check(state.external[0] === url + "/docs" && state.browser.tabs.length === 0, "default links must reach the system browser without creating Chromium tabs");
  check(document.getElementById("composer-message") && !document.querySelector(".browser-page"), "default link navigation left the chat");

  const draft = "Keep my unsent message";
  const field = document.getElementById("composer-message");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, draft);
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: draft }));
  document.querySelector('[aria-label="Open settings"]').click();
  const toggle = await waitFor(() => document.querySelector('[role="switch"][aria-label="Open links in app"]'), "browser setting");
  toggle.closest("details").querySelector("summary").click();
  check(toggle.getAttribute("aria-checked") === "false", "new setting must default off");
  await new Promise(requestAnimationFrame);
  toggle.scrollIntoView({ block: "center" });
  await waitFor(() => { const bounds = toggle.getBoundingClientRect(); return bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= window.innerHeight; }, "visible browser setting");
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  await native.capture("settings-off");
  toggle.click();
  await waitFor(() => toggle.getAttribute("aria-checked") === "true", "saved opt-in");
  state = await native.inspect();
  check(state.persisted.openLinksInApp === true && state.persisted.alerts === "attention", "opt-in must survive reload and preserve other preferences");
  document.querySelector('.settings-close-button').click();
  (await waitFor(link, "return to chat")).click();
  await waitFor(() => document.querySelector('.browser-page [role="tab"]'), "in-app browser");
  await waitFor(async () => (await native.inspect()).browser.tabs.some(tab => tab.url === url + "/docs"), "in-app page navigation");
  state = await native.inspect();
  check(state.external.length === 1, "opt-in also opened the system browser");
  await native.browserAction({ type: "create-tab", input: url + "/second", activate: true });
  await waitFor(() => document.querySelectorAll('.browser-page [role="tab"]').length === 2, "second tab");
  document.querySelector('.browser-tab-action[aria-label^="Close "]').click();
  await waitFor(() => document.querySelectorAll('.browser-page [role="tab"]').length === 1, "one tab remains");
  check(document.querySelector(".browser-page"), "closing one of multiple tabs must keep the remaining page open");
  document.querySelector('.browser-tab-action[aria-label^="Close "]').click();
  await waitFor(() => !document.querySelector(".browser-page") && document.getElementById("composer-message"), "last tab returns to chat");
  check((await native.inspect()).browser.tabs.length === 0, "last close recreated a tab");
  check(document.getElementById("composer-message").value === draft, "closing the browser lost the draft");
  await native.capture("returned-to-chat");

  link().click();
  await waitFor(() => document.querySelector('.browser-page [role="tab"]'), "reopened browser");
  await waitFor(async () => (await native.inspect()).browser.tabs.some(tab => tab.url === url + "/docs" && tab.title === "Browser QA" && !tab.loading), "page ready for keyboard input");
  await native.closeWithKeyboard();
  await waitFor(() => !document.querySelector(".browser-page") && document.getElementById("composer-message"), "Ctrl W returns to chat");
  document.querySelector('[aria-label="Open settings"]').click();
  const disable = await waitFor(() => document.querySelector('[aria-label="Open links in app"]'), "setting after reopen");
  disable.closest("details").open = true; disable.click();
  await waitFor(() => disable.getAttribute("aria-checked") === "false", "disable opt-in");
  document.querySelector('.settings-close-button').click();
  (await waitFor(link, "chat after disabling")).click();
  await waitFor(async () => (await native.inspect()).external.length === 2, "external links after disabling");
  check(!(await native.inspect()).persisted.openLinksInApp, "disabling did not persist");
  root.unmount();
  window.__browserLinksResult = { ok: true };
} catch (error) {
  window.__browserLinksResult = { ok: false, error: error.stack || String(error) };
}
