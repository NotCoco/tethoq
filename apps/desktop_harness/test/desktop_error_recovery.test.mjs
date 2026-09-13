import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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

test("a faulted renderer never renders an empty node and names what failed", async () => {
  const boundary = await source("../src/renderer/src/RendererErrorBoundary.tsx");

  // With no fatal fault the children render; a missing child still never returns nothing.
  assert.match(boundary, /if \(fault === undefined\) return <>\s*\n\s*\{this\.props\.children \?\? null\}/);

  // A rejected promise or a stray window error leaves the app mounted and usable.
  // Replacing all of it with the recovery card for one is how a refused clipboard
  // write came to look like Tethoq dying, so only a view that genuinely cannot
  // display takes the window; the rest is reported beside the app and dismissed.
  assert.match(boundary, /const fatalFaultSources: ReadonlySet<RendererFaultSource> = new Set<RendererFaultSource>\(\["render", "startup"\]\)/);
  assert.match(boundary, /if \(fatalFaultSources\.has\(fault\.source\)\) this\.setState\(\{ fault \}\);\s*\n\s*else this\.setState\(\{ notice: fault \}\)/);
  assert.match(boundary, /<aside className="renderer-notice" role="status" aria-live="polite">/);
  assert.match(boundary, /onClick=\{this\.#dismissNotice\}>Dismiss<\/button>/);
  // Every fault source has a visible headline and the specific message, so the
  // recovery card cannot come out blank no matter how the failure arrives.
  assert.match(boundary, /const rendererFaultHeadlines: Record<RendererFaultSource, string> = \{/);
  assert.match(boundary, /render: "The view failed to display\."/);
  assert.match(boundary, /window: "The window hit an unexpected error\."/);
  assert.match(boundary, /promise: "A background action stopped unexpectedly\."/);
  assert.match(boundary, /startup: "Tethoq could not start this view\."/);
  assert.match(boundary, /<main className="renderer-fault" role="alert" aria-live="assertive">/);
  assert.match(boundary, /<p>\{rendererFaultHeadlines\[fault\.source\]\}<\/p>/);
  assert.match(boundary, /<small>\{fault\.message\}<\/small>/);
  // Render faults are attributed to the component that threw, and an empty
  // stack or message still falls back to the generic copy instead of nothing.
  assert.match(boundary, /const failingComponent = info\.componentStack\?\.trim\(\)\.split\(\/\\n\/u\)\[0\]\?\.trim\(\) \?\? "";/);
  assert.match(boundary, /errorMessage\(error, "This view stopped unexpectedly\."\)/);
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

test("copying reports failures without throwing and prefers Desktop over the web clipboard", async (t) => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../src/renderer/src/clipboard.ts", import.meta.url))],
    write: false, bundle: true, format: "esm", platform: "node",
  });
  const { copyText } = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64"));
  const descriptors = ["window", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => { for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  const calls = [];
  const desktop = { copyText: async (text) => { calls.push(text); return true; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { tethoqDesktop: desktop } });
  const navigator = { clipboard: { writeText: async () => { throw new Error("Desktop must not use the web clipboard"); } } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  assert.equal(await copyText("  A complete answer\n"), true);
  assert.deepEqual(calls, ["  A complete answer\n"]);
  assert.equal(await copyText("   "), false);
  assert.equal(calls.length, 1, "empty text must not reach a clipboard");
  desktop.copyText = async () => { throw new Error("Clipboard denied"); };
  assert.equal(await copyText("answer"), false);
  desktop.copyText = async () => false;
  assert.equal(await copyText("answer"), false);
  delete globalThis.window;
  navigator.clipboard.writeText = async (text) => { calls.push(text); };
  assert.equal(await copyText("browser preview"), true);
  assert.equal(calls.at(-1), "browser preview");
  navigator.clipboard.writeText = async () => { throw new Error("Permission denied"); };
  assert.equal(await copyText("answer"), false);
  delete navigator.clipboard;
  assert.equal(await copyText("answer"), false);
});
