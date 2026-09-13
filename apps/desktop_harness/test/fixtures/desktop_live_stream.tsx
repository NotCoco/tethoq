import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/src/styles.css";

const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const envelope = (payload: unknown) => ({ ok: true, payload });
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const waitFor = async (read: () => unknown, label: string) => {
  const deadline = performance.now() + 5_000;
  while (!read()) {
    if (performance.now() > deadline) throw new Error(`${label} timed out`);
    await frame();
  }
};
Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
const at = new Date().toISOString();
const sessions = ["slow-history", "failed-history"].map((id) => ({
  id, providerSessionId: id, hostId: "qa", providerId: "opencode", title: id,
  workingDirectory: "C:\\qa", project: "qa", state: "working", preview: "Ready",
  createdAt: at, lastActivityAt: at, modelId: "deepseek/flash", reasoningEffort: "max",
  needsApproval: false, stale: false, nativeMetadata: {},
}));
const provider = {
  providerId: "opencode", displayName: "OpenCode", state: "online", detected: true, authenticated: true,
  capabilities: { createSession: true, sendMessage: true, sessionHistory: true, interrupt: true }, metadata: {},
};
const bootstrap = {
  app: { name: "Tethoq", version: "qa", platform: "win32", packaged: false },
  host: { id: "qa", displayName: "QA", platform: "windows", connectionState: "online", protocolVersion: 1, lastSeenAt: at, relayConnected: false },
  providers: [provider], allowedProviders: ["opencode"], latestSequence: 0,
  connectors: { directory: "C:\\qa", loaded: [], pending: [], diagnostics: [] },
  openCode: { state: "external", url: "http://127.0.0.1:4096/", managed: false, message: "QA" },
};
const preferences = {
  version: 1, experimentalFeatures: false, reasoningDisplay: "compact", taskListMode: "recent",
  localOpenHandlerId: "system", closeAction: "tray", launchAtLogin: "off", alerts: "all",
  agentDefaults: {}, globalAgentsPath: null, taskOverrides: {}, allowForeignSubagents: false,
  foreignSubagentOverrides: {}, ears: { enabled: false, providerId: null, modelId: null, mode: "cleaned" },
};
const browserState = {
  partition: "persist:tethoq-browser", profile: { persistent: true, appOwned: true, importsSystemProfile: false, clearing: false },
  visible: false, bounds: { x: 0, y: 0, width: 800, height: 600 }, tabs: [], activeTabId: null,
  downloads: [], pendingPermissions: [], canGoBack: false, canGoForward: false,
};
const recorderState = { phase: "idle", supported: true, privacy: { limitations: [] } };
const gates = new Map(sessions.map((session) => [session.id, deferred()]));
const opens: string[] = [];
let listener: ((batch: unknown) => void) | undefined;
const remove = () => undefined;
window.tethoqDesktop = {
  bootstrap: async () => bootstrap,
  request: async (type: string, payload: Record<string, unknown> = {}) => {
    if (type === "sessions.list" || type === "sessions.refresh") return envelope({ sessions });
    if (type === "provider.list") return envelope({ providers: [provider] });
    if (type === "models.list") return envelope({ models: [{ id: "deepseek/flash", providerId: "opencode", displayName: "Flash", nativeMetadata: { supportedReasoningEfforts: ["max"] } }] });
    if (type === "session.open") {
      opens.push(String(payload.sessionId));
      return gates.get(String(payload.sessionId))!.promise;
    }
    if (type === "scheduled_task.list") return envelope({ tasks: [] });
    if (type === "approval.list") return envelope({ approvals: [] });
    if (type === "user_input.list") return envelope({ requests: [] });
    if (type === "session.children" || type === "session.side_chats" || type === "side_chat.list") return envelope({ sessions: [] });
    if (type === "message_queue.list") return envelope({ messages: [] });
    if (type === "session.goal.get") return envelope({ goal: null });
    if (type === "session.context.get") return envelope({ context: null });
    if (type === "vision.targets") return envelope({ targets: [] });
    if (type === "session.vision.get") return envelope({ vision: { sessionId: payload.sessionId, primaryModelSupportsImageInput: true, configured: null } });
    if (type === "session.watch") return envelope({ incremental: true });
    if (type === "sync.since") return envelope({ events: [], throughSequence: 0, latestSequence: 0, replayGap: false });
    return envelope({});
  },
  onEventBatch: (callback: typeof listener) => { listener = callback; return remove; },
  preferencesState: async () => preferences, preferencesAction: async () => preferences,
  browserState: async () => browserState, browserAction: async () => browserState,
  recorderState: async () => recorderState, recorderAction: async () => recorderState,
  localOpenHandlers: async () => ({ defaultHandlerId: "system", handlers: [] }),
  notifyReady: remove, onRuntimeState: () => remove, onPreferencesState: () => remove,
  onBrowserState: () => remove, onBrowserNotice: () => remove,
  onRecorderState: () => remove, onRecorderEvent: () => remove,
} as never;

const { default: App } = await import("../../src/renderer/src/App");
const node = document.createElement("div");
document.body.append(node);
const root = createRoot(node);
let sequence = 0;
let maxPaintMs = 0;
const row = (id: string) => document.querySelector<HTMLElement>(`[data-session-id="${id}"] > .session-row`);
const transcript = () => document.querySelector(".conversation")?.textContent ?? "";
const readable = (text: string) => text.replace(/\s+/gu, " ").trim();
const emit = (sessionId: string, partId: string, text: string, partType = "text") => {
  sequence += 1;
  listener!({ latestSequence: sequence, replayGap: false, events: [{
    sequence, eventId: `delta-${sequence}`, type: "message.delta", sessionId, providerId: "opencode", hostId: "qa",
    occurredAt: new Date().toISOString(), payload: { messageId: `message-${partId}`, partId, partType, text },
  }] });
};
const streamAndCheck = async (sessionId: string, partId: string, chunk: string, expected: string, partType = "text") => {
  const start = performance.now();
  emit(sessionId, partId, chunk, partType);
  // Observe an ordinary committed render, without flushSync forcing delivery.
  // If the sidebar has painted this chunk, the transcript must have it too.
  await waitFor(() => row(sessionId)?.textContent?.includes(chunk.trim()), "sidebar delta");
  check(readable(transcript()).includes(readable(expected)), "Sidebar received a delta before the open chat: " + chunk.trim());
  maxPaintMs = Math.max(maxPaintMs, performance.now() - start);
};
const open = async (id: string) => {
  await waitFor(() => row(id), "task row");
  row(id)!.click();
  await waitFor(() => row(id)?.classList.contains("selected") && opens.includes(id), "selected task");
};
try {
  root.render(<App />);
  await waitFor(() => listener && document.querySelector(".new-task-button"), "startup");
  await open("slow-history");
  check(document.querySelector(".transcript-skeleton"), "Cold history did not show its loading state");
  await streamAndCheck("slow-history", "answer", "Already streaming", "Already streaming");

  // The delayed page predates the next chunk. Adopting it must retain the live
  // suffix and join the provider part into one card, then keep streaming.
  await streamAndCheck("slow-history", "answer", " while history loads.", "Already streaming while history loads.");
  gates.get("slow-history")!.resolve(envelope({ session: sessions[0], nextCursor: null, messages: [{
    id: "stored-answer", providerMessageId: "message-answer", sessionId: "slow-history", role: "assistant",
    createdAt: at, status: "in_progress", nativeMetadata: {},
    parts: [{ type: "text", text: "Already streaming", providerPartId: "answer" }],
  }] }));
  await frame();
  await frame();
  check(document.querySelectorAll(".message-assistant").length === 1, "History duplicated the streaming answer");
  check(transcript().includes("Already streaming while history loads."), "Delayed history removed newer text");

  let answer = "Already streaming while history loads.";
  for (let i = 0; i < 12; i += 1) {
    const chunk = ` Visible answer chunk ${i}.`;
    answer += chunk;
    await streamAndCheck("slow-history", "answer", chunk, answer);
  }
  let thought = "";
  for (let i = 0; i < 18; i += 1) {
    const chunk = `Thinking chunk ${i} has enough text to wrap onto another line in the open reasoning panel.\n\n`;
    thought += chunk;
    await streamAndCheck("slow-history", "thought", chunk, thought.trim(), "reasoning");
  }
  const flow = document.querySelector<HTMLElement>(".reasoning-flow");
  check(flow && flow.scrollHeight > flow.clientHeight, "Reasoning did not exercise its scrolling surface");
  check(flow!.scrollHeight - flow!.scrollTop - flow!.clientHeight <= 2, "Streamed reasoning left the latest text outside its viewport");

  // A failed read must not conceal text that the live provider can still send.
  await open("failed-history");
  await streamAndCheck("failed-history", "other", "Visible despite delayed history.", "Visible despite delayed history.");
  gates.get("failed-history")!.reject(new Error("History temporarily unavailable"));
  await frame();
  await streamAndCheck("failed-history", "other", " Still receiving.", "Visible despite delayed history. Still receiving.");
  check(!transcript().includes("Visible answer chunk"), "Switching tasks mixed their streams");
  (window as any).__liveStreamResult = { ok: true, chunks: sequence, maxPaintMs };
} catch (error) {
  (window as any).__liveStreamResult = { ok: false, error: error instanceof Error ? error.stack : String(error), text: transcript().slice(-1500) };
} finally {
  root.unmount();
}
