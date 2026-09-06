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

function runElectron(mainPath) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [mainPath], { cwd: appRoot, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Mounted tooltip QA timed out.\n${stderr}`)); }, 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`Mounted tooltip QA exited ${code}.\n${stderr}\n${stdout}`)); return; }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_TOOLTIP_QA="));
      if (!marker) { reject(new Error(`Mounted tooltip QA returned no result.\n${stderr}\n${stdout}`)); return; }
      resolve(JSON.parse(marker.slice("TETHOQ_TOOLTIP_QA=".length)));
    });
  });
}

test("mounted tooltip overlay owns edge pixels, clamps to eight pixels, and avoids adjacent controls", { timeout: 40_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-tooltip-mounted-${process.pid}-${Date.now()}`);
  const rendererBundle = join(outputDirectory, "renderer.js");
  const htmlPath = join(outputDirectory, "index.html");
  const mainPath = join(outputDirectory, "main.cjs");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot,
        sourcefile: "tooltip-mounted-qa.tsx",
        loader: "tsx",
        contents: String.raw`
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { AppTooltipLayer } from "./src/renderer/src/TooltipLayer.tsx";
          import "./src/renderer/src/styles.css";
          import "./src/renderer/src/navigation.css";

          const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
          const settle = async (milliseconds = 25) => {
            await wait(milliseconds);
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          };
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const outside = document.createElement("button");
          outside.textContent = "Outside";
          outside.style.cssText = "position:fixed;left:360px;top:260px";
          document.body.append(outside);
          const host = document.createElement("div");
          document.body.append(host);
          createRoot(host).render(<AppTooltipLayer />);

          const tooltip = () => document.querySelector(".app-tooltip-overlay");
          const paintedTooltip = async (name) => {
            await settle();
            const tip = tooltip();
            check(tip instanceof HTMLElement, name + ": tooltip missing");
            await Promise.all(tip.getAnimations().map((animation) => animation.finished));
            await settle();
            return tip;
          };
          const hover = async (trigger) => {
            // Hidden Electron windows cannot receive OS hover. Apply the real
            // hover CSS state, then exercise the tooltip's pointer handler.
            globalThis.__tooltipHoverTarget = trigger.id;
            const deadline = Date.now() + 2000;
            while (globalThis.__tooltipHoverTarget && Date.now() < deadline) await settle(10);
            check(!globalThis.__tooltipHoverTarget, "Hover CSS state was not applied");
            trigger.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: outside }));
            await settle(500);
          };
          const hide = async () => {
            const described = document.querySelector('[data-tooltip][aria-describedby]');
            described?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
            outside.focus();
            await settle(130);
          };
          const measure = async (name, css) => {
            await hide();
            const trigger = document.createElement("button");
            trigger.id = "tooltip-" + name;
            trigger.className = "session-subagents-trigger";
            trigger.dataset.tooltip = name + " edge tooltip";
            trigger.textContent = name;
            trigger.style.cssText = "position:fixed;width:32px;height:32px;margin:0;padding:0;" + css;
            document.body.append(trigger);
            await hover(trigger);
            const tip = await paintedTooltip(name);
            const rect = tip.getBoundingClientRect();
            const triggerRect = trigger.getBoundingClientRect();
            const owner = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            const result = {
              name,
              rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
              trigger: { left: triggerRect.left, top: triggerRect.top, right: triggerRect.right, bottom: triggerRect.bottom },
              placement: tip.dataset.placement,
              bodyPortal: tip.parentElement === document.body,
              ownsCentre: owner === tip || tip.contains(owner),
              described: (trigger.getAttribute("aria-describedby") ?? "").split(/\s+/).includes(tip.id),
            };
            await hide();
            trigger.remove();
            return result;
          };

          (async () => {
            try {
              await settle();
              const edges = [];
              edges.push(await measure("top-left", "left:0;top:0"));
              edges.push(await measure("top-right", "right:0;top:0"));
              edges.push(await measure("bottom-left", "left:0;bottom:0"));
              edges.push(await measure("bottom-right", "right:0;bottom:0"));

              const blocker = document.createElement("button");
              blocker.textContent = "Next row";
              blocker.style.cssText = "position:fixed;left:8px;top:160px;width:210px;height:44px";
              document.body.append(blocker);
              const collisionTrigger = document.createElement("button");
              collisionTrigger.textContent = "Count";
              collisionTrigger.dataset.tooltip = "1 sub-agent";
              collisionTrigger.style.cssText = "position:fixed;left:28px;top:120px;width:54px;height:31px";
              document.body.append(collisionTrigger);
              collisionTrigger.focus();
              collisionTrigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: outside }));
              let liveTip = await paintedTooltip("collision");
              const collisionPlacement = liveTip.dataset.placement;
              const blockerRect = blocker.getBoundingClientRect();
              const collisionRect = liveTip.getBoundingClientRect();
              const overlapsBlocker = collisionRect.left < blockerRect.right && collisionRect.right > blockerRect.left && collisionRect.top < blockerRect.bottom && collisionRect.bottom > blockerRect.top;
              collisionTrigger.dataset.tooltip = "12 sub-agents";
              await settle();
              liveTip = tooltip();
              const liveText = liveTip?.textContent?.trim();
              globalThis.__tooltipQa = { viewport: { width: innerWidth, height: innerHeight }, edges, collisionPlacement, overlapsBlocker, liveText };
            } catch (error) {
              globalThis.__tooltipQa = { error: String(error?.stack ?? error) };
            }
          })();
        `,
      },
      outfile: rendererBundle,
      bundle: true,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      loader: { ".ts": "ts", ".tsx": "tsx", ".css": "css", ".svg": "dataurl" },
      logLevel: "silent",
    });
    await writeFile(htmlPath, '<!doctype html><html><head><link rel="stylesheet" href="./renderer.css"></head><body><script type="module" src="./renderer.js"></script></body></html>', "utf8");
    await writeFile(mainPath, String.raw`
      const path = require("node:path");
      const { app, BrowserWindow } = require("electron");
      app.commandLine.appendSwitch("disable-gpu");
      app.commandLine.appendSwitch("force-device-scale-factor", "1");
      app.setPath("userData", path.join(__dirname, "profile"));
      app.whenReady().then(async () => {
        // Offscreen rendering keeps animation, layout and hit testing advancing
        // even when CI has no interactive desktop displaying the hidden window.
        const window = new BrowserWindow({ x: -10000, y: -10000, width: 800, height: 560, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } });
        try {
          await window.loadFile(${JSON.stringify(htmlPath)});
          window.webContents.debugger.attach("1.3");
          await window.webContents.debugger.sendCommand("DOM.enable");
          await window.webContents.debugger.sendCommand("CSS.enable");
          const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
          const started = Date.now();
          let result = null;
          while (result === null && Date.now() - started < 12000) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            const hoverTarget = await window.webContents.executeJavaScript("globalThis.__tooltipHoverTarget ?? null", true);
            if (hoverTarget) {
              const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#" + hoverTarget });
              await window.webContents.debugger.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
              await window.webContents.executeJavaScript("globalThis.__tooltipHoverTarget = null", true);
            }
            result = await window.webContents.executeJavaScript("globalThis.__tooltipQa ?? null", true);
          }
          if (result === null) throw new Error("Renderer returned no tooltip result");
          process.stdout.write("TETHOQ_TOOLTIP_QA=" + JSON.stringify(result) + "\n");
        } catch (error) {
          process.stderr.write(String(error?.stack ?? error) + "\n");
          process.exitCode = 1;
        } finally { window.destroy(); app.quit(); }
      });
    `, "utf8");
    const result = await runElectron(mainPath);
    assert.equal(result.error, undefined, result.error);
    for (const edge of result.edges) {
      assert.equal(edge.bodyPortal, true, `${edge.name}: tooltip did not portal to BODY`);
      assert.equal(edge.ownsCentre, true, `${edge.name}: tooltip did not own its painted centre`);
      assert.equal(edge.described, true, `${edge.name}: tooltip was not attached to aria-describedby`);
      assert.ok(edge.rect.left >= 7.5 && edge.rect.top >= 7.5, `${edge.name}: tooltip crossed the top/left inset`);
      assert.ok(edge.rect.right <= result.viewport.width - 7.5 && edge.rect.bottom <= result.viewport.height - 7.5, `${edge.name}: tooltip crossed the bottom/right inset`);
      const horizontalGap = Math.max(edge.trigger.left - edge.rect.right, edge.rect.left - edge.trigger.right, 0);
      const verticalGap = Math.max(edge.trigger.top - edge.rect.bottom, edge.rect.top - edge.trigger.bottom, 0);
      assert.ok(Math.hypot(horizontalGap, verticalGap) <= 12, `${edge.name}: tooltip drifted away from its trigger`);
    }
    assert.equal(result.overlapsBlocker, false, "tooltip covered the adjacent row instead of flipping or shifting");
    assert.notEqual(result.collisionPlacement, "below", "tooltip stayed below despite the adjacent-row collision");
    assert.equal(result.liveText, "12 sub-agents", "visible tooltip did not update from the live trigger count");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
