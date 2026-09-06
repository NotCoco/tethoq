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
      contents: "export default class InlineWorkerStub { addEventListener() {} postMessage() {} terminate() {} }",
      loader: "js",
    }));
  },
};

function runElectron(mainPath, htmlPath, screenshotPath) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete environment.ELECTRON_RUN_AS_NODE;
    if (screenshotPath) environment.TETHOQ_MESH_QA_SCREENSHOT = screenshotPath;
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
      reject(new Error(`Mounted Mesh timeline QA timed out.\n${stderr}`));
    }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`Mounted Mesh timeline QA exited ${code}.\n${stderr}\n${stdout}`)); return; }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_MESH_TIMELINE_QA="));
      if (!marker) { reject(new Error(`Mounted Mesh timeline QA returned no result.\n${stderr}\n${stdout}`)); return; }
      resolve(JSON.parse(marker.slice("TETHOQ_MESH_TIMELINE_QA=".length)));
    });
  });
}

test("mounted Mesh child row settles and opens only its exact child by pointer or keyboard", { timeout: 60_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-mesh-timeline-${process.pid}-${Date.now()}`);
  const rendererBundle = join(outputDirectory, "renderer.js");
  const htmlPath = join(outputDirectory, "index.html");
  const mainPath = join(outputDirectory, "main.cjs");
  const screenshotPath = process.env.TETHOQ_MESH_QA_SCREENSHOT || "";
  await mkdir(outputDirectory, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot,
        sourcefile: "mesh-timeline-mounted-qa.tsx",
        loader: "tsx",
        contents: String.raw`
          import React from "react";
          import { createRoot } from "react-dom/client";
          import "./src/renderer/src/styles.css";

          globalThis.IS_REACT_ACT_ENVIRONMENT = false;
          window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
          window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
          window.addEventListener("error", (event) => { window.__meshQaResult = { ok: false, error: event.error?.stack || event.message }; });
          window.addEventListener("unhandledrejection", (event) => { window.__meshQaResult = { ok: false, error: event.reason?.stack || String(event.reason) }; });
          window.tethoqDesktop = {
            request: async () => ({ ok: true, payload: {} }),
            selectFiles: async () => [],
            selectImages: async () => [],
          };

          const [{ ChatTimeline, groupTimeline, anchorMeshChildren }, { resolveTimelineSubagentSession }] = await Promise.all([
            import("./src/renderer/src/ChatTimeline.tsx"),
            import("./src/renderer/src/App.tsx"),
          ]);
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const settle = async (count = 4) => {
            for (let index = 0; index < count; index += 1) {
              await new Promise((resolve) => setTimeout(resolve, 0));
              await new Promise((resolve) => requestAnimationFrame(resolve));
            }
          };
          const session = (id, sourceSessionId = "mesh-parent") => ({
            id, providerId: "opencode", title: id, state: "completed", project: "qa",
            workingDirectory: "C:\\qa", preview: "Finished child output", updatedAt: "2026-09-03T11:00:00.000Z",
            model: "deepseek-v4", effort: "xhigh", relationshipKind: "subagent", relationshipSourceSessionId: sourceSessionId,
          });
          const exactChild = session("mesh-child");
          const sibling = session("mesh-child-near-match");
          const unverifiedCached = session("mesh-child", "different-parent");
          let cacheLoaderCalls = 0;
          const cached = await resolveTimelineSubagentSession("mesh-parent", "mesh-child", [exactChild], async () => {
            cacheLoaderCalls += 1;
            return [];
          });
          check(cached === exactChild && cacheLoaderCalls === 0, "a verified cached child should open without a bridge read");
          const refreshed = await resolveTimelineSubagentSession("mesh-parent", "mesh-child", [unverifiedCached], async (parentSessionId) => {
            check(parentSessionId === "mesh-parent", "the exact parent id should scope the child lookup");
            return [sibling, exactChild];
          });
          check(refreshed === exactChild, "an unverified cache entry must be replaced by the exact listed child");
          const missing = await resolveTimelineSubagentSession("mesh-parent", "missing-child", [], async () => [sibling, exactChild]);
          check(missing === null, "a missing child id must not fabricate a partial task");

          const { mapMessages } = await import("./src/renderer/src/bridge.ts");
          const mesh = {
            delegationId: "mesh-turn",
            targets: [
              { providerId: "grok", modelId: "Grok Code", reasoningEffort: "high" },
              { providerId: "grok", modelId: "Grok Code", reasoningEffort: "high" },
              { providerId: "codex", modelId: "GPT-5.6 Sol", reasoningEffort: "ultra" },
            ],
            segments: [
              { type: "text", text: "Ask **" }, { type: "mesh", targetIndex: 0 },
              { type: "text", text: "m** about caching, then " }, { type: "mesh", targetIndex: 1 },
              { type: "text", text: " about retries.\nHave " }, { type: "mesh", targetIndex: 2 },
              { type: "text", text: " review both results." },
            ],
          };
          const user = mapMessages([{
            id: "user", providerMessageId: "turn", sessionId: "mesh-parent", role: "user",
            createdAt: "2026-09-03T10:59:57.000Z", status: "completed",
            parts: [{ type: "text", text: mesh.segments.filter((segment) => segment.type === "text").map((segment) => segment.text).join("") }],
            nativeMetadata: { tethoqMesh: mesh },
          }])[0];
          check(user.mesh?.targets.length === 3, "reopened history lost its Mesh badges");
          const reasoning = { id: "reasoning", messageId: "turn", kind: "reasoning", title: "Reasoning", body: "Preparing the focused assignment", timestamp: "2026-09-03T10:59:58.000Z", state: "completed" };
          const childRow = (state) => ({
            id: "mesh-parent:delegation:one:child:mesh-child", kind: "subagent", title: "Spawned sub-agent", body: "opencode · deepseek-v4 · xhigh",
            timestamp: "2026-09-03T10:59:56.000Z", state, delegationId: "mesh-turn", childSessionId: "mesh-child",
            childProviderId: "opencode", childModelId: "deepseek-v4", childReasoningEffort: "xhigh",
          });
          const answer = { id: "answer", messageId: "turn", kind: "assistant", phase: "final_answer", body: "The child is running independently.", timestamp: "2026-09-03T11:00:00.000Z", state: "completed" };
          const groups = groupTimeline(anchorMeshChildren([childRow("completed"), user, reasoning, answer]));
          check(groups[0]?.kind === "item" && groups[0].item === user, "a prepared timestamp must not place a child before its prompt");
          check(groups[1]?.kind === "reasoning" && groups[1].items.some((item) => item.childSessionId === "mesh-child"), "finished Mesh children must join their turn's Reasoning");

          document.body.style.cssText = "margin:0;background:#10100f;color:#e4e7e4;font-family:Inter,Segoe UI,sans-serif";
          const host = document.createElement("main");
          host.className = "conversation";
          host.style.cssText = "box-sizing:border-box;width:840px;padding:42px 54px";
          document.body.append(host);
          const root = createRoot(host);
          const opened = [];
          let loaderCalls = 0;
          const onOpenSubagent = async (item) => {
            const child = await resolveTimelineSubagentSession("mesh-parent", item.childSessionId, [unverifiedCached], async () => {
              loaderCalls += 1;
              return [sibling, exactChild];
            });
            check(child === exactChild, "activation must resolve only the exact complete child task");
            opened.push({ mode: window.__meshQaActivationMode || "pointer", id: child.id });
            if (opened.length === 1) window.__meshQaPointerDone = true;
            if (opened.length === 2) {
              check(opened[0].mode === "pointer" && opened[1].mode === "keyboard", "both pointer and Enter should activate the whole row");
              check(opened.every((entry) => entry.id === "mesh-child"), "no sibling or partial task may open");
              check(loaderCalls === 2, "each unverified activation should perform one parent-scoped child read");
              window.__meshQaResult = { ok: true, opened, loaderCalls };
            }
          };
          const render = (state) => root.render(<ChatTimeline
            timeline={[childRow(state), user, { ...reasoning, state }, answer]}
            providerId="opencode"
            active={state === "running"}
            onOpenSubagent={onOpenSubagent}
          />);

          render("running");
          await settle();
          const messageBody = document.querySelector(".message-user .message-body");
          const badges = [...messageBody.querySelectorAll(".message-mesh-widget")];
          check(messageBody.querySelector("strong .message-mesh-widget"), "formatting across a Mesh badge must survive in the sent message");
          check(badges.length === 3 && badges.map((badge) => badge.dataset.targetIndex).join(",") === "0,1,2", "sent badges must preserve duplicate target slots in their original order");
          check(messageBody.textContent === "Ask Grok Code · Highm about caching, then Grok Code · High about retries.\nHave GPT-5.6 Sol · Ultra review both results.", "reopened message changed the badge positions or surrounding text");
          for (const badge of badges) {
            const bubble = badge.querySelector(".composer-mesh-widget-body");
            const style = getComputedStyle(bubble);
            check(style.borderStyle === "solid" && parseFloat(style.borderRadius) >= 99, "sent target lost its rounded bounding bubble");
            check(style.color === "rgb(215, 218, 215)", "provider colour must stay on the bubble, not the text");
            const following = badge.nextSibling;
            if (following?.nodeType === Node.TEXT_NODE && following.textContent) {
              const range = document.createRange(); range.setStart(following, 0); range.setEnd(following, 1);
              const text = range.getBoundingClientRect(); const bounds = badge.getBoundingClientRect();
              check(text.top > bounds.bottom - 1 || text.left >= bounds.right - 1, "text typed directly after a sent badge overlaps it");
            }
          }
          let row = document.querySelector(".spawned-subagent-row");
          check(row, "the parent transcript needs a spawned-sub-agent row");
          check(row.getBoundingClientRect().top >= document.querySelector('.message-user').getBoundingClientRect().bottom, "the running child must stay after its own prompt");
          check(row.closest(".reasoning-group") === null, "the spawned row must not live inside Reasoning");
          check(!row.hasAttribute("aria-expanded") && !document.querySelector(".activity-snippet"), "the spawned row must not expose generic activity expansion");
          check(row.getAttribute("aria-busy") === "true" && row.querySelector(".spinner"), "a running child needs a compact working state: " + row.outerHTML);

          window.__meshQaRunningReady = true;
          await new Promise((resolve) => { const wait = () => window.__meshQaRunningCaptured === true ? resolve() : setTimeout(wait, 10); wait(); });

          render("completed");
          await settle();
          check(!document.querySelector('.spawned-subagent-row'), "finished Mesh activity must collapse inside Reasoning");
          const disclosure = document.querySelector('.reasoning-disclosure');
          check(disclosure?.getAttribute('aria-expanded') === 'false', "the formerly live Mesh reasoning must settle collapsed");
          window.__meshQaCollapsedReady = true;
          await new Promise((resolve) => { const wait = () => window.__meshQaCollapsedCaptured === true ? resolve() : setTimeout(wait, 10); wait(); });
          disclosure.click();
          await settle();
          row = document.querySelector(".spawned-subagent-row");
          check(row?.closest('.reasoning-group'), "the reopened child must be inside Reasoning");
          check(row?.dataset.childState === "completed", "the child row should settle to completed");
          check(!row.hasAttribute("aria-busy") && !row.querySelector(".spinner"), "a finished child must stop presenting as live");
          check(row.querySelector(".spawned-subagent-state")?.textContent?.trim() === "finished", "the completed state should be visibly named");
          check(/opencode/iu.test(row.textContent || "") && row.textContent?.includes("deepseek-v4") && row.textContent?.includes("xhigh"), "provider, model, and reasoning detail should remain readable");
          const primarySize = Number.parseFloat(getComputedStyle(row.querySelector("strong")).fontSize);
          const detailSize = Number.parseFloat(getComputedStyle(row.querySelector("small")).fontSize);
          check(detailSize < primarySize, "secondary child detail should remain quieter than the action label");
          check(getComputedStyle(row.querySelector("strong")).animationName === "none", "the settled spawn label must never shimmer");
          check(row.getBoundingClientRect().width <= 720 && row.getBoundingClientRect().height >= 42, "the row should keep a compact full-width target");
          root.render(<ChatTimeline
            timeline={[childRow("completed"), user, reasoning, answer,
              { ...user, id: "later-user", delegationId: "later-mesh", body: "A later request", mesh: undefined },
              { ...childRow("completed"), id: "later-child", delegationId: "later-mesh", childSessionId: "later-session" },
              { ...answer, id: "later-answer", body: "Later result" },
            ]}
            providerId="opencode" active={false} onOpenSubagent={onOpenSubagent}
          />);
          await settle();
          check(document.querySelector('.reasoning-disclosure')?.getAttribute('aria-expanded') === 'true', "a later Mesh completion must not close a manually reopened older turn");
          check(document.querySelectorAll('.spawned-subagent-row').length === 1, "the later completed child must start collapsed in its own turn");
          window.__meshQaVisualReady = true;
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
      const fs = require("node:fs");
      const path = require("node:path");
      const { app, BrowserWindow } = require("electron");
      app.commandLine.appendSwitch("disable-gpu");
      app.setPath("userData", path.join(__dirname, "profile"));
      const waitFor = (window, expression, timeout = 30000) => window.webContents.executeJavaScript(
        'new Promise((resolve, reject) => { const started = performance.now(); const check = () => { if (' + expression + ') return resolve(true); if (performance.now() - started > ' + timeout + ') return reject(new Error("Timed out waiting for " + ' + JSON.stringify(expression) + ')); setTimeout(check, 10); }; check(); })',
        true,
      );
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 840, height: 520, backgroundColor: "#10100f", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        await window.loadFile(process.argv[2]);
        window.webContents.debugger.attach("1.3");
        window.showInactive();
        const screenshotPath = process.env.TETHOQ_MESH_QA_SCREENSHOT;
        // The window is shown offscreen so it owns a real compositor surface:
        // a never-shown window keeps returning its first painted frame, which
        // would let a stale "running" pixel pose as the settled state.
        const capture = async (suffix) => {
          if (!screenshotPath) return;
          await new Promise((resolve) => setTimeout(resolve, 150));
          fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
          fs.writeFileSync(screenshotPath.replace(/\.png$/i, suffix + ".png"), (await window.capturePage()).toPNG());
        };
        await waitFor(window, "window.__meshQaRunningReady === true || window.__meshQaResult !== undefined");
        await capture("-running");
        await window.webContents.executeJavaScript("window.__meshQaRunningCaptured = true", true);
        await waitFor(window, "window.__meshQaCollapsedReady === true || window.__meshQaResult !== undefined");
        await capture("-collapsed");
        await window.webContents.executeJavaScript("window.__meshQaCollapsedCaptured = true", true);
        await waitFor(window, "window.__meshQaVisualReady === true || window.__meshQaResult !== undefined");
        const earlyResult = await window.webContents.executeJavaScript("window.__meshQaResult", true);
        if (earlyResult) {
          process.stdout.write("TETHOQ_MESH_TIMELINE_QA=" + JSON.stringify(earlyResult) + "\n");
          window.destroy();
          app.quit();
          return;
        }
        await capture("-finished");
        // The row must be inside the viewport before a real pointer can reach it;
        // an off-screen centre silently dispatches the click into nothing.
        const point = await window.webContents.executeJavaScript('(() => { const row = document.querySelector(".spawned-subagent-row"); row.scrollIntoView({ block: "center" }); const rect = row.getBoundingClientRect(); const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; if (point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight) throw new Error("the spawned row is outside the QA viewport: " + JSON.stringify(point) + " in " + innerWidth + "x" + innerHeight); return point; })()', true);
        await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await waitFor(window, "window.__meshQaPointerDone === true");
        await window.webContents.executeJavaScript('window.__meshQaActivationMode = "keyboard"; document.querySelector(".spawned-subagent-row").focus()', true);
        await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await window.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await waitFor(window, "window.__meshQaResult !== undefined");
        const result = await window.webContents.executeJavaScript("window.__meshQaResult", true);
        process.stdout.write("TETHOQ_MESH_TIMELINE_QA=" + JSON.stringify(result) + "\n");
        window.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exitCode = 1; app.quit(); });
    `, "utf8");

    const result = await runElectron(mainPath, htmlPath, screenshotPath);
    assert.deepEqual(result, {
      ok: true,
      opened: [{ mode: "pointer", id: "mesh-child" }, { mode: "keyboard", id: "mesh-child" }],
      loaderCalls: 2,
    });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
