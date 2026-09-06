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
const destination = { ...source, id: "handoff-side", sessionKind: "side_chat", parentSessionId: source.id, providerSessionId: "side", relationship: { kind: "side_chat", sourceSessionId: source.id, strategy: "transcript_bootstrap" } };
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
let receiveEvents;
let sequence = 0;
const privateEcho = "[[TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1]]\nPRIVATE_TRANSCRIPT_SECRET\n[[TETHOQ_BRANCH_USER_REQUEST_V1]]\nSide chat!";
let sideMessages = [];
const envelope = (payload) => ({ ok: true, payload });
const remove = () => undefined;
window.tethoqDesktop = {
  request: async (type, payload = {}) => {
    if (type === "sessions.list") return envelope({ sessions: [source, ...(switches.length ? [destination] : [])] });
    if (type === "models.list") {
      const codex = payload.providerId === "codex";
      return envelope({ models: [{ id: codex ? source.modelId : destination.modelId, providerId: payload.providerId, displayName: codex ? "6 Astra" : "DeepSeek V4 Pro", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: [codex ? "medium" : "high"], defaultReasoningEffort: codex ? "medium" : "high" } }] });
    }
    if (type === "session.open") {
      const session = payload.sessionId === destination.id ? destination : source;
      return envelope({ session, messages: session.id === destination.id ? sideMessages : messages, nextCursor: null });
    }
    if (type === "side_chat.create") { switches.push(structuredClone(payload)); return envelope({ session: destination }); }
    if (type === "session.send_message") { sends.push(structuredClone(payload)); await waitFor(() => window.__finishHandoffSend, "send acknowledgement"); return envelope({ accepted: true }); }
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
  notifyReady: remove, onEventBatch: (listener) => { receiveEvents = listener; return remove; }, onRuntimeState: () => remove,
  browserState: async () => browser, browserAction: async () => browser,
  recorderState: async () => recorder, recorderAction: async (action) => action.type === "list" ? [] : recorder,
  localOpenHandlers: async () => ({ defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] }),
  onPreferencesState: () => remove, onBrowserState: () => remove, onBrowserNotice: () => remove, onRecorderState: () => remove, onRecorderEvent: () => remove,
  selectImages: async () => [], selectFiles: async () => [], connectorAction: async () => bootstrap,
};

const emit = (type, payload) => {
  const event = { eventId: crypto.randomUUID(), sequence: ++sequence, hostId: source.hostId, sessionId: destination.id, providerId: source.providerId, type, occurredAt: new Date().toISOString(), payload };
  receiveEvents({ events: [event], latestSequence: sequence, replayGap: false });
};

try {
  const { default: App } = await import("../../src/renderer/src/App");
  const host = document.createElement("div"); host.id = "root"; document.body.append(host);
  createRoot(host).render(<App />);
  (await waitFor(() => document.querySelector('[data-session-id="codex-source"] > .session-row'), "source task")).click();
  await waitFor(() => document.body.textContent.includes("The README heading is updated."), "source history");
  document.querySelector('button[aria-label="More message actions"]').click();
  (await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].find((button) => button.textContent.includes("Context Handoff")), "handoff action")).click();
  (await waitFor(() => document.querySelector('button[aria-label="Prepare context handoff"]'), "handoff picker")).click();
  await waitFor(() => sends.length, "handoff send");
  const panel = await waitFor(() => document.querySelector('.side-chat-panel'), "visible handoff side chat");
  const transcript = panel.querySelector('.side-chat-transcript');
  check(switches.length === 1 && sends.length === 1, "Handoff created or sent more than once");
  check(sends[0].sessionId === destination.id, "Handoff request went to the parent task");
  check(transcript.textContent.includes("Create a context handoff prompt"), "The real prompt was not shown before the send acknowledgement");
  check(!document.body.textContent.includes("TETHOQ_BRANCH"), "Private metadata reached the transcript");
  const marker = document.querySelector('.timeline-handoff');
  const precedingFooter = marker.previousElementSibling.querySelector('.message-footer');
  check(precedingFooter, "Handoff notice did not follow an assistant footer");
  check(marker.getBoundingClientRect().top - precedingFooter.getBoundingClientRect().bottom >= 8, "Assistant hover controls overlap the handoff notice");
  window.__finishHandoffSend = true;
  await waitFor(() => !document.querySelector('.handoff-chat-picker'), "handoff picker dismissal");
  emit("message.completed", { role: "user", messageId: "handoff-prompt", text: sends[0].content });
  emit("message.delta", { role: "user", messageId: "legacy-echo", text: privateEcho.split("[[TETHOQ_BRANCH_USER_REQUEST_V1]]")[0] });
  await frame();
  check(!transcript.textContent.includes("PRIVATE_TRANSCRIPT_SECRET"), "Partial metadata flashed while streaming");
  emit("message.completed", { role: "user", messageId: "legacy-echo", text: privateEcho });
  emit("message.completed", { role: "assistant", messageId: "handoff-result", phase: "final_answer", text: "Pickup prompt: Continue the README work and keep the heading short." });
  emit("agent.completed", {});
  await waitFor(() => transcript.textContent.includes("Pickup prompt:"), "model result in the side chat");
  check(!transcript.textContent.includes("PRIVATE_TRANSCRIPT_SECRET") && !transcript.textContent.includes("TETHOQ_BRANCH"), "Completed private context reached the user");
  const users = [...transcript.querySelectorAll('.message-user')];
  check(users.length === 2, `Unexpected visible user rows: ${JSON.stringify(users.map((row) => row.textContent.slice(0, 90)))}`);
  for (const row of users) {
    const footer = row.querySelector('.message-footer');
    const next = row.nextElementSibling;
    if (footer && next) check(next.getBoundingClientRect().top - footer.getBoundingClientRect().bottom >= 8, "Side-chat hover controls overlap the next message");
  }
  const lastFooter = transcript.querySelector('.message-assistant .message-footer');
  transcript.scrollTop = transcript.scrollHeight;
  await frame();
  check(lastFooter.getBoundingClientRect().bottom <= transcript.getBoundingClientRect().bottom - 4, "Last hover controls clip against the composer");
  let copied;
  window.tethoqDesktop.copyText = async (text) => { copied = text; return true; };
  users[1].querySelector('.copy-message').click();
  await waitFor(() => copied, "copy visible prompt");
  check(copied === "Side chat!", "Copy included private metadata");
  users[1].querySelector('.copy-message').focus();
  window.__contextHandoffReady = true;
  await waitFor(() => window.__contextHandoffContinue, "screenshot checkpoint");
  window.__contextHandoffResult = { ok: true };
} catch (error) {
  window.__contextHandoffResult = { ok: false, error: error instanceof Error ? error.stack : String(error) };
}
