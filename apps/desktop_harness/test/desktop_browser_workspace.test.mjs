import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = async () => await readFile(new URL("../src/main/browser_workspace.ts", import.meta.url), "utf8");

function loadPureExports(code) {
  const transformed = ts.transpileModule(`${code}\n;globalThis.__browserPure = { normalizeNavigationInput, isAllowedWebUrl };`, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
  const sandbox = { URL, encodeURIComponent };
  const script = transformed
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\r?\n/gm, "")
    .replace(/^export\s+/gm, "");
  vm.runInNewContext(script, sandbox);
  return sandbox.__browserPure;
}

test("browser workspace always uses an app-owned persistent partition", async () => {
  const code = await source();

  assert.match(code, /BROWSER_PARTITION\s*=\s*"persist:tethoq-browser"/);
  assert.match(code, /session\.fromPartition\(BROWSER_PARTITION,\s*\{\s*cache:\s*true\s*\}\)/);
  assert.match(code, /partition:\s*BROWSER_PARTITION/);
  assert.match(code, /importsSystemProfile:\s*false/);
  assert.doesNotMatch(code, /defaultSession/);
  assert.doesNotMatch(code, /Chrome User Data|Chromium User Data|Google\\Chrome|User Data\\Default/i);
});

test("remote Chromium content has no Electron or Node privileges", async () => {
  const code = await source();

  assert.match(code, /new WebContentsView\(/);
  assert.match(code, /nodeIntegration:\s*false/);
  assert.match(code, /nodeIntegrationInSubFrames:\s*false/);
  assert.match(code, /nodeIntegrationInWorker:\s*false/);
  assert.match(code, /contextIsolation:\s*true/);
  assert.match(code, /sandbox:\s*true/);
  assert.match(code, /webSecurity:\s*true/);
  assert.match(code, /allowRunningInsecureContent:\s*false/);
  assert.match(code, /navigateOnDragDrop:\s*false/);
  assert.doesNotMatch(code, /preload\s*:/);
});

test("browser navigation accepts only web pages and converts search text safely", async () => {
  const pure = loadPureExports(await source());

  assert.equal(pure.normalizeNavigationInput("example.com/docs"), "https://example.com/docs");
  assert.equal(pure.normalizeNavigationInput("localhost:4173/test"), "https://localhost:4173/test");
  assert.equal(pure.normalizeNavigationInput("HTTP://Example.com/a"), "http://example.com/a");
  assert.equal(pure.normalizeNavigationInput("electron security model"), "https://www.google.com/search?q=electron%20security%20model");
  assert.throws(() => pure.normalizeNavigationInput("mailto:user@example.com"), /Only http and https/);
  assert.throws(() => pure.normalizeNavigationInput("file:///C:/secrets.txt"), /Only http and https/);
  assert.throws(() => pure.normalizeNavigationInput("javascript:alert(1)"), /Only http and https/);
  assert.equal(pure.isAllowedWebUrl("https://example.com"), true);
  assert.equal(pure.isAllowedWebUrl("http://localhost:3000"), true);
  assert.equal(pure.isAllowedWebUrl("file:///etc/passwd"), false);
  assert.equal(pure.isAllowedWebUrl("data:text/html,hello"), false);
});

test("permissions, popups, device access, certificates and downloads are explicit", async () => {
  const code = await source();

  assert.match(code, /setPermissionCheckHandler/);
  assert.match(code, /setPermissionRequestHandler/);
  assert.match(code, /resolvePermission\(/);
  assert.match(code, /setDisplayMediaRequestHandler\([^]*?callback\(\{\}\)/);
  assert.match(code, /setDevicePermissionHandler\(\(\)\s*=>\s*false\)/);
  assert.match(code, /BLOCKED_PERMISSION_TYPES[^]*?"display-capture"[^]*?"fileSystem"[^]*?"usb"/);
  assert.match(code, /ASKABLE_PERMISSION_TYPES[^]*?"geolocation"[^]*?"media"[^]*?"notifications"/);
  assert.match(code, /setWindowOpenHandler/);
  assert.match(code, /isAllowedPopupUrl/);
  assert.match(code, /certificate-error[^]*?callback\(false\)/);
  assert.match(code, /contents\.on\("login"[^]*?callback\(\)/);
  assert.match(code, /will-download/);
  assert.match(code, /pauseDownload/);
  assert.match(code, /resumeDownload/);
  assert.match(code, /cancelDownload/);
});

test("clearing browser data removes app-owned login and website state", async () => {
  const code = await source();
  const clearMethod = code.match(/public async clearProfileData\([\s\S]*?\n  }/)?.[0] ?? "";

  assert.match(clearMethod, /clearAuthCache\(\)/);
  assert.match(clearMethod, /clearStorageData\(\)/);
  assert.match(clearMethod, /clearCache\(\)/);
  assert.match(clearMethod, /clearHostResolverCache\(\)/);
  assert.match(clearMethod, /closeAllConnections\(\)/);
  assert.match(clearMethod, /navigationHistory\.clear\(\)/);
  assert.match(clearMethod, /#permissionDecisions\.clear\(\)/);
});

test("manager exposes bounded tab, view and lifecycle controls for narrow IPC", async () => {
  const code = await source();

  for (const method of [
    "initialize", "getState", "createTab", "activateTab", "closeTab", "navigate",
    "goBack", "goForward", "reload", "stop", "setBounds", "setVisible", "setHostVisible", "setVisibleForSession", "releaseSession", "focus",
    "openOverlay", "closeOverlay", "resolvePermission", "clearProfileData", "clearDownloadHistory", "dispose",
  ]) assert.match(code, new RegExp(`public (?:async )?${method}\\(`), `${method} should be public`);

  assert.match(code, /const MAX_TABS\s*=\s*24/);
  assert.match(code, /const MAX_DOWNLOAD_HISTORY\s*=\s*100/);
  assert.match(code, /const MAX_PERMISSION_HISTORY\s*=\s*100/);
  assert.match(code, /public get initialized\(\)/);
  assert.match(code, /#window\.contentView\.addChildView/);
  assert.match(code, /#window\.contentView\.removeChildView/);
  assert.match(code, /setVisible\(this\.#visible\s*&&\s*!this\.#overlayOpen\s*&&\s*tab\.id\s*===\s*visibleTabId\)/);
  assert.match(code, /setPermissionRequestHandler\(null\)/);
  assert.match(code, /setDisplayMediaRequestHandler\(null\)/);
  assert.match(code, /setDevicePermissionHandler\(null\)/);
  assert.match(code, /removeListener\("select-hid-device"/);
  assert.match(code, /removeListener\("select-serial-port"/);
  assert.match(code, /removeListener\("select-usb-device"/);
});

test("Chromium stays lazy until a session explicitly opens the browser", async () => {
  const code = await source();
  const initialize = code.match(/public async initialize\([\s\S]*?\n  }\n\n  public getState/)?.[0] ?? "";
  const sessionVisible = code.match(/public async setVisibleForSession\([\s\S]*?\n  }/)?.[0] ?? "";

  assert.doesNotMatch(initialize, /createTab\(/);
  assert.match(sessionVisible, /if \(!visible && !this\.#initialized\) return this\.setVisible\(false\)/);
  assert.match(sessionVisible, /visible && this\.#hostVisible && this\.#tabs\.size === 0[^]*?#restoreSession/);
});

test("inactive browser state is lightweight, bounded and download-safe", async () => {
  const code = await source();
  assert.match(code, /const MAX_SESSION_SNAPSHOTS\s*=\s*32/);
  assert.match(code, /new BrowserIdleLifecycle/);
  assert.match(code, /#snapshotActiveSession\(\)[\s\S]*?#closeAllTabs\(\)[\s\S]*?closeAllConnections/);
  assert.match(code, /#hasActiveDownloads\(\)/);
  assert.match(code, /record\.item\s*=\s*null/);
  assert.match(code, /removeListener\("updated"/);
  assert.match(code, /removeListener\("done"/);
  assert.match(code, /backgroundThrottling:\s*true/);
  assert.match(code, /#sessionSnapshots\.size > MAX_SESSION_SNAPSHOTS/);
  const suspend = code.match(/async #suspendInactiveBrowser\([\s\S]*?\n  }/)?.[0] ?? "";
  assert.doesNotMatch(suspend, /clearStorageData|clearAuthCache|clearCache/);
});

test("browser overlay capture is tab-local and clamps to the native view", async () => {
  const code = await source();
  const openOverlay = code.match(/public async openOverlay\([\s\S]*?\n  }\n\n  public closeOverlay/)?.[0] ?? "";

  assert.match(openOverlay, /const viewBounds = tab\.view\.getBounds\(\)/);
  assert.match(openOverlay, /const captureBounds = \{\s*x:\s*0,\s*y:\s*0,/);
  assert.match(openOverlay, /width:\s*Math\.min\(requested\.width,\s*viewBounds\.width\)/);
  assert.match(openOverlay, /height:\s*Math\.min\(requested\.height,\s*viewBounds\.height\)/);
  assert.match(openOverlay, /capturePage\(captureBounds,\s*\{\s*stayHidden:\s*true\s*\}\)/);
  assert.doesNotMatch(openOverlay, /capturePage\(normalizeBounds\(bounds\)\)/);
});

test("browser overlay transitions cancel late capture and keep native focus guarded", async () => {
  const code = await source();
  const openOverlay = code.match(/public async openOverlay\([\s\S]*?\n  }\n\n  public closeOverlay/)?.[0] ?? "";
  const closeOverlay = code.match(/public closeOverlay\([\s\S]*?\n  }\n\n  public resolvePermission/)?.[0] ?? "";
  const focus = code.match(/public focus\([\s\S]*?\n  }/)?.[0] ?? "";
  const activate = code.match(/\n  #activate\([\s\S]*?\n  }/)?.[0] ?? "";

  assert.match(openOverlay, /const generation = \+\+this\.#overlayGeneration/);
  assert.match(openOverlay, /generation !== this\.#overlayGeneration/);
  assert.match(openOverlay, /this\.#overlayCaptureTabId !== tab\.id/);
  assert.match(openOverlay, /!this\.#tabs\.has\(tab\.id\)/);
  assert.match(openOverlay, /throw new Error\("The browser overlay request was cancelled"\)/);
  assert.match(closeOverlay, /\+\+this\.#overlayGeneration/);
  assert.match(closeOverlay, /if \(!wasOpen && !wasCapturing\) return/);
  assert.match(focus, /!this\.#overlayBusy\(\)[^]*?webContents\.focus\(\)/);
  assert.match(activate, /if \(!this\.#overlayBusy\(\)\)[^]*?webContents\.focus\(\)/);
});

test("browser overlay restores the active view without assuming child order", async () => {
  const code = await source();
  const closeOverlay = code.match(/public closeOverlay\([\s\S]*?\n  }\n\n  public resolvePermission/)?.[0] ?? "";
  const restoreActiveTab = code.match(/\n  #restoreActiveTab\([\s\S]*?\n  }/)?.[0] ?? "";

  assert.match(closeOverlay, /this\.#restoreActiveTab\(\)/);
  assert.match(restoreActiveTab, /this\.#activeTabId/);
  assert.match(restoreActiveTab, /this\.#window\.contentView\.addChildView\(tab\.view\)/);
  assert.match(restoreActiveTab, /this\.#syncTabVisibility\(\)/);
  assert.doesNotMatch(code, /contentView\.children\[0\]/);
});
