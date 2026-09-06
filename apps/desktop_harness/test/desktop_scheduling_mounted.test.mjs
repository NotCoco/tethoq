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
      reject(new Error(`Mounted scheduling QA timed out.\n${stderr}`));
    }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Mounted scheduling QA exited ${code}.\n${stderr}\n${stdout}`));
        return;
      }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_SCHEDULING_QA="));
      if (!marker) {
        reject(new Error(`Mounted scheduling QA returned no result.\n${stderr}\n${stdout}`));
        return;
      }
      resolve(JSON.parse(marker.slice("TETHOQ_SCHEDULING_QA=".length)));
    });
  });
}

test("App keeps scheduled Mesh commands draft-local, retry-safe, and visually stable", { timeout: 60_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-scheduling-mounted-${process.pid}-${Date.now()}`);
  const rendererBundle = join(outputDirectory, "renderer.js");
  const htmlPath = join(outputDirectory, "index.html");
  const mainPath = join(outputDirectory, "main.cjs");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot,
        sourcefile: "scheduling-mounted-qa.tsx",
        loader: "tsx",
        contents: String.raw`
          import React from "react";
          import { createRoot } from "react-dom/client";

          globalThis.IS_REACT_ACT_ENVIRONMENT = false;
          window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
          window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

          const deferred = () => {
            let resolve;
            let reject;
            const promise = new Promise((resolveValue, rejectValue) => {
              resolve = resolveValue;
              reject = rejectValue;
            });
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
            let value;
            while (performance.now() < deadline) {
              value = operation();
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
          const buttonWithText = (scope, text) => {
            const value = [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
            check(value, "Button is missing: " + text);
            return value;
          };
          const pressKey = async (value, key) => {
            if (value.id === "composer-message") value = element("#composer-message");
            value.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
            await settle();
          };
          const meshLabels = () => [...document.querySelectorAll('.composer-mesh-widget-body')].map((button) => button.title).join(' ');
          const composerProse = () => document.querySelector('#composer-message')?.value.replace(/[\uE000-\uF8FF]/gu, '').trim();
          const setField = async (field, value) => {
            if (field.id === "composer-message") field = element("#composer-message");
            if (field.id === 'composer-message' && !/[\uE000-\uF8FF]/u.test(value)) value = (field.value.match(/[\uE000-\uF8FF]/gu) ?? []).join('') + value;
            const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            if (field.isContentEditable) field.value = value;
            else Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, value);
            field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
            await settle();
          };
          const envelope = (payload) => ({ ok: true, payload });
          const sourceSession = {
            id: "schedule-source",
            hostId: "desktop-qa",
            providerId: "codex",
            providerSessionId: "schedule-source",
            title: "Scheduling source task",
            project: "qa",
            workingDirectory: "C:\\qa",
            state: "idle",
            createdAt: "2026-08-29T10:00:00.000Z",
            lastActivityAt: "2026-08-29T10:00:00.000Z",
            preview: "Ready for a fresh task",
            modelId: "gpt-5.6-sol",
            reasoningEffort: "low",
            needsApproval: false,
            stale: false,
            nativeMetadata: {},
          };
          const provider = (providerId, displayName) => ({
            providerId,
            displayName,
            state: "online",
            detected: true,
            authenticated: true,
            nativeVersion: "qa",
            capabilities: { createSession: true, sendMessage: true, sessionHistory: true, attachments: true, imageAttachments: true },
            metadata: {},
          });
          const providers = [provider("codex", "Codex"), provider("grok", "Grok Build"), provider("opencode", "OpenCode")];
          const bootstrap = {
            app: { name: "Tethoq", version: "qa", platform: "win32", packaged: false },
            host: { id: "desktop-qa", displayName: "QA computer", platform: "windows", connectionState: "online", protocolVersion: 1, lastSeenAt: "2026-08-29T10:00:00.000Z", relayConnected: false },
            providers,
            allowedProviders: providers.map((item) => item.providerId),
            connectors: { directory: "C:\\qa\\connectors", loaded: [], pending: [], diagnostics: [] },
            latestSequence: 0,
            openCode: { state: "external", url: "http://127.0.0.1:4096/", managed: false, message: "QA" },
          };
          const preferences = {
            version: 1,
            experimentalFeatures: false,
            reasoningDisplay: "compact",
            taskListMode: "recent",
            localOpenHandlerId: "system",
            closeAction: "tray",
            launchAtLogin: "off",
            alerts: "all",
            agentDefaults: {},
            globalAgentsPath: null,
            taskOverrides: {},
            allowForeignSubagents: false,
            foreignSubagentOverrides: {},
            ears: { enabled: false, providerId: null, modelId: null, mode: "cleaned" },
          };
          const browserState = {
            partition: "persist:tethoq-browser",
            profile: { persistent: true, appOwned: true, importsSystemProfile: false, clearing: false },
            visible: false,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            tabs: [],
            activeTabId: null,
            downloads: [],
            canGoBack: false,
            canGoForward: false,
          };
          const recorderState = {
            phase: "idle",
            supported: true,
            privacy: { localOnly: true, neverUploadedAutomatically: true, capturesScreen: true, capturesGlobalInput: true, capturesKeyCodesNotText: true, sensitiveDataPossible: true, warning: "QA", limitations: [] },
          };
          let scheduleGate = deferred();
          const scheduleCalls = [];
          const materializeCalls = [];
          const delegationCalls = [];
          const createdSessions = new Map();
          const request = async (type, payload = {}, requestId) => {
            if (type === "sessions.list") return envelope({ sessions: [sourceSession] });
            if (type === "scheduled_task.list") return envelope({ tasks: [] });
            if (type === "approval.list") return envelope({ approvals: [] });
            if (type === "user_input.list") return envelope({ requests: [] });
            if (type === "models.list") {
              const catalogues = {
                codex: [{ id: "gpt-5.6-sol", providerId: "codex", displayName: "GPT-5.6 Sol", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" } }],
                grok: [
                  { id: "grok-4.6", providerId: "grok", displayName: "Grok 4.6", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" } },
                  { id: "grok-4.5", providerId: "grok", displayName: "Grok 4.5", inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" } },
                ],
                opencode: [{ id: "opencode-go/deepseek-v4-flash", providerId: "opencode", displayName: "DeepSeek V4 Flash", isDefault: true, inputModalities: ["text", "image"], nativeMetadata: { supportedReasoningEfforts: ["max"], defaultReasoningEffort: "max" } }],
              };
              return envelope({ models: catalogues[payload.providerId] ?? [] });
            }
            if (type === "session.open") return envelope({ session: createdSessions.get(payload.sessionId) ?? sourceSession, messages: [], nextCursor: null });
            if (type === "side_chat.list") return envelope({ sessions: [] });
            if (type === "message_queue.list") return envelope({ messages: [] });
            if (type === "session.goal.get") return envelope({ goal: null });
            if (type === "session.create") {
              materializeCalls.push(structuredClone(payload));
              const id = "materialized-mesh-parent-" + materializeCalls.length;
              const session = {
                ...sourceSession,
                id,
                providerSessionId: id,
                providerId: payload.providerId,
                title: payload.title,
                modelId: payload.modelId ?? sourceSession.modelId,
                reasoningEffort: payload.reasoningEffort ?? sourceSession.reasoningEffort,
                state: payload.firstInstruction ? "working" : "idle",
                preview: payload.firstInstruction ?? "",
              };
              createdSessions.set(id, session);
              return envelope({ session });
            }
            if (type === "delegation.prepare") {
              delegationCalls.push(structuredClone(payload));
              return envelope({});
            }
            if (type === "scheduled_task.create") {
              scheduleCalls.push({ payload: structuredClone(payload), requestId });
              await scheduleGate.promise;
              return envelope({ task: {
                requestId,
                targetSessionId: "scheduled-task:" + requestId,
                providerId: payload.providerId,
                title: payload.title,
                workingDirectory: payload.workingDirectory,
                content: payload.content,
                runAt: payload.runAt,
                createdAt: "2026-08-29T10:00:01.000Z",
                status: "pending",
                modelId: payload.modelId,
                reasoningEffort: payload.reasoningEffort,
                meshTargets: payload.meshTargets,
              } });
            }
            return envelope({});
          };
          const remove = () => undefined;
          window.tethoqDesktop = {
            request,
            bootstrap: async () => bootstrap,
            preferencesState: async () => preferences,
            preferencesAction: async () => preferences,
            notifyReady: () => undefined,
            onEventBatch: () => remove,
            onRuntimeState: () => remove,
            browserState: async () => browserState,
            browserAction: async () => browserState,
            recorderState: async () => recorderState,
            recorderAction: async (action) => action.type === "list" ? [] : recorderState,
            localOpenHandlers: async () => ({ defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] }),
            onPreferencesState: () => remove,
            onBrowserState: () => remove,
            onBrowserNotice: () => remove,
            onRecorderState: () => remove,
            onRecorderEvent: () => remove,
            selectDirectory: async () => null,
            selectImages: async () => [],
            selectFiles: async () => [],
            openLocalTarget: async () => ({ state: { defaultHandlerId: "system", handlers: [{ id: "system", label: "File Explorer", icon: "explorer" }] } }),
            connectorAction: async () => bootstrap,
            revealPath: async () => undefined,
          };

          const { default: App } = await import("./src/renderer/src/App.tsx");
          const host = document.createElement("div");
          document.body.append(host);
          const root = createRoot(host);
          try {
            root.render(<App />);
            await waitFor(() => document.querySelector(".new-task-button") && !document.querySelector(".startup-skeleton"), "App startup");
            await click(element(".new-task-button"));
            const originalDraftRow = await waitFor(() => document.querySelector('[data-session-id^="draft-"] > .session-row.selected'), "selected original draft");
            const originalDraftId = originalDraftRow.parentElement.getAttribute("data-session-id");
            let composer = await waitFor(() => document.querySelector("#composer-message"), "draft composer");
            const entryGeometry = () => {
              const bounds = element(".composer-entry-row").getBoundingClientRect();
              return { left: bounds.left, right: bounds.right, width: bounds.width };
            };
            const stableEntry = entryGeometry();
            const checkStableEntry = (label) => {
              const current = entryGeometry();
              for (const key of ["left", "right", "width"]) {
                check(Math.abs(current[key] - stableEntry[key]) < 0.51, label + " shifted composer " + key + " from " + stableEntry[key] + " to " + current[key]);
              }
            };

            // /schedule may be inserted in prose, and a later whitespace-delimited
            // /mesh must stay on this local draft rather than materializing it.
            await setField(composer, "Schedule this prompt /schedule");
            await waitFor(() => document.querySelector(".composer-schedule-panel") && composerProse() === "Schedule this prompt", "schedule command panel");
            check(document.querySelector('[data-session-id="' + originalDraftId + '"] > .session-row.selected'), "/schedule replaced the selected local draft");
            check(materializeCalls.length === 0, "/schedule materialized the draft before persistence");
            check(!document.querySelector(".mesh-panel"), "Schedule and Mesh panels overlapped before /mesh");
            checkStableEntry("Opening Schedule");

            await setField(composer, "Schedule this /mesh prompt");
            await waitFor(() => document.querySelector(".mesh-panel"), "mid-draft Mesh picker");
            check(!document.querySelector(".composer-schedule-panel"), "Schedule remained painted behind the Mesh picker");
            check(document.querySelector('[data-session-id="' + originalDraftId + '"] > .session-row.selected'), "mid-draft /mesh replaced the local draft");
            check(materializeCalls.length === 0, "scheduled /mesh called draft materialization");
            checkStableEntry("Opening Mesh inside Schedule");

            // Exercise the detailed route first, choosing concrete model and
            // reasoning rather than relying on an inferred provider default.
            await click(element('button[aria-label="Choose model and reasoning for Grok Build"]'));
            const grokPicker = await waitFor(() => document.querySelector('.mesh-model-picker[aria-label="Choose model for Grok Build"]'), "Grok detailed Mesh picker");
            check(!document.querySelector(".composer-schedule-panel"), "Schedule remained painted behind Mesh details");
            check(!document.querySelector(".mesh-panel"), "Opening Mesh details left the quick picker behind the detailed picker");
            checkStableEntry("Opening detailed Mesh picker");
            await click(buttonWithText(grokPicker, "Grok 4.6"));
            await click(buttonWithText(grokPicker, "High"));
            await click(buttonWithText(grokPicker, "Add to mesh"));
            await waitFor(() => document.querySelector(".composer-schedule-panel") && document.querySelectorAll(".composer-mesh-widget").length === 1, "Grok inline Mesh widget");
            check(meshLabels().includes("Grok 4.6") && meshLabels().includes("High"), "Detailed Mesh selection did not paint its model and reasoning");
            checkStableEntry("Painting first inline Mesh target");

            // Exercise the quick route as well. Its command is consumed while
            // the prose surrounding it remains the scheduled instruction.
            composer = element("#composer-message");
            await setField(composer, "Schedule this prompt /mesh");
            const quickMesh = await waitFor(() => document.querySelector(".mesh-panel"), "second Mesh quick picker");
            await click(buttonWithText(quickMesh, "OpenCode"));
            await waitFor(() => document.querySelector(".composer-schedule-panel") && document.querySelectorAll(".composer-mesh-widget").length === 2, "two inline Mesh widgets");
            check(meshLabels().includes("DeepSeek V4 Flash"), "Quick Mesh selection did not paint its concrete model");
            check(composerProse() === "Schedule this prompt", "Committing /mesh changed surrounding scheduled prose");
            checkStableEntry("Painting two inline Mesh targets");

            const scheduleField = element('.composer-schedule-panel input[type="datetime-local"]');
            const due = new Date(Date.now() + 10 * 60 * 1000);
            due.setSeconds(0, 0);
            const part = (value) => String(value).padStart(2, "0");
            const localValue = due.getFullYear() + "-" + part(due.getMonth() + 1) + "-" + part(due.getDate()) + "T" + part(due.getHours()) + ":" + part(due.getMinutes());
            await setField(scheduleField, localValue);
            await click(element('.composer-schedule-panel button[type="submit"]'));
            await waitFor(() => scheduleCalls.length === 1, "deferred scheduled_task.create");
            const firstScheduleCall = structuredClone(scheduleCalls[0]);
            check(firstScheduleCall.payload.content === "Schedule this prompt", "App changed the submitted scheduled content");
            const submittedTargets = [
              { providerId: "grok", modelId: "grok-4.6", reasoningEffort: "high" },
              { providerId: "opencode", modelId: "opencode-go/deepseek-v4-flash", reasoningEffort: "max" },
            ];
            check(JSON.stringify(firstScheduleCall.payload.meshTargets) === JSON.stringify(submittedTargets), "Schedule did not submit exact cloned Mesh targets: " + JSON.stringify(firstScheduleCall.payload.meshTargets));
            check(!firstScheduleCall.payload.content.includes("/schedule") && !firstScheduleCall.payload.content.includes("/mesh"), "Scheduled payload leaked command tokens");
            check(materializeCalls.length === 0 && delegationCalls.length === 0, "Scheduling Mesh performed an ordinary materialization or delegation");

            await click(element('[data-session-id="schedule-source"] > .session-row'));
            await waitFor(() => document.querySelector('[data-session-id="schedule-source"] > .session-row.selected'), "source task selection");
            await click(element('[data-session-id="' + originalDraftId + '"] > .session-row'));
            await waitFor(() => document.querySelector('[data-session-id="' + originalDraftId + '"] > .session-row.selected') && document.querySelector("#composer-message"), "original draft remount");
            await click(element('button[aria-label="More message actions"]'));
            const remountedScheduleAction = [...document.querySelectorAll('.composer-actions-menu [role="menu"] button')]
              .find((button) => button.textContent?.includes("Schedule task"));
            check(remountedScheduleAction, "Remounted draft lost its schedule action");
            await click(remountedScheduleAction);
            const pendingScheduleButton = element('.composer-schedule-panel button[type="submit"]');
            check(pendingScheduleButton.disabled, "Remounted draft did not retain the in-flight scheduling lifecycle");
            pendingScheduleButton.click();
            await settle();
            check(scheduleCalls.length === 1, "Remounting and resubmitting created a duplicate bridge request");
            check(JSON.stringify(scheduleCalls[0]) === JSON.stringify(firstScheduleCall), "The in-flight schedule request identity or payload changed after remount");

            scheduleGate.reject(new Error("Schedule store unavailable"));
            await waitFor(() => document.querySelector('.composer-schedule-error')?.textContent === "Schedule store unavailable", "remounted schedule failure");
            const retryButton = element('.composer-schedule-panel button[type="submit"]');
            check(!retryButton.disabled && retryButton.textContent?.includes("Retry original task"), "Failure after remount did not enable the original retry");
            scheduleGate = deferred();
            await click(retryButton);
            await waitFor(() => scheduleCalls.length === 2, "same-identity schedule retry");
            check(scheduleCalls[1].requestId === firstScheduleCall.requestId, "Schedule retry changed its request id after remount");
            check(JSON.stringify(scheduleCalls[1].payload) === JSON.stringify(firstScheduleCall.payload), "Schedule retry changed its payload after remount");

            composer = element("#composer-message");
            await setField(composer, composer.value + "\nKeep this new text");
            // Edit a submitted target while the retry is pending. The original
            // payload is immutable; the changed target belongs to the fresh draft.
            await click(element('button[aria-label="Edit Grok Build target"]'));
            const editGrokPicker = await waitFor(() => document.querySelector('.mesh-model-picker[aria-label="Choose model for Grok Build"]'), "pending Grok target edit");
            check(!document.querySelector(".composer-schedule-panel"), "Schedule overlapped a pending Mesh target edit");
            await click(buttonWithText(editGrokPicker, "Grok 4.5"));
            await click(buttonWithText(editGrokPicker, "Low"));
            await click(buttonWithText(editGrokPicker, "Save target"));
            await waitFor(() => document.querySelector(".composer-schedule-panel") && meshLabels().includes("Grok 4.5"), "edited pending Mesh target");
            check(JSON.stringify(scheduleCalls[1].payload.meshTargets) === JSON.stringify(submittedTargets), "Editing a live target mutated the in-flight retry payload");
            const transfer = new DataTransfer();
            transfer.items.add(new File([Uint8Array.of(137)], "late-image.png", { type: "image/png" }));
            const paste = new Event("paste", { bubbles: true, cancelable: true });
            Object.defineProperty(paste, "clipboardData", { value: transfer });
            composer.dispatchEvent(paste);
            await waitFor(() => document.querySelectorAll(".image-attachment-chip").length === 1, "late image attachment");

            scheduleGate.resolve();
            const retainedDraftRow = await waitFor(() => {
              const selected = document.querySelector('[data-session-id^="draft-"] > .session-row.selected');
              return selected?.parentElement?.getAttribute("data-session-id") !== originalDraftId ? selected : null;
            }, "fresh retained draft selection");
            const retainedDraftId = retainedDraftRow.parentElement.getAttribute("data-session-id");
            await waitFor(() => composerProse() === "Keep this new text", "retained text repaint");
            check(document.querySelectorAll(".image-attachment-chip").length === 1, "Fresh draft lost the image added while scheduling was pending");
            check(element(".image-attachment-chip").textContent.includes("late-image.png"), "Fresh draft repainted the wrong image");
            await click(element('button[aria-label="More message actions"]'));
            const retainedScheduleAction = [...document.querySelectorAll('.composer-actions-menu [role="menu"] button')]
              .find((button) => button.textContent?.includes("Schedule task"));
            check(retainedScheduleAction, "Retained draft lost its Schedule action");
            await click(retainedScheduleAction);
            await waitFor(() => document.querySelector(".composer-schedule-panel") && document.querySelectorAll(".composer-mesh-widget").length === 1, "retained pending Mesh target repaint");
            check(document.querySelectorAll(".composer-mesh-widget").length === 1, "Fresh draft did not consume only the exact submitted Mesh targets");
            check(meshLabels().includes("Grok 4.5") && meshLabels().includes("Low"), "Fresh draft lost the target edited while persistence was pending");
            await click(element('button[aria-label="Close task scheduling"]'));
            const scheduledId = "scheduled-task:" + firstScheduleCall.requestId;
            check(document.querySelectorAll('[data-session-id="' + scheduledId + '"]').length === 1, "Scheduled placeholder was missing or duplicated");
            check(retainedDraftId !== originalDraftId && retainedDraftId !== scheduledId, "App did not create an independent retained draft identity");
            check(document.querySelector('[data-session-id="' + scheduledId + '"] > .session-row.selected') === null, "App selected the schedule instead of the retained draft");
            check(document.querySelectorAll('[data-session-id="' + originalDraftId + '"]').length === 0, "Original local draft survived conversion");
            check(firstScheduleCall.payload.content === "Schedule this prompt", "Late text leaked into the already-submitted schedule");

            // A second schedule contains URL and embedded lookalikes. Those are
            // prose, not command tokens, and submitted targets by themselves do
            // not justify creating another retained local draft.
            const draftIdsBeforeSecond = [...document.querySelectorAll('[data-session-id^="draft-"]')].map((row) => row.getAttribute("data-session-id"));
            await click(element(".new-task-button"));
            const secondDraftRow = await waitFor(() => {
              const selected = document.querySelector('[data-session-id^="draft-"] > .session-row.selected');
              return selected?.parentElement?.getAttribute("data-session-id") !== retainedDraftId ? selected : null;
            }, "second selected draft");
            const secondDraftId = secondDraftRow.parentElement.getAttribute("data-session-id");
            composer = element("#composer-message");
            await setField(composer, "Check https://example.test/mesh and tool/mesh /schedule");
            await waitFor(() => document.querySelector(".composer-schedule-panel"), "second Schedule panel");
            await setField(composer, "Check https://example.test/mesh and tool/mesh /mesh");
            const secondQuickMesh = await waitFor(() => document.querySelector(".mesh-panel"), "second schedule Mesh picker");
            await click(buttonWithText(secondQuickMesh, "OpenCode"));
            await waitFor(() => document.querySelector(".composer-schedule-panel") && document.querySelectorAll(".composer-mesh-widget").length === 1, "second schedule inline Mesh target");
            const secondScheduleField = element('.composer-schedule-panel input[type="datetime-local"]');
            await setField(secondScheduleField, localValue);
            scheduleGate = deferred();
            await click(element('.composer-schedule-panel button[type="submit"]'));
            await waitFor(() => scheduleCalls.length === 3, "second scheduled_task.create");
            const secondScheduleCall = structuredClone(scheduleCalls[2]);
            check(secondScheduleCall.payload.content === "Check https://example.test/mesh and tool/mesh", "URL or embedded /mesh lookalike was treated as a command: " + secondScheduleCall.payload.content);
            check(JSON.stringify(secondScheduleCall.payload.meshTargets) === JSON.stringify([submittedTargets[1]]), "Second schedule submitted the wrong quick Mesh target");
            scheduleGate.resolve();
            const secondScheduledId = "scheduled-task:" + secondScheduleCall.requestId;
            await waitFor(() => document.querySelector('[data-session-id="' + secondScheduledId + '"] > .session-row.selected'), "second scheduled placeholder selection");
            const remainingDraftIds = [...document.querySelectorAll('[data-session-id^="draft-"]')].map((row) => row.getAttribute("data-session-id"));
            check(!remainingDraftIds.includes(secondDraftId), "Submitted-target-only draft remained after scheduling");
            check(JSON.stringify(remainingDraftIds.sort()) === JSON.stringify(draftIdsBeforeSecond.sort()), "Submitted Mesh targets alone created a fresh draft: " + JSON.stringify(remainingDraftIds));

            // If Schedule is closed after choosing Mesh, ordinary Send/Enter
            // must first replace the local draft with a provider task, then use
            // that real id as delegation.prepare's parent.
            await click(element(".new-task-button"));
            const sendDraftRow = await waitFor(() => document.querySelector('[data-session-id^="draft-"] > .session-row.selected'), "Mesh-send local draft");
            const sendDraftId = sendDraftRow.parentElement.getAttribute("data-session-id");
            composer = element("#composer-message");
            await setField(composer, "Materialize delegated prompt /schedule");
            await waitFor(() => document.querySelector(".composer-schedule-panel"), "Mesh-send Schedule panel");
            await setField(composer, "Materialize delegated prompt /mesh");
            const sendQuickMesh = await waitFor(() => document.querySelector(".mesh-panel"), "Mesh-send quick picker");
            await click(buttonWithText(sendQuickMesh, "Grok Build"));
            await waitFor(() => document.querySelector(".composer-schedule-panel") && document.querySelectorAll(".composer-mesh-widget").length === 1, "Mesh-send inline target");
            await click(element('button[aria-label="Close task scheduling"]'));
            check(!document.querySelector(".composer-schedule-panel") && !document.querySelector(".mesh-panel"), "Closing Schedule left a command panel painted");
            await pressKey(composer, "Enter");
            await waitFor(() => materializeCalls.length === 1 && delegationCalls.length === 1, "provider-backed Mesh send after closing Schedule");
            check(materializeCalls[0].firstInstruction === undefined, "Mesh send materialized by sending the delegation prompt as an ordinary first instruction");
            check(delegationCalls[0].parentSessionId === "materialized-mesh-parent-1", "Mesh send delegated against the wrong parent: " + JSON.stringify(delegationCalls[0]));
            check(delegationCalls[0].parentSessionId !== sendDraftId && !delegationCalls.some((call) => String(call.parentSessionId).startsWith("draft-")), "delegation.prepare leaked a local draft id");
            check(delegationCalls[0].prompt === "Materialize delegated prompt", "Materialized Mesh send changed its prompt");
            check(document.querySelector('[data-session-id="materialized-mesh-parent-1"] > .session-row.selected'), "Materialized Mesh parent was not selected");

            window.__schedulingQaResult = { ok: true, originalDraftId, retainedDraftId, scheduledId, secondScheduledId, meshParentId: delegationCalls[0].parentSessionId };
          } catch (error) {
            window.__schedulingQaResult = { ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "" };
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
    await writeFile(htmlPath, '<!doctype html><html><body><script type="module" src="./renderer.js"></script></body></html>', "utf8");
    await writeFile(mainPath, String.raw`
      const path = require("node:path");
      const { app, BrowserWindow } = require("electron");
      app.commandLine.appendSwitch("disable-gpu");
      app.setPath("userData", path.join(__dirname, "profile"));
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 1200, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        await window.loadFile(process.argv[2]);
        const result = await window.webContents.executeJavaScript('new Promise((resolve, reject) => { const started = performance.now(); const check = () => { if (window.__schedulingQaResult) return resolve(window.__schedulingQaResult); if (performance.now() - started > 35000) return reject(new Error("Renderer did not finish mounted scheduling QA")); setTimeout(check, 10); }; check(); })', true);
        process.stdout.write("TETHOQ_SCHEDULING_QA=" + JSON.stringify(result) + "\n");
        window.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exitCode = 1; app.quit(); });
    `, "utf8");

    const result = await runElectron(mainPath, htmlPath);
    assert.equal(result.ok, true, result.error ?? result.stack);
    assert.notEqual(result.originalDraftId, result.retainedDraftId);
    assert.notEqual(result.retainedDraftId, result.scheduledId);
    assert.notEqual(result.scheduledId, result.secondScheduledId);
    assert.equal(result.meshParentId, "materialized-mesh-parent-1");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
