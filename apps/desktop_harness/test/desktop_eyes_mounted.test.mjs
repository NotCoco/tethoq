import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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
    let timeoutError;
    const timeout = setTimeout(() => {
      timeoutError = new Error(`Mounted EYES QA timed out.\n${stderr}\n${stdout}`);
      // Wait for this test's process tree to close before deleting its profile.
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => child.kill());
      } else child.kill();
    }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timeoutError) { reject(timeoutError); return; }
      if (code !== 0) { reject(new Error(`Mounted EYES QA exited ${code}.\n${stderr}\n${stdout}`)); return; }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_EYES_QA="));
      if (!marker) { reject(new Error(`Mounted EYES QA returned no result.\n${stderr}\n${stdout}`)); return; }
      resolve(JSON.parse(marker.slice("TETHOQ_EYES_QA=".length)));
    });
  });
}

test("mounted desktop EYES controls hydrate, recover, and coalesce saves without exposing internals", { timeout: 60_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-eyes-mounted-${process.pid}-${Date.now()}`);
  const rendererBundle = join(outputDirectory, "renderer.js");
  const htmlPath = join(outputDirectory, "index.html");
  const mainPath = join(outputDirectory, "main.cjs");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot,
        sourcefile: "eyes-mounted-qa.tsx",
        loader: "tsx",
        contents: String.raw`
          import React from "react";
          import { createRoot } from "react-dom/client";
          import "./src/renderer/src/styles.css";

          globalThis.IS_REACT_ACT_ENVIRONMENT = false;
          window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
          window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

          let bridgeHandler = async () => ({ ok: true, payload: {} });
          window.tethoqDesktop = {
            request: (type, payload = {}) => bridgeHandler(type, payload),
            selectFiles: async () => [],
            selectImages: async () => [],
          };

          const [{ VisionEyesPicker }, { TaskDetailsControl, WalletDropdown, reconcileVisionStatusEvents }, { ChatTimeline }, { eventToTimeline }] = await Promise.all([
            import("./src/renderer/src/Composer.tsx"),
            import("./src/renderer/src/App.tsx"),
            import("./src/renderer/src/ChatTimeline.tsx"),
            import("./src/renderer/src/bridge.ts"),
          ]);

          const progress = (step) => { window.__eyesQaProgress = step; };
          const deferred = () => {
            let resolve;
            let reject;
            const promise = new Promise((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
            return { promise, resolve, reject };
          };
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const settle = async (count = 4) => {
            for (let index = 0; index < count; index += 1) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              await frame();
            }
          };
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const element = (selector, label = selector) => {
            const value = document.querySelector(selector);
            check(value, label + " is missing");
            return value;
          };
          const buttonWithText = (scope, text) => {
            const value = [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
            check(value, "Button is missing: " + text);
            return value;
          };
          // The footer save is queried in its own scope: a chosen API row
          // names its own pending state and must never shadow it.
          const footerSave = (scope) => {
            const value = [...scope.querySelectorAll("footer button")].find((candidate) => candidate.textContent?.includes("Use as eyes"));
            check(value, "Footer is missing: Use as eyes");
            return value;
          };
          const click = async (value, count = 1) => {
            for (let index = 0; index < count; index += 1) value.click();
            await settle();
          };
          const setControl = async (value, next, settleAfter = true) => {
            const prototype = value instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, "value").set.call(value, next);
            value.dispatchEvent(value instanceof HTMLSelectElement
              ? new Event("change", { bubbles: true })
              : new InputEvent("input", { bubbles: true, inputType: "insertText", data: next }));
            if (settleAfter) await settle();
          };
          const envelope = (payload) => ({ ok: true, payload });
          const rejected = (message) => ({ ok: false, payload: {}, error: { code: "qa_error", message } });
          const provider = (id, name) => ({
            id, name, state: "online", detected: true, supportsAttachments: true,
            capabilities: ["Create Session", "Send Message", "Session History"],
          });
          const providers = [provider("codex", "Codex"), provider("direct", "Direct API")];
          const session = (id) => ({
            id, providerId: "codex", title: "Mounted EYES QA", state: "idle", project: "qa",
            workingDirectory: "C:\\qa", preview: "", updatedAt: "2026-08-27T00:00:00.000Z",
            model: "cached-vision", effort: "medium",
          });
          const snapshot = (currentSession, includeStructural = true) => ({
            providers,
            models: {
              codex: includeStructural ? [{ id: "cached-vision", name: "Cached Vision", isDefault: true, efforts: ["medium"], inputModalities: ["text", "image"] }] : [],
              direct: [],
            },
            sessions: [currentSession], timelines: { [currentSession.id]: [] }, approvals: [], inputRequests: [], goals: {}, goalClearRevisions: {},
          });
          const visionTarget = (modelId, modelName, providerId = "codex", providerName = "Codex", metadata = {}) => ({
            providerId, displayName: providerName,
            models: [{ id: modelId, providerId, displayName: modelName, isDefault: true, inputModalities: ["text", "image"], nativeMetadata: metadata }],
          });
          const codexVisionTarget = (models) => ({
            providerId: "codex", displayName: "Codex",
            models: models.map(([id, displayName], index) => ({ id, providerId: "codex", displayName, isDefault: index === 0, inputModalities: ["text", "image"], nativeMetadata: {} })),
          });
          const wallet = (endpointId, configured) => ({
            providerId: "direct", kind: "user_api", label: "Direct API", detail: "Uses a local API key.",
            endpointId, endpointName: endpointId === "xai" ? "Grok API" : "Gemini API", currency: "USD",
            apiKeyConfigured: configured, apiKeyLabel: endpointId === "xai" ? "XAI_API_KEY" : "GOOGLE_API_KEY",
            availableEndpoints: [{ id: "google", name: "Gemini API", apiKeyLabel: "GOOGLE_API_KEY" }, { id: "xai", name: "Grok API", apiKeyLabel: "XAI_API_KEY" }],
          });

          let mounted = null;
          const unmount = async () => {
            if (!mounted) return;
            mounted.root.unmount();
            mounted.host.remove();
            mounted = null;
            await settle(1);
          };
          const mount = async (node) => {
            await unmount();
            const host = document.createElement("div");
            host.style.cssText = "position:relative;width:760px;height:620px;margin:20px";
            document.body.append(host);
            const root = createRoot(host);
            root.render(node);
            mounted = { root, host };
            await settle(2);
            return mounted;
          };
          const rerender = async (node) => {
            check(mounted, "Nothing is mounted to rerender");
            mounted.root.render(node);
            await settle(4);
          };

          try {
            progress("API EYES reasoning is editable and survives save and reopen");
            const reasoningSession = session("eyes-reasoning");
            const reasoningTarget = visionTarget("google::gemini-reasoning", "Gemini Reasoning", "direct", "Direct API", {
              sourceProviderId: "google", walletKind: "user_api", apiKeyConfigured: true,
              variants: { minimal: {}, low: {}, medium: {}, high: {}, xhigh: {} },
            });
            let reasoningSaved = { providerId: "direct", modelId: "google::gemini-reasoning", reasoningEffort: "xhigh" };
            const reasoningSaves = [];
            const reasoningRequest = async (type, payload) => {
              if (type === "vision.targets") return { targets: [reasoningTarget] };
              if (type === "wallet.get") return { wallet: wallet(payload.endpointId, payload.endpointId === "google") };
              if (type === "session.vision.configure") { reasoningSaves.push(payload); reasoningSaved = payload.selection; }
              if (type === "session.vision.get" || type === "session.vision.configure") return { vision: { sessionId: reasoningSession.id, primaryModelSupportsImageInput: false, configured: reasoningSaved } };
              throw new Error("Unexpected reasoning request: " + type);
            };
            const reasoningNode = () => <VisionEyesPicker snapshot={snapshot(reasoningSession)} session={reasoningSession} request={reasoningRequest} action="settings" onClose={() => undefined} onReady={() => undefined} />;
            await mount(reasoningNode());
            await settle();
            check(element('.vision-single-choice select[aria-label="Vision reasoning effort"]').value === "xhigh", "Saved API reasoning was hidden or reset to the first variant");
            check(footerSave(element('.vision-eyes-picker')).disabled, "Opening saved EYES silently proposed a different reasoning level");
            await setControl(element('select[aria-label="Vision reasoning effort"]'), "high");
            await click(footerSave(element('.vision-eyes-picker')));
            check(reasoningSaves.length === 1 && reasoningSaves[0].selection.reasoningEffort === "high", "Chosen API reasoning did not reach configuration");
            check(reasoningSaves[0].sessionId === reasoningSession.id && reasoningSession.effort === "medium", "EYES changed the primary chat selection");
            await mount(reasoningNode());
            await settle();
            check(element('select[aria-label="Vision reasoning effort"]').value === "high", "Reopening EYES lost saved reasoning");
            reasoningSaved = null;
            await mount(reasoningNode());
            await settle();
            await click(element('.vision-api-route button[aria-label="Gemini API: Off"]'));
            check(element('select[aria-label="Vision reasoning effort"]').value === "", "A newly chosen API invented Minimal as its default");
            await setControl(element('select[aria-label="Vision reasoning effort"]'), "xhigh");
            await click(footerSave(element('.vision-eyes-picker')));
            check(reasoningSaves.at(-1).selection.reasoningEffort === "xhigh", "A newly chosen API ignored explicit reasoning");

            progress("Instant session EYES sends the chosen reasoning");
            const { LiveSessionPanel } = await import("./src/renderer/src/LiveSession.tsx");
            const instantSaves = [];
            window.tethoqDesktop.liveSessionState = async () => ({ phase: "idle", privacy: { warning: "QA" } });
            window.tethoqDesktop.onLiveSessionState = () => () => undefined;
            window.tethoqDesktop.onLiveSessionEvent = () => () => undefined;
            window.tethoqDesktop.liveSessionAction = async () => ({});
            bridgeHandler = async (type, payload) => {
              if (type === "session.vision.get") return envelope({ vision: { sessionId: reasoningSession.id, primaryModelSupportsImageInput: false, configured: null } });
              if (type === "vision.targets") return envelope({ targets: [reasoningTarget] });
              if (type === "session.vision.configure") { instantSaves.push(payload); return envelope({}); }
              throw new Error("Unexpected instant request: " + type);
            };
            await mount(<LiveSessionPanel session={reasoningSession} experimental={true} notify={() => undefined} onClose={() => undefined} />);
            await click(element('.live-session-start'));
            check(element('.live-session-eyes select[aria-label="Vision reasoning effort"]').value === "", "Instant session guessed Minimal");
            await click(buttonWithText(element('.live-session-eyes'), "Use this model as eyes"));
            check(instantSaves.length === 0, "Instant session saved an unchosen reasoning level");
            await setControl(element('.live-session-eyes select[aria-label="Vision reasoning effort"]'), "xhigh");
            await click(buttonWithText(element('.live-session-eyes'), "Use this model as eyes"));
            check(instantSaves.length === 1 && instantSaves[0].selection.reasoningEffort === "xhigh", "Instant session lost explicit EYES reasoning");
            bridgeHandler = async () => envelope({});

            progress("delayed structural hydration");
            const delayedSession = session("eyes-delayed");
            const targetsGate = deferred();
            const statusGate = deferred();
            const googleWalletGate = deferred();
            const xaiWalletGate = deferred();
            const delayedRequest = async (type, payload) => {
              if (type === "vision.targets") return targetsGate.promise;
              if (type === "session.vision.get") return statusGate.promise;
              if (type === "wallet.get" && payload.endpointId === "google") return googleWalletGate.promise;
              if (type === "wallet.get" && payload.endpointId === "xai") return xaiWalletGate.promise;
              return {};
            };
            const delayedSnapshot = snapshot(delayedSession);
            delayedSnapshot.models.direct = [{ id: "google::unverified", name: "Unverified Gemini", efforts: [], inputModalities: ["text", "image"], sourceProviderId: "google", walletKind: "user_api", apiKeyConfigured: true, apiKeyVerified: false }];
            await mount(<VisionEyesPicker snapshot={delayedSnapshot} session={delayedSession} request={delayedRequest} action="settings" onClose={() => undefined} onReady={() => undefined} />);
            const delayedPanel = element(".vision-eyes-picker");
            check(delayedPanel.textContent.includes("Choose a model as eyes"), "EYES structure did not paint immediately");
            const delayedProvider = element('select[aria-label="Vision provider"]');
            check([...delayedProvider.options].some((option) => option.value === "codex"), "Cached structural provider did not paint before discovery");
            check([...delayedProvider.options].some((option) => option.value === "direct"), "A configured API model was hidden by verification state");
            check(!delayedProvider.disabled, "Cached provider choices were blocked by unrelated saved-status hydration");
            const heightBefore = delayedPanel.getBoundingClientRect().height;
            statusGate.resolve({ vision: { sessionId: delayedSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "hydrated-vision", reasoningEffort: "high" } } });
            await settle(2);
            targetsGate.resolve({ targets: [visionTarget("hydrated-vision", "Hydrated Vision", "codex", "Codex", { supportedReasoningEfforts: ["high"] })] });
            googleWalletGate.resolve({ wallet: wallet("google", false) });
            xaiWalletGate.resolve({ wallet: wallet("xai", false) });
            await settle(6);
            const heightAfter = delayedPanel.getBoundingClientRect().height;
            check(Math.abs(heightAfter - heightBefore) < 1, "EYES panel geometry shifted during hydration");
            check(element('button.vision-model-trigger').dataset.modelId === "hydrated-vision", "Saved model did not win after independent hydration");

            progress("discovery unavailable and genuine empty");
            const discoverySession = session("eyes-discovery");
            let targetRequests = 0;
            const discoveryWalletGate = deferred();
            const discoveryRequest = async (type) => {
              if (type === "vision.targets") {
                targetRequests += 1;
                if (targetRequests === 1) throw new Error("RAW_TARGET_DISCOVERY_SECRET");
                return { targets: [] };
              }
              if (type === "session.vision.get") return { vision: { sessionId: discoverySession.id, primaryModelSupportsImageInput: false, configured: null } };
              if (type === "wallet.get") return discoveryWalletGate.promise;
              return {};
            };
            await mount(<VisionEyesPicker snapshot={snapshot(discoverySession, false)} session={discoverySession} request={discoveryRequest} action="settings" onClose={() => undefined} onReady={() => undefined} />);
            let discoveryPanel = element(".vision-eyes-picker");
            check(discoveryPanel.textContent.includes("Visual model discovery unavailable"), "Discovery failure was presented as a genuine empty catalogue");
            check(!discoveryPanel.textContent.includes("RAW_TARGET_DISCOVERY_SECRET"), "Raw discovery error reached visible EYES text");
            const discoveryRetry = buttonWithText(discoveryPanel, "Retry");
            check(!discoveryRetry.disabled, "Unrelated wallet hydration kept model discovery retry disabled");
            await click(discoveryRetry);
            discoveryPanel = element(".vision-eyes-picker");
            check(targetRequests === 2, "Panel retry did not own a fresh target request");
            check(discoveryPanel.textContent.includes("No image-capable model is ready"), "A genuine empty catalogue was not distinguished after retry");
            check(!discoveryPanel.textContent.includes("Visual model discovery unavailable"), "Unavailable state survived a successful empty retry");
            discoveryWalletGate.resolve({ wallet: wallet("google", false) });

            progress("partial discovery keeps usable choices");
            const partialSession = session("eyes-partial");
            const partialDirectTarget = visionTarget("google::partial-vision", "Partial Gemini", "direct", "Direct API", { sourceProviderId: "google", walletKind: "user_api", apiKeyConfigured: true, apiKeyVerified: true });
            const partialRequest = async (type, payload) => {
              if (type === "vision.targets") return { targets: [partialDirectTarget], incomplete: true };
              if (type === "session.vision.get") return { vision: { sessionId: partialSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "cached-vision", reasoningEffort: "medium" } } };
              if (type === "wallet.get") return { wallet: wallet(payload.endpointId, false) };
              return {};
            };
            await mount(<VisionEyesPicker snapshot={snapshot(partialSession)} session={partialSession} request={partialRequest} action="settings" onClose={() => undefined} onReady={() => undefined} />);
            const partialPanel = element(".vision-eyes-picker");
            const partialProviders = element('select[aria-label="Vision provider"]');
            check(partialPanel.textContent.includes("Some visual models could not be refreshed. Available choices are still shown."), "Partial discovery did not paint its safe warning");
            check([...partialProviders.options].some((option) => option.value === "codex"), "Partial discovery discarded the cached usable provider");
            check([...partialProviders.options].some((option) => option.value === "direct"), "Partial discovery discarded the freshly available provider");
            check(element('button.vision-model-trigger').dataset.modelId === "cached-vision", "Partial discovery did not preserve the saved usable choice");

            progress("live vision event updates an open picker");
            const livePickerSession = session("eyes-live-picker");
            const livePickerTargets = [codexVisionTarget([["vision-live-a", "Vision Live A"], ["vision-live-b", "Vision Live B"]])];
            const livePickerRequest = async (type, payload) => {
              if (type === "vision.targets") return { targets: livePickerTargets, incomplete: false };
              if (type === "session.vision.get") return { vision: { sessionId: livePickerSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "vision-live-a" } } };
              if (type === "wallet.get") return { wallet: wallet(payload.endpointId, false) };
              return {};
            };
            const livePickerSnapshot = snapshot(livePickerSession, false);
            const pickerNode = (liveStatus) => <VisionEyesPicker snapshot={livePickerSnapshot} session={livePickerSession} request={livePickerRequest} action="settings" liveStatus={liveStatus} onClose={() => undefined} onReady={() => undefined} />;
            await mount(pickerNode(undefined));
            const openPicker = element(".vision-eyes-picker");
            check(element('button.vision-model-trigger').dataset.modelId === "vision-live-a", "Open picker did not hydrate its initial saved choice");
            const liveStatuses = reconcileVisionStatusEvents({}, [{
              eventId: "vision-event-picker", sequence: 1, type: "session.vision_updated",
              occurredAt: "2026-08-27T12:00:00.000Z", providerId: "codex", sessionId: livePickerSession.id,
              payload: { vision: { sessionId: livePickerSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "vision-live-b" } } },
            }]);
            const livePickerStatus = liveStatuses[livePickerSession.id];
            check(livePickerStatus?.configured?.modelId === "vision-live-b", "session.vision_updated did not become app-owned EYES state");
            await rerender(pickerNode(livePickerStatus));
            check(element(".vision-eyes-picker") === openPicker, "Live EYES status remounted the open picker");
            check(element('button.vision-model-trigger').dataset.modelId === "vision-live-b", "Open picker ignored the live saved choice (showing " + element('button.vision-model-trigger').dataset.modelId + ")");

            progress("live status wins first picker paint");
            let firstPaintVisionModel = "";
            function FirstPaintProbe({ children }) {
              React.useLayoutEffect(() => { firstPaintVisionModel = element('button.vision-model-trigger').dataset.modelId; }, []);
              return children;
            }
            const initialLiveStatus = { sessionId: livePickerSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "vision-live-a" } };
            await mount(<FirstPaintProbe><VisionEyesPicker snapshot={livePickerSnapshot} session={livePickerSession} request={livePickerRequest} action="settings" liveStatus={initialLiveStatus} onClose={() => undefined} onReady={() => undefined} /></FirstPaintProbe>);
            check(firstPaintVisionModel === "vision-live-a", "A stale picker cache won the first paint over app-owned live status");

            progress("synchronous live status beats a stale picker request");
            const pickerRaceSession = session("eyes-picker-status-race");
            const pickerRaceTargets = [codexVisionTarget([["picker-race-a", "Picker Race A"], ["picker-race-b", "Picker Race B"]])];
            const pickerRaceGate = deferred();
            let pickerRaceLiveStatus;
            const pickerRaceRequest = async (type, payload) => {
              if (type === "vision.targets") return { targets: pickerRaceTargets, incomplete: false };
              if (type === "session.vision.get") return pickerRaceGate.promise;
              if (type === "wallet.get") return { wallet: wallet(payload.endpointId, false) };
              return {};
            };
            await mount(<VisionEyesPicker snapshot={snapshot(pickerRaceSession, false)} session={pickerRaceSession} request={pickerRaceRequest} action="settings" readLiveStatus={() => pickerRaceLiveStatus} onClose={() => undefined} onReady={() => undefined} />);
            pickerRaceLiveStatus = { sessionId: pickerRaceSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "picker-race-b" } };
            pickerRaceGate.resolve({ vision: { sessionId: pickerRaceSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "picker-race-a" } } });
            await settle(5);
            check(element('button.vision-model-trigger').dataset.modelId === "picker-race-b", "A stale picker status request overwrote the newer synchronous provider event");

            progress("persisted unavailable selection");
            const unavailableSession = session("eyes-unavailable");
            const unavailableRequest = async (type) => {
              if (type === "vision.targets") return { targets: [visionTarget("safe-model", "Safe Model")] };
              if (type === "session.vision.get") return { vision: { sessionId: unavailableSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "private-provider-id", modelId: "private-model-id" } } };
              if (type === "wallet.get") return { wallet: wallet("google", false) };
              return {};
            };
            await mount(<VisionEyesPicker snapshot={snapshot(unavailableSession, false)} session={unavailableSession} request={unavailableRequest} action="settings" onClose={() => undefined} onReady={() => undefined} />);
            const unavailablePanel = element(".vision-eyes-picker");
            check(unavailablePanel.textContent.includes("saved visual model is currently unavailable"), "Unavailable persisted model had no neutral state");
            check(element('select[aria-label="Vision provider"]').value === "", "Unavailable persisted model silently fell back to another provider");
            check(!unavailablePanel.textContent.includes("private-provider-id") && !unavailablePanel.textContent.includes("private-model-id"), "Raw unavailable selection IDs reached visible text");

            progress("model search filters and names the upstream provider");
            const searchSession = session("eyes-model-search");
            const openCodeModel = (id, displayName, sourceProviderId, sourceProviderName, isDefault = false) => ({
              id, providerId: "opencode", displayName, isDefault, inputModalities: ["text", "image"],
              nativeMetadata: { sourceProviderId, sourceProviderName },
            });
            const searchTarget = {
              providerId: "opencode", displayName: "OpenCode",
              models: [
                openCodeModel("crofai/deepseek-reasoner", "DeepSeek Reasoner", "crofai", "CrofAI", true),
                openCodeModel("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", "anthropic", "Anthropic"),
                openCodeModel("opencode/native-vision", "OpenCode Native Vision", "opencode", "OpenCode"),
              ],
            };
            const searchRequest = async (type) => {
              if (type === "vision.targets") return { targets: [searchTarget], incomplete: false };
              if (type === "session.vision.get") return { vision: { sessionId: searchSession.id, primaryModelSupportsImageInput: false, configured: null } };
              if (type === "wallet.get") return { wallet: wallet("google", false) };
              return {};
            };
            await mount(<VisionEyesPicker snapshot={snapshot(searchSession, false)} session={searchSession} request={searchRequest} action="settings" onClose={() => undefined} onReady={() => undefined} />);
            await settle(4);
            const searchPanel = element(".vision-eyes-picker");
            // EYES is off, so nothing is pre-selected: choosing the provider proposes its default model.
            check(element("button.vision-model-trigger").dataset.modelId === "", "An unconfigured task pre-selected a visual model");
            await setControl(element('select[aria-label="Vision provider"]'), "opencode");
            check(element("button.vision-model-trigger").dataset.modelId === "crofai/deepseek-reasoner", "Choosing the provider did not propose its default model");
            check(!document.querySelector(".vision-model-dropdown"), "The model list was open before it was asked for");
            await click(element("button.vision-model-trigger"));
            const modelRows = () => [...document.querySelectorAll(".vision-model-option")].map((node) => ({
              name: node.querySelector("strong")?.textContent?.trim(),
              source: node.querySelector("small")?.textContent?.trim() ?? null,
            }));
            const allRows = modelRows();
            check(allRows.length === 3, "The model list did not show every image-capable model (" + allRows.length + ")");
            check(allRows[0].source === "CrofAI", "The upstream provider was not named beside its model (" + allRows[0].source + ")");
            check(allRows[1].source === "Anthropic", "A second upstream provider was not named beside its model");
            // The Provider control already says OpenCode, so a native row must not repeat it.
            check(allRows[2].source === null, "An OpenCode-native model repeated the harness name as its own provider");
            check(!searchPanel.textContent.includes("crofai/deepseek-reasoner"), "A raw route identifier reached visible text");

            const eyesSearchField = element(".vision-model-search input");
            await setControl(eyesSearchField, "sonnet");
            check(modelRows().map((row) => row.name).join("|") === "Claude Sonnet 4.6", "Typing did not narrow the model list");
            // The upstream provider is searchable, not merely decorative.
            await setControl(eyesSearchField, "crof");
            check(modelRows().map((row) => row.name).join("|") === "DeepSeek Reasoner", "Searching by upstream provider did not match its model");
            await setControl(eyesSearchField, "no-such-model");
            check(modelRows().length === 0 && searchPanel.textContent.includes("No visual model matches"), "An empty search result did not say so");
            await setControl(eyesSearchField, "sonnet");
            await click(element(".vision-model-option"));
            check(!document.querySelector(".vision-model-dropdown"), "Choosing a model left the list open");
            check(element("button.vision-model-trigger").dataset.modelId === "anthropic/claude-sonnet-4-6", "Choosing a searched model did not become the EYES choice");

            progress("composer key validation and replacement");
            const credentialSession = session("eyes-credential");
            const credentialCalls = [];
            let credentialAttempt = 0;
            let credentialSelection = null;
            const directTarget = visionTarget("google::gemini-qa", "Gemini QA", "direct", "Direct API", { sourceProviderId: "google", walletKind: "user_api", apiKeyConfigured: true, apiKeyVerified: true });
            const credentialRequest = async (type, payload) => {
              if (type === "vision.targets") return { targets: [visionTarget("safe-model", "Safe Model"), directTarget] };
              if (type === "session.vision.get") return { vision: { sessionId: credentialSession.id, primaryModelSupportsImageInput: false, configured: credentialSelection } };
              if (type === "session.vision.configure") {
                credentialSelection = payload.selection ?? null;
                return { vision: { sessionId: credentialSession.id, primaryModelSupportsImageInput: false, configured: credentialSelection } };
              }
              if (type === "wallet.get") return { wallet: wallet(payload.endpointId, payload.endpointId === "google") };
              if (type === "wallet.configure") {
                credentialCalls.push(payload);
                credentialAttempt += 1;
                if (credentialAttempt === 1) throw new Error("RAW_INVALID_KEY_SECRET");
                return { wallet: wallet(payload.endpointId, true) };
              }
              return {};
            };
            await mount(<VisionEyesPicker snapshot={snapshot(credentialSession, false)} session={credentialSession} request={credentialRequest} action="settings" onClose={() => undefined} onReady={() => undefined} />);
            const credentialPanel = element(".vision-eyes-picker");
            // A stored-key row chooses instead of opening the editor; key
            // replacement lives beside the resulting single choice.
            await click(buttonWithText(credentialPanel, "Gemini API"));
            check(element(".vision-single-choice").textContent?.includes("Gemini API"), "Choosing the stored-key row did not collapse to one named choice");
            await click(buttonWithText(credentialPanel, "Replace key"));
            let keyInput = element('.vision-api-editor input[type="password"]');
            await setControl(keyInput, "invalid-composer-key");
            await click(buttonWithText(credentialPanel, "Save and use now"));
            keyInput = element('.vision-api-editor input[type="password"]');
            check(keyInput.value === "invalid-composer-key", "Failed in-panel key validation discarded the draft key");
            check(credentialPanel.textContent.includes("That API key could not be verified"), "Failed in-panel key validation had no safe feedback");
            check(!credentialPanel.textContent.includes("RAW_INVALID_KEY_SECRET"), "Raw in-panel key error reached visible text");
            check(credentialCalls[0]?.validateApiKey === true, "In-panel key save did not require server validation");
            await setControl(keyInput, "replacement-composer-key");
            await click(buttonWithText(credentialPanel, "Save and use now"));
            check(!document.querySelector(".vision-api-editor"), "Successful replacement key did not close its editor");
            check(element(".vision-single-choice").textContent?.includes("Gemini API"), "Save and use now did not keep the newly available key route chosen");
            check(credentialCalls.length === 2 && credentialCalls[1].validateApiKey === true, "Replacement key was not validated exactly once");

            progress("session opt-in, turn off, and key removal");
            const optInSession = session("eyes-opt-in");
            let optInSaved = null;
            let optInClosed = 0;
            const optInVisionCalls = [];
            const optInWalletCalls = [];
            let optInGrokKey = true;
            let optInRemovalFails = true;
            const optInDirectTarget = visionTarget("xai::optin-grok", "Optin Grok", "direct", "Direct API", { sourceProviderId: "xai", walletKind: "user_api", apiKeyConfigured: true, apiKeyVerified: false });
            const optInRequest = async (type, payload) => {
              if (type === "vision.targets") return { targets: [visionTarget("opt-in-vision", "Optin Vision"), optInDirectTarget], incomplete: false };
              if (type === "session.vision.get") return { vision: { sessionId: optInSession.id, primaryModelSupportsImageInput: false, configured: optInSaved } };
              if (type === "session.vision.configure") {
                optInVisionCalls.push(payload);
                optInSaved = payload.selection ?? null;
                return { vision: { sessionId: optInSession.id, primaryModelSupportsImageInput: false, configured: optInSaved } };
              }
              if (type === "wallet.get") return { wallet: wallet(payload.endpointId, payload.endpointId === "xai" && optInGrokKey) };
              if (type === "wallet.configure") {
                optInWalletCalls.push(payload);
                if (payload.clearApiKey === true) {
                  if (optInRemovalFails) { optInRemovalFails = false; throw new Error("RAW_REMOVAL_SECRET_TOKEN"); }
                  optInGrokKey = false;
                  return { wallet: wallet(payload.endpointId, false) };
                }
                return { wallet: wallet(payload.endpointId, true) };
              }
              return {};
            };
            await mount(<VisionEyesPicker snapshot={snapshot(optInSession, false)} session={optInSession} request={optInRequest} action="settings" onClose={() => { optInClosed += 1; }} onReady={() => undefined} />);
            await settle(4);
            const optInPanel = element(".vision-eyes-picker");
            // Nothing is pre-selected while EYES is off: the panel must say so,
            // offer no off switch, and keep confirmation unavailable.
            check(!optInPanel.querySelector(":scope > header small"), "The header repeated the EYES selection as prose");
            check(![...optInPanel.querySelectorAll("button")].some((node) => node.textContent?.includes("Turn off")), "An unconfigured task offered a Turn off action");
            const optInUse = buttonWithText(optInPanel, "Use as eyes");
            check(optInUse.disabled, "Use as eyes was available with no explicit model choice");
            check(element('select[aria-label="Vision provider"]').value === "", "An unconfigured task pre-selected a provider");
            const grokRowBefore = buttonWithText(optInPanel, "Grok API").closest(".vision-api-route");
            check(grokRowBefore && grokRowBefore.classList.contains("stored"), "A stored key row did not carry its neutral state");
            check(grokRowBefore && !grokRowBefore.classList.contains("active"), "A stored key read as the active EYES choice");
            // Enabling EYES is an explicit choice through the session route.
            await setControl(element('select[aria-label="Vision provider"]'), "codex");
            await click(buttonWithText(element(".vision-eyes-picker"), "Use as eyes"));
            check(optInVisionCalls.length === 1 && optInVisionCalls[0].selection?.modelId === "opt-in-vision", "Use as eyes did not save the chosen model through the session route");
            check(element('button.vision-model-trigger').textContent.includes("Optin Vision"), "The saved model was not shown in its control");
            // The saved key funds nothing here: it must still read as stored,
            // never as the active choice, and must not claim EYES is off
            // while another model is actually on.
            const grokWhileCodex = buttonWithText(optInPanel, "Grok API").textContent;
            const grokRowOther = buttonWithText(optInPanel, "Grok API").closest(".vision-api-route");
            check(grokWhileCodex.includes("Off"), "An inactive endpoint did not show its own off state");
            check(grokRowOther && grokRowOther.classList.contains("stored") && !grokRowOther.classList.contains("active"), "A stored key row took the active treatment while another model is on");
            await click(buttonWithText(optInPanel, "Turn off"));
            check(optInVisionCalls.length === 2 && optInVisionCalls[1].selection === null, "Turn off did not clear the saved choice through the session route");
            check(optInSaved === null && optInClosed === 1, "Turn off did not settle as an authoritative confirmed change");
            // Enabling EYES with the key-funded model marks exactly its row.
            await setControl(element('select[aria-label="Vision provider"]'), "direct");
            await click(buttonWithText(element(".vision-eyes-picker"), "Use as eyes"));
            check(optInVisionCalls.length === 3 && optInVisionCalls[2].selection?.modelId === "xai::optin-grok", "Use as eyes did not save the key-funded model");
            const grokRowActive = buttonWithText(optInPanel, "Grok API").closest(".vision-api-route");
            check(buttonWithText(optInPanel, "Grok API").textContent.includes("Enabled"), "The applied row did not say it is enabled");
            check(grokRowActive && grokRowActive.classList.contains("active"), "The funding row did not carry the active treatment");
            await click(buttonWithText(optInPanel, "Turn off"));
            check(optInSaved === null, "Turn off did not clear the key-funded choice");

            await mount(<VisionEyesPicker snapshot={snapshot(optInSession, false)} session={optInSession} request={optInRequest} action="settings" onClose={() => { optInClosed += 1; }} onReady={() => undefined} />);
            await settle(4);
            const removalPanel = element(".vision-eyes-picker");
            const grokMain = buttonWithText(removalPanel, "Grok API");
            check(grokMain.textContent.includes("Off"), "A saved key row did not read as off");
            // Row-level removal confirms inline, reports failure without the
            // editor, and never exposes the raw error.
            await click(buttonWithText(removalPanel, "Remove"));
            check(buttonWithText(removalPanel, "Confirm remove"), "Row removal did not ask for confirmation");
            check(!document.querySelector(".vision-api-editor"), "Arming row removal opened the credential editor");
            await click(buttonWithText(removalPanel, "Confirm remove"));
            check(optInWalletCalls.at(-1)?.clearApiKey === true, "Row removal did not ask the Bridge to clear the saved key");
            check(!document.querySelector(".vision-api-editor"), "A failed row removal opened the editor");
            check(removalPanel.textContent.includes("could not be removed"), "A failed row removal had no safe feedback");
            check(!removalPanel.textContent.includes("RAW_REMOVAL_SECRET_TOKEN"), "A raw removal error reached visible text");
            await click(buttonWithText(removalPanel, "Remove"));
            await click(buttonWithText(removalPanel, "Confirm remove"));
            await settle(4);
            check(buttonWithText(removalPanel, "Grok API").textContent.includes("Add API key"), "A removed key still read as saved");
            check(!removalPanel.querySelector(".vision-api-row-remove"), "A keyless row kept its Remove action");
            // The editor path still clears through the same authoritative route.
            optInGrokKey = true;
            optInRemovalFails = true;
            await mount(<VisionEyesPicker snapshot={snapshot(optInSession, false)} session={optInSession} request={optInRequest} action="settings" onClose={() => { optInClosed += 1; }} onReady={() => undefined} />);
            await settle(4);
            const editorPanel = element(".vision-eyes-picker");
            await click(buttonWithText(editorPanel, "Grok API"));
            check(element(".vision-single-choice").textContent?.includes("Grok API"), "Choosing the stored-key row did not collapse to one named choice");
            await click(buttonWithText(editorPanel, "Replace key"));
            check(document.querySelector(".vision-api-editor"), "Replace key did not open the key editor");
            await click(buttonWithText(editorPanel, "Remove key"));
            check(document.querySelector(".vision-api-editor"), "A failed removal closed the editor");
            check(editorPanel.textContent.includes("could not be removed"), "A failed removal had no safe feedback");
            check(!editorPanel.textContent.includes("RAW_REMOVAL_SECRET_TOKEN"), "A raw removal error reached visible text");
            await click(buttonWithText(editorPanel, "Remove key"));
            await settle(4);
            check(!document.querySelector(".vision-api-editor"), "A successful removal left its editor open");
            check(buttonWithText(editorPanel, "Grok API").textContent.includes("Add API key"), "A removed key still read as saved");

            progress("api row chooses, toggles, and saves");
            optInGrokKey = true;
            optInSaved = null;
            await mount(<VisionEyesPicker snapshot={snapshot(optInSession, false)} session={optInSession} request={optInRequest} action="settings" onClose={() => { optInClosed += 1; }} onReady={() => undefined} />);
            await settle(4);
            const rowPanel = element(".vision-eyes-picker");
            // Nothing chosen yet: three harness boxes, no single box, saving unavailable.
            check(!rowPanel.querySelector(".vision-single-choice"), "An unchosen endpoint already collapsed the harness boxes");
            check(rowPanel.querySelector(".vision-picker-fields"), "The harness boxes were missing before any endpoint choice");
            check(footerSave(rowPanel).disabled, "Use as eyes was available with no pending choice");
            // Choosing the Grok row collapses the boxes into one named choice.
            await click(buttonWithText(rowPanel, "Grok API"));
            const singleChoice = rowPanel.querySelector(".vision-single-choice");
            check(singleChoice && singleChoice.textContent?.includes("Grok API"), "Choosing the Grok row did not replace the harness boxes with one named choice");
            check(!rowPanel.querySelector(".vision-picker-fields"), "The harness boxes stayed visible beside the endpoint choice");
            const grokChosenRow = buttonWithText(rowPanel, "Grok API").closest(".vision-api-route");
            check(grokChosenRow && grokChosenRow.classList.contains("active"), "The chosen row did not carry the active treatment");
            check(buttonWithText(rowPanel, "Grok API").getAttribute("aria-checked") === "true", "The chosen endpoint switch was not visibly on");
            check(optInSaved === null, "Choosing an endpoint saved before Use as eyes");
            check(!rowPanel.textContent.includes("Will turn on"), "A saved endpoint still claimed to be a draft");
            check(!footerSave(rowPanel).disabled, "Choosing an endpoint did not enable Use as eyes");
            await rerender(<VisionEyesPicker snapshot={snapshot(optInSession, false)} session={optInSession} request={optInRequest} action="settings" liveStatus={{ sessionId: optInSession.id, primaryModelSupportsImageInput: false, configured: null }} onClose={() => { optInClosed += 1; }} onReady={() => undefined} />);
            check(buttonWithText(rowPanel, "Grok API").getAttribute("aria-checked") === "true", "An unchanged live status erased the unapplied choice");
            // Choosing it again reverts to the saved (here: off) state.
            await click(buttonWithText(rowPanel, "Grok API"));
            check(optInSaved === null, "Second endpoint click changed the saved setting");
            check(!rowPanel.querySelector(".vision-single-choice"), "Re-choosing the row did not restore the harness boxes");
            check(rowPanel.querySelector(".vision-picker-fields"), "The harness boxes did not return after the choice was reverted");
            check(footerSave(rowPanel).disabled, "Use as eyes stayed available after the choice was reverted");
            // Choose once more and save through the session route.
            const rowVisionBefore = optInVisionCalls.length;
            await click(buttonWithText(rowPanel, "Grok API"));
            check(rowPanel.querySelector(".vision-single-choice")?.textContent?.includes("Grok API"), "Re-choosing the row did not collapse again");
            check(!footerSave(rowPanel).disabled, "Re-choosing did not enable Use as eyes");
            await click(footerSave(rowPanel));
            await settle(8);
            check(optInVisionCalls.length === rowVisionBefore + 1, "Use as eyes did not reach the session route");
            check(optInVisionCalls.length === rowVisionBefore + 1 && optInVisionCalls.at(-1)?.selection?.providerId === "direct" && optInVisionCalls.at(-1)?.selection?.modelId === "xai::optin-grok", "Use as eyes did not save the row-chosen endpoint model");
            await settle(4);
            check(buttonWithText(rowPanel, "Grok API").getAttribute("aria-checked") === "true", "Applying did not retain the enabled switch");
            check(footerSave(rowPanel).disabled, "Use as eyes stayed available with no pending change");
            // A keyless row still opens the key editor instead of choosing.
            await click(buttonWithText(rowPanel, "Gemini API"));
            check(document.querySelector(".vision-api-editor"), "A keyless row did not open the key editor");

            progress("stored key remains selectable when discovery is unavailable");
            const staleSession = session("eyes-stale-key");
            const staleRequest = async (type, payload) => {
              if (type === "vision.targets") return { targets: [visionTarget("stale-safe", "Stale Safe")], incomplete: false };
              if (type === "session.vision.get") return { vision: { sessionId: staleSession.id, primaryModelSupportsImageInput: false, configured: null } };
              if (type === "wallet.get") return { wallet: wallet(payload.endpointId, true) };
              return {};
            };
            await mount(<VisionEyesPicker snapshot={snapshot(staleSession, false)} session={staleSession} request={staleRequest} action="settings" onClose={() => undefined} onReady={() => undefined} />);
            await settle(4);
            const stalePanel = element(".vision-eyes-picker");
            await click(buttonWithText(stalePanel, "Grok API"));
            check(stalePanel.querySelector(".vision-single-choice"), "Unavailable discovery prevented an endpoint choice");
            check(buttonWithText(stalePanel, "Grok API").getAttribute("aria-checked") === "true", "Unavailable discovery blocked the local toggle");
            check(!document.querySelector(".vision-api-editor"), "Selecting a saved endpoint unexpectedly opened key setup");
            check(!footerSave(stalePanel).disabled, "Unavailable discovery stranded the apply control");
            await click(footerSave(stalePanel));
            check(stalePanel.querySelector('[role="alert"]'), "Unavailable discovery failed silently when applying");

            progress("titlebar key failure and double save");
            const titlebarSession = { ...session("titlebar-key"), providerId: "direct", model: "google::gemini-qa" };
            let titlebarWallet = { ...wallet("google", true), balance: 25 };
            const titlebarConfigureGate = deferred();
            const titlebarConfigureCalls = [];
            let titlebarMode = "deferred-failure";
            let titlebarRefreshes = 0;
            bridgeHandler = async (type, payload) => {
              if (type === "wallet.get") return envelope({ wallet: titlebarWallet });
              if (type === "wallet.configure") {
                titlebarConfigureCalls.push(payload);
                if (titlebarMode === "deferred-failure") return titlebarConfigureGate.promise;
                if (payload.clearBalance === true) {
                  const { balance, ...clearedWallet } = titlebarWallet;
                  titlebarWallet = clearedWallet;
                }
                return envelope({ wallet: titlebarWallet });
              }
              return envelope({});
            };
            await mount(<WalletDropdown snapshot={snapshot(titlebarSession, false)} session={titlebarSession} notify={() => undefined} onRefreshProviderModels={async () => { titlebarRefreshes += 1; }} />);
            await click(element(".wallet-trigger"));
            let titlebarInput = element('.wallet-direct-settings input[type="password"]');
            await setControl(titlebarInput, "invalid-titlebar-key");
            const titlebarSave = buttonWithText(element(".wallet-popover"), "Save key");
            titlebarSave.click();
            titlebarSave.click();
            await settle(2);
            check(titlebarConfigureCalls.length === 1, "Double titlebar key save crossed the request boundary twice");
            check(titlebarConfigureCalls[0].validateApiKey === true, "Titlebar key save did not require validation");
            titlebarConfigureGate.resolve(rejected("RAW_TITLEBAR_KEY_SECRET"));
            await settle(6);
            titlebarInput = element('.wallet-direct-settings input[type="password"]');
            check(titlebarInput.value === "invalid-titlebar-key", "Failed titlebar key validation discarded the draft key");
            const titlebarError = element(".wallet-inline-error");
            check(titlebarError.textContent.includes("That API key could not be verified"), "Titlebar key failure had no safe inline feedback");
            check(!element(".wallet-popover").textContent.includes("RAW_TITLEBAR_KEY_SECRET"), "Raw titlebar key error reached visible text");
            titlebarMode = "success";
            await setControl(titlebarInput, "replacement-titlebar-key");
            await click(titlebarSave);
            check(element('.wallet-direct-settings input[type="password"]').value === "", "Successful titlebar replacement did not clear the submitted key");
            check(!document.querySelector(".wallet-inline-error"), "Successful titlebar replacement retained a stale error");
            check(titlebarRefreshes === 1, "Successful titlebar replacement did not refresh direct models once");
            const clearSpendCap = [...element(".wallet-budget").querySelectorAll("button")].find((button) => button.textContent === "Clear");
            check(clearSpendCap, "Clear spend cap is missing");
            await click(clearSpendCap);
            check(titlebarConfigureCalls.at(-1)?.clearBalance === true, "Clear spend cap did not send an explicit clear operation");
            check(titlebarConfigureCalls.at(-1)?.setBalance === undefined, "Clear spend cap silently wrote a zero cap");
            check(!element(".wallet-stats").textContent.includes("stops at"), "Cleared spend cap remained visible as an active limit");

            progress("titlebar wallet follows the selected task");
            const codexBillingSession = session("wallet-codex");
            const opencodeBillingSession = { ...session("wallet-opencode"), providerId: "opencode", model: "opencode-model" };
            const codexBilling = { providerId: "codex", kind: "subscription", label: "Codex subscription", detail: "Uses the signed-in Codex subscription.", currency: "USD", apiKeyConfigured: true };
            const opencodeBilling = { providerId: "opencode", kind: "harness", label: "OpenCode account", detail: "OpenCode manages this task's funding.", currency: "USD", apiKeyConfigured: true };
            const staleDirectGate = deferred();
            let directBillingRequests = 0;
            const billingCalls = [];
            bridgeHandler = async (type, payload) => {
              if (type !== "wallet.get") return envelope({});
              billingCalls.push(payload);
              if (payload.providerId === "codex") return envelope({ wallet: codexBilling });
              if (payload.providerId === "opencode") return envelope({ wallet: opencodeBilling });
              if (payload.providerId === "direct") {
                directBillingRequests += 1;
                if (directBillingRequests === 1) return envelope({ wallet: { ...wallet("google", false), detail: "Gemini API key is not configured." } });
                return staleDirectGate.promise;
              }
              return envelope({});
            };
            let captureTaskSwitchFirstPaint = false;
            let taskSwitchFirstPaint = "";
            function BillingWalletProbe({ currentSession }) {
              const currentSnapshot = snapshot(currentSession, false);
              currentSnapshot.providers = [...providers, provider("opencode", "OpenCode")];
              currentSnapshot.models.opencode = [];
              React.useLayoutEffect(() => {
                if (captureTaskSwitchFirstPaint) taskSwitchFirstPaint = document.querySelector(".wallet-popover")?.textContent ?? "";
              }, [currentSession.id]);
              return <WalletDropdown snapshot={currentSnapshot} session={currentSession} notify={() => undefined} onRefreshProviderModels={async () => undefined} />;
            }
            const billingNode = (currentSession) => <BillingWalletProbe currentSession={currentSession} />;
            await mount(billingNode(codexBillingSession));
            await click(element(".wallet-trigger"));
            let billingPopover = element(".wallet-popover");
            check(billingPopover.textContent.includes("Codex subscription"), "Selected Codex task did not own the titlebar wallet");
            await click(buttonWithText(billingPopover, "Configure Direct API"));
            billingPopover = element(".wallet-popover");
            check(billingPopover.textContent.includes("Direct API configuration"), "Explicit Direct API settings were not presented as configuration");
            check(billingPopover.textContent.includes("Gemini API key is not configured"), "Explicit Direct API settings did not show their own confirmed state");
            await click(element(".wallet-trigger"));
            await click(element(".wallet-trigger"));
            billingPopover = element(".wallet-popover");
            check(billingPopover.textContent.includes("Codex subscription"), "Reopening the wallet retained optional Direct API settings over task billing");

            await click(buttonWithText(billingPopover, "Configure Direct API"));
            captureTaskSwitchFirstPaint = true;
            await rerender(billingNode(opencodeBillingSession));
            captureTaskSwitchFirstPaint = false;
            check(!taskSwitchFirstPaint.includes("Direct API configuration") && !taskSwitchFirstPaint.includes("Gemini API key is not configured"), "Task switch painted stale Direct API settings before task billing hydrated");
            billingPopover = element(".wallet-popover");
            check(billingPopover.textContent.includes("OpenCode account"), "Changing tasks did not immediately restore the new task's billing route");
            staleDirectGate.resolve(envelope({ wallet: { ...wallet("google", true), detail: "STALE_DIRECT_CONFIGURATION" } }));
            await settle(6);
            billingPopover = element(".wallet-popover");
            check(billingPopover.textContent.includes("OpenCode account"), "A late Direct API response replaced the selected task's billing route");
            check(!billingPopover.textContent.includes("STALE_DIRECT_CONFIGURATION"), "A late Direct API response reached the selected task's wallet");

            progress("direct task endpoint rollback uses the task route");
            const xaiBillingSession = { ...session("wallet-xai"), providerId: "direct", model: "xai::grok-4.6" };
            bridgeHandler = async (type, payload) => {
              if (type !== "wallet.get") return envelope({});
              if (payload.providerId === "direct" && payload.modelId === xaiBillingSession.model) return envelope({ wallet: wallet("xai", true) });
              if (payload.providerId === "direct" && payload.endpointId === "google") return rejected("ENDPOINT_CHECK_FAILED");
              return envelope({});
            };
            await rerender(billingNode(xaiBillingSession));
            billingPopover = element(".wallet-popover");
            check(billingPopover.textContent.includes("Grok API"), "Direct task did not show its model's actual endpoint");
            await setControl(element('.wallet-direct-settings select'), "google");
            check(element('.wallet-direct-settings select').value === "xai", "Failed endpoint check rolled a Direct task back to optional settings instead of its task endpoint");
            check(billingPopover.textContent.includes("previous endpoint is still selected"), "Failed endpoint check did not keep an owned recovery message");

            progress("late task wallet response is rejected");
            const staleTaskWalletGate = deferred();
            bridgeHandler = async (type, payload) => {
              if (type !== "wallet.get") return envelope({});
              if (payload.providerId === "codex") return staleTaskWalletGate.promise;
              if (payload.providerId === "opencode") return envelope({ wallet: opencodeBilling });
              return envelope({});
            };
            await mount(billingNode(codexBillingSession));
            await rerender(billingNode(opencodeBillingSession));
            await click(element(".wallet-trigger"));
            check(element(".wallet-popover").textContent.includes("OpenCode account"), "The new task wallet did not win while an older task request was pending");
            staleTaskWalletGate.resolve(envelope({ wallet: { ...codexBilling, detail: "STALE_TASK_BILLING" } }));
            await settle(6);
            check(element(".wallet-popover").textContent.includes("OpenCode account"), "A late previous-task wallet response replaced the selected task's billing route");
            check(!element(".wallet-popover").textContent.includes("STALE_TASK_BILLING"), "A late previous-task wallet response reached the selected task's wallet");

            progress("titlebar wallet has no first-online fallback");
            const emptyBillingSnapshot = { ...snapshot(codexBillingSession, false), sessions: [], timelines: {} };
            let emptyWalletCalls = 0;
            bridgeHandler = async (type) => {
              if (type === "wallet.get") emptyWalletCalls += 1;
              return envelope({});
            };
            await mount(<WalletDropdown snapshot={emptyBillingSnapshot} session={null} notify={() => undefined} onRefreshProviderModels={async () => undefined} />);
            await click(element(".wallet-trigger"));
            check(emptyWalletCalls === 0, "No selected task silently queried the first online provider wallet");
            check(element(".wallet-popover").textContent.includes("Select a task to see how it is funded"), "No selected task did not show neutral billing settings");

            progress("task details partial refresh uses latest cache");
            const independentDetailsSession = session("eyes-details-independent");
            const independentDetailsStatusGate = deferred();
            const independentDetailsRequest = async (type) => {
              if (type === "vision.targets") return envelope({ targets: [visionTarget("independent-vision", "Independent Vision")], incomplete: false });
              if (type === "session.vision.get") return independentDetailsStatusGate.promise;
              if (type === "session.children" || type === "session.side_chats") return envelope({ sessions: [] });
              return envelope({});
            };
            bridgeHandler = independentDetailsRequest;
            await mount(<TaskDetailsControl session={independentDetailsSession} providers={providers} onOpenChild={() => undefined} foreignSubagentsEnabled={false} sessionForeignSubagents={true} onSessionForeignSubagents={() => undefined} />);
            await click(element(".task-details-trigger"));
            const independentDetailsSelect = element('select[aria-label="Task EYES model"]');
            check(!independentDetailsSelect.disabled, "Task Details blocked usable models while saved status was still hydrating");
            check([...independentDetailsSelect.options].some((option) => option.textContent?.includes("Independent Vision")), "Task Details did not paint independently hydrated models");
            independentDetailsStatusGate.resolve(envelope({ vision: { sessionId: independentDetailsSession.id, primaryModelSupportsImageInput: false, configured: null } }));
            await settle(2);

            progress("task details partial refresh uses latest cache");
            const partialDetailsSession = session("eyes-details-partial-cache");
            const staleDetailsTarget = visionTarget("stale-details-model", "Stale Details", "codex", "Codex");
            const currentDetailsTarget = visionTarget("current-details-model", "Current Details", "opencode", "OpenCode");
            const freshDetailsTarget = visionTarget("fresh-details-model", "Fresh Details", "grok", "Grok");
            let partialDetailsTargetCalls = 0;
            bridgeHandler = async (type) => {
              if (type === "session.children") return envelope({ sessions: [] });
              if (type === "session.side_chats") return envelope({ sessions: [] });
              if (type === "session.vision.get") return envelope({ vision: { sessionId: partialDetailsSession.id, primaryModelSupportsImageInput: false, configured: null } });
              if (type === "vision.targets") {
                partialDetailsTargetCalls += 1;
                if (partialDetailsTargetCalls === 1) return envelope({ targets: [staleDetailsTarget], incomplete: true });
                if (partialDetailsTargetCalls === 2) return envelope({ targets: [currentDetailsTarget], incomplete: false });
                return envelope({ targets: [freshDetailsTarget], incomplete: true });
              }
              return envelope({});
            };
            await mount(<TaskDetailsControl session={partialDetailsSession} providers={providers} onOpenChild={() => undefined} foreignSubagentsEnabled={false} sessionForeignSubagents={true} onSessionForeignSubagents={() => undefined} />);
            await click(element(".task-details-trigger"));
            let partialDetailsPanel = element(".task-details-popover");
            let partialDetailsOptions = [...element('select[aria-label="Task EYES model"]').options];
            check(partialDetailsOptions.some((option) => option.textContent?.includes("Stale Details")), "Initial partial Task Details catalogue was not painted");
            await click(buttonWithText(partialDetailsPanel, "Retry"));
            partialDetailsOptions = [...element('select[aria-label="Task EYES model"]').options];
            check(partialDetailsOptions.some((option) => option.textContent?.includes("Current Details")), "Complete Task Details refresh was not painted");
            check(!partialDetailsOptions.some((option) => option.textContent?.includes("Stale Details")), "Complete Task Details refresh retained stale choices");
            await click(element('button[aria-label="Close task details"]'));
            await click(element(".task-details-trigger"));
            partialDetailsPanel = element(".task-details-popover");
            partialDetailsOptions = [...element('select[aria-label="Task EYES model"]').options];
            check(partialDetailsOptions.some((option) => option.textContent?.includes("Current Details")), "Later partial Task Details refresh lost the latest complete catalogue");
            check(partialDetailsOptions.some((option) => option.textContent?.includes("Fresh Details")), "Later partial Task Details refresh lost its fresh choice");
            check(!partialDetailsOptions.some((option) => option.textContent?.includes("Stale Details")), "Later partial Task Details refresh resurrected an older same-length catalogue");

            progress("task details selection races");
            const detailsSession = session("sensitive-session-id");
            const detailsTargets = [codexVisionTarget([["vision-a-internal", "Vision Alpha"], ["vision-b-internal", "Vision Beta"]])];
            const childGate = deferred();
            const staleStatusGate = deferred();
            const configureGate = deferred();
            const detailsConfigureCalls = [];
            let detailsChoice = { providerId: "codex", modelId: "vision-a-internal" };
            let detailsStatusCalls = 0;
            let detailsConfigureMode = "deferred-success";
            const detailsStatus = (choice) => ({ sessionId: detailsSession.id, primaryModelSupportsImageInput: false, configured: choice });
            bridgeHandler = async (type, payload) => {
              if (type === "session.children") return childGate.promise;
              if (type === "session.side_chats") return envelope({ sessions: [] });
              if (type === "vision.targets") return envelope({ targets: detailsTargets, incomplete: true });
              if (type === "session.vision.get") {
                detailsStatusCalls += 1;
                if (detailsStatusCalls === 2) return staleStatusGate.promise;
                return envelope({ vision: detailsStatus(detailsChoice) });
              }
              if (type === "session.vision.configure") {
                detailsConfigureCalls.push(payload);
                if (detailsConfigureMode === "deferred-success") return configureGate.promise;
                return rejected("RAW_TASK_DETAILS_SAVE_SECRET");
              }
              return envelope({});
            };
            await mount(<TaskDetailsControl session={detailsSession} providers={providers} onOpenChild={() => undefined} foreignSubagentsEnabled={false} sessionForeignSubagents={true} onSessionForeignSubagents={() => undefined} />);
            await click(element(".task-details-trigger"));
            let detailsPanel = element(".task-details-popover");
            let detailsSelect = element('select[aria-label="Task EYES model"]');
            check(detailsPanel.textContent.includes("Checking this task"), "Child loading did not remain independent in Task Details");
            check(!detailsSelect.disabled && detailsSelect.value === "codex|vision-a-internal", "EYES hydration waited for child sessions");
            check(detailsPanel.textContent.includes("Some visual models could not be refreshed. Available choices are still shown."), "Task Details did not preserve usable choices during partial discovery");
            await setControl(detailsSelect, "codex|vision-b-internal", false);
            await setControl(detailsSelect, "codex|vision-b-internal", false);
            await settle(2);
            check(detailsConfigureCalls.length === 1, "Double Task Details selection crossed the save boundary twice");
            await click(element('button[aria-label="Close task details"]'));
            await click(element(".task-details-trigger"));
            detailsChoice = { providerId: "codex", modelId: "vision-b-internal" };
            configureGate.resolve(envelope({}));
            await settle(6);
            detailsPanel = element(".task-details-popover");
            detailsSelect = element('select[aria-label="Task EYES model"]');
            check(detailsSelect.value === "codex|vision-b-internal", "Authoritative post-save choice was not applied");
            staleStatusGate.resolve(envelope({ vision: detailsStatus({ providerId: "codex", modelId: "vision-a-internal" }) }));
            childGate.resolve(envelope({ sessions: [] }));
            await settle(6);
            check(detailsSelect.value === "codex|vision-b-internal", "Late Task Details refresh overwrote the newer saved choice");
            detailsConfigureMode = "failure";
            await setControl(detailsSelect, "codex|vision-a-internal", false);
            await setControl(detailsSelect, "codex|vision-a-internal", false);
            await settle(6);
            check(detailsConfigureCalls.length === 2, "Failed double selection was not coalesced into one additional save");
            check(detailsSelect.value === "codex|vision-b-internal", "Failed Task Details save did not restore authoritative state");
            check(detailsPanel.textContent.includes("The visual model was not changed"), "Failed Task Details save had no safe inline feedback");
            check(!detailsPanel.textContent.includes("RAW_TASK_DETAILS_SAVE_SECRET"), "Raw Task Details error reached visible text");
            check(!/helper session/iu.test(detailsPanel.textContent), "Task Details exposes helper implementation prose");
            check(![...detailsPanel.querySelectorAll("h2[id]")].some((heading) => heading.id.includes(detailsSession.id)), "Task Details heading IDs expose the session ID");
            check(!detailsPanel.textContent.includes("vision-a-internal") && !detailsPanel.textContent.includes("vision-b-internal"), "Task Details exposes raw model IDs in visible text");

            progress("live vision event updates open task details");
            const liveDetailsSession = session("eyes-live-details");
            const liveDetailsTargets = [codexVisionTarget([["details-live-a", "Details Live A"], ["details-live-b", "Details Live B"]])];
            bridgeHandler = async (type) => {
              if (type === "session.children") return envelope({ sessions: [] });
              if (type === "session.side_chats") return envelope({ sessions: [] });
              if (type === "vision.targets") return envelope({ targets: liveDetailsTargets, incomplete: false });
              if (type === "session.vision.get") return envelope({ vision: { sessionId: liveDetailsSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "details-live-a" } } });
              return envelope({});
            };
            const detailsNode = (liveStatus) => <TaskDetailsControl session={liveDetailsSession} providers={providers} liveVisionStatus={liveStatus} onOpenChild={() => undefined} foreignSubagentsEnabled={false} sessionForeignSubagents={true} onSessionForeignSubagents={() => undefined} />;
            await mount(detailsNode(undefined));
            await click(element(".task-details-trigger"));
            const openDetails = element(".task-details-popover");
            check(element('select[aria-label="Task EYES model"]').value === "codex|details-live-a", "Open Task Details did not hydrate its initial saved choice");
            const liveDetailsStatuses = reconcileVisionStatusEvents({}, [{
              eventId: "vision-event-details", sequence: 2, type: "session.vision_updated",
              occurredAt: "2026-08-27T12:00:01.000Z", providerId: "codex", sessionId: liveDetailsSession.id,
              payload: { vision: { sessionId: liveDetailsSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "details-live-b" } } },
            }]);
            await rerender(detailsNode(liveDetailsStatuses[liveDetailsSession.id]));
            check(element(".task-details-popover") === openDetails, "Live EYES status remounted the open Task Details panel");
            check(element('select[aria-label="Task EYES model"]').value === "codex|details-live-b", "Open Task Details ignored the live saved choice");

            progress("synchronous live status beats a stale task-details request");
            const detailsRaceSession = session("eyes-details-status-race");
            const detailsRaceTargets = [codexVisionTarget([["details-race-a", "Details Race A"], ["details-race-b", "Details Race B"]])];
            const detailsRaceGate = deferred();
            let detailsRaceLiveStatus;
            bridgeHandler = async (type) => {
              if (type === "session.children") return envelope({ sessions: [] });
              if (type === "session.side_chats") return envelope({ sessions: [] });
              if (type === "vision.targets") return envelope({ targets: detailsRaceTargets, incomplete: false });
              if (type === "session.vision.get") return detailsRaceGate.promise;
              return envelope({});
            };
            await mount(<TaskDetailsControl session={detailsRaceSession} providers={providers} readLiveVisionStatus={() => detailsRaceLiveStatus} onOpenChild={() => undefined} foreignSubagentsEnabled={false} sessionForeignSubagents={true} onSessionForeignSubagents={() => undefined} />);
            await click(element(".task-details-trigger"));
            detailsRaceLiveStatus = { sessionId: detailsRaceSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "details-race-b" } };
            detailsRaceGate.resolve(envelope({ vision: { sessionId: detailsRaceSession.id, primaryModelSupportsImageInput: false, configured: { providerId: "codex", modelId: "details-race-a" } } }));
            await settle(5);
            check(element('select[aria-label="Task EYES model"]').value === "codex|details-race-b", "A stale Task Details status request overwrote the newer synchronous provider event");

            progress("visible app-owned EYES failure notice");
            const eyesFailure = eventToTimeline({
              eventId: "eyes-failure-notice", sequence: 50, type: "tool.completed",
              occurredAt: "2026-08-27T12:10:00.000Z", providerId: "direct", sessionId: "eyes-parent",
              payload: { name: "tethoq_turn_support", callId: "private-eyes-call", status: "failed", error: "429 quota exhausted for api_key=RAW_EYES_SECRET https://provider.invalid/private" },
            });
            check(eyesFailure?.notice === "eyes_failure" && eyesFailure.state === "completed", "EYES failure was not normalized as a non-terminal app-owned notice");
            await mount(<ChatTimeline timeline={[eyesFailure]} providerId="direct" active={true} />);
            const visibleEyesNotices = [...document.querySelectorAll(".timeline-error-notice")];
            check(visibleEyesNotices.length === 1, "EYES failure did not paint exactly one calm visible notice");
            check(visibleEyesNotices[0].textContent.includes("usage limit was reached"), "Visible EYES notice lost the useful failure cause");
            check(!document.body.textContent.includes("RAW_EYES_SECRET") && !document.body.textContent.includes("provider.invalid"), "Raw EYES diagnostics reached the rendered notice");
            check(!document.querySelector(".activity-disclosure"), "EYES failure was buried inside the Reasoning disclosure");

            progress("complete");
            await unmount();
            window.__eyesQaResult = { ok: true };
          } catch (error) {
            window.__eyesQaResult = { ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "", progress: window.__eyesQaProgress };
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
        const result = await window.webContents.executeJavaScript('new Promise((resolve, reject) => { const started = performance.now(); const check = () => { if (window.__eyesQaResult) return resolve(window.__eyesQaResult); if (performance.now() - started > 35000) return reject(new Error("Renderer did not finish mounted EYES QA at: " + (window.__eyesQaProgress || "startup"))); setTimeout(check, 10); }; check(); })', true);
        process.stdout.write("TETHOQ_EYES_QA=" + JSON.stringify(result) + "\n");
        window.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exitCode = 1; app.quit(); });
    `, "utf8");

    const result = await runElectron(mainPath, htmlPath);
    assert.deepEqual(result, { ok: true }, result.error ?? result.stack);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
