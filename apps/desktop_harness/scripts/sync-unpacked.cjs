/**
 * Pushes a fresh `electron-vite build` into the unpacked app the Start Menu
 * shortcut actually launches.
 *
 * `npm run build` writes only `out/`. The running app reads
 * `release/win-unpacked/resources/app.asar`, which nothing except the full
 * `pack:win` chain regenerates — so editing source, building, and relaunching
 * showed no change at all. This unpacks that archive, swaps in the new `out/`,
 * and repacks it, which takes seconds instead of a full repackage.
 */
const { spawnSync } = require("node:child_process");
const { cpSync, existsSync, mkdtempSync, renameSync, rmSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { stopTethoq } = require("./stop-unpacked.cjs");

const harness = path.join(__dirname, "..");
const outDirectory = path.join(harness, "out");
const resources = path.join(harness, "release", "win-unpacked", "resources");
const asarPath = path.join(resources, "app.asar");
const skipBuild = process.argv.includes("--no-build");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(asarPath)) {
  fail(`No packaged app at ${asarPath}. Run "npm run pack:win" once to create it.`);
}

if (!skipBuild) {
  const build = spawnSync("npm", ["run", "build"], { cwd: harness, stdio: "inherit", shell: true });
  if (build.status !== 0) fail("The renderer/main build failed; the packaged app was left untouched.");
}

if (!existsSync(outDirectory)) fail(`No build output at ${outDirectory}.`);

// Windows keeps app.asar mapped while the app runs, so a repack would fail
// halfway and leave a torn archive.
if (!stopTethoq()) {
  fail("Tethoq is still running; close it and try again.");
}

const asar = require(path.join(harness, "node_modules", "@electron", "asar"));
const staging = mkdtempSync(path.join(tmpdir(), "tethoq-asar-"));
const extracted = path.join(staging, "app");
const rebuilt = path.join(staging, "app.asar");

async function main() {
  asar.extractAll(asarPath, extracted);
  rmSync(path.join(extracted, "out"), { recursive: true, force: true });
  cpSync(outDirectory, path.join(extracted, "out"), { recursive: true });
  cpSync(path.join(harness, "package.json"), path.join(extracted, "package.json"));
  // uiohook-napi ships unpacked beside the archive; it must not be duplicated in.
  await asar.createPackageWithOptions(extracted, rebuilt, { unpackDir: "node_modules/uiohook-napi" });
  // The previous archive is kept, not deleted: a bad repack would otherwise leave
  // no way back except the full pack:win chain.
  rmSync(`${asarPath}.previous`, { force: true });
  renameSync(asarPath, `${asarPath}.previous`);
  renameSync(rebuilt, asarPath);
  rmSync(staging, { recursive: true, force: true });
  const size = statSync(asarPath).size;
  process.stdout.write(`Packaged app refreshed: ${asarPath} (${(size / 1024 / 1024).toFixed(1)} MB)\n`);
}

main().catch((error) => {
  rmSync(staging, { recursive: true, force: true });
  fail(`Refreshing the packaged app failed: ${error instanceof Error ? error.message : String(error)}`);
});
