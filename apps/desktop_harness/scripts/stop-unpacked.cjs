/**
 * Stops a running Tethoq app as gracefully as possible.
 *
 * A plain taskkill never reaches before-quit, so the preferred path asks the
 * running workspace instance to hand off cleanly. That route preserves an
 * active managed OpenCode server for the replacement Tethoq generation. The
 * forced fallback targets only the exact Tethoq executable processes and never
 * `/T`-kills their provider descendants. The query is path-locked: a similarly
 * named installed app is never a target.
 */
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const exe = path.resolve(path.join(__dirname, "..", "release", "win-unpacked", "Tethoq.exe"));

function processRows() {
  if (process.platform !== "win32") return [];
  const target = exe.replaceAll("'", "''");
  const script = [
    `$target = '${target}'`,
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'Tethoq.exe' -and $_.ExecutablePath -ieq $target } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout?.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((row) => Number.isInteger(Number(row?.ProcessId)));
  } catch {
    // An unprovable process query must never degrade into a broad name match.
    return [];
  }
}

function roots(rows) {
  const ids = new Set(rows.map((row) => Number(row.ProcessId)));
  return rows.filter((row) => !ids.has(Number(row.ParentProcessId)));
}

function hasDebugPort(row, debugPort) {
  return new RegExp(`(?:^|\\s)--remote-debugging-port=${Number(debugPort)}(?:\\s|$)`, "u").test(row.CommandLine ?? "");
}

function running() {
  return processRows().map((row) => Number(row.ProcessId));
}

function waitForExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (running().length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return running().length === 0;
}

function forceKill(rows) {
  for (const row of [...rows].reverse()) {
    spawnSync("taskkill.exe", ["/PID", String(row.ProcessId), "/F"], { windowsHide: true });
  }
  return waitForExit(8_000);
}

function stopTethoq(options = {}) {
  const rows = processRows();
  const runningRoots = roots(rows);
  if (runningRoots.length === 0) return true;
  // A QA run supplies its debug port. Refuse to touch a visible/user-launched
  // workspace instance or an ambiguous process tree; only the exact QA root
  // carrying that port may be closed.
  if (options.debugPort !== undefined && (runningRoots.length !== 1 || !hasDebugPort(runningRoots[0], options.debugPort))) return false;
  // A secondary instance never shows a window; the running instance hears the
  // argument through the single-instance lock and quits cleanly.
  spawn(exe, ["--quit-other"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  if (waitForExit(12_000)) return true;
  // Re-query before the fallback. The quit helper can inherit the
  // single-instance lock while the original process is shutting down, so the
  // original snapshot may no longer include the exact Tethoq process that now
  // owns the app. Killing only the stale snapshot leaves that helper running.
  return forceKill(processRows());
}

if (require.main === module) {
  const stopped = stopTethoq();
  process.stdout.write(stopped ? "Tethoq stopped.\n" : "Tethoq did not stop cleanly.\n");
  process.exit(stopped ? 0 : 1);
}

module.exports = { stopTethoq, running };
