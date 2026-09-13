/**
 * Pushes a fresh `electron-vite build` into the unpacked app the Start Menu
 * shortcut actually launches.
 *
 * The normal build calls this after producing out/. Prepare and verify the new
 * archive before stopping the app, then replace it and restore a running app.
 * No installer or Electron runtime rebuild is needed.
 */
const { spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { stopTethoq, running } = require("./stop-unpacked.cjs");

const harness = path.join(__dirname, "..");
const outDirectory = path.join(harness, "out");
const resources = path.join(harness, "release", "win-unpacked", "resources");
const asarPath = path.join(resources, "app.asar");
const providerAssets = path.join(harness, "..", "agent_bridge", "assets");
const skipBuild = process.argv.includes("--no-build");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(asarPath)) {
  if (process.argv.includes("--if-present")) {
    process.stdout.write("Desktop build ready; no local unpacked app to refresh.\n");
    process.exit(0);
  }
  fail(`No packaged app at ${asarPath}. Run "npm run pack:win" once to create it.`);
}

if (!skipBuild) {
  const build = spawnSync("npm", ["run", "build:bundle"], { cwd: harness, stdio: "inherit", shell: true, windowsHide: true });
  if (build.status !== 0) fail("The renderer/main build failed; the packaged app was left untouched.");
}

for (const entry of ["main/index.js", "preload/index.cjs", "renderer/index.html"]) {
  if (!existsSync(path.join(outDirectory, entry))) fail(`Incomplete desktop build: missing ${entry}. The running app was left untouched.`);
}

const providerFiles = [
  ["opencode", "uar_mesh.txt", "uar_mesh.txt"],
  ["opencode", "tethoq_images.txt", "tethoq_images.txt"],
  ["pi", "tethoq_tools.txt", "tethoq_tools.txt"],
];

const asar = require(path.join(harness, "node_modules", "@electron", "asar"));
// Stage on the destination volume so the archive swap is a rename, even when
// the checkout and Windows TEMP live on different drives.
const staging = mkdtempSync(path.join(resources, ".tethoq-sync-"));
const extracted = path.join(staging, "app");
const rebuilt = path.join(staging, "app.asar");
const wasRunning = running().length > 0;
const launchAfterSync = process.argv.includes("--launch") || (wasRunning && process.argv.includes("--relaunch-if-running"));
let stopped = false;

function removeStaged(target) {
  const relative = path.relative(staging, path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Refusing to remove a path outside the sync staging directory");
  rmSync(target, { recursive: true, force: true });
}

function verifyArchive(archive) {
  asar.uncache(archive);
  const verifyFile = (relative) => {
    const expected = readFileSync(path.join(harness, relative));
    const actual = asar.extractFile(archive, relative);
    if (!createHash("sha256").update(expected).digest().equals(createHash("sha256").update(actual).digest())) {
      throw new Error(`Packaged output differs from the build: ${relative}`);
    }
  };
  const visit = (directory) => {
    for (const entry of readdirSync(path.join(harness, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(relative);
      else verifyFile(relative);
    }
  };
  visit("out");
  verifyFile("package.json");
}

function launch() {
  const result = spawnSync(process.execPath, [path.join(__dirname, "launch-unpacked.cjs"), "--synced"], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error("The refreshed Tethoq app did not open successfully");
}

async function main() {
  asar.extractAll(asarPath, extracted);
  removeStaged(path.join(extracted, "out"));
  cpSync(outDirectory, path.join(extracted, "out"), { recursive: true });
  cpSync(path.join(harness, "package.json"), path.join(extracted, "package.json"));
  // uiohook-napi ships unpacked beside the archive; it must not be duplicated in.
  await asar.createPackageWithOptions(extracted, rebuilt, { unpackDir: "node_modules/uiohook-napi" });
  verifyArchive(rebuilt);
  if (!stopTethoq()) throw new Error("Tethoq is still running; the existing archive was left untouched.");
  stopped = true;
  // The previous archive is kept, not deleted: a bad repack would otherwise leave
  // no way back except the full pack:win chain.
  rmSync(`${asarPath}.previous`, { force: true });
  renameSync(asarPath, `${asarPath}.previous`);
  try {
    renameSync(rebuilt, asarPath);
    verifyArchive(asarPath);
  } catch (error) {
    rmSync(asarPath, { force: true });
    renameSync(`${asarPath}.previous`, asarPath);
    throw error;
  }
  for (const [provider, sourceName, targetName] of providerFiles) {
    const targetDirectory = path.join(resources, "provider-tools", provider);
    mkdirSync(targetDirectory, { recursive: true });
    cpSync(path.join(providerAssets, provider, sourceName), path.join(targetDirectory, targetName));
  }
  removeStaged(staging);
  const size = statSync(asarPath).size;
  process.stdout.write(`Packaged app refreshed: ${asarPath} (${(size / 1024 / 1024).toFixed(1)} MB)\n`);
  if (launchAfterSync) launch();
}

main().catch((error) => {
  removeStaged(staging);
  if (stopped && wasRunning) {
    try { launch(); } catch { /* Preserve the original failure below. */ }
  }
  fail(`Refreshing the packaged app failed: ${error instanceof Error ? error.message : String(error)}`);
});
