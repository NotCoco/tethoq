import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import assets from "../scripts/update-release-assets.cjs";

const directory = await mkdtemp(join(tmpdir(), "tethoq-update-tests-"));
after(() => rm(directory, { recursive: true, force: true }));
const output = join(directory, "updates.mjs");
await build({ entryPoints: [fileURLToPath(new URL("../src/main/updates.ts", import.meta.url))], outfile: output, bundle: true, format: "esm", platform: "node", target: "node22" });
const { DesktopUpdateManager } = await import(pathToFileURL(output).href);

class Updater extends EventEmitter {
  checks = 0; downloads = 0; installs = [];
  check = async () => { this.emit("update-available", { version: "0.1.2" }); return {}; };
  download = async () => { this.emit("download-progress", { percent: 45.2 }); this.emit("update-downloaded", { version: "0.1.2" }); };
  async checkForUpdates() { this.checks++; return this.check(); }
  async downloadUpdate() { this.downloads++; return this.download(); }
  quitAndInstall(...args) { this.installs.push(args); }
}

function setup(t, options = {}) {
  const updater = new Updater(), states = [];
  const manager = new DesktopUpdateManager({ currentVersion: "0.1.1", updater, onState: state => states.push(state), beforeInstall: async () => {}, ...options });
  t.after(() => manager.dispose());
  return { updater, manager, states };
}

test("updates require explicit download and install, and cannot downgrade", async t => {
  const { updater, manager, states } = setup(t);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, true);
  await manager.action("install");
  await manager.action("download");
  assert.equal(updater.downloads, 0);
  await manager.action("check");
  assert.equal(manager.state().phase, "available");
  assert.equal(updater.downloads, 0);
  await manager.action("download");
  assert.ok(states.some(state => state.phase === "downloading" && state.percent === 45));
  assert.equal(manager.state().phase, "downloaded");
  assert.deepEqual(updater.installs, []);
  await manager.action("check");
  assert.equal(updater.checks, 1, "a later background check must preserve a ready update");
  await manager.action("install");
  await manager.action("install");
  assert.deepEqual(updater.installs, [[true, true]], "install silently and relaunch only on the user's action");
});

test("an active task can defer restart without losing the downloaded update", async t => {
  let active = true;
  const { updater, manager } = setup(t, { beforeInstall: async () => { if (active) throw Error("Finish running tasks first."); } });
  await manager.action("check"); await manager.action("download");
  await manager.action("install");
  assert.equal(manager.state().phase, "downloaded");
  assert.equal(manager.state().message, "Finish running tasks first.");
  assert.equal(updater.installs.length, 0);
  active = false;
  await manager.action("install");
  assert.equal(updater.installs.length, 1);
});

test("concurrent checks coalesce and download failures allow a fresh retry", async t => {
  const { updater, manager } = setup(t);
  let finish;
  updater.check = () => new Promise(resolve => { finish = () => { updater.emit("update-available", { version: "0.1.2" }); resolve({}); }; });
  const check = manager.action("check");
  await manager.action("check");
  assert.equal(updater.checks, 1);
  finish(); await check;
  updater.download = async () => { throw Error("Checksum verification failed"); };
  await manager.action("download");
  assert.equal(manager.state().phase, "error");
  await manager.action("install");
  assert.equal(updater.installs.length, 0);
  updater.check = async () => { updater.emit("update-available", { version: "0.1.2" }); return {}; };
  updater.download = async () => updater.emit("update-downloaded", { version: "0.1.2" });
  await manager.action("check"); await manager.action("download");
  assert.equal(manager.state().phase, "downloaded");
});

test("background checks are delayed, periodic, and disposed with the application", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { updater, manager } = setup(t);
  manager.start(); manager.start();
  t.mock.timers.tick(29999);
  assert.equal(updater.checks, 0);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.checks, 1);
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updater.checks, 2);
  manager.dispose();
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(updater.checks, 2);
  assert.equal(updater.listenerCount("update-available"), 0);
});

test("stable installs exclude previews and builds without a feed cannot update", async t => {
  const stable = setup(t, { currentVersion: "1.0.0" });
  assert.equal(stable.updater.allowPrerelease, false);
  const unavailable = setup(t, { updater: undefined });
  await unavailable.manager.action("check");
  await unavailable.manager.action("install");
  assert.equal(unavailable.manager.state().phase, "unavailable");
  assert.equal(unavailable.updater.checks, 0);
});

test("release metadata rejects mixed versions, foreign paths, and changed installer bytes", async () => {
  const version = "0.1.2", name = `Tethoq-Desktop-${version}-x64.exe`, bytes = Buffer.from("installer fixture");
  const entry = { url: name, size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") };
  const metadata = { version, files: [entry] };
  await writeFile(join(directory, name), bytes);
  await writeFile(join(directory, `${name}.blockmap`), "fixture blockmap");
  const save = value => writeFile(join(directory, "latest.yml"), JSON.stringify(value));
  await save(metadata);
  assert.equal((await assets.updateReleaseAssets(directory, version)).files.length, 3);
  await assert.rejects(assets.updateReleaseAssets(directory, "0.1.3"), /exactly this Desktop version/);
  await save({ ...metadata, files: [{ ...entry, url: `../${name}` }] });
  await assert.rejects(assets.updateReleaseAssets(directory, version), /different installer/);
  await save(metadata);
  await writeFile(join(directory, name), "changed installer");
  await assert.rejects(assets.updateReleaseAssets(directory, version), /checksum/);
});
