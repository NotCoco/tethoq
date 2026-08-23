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

test("copying goes through the desktop clipboard and can never reject", async () => {
  const [clipboard, chat, rich, preload, ipc, security] = await Promise.all([
    source("../src/renderer/src/clipboard.ts"),
    source("../src/renderer/src/ChatTimeline.tsx"),
    source("../src/renderer/src/RichText.tsx"),
    source("../src/preload/index.ts"),
    source("../src/main/ipc.ts"),
    source("../src/main/security.ts"),
  ]);

  // The window runs from file:// and the permission policy grants nothing but
  // audio, so the web clipboard is refused outright: every copy control in the
  // app was failing, and the refusal arrived as an unhandled rejection that the
  // fault handler turned into a full-window error card.
  assert.match(security, /permission === "media"/);
  assert.doesNotMatch(security, /clipboard-sanitized-write|clipboard-read/);
  assert.doesNotMatch(chat, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(rich, /navigator\.clipboard/);

  // Electron's own clipboard needs no permission, and the call is bounded.
  assert.match(ipc, /handle\(IPC_CHANNELS\.copyText[\s\S]*?clipboard\.writeText\(trimmed\)/);
  assert.match(ipc, /const trimmed = text\.slice\(0, MAX_CLIPBOARD_CHARACTERS\)/);
  assert.match(preload, /copyText: \(text: string\)[\s\S]*?ipcRenderer\.invoke\(IPC_CHANNELS\.copyText, \{ text \}\)/);

  // A copy that cannot happen answers false; it never throws at a click handler.
  assert.match(clipboard, /export async function copyText\(text: string\): Promise<boolean>/);
  assert.match(clipboard, /try \{\s*\n\s*return await desktop\.copyText\(text\);\s*\n\s*\} catch \{\s*\n\s*return false;/);
  assert.doesNotMatch(clipboard, /throw /);
  // Reading the DOM at module scope would keep these controls out of headless tests.
  assert.match(clipboard, /globalThis\.window\?\.tethoqDesktop/);

  // The control says what happened: silently doing nothing is the same defect.
  assert.match(chat, /onClick=\{\(\) => \{ void copyToClipboard\(text\)\.then\(\(copied\) => setResult\(copied \? "copied" : "failed"\)\); \}\}/);
  assert.match(chat, /\{result === "copied" \? <CheckIcon \/> : <CopyIcon \/>\}/);
  assert.match(chat, /<CopyButton className="timeline-copy-button"/);
  assert.match(chat, /<CopyButton className="copy-message"/);
});
