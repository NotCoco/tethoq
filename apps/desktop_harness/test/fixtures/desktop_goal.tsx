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
const messages = [
  { id: "old-user", sessionId: source.id, providerMessageId: "old-user", role: "user", createdAt: stamp, status: "completed", parts: [{ type: "text", text: "Keep the heading short." }], nativeMetadata: {} },
  { id: "old-answer", sessionId: source.id, providerMessageId: "old-answer", role: "assistant", createdAt: stamp, status: "completed", parts: [{ type: "text", text: "The README heading is updated." }], nativeMetadata: {} },
];
const providers = ["codex", "opencode"].map((providerId) => ({ providerId, displayName: providerId === "codex" ? "Codex" : "OpenCode", state: "online", detected: true, authenticated: true, nativeVersion: "qa", capabilities: { createSession: true, sendMessage: true, sessionHistory: true, interrupt: true, attachments: true, imageAttachments: true }, metadata: {} }));
const bootstrap = { app: { name: "Tethoq", version: "qa", platform: "win32", packaged: false }, host: { id: "switch-qa", displayName: "QA", platform: "windows", connectionState: "online", protocolVersion: 1, lastSeenAt: stamp, relayConnected: false }, providers, allowedProviders: ["codex", "opencode"], connectors: { directory: "C:\\qa\\connectors", loaded: [], pending: [], diagnostics: [] }, latestSequence: 0, openCode: { state: "external", url: "http://127.0.0.1:4096/", managed: false, message: "QA" } };
let preferences = { version: 1, experimentalFeatures: false, reasoningDisplay: "compact", taskListMode: "recent", savedProjectDirectories: [], localOpenHandlerId: "system", closeAction: "tray", launchAtLogin: "off", alerts: "all", agentDefaults: {}, globalAgentsPath: null, taskOverrides: {}, allowForeignSubagents: false, foreignSubagentOverrides: {}, ears: { enabled: false, providerId: null, modelId: null, mode: "cleaned" } };
const browser = { partition: "persist:qa", profile: { persistent: true, appOwned: true, importsSystemProfile: false, clearing: false }, visible: false, bounds: { x: 0, y: 0, width: 800, height: 600 }, tabs: [], activeTabId: null, downloads: [], pendingPermissions: [], canGoBack: false, canGoForward: false };
const recorder = { phase: "idle", supported: true, privacy: { localOnly: true, neverUploadedAutomatically: true, capturesScreen: true, capturesGlobalInput: true, capturesKeyCodesNotText: true, sensitiveDataPossible: true, warning: "QA", limitations: [] } };

const created = { ...source, id: "goal-new", providerSessionId: "new", title: "New goal task" };
const calls = [], sends = [], creations = [], goals = new Map(), history = new Map([[source.id, messages]]);
let receiveEvents, sequence = 0, rejectNext = true;
const remove = () => undefined;
const envelope = (payload) => ({ ok: true, payload });
const emit = (sessionId, type, payload) => receiveEvents({ events: [{ eventId: crypto.randomUUID(), sequence: ++sequence, hostId: source.hostId, sessionId, providerId: source.providerId, type, occurredAt: new Date().toISOString(), payload }], latestSequence: sequence, replayGap: false });
const message = (sessionId, id, role, text) => ({ id, sessionId, providerMessageId: id, role, createdAt: new Date().toISOString(), status: "completed", parts: [{ type: "text", text }], nativeMetadata: {} });
window.tethoqDesktop = {
  request: async (type, payload = {}) => {
    calls.push({ type, payload: structuredClone(payload) });
    if (type === "sessions.list") return envelope({ sessions: [source, ...(creations.length ? [created] : [])] });
    if (type === "models.list") return envelope({ models: [{ id: source.modelId, providerId: payload.providerId, displayName: "6 Astra", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" } }] });
    if (type === "session.open") return envelope({ session: payload.sessionId === created.id ? created : source, messages: history.get(payload.sessionId) ?? [], nextCursor: null });
    if (type === "session.create") { creations.push(structuredClone(payload)); return envelope({ session: created }); }
    if (type === "session.send_message") {
      sends.push(structuredClone(payload));
      if (rejectNext) { rejectNext = false; return { ok: false, payload: {}, error: { code: "DELIVERY_REJECTED", message: "Retry the goal", retryable: true } }; }
      if (payload.goal) {
        const goal = { sessionId: payload.sessionId, objective: payload.goal.objective, status: "active", source: "tethoq", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: stamp, updatedAt: stamp, revision: 1 };
        goals.set(payload.sessionId, goal);
        emit(payload.sessionId, "session.goal_updated", { goal });
      }
      const echo = message(payload.sessionId, "user-" + sends.length, "user", "<tethoq_response_guidance>\n<tethoq_task_goal>\nPRIVATE_GOAL_CONTROL\n</tethoq_task_goal>\n</tethoq_response_guidance>\n" + payload.content);
      const answer = message(payload.sessionId, "answer-" + sends.length, "assistant", "The documentation is ready.");
      answer.nativeMetadata.phase = "final_answer";
      history.set(payload.sessionId, [...(history.get(payload.sessionId) ?? []), echo, answer]);
      emit(payload.sessionId, "message.updated", { message: echo });
      setTimeout(() => {
        emit(payload.sessionId, "message.completed", { role: "assistant", messageId: answer.id, phase: "final_answer", text: "The documentation is ready." });
        emit(payload.sessionId, "session.status_changed", { state: "idle" });
      }, 0);
      return envelope({ accepted: true });
    }
    if (type === "message_queue.list") return envelope({ messages: [] });
    if (type === "side_chat.list") return envelope({ sessions: [] });
    if (type === "approval.list") return envelope({ approvals: [] });
    if (type === "user_input.list") return envelope({ requests: [] });
    if (type === "scheduled_task.list") return envelope({ tasks: [] });
    if (type === "session.goal.get") return envelope({ goal: goals.get(payload.sessionId) ?? null });
    if (type === "session.vision.get") return envelope({ vision: { sessionId: payload.sessionId, primaryModelSupportsImageInput: true, configured: null } });
    if (type === "vision.targets") return envelope({ targets: [] });
    return envelope({});
  },
  bootstrap: async () => bootstrap, preferencesState: async () => preferences, preferencesAction: async () => preferences,
  notifyReady: remove, onEventBatch: (listener) => { receiveEvents = listener; return remove; }, onRuntimeState: () => remove,
  browserState: async () => browser, browserAction: async () => browser,
  recorderState: async () => recorder, recorderAction: async (action) => action.type === "list" ? [] : recorder,
  localOpenHandlers: async () => ({ defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] }),
  onPreferencesState: () => remove, onBrowserState: () => remove, onBrowserNotice: () => remove, onRecorderState: () => remove, onRecorderEvent: () => remove,
  selectImages: async () => [], selectFiles: async () => [], connectorAction: async () => bootstrap,
};
const write = async (value) => {
  const field = document.getElementById("composer-message");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, value);
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  await frame();
};
const arm = async () => {
  document.querySelector('.composer-actions-menu > button').click();
  const action = await waitFor(() => [...document.querySelectorAll('.composer-actions-menu [role="menuitemcheckbox"]')].find((item) => item.textContent.includes("Goal")), "Goal action");
  action.click();
  await waitFor(() => document.querySelector('.composer-goal-indicator.is-armed'), "armed goal");
};
try {
  const { default: App } = await import("../../src/renderer/src/App");
  const host = document.createElement("div"); host.id = "root"; document.body.append(host);
  createRoot(host).render(<App />);
  (await waitFor(() => document.querySelector('[data-session-id="codex-source"] > .session-row'), "existing task")).click();
  await waitFor(() => document.getElementById("composer-message"), "composer");
  await write("Finish the documentation");
  await arm();
  check(!document.querySelector('.composer-goal-panel'), "Goal opened a separate objective form");
  check(document.querySelector('.composer-box .composer-goal-indicator'), "Goal activation is outside the composer");
  check(!calls.some(({ type }) => type === "session.goal.set") && sends.length === 0, "Arming goal prematurely activated or sent it");
  document.querySelector('button[aria-label="Cancel goal for next message"]').click();
  await frame();
  check(document.getElementById("composer-message").value === "Finish the documentation", "Cancel discarded the draft");
  await arm();
  window.__goalReady = true;
  await waitFor(() => window.__goalContinue, "screenshot checkpoint");
  document.querySelector('.send-button').click();
  await waitFor(() => sends.length === 1 && document.getElementById("composer-message").value === "Finish the documentation", "failed goal draft restoration");
  check(document.querySelector('.composer-goal-indicator.is-armed'), "Failed send lost goal mode");
  await frame();
  document.querySelector('.send-button').click();
  await waitFor(() => document.querySelector('.composer-current-goal'), "active goal indicator");
  check(sends.length === 2 && sends[1].goal.objective === sends[1].content && sends[1].content === "Finish the documentation", "Goal did not send the readable prompt and structured objective");
  check(!document.body.textContent.includes("PRIVATE_GOAL_CONTROL") && !document.body.textContent.includes("tethoq_task_goal"), "Private goal metadata leaked");
  const visibleUser = await waitFor(() => [...document.querySelectorAll('.conversation .message-user')].find((row) => row.textContent.includes("Finish the documentation")), "visible goal prompt");
  check([...document.querySelectorAll('.conversation .message-user')].filter((row) => row.textContent.includes("Finish the documentation")).length === 1, "Goal echo duplicated the real message");
  let copied;
  window.tethoqDesktop.copyText = async (text) => { copied = text; return true; };
  visibleUser.querySelector('.copy-message').click();
  await waitFor(() => copied, "copy prompt");
  check(copied === "Finish the documentation", "Copy exposed private goal context");
  for (const row of document.querySelectorAll('.conversation > .message, .conversation > .final-answer-block')) {
    const footer = row.querySelector('.message-footer'), next = row.nextElementSibling;
    if (footer && next) check(next.getBoundingClientRect().top - footer.getBoundingClientRect().bottom >= 8, "Main transcript footer overlaps its next row");
  }
  // Goal activation arrives before the response/idle events. Wait for the
  // completed turn before testing a direct follow-up; an earlier click is
  // correctly queued, and this fixture does not run the bridge's queue pump.
  await waitFor(() => document.querySelector('.conversation')?.textContent.includes("The documentation is ready.")
    && document.getElementById("composer-message")?.placeholder === "Continue this task…"
    && !document.querySelector('.send-button')?.classList.contains('stop-button'), "completed goal response");
  const activeGoal = goals.get(source.id);
  for (const [status, label] of [["blocked", "Goal stalled"], ["complete", "Goal complete"]]) {
    const terminalGoal = { ...activeGoal, status, revision: ++sequence };
    goals.set(source.id, terminalGoal);
    emit(source.id, "session.goal_updated", { goal: terminalGoal });
    await waitFor(() => document.querySelector('.composer-current-goal strong')?.textContent === label, `${status} goal status`);
    emit(source.id, "session.goal_updated", { goal: activeGoal });
    await frame();
    check(document.querySelector('.composer-current-goal strong')?.textContent === label, "A stale active goal overwrote the terminal state");
    check(!document.querySelector('.send-button')?.classList.contains('stop-button'), "A terminal goal left the task running");
  }
  await write("Explain the result");
  await waitFor(() => document.querySelector('.send-button')?.disabled === false, "follow-up send control");
  document.querySelector('.send-button').click();
  await waitFor(() => sends.length === 3, "ordinary follow-up");
  check(sends[2].goal === undefined, "Goal mode applied itself to every future message");
  await frame();
  [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === "Dashboard").click();
  const newTask = await waitFor(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === "New task"), "new task action");
  newTask.click();
  await waitFor(() => document.getElementById("composer-message"), "new task composer");
  await write("/goal Complete the new task");
  await waitFor(() => document.querySelector('.composer-goal-indicator.is-armed'), "slash goal");
  check(creations.length === 0 && !document.querySelector('.composer-goal-panel'), "New task goal materialized before Send");
  document.querySelector('.send-button').click();
  await waitFor(() => sends.length === 4 && document.querySelector('.composer-current-goal'), "new task goal delivery");
  check(creations.length === 1 && creations[0].firstInstruction === undefined, "Goal bypassed the separate create and send sequence");
  check(creations[0].title === "Complete the new task" && creations[0].provisionalTitle === true, "Goal creation lost its prompt title or disabled native title generation");
  check(sends[3].sessionId === created.id && sends[3].goal.objective === "Complete the new task" && sends[3].content === "Complete the new task", "New task goal lost its route or plain prompt");
  window.__goalResult = { ok: true };
} catch (error) {
  const button = document.querySelector('.send-button');
  window.__goalResult = { ok: false, error: `${error instanceof Error ? error.stack : String(error)}\n${JSON.stringify({
    sends: sends.length,
    recentRequests: calls.slice(-12).map(({ type }) => type),
    draft: document.getElementById('composer-message')?.value,
    sendButton: { label: button?.getAttribute('aria-label'), disabled: button?.disabled, classes: button?.className },
  })}` };
}
