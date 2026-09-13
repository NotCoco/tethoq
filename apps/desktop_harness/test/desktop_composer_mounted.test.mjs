import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
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
      contents: `export default class InlineWorkerStub {
        constructor() {
          globalThis.__attachmentWorkerConstructions = (globalThis.__attachmentWorkerConstructions ?? 0) + 1;
          this.listeners = { message: [], error: [] };
        }
        addEventListener(type, listener) { this.listeners[type]?.push(listener); }
        postMessage({ id, blob }) {
          globalThis.__attachmentWorkerPosts = (globalThis.__attachmentWorkerPosts ?? 0) + 1;
          if (!String(blob.type).startsWith("audio/") && !document.querySelector(".image-attachment-chip, .file-attachment-chip")) {
            globalThis.__attachmentWorkerPostsWithoutWidget = (globalThis.__attachmentWorkerPostsWithoutWidget ?? 0) + 1;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const encoded = String(reader.result ?? "").split(",", 2)[1] ?? "";
            for (const listener of this.listeners.message) listener({ data: { id, dataBase64: encoded } });
          };
          reader.onerror = () => { for (const listener of this.listeners.error) listener({}); };
          reader.readAsDataURL(blob);
        }
        terminate() {}
      }`,
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
      reject(new Error(`Mounted Composer QA timed out.\n${stderr}`));
    }, 90_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`Mounted Composer QA exited ${code}.\n${stderr}\n${stdout}`)); return; }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_COMPOSER_QA="));
      if (!marker) { reject(new Error(`Mounted Composer QA returned no result.\n${stderr}\n${stdout}`)); return; }
      resolve(JSON.parse(marker.slice("TETHOQ_COMPOSER_QA=".length)));
    });
  });
}

test("mounted Composer preserves pending content and closes transient panels cleanly", { timeout: 105_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-composer-mounted-${process.pid}-${Date.now()}`);
  const rendererBundle = join(outputDirectory, "renderer.js");
  const htmlPath = join(outputDirectory, "index.html");
  const mainPath = join(outputDirectory, "main.cjs");
  const preloadPath = join(outputDirectory, "preload.cjs");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot,
        sourcefile: "composer-mounted-qa.tsx",
        loader: "tsx",
        contents: String.raw`
          import "./src/renderer/src/styles.css";
          import "./src/renderer/src/live-session.css";
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { flushSync } from "react-dom";

          globalThis.IS_REACT_ACT_ENVIRONMENT = false;
          // Chromium deliberately throttles requestAnimationFrame in a hidden
          // BrowserWindow. The Composer uses the next frame only to sequence DOM
          // focus/layout after state commits, so drive that same boundary with a
          // zero-delay browser task and keep this mounted regression bounded.
           window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
           window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
           Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
             enumerateDevices: async () => [],
             getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }),
           }});
           class MountedQaMediaRecorder {
             static isTypeSupported() { return true; }
             constructor(_stream, options) { this.mimeType = options?.mimeType ?? "audio/webm"; this.state = "inactive"; }
             start() { this.state = "recording"; }
             stop() {
               if (this.state !== "recording") return;
               this.state = "inactive";
               this.ondataavailable?.({ data: new Blob([Uint8Array.of(1, 2, 3)], { type: this.mimeType }) });
               this.onstop?.();
             }
           }
           globalThis.MediaRecorder = MountedQaMediaRecorder;
           globalThis.__mountedQaAnalyserReads = 0;
           globalThis.__mountedQaAudioContextCloses = 0;
           class MountedQaAudioContext {
             constructor() { this.state = "running"; }
             async resume() { this.state = "running"; }
             createMediaStreamSource() { return { connect: () => undefined, disconnect: () => undefined }; }
             createAnalyser() {
               return {
                 fftSize: 2048,
                 disconnect: () => undefined,
                 getFloatTimeDomainData: (samples) => {
                   globalThis.__mountedQaAnalyserReads += 1;
                   for (let index = 0; index < samples.length; index += 1) samples[index] = index % 2 === 0 ? 0.25 : -0.25;
                 },
               };
             }
             async close() { this.state = "closed"; globalThis.__mountedQaAudioContextCloses += 1; }
           }
           globalThis.AudioContext = MountedQaAudioContext;
          let goalLoad = null;
          let resolveGoalLoad = null;
          const workflowItems = [{
            id: "workflow-one", name: "Checkout workflow", summary: { eventCount: 3, screenshotCount: 2, apps: ["Tethoq"] },
          }];
          const workflowAttachment = {
            id: "workflow-one", name: "Checkout workflow", promptReference: "workflow://workflow-one",
            summary: { eventCount: 3, screenshotCount: 2, apps: ["Tethoq"] },
          };
          let workflowListMode = "success";
          let resolveDelayedWorkflowList = null;
          let workflowListRequests = 0;
          let workflowAttachmentRequests = 0;
          let workflowAttachmentFailures = 0;
          window.tethoqDesktop = {
            request: async (type, payload = {}) => {
              if (type === "session.goal.get") {
                if (goalLoad === null) goalLoad = new Promise((resolve) => { resolveGoalLoad = resolve; });
                const goal = await goalLoad;
                return { ok: true, payload: { goal } };
              }
              if (type === "session.goal.clear") return { ok: true, payload: { cleared: true, revision: 2 } };
              return { ok: true, payload: {} };
            },
            recorderAction: async (action) => {
              if (action.type === "list") {
                workflowListRequests += 1;
                if (workflowListMode === "delayed") {
                  return await new Promise((resolve) => {
                    resolveDelayedWorkflowList = () => { workflowListMode = "success"; resolve(workflowItems); };
                  });
                }
                if (workflowListMode === "reject-once") {
                  workflowListMode = "success";
                  throw new Error("Workflow store unavailable");
                }
                return workflowItems;
              }
              workflowAttachmentRequests += 1;
              if (workflowAttachmentFailures > 0) {
                workflowAttachmentFailures -= 1;
                throw new Error("Workflow attachment unavailable");
              }
              return workflowAttachment;
            },
            selectFiles: async () => [],
            selectImages: async () => [],
          };

          const [{ Composer, mergeFailedComposerDraft, defaultDraftScheduleLocalValue, persistMeshRecentTargetsForSession, recentMeshModels }, { mergeRefreshedSessions }, { loadProviderModelCatalogue, DesktopBridgeRequestError }, { mergeTimeline }] = await Promise.all([
            import("./src/renderer/src/Composer.tsx"),
            import("./src/renderer/src/session_refresh.ts"),
            import("./src/renderer/src/bridge.ts"),
            import("./src/renderer/src/timeline_merge.ts"),
          ]);
          const progress = (step) => {
            window.__composerQaProgress = step;
            window.__composerQaProgressAt = performance.now();
          };
          progress("renderer imported");
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const settle = async (count = 3) => { for (let index = 0; index < count; index += 1) { await new Promise((resolve) => setTimeout(resolve, 0)); await frame(); } };
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const revokedObjectUrls = new Set();
          const nativeRevokeObjectUrl = URL.revokeObjectURL.bind(URL);
          URL.revokeObjectURL = (value) => { revokedObjectUrls.add(value); nativeRevokeObjectUrl(value); };
          const element = (selector, label = selector) => { const value = document.querySelector(selector); check(value, label + " is missing"); return value; };
          const buttonWithText = (scope, text) => {
            const value = [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
            check(value, "Button is missing: " + text);
            return value;
          };
          const click = async (value) => { check(value instanceof HTMLElement, "Click target is unavailable"); value.click(); await settle(); };
          const pressKey = async (value, key, options = {}) => {
            check(value instanceof HTMLElement, "Key target is unavailable");
            value.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
            await settle();
          };
          const setField = async (value, next, preserveMesh = true) => {
            if (value.id === "composer-message") value = element("#composer-message");
            // These fixtures replace the prose without editing selected targets.
            // Native selection/deletion is covered separately below.
            if (preserveMesh && value.id === "composer-message" && !/[\uE000-\uF8FF]/u.test(next)) {
              next = (value.value.match(/[\uE000-\uF8FF]/gu) ?? []).join("") + next;
            }
            const prototype = value instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            if (value.isContentEditable) value.value = next;
            else Object.getOwnPropertyDescriptor(prototype, "value").set.call(value, next);
            if (value.id === "composer-message") { value.focus(); value.setSelectionRange(next.length, next.length); }
            value.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: next }));
            await settle();
          };
          const provider = (id, name = id) => ({
            id, name, state: "online", detected: true, supportsAttachments: true,
            capabilities: ["Create Session", "Send Message", "Session History", "Steering", "Interrupt"],
          });
          const providers = [provider("codex", "Codex"), provider("opencode", "OpenCode"), provider("grok", "Grok Build"), provider("direct", "Direct API"), ...Array.from({ length: 5 }, (_, index) => provider("mesh-" + (index + 1), "Mesh " + (index + 1)))];
          const models = Object.fromEntries(providers.map((item) => [item.id, [{ id: item.id + "-model", name: item.name + " Model", isDefault: true, efforts: ["medium"], inputModalities: ["text", "image"] }]]));
          models.opencode = [
            { id: "opencode-go/deepseek-v4-pro", name: "DeepSeek V4 Pro", isDefault: true, efforts: ["high"], inputModalities: ["text", "image"] },
            { id: "opencode-go/glm-5.3-flash", name: "GLM 5.3 Flash", efforts: ["high", "max"], inputModalities: ["text", "image"] },
          ];
          models["mesh-1"] = [
            { id: "mesh-1-model", name: "Mesh 1 Model", isDefault: true, efforts: ["medium"], inputModalities: ["text", "image"] },
            { id: "mesh-1-alternate", name: "Mesh 1 Alternate", efforts: ["high", "max"], defaultEffort: "max", inputModalities: ["text", "image"] },
          ];
          models.grok = [{ id: "grok-stale", name: "Previously loaded Grok", isDefault: true, efforts: ["medium"], inputModalities: ["text"] }];
          models.direct = [{ id: "direct-audio", name: "Direct Audio", isDefault: true, efforts: ["low"], inputModalities: ["text", "audio"] }];
          // Mesh 2 deliberately starts uncached. Its catalogue arrives after the
          // picker mounts, reproducing the packaged race where Add became
          // disabled after a late model list appeared.
          models["mesh-2"] = [];
          let mounted = null;
          const unmount = async () => {
            if (!mounted) return;
            mounted.root.unmount();
            mounted.host.remove();
            mounted = null;
            await settle(1);
          };
          const mount = async ({ providerId = "codex", sessionModel = providerId + "-model", sessionEffort = "medium", sessionState = "working", externalWriter = false, draft = false, initialDraft = "", initialAttachments = [], initialWorkflowAttachments = [], initialAnnotations = [], selectImages = async () => [], initialQueue = [], queuedSteerFailure = null, queuedSteerError = null, queuedSteerRecovery = "failed", queuedSteerSessionStateAfterFailure = null, goal = null, earsSettings = undefined, deferDelivery = false, deferQueuedDelivery = false, deferQueuedEdit = false, deferDelegation = false, deferSchedule = false, scheduleFailure = null, strictMode = false } = {}) => {
            await unmount();
            const host = document.createElement("div");
            host.id = "root";
            document.body.append(host);
            const session = {
              id: "mounted-session", providerId, model: sessionModel, effort: sessionEffort, state: sessionState,
              title: "Mounted QA", workingDirectory: "C:\\\\Projects\\\\mounted", externalWriter,
              createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
              ...(draft ? { draft: true } : {}),
            };
            const snapshot = { providers, models, sessions: [session], timelines: { [session.id]: [] } };
            const calls = [];
            const derivedSessions = [];
            const notifications = [];
            let permission = "ask";
            const queue = [...initialQueue];
            let interrupted = 0;
            let upload = 0;
            let workflowDraft = initialWorkflowAttachments;
            let annotationDraft = initialAnnotations;
            let draftStore = {
              content: initialDraft,
              attachments: initialAttachments,
              workflowAttachments: initialWorkflowAttachments,
              annotations: initialAnnotations,
            };
            let rejectGrokCatalogue = null;
            let grokCatalogueRequests = 0;
            let meshTwoCatalogueRequests = 0;
            let renderedSnapshot = snapshot;
            let commitSnapshot = null;
            let setComposerVisible = null;
            let pendingDelivery = null;
            let pendingQueuedDelivery = null;
            let pendingQueuedEdit = null;
            let deferQueueReads = false;
            const pendingQueueReads = [];
            let requestQueueRefresh = null;
            let pendingDelegation = null;
            let pendingSchedule = null;
            const schedules = [];
            const materializeActions = [];
            const sideChatCreates = [];
            let beforeSubmitCalls = 0;
            let attachmentWidgetsAtSubmitBoundary = -1;
            let queuedSteerFailed = false;
             const request = async (type, payload = {}, requestId) => {
               calls.push({ type, payload, requestId });
               if (type === "dictation.source.list") return { sources: [{ id: "openai-stt", label: "OpenAI", status: "ready", setupEnvironmentVariable: "OPENAI_API_KEY", capabilities: { batch: true, maxAudioBytes: 25 * 1024 * 1024 } }] };
               if (type === "dictation.transcribe") return { text: "Atomic dictated instruction" };
               if (type === "ears.process") return { texts: payload.attachmentIds.map(() => "Heard through EARS") };
               if (type === "message_queue.list") {
                 if (queuedSteerFailed && queuedSteerRecovery === "list-failure") throw new Error("simulated queue recovery read failure");
                 const messages = [...queue];
                 if (deferQueueReads) await new Promise(resolve => { pendingQueueReads.push(resolve); });
                 return { messages };
               }
               if (type === "message_queue.draft") {
                 const message = queue.find(item => item.id === payload.messageId);
                 check(message, "Queued draft is missing");
                 return { ...message, version: "draft-" + message.id, workflows: message.workflows ?? [],
                   attachments: message.attachments.map(({ dataBase64, dataUrl, ...info }) => info) };
               }
               if (type === "message_queue.draft_attachment") {
                 const message = queue.find(item => item.id === payload.messageId);
                 const encoded = message?.attachments[payload.index]?.dataBase64;
                 if (typeof encoded !== "string") throw new Error("Original attachment is unavailable");
                 const dataBase64 = encoded.slice(payload.offset, payload.offset + 480 * 1024);
                 const next = payload.offset + dataBase64.length;
                 return { dataBase64, offset: payload.offset, totalCharacters: encoded.length, nextOffset: next < encoded.length ? next : null };
               }
               if (type === "message_queue.cancel") {
                 if (deferQueuedEdit) await new Promise(resolve => { pendingQueuedEdit = resolve; });
                 const index = queue.findIndex(item => item.id === payload.messageId);
                 if (index < 0 || queue[index].cancelled === false) return { cancelled: false };
                 queue.splice(index, 1);
                 return { cancelled: true };
               }
              if (type === "session.permissions.get" || type === "session.permissions.set") {
                if (type.endsWith(".set")) permission = payload.value;
                return { controls: [{ id: "tools", label: "Tool permissions", value: permission, options: [{ value: "ask", label: "Ask" }, { value: "deny", label: "Deny" }] }], note: "Applies to this task." };
              }
              if (type === "attachment.upload.begin") return { uploadId: "upload-" + (++upload), chunkBytes: 32768 };
              if (type === "session.branch") return { session: { ...session, id: "paused-branch", state: "idle" }, copiedMessageCount: 4 };
              if (type === "attachment.upload.complete") return { attachmentId: "attachment-" + upload };
              if (type === "message_queue.enqueue") {
                const message = { id: "queued-" + calls.length, sessionId: session.id, content: payload.content ?? "", state: "queued", attachments: [] };
                queue.push(message);
                return { message };
              }
              if (type === "message_queue.deliver") {
                if (payload.mode !== "steer") throw new Error("Wait for the active turn to finish, or steer this instruction instead");
                const index = queue.findIndex((message) => message.id === payload.messageId);
                if (index < 0) return { delivered: false };
                if (queuedSteerFailure || queuedSteerError) {
                  queuedSteerFailed = true;
                  const failure = queuedSteerError ?? new Error(queuedSteerFailure);
                  const failureMessage = failure instanceof Error ? failure.message : String(failure);
                  if (queuedSteerRecovery === "empty" || queuedSteerRecovery === "list-failure") queue.splice(index, 1);
                  else queue[index] = {
                    ...queue[index],
                    state: "failed",
                    error: failureMessage,
                    ...(failure instanceof DesktopBridgeRequestError && failure.code === "DELIVERY_UNKNOWN" && !failure.retryable ? { retryable: false } : {}),
                  };
                  if (queuedSteerSessionStateAfterFailure !== null && commitSnapshot !== null) {
                    commitSnapshot((current) => ({
                      ...current,
                      sessions: current.sessions.map((item) => item.id === session.id
                        ? { ...item, state: queuedSteerSessionStateAfterFailure }
                        : item),
                    }));
                  }
                  throw failure;
                }
                if (deferQueuedDelivery) {
                  queue[index] = { ...queue[index], state: "sending" };
                  await new Promise((resolve, reject) => { pendingQueuedDelivery = { resolve, reject }; });
                }
                queue.splice(index, 1);
                return { delivered: true };
              }
              if (type === "session.vision.get") return { vision: { sessionId: session.id, primaryModelSupportsImageInput: true, configured: null } };
              if (type === "vision.targets") return { targets: [{ providerId: "codex", displayName: "Codex", models: [{ id: "codex-model", providerId: "codex", displayName: "Codex Model", isDefault: true, nativeMetadata: {} }] }] };
              if (type === "session.vision.configure") return {};
              if (type === "models.list" && payload.providerId === "grok") {
                grokCatalogueRequests += 1;
                if (grokCatalogueRequests === 1) return await new Promise((resolve, reject) => { rejectGrokCatalogue = () => reject(new Error("Grok catalogue unavailable")); });
                return { models: [
                  { id: "grok-4.6", providerId: "grok", displayName: "Grok 4.6", isDefault: true, nativeMetadata: {} },
                  { id: "grok-4.5", providerId: "grok", displayName: "Grok 4.5", nativeMetadata: {} },
                ] };
              }
              if (type === "models.list" && payload.providerId === "mesh-2") {
                meshTwoCatalogueRequests += 1;
                await new Promise((resolve) => setTimeout(resolve, 0));
                return { models: [{ id: "mesh-2-hydrated", providerId: "mesh-2", displayName: "Mesh 2 Hydrated", isDefault: true, nativeMetadata: { reasoningEfforts: ["medium"] } }] };
              }
              if (type === "models.list" && typeof payload.providerId === "string" && payload.providerId.startsWith("mesh-")) {
                return { models: (models[payload.providerId] ?? []).map((model) => ({ id: model.id, providerId: payload.providerId, displayName: model.name, isDefault: model.isDefault, nativeMetadata: { reasoningEfforts: model.efforts, ...(model.defaultEffort ? { defaultReasoningEffort: model.defaultEffort } : {}) } })) };
              }
              if (type === "models.list") return { models: [] };
              if (deferDelivery && (type === "session.send_message" || type === "session.steer_message")) {
                return await new Promise((resolve, reject) => { pendingDelivery = { resolve, reject }; });
              }
              if (deferDelegation && type === "delegation.prepare") {
                return await new Promise((resolve, reject) => { pendingDelegation = { resolve, reject }; });
              }
              return {};
            };
            const root = createRoot(host);
            const Harness = () => {
              const [current, setCurrent] = React.useState(snapshot);
              const [composerVisible, setVisible] = React.useState(true);
              const [draftRestoreRevision, setDraftRestoreRevision] = React.useState(0);
              setComposerVisible = setVisible;
              const hydrateProviderModels = React.useCallback(async (providerId) => {
                const catalogue = await loadProviderModelCatalogue(providerId, request);
                setCurrent((value) => ({ ...value, models: { ...value.models, [providerId]: catalogue } }));
              }, []);
              renderedSnapshot = current;
              commitSnapshot = setCurrent;
              const currentSession = current.sessions.find((item) => item.id === session.id);
              const [queueRevision, setQueueRevision] = React.useState(0);
              requestQueueRefresh = () => setQueueRevision(value => value + 1);
              if (!composerVisible) return null;
              return <Composer
                snapshot={current} session={currentSession} request={request} selectImages={selectImages} preview={false} queueRevision={queueRevision}
                notify={(message, tone) => { notifications.push({ message, tone }); }} updateSnapshot={setCurrent} onHydrateProviderModels={hydrateProviderModels} onBrowser={() => undefined} onManageWorkflow={() => undefined}
                onBeforeSubmit={() => { beforeSubmitCalls += 1; attachmentWidgetsAtSubmitBoundary = document.querySelectorAll(".image-attachment-chip, .file-attachment-chip").length; }}
                initialDraft={draftStore.content} initialAttachments={draftStore.attachments} initialWorkflowAttachments={draftStore.workflowAttachments} initialAnnotations={draftStore.annotations}
                onDraftChange={(value) => { draftStore = { ...draftStore, content: value }; }}
                onAttachmentsChange={(value) => { draftStore = { ...draftStore, attachments: value }; }}
                onWorkflowAttachmentsChange={(value) => { workflowDraft = value; draftStore = { ...draftStore, workflowAttachments: value }; }}
                onAnnotationsChange={(value) => { annotationDraft = value; draftStore = { ...draftStore, annotations: value }; }}
                draftRestoreRevision={draftRestoreRevision}
                onRestoreFailedSubmission={(submitted) => {
                  const restored = mergeFailedComposerDraft(submitted, draftStore);
                  draftStore = restored;
                  workflowDraft = restored.workflowAttachments;
                  annotationDraft = restored.annotations;
                  setDraftRestoreRevision((value) => value + 1);
                  return restored;
                }}
                onDerivedSession={(session) => derivedSessions.push(session)}
                onCreateDraftSend={async (input) => { calls.push({ type: "draft.create_send", payload: input }); }}
                onMaterializeDraft={async (input, action) => { materializeActions.push({ input, action }); }}
                onCreateSideChat={async (...args) => { sideChatCreates.push(args); }}
                onCreateDraftSchedule={async (input) => {
                  schedules.push(input);
                  if (deferSchedule) await new Promise((resolve, reject) => { pendingSchedule = { resolve, reject }; });
                  if (scheduleFailure) throw new Error(scheduleFailure);
                }}
                queueingEnabled={true} onQueueingEnabledChange={() => undefined} onGoal={() => undefined}
                ears={earsSettings}
                goal={goal}
                onInterrupt={async () => { interrupted += 1; }}
              />;
            };
            root.render(strictMode ? <React.StrictMode><Harness /></React.StrictMode> : <Harness />);
            mounted = {
              root, host, calls, derivedSessions, snapshot: () => renderedSnapshot,
              beforeSubmitCalls: () => beforeSubmitCalls,
              attachmentWidgetsAtSubmitBoundary: () => attachmentWidgetsAtSubmitBoundary,
              refreshSession: async (incoming) => {
                check(commitSnapshot, "Mounted snapshot updater is unavailable");
                commitSnapshot((current) => ({
                  ...current,
                  sessions: mergeRefreshedSessions(current.sessions, [incoming], () => false, () => false),
                }));
                await settle();
              },
              refreshModels: async (providerId, incoming) => {
                check(commitSnapshot, "Mounted snapshot updater is unavailable");
                commitSnapshot((current) => ({ ...current, models: { ...current.models, [providerId]: [...incoming] } }));
                await settle();
              },
              completeTurn: async (updatedAt) => {
                commitSnapshot((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === session.id
                  ? { ...item, state: "idle", updatedAt } : item) }));
                await settle();
              },
              injectTimeline: async (item) => {
                check(commitSnapshot, "Mounted snapshot updater is unavailable");
                commitSnapshot((current) => ({ ...current, timelines: { ...current.timelines, [session.id]: mergeTimeline(current.timelines[session.id] ?? [], item) } }));
                await settle();
              },
              setComposerVisible: async (visible) => {
                check(setComposerVisible, "Mounted Composer visibility control is unavailable");
                flushSync(() => setComposerVisible(visible));
                await settle();
              },
              resolveDelivery: (value = {}) => { check(pendingDelivery, "Deferred delivery resolver is unavailable"); const pending = pendingDelivery; pendingDelivery = null; pending.resolve(value); },
              rejectDelivery: (error) => { check(pendingDelivery, "Deferred delivery rejecter is unavailable"); const pending = pendingDelivery; pendingDelivery = null; pending.reject(error); },
              resolveQueuedDelivery: () => { check(pendingQueuedDelivery, "Deferred queue delivery resolver is unavailable"); const pending = pendingQueuedDelivery; pendingQueuedDelivery = null; pending.resolve(); },
              rejectQueuedDelivery: (error) => { check(pendingQueuedDelivery, "Deferred queue delivery rejecter is unavailable"); const pending = pendingQueuedDelivery; pendingQueuedDelivery = null; pending.reject(error); },
              resolveQueuedEdit: () => { check(pendingQueuedEdit, "Deferred queue edit resolver is unavailable"); const resolve = pendingQueuedEdit; pendingQueuedEdit = null; resolve(); },
              holdQueueReads: () => { deferQueueReads = true; },
              refreshQueue: async () => { requestQueueRefresh(); await settle(); },
              resolveQueueRead: async () => { const resolve = pendingQueueReads.shift(); check(resolve, "Deferred queue read is unavailable"); resolve(); await settle(); },
              resolveDelegation: (value = {}) => { check(pendingDelegation, "Deferred delegation resolver is unavailable"); const pending = pendingDelegation; pendingDelegation = null; pending.resolve(value); },
              rejectDelegation: (error) => { check(pendingDelegation, "Deferred delegation rejecter is unavailable"); const pending = pendingDelegation; pendingDelegation = null; pending.reject(error); },
              resolveSchedule: () => { check(pendingSchedule, "Deferred schedule resolver is unavailable"); const pending = pendingSchedule; pendingSchedule = null; pending.resolve(); },
              rejectSchedule: (error) => { check(pendingSchedule, "Deferred schedule rejecter is unavailable"); const pending = pendingSchedule; pendingSchedule = null; pending.reject(error); },
              schedules: () => schedules,
              materializeActions: () => materializeActions,
              sideChatCreates: () => sideChatCreates,
              draft: () => draftStore,
              interrupted: () => interrupted, workflowDraft: () => workflowDraft, annotationDraft: () => annotationDraft, notifications: () => notifications,
              rejectGrokCatalogue: () => { check(rejectGrokCatalogue, "Deferred Grok catalogue request is unavailable"); rejectGrokCatalogue(); },
              grokCatalogueRequests: () => grokCatalogueRequests,
              meshTwoCatalogueRequests: () => meshTwoCatalogueRequests,
            };
            await settle();
            return mounted;
          };
          const composer = () => element("#composer-message", "Composer input");
          const plainComposerValue = () => composer().value.replace(/[\uE000-\uF8FF]/gu, "");
          const send = () => element(".send-button", "Primary action");
          const assertSubmittedWithoutInterrupt = async (state, expectedType) => {
            check(send().getAttribute("aria-label") !== "Stop task", "Pending content was mislabeled as Stop");
            check(!send().disabled, "Pending content left the primary action disabled");
            await click(send());
            check(state.interrupted() === 0, "Pending content interrupted the active task");
            check(state.calls.some((call) => call.type === expectedType), "Pending content did not reach " + expectedType);
          };
          const openAction = async (text) => {
            await click(element('button[aria-label="More message actions"]'));
            await click(buttonWithText(element('.composer-actions-menu [role="menu"]'), text));
          };

           try {
             progress("long draft containment with slash suggestions");
             const longDraft = "Keep every line of this long draft inside the composer while choosing a command. ".repeat(90);
             const checkComposerBounds = (label) => {
               const box = element('.composer-box').getBoundingClientRect();
               for (const selector of ['.composer-entry-row', '#composer-message', '.composer-primary-actions']) {
                 const bounds = element(selector).getBoundingClientRect();
                 check(bounds.top >= box.top && bounds.bottom <= box.bottom - 5,
                   label + ': ' + selector + ' escaped the composer: ' + JSON.stringify({ box: box.toJSON(), bounds: bounds.toJSON() }));
               }
               check(composer().scrollHeight > composer().clientHeight && getComputedStyle(composer()).overflowY === "auto", label + ': long draft is not scrollable');
             };
             for (const [width, height] of [[1200, 800], [760, 480], [520, 640]]) {
               await window.composerLayoutQa.resize(width, height);
               await settle();
               for (const rich of [false, true]) {
                 await mount({ sessionState: "idle", initialDraft: longDraft });
                 if (rich) {
                   await setField(composer(), longDraft + "/mesh");
                   await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
                   check(composer().isContentEditable, "Selected Mesh target did not use the rich editor");
                 }
                 checkComposerBounds("Without slash");
                 await setField(composer(), longDraft + "/");
                 check(document.querySelector('.slash-command-palette'), "Long draft did not open slash suggestions");
                 checkComposerBounds("With slash");
                 const palette = element('.slash-command-palette');
                 check(palette.clientHeight >= 43, "Slash suggestions lost the space needed for one complete option");
                 const draftHeight = composer().clientHeight;
                 await window.composerLayoutQa.capture('slash-' + width + '-' + height + (rich ? '-rich' : '-plain'));
                 await pressKey(composer(), "Escape");
                 check(!document.querySelector('.slash-command-palette'), "Escape did not close slash suggestions");
                 checkComposerBounds("Dismissed slash");
                 check(composer().clientHeight > draftHeight, "Closing suggestions did not return their space to the draft");
                 check(plainComposerValue() === longDraft + "/", "Closing slash suggestions changed the draft");
               }
               await mount({ sessionState: "idle", initialDraft: longDraft, initialWorkflowAttachments: [workflowAttachment] });
               await setField(composer(), longDraft + "/");
               checkComposerBounds("Slash with attachments");
               check(document.querySelector('.workflow-attachment-chip'), "Layout discarded the attachment");
             }
             await window.composerLayoutQa.resize(1200, 800);
             await mount({ sessionState: "idle", initialDraft: longDraft.slice(0, 700) });
             await setField(composer(), longDraft.slice(0, 700) + " /");
             checkComposerBounds("Draft smaller than the normal maximum");
             progress("provider-neutral draft feature menu");
             const branchState = await mount({ providerId: "opencode", sessionModel: "opencode-go/deepseek-v4-pro", sessionState: "working", initialDraft: "Keep this unsent instruction" });
             await openAction("Branch in New Task");
             check(branchState.calls.filter((call) => call.type === "session.branch").length === 1, "Branch action did not request exactly one copy");
             const branchPayload = branchState.calls.find((call) => call.type === "session.branch").payload;
             check(branchPayload.sessionId === "mounted-session" && branchPayload.prompt === undefined, "Branch submitted the unsent draft");
             check(branchState.derivedSessions.length === 1 && branchState.derivedSessions[0].state === "idle", "Branch did not open the paused child");
             check(!branchState.calls.some((call) => call.type === "message.send" || call.type === "session.continue" || call.type === "message_queue.enqueue"), "Branch started a response");
             check(plainComposerValue() === "Keep this unsent instruction", "Branch changed the source draft");
             let state = await mount({ providerId: "opencode", sessionModel: "opencode-go/deepseek-v4-pro", sessionEffort: "high", draft: true, sessionState: "idle", initialDraft: "Keep this OpenCode draft" });
             await click(element('button[aria-label="More message actions"]'));
             const draftActionLabels = [...element('.composer-actions-menu [role="menu"]').querySelectorAll("button")].map((button) => button.textContent ?? "");
             for (const expected of ["Schedule task", "Context Handoff", "Branch in New Task", "Open session browser", "Open side chat", "Delegate task", "Send behavior", "Goal", "EARS settings", "EYES settings", "Manage workflows"]) {
               check(draftActionLabels.some((label) => label.includes(expected)), "OpenCode draft is missing action: " + expected);
             }
             await click(buttonWithText(element('.composer-actions-menu [role="menu"]'), "Open session browser"));
             check(state.materializeActions().length === 1 && state.materializeActions()[0].action === "browser", "Draft browser action did not request materialization exactly once");
             check(state.materializeActions()[0].input.providerId === "opencode" && state.materializeActions()[0].input.modelId === "opencode-go/deepseek-v4-pro", "Draft materialization lost the OpenCode route");
             check(plainComposerValue() === "Keep this OpenCode draft" && state.draft().content === "Keep this OpenCode draft", "Draft action cleared the pending composition");
             await openAction("Open side chat");
             check(state.materializeActions().at(-1)?.action === "side_chat", "Draft side chat bypassed materialization");
             check(state.sideChatCreates().length === 0, "Draft side chat used the local draft id before materialization");
             await openAction("Goal");
             check(document.querySelector(".composer-goal-indicator.is-armed") && state.materializeActions().at(-1)?.action === "side_chat", "Draft Goal must arm the next message without materializing");

             progress("draft mesh opens locally");
             state = await mount({ draft: true, sessionState: "idle", initialDraft: "" });
             await setField(composer(), "Please /mesh review this");
             check(document.querySelector('.mesh-panel'), "Draft Mesh waited for provider task creation before painting");
             check(state.materializeActions().length === 0, "Typing /mesh eagerly materialized the draft");
             await click(element('button[aria-label="Choose model and reasoning for OpenCode"]'));
             check(plainComposerValue() === "Please /mesh review this" && !document.querySelector('.composer-inline-mesh'), "Draft Mesh disclosure committed instead of opening details");
             await click(element('button[aria-label="Back to mesh targets"]'));
             await click(buttonWithText(element('.mesh-panel'), "OpenCode"));
             const draftMeshWidget = element('.composer-mesh-widget[data-provider-id="opencode"]');
             check(Boolean(draftMeshWidget.textContent?.trim()), "Draft Mesh quick selection did not paint its local target widget");
             check(plainComposerValue() === "Please  review this", "Draft Mesh selection did not consume only the command token");
             check(state.materializeActions().length === 0, "Choosing a draft Mesh target eagerly materialized the task");
             await click(send());
             check(state.materializeActions().length === 1 && state.materializeActions()[0].action === "mesh_send", "Draft Mesh Send did not request exactly one delayed materialization");

             progress("draft scheduling routes and dismissal");
             state = await mount({ sessionState: "idle" });
             await click(element('button[aria-label="More message actions"]'));
             check(![...element('.composer-actions-menu [role="menu"]').querySelectorAll("button")].some((button) => button.textContent?.includes("Schedule task")), "Schedule task appeared on an existing provider task");

             state = await mount({ draft: true, sessionState: "idle" });
             await setField(composer(), "Prepare /schedule release notes");
             check(plainComposerValue() === "Prepare release notes", "/schedule did not consume only its whitespace-delimited token");
             check(element('.composer-schedule-panel').getAttribute("role") === "dialog", "/schedule did not open the inline dialog");
             check(document.activeElement === element('.composer-schedule-panel input[type="datetime-local"]'), "The schedule field did not own focus after /schedule");
             window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
             await settle();
             check(!document.querySelector('.composer-schedule-panel'), "Escape did not close scheduling");
             check(document.activeElement === composer(), "Escape did not restore Composer focus after scheduling");
             check(plainComposerValue() === "Prepare release notes", "Escape discarded the scheduling draft");

             await openAction("Schedule task");
             check(document.activeElement === element('.composer-schedule-panel input[type="datetime-local"]'), "The More-menu schedule route did not focus its field");
             document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
             await settle();
             check(!document.querySelector('.composer-schedule-panel'), "Outside click did not close scheduling");
             check(document.activeElement === composer(), "A non-focusable outside click did not return focus to the Composer");
             check(plainComposerValue() === "Prepare release notes", "Outside dismissal discarded the scheduling draft");

             await openAction("Schedule task");
             await click(element('button[aria-label="Close task scheduling"]'));
             check(document.activeElement === composer(), "Schedule close did not restore Composer focus");
             check(plainComposerValue() === "Prepare release notes", "Schedule close discarded the draft");

             progress("draft scheduling validation and success");
             await openAction("Schedule task");
             let scheduleInput = element('.composer-schedule-panel input[type="datetime-local"]');
             await setField(scheduleInput, "");
             check(element('.composer-schedule-error').textContent?.includes("valid local date and time"), "An invalid schedule did not paint inline validation");
             const past = new Date(Date.now() - 5 * 60_000);
             const pastValue = [past.getFullYear(), String(past.getMonth() + 1).padStart(2, "0"), String(past.getDate()).padStart(2, "0")].join("-") + "T" + [String(past.getHours()).padStart(2, "0"), String(past.getMinutes()).padStart(2, "0")].join(":");
             await setField(scheduleInput, pastValue);
             check(element('.composer-schedule-error').textContent?.includes("future"), "A past schedule did not paint inline validation");
             const futureValue = defaultDraftScheduleLocalValue();
             await setField(scheduleInput, futureValue);
             check(!document.querySelector('.composer-schedule-error'), "A valid schedule retained stale inline validation");
             check(element('.composer-schedule-resolved').textContent?.startsWith("Runs "), "The selected date did not resolve to readable local time");
             await click(buttonWithText(element('.composer-schedule-panel'), "Schedule task"));
             check(state.schedules().length === 1, "Scheduling did not cross its callback exactly once");
             const scheduled = state.schedules()[0];
             check(scheduled.draftSessionId === "mounted-session", "Scheduled callback lost the local draft id");
             check(typeof scheduled.requestId === "string" && scheduled.requestId.startsWith("schedule_"), "Scheduled callback lost its stable request id");
             check(scheduled.providerId === "codex" && scheduled.modelId === "codex-model" && scheduled.effort === "medium", "Scheduled callback lost its provider route");
             check(scheduled.workingDirectory === "C:\\\\Projects\\\\mounted", "Scheduled callback lost its working directory");
             check(scheduled.scheduledComposerContent === "Prepare release notes", "Scheduled callback lost the exact submitted Composer snapshot");
             check(scheduled.content === "Prepare release notes" && scheduled.title === "Prepare release notes" && scheduled.preview === "Prepare release notes", "Scheduled callback did not derive clean content presentation");
             check(scheduled.runAt === new Date(futureValue).toISOString(), "Scheduled callback did not resolve the local value to ISO");
             check(!state.calls.some((call) => call.type === "session.send_message" || call.type === "draft.create_send"), "Scheduling also sent or created the task immediately");
             check(plainComposerValue() === "", "Successful scheduling did not clear its exact content");
             check(!document.querySelector('.composer-schedule-panel'), "Successful scheduling did not close its dialog");
             check(document.activeElement === composer(), "Successful scheduling did not restore Composer focus");
             check(!state.notifications().some((notification) => notification.message.startsWith("Task scheduled for ")), "Durable scheduling duplicated its confirmation with a toast");

             progress("draft scheduling concurrent typing and failure retention");
             state = await mount({ draft: true, sessionState: "idle", initialDraft: "Persist this later", deferSchedule: true });
             await openAction("Schedule task");
             scheduleInput = element('.composer-schedule-panel input[type="datetime-local"]');
             await setField(scheduleInput, defaultDraftScheduleLocalValue());
             element('.composer-schedule-panel button[type="submit"]').click();
             await settle();
             check(state.schedules().length === 1, "Deferred scheduling did not start exactly once");
             await setField(composer(), "Persist this later\nNew typing while scheduling");
             state.resolveSchedule();
             await settle(5);
             check(plainComposerValue() === "New typing while scheduling", "Successful scheduling erased text added while persistence was pending");
             check(!state.calls.some((call) => call.type === "session.send_message" || call.type === "draft.create_send"), "Deferred scheduling invoked immediate delivery");

             state = await mount({ draft: true, sessionState: "idle", initialDraft: "Retain failed schedule", scheduleFailure: "Schedule store unavailable" });
             await openAction("Schedule task");
             await setField(element('.composer-schedule-panel input[type="datetime-local"]'), defaultDraftScheduleLocalValue());
             await click(element('.composer-schedule-panel button[type="submit"]'));
             check(plainComposerValue() === "Retain failed schedule", "A scheduling failure cleared the draft");
             check(document.querySelector('.composer-schedule-panel'), "A scheduling failure closed the corrective dialog");
             check(element('.composer-schedule-error').textContent === "Schedule store unavailable", "A scheduling failure did not paint its error inline");
             check(!state.calls.some((call) => call.type === "session.send_message" || call.type === "draft.create_send"), "A scheduling failure invoked immediate delivery");
             const originalScheduleAttempt = structuredClone(state.schedules()[0]);
             const retryField = element('.composer-schedule-panel input[type="datetime-local"]');
             check(retryField.readOnly && !retryField.disabled, "The immutable retry time was not focusable and read-only");
             check(buttonWithText(element('.composer-schedule-panel'), "Retry original task"), "The retry action did not identify the immutable original task");
             await setField(composer(), "A newer draft which must not replace the failed attempt");
             await click(element('.composer-schedule-panel button[type="submit"]'));
             check(state.schedules().length === 2, "A schedule retry did not cross its callback exactly once");
             check(JSON.stringify(state.schedules()[1]) === JSON.stringify(originalScheduleAttempt), "A schedule retry changed the original content, route, time, or request id");
             check(plainComposerValue() === "A newer draft which must not replace the failed attempt", "Retrying the original task overwrote the newer draft");

             progress("draft scheduling failure recovers under StrictMode");
             state = await mount({ draft: true, sessionState: "idle", initialDraft: "Strict schedule failure", scheduleFailure: "Strict schedule unavailable", strictMode: true });
             await openAction("Schedule task");
             await setField(element('.composer-schedule-panel input[type="datetime-local"]'), defaultDraftScheduleLocalValue());
             await click(element('.composer-schedule-panel button[type="submit"]'));
             check(element('.composer-schedule-error').textContent === "Strict schedule unavailable", "StrictMode suppressed the scheduling failure");
             check(!element('.composer-schedule-panel button[type="submit"]').disabled, "StrictMode left scheduling permanently busy after failure");

             progress("draft scheduling text-only rejection");
             state = await mount({
               draft: true,
               sessionState: "idle",
               initialDraft: "Keep the rich draft",
               initialAttachments: [{ name: "keep.png", path: "keep.png", mimeType: "image/png", byteLength: 1, dataBase64: "AQ==", origin: "clipboard" }],
             });
             await openAction("Schedule task");
             await setField(element('.composer-schedule-panel input[type="datetime-local"]'), defaultDraftScheduleLocalValue());
             await click(element('.composer-schedule-panel button[type="submit"]'));
             check(state.schedules().length === 0, "A rich composition reached the text-only scheduling callback");
             check(plainComposerValue() === "Keep the rich draft" && document.querySelector('.image-attachment-chip'), "Text-only rejection cleared rich draft state");
             check(element('.composer-schedule-error').textContent?.includes("Remove attachments"), "Text-only rejection did not explain how to continue");

             progress("dictation immediate send is atomic");
             localStorage.setItem("tethoq:dictation-source:codex", "openai-stt");
             state = await mount({ sessionState: "idle" });
             await click(element('button[aria-label="Start dictation"]'));
             check(send().getAttribute("aria-label") === "Stop dictation and send", "Recording did not turn Send into the combined dictation action");
             check(element('.dictation-audio-strip .audio-trace canvas', "API dictation live waveform") instanceof HTMLCanvasElement, "API dictation did not render the shared live waveform");
             check(!document.querySelector('.dictation-audio-stop'), "The live waveform duplicated the lower Stop action");
             check(document.querySelectorAll('.dictation-main[aria-label="Stop dictation"]').length === 1, "Recording did not expose exactly one dedicated Stop control");
             check(!document.querySelector('.dictation-source-menu'), "The dictation-source crescent still intercepted part of the lower Stop control while recording");
             await settle(4);
             check(globalThis.__mountedQaAnalyserReads > 0, "API dictation waveform did not sample the microphone stream");
             const paintedComposerValues = [];
             const dictationObserver = new MutationObserver(() => { paintedComposerValues.push(plainComposerValue()); });
             dictationObserver.observe(document.body, { attributes: true, childList: true, subtree: true });
             send().click();
             await settle(8);
             dictationObserver.disconnect();
             const dictationSendCalls = state.calls.filter((call) => call.type === "session.send_message");
             check(dictationSendCalls.length === 1, "Immediate dictation Send did not submit exactly once");
             check(dictationSendCalls[0].payload.content === "Atomic dictated instruction", "Immediate dictation Send omitted the committed transcript");
             check(!paintedComposerValues.includes("Atomic dictated instruction"), "Committed dictation painted in the composer for an intermediate frame before Send");
             check(plainComposerValue() === "", "Immediate dictation Send left the committed transcript in the composer");
             check(!document.querySelector('.dictation-audio-strip'), "API dictation live waveform remained after capture stopped");
             check(globalThis.__mountedQaAudioContextCloses > 0, "API dictation waveform did not release its audio context");

             progress("EARS owns dictation for an audio-capable destination");
             const earsAudio = {
               path: "dictation:ears-audio",
               name: "ears-audio.mp3",
               mimeType: "audio/mpeg",
               byteLength: 3,
               dataBase64: "AQID",
               durationSeconds: 1,
               origin: "dictation",
             };
             state = await mount({
               providerId: "direct",
               sessionModel: "direct-audio",
               sessionEffort: "low",
               sessionState: "idle",
               initialDraft: "Keep this instruction",
               initialAttachments: [earsAudio],
               earsSettings: {
                 enabled: true,
                 providerId: "direct",
                 modelId: "direct-audio",
                 mode: "cleaned",
               },
             });
             await click(send());
             const earsCalls = state.calls.filter((call) => call.type === "ears.process");
             const earsDestinationCalls = state.calls.filter((call) => call.type === "session.send_message");
             check(earsCalls.length === 1, "Enabled EARS did not preprocess dictation exactly once for an audio-capable destination");
             check(earsDestinationCalls.length === 1, "EARS preprocessing did not lead to exactly one destination send");
             check(earsDestinationCalls[0].payload.content.includes("Keep this instruction"), "EARS destination send lost the typed instruction");
             check(earsDestinationCalls[0].payload.content.includes("Heard through EARS"), "EARS destination send omitted the processed transcript");
             check(!("attachmentIds" in earsDestinationCalls[0].payload), "EARS forwarded the raw dictation recording to the destination model");
             check(plainComposerValue() === "", "Accepted EARS send left text in the composer");
             check(!document.querySelector('.audio-attachment-chip'), "Accepted EARS send left the dictation attachment in the composer");
             check(!document.querySelector('.ears-progress'), "Accepted EARS send left its progress UI visible");
             check(state.snapshot().sessions.length === 1 && state.snapshot().sessions[0].id === "mounted-session", "EARS exposed its private helper session in the desktop snapshot");
             check(!state.snapshot().timelines["mounted-session"]?.[0]?.audio?.length, "EARS painted the private raw dictation recording in the destination timeline");

             progress("accepted composer transaction");
             const acceptedPreviewUrl = URL.createObjectURL(new Blob([Uint8Array.of(1)], { type: "image/png" }));
             state = await mount({
              providerId: "opencode",
              sessionModel: "opencode-go/deepseek-v4-pro",
              sessionEffort: "high",
              sessionState: "idle",
              initialDraft: "Send this exactly once",
              initialAttachments: [{ name: "accepted.png", path: "accepted.png", mimeType: "image/png", byteLength: 1, dataBase64: "AQ==", previewUrl: acceptedPreviewUrl, origin: "clipboard" }],
              deferDelivery: true,
            });
            const firstSend = send();
            firstSend.click();
            firstSend.click();
            composer().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await settle(5);
            check(plainComposerValue() === "", "Accepted transaction did not clear submitted text immediately");
            check(document.querySelectorAll(".image-attachment-chip").length === 0, "Accepted transaction did not clear the submitted image immediately");
            check(state.beforeSubmitCalls() === 1, "One accepted transaction did not sample the transcript exactly once");
            check(state.attachmentWidgetsAtSubmitBoundary() === 1, "Transcript position was sampled after the submitted image had already collapsed");
            check(send().disabled, "Send stayed enabled while delivery was unresolved");
            check(state.calls.filter((call) => call.type === "session.send_message").length === 1, "Rapid click and Enter submitted more than one delivery");
            const immediateTimeline = state.snapshot().timelines["mounted-session"];
            check(immediateTimeline.length === 1, "OpenCode did not paint the submitted user row while delivery was unresolved");
            check(immediateTimeline[0].id.startsWith("local-"), "The unresolved OpenCode row did not retain its local presentation identity");
            check(immediateTimeline[0].body === "Send this exactly once", "The immediate OpenCode row lost the submitted text");
            check(state.snapshot().sessions[0].state === "working", "The immediate OpenCode send did not start live-turn presentation");
            check(!revokedObjectUrls.has(acceptedPreviewUrl), "The submitted preview URL was revoked before delivery resolved");

            const canonicalEcho = {
              id: "canonical-user-before-ack", messageId: "canonical-message-before-ack", kind: "user",
              body: "Send this exactly once", timestamp: new Date().toISOString(), state: "completed",
              images: [{ name: "accepted.png", mimeType: "image/png", loading: true }],
            };
            await state.injectTimeline(canonicalEcho);
            check(state.snapshot().timelines["mounted-session"].length === 1, "The canonical pre-ack echo was not retained");
            check(state.snapshot().timelines["mounted-session"][0].id === canonicalEcho.id, "The canonical pre-ack echo did not adopt the optimistic row");
            const completedAt = new Date(Date.now() + 1_000).toISOString();
            await state.completeTurn(completedAt);
            state.resolveDelivery({});
            await settle(6);
            const acceptedTimeline = state.snapshot().timelines["mounted-session"];
            check(acceptedTimeline.length === 1, "Acknowledgement duplicated the canonical user echo");
            check(acceptedTimeline[0].id === canonicalEcho.id, "Acknowledgement discarded the canonical provider identity");
            check(acceptedTimeline[0].images?.[0]?.dataUrl === "data:image/png;base64,AQ==", "Canonical image placeholder lost the accepted local preview");
            check(revokedObjectUrls.has(acceptedPreviewUrl), "Accepted delivery retained its obsolete object URL");
            check(state.snapshot().sessions[0].state === "idle", "A late delivery receipt reopened the completed task");
            check(state.snapshot().sessions[0].updatedAt === completedAt, "A late delivery receipt rolled back the task activity timestamp");
            await setField(composer(), "Start the next turn");
            send().click();
            await settle(5);
            check(state.calls.filter((call) => call.type === "session.send_message").length === 2, "The next prompt was not sent after the previous turn completed before acknowledgement");
            check(!state.calls.some((call) => call.type === "message_queue.enqueue"), "A late delivery receipt diverted the next turn into the queue");
            state.resolveDelivery({});
            await settle(4);

            progress("failed composer transaction across remount");
            const failedPreviewUrl = URL.createObjectURL(new Blob([Uint8Array.of(2)], { type: "image/png" }));
            state = await mount({
              sessionState: "idle",
              initialDraft: "Restore this failed prompt",
              initialAttachments: [{ name: "failed.png", path: "failed.png", mimeType: "image/png", byteLength: 1, dataBase64: "Ag==", previewUrl: failedPreviewUrl, origin: "clipboard" }],
              deferDelivery: true,
            });
            send().click();
            await settle(5);
            check(state.snapshot().timelines["mounted-session"].length === 1, "A pending transaction did not paint its optimistic row");
            check(state.snapshot().sessions[0].state === "working", "A pending transaction did not expose immediate live processing");
            await state.setComposerVisible(false);
            await state.setComposerVisible(true);
            check(send().disabled, "A remounted Composer forgot the unresolved delivery lock");
            await setField(composer(), "New draft typed while waiting");
            const newerClipboard = new DataTransfer();
            newerClipboard.items.add(new File([Uint8Array.of(3)], "newer.png", { type: "image/png" }));
            const newerPaste = new Event("paste", { bubbles: true, cancelable: true });
            Object.defineProperty(newerPaste, "clipboardData", { value: newerClipboard });
            composer().dispatchEvent(newerPaste);
            await settle(6);
            check(state.draft().attachments.length === 1, "The newer image was not retained while delivery was unresolved");
            const newerPreviewUrl = state.draft().attachments[0].previewUrl;
            state.rejectDelivery(new Error("Provider rejected the send"));
            await settle(8);
            check(plainComposerValue() === "Restore this failed prompt\n\nNew draft typed while waiting", "Failure did not restore the submitted prompt before the newer draft");
            check(state.draft().attachments.map((attachment) => attachment.name).join(",") === "failed.png,newer.png", "Failure did not atomically restore both submitted and newer images");
            check(document.querySelectorAll(".image-attachment-chip").length === 2, "Failure did not repaint both image widgets");
            check(!revokedObjectUrls.has(failedPreviewUrl), "Failure revoked the submitted image preview");
            check(!revokedObjectUrls.has(newerPreviewUrl), "Failure revoked the newer image preview");
            check(!send().disabled, "Composer stayed locked after a definite delivery failure");
            check(state.snapshot().timelines["mounted-session"].length === 0, "A definite delivery failure did not retract its optimistic row");
            check(state.snapshot().sessions[0].state === "idle", "A definite delivery failure left the task in optimistic working state");
            check(state.notifications().some((notification) => notification.message === "Provider rejected the send" && notification.tone === "error"), "A definite delivery failure did not surface one clear error");
            nativeRevokeObjectUrl(failedPreviewUrl);
            if (newerPreviewUrl) nativeRevokeObjectUrl(newerPreviewUrl);

            progress("ambiguous direct delivery stays consumed and visible");
            const unknownPreviewUrl = URL.createObjectURL(new Blob([Uint8Array.of(4)], { type: "image/png" }));
            state = await mount({
              providerId: "opencode",
              sessionModel: "opencode-go/deepseek-v4-pro",
              sessionEffort: "high",
              sessionState: "idle",
              initialDraft: "Keep this ambiguous delivery visible",
              initialAttachments: [{ name: "unknown.png", path: "unknown.png", mimeType: "image/png", byteLength: 1, dataBase64: "BA==", previewUrl: unknownPreviewUrl, origin: "clipboard" }],
              deferDelivery: true,
            });
            send().click();
            await settle(5);
            state.rejectDelivery(new DesktopBridgeRequestError({
              code: "DELIVERY_UNKNOWN",
              message: "The provider acknowledgement was lost",
              retryable: false,
            }));
            await settle(8);
            const unknownTimeline = state.snapshot().timelines["mounted-session"];
            check(unknownTimeline.length === 1 && unknownTimeline[0].body === "Keep this ambiguous delivery visible", "Ambiguous direct delivery retracted its optimistic user row");
            check(unknownTimeline[0].images?.[0]?.name === "unknown.png", "Ambiguous direct delivery lost its submitted attachment presentation");
            check(plainComposerValue() === "" && state.draft().content === "", "Ambiguous direct delivery restored the submitted text into the composer");
            check(state.draft().attachments.length === 0 && !document.querySelector('.image-attachment-chip'), "Ambiguous direct delivery restored the consumed attachment into the composer");
            check(state.snapshot().sessions[0].state === "idle", "An unresolved delivery alone left the task in optimistic working state");
            check(!state.calls.some((call) => call.type === "attachment.upload.cancel"), "Ambiguous direct delivery cancelled an upload that the provider may own");
            check(state.notifications().some((notification) => notification.message === "The provider acknowledgement was lost" && notification.tone === "error"), "Ambiguous direct delivery did not surface its unresolved status");
            await setField(composer(), "A separate follow-up instruction");
            send().click();
            await settle(5);
            check(state.calls.filter((call) => call.type === "session.send_message").length === 2, "An unresolved delivery incorrectly held the next prompt in the queue");
            const nativeWorkingAt = new Date(Date.now() + 1_000).toISOString();
            await state.refreshSession({ ...state.snapshot().sessions[0], state: "working", updatedAt: nativeWorkingAt });
            state.rejectDelivery(new DesktopBridgeRequestError({ code: "DELIVERY_UNKNOWN", message: "The provider acknowledgement was lost", retryable: false }));
            await settle(6);
            check(state.snapshot().sessions[0].state === "working" && state.snapshot().sessions[0].updatedAt === nativeWorkingAt, "An unresolved receipt erased newer provider activity");
            nativeRevokeObjectUrl(unknownPreviewUrl);

            progress("provider-reported model resync");
            state = await mount({
              providerId: "opencode",
              sessionModel: "opencode-go/deepseek-v4-pro",
              sessionEffort: "high",
              sessionState: "idle",
            });
            const currentModel = () => element('button[aria-label^="Choose model. Current model:"]');
            check(currentModel().getAttribute("aria-label")?.includes("DeepSeek V4 Pro"), "Initial OpenCode model was not painted");
            const staleSession = state.snapshot().sessions[0];
            await state.refreshSession({
              ...staleSession,
              model: "opencode-go/glm-5.3-flash",
              effort: "max",
              updatedAt: new Date(Date.parse(staleSession.updatedAt) + 1_000).toISOString(),
            });
            check(currentModel().getAttribute("aria-label")?.includes("GLM 5.3 Flash"), "Provider-reported GLM did not replace the stale DeepSeek label");
            check(element('button[aria-label^="Choose reasoning effort"]').textContent?.includes("Max"), "Provider-reported OpenCode variant was not painted");

            await click(currentModel());
            await click(buttonWithText(element('.model-picker-dropup'), "DeepSeek V4 Pro"));
            check(currentModel().getAttribute("aria-label")?.includes("DeepSeek V4 Pro"), "Local unsent model choice was not painted");
            await state.refreshModels("opencode", [...state.snapshot().models.opencode]);
            const reportedSession = state.snapshot().sessions[0];
            await state.refreshSession({
              ...reportedSession,
              effort: "high",
              updatedAt: new Date(Date.parse(reportedSession.updatedAt) + 1_000).toISOString(),
            });
            check(currentModel().getAttribute("aria-label")?.includes("DeepSeek V4 Pro"), "An unrelated refresh erased the local unsent model choice");
            await state.refreshModels("opencode", [models.opencode[1]]);
            check(currentModel().getAttribute("aria-label")?.includes("opencode-go/deepseek-v4-pro"), "A temporarily missing catalogue row painted the task's old model instead of the pending model");

            progress("OpenCode native-default reasoning does not turn into Minimal");
            state = await mount({ providerId: "opencode", sessionModel: "opencode-go/muse-spark-1.3-contributor", sessionEffort: "default", sessionState: "idle" });
            await state.refreshModels("opencode", [{ id: "opencode-go/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", efforts: ["minimal", "low", "medium", "high", "xhigh"], defaultEffort: "minimal" }]);
            const reasoningChoice = () => element('button[aria-label^="Choose reasoning effort"]');
            check(reasoningChoice().textContent?.includes("Choose"), "An unknown/native-default effort was painted as Minimal");
            await setField(composer(), "Keep the existing provider settings");
            await assertSubmittedWithoutInterrupt(state, "session.send_message");
            check(state.calls.find((call) => call.type === "session.send_message")?.payload.reasoningEffort === undefined, "The composer silently sent the first variant");
            await click(reasoningChoice());
            await click(buttonWithText(element('.effort-choice'), "Extra high"));
            await state.refreshModels("opencode", [...state.snapshot().models.opencode]);
            await state.refreshSession({ ...state.snapshot().sessions[0], effort: "default" });
            check(reasoningChoice().textContent?.includes("Extra high"), "An unrelated refresh erased explicit reasoning");
            await setField(composer(), "Use my chosen reasoning");
            await assertSubmittedWithoutInterrupt(state, "message_queue.enqueue");
            check(state.calls.find((call) => call.type === "message_queue.enqueue")?.payload.reasoningEffort === "xhigh", "Explicit reasoning did not reach the queued request");

            progress("external writer ownership handoff");
            state = await mount({ sessionState: "idle", externalWriter: true });
            check(globalThis.__attachmentWorkerConstructions === 1, "Composer did not prewarm one attachment worker after its first paint");
            await setField(composer(), "Start this turn directly");
            await assertSubmittedWithoutInterrupt(state, "session.send_message");
            const activeSession = state.snapshot().sessions[0];
            check(activeSession.state === "working", "Successful direct send did not mark the session working");
            check(activeSession.externalWriter === false, "Successful direct send retained stale external ownership");
            await state.refreshSession({ ...activeSession, externalWriter: true, updatedAt: new Date(Date.parse(activeSession.updatedAt) + 1_000).toISOString() });
            check(state.snapshot().sessions[0].externalWriter === false, "Canonical refresh restored stale external ownership during the accepted turn");
            check(send().getAttribute("aria-label") === "Stop task", "Canonical refresh removed active-turn Stop semantics");
            await setField(composer(), "Queue this exactly once");
            const queueCallsBefore = state.calls.filter((call) => call.type === "message_queue.enqueue").length;
            await assertSubmittedWithoutInterrupt(state, "message_queue.enqueue");
            const queueCalls = state.calls.filter((call) => call.type === "message_queue.enqueue");
            check(queueCalls.length === queueCallsBefore + 1, "The active follow-up was not queued exactly once");
            check(document.querySelectorAll('.queued-message-row').length === 1, "The active follow-up was not painted exactly once");
            check(document.querySelector('.queued-message-row')?.textContent?.includes("Queue this exactly once"), "The visible queue row lost its instruction");

            progress("queued Edit unqueues once into the main composer and preserves a newer draft");
            state = await mount({ initialDraft: "My other draft", deferQueuedEdit: true, initialQueue: [
              { id: "queued-edit", sessionId: "mounted-session", content: "Edit this instruction", state: "queued", attachments: [] },
              { id: "queued-sibling", sessionId: "mounted-session", content: "Keep this queued", state: "queued", attachments: [] },
            ] });
            await click(element('button[aria-label="Queued instruction actions"]'));
            const queuedEditButton = buttonWithText(document, "Edit message");
            queuedEditButton.click();
            queuedEditButton.click();
            await settle();
            check(state.calls.filter(call => call.type === "message_queue.cancel").length === 1, "Double Edit created duplicate cancellation requests");
            await setField(composer(), "Newer unsent draft");
            state.resolveQueuedEdit();
            await settle(5);
            check(composer().value === "Edit this instruction\n\nNewer unsent draft", "Edit lost the queued text or the latest unsent draft");
            check(document.activeElement === composer(), "Edit did not focus the main composer");
            check(document.querySelectorAll('.queued-message-row').length === 1 && document.querySelector('.queued-message-row').textContent.includes("Keep this queued"), "Edit removed the wrong queued messages");
            check(!document.querySelector('.queued-message-row input, .queued-message-row textarea'), "Edit opened an inline queue editor");
            check(!state.calls.some(call => ["message_queue.edit", "message_queue.enqueue", "session.send_message"].includes(call.type)), "Edit sent or requeued content");

            progress("queued Edit restores original attachments, workflow, and annotations together");
            const editAudio = { name: "voice.mp3", mimeType: "audio/mpeg", byteLength: 3, dataBase64: "BAUG", durationSeconds: 1 };
            const editImage = { name: "original.png", mimeType: "image/png", byteLength: 400_001, dataBase64: btoa("a".repeat(400_001)) };
            state = await mount({ providerId: "opencode", initialQueue: [{ id: "queued-rich-edit", sessionId: "mounted-session",
              content: '# Response annotations:\n<response-annotations>\n[{"text":"Selected text","annotation":"Voice feedback","audioAttachmentIndex":0}]\n</response-annotations>\n\n## My request:\nEdit with context',
              state: "queued", attachments: [editImage, editAudio, { name: "notes.md", mimeType: "text/markdown", byteLength: 3, dataBase64: "AQID" }], workflows: [workflowAttachment] }] });
            await click(element('button[aria-label="Queued instruction actions"]'));
            await click(buttonWithText(document, "Edit message"));
            const editedRichDraft = state.draft();
            check(composer().value === "Edit with context", "Edit exposed the annotation transport envelope");
            check(editedRichDraft.attachments.length === 2 && editedRichDraft.attachments[0].dataBase64 === editImage.dataBase64 && editedRichDraft.attachments[1].dataBase64 === "AQID", "Edit lost or shortened the original image/file bytes");
            check(editedRichDraft.annotations.length === 1 && editedRichDraft.annotations[0].audio?.dataBase64 === editAudio.dataBase64, "Edit lost the voice annotation or duplicated its audio attachment");
            check(editedRichDraft.workflowAttachments[0]?.id === workflowAttachment.id, "Edit lost its workflow attachment");
            check(state.calls.filter(call => call.type === "message_queue.draft_attachment").length === 4, "The original image was not recovered in bounded chunks");
            check(state.calls.findIndex(call => call.type === "message_queue.cancel") > state.calls.findLastIndex(call => call.type === "message_queue.draft_attachment"), "Edit removed the message before its bytes were recovered");

            progress("failed queued Edit preserves the queue and composer without duplicating delivery");
            for (const failure of ["already-sending", "missing-attachment"]) {
              state = await mount({ initialDraft: "Keep my draft", initialQueue: [{ id: "queued-edit-failed", sessionId: "mounted-session", content: "Keep queued", state: "queued",
                cancelled: failure !== "already-sending", attachments: failure === "missing-attachment" ? [{ name: "missing.png", mimeType: "image/png", byteLength: 3 }] : [] }] });
              await click(element('button[aria-label="Queued instruction actions"]'));
              await click(buttonWithText(document, "Edit message"));
              check(composer().value === "Keep my draft", failure + " overwrote the main draft");
              check(document.querySelectorAll('.queued-message-row').length === 1, failure + " lost the queued instruction");
              check(state.notifications().some(item => item.tone === "error"), failure + " failed silently");
              if (failure === "missing-attachment") check(!state.calls.some(call => call.type === "message_queue.cancel"), "Missing attachment was dequeued before recovery");
            }

            progress("queued Edit persists the recovered draft after the composer unmounts");
            state = await mount({ deferQueuedEdit: true, initialQueue: [{ id: "queued-edit-unmount", sessionId: "mounted-session", content: "Restore after navigation", state: "queued", attachments: [] }] });
            await click(element('button[aria-label="Queued instruction actions"]'));
            await click(buttonWithText(document, "Edit message"));
            await state.setComposerVisible(false);
            state.resolveQueuedEdit();
            await settle();
            check(state.draft().content === "Restore after navigation", "Navigation lost a successfully unqueued draft");
            await state.setComposerVisible(true);
            check(composer().value === "Restore after navigation", "Returning to the task did not restore the unqueued draft");

            progress("queued Steer promotes immediately and prevents duplicate delivery");
            state = await mount({
              sessionState: "working",
              deferQueuedDelivery: true,
              initialQueue: [{ id: "queued-steer", sessionId: "mounted-session", content: "Steer this exact instruction", state: "queued", attachments: [] }],
            });
            const composerGeometryBeforeSteer = element('.composer-box').getBoundingClientRect();
            const queuedSteerButton = element('button[aria-label="Steer with this queued instruction"]');
            queuedSteerButton.click();
            queuedSteerButton.click();
            await settle();
            const steerDeliveries = state.calls.filter((call) => call.type === "message_queue.deliver");
            check(steerDeliveries.length === 1, "The visible Steer action did not make exactly one delivery request");
            check(steerDeliveries[0].payload.messageId === "queued-steer", "The visible Steer action targeted the wrong queued instruction");
            check(steerDeliveries[0].payload.mode === "steer", "The visible Steer action silently fell back to ordinary send");
            check(document.querySelectorAll('.queued-message-row').length === 0, "A pending steer retained its old queue presentation");
            let promotedRows = state.snapshot().timelines["mounted-session"].filter((item) => item.kind === "user" && item.body === "Steer this exact instruction");
            check(promotedRows.length === 1, "A pending steer was not promoted to exactly one visible user row");
            check(/^local-\d+$/u.test(promotedRows[0].id), "The pending steer did not retain an adoptable optimistic identity");
            const composerGeometryDuringSteer = element('.composer-box').getBoundingClientRect();
            check(Math.round(composerGeometryDuringSteer.width) === Math.round(composerGeometryBeforeSteer.width)
              && Math.round(composerGeometryDuringSteer.height) === Math.round(composerGeometryBeforeSteer.height), "Queue promotion changed the composer shape while acknowledgement was pending");
            state.resolveQueuedDelivery();
            await settle(5);
            promotedRows = state.snapshot().timelines["mounted-session"].filter((item) => item.kind === "user" && item.body === "Steer this exact instruction");
            check(promotedRows.length === 1, "A successful deferred steer duplicated or lost its user row");
            check(state.notifications().some((notification) => notification.message === "Task steered" && notification.tone !== "error"), "Successful queued steering did not report success");

            progress("queued Steer canonical echo adopts before acknowledgement");
            state = await mount({
              sessionState: "working",
              deferQueuedDelivery: true,
              initialQueue: [{ id: "queued-steer-echo", sessionId: "mounted-session", content: "Adopt this canonical steer echo", state: "queued", attachments: [] }],
            });
            element('button[aria-label="Steer with this queued instruction"]').click();
            await settle();
            const optimisticSteerRow = state.snapshot().timelines["mounted-session"].find((item) => item.body === "Adopt this canonical steer echo");
            check(optimisticSteerRow, "The echo race had no optimistic steer presentation to adopt");
            await state.injectTimeline({
              id: "canonical-steer-user",
              messageId: "provider-steer-message",
              kind: "user",
              body: "Adopt this canonical steer echo",
              timestamp: new Date().toISOString(),
              state: "completed",
            });
            let canonicalSteerRows = state.snapshot().timelines["mounted-session"].filter((item) => item.kind === "user" && item.body === "Adopt this canonical steer echo");
            check(canonicalSteerRows.length === 1, "A canonical echo duplicated the pending steer presentation");
            check(canonicalSteerRows[0].id === "canonical-steer-user" && canonicalSteerRows[0].presentationId === optimisticSteerRow.id, "The canonical echo did not adopt the existing steer presentation");
            state.resolveQueuedDelivery();
            await settle(5);
            canonicalSteerRows = state.snapshot().timelines["mounted-session"].filter((item) => item.kind === "user" && item.body === "Adopt this canonical steer echo");
            check(canonicalSteerRows.length === 1 && canonicalSteerRows[0].id === "canonical-steer-user", "Steer acknowledgement remounted or duplicated its adopted canonical row");

            progress("queue cancellation paints before slow refresh and ignores older responses");
            state = await mount({ initialQueue: [
              { id: "cancel-now", sessionId: "mounted-session", content: "Remove this immediately", state: "queued", attachments: [] },
              { id: "cancel-sibling", sessionId: "mounted-session", content: "Keep this sibling", state: "queued", attachments: [] },
            ] });
            state.holdQueueReads();
            await state.refreshQueue();
            await click(element('button[aria-label="Remove queued instruction"]'));
            check(document.querySelectorAll('.queued-message-row').length === 1, "Confirmed removal waited for provider history");
            check(!element('button[aria-label="Remove queued instruction"]').disabled, "A slow refresh kept other queue actions busy");
            await state.resolveQueueRead();
            check(document.querySelectorAll('.queued-message-row').length === 1 && element('.queued-message-row').textContent.includes("Keep this sibling"), "A pre-cancellation queue response resurrected the removed row");
            await state.resolveQueueRead();
            check(document.querySelectorAll('.queued-message-row').length === 1, "The refreshed queue lost its unrelated sibling");

            progress("queue cancellation rejection retains the instruction");
            state = await mount({ initialQueue: [{ id: "cannot-cancel", sessionId: "mounted-session", content: "Already delivering", state: "queued", attachments: [], cancelled: false }] });
            await click(element('button[aria-label="Remove queued instruction"]'));
            check(document.querySelectorAll('.queued-message-row').length === 1, "A rejected removal hid an instruction still owned by the provider");
            check(state.notifications().some(item => item.message.includes("already being sent")), "Rejected cancellation hid its failure");

            progress("ambiguous queued Steer loads one non-retryable tombstone");
            state = await mount({
              sessionState: "working",
              initialQueue: [{ id: "queued-steer-unknown", sessionId: "mounted-session", content: "Do not retry this ambiguous steer", state: "queued", attachments: [] }],
              queuedSteerError: new DesktopBridgeRequestError({
                code: "DELIVERY_UNKNOWN",
                message: "The queued acknowledgement was lost",
                retryable: false,
              }),
            });
            await click(element('button[aria-label="Steer with this queued instruction"]'));
            const unknownQueueRows = [...document.querySelectorAll('.queued-message-row')];
            check(unknownQueueRows.length === 1 && unknownQueueRows[0].textContent?.includes("Do not retry this ambiguous steer"), "Ambiguous queued delivery lost or duplicated its authoritative tombstone");
            check(unknownQueueRows[0].classList.contains('queued-message-failed'), "Ambiguous queued delivery did not paint the authoritative failed state");
            check(unknownQueueRows[0].querySelector('button[aria-label="Steer with this queued instruction"]')?.disabled, "Ambiguous queued delivery exposed a retryable Steer action");
            check(!unknownQueueRows[0].querySelector('button[aria-label="Dismiss delivery notice"]')?.disabled, "Ambiguous queued delivery disabled its safe Dismiss action");
            check(unknownQueueRows[0].querySelector('.queued-delivery-status')?.textContent === "Delivery unconfirmed", "Uncertain delivery appeared as an ordinary waiting instruction");
            await click(unknownQueueRows[0].querySelector('button[aria-label="Queued instruction actions"]'));
            const unknownQueueActions = [...document.querySelectorAll('.queued-message-menu [role="menuitem"]')];
            for (const label of ["Edit message", "Open in side chat", "Send to new task"]) {
              const action = unknownQueueActions.find((candidate) => candidate.textContent?.includes(label));
              check(action?.disabled, "Ambiguous queued delivery enabled " + label);
            }
            check(!state.snapshot().timelines["mounted-session"].some((item) => item.kind === "user" && item.body === "Do not retry this ambiguous steer"), "Ambiguous queued delivery retained its speculative transcript row beside the tombstone");
            check(state.calls.filter((call) => call.type === "message_queue.list").length === 2, "Ambiguous queued delivery did not perform exactly one authoritative recovery read");
            check(state.notifications().some((notification) => notification.message === "The queued acknowledgement was lost" && notification.tone === "error"), "Ambiguous queued delivery did not surface its unresolved status");
            state.holdQueueReads();
            await click(element('button[aria-label="Dismiss delivery notice"]'));
            check(!document.querySelector('.queued-message-row'), "Dismissing an uncertain notice waited for history recovery");
            check(state.notifications().some(item => item.message === "Delivery notice dismissed"), "Dismissal claimed to cancel an instruction the provider may already have accepted");
            await state.resolveQueueRead();

            progress("failed queued Steer restores its original queue position");
            state = await mount({
              sessionState: "working",
              initialQueue: [
                { id: "queued-before", sessionId: "mounted-session", content: "Queue sibling before", state: "queued", attachments: [] },
                { id: "queued-steer-failure", sessionId: "mounted-session", content: "Keep this instruction retryable", state: "queued", attachments: [] },
                { id: "queued-after", sessionId: "mounted-session", content: "Queue sibling after", state: "queued", attachments: [] },
              ],
              queuedSteerFailure: "NoActiveTurn",
            });
            const failedSteerRow = [...document.querySelectorAll('.queued-message-row')].find((row) => row.textContent?.includes("Keep this instruction retryable"));
            check(failedSteerRow, "The target queue row is missing before its failed steer");
            await click(failedSteerRow.querySelector('button[aria-label="Steer with this queued instruction"]'));
            const restoredQueueRows = [...document.querySelectorAll('.queued-message-row')];
            check(restoredQueueRows.length === 3, "A failed queued Steer did not retain exactly its three original siblings");
            check(restoredQueueRows.map((row) => row.querySelector('.queued-message-content > strong')?.textContent).join("|") === "Queue sibling before|Keep this instruction retryable|Queue sibling after", "A failed queued Steer changed its original queue position");
            check(restoredQueueRows[1].classList.contains('queued-message-failed'), "A failed queued Steer restored stale local state instead of the authoritative failed state");
            check(!state.snapshot().timelines["mounted-session"].some((item) => item.kind === "user" && item.body === "Keep this instruction retryable"), "A failed queued Steer left its optimistic transcript row behind");
            check(state.calls.filter((call) => call.type === "message_queue.list").length === 2, "A failed queued Steer did not make exactly one recovery queue read");
            check(state.notifications().some((notification) => notification.message === "NoActiveTurn" && notification.tone === "error"), "A failed queued Steer did not surface its error");

            progress("NoActiveTurn reconciliation retires stale steering and restores ordinary Send");
            state = await mount({
              sessionState: "working",
              initialQueue: [{ id: "stale-working-steer", sessionId: "mounted-session", content: "Keep this after the turn settles", state: "queued", attachments: [] }],
              queuedSteerFailure: "NoActiveTurn",
              queuedSteerSessionStateAfterFailure: "idle",
            });
            await click(element('button[aria-label="Steer with this queued instruction"]'));
            check(state.snapshot().sessions[0]?.state === "idle", "Authoritative inactivity did not replace the stale working session");
            const settledQueueRows = [...document.querySelectorAll('.queued-message-row')];
            check(settledQueueRows.length === 1 && settledQueueRows[0].textContent?.includes("Keep this after the turn settles"), "NoActiveTurn did not preserve exactly one retryable instruction");
            check(!settledQueueRows[0].querySelector('button[aria-label="Steer with this queued instruction"]'), "The stale Steer action remained visible after authoritative inactivity");
            check(!state.snapshot().timelines["mounted-session"].some((item) => item.kind === "user" && item.body === "Keep this after the turn settles"), "NoActiveTurn left an undelivered optimistic user row in the transcript");
            await setField(composer(), "Send after the stale turn retired");
            check(send().getAttribute("aria-label") === "Send instruction", "Ordinary Send was not restored after the stale turn retired");
            await click(send());
            check(state.calls.filter((call) => call.type === "message_queue.deliver").length === 1, "The failed Steer action was invoked more than once");
            check(state.calls.filter((call) => call.type === "session.send_message").length === 1, "The next ordinary submission did not use Send exactly once");
            check(state.calls.filter((call) => call.type === "session.steer_message").length === 0, "The next ordinary submission retained stale steering semantics");

            progress("failed queued Steer trusts an authoritative empty queue");
            state = await mount({
              sessionState: "working",
              initialQueue: [
                { id: "authoritative-before", sessionId: "mounted-session", content: "Authoritative sibling before", state: "queued", attachments: [] },
                { id: "authoritative-empty-target", sessionId: "mounted-session", content: "Do not resurrect this accepted row", state: "queued", attachments: [] },
                { id: "authoritative-after", sessionId: "mounted-session", content: "Authoritative sibling after", state: "queued", attachments: [] },
              ],
              queuedSteerFailure: "Steer acknowledgement was lost",
              queuedSteerRecovery: "empty",
            });
            const authoritativeTarget = [...document.querySelectorAll('.queued-message-row')].find((row) => row.textContent?.includes("Do not resurrect this accepted row"));
            check(authoritativeTarget, "The authoritative-empty target row is missing before its failed steer");
            await click(authoritativeTarget.querySelector('button[aria-label="Steer with this queued instruction"]'));
            const authoritativeRows = [...document.querySelectorAll('.queued-message-row')];
            check(authoritativeRows.map((row) => row.querySelector('.queued-message-content > strong')?.textContent).join("|") === "Authoritative sibling before|Authoritative sibling after", "A successful authoritative empty queue resurrected the closed-over Steer row");
            check(!state.snapshot().timelines["mounted-session"].some((item) => item.kind === "user" && item.body === "Do not resurrect this accepted row"), "Authoritative empty recovery left the failed optimistic transcript row behind");
            check(state.calls.filter((call) => call.type === "message_queue.list").length === 2, "Authoritative empty recovery did not make exactly one post-failure queue read");

            progress("failed queued Steer falls back exactly once when queue recovery is unavailable");
            state = await mount({
              sessionState: "working",
              initialQueue: [
                { id: "fallback-before", sessionId: "mounted-session", content: "Fallback sibling before", state: "queued", attachments: [] },
                { id: "fallback-target", sessionId: "mounted-session", content: "Restore this unavailable-read row once", state: "queued", attachments: [] },
                { id: "fallback-after", sessionId: "mounted-session", content: "Fallback sibling after", state: "queued", attachments: [] },
              ],
              queuedSteerFailure: "NoActiveTurn after queue removal",
              queuedSteerRecovery: "list-failure",
            });
            const fallbackTarget = [...document.querySelectorAll('.queued-message-row')].find((row) => row.textContent?.includes("Restore this unavailable-read row once"));
            check(fallbackTarget, "The unavailable-read target row is missing before its failed steer");
            await click(fallbackTarget.querySelector('button[aria-label="Steer with this queued instruction"]'));
            const fallbackRows = [...document.querySelectorAll('.queued-message-row')];
            check(fallbackRows.length === 3, "A failed queue recovery did not restore exactly the original three rows");
            check(fallbackRows.map((row) => row.querySelector('.queued-message-content > strong')?.textContent).join("|") === "Fallback sibling before|Restore this unavailable-read row once|Fallback sibling after", "A failed queue recovery did not restore the Steer row at its original position");
            check(fallbackRows.filter((row) => row.textContent?.includes("Restore this unavailable-read row once")).length === 1, "A failed queue recovery duplicated its local fallback row");
            check(!state.snapshot().timelines["mounted-session"].some((item) => item.kind === "user" && item.body === "Restore this unavailable-read row once"), "Failed queue recovery left the optimistic Steer row behind");
            check(state.calls.filter((call) => call.type === "message_queue.list").length === 2, "Failed queue recovery did not attempt exactly one authoritative post-failure read");

            progress("image-only mount");
            state = await mount({ initialAttachments: [{ name: "image.png", path: "image.png", mimeType: "image/png", byteLength: 1, dataBase64: "AA==", origin: "file-picker" }] });
            progress("image-only submit");
            await assertSubmittedWithoutInterrupt(state, "message_queue.enqueue");

            progress("file-only mount");
            state = await mount({ providerId: "opencode", initialAttachments: [{ kind: "file", name: "notes.txt", path: "notes.txt", mimeType: "text/plain", byteLength: 1, dataBase64: "QQ==", origin: "file-picker" }] });
            progress("file-only submit");
            await assertSubmittedWithoutInterrupt(state, "message_queue.enqueue");

            progress("twelve mixed attachments, excess paste, removal, and submit");
            const twelveAttachments = Array.from({ length: 12 }, (_, index) => ({
              ...(index % 2 ? { kind: "file" } : {}),
              name: "attachment-" + index + (index % 2 ? ".txt" : ".png"),
              path: "attachment-" + index,
              mimeType: index % 2 ? "text/plain" : "image/png",
              byteLength: 1, dataBase64: "AQ==", origin: "file-picker",
            }));
            state = await mount({ providerId: "opencode", initialAttachments: twelveAttachments });
            check(document.querySelectorAll('.image-attachment-chip, .file-attachment-chip').length === 12, "The composer did not paint all twelve attachments");
            const excessPaste = () => {
              const data = new DataTransfer();
              data.items.add(new File([Uint8Array.of(1)], "extra.png", { type: "image/png" }));
              const event = new Event("paste", { bubbles: true, cancelable: true });
              Object.defineProperty(event, "clipboardData", { value: data });
              composer().dispatchEvent(event);
            };
            const postsBeforeExcess = globalThis.__attachmentWorkerPosts ?? 0;
            excessPaste();
            await settle(5);
            check(state.draft().attachments.length === 12, "Excess paste changed the twelve-item draft");
            check(state.notifications().some(item => item.message.includes("up to 12 items")), "Excess paste did not explain the twelve-item limit");
            check((globalThis.__attachmentWorkerPosts ?? 0) === postsBeforeExcess, "Rejected paste started an unnecessary encoding worker");
            await click(element('button[aria-label="Remove attachment-0.png"]'));
            excessPaste();
            await settle(5);
            check(state.draft().attachments.length === 12 && document.querySelector('button[aria-label="Remove extra.png"]'), "Removing an attachment did not free a slot");
            await assertSubmittedWithoutInterrupt(state, "message_queue.enqueue");
            check(state.calls.find(call => call.type === "message_queue.enqueue")?.payload.attachmentIds?.length === 12, "Twelve mixed attachments did not reach the queue intact");

            progress("image picker rejection preserves draft and explains limit");
            state = await mount({ initialDraft: "Keep this draft", initialAttachments: [twelveAttachments[0]], selectImages: async () => { throw new Error("Choose up to 12 files at a time"); } });
            await click(element('button[aria-label="Add attachment"]'));
            await click(buttonWithText(element('.composer-attachment-menu [role="menu"]'), "Attach image"));
            check(state.notifications().some(item => item.message === "Choose up to 12 files at a time" && item.tone === "error"), "Image picker failure was not surfaced");
            check(state.draft().content === "Keep this draft" && state.draft().attachments.length === 1, "Image picker rejection lost the existing draft");

            progress("voice annotations share the twelve-item submit limit");
            const elevenAudio = Array.from({ length: 11 }, (_, index) => ({ ...earsAudio, name: "clip-" + index + ".mp3", path: "dictation:clip-" + index }));
            const voiceAnnotation = { id: "voice-limit", text: "Selected response", annotation: "", audio: { ...earsAudio, path: "dictation:annotation" } };
            state = await mount({ providerId: "direct", sessionModel: "direct-audio", sessionEffort: "low", initialAttachments: elevenAudio, initialAnnotations: [voiceAnnotation], earsSettings: { enabled: false, providerId: null, modelId: null, mode: "verbatim" } });
            await assertSubmittedWithoutInterrupt(state, "message_queue.enqueue");
            check(state.calls.find(call => call.type === "message_queue.enqueue")?.payload.attachmentIds?.length === 12, "The twelfth attachment from a voice annotation was not sent");
            state = await mount({ providerId: "direct", sessionModel: "direct-audio", sessionEffort: "low", initialAttachments: [...elevenAudio, { ...earsAudio, path: "dictation:twelfth" }], initialAnnotations: [voiceAnnotation], earsSettings: { enabled: false, providerId: null, modelId: null, mode: "verbatim" } });
            await click(send());
            check(state.notifications().some(item => item.message.includes("up to 12 items per message, including voice annotations")), "A thirteenth voice attachment escaped the submit guard");
            check(!state.calls.some(call => call.type === "attachment.upload.begin" || call.type === "message_queue.enqueue"), "Over-limit voice attachments began uploading");
            check(state.draft().attachments.length === 12 && state.draft().annotations.length === 1, "Rejected voice attachments were not preserved for editing");

            progress("OpenCode PDF presentation uses one attachment card");
            const pdfAttachment = { kind: "file", name: "canary.pdf", path: "canary.pdf", mimeType: "application/pdf", byteLength: 1, dataBase64: "QQ==", origin: "file-picker" };
            state = await mount({
              providerId: "opencode",
              sessionModel: "opencode-go/deepseek-v4-pro",
              sessionEffort: "high",
              sessionState: "idle",
              initialDraft: "Read the PDF canary",
              initialAttachments: [pdfAttachment],
              deferDelivery: true,
            });
            send().click();
            await settle(5);
            let pdfRows = state.snapshot().timelines["mounted-session"].filter((item) => item.kind === "user");
            check(pdfRows.length === 1, "The optimistic PDF send did not paint exactly one user row");
            check(pdfRows[0].body === "Read the PDF canary", "The optimistic PDF send duplicated its filename as visible message text");
            check(pdfRows[0].files?.length === 1 && pdfRows[0].files[0].name === "canary.pdf", "The optimistic PDF send lost its attachment card metadata");
            state.resolveDelivery();
            await settle(5);
            pdfRows = state.snapshot().timelines["mounted-session"].filter((item) => item.kind === "user");
            check(pdfRows.length === 1 && pdfRows[0].body === "Read the PDF canary", "The accepted PDF send reintroduced redundant attachment prose");
            check(pdfRows[0].files?.length === 1 && pdfRows[0].files[0].name === "canary.pdf", "The accepted PDF send lost its attachment card");

            progress("OpenCode attachment-only PDF remains a valid user row");
            state = await mount({
              providerId: "opencode",
              sessionModel: "opencode-go/deepseek-v4-pro",
              sessionEffort: "high",
              sessionState: "idle",
              initialAttachments: [pdfAttachment],
            });
            await click(send());
            const attachmentOnlyRows = state.snapshot().timelines["mounted-session"].filter((item) => item.kind === "user");
            check(attachmentOnlyRows.length === 1, "The attachment-only PDF send did not retain one user row");
            check(attachmentOnlyRows[0].body === "", "The attachment-only PDF send exposed synthetic filename prose");
            check(attachmentOnlyRows[0].files?.length === 1 && attachmentOnlyRows[0].files[0].name === "canary.pdf", "The attachment-only PDF row lost its file card");
            const attachmentOnlySend = state.calls.find((call) => call.type === "session.send_message");
            check(attachmentOnlySend?.payload.content === "" && attachmentOnlySend.payload.attachmentIds?.length === 1, "The attachment-only PDF did not reach OpenCode transport intact");

            progress("mixed image and video paste");
            state = await mount({ providerId: "opencode" });
            const clipboard = new DataTransfer();
            clipboard.items.add(new File([Uint8Array.of(1)], "pasted-image.png", { type: "image/png" }));
            clipboard.items.add(new File([Uint8Array.of(2)], "pasted-video.mp4", { type: "video/mp4" }));
            const paste = new Event("paste", { bubbles: true, cancelable: true });
            Object.defineProperty(paste, "clipboardData", { value: clipboard });
            const postsBeforePaste = globalThis.__attachmentWorkerPosts ?? 0;
            flushSync(() => composer().dispatchEvent(paste));
            check(document.querySelector('.image-attachment-chip'), "Pasted image widget was not painted in the accepting event");
            check((globalThis.__attachmentWorkerPosts ?? 0) === postsBeforePaste, "Pasted attachment encoding started before its widget could paint");
            await settle(5);
            check(document.querySelector('.image-attachment-chip'), "Pasted image lost its image widget: " + JSON.stringify(state.notifications()));
            check(document.querySelector('.file-attachment-chip')?.textContent?.includes("pasted-video.mp4"), "Pasted video did not become a file widget");
            check((globalThis.__attachmentWorkerPosts ?? 0) > postsBeforePaste, "Accepted pasted attachments never reached the encoding worker");
            check((globalThis.__attachmentWorkerPostsWithoutWidget ?? 0) === 0, "Attachment encoding started before a pending widget was visible");
            await assertSubmittedWithoutInterrupt(state, "message_queue.enqueue");

            progress("remove pasted image before worker start");
            const removableClipboard = new DataTransfer();
            removableClipboard.items.add(new File([Uint8Array.of(3)], "remove-before-start.png", { type: "image/png" }));
            const removablePaste = new Event("paste", { bubbles: true, cancelable: true });
            Object.defineProperty(removablePaste, "clipboardData", { value: removableClipboard });
            flushSync(() => composer().dispatchEvent(removablePaste));
            const postsBeforeRemoval = globalThis.__attachmentWorkerPosts ?? 0;
            flushSync(() => element('button[aria-label="Remove remove-before-start.png"]').click());
            check(!document.querySelector('button[aria-label="Remove remove-before-start.png"]'), "Removed pasted image stayed painted");
            await settle(5);
            check((globalThis.__attachmentWorkerPosts ?? 0) === postsBeforeRemoval, "Removing a pasted image before worker start did not cancel its preparation");
            check(globalThis.__attachmentWorkerConstructions === 1, "Attachment worker was rebuilt during normal Composer remounts or pastes");

            progress("workflow-only mount");
            state = await mount();
            await click(element('button[aria-label="Add attachment"]'));
            progress("workflow picker open");
            await click(buttonWithText(element('.composer-attachment-menu [role="menu"]'), "Attach workflow"));
            check(element('.workflow-chat-picker').contains(document.activeElement), "Workflow picker did not own focus after opening");
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
            check(!document.querySelector('.workflow-chat-picker'), "Escape did not close the Workflow picker");
            check(document.activeElement === composer(), "Escape did not restore Composer focus after Workflow picker");
            await click(element('button[aria-label="Add attachment"]'));
            await click(buttonWithText(element('.composer-attachment-menu [role="menu"]'), "Attach workflow"));
            document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            await settle();
            check(!document.querySelector('.workflow-chat-picker'), "Outside click did not close the Workflow picker");
            await click(element('button[aria-label="Add attachment"]'));
            await click(buttonWithText(element('.composer-attachment-menu [role="menu"]'), "Attach workflow"));
            await click(buttonWithText(element('.workflow-chat-picker'), "Checkout workflow"));
            check(document.activeElement === composer(), "Workflow selection did not restore Composer focus");
            check(document.querySelector('.workflow-attachment-chip'), "Workflow attachment widget did not appear");
            const persistedWorkflows = state.workflowDraft();
            check(persistedWorkflows.length === 1 && persistedWorkflows[0].id === "workflow-one", "Workflow draft callback did not preserve the selection");
            state = await mount({ initialWorkflowAttachments: persistedWorkflows });
            check(document.querySelector('.workflow-attachment-chip')?.textContent?.includes("Checkout workflow"), "Workflow widget did not survive a Composer remount");
            progress("workflow-only submit");
            await assertSubmittedWithoutInterrupt(state, "message_queue.enqueue");
            const workflowCall = state.calls.find((call) => call.type === "message_queue.enqueue");
            check(workflowCall?.payload.workflowIds?.[0] === "workflow-one", "Workflow id was not submitted");

            progress("workflow delayed list focus");
            workflowListMode = "delayed";
            state = await mount();
            await click(element('button[aria-label="Add attachment"]'));
            await click(buttonWithText(element('.composer-attachment-menu [role="menu"]'), "Attach workflow"));
            check(element('.workflow-chat-picker').textContent?.includes("Loading workflows"), "Delayed workflow list did not paint a loading state");
            check(document.activeElement?.getAttribute("aria-label") !== "Close workflows", "Workflow picker focused Close while its list was loading");
            check(resolveDelayedWorkflowList, "Delayed workflow list resolver was not installed");
            resolveDelayedWorkflowList();
            await settle(5);
            check(document.activeElement?.getAttribute("data-workflow-id") === "workflow-one", "Loaded workflow row did not receive focus");
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
            check(document.activeElement === composer(), "Closing the delayed Workflow picker did not restore Composer focus");

            progress("workflow list and attachment recovery");
            workflowListMode = "reject-once";
            const listRequestsBefore = workflowListRequests;
            state = await mount();
            await click(element('button[aria-label="Add attachment"]'));
            await click(buttonWithText(element('.composer-attachment-menu [role="menu"]'), "Attach workflow"));
            await settle(5);
            check(document.querySelector('.workflow-chat-picker'), "Workflow list failure dismissed the picker");
            check(element('.workflow-picker-error').textContent?.includes("Couldn’t load recorded workflows"), "Workflow list failure was not shown inline");
            await click(buttonWithText(element('.workflow-picker-error'), "Try again"));
            await settle(5);
            check(workflowListRequests === listRequestsBefore + 2, "Workflow list retry did not make exactly one additional request");
            const recoveredWorkflow = element('button[data-workflow-id="workflow-one"]');
            check(document.activeElement === recoveredWorkflow, "Recovered workflow list did not focus its first enabled row");
            workflowAttachmentFailures = 1;
            const attachmentRequestsBefore = workflowAttachmentRequests;
            await click(recoveredWorkflow);
            check(document.querySelector('.workflow-chat-picker'), "Workflow attachment failure dismissed the picker");
            check(element('.workflow-picker-error').textContent?.includes("Couldn’t attach Checkout workflow"), "Workflow attachment failure was not shown inline");
            check(element('button[data-workflow-id="workflow-one"]') && !element('button[data-workflow-id="workflow-one"]').disabled, "Workflow attachment failure discarded or disabled the selection");
            await click(buttonWithText(element('.workflow-picker-error'), "Try again"));
            check(workflowAttachmentRequests === attachmentRequestsBefore + 2, "Workflow attachment retry did not make exactly one additional request");
            check(!document.querySelector('.workflow-chat-picker'), "Successful workflow attachment retry did not close the picker");
            check(document.activeElement === composer(), "Successful workflow attachment retry did not restore Composer focus");
            check(document.querySelector('.workflow-attachment-chip'), "Successful workflow attachment retry did not paint its widget");

            progress("annotation remove and recreate");
            const removedAnnotation = { id: "annotation-old", text: "Selected response", annotation: "Old comment" };
            state = await mount({ initialAnnotations: [removedAnnotation] });
            check(document.querySelectorAll('.composer-annotation-chip').length === 1, "Initial annotation chip was not restored");
            element('button[aria-label="Remove annotation 1"]').click();
            // Read persistence immediately, before any passive effect can run.
            // Recreating from this exact draft used to append to the deleted chip.
            const recreatedDraft = [...state.annotationDraft(), { id: "annotation-new", text: "Selected response", annotation: "New comment" }];
            check(recreatedDraft.length === 1, "Annotation removal was not persisted before recreation");
            state = await mount({ initialAnnotations: recreatedDraft });
            check(document.querySelectorAll('.composer-annotation-chip').length === 1, "Remove then recreate painted duplicate annotation chips");
            check(state.annotationDraft().length === 1 && state.annotationDraft()[0].id === "annotation-new", "Recreated annotation draft was not persisted exactly once");

            progress("delegation dismissal focus");
            state = await mount();
            await openAction("Delegate task");
            element('.delegation-chat-picker textarea').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
            check(!document.querySelector('.delegation-chat-picker'), "Escape did not close delegation");
            check(document.activeElement === composer(), "Escape did not restore Composer focus after delegation");
            await openAction("Delegate task");
            await click(buttonWithText(element('.delegation-chat-picker'), "Cancel"));
            check(document.activeElement === composer(), "Delegation Cancel did not restore Composer focus");
            await openAction("Delegate task");
            await click(element('button[aria-label="Close delegation"]'));
            check(document.activeElement === composer(), "Delegation close did not restore Composer focus");
            await openAction("Delegate task");
            const focusableOutsideDelegation = element('button[aria-label="Add attachment"]');
            focusableOutsideDelegation.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            focusableOutsideDelegation.focus();
            await settle();
            check(!document.querySelector('.delegation-chat-picker'), "Focusable outside click did not close delegation");
            check(document.activeElement === focusableOutsideDelegation, "Delegation stole focus back from the clicked outside control");
            await openAction("Delegate task");
            document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            await settle();
            check(!document.querySelector('.delegation-chat-picker'), "Non-focusable outside click did not close delegation");
            check(document.activeElement === composer(), "Non-focusable outside click did not return focus to the Composer");

            progress("delegation catalogue hydration");
            state = await mount();
            await openAction("Delegate task");
            const delegation = element('.delegation-chat-picker');
            const delegationPrompt = element('.delegation-chat-picker textarea');
            await setField(delegationPrompt, "Keep this delegation prompt");
            await click(buttonWithText(delegation, "Grok Build"));
            check(state.grokCatalogueRequests() === 1, "Selecting Grok did not request its real model catalogue exactly once");
            check(element('.delegation-catalogue-status').textContent?.includes("Refreshing Grok Build models"), "Grok catalogue loading state was not painted");
            check(element('select[aria-label="Delegation model"]').value === "grok-stale", "Catalogue loading discarded the current Grok choice");
            check(delegationPrompt.value === "Keep this delegation prompt", "Catalogue loading discarded the delegation prompt");
            state.rejectGrokCatalogue();
            await settle(5);
            check(element('.delegation-catalogue-error').textContent?.includes("Showing the last loaded choices"), "Catalogue failure did not preserve the panel with a useful error");
            check(element('select[aria-label="Delegation model"]').value === "grok-stale", "Catalogue failure discarded the last loaded Grok choice");
            check(delegationPrompt.value === "Keep this delegation prompt", "Catalogue failure discarded the delegation prompt");
            await click(buttonWithText(element('.delegation-catalogue-error'), "Try again"));
            await settle(5);
            check(state.grokCatalogueRequests() === 2, "Catalogue retry did not make exactly one additional Grok request");
            check(!document.querySelector('.delegation-catalogue-error') && !document.querySelector('.delegation-catalogue-status'), "Successful catalogue retry left stale loading or error UI");
            check(state.snapshot().models.grok.map((model) => model.id).join(",") === "grok-4.6,grok-4.5", "Grok catalogue was not committed into the shared snapshot");
            const delegationModel = element('select[aria-label="Delegation model"]');
            check([...delegationModel.options].map((option) => option.value).join(",") === "grok-4.6,grok-4.5", "Delegate panel did not paint the hydrated Grok models");
            delegationModel.value = "grok-4.5";
            delegationModel.dispatchEvent(new Event("change", { bubbles: true }));
            await settle();
            await click(buttonWithText(element('.delegation-chat-picker'), "Delegate"));
            const delegationCall = state.calls.find((call) => call.type === "delegation.prepare");
            check(delegationCall?.payload.targets?.[0]?.providerId === "grok" && delegationCall.payload.targets[0].modelId === "grok-4.5", "Hydrated Grok model was not sent to the real delegation boundary");
            check(JSON.stringify(delegationCall?.payload.presentationSegments) === JSON.stringify([{ type: "mesh", targetIndex: 0 }, { type: "text", text: "Keep this delegation prompt" }]), "Delegate did not preserve the ordered target-and-text presentation");
            check(delegationCall?.payload.modelId === "codex-model" && delegationCall.payload.reasoningEffort === "medium", "Delegate did not preserve the parent Composer model selection");
            check(!state.calls.some((call) => call.type === "delegation.start"), "Delegate bypassed parent orchestration through the legacy direct-spawn route");
            check(document.activeElement === composer(), "Successful delegation did not restore Composer focus");

            progress("eyes flows");
            await mount();
            await openAction("EYES settings");
            check(element('.vision-eyes-picker').contains(document.activeElement), "EYES did not own focus after opening");
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
            check(!document.querySelector('.vision-eyes-picker'), "Escape did not close EYES");
            check(document.activeElement === composer(), "Escape did not restore Composer focus after EYES");
            await openAction("EYES settings");
            document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            await settle();
            check(!document.querySelector('.vision-eyes-picker'), "Outside click did not close EYES");
            await openAction("EYES settings");
            await click(element('button[aria-label="Close vision model selection"]'));
            check(document.activeElement === composer(), "EYES close did not restore Composer focus");

            progress("handoff flows");
            await openAction("Context Handoff");
            check(element('.handoff-chat-picker').contains(document.activeElement), "Context Handoff did not own focus after opening");
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
            check(!document.querySelector('.handoff-chat-picker'), "Escape did not close Context Handoff");
            check(document.activeElement === composer(), "Escape did not restore Composer focus after Context Handoff");
            await openAction("Context Handoff");
            document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            await settle();
            check(!document.querySelector('.handoff-chat-picker'), "Outside click did not close Context Handoff");
            await openAction("Context Handoff");
            await click(element('button[aria-label="Close context handoff"]'));
            check(document.activeElement === composer(), "Context Handoff close did not restore Composer focus");

            progress("mesh mount");
            localStorage.removeItem("tethoq:mesh-recent-targets:v1");
            state = await mount();
            await setField(composer(), "/mesh");
            check(send().disabled, "Command-only /mesh left an interrupt or empty-send action enabled");
            check(send().getAttribute("aria-label") !== "Stop task", "Command-only /mesh was mislabeled as Stop task");
            check(buttonWithText(element('.mesh-panel'), "Mesh 1").textContent?.includes("Mesh 1 Model · Medium"), "Mesh quick row hid its model or reasoning");
            check(element('.mesh-add-row.selected').textContent?.includes("Codex"), "Mesh did not offer its own provider as the first quick target");
            await pressKey(composer(), "ArrowDown");
            check(element('.mesh-add-row.selected').textContent?.includes("OpenCode"), "Mesh ArrowDown did not move the quick selection");
            await pressKey(composer(), "ArrowUp");
            check(element('.mesh-add-row.selected').textContent?.includes("Codex"), "Mesh ArrowUp did not move the quick selection");
            await pressKey(composer(), "ArrowUp");
            check(element('.mesh-add-row.selected').textContent?.includes("Mesh 5"), "Mesh ArrowUp did not wrap to the final quick target");
            await pressKey(composer(), "ArrowDown");
            await pressKey(composer(), "ArrowDown");
            await pressKey(composer(), "Enter");
            check(!document.querySelector('.mesh-panel'), "Mesh Enter did not close the quick chooser");
            check(element('button[aria-label="Edit OpenCode target"]').title.includes("DeepSeek V4 Pro"), "Mesh Enter did not insert the highlighted target widget");
            check(element('.composer-mesh-widget').getAttribute("data-provider-id") === "opencode", "Mesh widget lost the selected provider identity used by its outline");
            await click(element('button[aria-label="Remove OpenCode from mesh"]'));

            await setField(composer(), "/mesh");
            element('.mesh-panel .mesh-add-label').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            await settle();
            check(document.querySelector('.mesh-panel'), "Clicking inside the Mesh target panel closed it");
            await click(element('button[aria-label="Choose model and reasoning for Mesh 1"]'));
            check(plainComposerValue() === "/mesh" && !document.querySelector('.composer-inline-mesh'), "Mesh disclosure committed instead of opening details");
            check(element('.mesh-model-picker-search input') === document.activeElement, "Mesh details did not focus model search");
            check(element('.mesh-model-picker-reasoning').closest('.mesh-model-picker-scroll') === null, "Mesh reasoning remained trapped in the scrolling model list");
            check([...element('.mesh-model-picker-reasoning-options').querySelectorAll('button[role="radio"]')].map((button) => button.textContent?.trim()).join(",") === "Medium", "Mesh reasoning did not start with exactly the selected model's efforts");
            check(!document.querySelector('.mesh-panel'), "Mesh quick choices remained stacked behind the detailed picker");
            element('.mesh-model-picker-title').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            await settle();
            check(document.querySelector('.mesh-model-picker'), "Clicking inside the Mesh model picker closed it");
            await setField(composer(), "/mesh changed");
            check(!document.querySelector('.mesh-panel') && document.querySelector('.mesh-model-picker'), "A valid mid-draft /mesh token closed its detailed picker");
            await setField(composer(), "tool/mesh changed");
            check(!document.querySelector('.mesh-panel') && !document.querySelector('.mesh-model-picker'), "Embedded non-command mesh text left a Mesh dialog orphaned");
            await setField(composer(), "");

            progress("mesh accepted per-session recency");
            await setField(composer(), "/mesh");
            await click(element('button[aria-label="Choose model and reasoning for Mesh 1"]'));
            const meshSearch = element('.mesh-model-picker-search input');
            await setField(meshSearch, "aLtErNaTe");
            check(element('.mesh-model-picker-scroll').querySelectorAll('button[role="radio"]').length === 1 && buttonWithText(element('.mesh-model-picker-scroll'), "Mesh 1 Alternate"), "Mesh search did not filter model names case-insensitively");
            check(buttonWithText(element('.mesh-model-picker-reasoning-options'), "Medium").getAttribute("aria-checked") === "true", "Filtering Mesh models changed the selected reasoning");
            const searchHome = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
            meshSearch.dispatchEvent(searchHome);
            check(!searchHome.defaultPrevented && document.activeElement === meshSearch, "Mesh search intercepted text-editing keys");
            await pressKey(meshSearch, "ArrowDown");
            check(document.activeElement === buttonWithText(element('.mesh-model-picker-scroll'), "Mesh 1 Alternate"), "Mesh search did not support keyboard selection of a result");
            check([...element('.mesh-model-picker-reasoning-options').querySelectorAll('button[role="radio"]')].map((button) => button.textContent?.trim()).join(",") === "High,Max", "Changing the Mesh model did not replace the visible reasoning choices");
            await click(buttonWithText(element('.mesh-model-picker-reasoning-options'), "High"));
            check(buttonWithText(element('.mesh-model-picker-reasoning-options'), "High").getAttribute("aria-checked") === "true", "Mesh reasoning could not be selected directly");
            await click(buttonWithText(element('.mesh-model-picker-reasoning-options'), "Max"));
            meshSearch.focus();
            await setField(meshSearch, "no-such-model");
            check(element('.mesh-model-empty').textContent?.includes("No matching models") && !document.querySelector('.mesh-model-picker-scroll button[role="radio"]'), "Mesh search did not explain an empty result");
            await pressKey(meshSearch, "ArrowDown");
            check(document.activeElement === meshSearch && buttonWithText(element('.mesh-model-picker-reasoning-options'), "Max").getAttribute("aria-checked") === "true", "An empty Mesh search changed focus or reasoning");
            await setField(meshSearch, "");
            check(element('.mesh-model-picker-scroll').querySelectorAll('button[role="radio"]').length === 2 && buttonWithText(element('.mesh-model-picker-scroll'), "Mesh 1 Alternate").getAttribute("aria-checked") === "true", "Clearing Mesh search did not restore models and preserve the selection");
            await click(buttonWithText(element('.mesh-model-picker'), "Add to mesh"));
            check(element('button[aria-label="Edit Mesh 1 target"]').title.includes("Mesh 1 Alternate · Max"), "Mesh detail choice did not paint its concrete reasoning");
            await setField(composer(), "Remember this Mesh target");
            await click(send());
            check(!document.querySelector('.composer-inline-mesh'), "Successful Mesh send left its accepted target in the composer");
            await setField(composer(), "/mesh");
            check(buttonWithText(element('.mesh-panel'), "Mesh 1").textContent?.includes("Mesh 1 Alternate · Max"), "Mesh did not restore the parent session's last accepted model and reasoning");
            await setField(composer(), "");

            for (let index = 1; index <= 4; index += 1) {
              progress("mesh add " + index);
              await setField(composer(), "/mesh");
              await click(buttonWithText(element('.mesh-panel'), "Mesh " + index));
              check(!document.querySelector('.mesh-panel') && document.querySelector('.composer-inline-mesh'), "Mesh quick click did not commit target " + index);
            }
            check(state.meshTwoCatalogueRequests() === 1, "Mesh did not hydrate the uncached second provider exactly once");
            check(element('button[aria-label="Edit Mesh 2 target"]').title.includes("Mesh 2 Hydrated"), "Late Mesh catalogue did not select and paint its provider default");
            progress("mesh edit fourth");
            await click(element('button[aria-label="Edit Mesh 4 target"]'));
            check(buttonWithText(element('.mesh-model-picker'), "Save target"), "Fourth mesh target could not be edited at the cap");
            await click(element('button[aria-label="Close model picker"]'));
            check(document.activeElement === composer(), "Mesh model close did not restore Composer focus");
            progress("mesh fifth blocked");
            await setField(composer(), "/mesh");
            check(![...element('.mesh-panel').querySelectorAll("button")].some((button) => button.textContent?.includes("Mesh 5")), "A fifth mesh target was offered");
            document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            await settle();
            check(!document.querySelector('.mesh-panel'), "Outside click did not close Mesh");
            check(document.activeElement === composer(), "Mesh outside click did not restore Composer focus");
            await setField(composer(), "");
            await setField(composer(), "/mesh");
            await click(element('button[aria-label="Close mesh panel"]'));
            check(document.activeElement === composer(), "Mesh close did not restore Composer focus");

            progress("Mesh supports the current provider");
            const savedMeshRecency = localStorage.getItem("tethoq:mesh-recent-targets:v1");
            for (const ownProviderId of ["codex", "opencode", "grok", "mesh-1"]) {
              state = await mount({ providerId: ownProviderId });
              await setField(composer(), "Ask /mesh to review this");
              const ownProviderName = providers.find((item) => item.id === ownProviderId).name;
              await click(buttonWithText(element('.mesh-panel'), ownProviderName));
              check(element('.composer-mesh-widget').dataset.providerId === ownProviderId, "Mesh did not insert a target from its own provider: " + ownProviderId);
              await click(send());
              const ownPrepare = state.calls.find((call) => call.type === "delegation.prepare");
              check(ownPrepare?.payload.targets[0]?.providerId === ownProviderId, "Mesh dropped its own provider on send: " + ownProviderId);
            }
            if (savedMeshRecency === null) localStorage.removeItem("tethoq:mesh-recent-targets:v1");
            else localStorage.setItem("tethoq:mesh-recent-targets:v1", savedMeshRecency);

            progress("slash completion follows the caret after Mesh");
            state = await mount();
            await setField(composer(), "/");
            await click(buttonWithText(element('.slash-command-palette'), "/mesh"));
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            const inlineToken = composer().value.match(/[\uE000-\uF8FF]/u)[0];
            document.execCommand("insertText", false, "/");
            await settle();
            check(document.querySelector('.slash-command-palette'), "A slash immediately after a Mesh badge must suggest commands before the trailing space");
            await click(buttonWithText(element('.slash-command-palette'), "/mesh"));
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            check(document.querySelectorAll('.composer-mesh-widget').length === 2 && composer().value.startsWith(inlineToken), "Completing a command at the caret erased an existing badge");
            document.execCommand("insertLineBreak");
            document.execCommand("insertText", false, "/");
            await settle();
            check(document.querySelector('.slash-command-palette'), "Slash suggestions must work on the new line after Mesh");
            await click(buttonWithText(element('.slash-command-palette'), "/mesh"));
            await click(buttonWithText(element('.mesh-panel'), "Mesh 2"));
            check(composer().value.includes("\n") && document.querySelectorAll('.composer-mesh-widget').length === 3, "A new-line Mesh insertion lost the newline or an existing target");
            await setField(composer(), "Ask " + inlineToken + "  keep this suffix", false);
            const middleCaret = composer().value.indexOf(" keep");
            composer().setSelectionRange(middleCaret, middleCaret);
            document.execCommand("insertText", false, "/");
            await settle();
            check(document.querySelector('.slash-command-palette'), "Typing a slash in existing text did not suggest commands at the caret");
            await click(buttonWithText(element('.slash-command-palette'), "/mesh"));
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            check(composer().value.startsWith("Ask " + inlineToken) && composer().value.endsWith(" keep this suffix"), "Completing a middle-of-message command changed surrounding text");

            progress("repeated inline Mesh references");
            state = await mount();
            await setField(composer(), "Ask /mesh about caching", false);
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            const firstToken = composer().value.match(/[\uE000-\uF8FF]/u)[0];
            check(composer().value.startsWith("Ask " + firstToken), "Mesh reference was not inserted at the command");
            await setField(composer(), composer().value + " then /mesh about retries", false);
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            check(document.querySelectorAll('.composer-mesh-widget').length === 2, "The same provider could not be selected twice");
            const secondToken = composer().value.match(/[\uE000-\uF8FF]/gu)[1];
            await setField(composer(), "First line\n" + composer().value, false);
            check(composer().value.startsWith("First line\nAsk " + firstToken), "References did not move with preceding text");
            await click(document.querySelectorAll('button[aria-label="Edit Mesh 1 target"]')[1]);
            await click(buttonWithText(element('.mesh-model-picker'), "Save target"));
            check(document.querySelectorAll('.composer-mesh-widget').length === 2, "Editing one duplicate replaced the other target");
            await setField(composer(), composer().value.replace(firstToken, ""), false);
            check(document.querySelectorAll('.composer-mesh-widget').length === 1 && composer().value.includes(secondToken), "Deleting one reference removed its sibling");
            await setField(composer(), composer().value.replace("Ask ", "Ask " + firstToken), false);
            check(document.querySelectorAll('.composer-mesh-widget').length === 2, "Restoring a deleted marker lost its target");
            const beforePaste = composer().value;
            composer().focus();
            composer().setSelectionRange(0, 0);
            const pasted = new DataTransfer();
            pasted.setData("text/plain", "Pasted first line\nPasted second line\n");
            composer().dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: pasted }));
            await settle();
            check(composer().value === "Pasted first line\nPasted second line\n" + beforePaste, "Multiline paste changed the prose or Mesh positions");
            const afterSecond = composer().value.indexOf(secondToken) + 1;
            composer().setSelectionRange(afterSecond, afterSecond);
            document.execCommand("insertText", false, "m");
            await settle();
            check(composer().value[afterSecond] === "m", "The caret after a badge drifted after multiline paste");
            composer().setSelectionRange(0, composer().value.length);
            const copied = new DataTransfer();
            composer().dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: copied }));
            check(!/[\uE000-\uF8FF]/u.test(copied.getData("text/plain")) && copied.getData("text/plain").includes("@Mesh 1"), "Copying badges must expose readable model names");
            await setField(composer(), "  " + composer().value + "  ", false);
            const beforeTrimmedSend = composer().value.trim();
            await click(send());
            const repeated = state.calls.find((call) => call.type === "delegation.prepare");
            check(repeated.payload.targets.length === 2 && repeated.payload.targets.every((target) => target.providerId === "mesh-1"), "Duplicate targets were lost on submission");
            check(!/[\uE000-\uF8FF]/u.test(JSON.stringify(repeated.payload)), "Private editor markers leaked into the request");
            check(repeated.payload.presentationSegments.map((segment) => segment.type).join(",") === "text,mesh,text,mesh,text", "Sent references lost their inline order");
            check(repeated.payload.presentationSegments.map((segment) => segment.type === "text" ? segment.text : [firstToken, secondToken][segment.targetIndex]).join("") === beforeTrimmedSend, "Trimming whitespace moved Mesh references away from their surrounding text");

            progress("mesh delivery keeps follow-up composition");
            state = await mount({ deferDelegation: true });
            await setField(composer(), "/mesh");
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            await setField(composer(), "First mesh instruction");
            await click(send());
            const pendingMeshRow = state.snapshot().timelines["mounted-session"][0];
            check(pendingMeshRow?.body === "First mesh instruction" && pendingMeshRow.mesh?.targets.length === 1, "Mesh must paint the complete message and badges before delivery resolves");
            check(state.calls.find((call) => call.type === "delegation.prepare").requestId === pendingMeshRow.delegationId, "Mesh transport and presentation need the same stable identity");
            await state.injectTimeline({ id: "mesh-provider-echo", messageId: "mesh-provider-message", kind: "user", body: "[Mesh target 0: mesh-1 / mesh-1-alternate / max]" + pendingMeshRow.body, timestamp: pendingMeshRow.timestamp, state: "completed" });
            check(state.snapshot().timelines["mounted-session"].length === 1 && state.snapshot().timelines["mounted-session"][0].mesh?.targets.length === 1, "The provider echo duplicated the Mesh message or erased its badges");
            check(state.snapshot().timelines["mounted-session"][0].body === pendingMeshRow.body, "The provider's routing references replaced the visible Mesh prompt");
            check(plainComposerValue() === "", "Mesh send did not clear the submitted prompt immediately");
            check(!document.querySelector('.composer-inline-mesh'), "Mesh send left submitted targets in the live composer");
            const preparedMeshCall = state.calls.find((call) => call.type === "delegation.prepare");
            check(JSON.stringify(preparedMeshCall?.payload.targets) === JSON.stringify([{ providerId: "mesh-1", modelId: "mesh-1-alternate", reasoningEffort: "max" }]), "Mesh did not preserve its selected worker route");
            check(JSON.stringify(preparedMeshCall?.payload.presentationSegments) === JSON.stringify([{ type: "mesh", targetIndex: 0 }, { type: "text", text: "First mesh instruction" }]), "Mesh did not preserve target-first visible ordering for the parent");
            check(preparedMeshCall?.payload.modelId === "codex-model" && preparedMeshCall.payload.reasoningEffort === "medium", "Mesh did not send the active parent model and reasoning selection");
            check(!state.calls.some((call) => call.type === "delegation.start"), "Mesh used the legacy raw-prompt child route");
            await setField(composer(), "Follow-up typed while mesh starts");
            state.resolveDelegation();
            await settle(5);
            check(plainComposerValue() === "Follow-up typed while mesh starts", "Successful Mesh delivery erased follow-up typing");
            check(!send().disabled, "Successful Mesh delivery left the composer stuck in its sending state");

            await setField(composer(), "/mesh");
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            await setField(composer(), "Failed mesh instruction");
            await click(send());
            await setField(composer(), "Follow-up after failed mesh");
            state.rejectDelegation(new Error("Injected Mesh failure"));
            await settle(5);
            check(!state.snapshot().timelines["mounted-session"].some((item) => item.body === "Failed mesh instruction"), "A rejected Mesh send left a false sent message behind");
            check(plainComposerValue() === "Failed mesh instruction\n\nFollow-up after failed mesh", "Failed Mesh delivery did not merge the submitted prompt with follow-up typing");
            check(document.querySelector('.composer-inline-mesh'), "Failed Mesh delivery did not restore its targets");
            check(!send().disabled, "Failed Mesh delivery left the composer stuck in its sending state");

            progress("uncertain Mesh delivery retains the sent message");
            state = await mount({ deferDelegation: true });
            await setField(composer(), "/mesh");
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            await setField(composer(), "Do not duplicate an uncertain send");
            await click(send());
            state.rejectDelegation(new DesktopBridgeRequestError({ code: "DELIVERY_UNKNOWN", message: "Provider acceptance is still being checked", retryable: false }));
            await settle(5);
            check(state.snapshot().timelines["mounted-session"].length === 1 && state.snapshot().timelines["mounted-session"][0].mesh?.targets.length === 1, "Uncertain delivery erased the submitted Mesh message");
            check(plainComposerValue() === "" && !document.querySelector('.composer-mesh-widget'), "Uncertain delivery restored a duplicate Mesh send into the composer");

            progress("recent mesh mentions");
            const mentionStorageKeys = ["tethoq:mesh-recent-targets:v1", "tethoq:mesh-recent-models:v1"];
            const mentionStorageBackup = mentionStorageKeys.map((key) => localStorage.getItem(key));
            for (const key of mentionStorageKeys) localStorage.removeItem(key);
            state = await mount({ deferDelegation: true });
            await setField(composer(), "@");
            check(element('.mesh-mention-panel').textContent.includes("Use /mesh"), "First-use mentions did not explain how to populate recent models");
            await pressKey(composer(), "Enter");
            check(!state.calls.some((call) => ["delegation.prepare", "message_queue.enqueue", "session.send"].includes(call.type)), "Enter on an empty mention picker sent the draft");
            await pressKey(composer(), "Escape");
            check(!document.querySelector('.mesh-mention-panel') && composer().value === "@", "Escape changed the mention draft");
            for (const prose of ["user@grok.com", "https://example.test/@grok"]) {
              await setField(composer(), prose);
              check(!document.querySelector('.mesh-mention-panel'), "An email or URL opened the mention picker");
            }
            await setField(composer(), "/mesh");
            await click(buttonWithText(element('.mesh-panel'), "Mesh 1"));
            check(recentMeshModels().length === 0, "Selecting without sending populated mesh history");
            await click(send());
            check(recentMeshModels().length === 0, "Pending delegation populated mesh history");
            state.resolveDelegation();
            await settle(5);
            await setField(composer(), "@");
            check(element('.mesh-mention-panel [role="option"]').textContent.includes("Mesh 1"), "Accepted mesh usage did not immediately enable mentions");

            const mentionFixtures = [
              { providerId: "mesh-1", modelId: "mesh-1-model", reasoningEffort: "medium" },
              { providerId: "direct", modelId: "direct-audio", reasoningEffort: "low" },
              { providerId: "codex", modelId: "codex-model", reasoningEffort: "medium" },
              { providerId: "opencode", modelId: "opencode-go/deepseek-v4-pro", reasoningEffort: "high" },
              { providerId: "opencode", modelId: "opencode-go/glm-5.3-flash", reasoningEffort: "max" },
              { providerId: "grok", modelId: "grok-stale", reasoningEffort: "medium" },
            ];
            for (const target of mentionFixtures) persistMeshRecentTargetsForSession("another-parent", [target]);
            state = await mount();
            await setField(composer(), "@");
            check(document.querySelectorAll('.mesh-mention-panel [role="option"]').length === 5, "Mentions did not retain exactly five models across tasks");
            await pressKey(composer(), "ArrowUp");
            check(element('.mesh-mention-row.selected').textContent.includes("Direct Audio"), "Mention ArrowUp did not wrap");
            await pressKey(composer(), "ArrowDown");
            check(element('.mesh-mention-row.selected').textContent.includes("Previously loaded Grok"), "Mention ArrowDown did not wrap");
            await setField(composer(), "@g");
            check(document.querySelectorAll('.mesh-mention-panel [role="option"]').length === 2, "@g did not narrow the recent models");
            await setField(composer(), "@GL");
            check(document.querySelectorAll('.mesh-mention-panel [role="option"]').length === 1, "Mention prefixes were not case insensitive");
            await pressKey(composer(), "Enter", { isComposing: true });
            check(!document.querySelector('.composer-mesh-widget'), "IME composition committed a model");
            await pressKey(composer(), "Enter");
            check(element('.composer-mesh-widget-body').title === "GLM 5.3 Flash · Max", "Mention selection lost the saved model or reasoning");
            const mentionBadge = composer().value;
            check(mentionBadge.length === 1 && !document.querySelector('.mesh-mention-panel'), "Mention text was not replaced by one badge");
            check(composer().selectionStart === 1 && document.activeElement === composer(), "Mention selection lost the caret");

            await setField(composer(), "Compare @grok suffix " + mentionBadge, false);
            const mentionCaret = "Compare @g".length;
            composer().setSelectionRange(mentionCaret, mentionCaret);
            document.dispatchEvent(new Event("selectionchange"));
            await settle();
            await click(element('.mesh-mention-row .mesh-add-select'));
            check(plainComposerValue() === "Compare  suffix ", "Completing at a middle caret left a partial mention or erased surrounding prose");
            const mentionBadges = [...document.querySelectorAll('.composer-mesh-widget-body')].map((button) => button.title);
            check(mentionBadges[0].includes("Grok") && mentionBadges[1].includes("GLM"), "Mention insertion reordered existing badges");
            await setField(composer(), composer().value + " @doesnotexist", false);
            check(element('.mesh-mention-panel').textContent.includes("No recent models match"), "Unmatched mentions did not explain the empty result");
            await pressKey(composer(), "Enter");
            check(document.querySelectorAll('.composer-mesh-widget').length === 2, "An unmatched mention selected a model");
            await setField(composer(), composer().value.replace("@doesnotexist", "@gl"), false);
            await pressKey(composer(), "Tab");
            await setField(composer(), composer().value + " @gl", false);
            await pressKey(composer(), "Enter");
            await setField(composer(), composer().value + " @", false);
            check(element('.mesh-mention-panel').textContent.includes("Four subagents"), "Mentions did not enforce the four-target limit");
            await pressKey(composer(), "Enter");
            check(document.querySelectorAll('.composer-mesh-widget').length === 4, "Mentions allowed a fifth target");
            await pressKey(composer(), "Escape");
            await setField(composer(), composer().value.slice(0, -1), false);
            const mentionPrompt = plainComposerValue().trim();
            await click(send());
            const mentionedSend = state.calls.find((call) => call.type === "delegation.prepare");
            check(mentionedSend?.payload.prompt === mentionPrompt, "Mention completion leaked search text into the sent prompt");
            check(mentionedSend.payload.targets.map((target) => target.modelId).join(",") === "grok-stale,opencode-go/glm-5.3-flash,opencode-go/glm-5.3-flash,opencode-go/glm-5.3-flash", "Mention tags did not send their exact model routes in inline order");
            check(mentionedSend.payload.targets.slice(1).every((target) => target.reasoningEffort === "max"), "Mention sends lost saved reasoning");
            for (const [index, key] of mentionStorageKeys.entries()) {
              if (mentionStorageBackup[index] === null) localStorage.removeItem(key);
              else localStorage.setItem(key, mentionStorageBackup[index]);
            }

            progress("goal clear focus");
            const existingGoal = {
              sessionId: "mounted-session", objective: "Clear this goal", status: "active", source: "native", tokenBudget: null,
              tokensUsed: 0, timeUsedSeconds: 0, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z", revision: 1,
            };
            await mount({ goal: existingGoal });
            await click(element(".composer-current-goal"));
            await click(buttonWithText(element('.composer-goal-panel'), "Clear"));
            check(!document.querySelector('.composer-goal-panel'), "Successful Goal clear did not dismiss the panel");
            check(document.activeElement === composer(), "Successful Goal clear did not restore Composer focus");

            progress("goal delayed load");
            await mount({ goal: existingGoal });
            await click(element(".composer-current-goal"));
            const objective = element('.composer-goal-panel textarea');
            const budget = element('.composer-goal-panel input[type="number"]');
            await setField(objective, "Keep my typed objective");
            await setField(budget, "321");
            progress("goal load resolve");
            resolveGoalLoad({
              sessionId: "mounted-session", objective: "Old loaded objective", status: "active", source: "native", tokenBudget: 999,
              tokensUsed: 0, timeUsedSeconds: 0, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z", revision: 1,
            });
            await settle(5);
            check(objective.value === "Keep my typed objective", "Delayed goal load overwrote the edited objective");
            check(budget.value === "321", "Delayed goal load overwrote the edited budget");

            progress("permissions slash and menu");
            state = await mount({ sessionState: "idle", initialDraft: "Keep /permission this instruction" });
            check(document.querySelector('.permission-settings'), "Complete /permission did not open its picker");
            check(!plainComposerValue().includes("/permission") && plainComposerValue().includes("Keep") && plainComposerValue().includes("this instruction"), "Permission command erased surrounding draft text");
            check(state.calls.some(call => call.type === "session.permissions.get" && call.payload.sessionId === "mounted-session"), "Picker did not read native task permissions");
            check(!state.calls.some(call => call.type === "message.send"), "Permission command was sent to the model");
            await pressKey(element('.permission-settings'), "Escape");
            check(!document.querySelector('.permission-settings') && document.activeElement === composer(), "Escape did not restore composer focus");
            await setField(composer(), "/perm");
            check(document.querySelector('.slash-command-palette')?.textContent.includes('/permission'), "Permission prefix did not filter the palette");
            await pressKey(composer(), "Enter");
            check(document.querySelector('.permission-settings') && !plainComposerValue().includes('/perm'), "Keyboard command selection failed");
            await pressKey(element('.permission-settings'), "Escape");
            await openAction("Permissions");
            check(document.querySelector('.permission-settings'), "Three-dot menu did not open permissions");
            document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); await settle();
            check(!document.querySelector('.permission-settings'), "Outside click did not dismiss permissions");
            state = await mount({ draft: true, sessionState: "idle", initialDraft: "Keep new-task draft" });
            await openAction("Permissions");
            check(state.materializeActions().some(item => item.action === "permission"), "Draft permissions did not materialize the selected harness task");
            check(plainComposerValue() === "Keep new-task draft", "Draft permissions erased the instruction");
            progress("complete");
            await unmount();
            window.__composerQaResult = { ok: true };
          } catch (error) {
            window.__composerQaResult = { ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "" };
          }
        `,
      },
      outfile: rendererBundle,
      bundle: true,
      plugins: [inlineWorkerStubPlugin],
      format: "esm",
      platform: "browser",
      target: "chrome136",
      loader: { ".css": "css" },
    });
    await writeFile(htmlPath, '<!doctype html><html><head><link rel="stylesheet" href="./renderer.css"></head><body><script type="module" src="./renderer.js"></script></body></html>', "utf8");
    await writeFile(preloadPath, `const { contextBridge, ipcRenderer } = require("electron");
      contextBridge.exposeInMainWorld("composerLayoutQa", {
        resize: (width, height) => ipcRenderer.invoke("composer-qa-resize", width, height),
        capture: (name) => ipcRenderer.invoke("composer-qa-capture", name),
      });`, "utf8");
    await writeFile(mainPath, String.raw`
      const path = require("node:path");
      const { app, BrowserWindow, ipcMain } = require("electron");
      app.commandLine.appendSwitch("disable-gpu");
      app.setPath("userData", path.join(__dirname, "profile"));
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 1200, height: 800, webPreferences: { offscreen: true, preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        ipcMain.handle("composer-qa-resize", (_event, width, height) => window.setContentSize(width, height));
        ipcMain.handle("composer-qa-capture", async (_event, name) => {
          if (!process.env.TETHOQ_COMPOSER_QA_ARTIFACT_DIR) return;
          const fs = require("node:fs/promises");
          await fs.mkdir(process.env.TETHOQ_COMPOSER_QA_ARTIFACT_DIR, { recursive: true });
          // Wait for the compositor and ResizeObserver-driven surface outline,
          // rather than capturing the hidden window's previous frame.
          for (let frame = 0; frame < 2; frame += 1) await new Promise((resolve, reject) => {
            const painted = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { window.webContents.removeListener("paint", painted); reject(new Error("Composer paint timed out")); }, 2000);
            window.webContents.once("paint", painted);
            window.webContents.invalidate();
          });
          const image = await window.webContents.capturePage();
          await fs.writeFile(path.join(process.env.TETHOQ_COMPOSER_QA_ARTIFACT_DIR, name + ".png"), image.toPNG());
        });
        await window.loadFile(process.argv[2]);
        // The full sequence can exceed 25 seconds while every scenario is
        // progressing. Bound each scenario here; runElectron caps the whole run.
        const result = await window.webContents.executeJavaScript('new Promise((resolve, reject) => { const started = performance.now(); const check = () => { if (window.__composerQaResult) return resolve(window.__composerQaResult); if (performance.now() - (window.__composerQaProgressAt ?? started) > 10000) return reject(new Error("Mounted Composer QA stopped making progress at: " + (window.__composerQaProgress || "startup"))); setTimeout(check, 10); }; check(); })', true);
        process.stdout.write("TETHOQ_COMPOSER_QA=" + JSON.stringify(result) + "\n");
        window.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exit(1); });
    `, "utf8");

    const result = await runElectron(mainPath, htmlPath);
    assert.deepEqual(result, { ok: true }, result.error ?? result.stack);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
