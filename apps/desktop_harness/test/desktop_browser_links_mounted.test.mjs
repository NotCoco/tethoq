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

test("saved browser opt-in, external URL boundary, last-tab close and Ctrl W work through mounted IPC", { timeout: 75_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-browser-links-"));
  try {
    await Promise.all([
      build({ entryPoints: [join(appRoot, "test/fixtures/desktop_browser_links.tsx")], outfile: join(directory, "renderer.js"), bundle: true, format: "esm", platform: "browser", target: "chrome140", jsx: "automatic", loader: { ".png": "dataurl" }, plugins: [{ name: "worker-stub", setup(context) {
        context.onResolve({ filter: /\?worker&inline$/ }, ({ path }) => ({ path, namespace: "worker-stub" }));
        context.onLoad({ filter: /.*/, namespace: "worker-stub" }, () => ({ contents: "export default class { addEventListener() {} postMessage() {} terminate() {} }", loader: "js" }));
      } }] }),
      build({ entryPoints: [join(appRoot, "test/fixtures/desktop_browser_links_main.ts")], outfile: join(directory, "main.cjs"), bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"] }),
    ]);
    await writeFile(join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><script type="module" src="renderer.js"></script></body></html>');
    await writeFile(join(directory, "preload.cjs"), `
      const { contextBridge, ipcRenderer } = require('electron');
      const api = {};
      for (const [method, channel] of Object.entries({browserState:'browser-get-state',browserAction:'browser-action',preferencesState:'preferences-get',preferencesAction:'preferences-action',openExternalUrl:'open-external-url'})) api[method] = value => ipcRenderer.invoke('tethoq:'+channel,value);
      for (const [method, channel] of Object.entries({onBrowserState:'browser-state',onBrowserNotice:'browser-notice',onPreferencesState:'preferences-state'})) api[method] = listener => { const handler = (_event,value)=>listener(value); ipcRenderer.on('tethoq:'+channel,handler); return ()=>ipcRenderer.removeListener('tethoq:'+channel,handler); };
      api.inspect = () => ipcRenderer.invoke('qa:inspect'); api.capture = name => ipcRenderer.invoke('qa:capture',name); api.closeWithKeyboard = () => ipcRenderer.invoke('qa:keyboard');
      contextBridge.exposeInMainWorld('qaBrowser',api);
    `);
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(electronPath, [join(directory, "main.cjs")], { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => {
        clearTimeout(timer);
        const line = output.split(/\r?\n/u).find(value => value.startsWith("BROWSER_LINKS_QA="));
        if (code !== 0 || !line) reject(new Error(`Browser QA exited ${code}: ${errors}\n${output}`));
        else resolveResult(JSON.parse(line.slice("BROWSER_LINKS_QA=".length)));
      });
    });
    assert.equal(result.ok, true, result.error);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
