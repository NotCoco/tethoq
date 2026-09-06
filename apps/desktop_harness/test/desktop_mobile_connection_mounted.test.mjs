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
      reject(new Error(`Mounted phone-connection QA timed out.\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Mounted phone-connection QA exited ${code}.\n${stderr}\n${stdout}`));
        return;
      }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_MOBILE_CONNECTION_QA="));
      if (!marker) {
        reject(new Error(`Mounted phone-connection QA returned no result.\n${stderr}\n${stdout}`));
        return;
      }
      resolve(JSON.parse(marker.slice("TETHOQ_MOBILE_CONNECTION_QA=".length)));
    });
  });
}

test("mounted phone dialog distinguishes a saved phone from live presence", { timeout: 40_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-mobile-connection-mounted-${process.pid}-${Date.now()}`);
  const rendererBundle = join(outputDirectory, "renderer.js");
  const htmlPath = join(outputDirectory, "index.html");
  const mainPath = join(outputDirectory, "main.cjs");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot,
        sourcefile: "mobile-connection-mounted-qa.tsx",
        loader: "tsx",
        contents: String.raw`
          import React from "react";
          import { createRoot } from "react-dom/client";
          import "./src/renderer/src/styles.css";

          globalThis.IS_REACT_ACT_ENVIRONMENT = false;
          window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);

          const savedPhone = {
            id: "opaque-phone-handle",
            pairedAt: "2026-09-02T09:00:00.000Z",
            connected: false,
          };
          let connectionListener = () => undefined;
          window.tethoqDesktop = {
            mobileConnectionState: async () => ({ state: "paired", devices: [savedPhone] }),
            onMobileConnectionState: (listener) => {
              connectionListener = listener;
              return () => { connectionListener = () => undefined; };
            },
            mobileConnectionAction: async () => ({ state: "paired", devices: [savedPhone] }),
          };

          const { MobileConnectionDialog } = await import("./src/renderer/src/MobileConnectionDialog.tsx");
          const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
          const settle = async (count = 4) => {
            for (let index = 0; index < count; index += 1) {
              await wait();
              await new Promise((resolve) => requestAnimationFrame(resolve));
            }
          };
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const element = (selector, label = selector) => {
            const value = document.querySelector(selector);
            check(value, label + " is missing");
            return value;
          };
          const painted = (value) => {
            const style = getComputedStyle(value);
            const rect = value.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
          };
          const buttonWithText = (text) => {
            const value = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
            check(value, "Button is missing: " + text);
            return value;
          };
          const statusSnapshot = () => {
            const dialog = element('[role="dialog"]', "Phone connection dialog");
            const title = element('[role="dialog"] > h2', "Phone connection title");
            const sectionTitle = element("#paired-phones-title", "Saved phones heading");
            const row = element(".paired-phone-row", "Saved phone row");
            const phoneName = element(".paired-phone-row strong", "Saved phone name");
            const status = element(".paired-phone-status", "Phone presence status");
            const remove = buttonWithText("Remove");
            const action = element(".mobile-connection-actions button:last-child", "Pairing action");
            const style = getComputedStyle(status);
            const dotStyle = getComputedStyle(status, "::before");
            return {
              title: title.textContent?.trim(),
              sectionTitle: sectionTitle.textContent?.trim(),
              phoneName: phoneName.textContent?.trim(),
              statusText: status.textContent?.trim(),
              statusClass: status.className,
              statusColor: style.color,
              dotColor: dotStyle.backgroundColor,
              statusPainted: painted(status),
              removeText: remove.textContent?.trim(),
              removePainted: painted(remove),
              removeDisabled: remove.disabled,
              actionText: action.textContent?.trim(),
              paintedLabels: {
                title: painted(title),
                sectionTitle: painted(sectionTitle),
                row: painted(row),
                phoneName: painted(phoneName),
                status: painted(status),
                remove: painted(remove),
                action: painted(action),
              },
            };
          };

          const host = document.createElement("div");
          document.body.append(host);
          const root = createRoot(host);
          root.render(<MobileConnectionDialog onClose={() => undefined} />);

          (async () => {
            try {
              await settle();
              const initialRemove = buttonWithText("Remove");
              const disconnected = statusSnapshot();
              connectionListener({ state: "paired", devices: [{ ...savedPhone, connected: true }] });
              await settle();
              const connected = statusSnapshot();
              const removePreserved = buttonWithText("Remove") === initialRemove;
              root.unmount();
              window.__mobileConnectionQa = { disconnected, connected, removePreserved };
            } catch (error) {
              window.__mobileConnectionQa = { error: String(error?.stack ?? error) };
            }
          })();
        `,
      },
      outfile: rendererBundle,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome136",
      loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "css" },
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
        const window = new BrowserWindow({
          show: false,
          x: -10000,
          y: -10000,
          width: 760,
          height: 620,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
        });
        try {
          await window.loadFile(process.argv[2]);
          const result = await window.webContents.executeJavaScript('new Promise((resolve, reject) => { const started = performance.now(); const check = () => { if (window.__mobileConnectionQa) return resolve(window.__mobileConnectionQa); if (performance.now() - started > 15000) return reject(new Error("Renderer returned no mounted phone-connection result")); setTimeout(check, 10); }; check(); })', true);
          process.stdout.write("TETHOQ_MOBILE_CONNECTION_QA=" + JSON.stringify(result) + "\n");
        } catch (error) {
          process.stderr.write(String(error?.stack ?? error) + "\n");
          process.exitCode = 1;
        } finally {
          window.destroy();
          app.quit();
        }
      });
    `, "utf8");

    const result = await runElectron(mainPath, htmlPath);
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.disconnected, {
      title: "Connect your phone",
      sectionTitle: "Saved phones",
      phoneName: "Phone",
      statusText: "Not connected",
      statusClass: "paired-phone-status not-connected",
      statusColor: "rgb(150, 155, 150)",
      dotColor: "rgb(98, 103, 98)",
      statusPainted: true,
      removeText: "Remove",
      removePainted: true,
      removeDisabled: false,
      actionText: "Pair a phone",
      paintedLabels: { title: true, sectionTitle: true, row: true, phoneName: true, status: true, remove: true, action: true },
    });
    assert.deepEqual(result.connected, {
      title: "Connect your phone",
      sectionTitle: "Saved phones",
      phoneName: "Phone",
      statusText: "Connected",
      statusClass: "paired-phone-status connected",
      statusColor: "rgb(178, 199, 181)",
      dotColor: "rgb(123, 211, 154)",
      statusPainted: true,
      removeText: "Remove",
      removePainted: true,
      removeDisabled: false,
      actionText: "Pair another phone",
      paintedLabels: { title: true, sectionTitle: true, row: true, phoneName: true, status: true, remove: true, action: true },
    });
    assert.equal(result.removePreserved, true, "Live presence transition replaced or removed the saved-phone action");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
