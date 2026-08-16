import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => await readFile(new URL(path, import.meta.url), "utf8");

test("renderer faults stay visible behind one recoverable React boundary", async () => {
  const [entry, boundary, styles] = await Promise.all([
    source("../src/renderer/src/main.tsx"),
    source("../src/renderer/src/RendererErrorBoundary.tsx"),
    source("../src/renderer/src/styles.css"),
  ]);

  assert.match(entry, /installGlobalRendererFaultHandlers\(\);[\s\S]*?createRoot\(root\)\.render/);
  assert.match(entry, /root === null[\s\S]*?reportRendererStartupFault[\s\S]*?document\.body\.append\(root\)/);
  assert.match(entry, /<RendererErrorBoundary>[\s\S]*?<App\s*\/>[\s\S]*?<\/RendererErrorBoundary>/);
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch[\s\S]*?console\.error/);
  assert.match(boundary, /window\.addEventListener\("error"/);
  assert.match(boundary, /window\.addEventListener\("unhandledrejection"/);
  assert.doesNotMatch(boundary, /preventDefault\(\)/);
  assert.match(boundary, /Try again/);
  assert.match(boundary, /Reload window/);
  assert.match(boundary, /window\.location\.reload\(\)/);
  assert.match(styles, /\.renderer-fault\s*\{/);
});

test("a dead renderer offers a guarded user-triggered reload without a restart loop", async () => {
  const main = await source("../src/main/index.ts");

  assert.match(main, /render-process-gone[\s\S]*?details\.reason[\s\S]*?details\.exitCode/);
  assert.match(main, /details\.reason === "clean-exit"/);
  assert.match(main, /rendererRecoveryRequired = true;[\s\S]*?promptForRendererRecovery\(window\)/);
  assert.match(main, /rendererCrashPromptOpen[\s\S]*?dialog\.showMessageBox/);
  assert.match(main, /buttons:\s*\["Reload window", "Close window"\]/);
  assert.match(main, /result\.response === 0[\s\S]*?recoverMainWindowRenderer\(window\)/);
  assert.match(main, /rendererRecoveryInFlight !== undefined[\s\S]*?return rendererRecoveryInFlight/);
  assert.match(main, /await loadRenderer\(window\);[\s\S]*?rendererRecoveryRequired = false/);
  assert.doesNotMatch(main, /setInterval|setTimeout\([^)]*loadRenderer/);
  assert.match(main, /dialog\.showErrorBox\("Tethoq could not start"/);
});
