/**
 * Stops a running Tethoq app as gracefully as possible.
 *
 * A plain taskkill never reaches before-quit, so the desktop cannot stop its
 * managed OpenCode server. The orphan keeps holding port 4096, the next launch
 * treats it as an external server, and live events for later sessions can end
 * up streaming from a different server than the one the app is subscribed to.
 * The preferred path asks the running instance to quit cleanly (`--quit-other`
 * routes through the ordinary quit flow, which stops the managed server), and
 * only falls back to a forced kill when the instance does not exit in time.
 */
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const exe = path.join(__dirname, "..", "release", "win-unpacked", "Tethoq.exe");

function running() {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-Process -Name Tethoq -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
  ], { encoding: "utf8", windowsHide: true });
  return (result.stdout ?? "").split(/\s+/u).map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value));
}

function waitForExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (running().length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return running().length === 0;
}

function forceKill() {
  for (const id of running()) {
    spawnSync("taskkill.exe", ["/PID", String(id), "/T", "/F"], { windowsHide: true });
  }
  return waitForExit(8_000);
}

function stopTethoq() {
  if (running().length === 0) return true;
  // A secondary instance never shows a window; the running instance hears the
  // argument through the single-instance lock and quits cleanly.
  spawn(exe, ["--quit-other"], { detached: true, stdio: "ignore" }).unref();
  if (waitForExit(12_000)) return true;
  return forceKill();
}

if (require.main === module) {
  const stopped = stopTethoq();
  process.stdout.write(stopped ? "Tethoq stopped.\n" : "Tethoq did not stop cleanly.\n");
  process.exit(stopped ? 0 : 1);
}

module.exports = { stopTethoq, running };
