import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");

test("live OpenCode text paints with its sidebar preview while history is pending, stale, or unavailable", { timeout: 35_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-live-stream-"));
  try {
    await build({ entryPoints: [join(appRoot, "test/fixtures/desktop_live_stream.tsx")], outfile: join(directory, "renderer.js"), bundle: true, format: "esm", platform: "browser", target: "chrome140", jsx: "automatic", loader: { ".png": "dataurl" }, logLevel: "silent", plugins: [{ name: "worker-stub", setup(context) {
      context.onResolve({ filter: /\?worker&inline$/ }, ({ path }) => ({ path, namespace: "worker-stub" }));
      context.onLoad({ filter: /.*/, namespace: "worker-stub" }, () => ({ contents: "export default class { addEventListener() {} postMessage() {} terminate() {} }", loader: "js" }));
    } }] });
    await writeFile(join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><script type="module" src="renderer.js"></script></body></html>');
    await writeFile(join(directory, "main.cjs"), `
      const { app, BrowserWindow } = require('electron');
      const path = require('node:path');
      app.commandLine.appendSwitch('disable-gpu');
      app.setPath('userData', path.join(__dirname, 'profile'));
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { backgroundThrottling: false, offscreen: true } });
        window.webContents.on('console-message', (event) => { if (event.level >= 2) process.stderr.write(event.message + '\\n'); });
        await window.loadFile(path.join(__dirname, 'index.html'));
        const result = await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const end=performance.now()+20000; const poll=()=>{if(window.__liveStreamResult)return resolve(window.__liveStreamResult);if(performance.now()>end)return reject(new Error("Live stream renderer timed out"));setTimeout(poll,10);};poll();})');
        process.stdout.write('STREAM_QA='+JSON.stringify(result)+'\\n');
        window.destroy(); app.quit();
      }).catch((error) => { console.error(error); app.exit(1); });
    `);
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(electronPath, [join(directory, "main.cjs")], { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      const timer = setTimeout(() => { child.kill(); }, 25_000);
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        const line = output.split(/\r?\n/u).find((value) => value.startsWith("STREAM_QA="));
        if (code !== 0 || !line) reject(new Error(`Stream check exited ${code}: ${errors}\n${output}`));
        else resolveResult(JSON.parse(line.slice("STREAM_QA=".length)));
      });
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    console.log(`${result.chunks} streamed chunks painted with the sidebar; slowest observed paint ${result.maxPaintMs.toFixed(1)} ms.`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
