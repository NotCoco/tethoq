const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { stopTethoq } = require("./stop-unpacked.cjs");

const exe = path.join(__dirname, "..", "release", "win-unpacked", "Tethoq.exe");
const timeoutMs = 20_000;

function visibleWindow() {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    [
      "Add-Type -Namespace TethoqLaunch -Name Native -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);' -ErrorAction SilentlyContinue | Out-Null",
      "$found = $false",
      "Get-Process -Name Tethoq -ErrorAction SilentlyContinue | ForEach-Object {",
      "  if ($_.MainWindowHandle -ne [IntPtr]::Zero -and [TethoqLaunch.Native]::IsWindowVisible($_.MainWindowHandle)) { $found = $true }",
      "}",
      "if ($found) { 'yes' }",
    ].join("; "),
  ], { encoding: "utf8", windowsHide: true });
  return result.stdout.includes("yes");
}

if (!stopTethoq()) {
  console.error("Tethoq is still running after stop; not launching a second copy.");
  process.exit(1);
}

spawn("explorer.exe", [exe], { detached: true, stdio: "ignore" }).unref();

const visibleDeadline = Date.now() + timeoutMs;
while (Date.now() < visibleDeadline) {
  if (visibleWindow()) {
    process.stdout.write("Tethoq window is visible.\n");
    process.exit(0);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
}

console.error("Tethoq started but no visible window appeared.");
process.exit(1);
