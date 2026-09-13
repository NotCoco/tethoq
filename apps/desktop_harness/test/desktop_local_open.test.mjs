import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(tmpdir(), `tethoq-local-open-${process.pid}-${Date.now()}`);
const bundle = join(outputDirectory, "local-open.mjs");
await mkdir(outputDirectory, { recursive: true });
await build({ entryPoints: [join(appRoot, "src", "main", "local_open.ts")], outfile: bundle, bundle: true, format: "esm", platform: "node", target: "node22" });
const localOpen = await import(`file:///${bundle.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

test("installed local-open integrations are resolved from fixed candidates only", async () => {
  const available = new Set([
    "C:\\Users\\example\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    "C:\\Tools\\Cursor.exe",
  ]);
  const handlers = await localOpen.detectLocalOpenHandlers({
    platform: "win32",
    environment: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local", ProgramFiles: "C:\\Program Files", PATH: "C:\\Tools;relative-entry" },
    isExecutable: async (candidate) => available.has(candidate),
  });
  assert.deepEqual(handlers.map(({ id, label }) => ({ id, label })), [
    { id: "system", label: "File Explorer" },
    { id: "vscode", label: "Visual Studio Code" },
    { id: "cursor", label: "Cursor" },
  ]);
  assert.equal(handlers.some((handler) => handler.id === "windsurf"), false);
});

test("local targets must exist and cannot use network or device namespaces", async (t) => {
  const directory = join(tmpdir(), `tethoq-open-target-${process.pid}-${Date.now()}`);
  const file = join(directory, "notes.txt");
  await mkdir(directory, { recursive: true });
  await writeFile(file, "safe");
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(localOpen.isSafeLocalAbsolutePath(directory), true);
  assert.equal(localOpen.isSafeLocalAbsolutePath("relative\\notes.txt"), false);
  if (process.platform === "win32") {
    assert.equal(localOpen.isSafeLocalAbsolutePath("\\\\server\\share\\notes.txt"), false);
    assert.equal(localOpen.isSafeLocalAbsolutePath("\\\\?\\C:\\notes.txt"), false);
  }
  const target = await localOpen.existingLocalTarget(file, 44, 3);
  assert.equal(target.kind, "file");
  assert.equal(target.line, 44);
  assert.equal(target.column, 3);
  await assert.rejects(localOpen.existingLocalTarget(join(directory, "missing.txt")), /no longer exists/);
});

test("system open reveals files and editors launch fixed executables without a shell", async () => {
  const calls = [];
  const shell = {
    openPath: async (path) => { calls.push(["directory", path]); return ""; },
    showItemInFolder: (path) => { calls.push(["file", path]); },
  };
  await localOpen.openExistingLocalTarget({ path: "C:\\work", kind: "directory" }, { id: "system", label: "File Explorer", icon: "explorer" }, { shell });
  await localOpen.openExistingLocalTarget({ path: "C:\\work\\app.ts", kind: "file" }, { id: "system", label: "File Explorer", icon: "explorer" }, { shell });
  let spawned;
  const spawnProcess = (executable, args, options) => {
    spawned = { executable, args, options };
    const child = new EventEmitter();
    child.unref = () => undefined;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  await localOpen.openExistingLocalTarget(
    { path: "C:\\work\\app.ts", kind: "file", line: 12, column: 4 },
    { id: "vscode", label: "Visual Studio Code", icon: "vscode", executable: "C:\\Apps\\Code.exe" },
    { shell, spawnProcess },
  );
  assert.deepEqual(calls, [["directory", "C:\\work"], ["file", "C:\\work\\app.ts"]]);
  assert.equal(spawned.executable, "C:\\Apps\\Code.exe");
  assert.deepEqual(spawned.args, ["--goto", "C:\\work\\app.ts:12:4"]);
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.detached, true);
});
