import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = createRequire(import.meta.url)("electron");
test("images travel from the bridge tool to visible, expandable chat content and survive reopening", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-image-mounted-"));
  try {
    await Promise.all([
      build({ entryPoints: [join(appRoot, "test/fixtures/desktop_presented_image.tsx")], outfile: join(directory, "renderer.js"), bundle: true,
        format: "esm", platform: "browser", target: "chrome140", jsx: "automatic", loader: { ".png": "dataurl" }, plugins: [{ name: "worker-stub", setup(context) {
          context.onResolve({ filter: /\?worker&inline$/ }, ({ path }) => ({ path, namespace: "worker-stub" }));
          context.onLoad({ filter: /.*/, namespace: "worker-stub" }, () => ({ contents: "export default class { addEventListener() {} postMessage() {} terminate() {} }", loader: "js" }));
        } }] }),
      build({ entryPoints: [join(appRoot, "test/fixtures/desktop_presented_image_main.ts")], outfile: join(directory, "main.cjs"), bundle: true,
        platform: "node", format: "cjs", target: "node22", external: ["electron"],
        define: { "import.meta.url": "imageQaModuleUrl" }, banner: { js: "const imageQaModuleUrl = require('node:url').pathToFileURL(__filename).href;" } }),
    ]);
    await writeFile(join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><script type="module" src="renderer.js"></script></body></html>');
    await writeFile(join(directory, "preload.cjs"), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('qaImage',{request:(type,payload)=>ipcRenderer.invoke('qa:request',type,payload),present:()=>ipcRenderer.invoke('qa:present'),restart:()=>ipcRenderer.invoke('qa:restart'),capture:()=>ipcRenderer.invoke('qa:capture')});");
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(electronPath, [join(directory, "main.cjs"), join(appRoot, "assets/tethoq-icon.png")], { cwd: appRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      const timer = setTimeout(() => child.kill(), 40_000);
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => {
        clearTimeout(timer);
        const line = output.split(/\r?\n/u).find(value => value.startsWith("IMAGE_QA="));
        if (code !== 0 || !line) reject(new Error(`Image QA exited ${code}: ${errors}\n${output}`));
        else resolveResult(JSON.parse(line.slice("IMAGE_QA=".length)));
      });
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.restored, true);
    assert.ok(result.width > 10);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
