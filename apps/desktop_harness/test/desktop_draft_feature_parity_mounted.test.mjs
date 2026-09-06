import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const electronPath = createRequire(import.meta.url)("electron");
const inlineWorkerStubPlugin = {
  name: "inline-worker-stub",
  setup(buildContext) {
    buildContext.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, namespace: "inline-worker-stub" }));
    buildContext.onLoad({ filter: /.*/, namespace: "inline-worker-stub" }, () => ({
      contents: "export default class InlineWorkerStub { addEventListener() {} postMessage() {} terminate() {} }",
      loader: "js",
    }));
  },
};

function runElectron(mainPath, htmlPath) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [mainPath, htmlPath], {
      cwd: appRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Mounted draft parity QA timed out.\n${stderr}`));
    }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Mounted draft parity QA exited ${code}.\n${stderr}\n${stdout}`));
        return;
      }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_DRAFT_PARITY_QA="));
      if (!marker) {
        reject(new Error(`Mounted draft parity QA returned no result.\n${stderr}\n${stdout}`));
        return;
      }
      resolve(JSON.parse(marker.slice("TETHOQ_DRAFT_PARITY_QA=".length)));
    });
  });
}

test("OpenCode drafts expose and safely materialize the full provider-neutral task surface", { timeout: 60_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-draft-parity-mounted-${process.pid}-${Date.now()}`);
  const rendererBundle = join(outputDirectory, "renderer.js");
  const htmlPath = join(outputDirectory, "index.html");
  const mainPath = join(outputDirectory, "main.cjs");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot,
        sourcefile: "draft-parity-mounted-qa.tsx",
        loader: "tsx",
        contents: String.raw`
          import React from "react";
          import { createRoot } from "react-dom/client";
          import "./src/renderer/src/styles.css";
          import "./src/renderer/src/navigation.css";
          import "./src/renderer/src/workflow-settings.css";
          import "./src/renderer/src/live-session.css";

          globalThis.IS_REACT_ACT_ENVIRONMENT = false;
          window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
          window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
          Object.defineProperty(document, "hidden", { configurable: true, get: () => false });

          const deferred = () => {
            let resolve;
            let reject;
            const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
            return { promise, resolve, reject };
          };
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const settle = async (count = 5) => {
            for (let index = 0; index < count; index += 1) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              await frame();
            }
          };
          const waitFor = async (operation, label) => {
            const deadline = performance.now() + 10000;
            while (performance.now() < deadline) {
              const value = operation();
              if (value) return value;
              await settle(1);
            }
            throw new Error(label + " timed out");
          };
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const element = (selector, label = selector) => {
            const value = document.querySelector(selector);
            check(value, label + " is missing");
            return value;
          };
          const click = async (value) => { value.click(); await settle(); };
          const contextMenu = async (value) => {
            const bounds = value.getBoundingClientRect();
            value.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: bounds.left + 12, clientY: bounds.top + 12 }));
            await settle();
          };
          const setField = async (field, value) => {
            const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, value);
            field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
            await settle();
          };
          const action = (label) => [...document.querySelectorAll('.composer-actions-menu [role="menu"] button')]
            .find((button) => button.textContent?.includes(label));
          const openAction = async (label) => {
            await click(element('button[aria-label="More message actions"]'));
            const button = action(label);
            check(button, "Action is missing: " + label);
            await click(button);
          };
          const selectOpenCode = async () => {
            await click(element('button[aria-label^="Choose model. Current model:"]'));
            const group = await waitFor(() => document.querySelector('[data-provider-group="opencode"]'), "OpenCode model group");
            const button = [...group.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("DeepSeek V4 Pro"));
            check(button, "OpenCode model choice is missing");
            await click(button);
          };
          const envelope = (payload) => ({ ok: true, payload });
          const sourceSession = {
            id: "opencode-source", hostId: "desktop-qa", providerId: "opencode", providerSessionId: "opencode-source",
            title: "OpenCode source", project: "qa", workingDirectory: "C:\\qa", state: "idle",
            createdAt: "2026-08-30T10:00:00.000Z", lastActivityAt: "2026-08-30T10:00:00.000Z",
            preview: "Ready", modelId: "opencode-go/deepseek-v4-pro", reasoningEffort: "high",
            needsApproval: false, stale: false, nativeMetadata: {},
          };
          const provider = (providerId, displayName) => ({
            providerId, displayName, state: "online", detected: true, authenticated: true, nativeVersion: "qa",
            capabilities: { createSession: true, sendMessage: true, sessionHistory: true, steering: true, interrupt: true, attachments: true, imageAttachments: true },
            metadata: {},
          });
          const providers = [provider("opencode", "OpenCode"), provider("codex", "Codex")];
          const bootstrap = {
            app: { name: "Tethoq", version: "qa", platform: "win32", packaged: false },
            host: { id: "desktop-qa", displayName: "QA computer", platform: "windows", connectionState: "online", protocolVersion: 1, lastSeenAt: "2026-08-30T10:00:00.000Z", relayConnected: false },
            providers,
            allowedProviders: ["opencode", "codex"],
            connectors: { directory: "C:\\qa\\connectors", loaded: [], pending: [], diagnostics: [] },
            latestSequence: 0,
            openCode: { state: "external", url: "http://127.0.0.1:4096/", managed: false, message: "QA" },
          };
          let pickedDirectory = null;
          let preferences = {
            version: 1, experimentalFeatures: false, reasoningDisplay: "compact", taskListMode: "recent", savedProjectDirectories: [],
            localOpenHandlerId: "system", closeAction: "tray", launchAtLogin: "off", alerts: "all",
            agentDefaults: {}, globalAgentsPath: null, taskOverrides: {}, allowForeignSubagents: false,
            foreignSubagentOverrides: {}, ears: { enabled: false, providerId: null, modelId: null, mode: "cleaned" },
          };
          let browserState = {
            partition: "persist:tethoq-browser",
            profile: { persistent: true, appOwned: true, importsSystemProfile: false, clearing: false },
            visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 }, tabs: [], activeTabId: null,
            downloads: [], pendingPermissions: [], canGoBack: false, canGoForward: false,
          };
          const recorderState = {
            phase: "idle", supported: true,
            privacy: { localOnly: true, neverUploadedAutomatically: true, capturesScreen: true, capturesGlobalInput: true, capturesKeyCodesNotText: true, sensitiveDataPossible: true, warning: "QA", limitations: [] },
          };
          const createdSessions = new Map();
          const createCalls = [];
          const sendCalls = [];
          const sideChatCalls = [];
          const preferenceCalls = [];
          let createSequence = 0;
          const firstCreateGate = deferred();
          const navigationCreateGate = deferred();
          const contextCompactionGate = deferred();
          const contextThresholdCalls = [];
          let eventSink;
          let contextReading = {
            sessionId: sourceSession.id,
            modelId: sourceSession.modelId,
            usedTokens: 150000,
            contextWindowTokens: 200000,
            usedPercent: 75,
            compactionThresholdTokens: 180000,
            minimumThresholdTokens: 10000,
            supportsManualCompaction: true,
            supportsThreshold: true,
            isCompacting: false,
            compactionKind: null,
            updatedAt: "2026-08-30T10:00:00.000Z",
            usage: { inputTokens: 145000, outputTokens: 5000, totalTokens: 150000, cost: 0.5, currency: "USD" },
          };
          const request = async (type, payload = {}) => {
            if (type === "sessions.list") return envelope({ sessions: [sourceSession] });
            if (type === "scheduled_task.list") return envelope({ tasks: [] });
            if (type === "approval.list") return envelope({ approvals: [] });
            if (type === "user_input.list") return envelope({ requests: [] });
            if (type === "models.list") {
              const providerId = payload.providerId;
              const id = providerId === "opencode" ? "opencode-go/deepseek-v4-pro" : "gpt-5.6-sol";
              return envelope({ models: [{ id, providerId, displayName: providerId === "opencode" ? "DeepSeek V4 Pro" : "GPT-5.6 Sol", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: [providerId === "opencode" ? "high" : "low"], defaultReasoningEffort: providerId === "opencode" ? "high" : "low" } }] });
            }
            if (type === "session.open") return envelope({ session: createdSessions.get(payload.sessionId) ?? sourceSession, messages: [], nextCursor: null });
            if (type === "side_chat.list") return envelope({ sessions: [] });
            if (type === "message_queue.list") return envelope({ messages: [] });
            if (type === "session.goal.get") return envelope({ goal: null });
            if (type === "session.context.get") return envelope({ context: contextReading });
            if (type === "session.context.set_threshold") {
              contextThresholdCalls.push(structuredClone(payload));
              await contextCompactionGate.promise;
              contextReading = {
                ...contextReading,
                usedTokens: 40000,
                usedPercent: 20,
                compactionThresholdTokens: payload.thresholdTokens,
                updatedAt: "2026-08-30T10:00:01.000Z",
                usage: { ...contextReading.usage, inputTokens: 38000, outputTokens: 2000, totalTokens: 40000 },
              };
              return envelope({ context: contextReading });
            }
            if (type === "session.create") {
              createSequence += 1;
              const call = { payload: structuredClone(payload), sequence: createSequence };
              createCalls.push(call);
              if (createSequence === 1) await firstCreateGate.promise;
              if (createSequence === 4) await navigationCreateGate.promise;
              const id = "opencode-materialized-" + createSequence;
              const session = {
                ...sourceSession, id, providerSessionId: id, title: payload.title, providerId: payload.providerId,
                modelId: payload.modelId ?? sourceSession.modelId, reasoningEffort: payload.reasoningEffort ?? sourceSession.reasoningEffort,
                state: payload.firstInstruction ? "working" : "idle", preview: payload.firstInstruction ?? "",
                createdAt: "2026-08-30T10:00:0" + createSequence + ".000Z", lastActivityAt: "2026-08-30T10:00:0" + createSequence + ".000Z",
              };
              createdSessions.set(id, session);
              return envelope({ session });
            }
            if (type === "session.send_message") {
              sendCalls.push(structuredClone(payload));
              const session = createdSessions.get(payload.sessionId);
              if (session) createdSessions.set(payload.sessionId, { ...session, state: "working", preview: payload.content });
              return envelope({});
            }
            if (type === "side_chat.create") {
              sideChatCalls.push(structuredClone(payload));
              const parent = createdSessions.get(payload.parentSessionId);
              const id = "side-chat-" + sideChatCalls.length;
              const session = { ...parent, id, providerSessionId: id, title: "Side chat", state: "idle", preview: "", sessionKind: "side_chat", parentSessionId: payload.parentSessionId };
              createdSessions.set(id, session);
              return envelope({ session });
            }
            if (type === "session.vision.get") return envelope({ vision: { sessionId: payload.sessionId, primaryModelSupportsImageInput: true, configured: null } });
            if (type === "vision.targets") return envelope({ targets: [] });
            return envelope({});
          };
          const remove = () => undefined;
          window.tethoqDesktop = {
            request,
            bootstrap: async () => bootstrap,
            preferencesState: async () => preferences,
            preferencesAction: async (next) => {
              preferenceCalls.push(structuredClone(next));
              if (next.type === "set-task-list-mode") preferences = { ...preferences, taskListMode: next.value };
              if (next.type === "save-project" || next.type === "use-project" && preferences.savedProjectDirectories.includes(next.directory)) {
                preferences = { ...preferences, savedProjectDirectories: [next.directory, ...preferences.savedProjectDirectories.filter(directory => directory !== next.directory)] };
              }
              const taskOverrides = { ...preferences.taskOverrides };
              if (next.type === "set-task-override") {
                const merged = { ...taskOverrides[next.sessionId], ...next.override };
                if (!merged.title) delete merged.title;
                if (merged.pinned !== true) delete merged.pinned;
                if (merged.archived !== true) delete merged.archived;
                delete taskOverrides[next.sessionId];
                if (Object.keys(merged).length) taskOverrides[next.sessionId] = merged;
              }
              if (next.type === "move-task-override") {
                const source = taskOverrides[next.fromSessionId];
                if (source) {
                  const moved = { ...taskOverrides[next.toSessionId], ...source };
                  delete taskOverrides[next.fromSessionId];
                  delete taskOverrides[next.toSessionId];
                  taskOverrides[next.toSessionId] = moved;
                }
              }
              preferences = { ...preferences, taskOverrides };
              return preferences;
            },
            notifyReady: () => undefined,
            onEventBatch: (sink) => { eventSink = sink; return remove; },
            onRuntimeState: () => remove,
            browserState: async () => browserState,
            browserAction: async (next) => {
              if (next.type === "set-bounds") browserState = { ...browserState, bounds: next.bounds };
              return browserState;
            },
            recorderState: async () => recorderState,
            recorderAction: async (next) => next.type === "list" ? [] : recorderState,
            localOpenHandlers: async () => ({ defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] }),
            onPreferencesState: () => remove,
            onBrowserState: () => remove,
            onBrowserNotice: () => remove,
            onRecorderState: () => remove,
            onRecorderEvent: () => remove,
            selectDirectory: async () => pickedDirectory,
            selectImages: async () => [],
            selectFiles: async () => [],
            openLocalTarget: async () => ({ state: { defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] } }),
            connectorAction: async () => bootstrap,
            revealPath: async () => undefined,
          };

          const { default: App } = await import("./src/renderer/src/App.tsx");
          const host = document.createElement("div");
          host.id = "root";
          document.body.append(host);
          const root = createRoot(host);
          try {
            root.render(<App />);
            await waitFor(() => document.querySelector(".new-task-button") && !document.querySelector(".startup-skeleton"), "App startup");

            await click(element(".new-task-button"));
            const racedDraft = await waitFor(() => document.querySelector('[data-session-id^="draft-"] > .session-row.selected'), "OpenCode race draft");
            const racedDraftId = racedDraft.parentElement.getAttribute("data-session-id");
            check(!racedDraft.querySelector("[data-provider-id]") && racedDraft.querySelector(".session-draft-harness"), "An unsent draft already claims a harness");
            await selectOpenCode();
            check(!racedDraft.querySelector("[data-provider-id]"), "Choosing a draft model prematurely assigned a harness icon");
            await setField(element("#composer-message"), "Race-safe OpenCode draft");
            await click(element('button[aria-label="More message actions"]'));
            const labels = [...document.querySelectorAll('.composer-actions-menu [role="menu"] button')].map((button) => button.textContent ?? "");
            for (const expected of ["Schedule task", "Context Handoff", "Branch in New Task", "Open session browser", "Open side chat", "Delegate task", "Send behavior", "Goal", "EARS settings", "EYES settings", "Manage workflows"]) {
              check(labels.some((label) => label.includes(expected)), "Full OpenCode draft menu is missing: " + expected);
            }
            await click(action("Goal"));
            await waitFor(() => createCalls.length === 1, "first session.create");
            element(".send-button").click();
            await settle();
            check(createCalls.length === 1, "An interleaved draft action and send created duplicate provider tasks");
            firstCreateGate.resolve();
            await waitFor(() => document.querySelector(".composer-goal-panel"), "Goal after materialization remount");
            await waitFor(() => sendCalls.length === 1, "send after shared materialization");
            check(createCalls.length === 1, "Resolving the shared materialization created a second provider task");
            check(createCalls[0].payload.providerId === "opencode" && createCalls[0].payload.firstInstruction === undefined, "The app did not use the selected OpenCode route for action-led materialization: " + JSON.stringify(createCalls[0].payload));
            check(sendCalls[0].sessionId === "opencode-materialized-1" && sendCalls[0].content === "Race-safe OpenCode draft", "The interleaved send did not target the one real OpenCode task");
            check(document.querySelector('[data-session-id="opencode-materialized-1"] > .session-row.selected'), "The real OpenCode task was not selected after materialization");
            check(!document.querySelector('[data-session-id="' + racedDraftId + '"]'), "The local draft row survived provider materialization");
            check(document.querySelector('[data-session-id="opencode-materialized-1"] .provider-logo[data-provider-id="opencode"]'), "The stored session did not keep the harness that created it");
            await click(element('button[aria-label="Close goal controls"]'));

            await click(element(".new-task-button"));
            const sideDraft = await waitFor(() => document.querySelector('[data-session-id^="draft-"] > .session-row.selected'), "side-chat draft");
            const sideDraftId = sideDraft.parentElement.getAttribute("data-session-id");
            await selectOpenCode();
            await setField(element("#composer-message"), "Keep this text while opening a side chat");
            await openAction("Open side chat");
            await waitFor(() => document.querySelector(".side-chat-panel"), "side chat after materialization");
            check(createCalls.length === 2, "Draft side chat did not create exactly one provider task");
            check(sideChatCalls.length === 1 && sideChatCalls[0].parentSessionId === "opencode-materialized-2", "Side chat used the dead local draft id instead of the real parent");
            check(sideChatCalls[0].parentSessionId !== sideDraftId, "Side chat leaked the local draft id to the bridge");
            check(element("#composer-message").value === "Keep this text while opening a side chat", "Side-chat materialization discarded the pending composition");
            await click(element('button[aria-label="Close side chat"]'));

            await click(element(".new-task-button"));
            await waitFor(() => document.querySelector('[data-session-id^="draft-"] > .session-row.selected'), "browser draft");
            await selectOpenCode();
            await setField(element("#composer-message"), "Keep this text while opening the browser");
            await openAction("Open session browser");
            await waitFor(() => document.querySelector(".browser-page"), "session browser after materialization");
            check(createCalls.length === 3, "Draft browser did not create exactly one provider task");
            await click(element('button[aria-label="Return to task"]'));
            await waitFor(() => document.querySelector("#composer-message")?.value === "Keep this text while opening the browser", "browser draft restoration");
            check(document.querySelector('[data-session-id="opencode-materialized-3"] > .session-row.selected'), "Browser return did not retain the materialized OpenCode task");

            await click(element(".new-task-button"));
            await waitFor(() => document.querySelector('[data-session-id^="draft-"] > .session-row.selected'), "navigation draft");
            await selectOpenCode();
            await setField(element("#composer-message"), "Keep this draft without replaying its abandoned action");
            await openAction("Goal");
            await waitFor(() => createCalls.length === 4, "navigation session.create");
            await click(element('[data-session-id="opencode-source"] > .session-row'));
            check(document.querySelector('[data-session-id="opencode-source"] > .session-row.selected'), "Navigation away from the materializing draft did not stick");
            navigationCreateGate.resolve();
            await waitFor(() => document.querySelector('[data-session-id="opencode-materialized-4"]'), "background materialization");
            check(document.querySelector('[data-session-id="opencode-source"] > .session-row.selected'), "Background materialization stole task selection");
            check(!document.querySelector(".composer-goal-panel"), "The abandoned Goal action opened on another task");
            await click(element('[data-session-id="opencode-materialized-4"] > .session-row'));
            await waitFor(() => document.querySelector("#composer-message")?.value === "Keep this draft without replaying its abandoned action", "background draft restoration");
            check(!document.querySelector(".composer-goal-panel"), "The abandoned Goal action replayed after returning later");

            await click(element(".new-task-button"));
            await waitFor(() => document.querySelector('[data-session-id^="draft-"] > .session-row.selected'), "delegation draft");
            await selectOpenCode();
            await setField(element("#composer-message"), "Preserve this draft while opening delegation");
            await openAction("Delegate task");
            await waitFor(() => document.querySelector(".delegation-chat-picker"), "delegation after materialization");
            check(createCalls.length === 5, "Draft delegation did not create exactly one provider task");
            check(document.querySelector('[data-session-id="opencode-materialized-5"] > .session-row.selected'), "Delegation did not retain the materialized OpenCode task");
            check(element("#composer-message").value === "Preserve this draft while opening delegation", "Delegation materialization discarded the pending composition");

            await click(element('button[aria-label="Close delegation"]'));
            await click(element(".new-task-button"));
            const archivedDraft = await waitFor(() => document.querySelector('[data-session-id^="draft-"] > .session-row.selected'), "archived draft");
            const archivedDraftShell = archivedDraft.parentElement;
            const archivedDraftId = archivedDraftShell.getAttribute("data-session-id");
            await selectOpenCode();
            await setField(element("#composer-message"), "Run this archived draft without bringing it back");
            await contextMenu(archivedDraft);
            check(document.querySelector(".session-context-menu"), "Draft context menu did not open; connected=" + archivedDraft.isConnected + " shell=" + archivedDraftShell.isConnected);
            const archiveAction = await waitFor(() => [...document.querySelectorAll('.session-context-menu [role="menuitem"]')].find((button) => button.textContent?.includes("Archive")), "draft Archive action");
            await click(archiveAction);
            await waitFor(() => !document.querySelector('[data-session-id="' + archivedDraftId + '"]'), "archived draft row to hide");
            check(element("#composer-message").value === "Run this archived draft without bringing it back", "Archiving the open draft closed or cleared its composer");
            await click(element(".send-button"));
            await waitFor(() => createCalls.length === 6, "archived draft materialization");
            await waitFor(() => preferences.taskOverrides["opencode-materialized-6"]?.archived === true, "archived override move");
            check(createCalls[5].payload.firstInstruction === "Run this archived draft without bringing it back", "The archived draft did not run its first message");
            check(preferences.taskOverrides[archivedDraftId] === undefined, "The obsolete archived draft override survived materialization");
            check(!document.querySelector('[data-session-id="opencode-materialized-6"]'), "The real task reappeared after its archived draft materialized");
            check(preferenceCalls.some((call) => call.type === "move-task-override" && call.fromSessionId === archivedDraftId && call.toSessionId === "opencode-materialized-6"), "Materialization did not persist the override move");

            await click(await waitFor(() => document.querySelector('[data-session-id="opencode-source"] > .session-row'), "OpenCode source task"));
            await waitFor(() => document.querySelector(".context-usage-percent")?.textContent === "83%", "initial applied-threshold percentage");
            await click(element(".context-usage-trigger"));
            await setField(element('input[aria-label="Automatic compaction threshold"]'), "100000");
            await click(element('.context-threshold button'));
            await waitFor(() => contextThresholdCalls.length === 1, "immediate threshold request");
            check(contextThresholdCalls[0].thresholdTokens === 100000 && contextThresholdCalls[0].compactNow === true, "Apply did not request immediate compaction below current usage");
            check(document.querySelector(".timeline-compaction-active")?.textContent?.includes("Compacting context"), "Immediate compaction did not paint before the request completed");
            check(sendCalls.length === 1, "Applying the threshold sent a user message");
            contextCompactionGate.resolve();
            await waitFor(() => document.querySelector(".context-usage-percent")?.textContent === "40%", "same-boundary post-compaction percentage");
            const settledCompactionPercent = document.querySelector(".context-usage-percent")?.textContent ?? null;
            check(!document.querySelector(".context-usage-popover"), "The settled compaction panel did not close on the corrected reading");

            const emitCompaction = (type, sequence) => eventSink({ latestSequence: sequence, replayGap: false, events: [{
              type, sequence, eventId: "compaction-" + sequence, sessionId: sourceSession.id,
              providerId: "opencode", occurredAt: new Date().toISOString(), payload: { kind: "automatic" },
            }] });
            emitCompaction("context.compaction_started", 100);
            await waitFor(() => document.querySelector(".timeline-compaction-active"), "automatic compaction progress");
            emitCompaction("context.compaction_failed", 101);
            await waitFor(() => !document.querySelector(".timeline-compaction-active"), "failed compaction progress to clear");
            await waitFor(() => document.body.textContent.includes("Compaction could not be completed. You can try again."), "retryable compaction notice");

            await click(element('button[aria-label="Arrange tasks by project"]'));
            check(document.body.textContent.includes("Add a project") && !document.querySelector('.session-project-group'), "Chat working directories were silently saved as projects");
            await click(element('button[aria-label="New project"]'));
            check(preferences.savedProjectDirectories.length === 0, "Cancelling the folder picker saved a project");
            pickedDirectory = "C:\\qa";
            await click(element('button[aria-label="New project"]'));
            await waitFor(() => document.querySelector('.session-project-group'), "saved project after folder selection");
            check(preferences.savedProjectDirectories.includes(pickedDirectory), "Chosen project was not persisted");
            const showMoreTasks = document.querySelector('.session-project-show-more');
            if (showMoreTasks) await click(showMoreTasks);
            check(document.querySelector('[data-session-id="opencode-source"] .provider-logo[data-provider-id="opencode"]'), "The saved folder did not collect the existing external harness task");
            pickedDirectory = "C:\\picked\\empty";
            await click(element('button[aria-label="New project"]'));
            pickedDirectory = "C:\\picked\\another";
            await click(element('button[aria-label^="Choose project folder. Current folder:"]'));
            check(preferences.savedProjectDirectories.length === 3, "The draft folder picker did not save the project");
            const emptyProject = [...document.querySelectorAll('.session-project-group')].find(group => group.querySelector('strong')?.textContent === "empty");
            check(emptyProject && !emptyProject.querySelector('.session-row'), "A saved empty folder disappeared after its draft moved");
            check(createCalls.length === 6, "Saving a project created a provider session before the first prompt");

            window.__draftParityQaResult = { ok: true, createCount: createCalls.length, sendCount: sendCalls.length, sideChatParent: sideChatCalls[0].parentSessionId, archivedTaskId: "opencode-materialized-6", compactionPercent: settledCompactionPercent };
          } catch (error) {
            window.__draftParityQaResult = { ok: false, error: (error instanceof Error ? error.message : String(error)) + " | context=" + (document.querySelector(".context-usage-percent")?.textContent ?? "missing") + " hidden=" + document.hidden + " selected=" + (document.querySelector("[data-session-id] > .session-row.selected")?.parentElement?.getAttribute("data-session-id") ?? "missing"), stack: error instanceof Error ? error.stack : "" };
          } finally {
            root.unmount();
          }
        `,
      },
      outfile: rendererBundle,
      bundle: true,
      plugins: [inlineWorkerStubPlugin],
      format: "esm",
      platform: "browser",
      target: "chrome136",
      loader: { ".png": "dataurl" },
    });
    await writeFile(htmlPath, '<!doctype html><html><head><link rel="stylesheet" href="./renderer.css"></head><body><script type="module" src="./renderer.js"></script></body></html>', "utf8");
    await writeFile(mainPath, String.raw`
      const path = require("node:path");
      const { app, BrowserWindow } = require("electron");
      app.commandLine.appendSwitch("disable-gpu");
      app.setPath("userData", path.join(__dirname, "profile"));
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 1200, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        await window.loadFile(process.argv[2]);
        const result = await window.webContents.executeJavaScript('new Promise((resolve, reject) => { const started = performance.now(); const check = () => { if (window.__draftParityQaResult) return resolve(window.__draftParityQaResult); if (performance.now() - started > 35000) return reject(new Error("Renderer did not finish mounted draft parity QA")); setTimeout(check, 10); }; check(); })', true);
        process.stdout.write("TETHOQ_DRAFT_PARITY_QA=" + JSON.stringify(result) + "\n");
        window.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exitCode = 1; app.quit(); });
    `, "utf8");

    const result = await runElectron(mainPath, htmlPath);
    assert.equal(result.ok, true, result.error ?? result.stack);
    assert.equal(result.createCount, 6);
    assert.equal(result.sendCount, 1);
    assert.equal(result.sideChatParent, "opencode-materialized-2");
    assert.equal(result.archivedTaskId, "opencode-materialized-6");
    assert.equal(result.compactionPercent, "40%");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
