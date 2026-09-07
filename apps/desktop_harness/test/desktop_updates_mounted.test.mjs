import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");

test("installed update controls handle progress, restart deferral, retry, and newer events", { timeout: 45_000 }, async () => {
  const directory = join(tmpdir(), `tethoq-updates-ui-${process.pid}-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  try {
    await build({ entryPoints: [join(appRoot, "test/fixtures/desktop_updates.tsx")], outfile: join(directory, "renderer.js"), bundle: true, format: "esm", platform: "browser", target: "chrome140", jsx: "automatic", loader: { ".png": "dataurl" } });
    await writeFile(join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><script type="module" src="renderer.js"></script></body></html>');
    await writeFile(join(directory, "main.cjs"), `
      const { app, BrowserWindow } = require('electron');
      const path = require('node:path'), fs = require('node:fs/promises');
      app.commandLine.appendSwitch('disable-gpu');
      app.setPath('userData', path.join(__dirname, 'profile'));
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false, width: 1050, height: 640, webPreferences: { backgroundThrottling: false, offscreen: true } });
        window.webContents.on('console-message', (event) => { if (event.level >= 2) process.stderr.write(event.message + '\\n'); });
        await window.loadFile(path.join(__dirname, 'index.html'));
        const wait = expression => window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const end=Date.now()+20000;const poll=()=>{const value='+expression+';if(value)return resolve(value);if(Date.now()>end)return reject(new Error("Update UI timed out"));setTimeout(poll,10);};poll();})');
        await wait('window.__updateReady || window.__updateResult');
        if (process.env.TETHOQ_UPDATE_QA_ARTIFACTS) {
          await fs.mkdir(process.env.TETHOQ_UPDATE_QA_ARTIFACTS, { recursive: true });
          await new Promise(resolve => setTimeout(resolve, 200));
          await fs.writeFile(path.join(process.env.TETHOQ_UPDATE_QA_ARTIFACTS, 'desktop-update-ready.png'), (await window.webContents.capturePage()).toPNG());
        }
        await window.webContents.executeJavaScript('window.__updateContinue=true');
        process.stdout.write('UPDATE_QA='+JSON.stringify(await wait('window.__updateResult'))+'\\n');
        window.destroy(); app.quit();
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(electronPath, [join(directory, "main.cjs")], { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Update UI timed out: ${errors}`)); }, 35_000);
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { errors += chunk; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => {
        clearTimeout(timer);
        const line = output.split(/\r?\n/u).find(value => value.startsWith("UPDATE_QA="));
        if (code !== 0 || !line) reject(new Error(`Update UI exited ${code}: ${errors}\n${output}`));
        else resolveResult(JSON.parse(line.slice("UPDATE_QA=".length)));
      });
    });
    assert.equal(result.ok, true, result.error);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
