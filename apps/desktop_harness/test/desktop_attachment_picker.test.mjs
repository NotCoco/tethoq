import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("native attachment pickers accept twelve and reject excess count/bytes before reading payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-attachment-picker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handlers = new Map();
  let selection = { canceled: false, filePaths: [] };
  let payloadReads = 0;
  globalThis.__attachmentPickerQa = {
    handlers,
    showOpenDialog: async () => selection,
    readPayload: () => { payloadReads += 1; },
  };
  t.after(() => { delete globalThis.__attachmentPickerQa; });
  const bundle = join(directory, "ipc.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/main/ipc.ts", import.meta.url))],
    outfile: bundle, bundle: true, platform: "node", format: "esm",
    plugins: [{
      name: "attachment-picker-boundaries",
      setup(context) {
        context.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "picker-qa" }));
        context.onResolve({ filter: /local_open\.js$/ }, () => ({ path: "local-open", namespace: "picker-qa" }));
        context.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: "fs", namespace: "picker-qa" }));
        context.onLoad({ filter: /.*/, namespace: "picker-qa" }, ({ path }) => ({
          loader: "js",
          contents: path === "electron" ? `
            const qa = globalThis.__attachmentPickerQa;
            export const ipcMain = { handle: (key, handler) => qa.handlers.set(key, handler), removeHandler: key => qa.handlers.delete(key) };
            export const dialog = { showOpenDialog: qa.showOpenDialog };
            export const app = {}, clipboard = {}, desktopCapturer = {}, screen = {}, shell = {};
            export class BrowserWindow {}
          ` : path === "fs" ? `
            import { promises as fs } from 'node:fs';
            export const lstat = fs.lstat;
            export const readFile = (...args) => { globalThis.__attachmentPickerQa.readPayload(); return fs.readFile(...args); };
          ` : `
            export const detectLocalOpenHandlers = async () => [];
            export const publicLocalOpenHandlers = value => value;
            export const existingLocalTarget = () => {}, openExistingLocalTarget = () => {};
          `,
        }));
      },
    }],
  });
  const { registerDesktopIpc } = await import(pathToFileURL(bundle).href);
  const webContents = { mainFrame: { url: "file:///attachment-picker-qa.html" } };
  const unregister = registerDesktopIpc({ window: { webContents }, runtime: {} });
  t.after(unregister);
  const invoke = (kind) => handlers.get(`tethoq:select-${kind}`)(
    { sender: webContents, senderFrame: webContents.mainFrame }, { providerId: "opencode" },
  );
  const paths = await Promise.all(Array.from({ length: 13 }, async (_, index) => {
    const path = join(directory, `image ${index}.png`);
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=", "base64"));
    return path;
  }));
  for (const kind of ["images", "files"]) {
    selection = { canceled: false, filePaths: paths.slice(0, 12) };
    payloadReads = 0;
    const selected = await invoke(kind);
    assert.deepEqual(selected.map(item => item.path), selection.filePaths);
    assert.equal(payloadReads, 12);
    assert.ok(selected.every(item => item.mimeType === "image/png" && item.dataBase64.length > 0));
    assert.ok(selected.every(item => kind === "images" ? item.kind === undefined : item.kind === "file"));

    selection = { canceled: false, filePaths: paths };
    payloadReads = 0;
    await assert.rejects(invoke(kind), /Choose up to 12 files/);
    assert.equal(payloadReads, 0, "Excess selection must fail before allocating file buffers");

    selection = { canceled: true, filePaths: paths };
    assert.deepEqual(await invoke(kind), []);
    assert.equal(payloadReads, 0);
  }

  const sparseImage = async (name, bytes) => {
    const path = join(directory, name);
    const handle = await open(path, "w");
    try { await handle.truncate(bytes); } finally { await handle.close(); }
    return path;
  };
  const oversized = await sparseImage("oversized.png", 25 * 1024 * 1024 + 1);
  const aggregate = await Promise.all([0, 1, 2].map(index => sparseImage(`large-${index}.png`, 17 * 1024 * 1024)));
  for (const kind of ["images", "files"]) {
    payloadReads = 0;
    selection = { canceled: false, filePaths: [paths[0], oversized] };
    await assert.rejects(invoke(kind), /25 MiB/);
    assert.equal(payloadReads, 0);
    selection = { canceled: false, filePaths: aggregate };
    await assert.rejects(invoke(kind), /50 MiB/);
    assert.equal(payloadReads, 0, "Aggregate guard must run before reading even the first file");
  }
});
