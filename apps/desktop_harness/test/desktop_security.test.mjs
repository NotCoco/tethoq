import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => await readFile(new URL(path, import.meta.url), "utf8");

test("desktop built-in provider allowlist stays explicit at every privileged boundary", async () => {
  const [api, config, runtime, connectors] = await Promise.all([
    source("../src/shared/desktop_api.ts"),
    source("../src/main/config.ts"),
    source("../src/main/runtime.ts"),
    source("../src/main/connectors.ts"),
  ]);

  assert.match(api, /DESKTOP_PROVIDERS\s*=\s*\[\s*"codex",\s*"opencode",\s*"grok",\s*"pi",\s*"omp",\s*"qwen",\s*"goose",\s*"kimi",\s*"hermes",\s*"cline",\s*"copilot",\s*"direct"\s*\]\s*as const/);
  assert.match(connectors, /RESERVED_IDS\s*=\s*new Set\(\[[^\]]*"direct"[^\]]*\]\)/);
  assert.doesNotMatch(api, /DESKTOP_PROVIDERS[^;]*claude/is);
  assert.match(config, /enabledProviders:\s*DESKTOP_PROVIDERS/g);
  assert.doesNotMatch(runtime, /provider_claude|ClaudeAdapter|createConfiguredProviders/);

  assert.match(runtime, /new CodexAdapter\s*\(/);
  assert.match(runtime, /new OpenCodeAdapter\s*\(/);
  assert.match(runtime, /new GrokProviderAdapter\s*\(/);
  assert.match(runtime, /new CodexAdapter\([\s\S]*?localActivity:\s*\{\s*retirementStatePath:\s*join\(dirname\(this\.#configPath\),\s*"codex-activity-retirements\.json"\)\s*\}/);
  assert.match(runtime, /new OpenCodeAdapter\([\s\S]*?localActivity:\s*openCodeDatabasePath === undefined \? \{\} : \{ databasePath: openCodeDatabasePath \}/);
  assert.match(runtime, /new CodexAdapter\([\s\S]*?localActivity:\s*\{[^}]*retirementStatePath:[^}]*\},[\s\S]*?desktopQueue:\s*\{\}/);
});

test("preload exposes a narrow frozen API without Node or raw IPC access", async () => {
  const preload = await source("../src/preload/index.ts");
  const api = await source("../src/shared/desktop_api.ts");

  assert.match(preload, /contextBridge\.exposeInMainWorld\(\s*"tethoqDesktop",\s*api\s*\)/);
  assert.match(preload, /const api:[^=]+=\s*Object\.freeze\(/s);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*(ipcRenderer|require|process)/s);
  assert.doesNotMatch(api, /privateKey|pairingSecret|relayToken|\bcredential\s*[?:]/i);

  const invokes = [...preload.matchAll(/ipcRenderer\.invoke\(IPC_CHANNELS\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual(new Set(invokes), new Set([
    "bootstrap",
    "updateGetState",
    "updateAction",
    "request",
    "selectDirectory",
    "selectImages",
    "selectFiles",
    "captureScreens",
    "revealPath",
    "copyText",
    "localOpenHandlers",
    "openLocalTarget",
    "openExternalUrl",
    "openDictationSetupPage",
    "openHarnessSetupPage",
    "showWindow",
    "hideWindow",
    "openCodeStatus",
    "restartOpenCode",
    "connectorAction",
    "browserGetState",
    "browserAction",
    "recorderGetState",
    "recorderAction",
    "preferencesGet",
    "preferencesAction",
    "liveSessionGetState",
    "liveSessionAction",
    "mobileConnectionGetState",
    "mobileConnectionAction",
    "smokeQuit",
  ]));
  assert.match(preload, /process\.env\.TETHOQ_PACKAGED_SMOKE\s*===\s*"1"[\s\S]*?quitForSmoke[\s\S]*?IPC_CHANNELS\.smokeQuit/);
  assert.doesNotMatch(preload, /desktopCapturer|screen\.getAllDisplays/);
});

test("local file opening stays main-validated and never accepts renderer commands", async () => {
  const [api, preload, ipc, localOpen] = await Promise.all([
    source("../src/shared/desktop_api.ts"),
    source("../src/preload/index.ts"),
    source("../src/main/ipc.ts"),
    source("../src/main/local_open.ts"),
  ]);
  assert.match(api, /localOpenHandlers:\s*"tethoq:local-open-handlers"/);
  assert.match(preload, /openLocalTarget:[\s\S]*?IPC_CHANNELS\.openLocalTarget/);
  assert.match(ipc, /handle\(IPC_CHANNELS\.openLocalTarget[\s\S]*?existingLocalTarget\(path, line, column\)[\s\S]*?openExistingLocalTarget/);
  assert.match(localOpen, /realpath\(normalize\(resolve\(path\)\)\)/);
  assert.match(localOpen, /Network and Win32 device namespaces/);
  assert.match(localOpen, /spawnProcess\(executable, \[\.\.\.args\], \{ detached: true, shell: false/);
  assert.match(localOpen, /target\.kind === "file"\) options\.shell\.showItemInFolder/);
  assert.doesNotMatch(preload, /executable|command|shell/);
});

test("generic desktop files stay OpenCode-only, bounded, and non-executable", async () => {
  const [api, ipc, preload, bridge] = await Promise.all([
    source("../src/shared/desktop_api.ts"),
    source("../src/main/ipc.ts"),
    source("../src/preload/index.ts"),
    source("../src/renderer/src/bridge.ts"),
  ]);
  assert.match(api, /selectFiles:\s*"tethoq:select-files"/);
  assert.match(preload, /selectFiles:[\s\S]*?IPC_CHANNELS\.selectFiles/);
  assert.match(ipc, /providerId !== "opencode"/);
  assert.match(ipc, /properties:\s*\["openFile", "multiSelections"\]/);
  assert.match(ipc, /file\.isSymbolicLink\(\) \|\| !file\.isFile\(\)/);
  assert.match(ipc, /MAX_FILE_BYTES\s*=\s*25 \* 1024 \* 1024/);
  assert.match(ipc, /MAX_SELECTED_FILE_BYTES\s*=\s*50 \* 1024 \* 1024/);
  assert.match(ipc, /EXECUTABLE_FILE_EXTENSIONS/);
  assert.match(ipc, /hasExecutableSignature\(data\)/);
  assert.match(ipc, /case "\.ts"[\s\S]*?case "\.ps1"[\s\S]*?return "text\/plain"/);
  assert.doesNotMatch(ipc.match(/EXECUTABLE_FILE_EXTENSIONS = new Set\(\[[\s\S]*?\]\);/)?.[0] ?? "", /\.ts|\.js|\.py|\.ps1|\.sh|\.bat/);
  assert.match(bridge, /supportsGenericFileAttachments\(providerId: string\)[\s\S]*?providerId === "opencode"/);
});

test("screen-region capture stays in main and returns bounded renderer-safe previews", async () => {
  const [api, ipc, preload] = await Promise.all([
    source("../src/shared/desktop_api.ts"),
    source("../src/main/ipc.ts"),
    source("../src/preload/index.ts"),
  ]);
  assert.match(api, /captureScreens:\s*"tethoq:capture-screens"/);
  assert.match(preload, /captureScreens:[\s\S]*?IPC_CHANNELS\.captureScreens/);
  assert.match(ipc, /desktopCapturer\.getSources\(\{[\s\S]*?types:\s*\["screen"\]/);
  assert.match(ipc, /MAX_CAPTURE_EDGE\s*=\s*4_096/);
  assert.match(ipc, /toJPEG\(88\)/);
  assert.match(ipc, /assertTrustedSender\(event, window\)/);
});

test("provider requests and event delivery stay in the main process", async () => {
  const runtime = await source("../src/main/runtime.ts");

  assert.match(runtime, /new BridgeRequestRouter\(bridge\)/);
  // Batch bounds and replay ordering are exercised by desktop_event_delivery.
  assert.match(runtime, /new DesktopEventDelivery\(sequence => bridge\.eventReplaySince\(sequence\), this\.#onEvents\)/);
  assert.match(runtime, /const ACTIVE_EVENT_POLL_MS\s*=\s*1_000/);
  assert.match(runtime, /const HIDDEN_EVENT_POLL_MS\s*=\s*1_000/);
  assert.match(runtime, /setWindowVisible\(visible: boolean\)[\s\S]*?scheduleEventPoll\(\)/);
  assert.doesNotMatch(runtime, /BridgeSocketServer|allowUnsignedRequests/);
  const ensureOpenCode = runtime.match(/public (?:async )?ensureOpenCode\([\s\S]*?\n  }/)?.[0] ?? "";
  assert.match(ensureOpenCode, /#openCodeEnsurePromise/);
  assert.doesNotMatch(ensureOpenCode, /reconnectProvider/);
  const ensureOpenCodeOnce = runtime.match(/private async ensureOpenCodeOnce\([\s\S]*?\n  }/)?.[0] ?? "";
  assert.match(ensureOpenCodeOnce, /#openCode\.ensureRunning\(\)/);
  const startOnce = runtime.match(/private async startOnce\([\s\S]*?\n  }/)?.[0] ?? "";
  assert.match(startOnce, /#openCode\.probe\(\)/);
  // The desktop owns the OpenCode server for its whole lifetime, but a cold
  // server can take seconds to answer, so readiness is reported first and the
  // start runs behind it.
  assert.doesNotMatch(startOnce, /#openCode\.ensureRunning\(\)/);
  assert.match(startOnce, /this\.#onState\(\{ state: "ready" \}\);[\s\S]*?this\.startOpenCodeInBackground\(bridge\)/);
  const backgroundStart = runtime.match(/private startOpenCodeInBackground\([\s\S]*?\n  }/)?.[0] ?? "";
  assert.match(backgroundStart, /this\.ensureOpenCode\(\)/);
  assert.match(backgroundStart, /this\.reconnectOpenCodeProvider\(bridge\)/);
  assert.match(runtime, /new MeshToolGateway\(/);
  assert.match(
    runtime,
    /\(parentSessionId, tool, input, context\) => tool\.startsWith\("browser_"\)[\s\S]{0,200}bridge\.executeClientTool\(parentSessionId, tool, input, context\)/,
    "Desktop must preserve the provider-owned tool call identity so EYES does not create a duplicate Bridge fallback",
  );
  assert.match(runtime, /bridge\.configureClientTooling\(clientTools\)/);
  assert.match(runtime, /catch \(error\) \{[\s\S]*?#bridge\?\.dispose\(\)[\s\S]*?#clientTools\?\.close\(\)[\s\S]*?#connectorRegistry\?\.dispose\(\)[\s\S]*?#openCode\.dispose\(\)/);
});

test("connector trust actions are narrow and revocation removes runtime authorization immediately", async () => {
  const [api, ipc, runtime] = await Promise.all([
    source("../src/shared/desktop_api.ts"),
    source("../src/main/ipc.ts"),
    source("../src/main/runtime.ts"),
  ]);

  assert.match(ipc, /handle\(IPC_CHANNELS\.connectorAction[\s\S]*?runtime\.connectorAction\(validateConnectorAction\(value\)\)/);
  assert.match(ipc, /type !== "approve" && type !== "revoke"/);
  assert.match(ipc, /\^sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(runtime, /fingerprintInstalledDesktopConnector\(pending\.directory\)/);
  assert.match(runtime, /#revokedConnectorIds\.add\(loaded\.id\)[\s\S]*?adapter\?\.dispose\(\)/);
  assert.match(runtime, /allowedProviderIds\(\)[\s\S]*?filter\(\(providerId\) => !this\.#revokedConnectorIds\.has\(providerId\)\)/);
  assert.match(runtime, /mutableLoaded\.splice\(index, 1\)/);
  assert.doesNotMatch(runtime, /Restart Tethoq to review/);
  const descriptor = api.match(/export interface DesktopConnectorDescriptor \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.doesNotMatch(descriptor, /restartRequired/);
  assert.match(api, /export interface ConnectorActionResult \{[\s\S]*?restartRequired: boolean/);
});

test("IPC request routing is allowlisted and provider targets are validated", async () => {
  const ipc = await source("../src/main/ipc.ts");
  const allowedBlock = ipc.match(/const ALLOWED_REQUESTS\s*=\s*new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  const allowed = [...allowedBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  assert.ok(allowed.length >= 20, "desktop request allowlist unexpectedly collapsed");
  assert.equal(new Set(allowed).size, allowed.length, "desktop request allowlist contains duplicates");
  assert.ok(allowed.includes("session.create"));
  assert.ok(allowed.includes("scheduled_task.list"));
  assert.ok(allowed.includes("scheduled_task.create"));
  assert.ok(allowed.includes("scheduled_task.cancel"));
  assert.ok(allowed.includes("scheduled_task.run_now"));
  assert.ok(allowed.includes("scheduled_task.retry"));
  assert.ok(allowed.includes("session.watch"));
  assert.ok(allowed.includes("session.unwatch"));
  assert.ok(allowed.includes("ears.process"));
  assert.ok(allowed.includes("ears.cancel"));
  assert.ok(allowed.includes("approval.respond"));
  assert.ok(allowed.includes("delegation.start"));
  assert.ok(allowed.includes("delegation.prepare"));
  assert.ok(allowed.includes("session.context_handoff"));
  assert.ok(allowed.includes("session.branch"));
  assert.ok(allowed.includes("session.image.get"));
  assert.ok(allowed.includes("message_queue.draft"));
  assert.ok(allowed.includes("message_queue.draft_attachment"));
  assert.ok(allowed.includes("session.goal.get"));
  assert.ok(allowed.includes("session.goal.set"));
  assert.ok(allowed.includes("session.goal.clear"));
  assert.ok(allowed.includes("session.permissions.get"));
  assert.ok(allowed.includes("session.permissions.set"));
  assert.ok(allowed.includes("session.context.clear_threshold"));
  assert.ok(allowed.includes("wallet.get"));
  assert.ok(allowed.includes("wallet.configure"));
  assert.equal(allowed.includes("pairing.confirm"), false);
  assert.equal(allowed.includes("pairing.start"), false);
  assert.match(ipc, /if \(!ALLOWED_REQUESTS\.has\(type\)\) throw new Error/);
  assert.match(ipc, /validateProviderTarget\(payload,[\s\S]*?allowedProviderIds/);
  assert.match(ipc, /!allowedProviderIds\.has\(providerId\)/);
  assert.match(ipc, /!allowedProviderIds\.has\(target\.providerId\)/);
  assert.match(ipc, /event\.senderFrame !== window\.webContents\.mainFrame/);
  assert.match(ipc, /process\.env\.TETHOQ_PACKAGED_SMOKE\s*===\s*"1"[\s\S]*?handle\(IPC_CHANNELS\.smokeQuit[\s\S]*?app\.quit\(\)/);
});

test("the Electron window keeps renderer privileges disabled", async () => {
  const [main, security, rendererHtml] = await Promise.all([
    source("../src/main/index.ts"),
    source("../src/main/security.ts"),
    source("../src/renderer/index.html"),
  ]);

  assert.match(main, /\.\.\.SECURE_WEB_PREFERENCES/);
  assert.match(main, /preload:\s*join\(__dirname,\s*"\.\.\/preload\/index\.cjs"\)/);
  assert.match(main, /hardenSession\(session\.defaultSession\)/);
  assert.match(main, /hardenWindow\(window\)/);
  assert.match(main, /titleBarStyle:\s*"hidden"/);
  assert.match(main, /const WINDOW_SURFACE_COLOR = "#0b0b0a"/);
  assert.match(main, /backgroundColor:\s*WINDOW_SURFACE_COLOR/);
  assert.match(main, /titleBarOverlay:\s*\{[\s\S]*?color:\s*WINDOW_SURFACE_COLOR[\s\S]*?height:\s*46/);
  assert.match(main, /minWidth:\s*760/);
  assert.match(main, /minHeight:\s*480/);
  assert.match(main, /backgroundThrottling:\s*true/);
  assert.match(main, /webContents\.setBackgroundThrottling\(true\)/);
  assert.doesNotMatch(main, /disable-renderer-backgrounding/);
  assert.doesNotMatch(main, /disable-background-timer-throttling/);
  assert.doesNotMatch(main, /disable-backgrounding-occluded-windows/);
  assert.doesNotMatch(main, /CalculateNativeWinOcclusion/);
  assert.match(main, /window\.webContents\.send\(IPC_CHANNELS\.eventBatch, batch\)[\s\S]*?notifyForEvents\(window, batch\.events/);
  assert.match(main, /window\.on\("hide"[\s\S]*?setWindowVisible\(false\)[\s\S]*?setHostVisible\(false\)/);
  // The smoke build must stay invisible and inert, and a hidden start must stay hidden.
  assert.match(main, /const reveal = \(\): void =>[\s\S]*?TETHOQ_PACKAGED_SMOKE\s*===\s*"1"[\s\S]*?else if \(!startedHidden\(\)\) \{\s*window\.show\(\);\s*window\.focus\(\);/);
  // Slow setup cannot reveal Chromium's initial blank document: the app-owned local
  // startup page must finish loading before the first explicit reveal.
  assert.match(main, /await loadStartupSurface\(window\);\s*(?:recordStartupProfile\([\s\S]*?\);\s*)?reveal\(\);\s*await delayStartupForVisualTest\(\)/);
  assert.match(main, /async function loadRenderer\(window: BrowserWindow\): Promise<void> \{[\s\S]*?await window\.load(?:URL|File)\([\s\S]*?window\.webContents\.navigationHistory\.clear\(\);\s*\}/, "the startup surface must not remain reachable through shell Back/Forward commands");
  assert.doesNotMatch(main, /startupRevealTimer|STARTUP_REVEAL_FALLBACK_MS/);
  assert.match(main, /<main class="shell" role="status" aria-label="Tethoq is starting">[\s\S]*class="rail"[\s\S]*class="messages"[\s\S]*class="composer"/);
  assert.doesNotMatch(main, /Connecting to your coding tools on this computer…/);
  assert.match(main, /await loadStartupSurface\(window, "failed"\)/);
  assert.match(rendererHtml, /:root, html, body, #root \{[^}]*background: #0b0b0a/);
  assert.match(rendererHtml, /id="root"><main class="pre-react-startup" role="status" aria-label="Tethoq is starting">[\s\S]*class="pre-react-rail"[\s\S]*class="pre-react-messages"[\s\S]*class="pre-react-composer"/);
  assert.doesNotMatch(rendererHtml, /Connecting to your coding tools on this computer…/);
  assert.match(main, /clampWindowStateToDisplay\(remembered, display\.workArea\)/);
  assert.match(main, /else if \(!startedHidden\(\)\) \{\s*window\.show\(\);\s*window\.focus\(\);/);
  assert.match(security, /contextIsolation:\s*true/);
  assert.match(security, /nodeIntegration:\s*false/);
  assert.match(security, /sandbox:\s*true/);
  assert.match(security, /permission === "media"[\s\S]*?details\.mediaType === "audio"[\s\S]*?isTrustedRendererUrl/);
  assert.match(security, /details\.mediaTypes\?\.length === 1[\s\S]*?details\.mediaTypes\[0\] === "audio"/);
  assert.match(security, /callback\(audioOnly\)/);
  assert.doesNotMatch(security, /mediaTypes[^\n]+"video"/);
  assert.match(security, /img-src 'self' data: blob: https: tethoq-media: http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\* http:\/\/\[::1\]:\*; connect-src 'none'/);
  assert.equal((security.match(/img-src[^;]*tethoq-media:/g) ?? []).length, 2);
  assert.doesNotMatch(security, /img-src[^;]*file:/);
  assert.equal((security.match(/http:\/\/localhost:\*/g) ?? []).length, 2);
  assert.equal((security.match(/http:\/\/127\.0\.0\.1:\*/g) ?? []).length, 2);
  assert.equal((security.match(/http:\/\/\[::1\]:\*/g) ?? []).length, 2);
  assert.doesNotMatch(security, /img-src[^;]*\shttp:(?:\s|;)/);
  assert.doesNotMatch(security, /connect-src[^;]*http:/);
  assert.equal((security.match(/media-src 'self' blob: tethoq-media:/g) ?? []).length, 2);
  assert.equal((security.match(/worker-src blob:/g) ?? []).length, 2);
  assert.deepEqual([...security.matchAll(/worker-src ([^"`;]+)/g)].map((match) => match[1].trim()), ["blob:", "blob:"]);
  assert.match(main, /registerLocalMediaScheme\(\)/);
  assert.match(main, /registerLocalMediaProtocol\(session\.defaultSession\)/);
  assert.doesNotMatch(security, /connect-src[^;]*https:/);
  assert.match(security, /will-navigate/);
  assert.match(security, /setWindowOpenHandler/);
});

test("packaged smoke compositor priming stays invisible and environment-guarded", async () => {
  const main = await source("../src/main/index.ts");
  assert.match(main, /process\.env\.TETHOQ_PACKAGED_SMOKE\s*===\s*"1"/);
  assert.match(main, /window\.setSkipTaskbar\(true\)/);
  assert.match(main, /window\.setIgnoreMouseEvents\(true\)/);
  assert.match(main, /window\.setOpacity\(0\)/);
  assert.match(main, /window\.showInactive\(\)/);
  // Outside smoke, the window shows unless the user asked Windows to start Tethoq in the tray.
  assert.match(main, /else if \(!startedHidden\(\)\) \{\s*window\.show\(\);\s*window\.focus\(\);/);
});

test("the packaged preload is emitted as sandbox-compatible CommonJS", async () => {
  const config = await source("../electron.vite.config.ts");
  const main = await source("../src/main/index.ts");

  assert.match(config, /preload:[\s\S]*?output:\s*\{[\s\S]*?format:\s*"cjs"[\s\S]*?entryFileNames:\s*"\[name\]\.cjs"/);
  assert.match(main, /preload:\s*join\(__dirname,\s*"\.\.\/preload\/index\.cjs"\)/);
  assert.doesNotMatch(main, /preload:\s*join\(__dirname,[^\n]*\.mjs/);
});

test("Windows packaging embeds one independently launchable Bridge companion", async () => {
  const [packageJson, metadataScript, builderConfig, installerInclude, embeddedBridgeSmoke] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/write-release-metadata.cjs", import.meta.url), "utf8"),
    readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/installer.nsh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-embedded-bridge.cjs", import.meta.url), "utf8"),
  ]);

  assert.match(packageJson, /electron-builder[^\n]+npm run release:metadata/);
  assert.match(metadataScript, /release-manifest\.json/);
  assert.match(metadataScript, /SHA256SUMS\.txt/);
  assert.match(metadataScript, /createHash\('sha256'\)/);
  assert.match(metadataScript, /format: 'nsis-installer'/);
  assert.match(metadataScript, /bridgeExecutableSha256/);
  assert.match(builderConfig, /from: build\/bridge-companion[\s\S]*?to: bridge-companion/);
  assert.doesNotMatch(builderConfig, /Tethoq-Bridge-[^\n]+\.zip/);
  assert.match(installerInclude, /Tethoq Bridge\.lnk[\s\S]*?--background/);
  assert.match(installerInclude, /customUnInstall[\s\S]*?Delete/);
  assert.match(embeddedBridgeSmoke, /Desktop must embed exactly one Bridge companion/);
  assert.match(embeddedBridgeSmoke, /Usage: agent-bridge/);
});
