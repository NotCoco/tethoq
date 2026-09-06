import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const electronPath = createRequire(import.meta.url)("electron");

const contextMenuSource = async () => await readFile(join(appRoot, "src", "main", "context_menu.ts"), "utf8");

function transpileContextMenu(code, moduleKind) {
  return ts.transpileModule(code, {
    compilerOptions: { module: moduleKind, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

/**
 * Runs the real builder. It imports only types, so nothing has to be stubbed.
 * This evaluates in the current realm rather than a fresh context, so the arrays
 * it returns compare by structure against the ones asserted here.
 */
async function loadTemplateBuilder() {
  const script = transpileContextMenu(await contextMenuSource(), ts.ModuleKind.ESNext)
    .replace(/^export\s+/gm, "");
  return vm.runInThisContext(`(() => {\n${script}\n; return contextMenuTemplate; })()`);
}

const noopActions = {
  replaceMisspelling: () => undefined,
  learnSpelling: () => undefined,
  copyText: () => undefined,
  copyImage: () => undefined,
  allowWebUrl: (url) => url.startsWith("https://") || url.startsWith("http://"),
};

function params(overrides = {}) {
  return {
    x: 10,
    y: 20,
    isEditable: false,
    selectionText: "",
    linkURL: "",
    mediaType: "none",
    hasImageContents: false,
    misspelledWord: "",
    dictionarySuggestions: [],
    ...overrides,
    editFlags: {
      canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false,
      ...(overrides.editFlags ?? {}),
    },
  };
}

const roles = (template) => template.map((item) => item.role ?? item.label ?? item.type);
const itemFor = (template, role) => template.find((item) => item.role === role);
const labelled = (template, label) => template.find((item) => item.label === label);

test("selected text outside an editable field offers exactly one copy", async () => {
  const build = await loadTemplateBuilder();
  const template = build(params({ selectionText: "a selected answer", editFlags: { canCopy: true, canSelectAll: true } }), noopActions);

  assert.deepEqual(roles(template), ["copy"]);
  assert.equal(itemFor(template, "copy").enabled, true);
});

test("an editable field offers the full editing set with real enablement", async () => {
  const build = await loadTemplateBuilder();
  const template = build(params({
    isEditable: true,
    selectionText: "draft text",
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  }), noopActions);

  assert.deepEqual(roles(template), ["undo", "redo", "separator", "cut", "copy", "paste", "separator", "selectAll"]);
  assert.equal(itemFor(template, "undo").enabled, true);
  assert.equal(itemFor(template, "redo").enabled, false);
  assert.equal(itemFor(template, "paste").enabled, true);
});

test("an empty editable field still offers paste and select all", async () => {
  const build = await loadTemplateBuilder();
  const template = build(params({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } }), noopActions);

  assert.equal(itemFor(template, "paste").enabled, true);
  assert.equal(itemFor(template, "cut").enabled, false);
  assert.equal(itemFor(template, "copy").enabled, false);
});

test("a masked field cannot have its value lifted out of the menu", async () => {
  const build = await loadTemplateBuilder();
  // Chromium reports a password field's selection as bullets and refuses copy
  // and cut. The menu must carry that refusal rather than re-enabling them.
  const template = build(params({
    isEditable: true,
    selectionText: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
    editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
  }), noopActions);

  assert.equal(itemFor(template, "copy").enabled, false);
  assert.equal(itemFor(template, "cut").enabled, false);
});

test("optimistic edit flags on a plain link cannot invent editing items", async () => {
  const build = await loadTemplateBuilder();
  // Chromium answers true to canCut and canPaste over a link with nothing
  // selected. Item choice comes from isEditable and selectionText instead.
  const template = build(params({
    linkURL: "https://example.invalid/page",
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
  }), noopActions);

  assert.deepEqual(roles(template), ["Copy link"]);
});

test("only real web links and real images gain their copy actions", async () => {
  const build = await loadTemplateBuilder();

  assert.deepEqual(roles(build(params({ linkURL: "javascript:alert(1)" }), noopActions)), []);
  assert.deepEqual(roles(build(params({ linkURL: "file:///C:/secret" }), noopActions)), []);
  assert.deepEqual(roles(build(params({ mediaType: "image", hasImageContents: true }), noopActions)), ["Copy image"]);
  assert.deepEqual(roles(build(params({ mediaType: "image", hasImageContents: false }), noopActions)), []);
});

test("copy image copies from the point that was right-clicked", async () => {
  const build = await loadTemplateBuilder();
  const copied = [];
  const template = build(params({ x: 143, y: 271, mediaType: "image", hasImageContents: true }), {
    ...noopActions,
    copyImage: (x, y) => copied.push([x, y]),
  });
  labelled(template, "Copy image").click();

  assert.deepEqual(copied, [[143, 271]]);
});

test("a misspelled word leads with its corrections and can teach the dictionary", async () => {
  const build = await loadTemplateBuilder();
  const replaced = [];
  const learned = [];
  const template = build(params({
    isEditable: true,
    misspelledWord: "recieve",
    dictionarySuggestions: ["receive", "relieve", "reprieve", "retrieve", "recipe", "recital"],
    editFlags: { canPaste: true, canSelectAll: true },
  }), { ...noopActions, replaceMisspelling: (w) => replaced.push(w), learnSpelling: (w) => learned.push(w) });

  // Capped at five so the list stays scannable, then the dictionary action,
  // then the ordinary editing items.
  assert.deepEqual(roles(template).slice(0, 8),
    ["receive", "relieve", "reprieve", "retrieve", "recipe", "separator", "Add to dictionary", "separator"]);
  labelled(template, "receive").click();
  labelled(template, "Add to dictionary").click();
  assert.deepEqual(replaced, ["receive"]);
  assert.deepEqual(learned, ["recieve"]);
  assert.ok(itemFor(template, "paste"), "editing items must survive the spelling block");
});

test("a misspelling with no suggestions says so rather than promising nothing", async () => {
  const build = await loadTemplateBuilder();
  const template = build(params({ isEditable: true, misspelledWord: "qwertyish", dictionarySuggestions: [] }), noopActions);

  assert.equal(labelled(template, "No spelling suggestions").enabled, false);
  assert.ok(labelled(template, "Add to dictionary"));
});

test("a spot with nothing to offer produces no menu at all", async () => {
  const build = await loadTemplateBuilder();

  assert.deepEqual(build(params(), noopActions), []);
  assert.deepEqual(build(params({ editFlags: { canSelectAll: true, canPaste: true } }), noopActions), []);
});

test("the window wires the shared menu and the app's own right-click menus keep cancelling", async () => {
  const [index, timeline, composer, navigation, localOpen, workspace] = await Promise.all([
    readFile(join(appRoot, "src", "main", "index.ts"), "utf8"),
    readFile(join(appRoot, "src", "renderer", "src", "ChatTimeline.tsx"), "utf8"),
    readFile(join(appRoot, "src", "renderer", "src", "Composer.tsx"), "utf8"),
    readFile(join(appRoot, "src", "renderer", "src", "NavigationPanels.tsx"), "utf8"),
    readFile(join(appRoot, "src", "renderer", "src", "LocalOpen.tsx"), "utf8"),
    readFile(join(appRoot, "src", "main", "browser_workspace.ts"), "utf8"),
  ]);

  assert.match(index, /webContents\.on\("context-menu"/u);
  assert.match(index, /contextMenuTemplate\(params, \{/u);
  // An empty template must never become an empty popup.
  assert.match(index, /if \(template\.length === 0 \|\| window\.isDestroyed\(\)\) return;/u);
  // One implementation for the workspace and the in-app browser.
  assert.match(workspace, /contextMenuTemplate\(params, \{/u);

  // Every app-owned right-click still cancels, which is what keeps the native
  // menu from opening on top of it.
  for (const [name, code] of [["ChatTimeline", timeline], ["Composer", composer], ["NavigationPanels", navigation], ["LocalOpen", localOpen]]) {
    assert.match(code, /onContextMenu=\{/u, `${name} lost its context menu`);
    assert.match(code, /event\.preventDefault\(\);/u, `${name} no longer cancels its right-click`);
  }
  // The two menus that take a right-click away from selectable text give the
  // copy back themselves.
  assert.match(timeline, /aria-label="Copy selected response"/u);
  assert.match(localOpen, /Copy path/u);
});

function runElectron(mainPath, htmlPath, modulePath) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [mainPath, htmlPath, modulePath], {
      cwd: appRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Context menu QA timed out.\n${stderr}`)); }, 45_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`Context menu QA exited ${code}.\n${stderr}\n${stdout}`)); return; }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_CONTEXT_MENU="));
      if (!marker) { reject(new Error(`Context menu QA returned no result.\n${stderr}\n${stdout}`)); return; }
      resolve(JSON.parse(marker.slice("TETHOQ_CONTEXT_MENU=".length)));
    });
  });
}

test("a real right-click builds the right menu and never fights an app-owned one", { timeout: 60_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-context-menu-${process.pid}-${Date.now()}`);
  const htmlPath = join(outputDirectory, "surface.html");
  const mainPath = join(outputDirectory, "main.cjs");
  const modulePath = join(outputDirectory, "context_menu.cjs");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(modulePath, transpileContextMenu(await contextMenuSource(), ts.ModuleKind.CommonJS), "utf8");
    await writeFile(htmlPath, `<!doctype html><html><body style="margin:0;font:16px system-ui">
      <div id="guarded" style="height:70px;background:#333;color:#fff">an app-owned region</div>
      <p id="answer" style="margin:0;padding:18px;background:#eee">a selected assistant answer</p>
      <textarea id="draft" style="margin:14px;width:320px;height:70px">draft message text</textarea>
      <input id="secret" type="password" value="super-secret-key" style="margin:14px;width:320px">
      <a id="link" href="https://example.invalid/page" style="display:block;padding:14px">a web link</a>
      <div id="empty" style="height:70px;background:#ddd"></div>
      <script>
        document.getElementById('guarded').addEventListener('contextmenu', (event) => event.preventDefault());
        const select = (node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        };
        window.__select = select;
        window.__rects = () => JSON.stringify(Object.fromEntries(
          ['guarded', 'answer', 'draft', 'secret', 'link', 'empty']
            .map((id) => [id, document.getElementById(id).getBoundingClientRect().toJSON()])));
      </script>
    </body></html>`, "utf8");
    await writeFile(mainPath, String.raw`
      const path = require("node:path");
      const { app, BrowserWindow } = require("electron");
      const { contextMenuTemplate } = require(process.argv[3]);
      app.commandLine.appendSwitch("disable-gpu");
      app.setPath("userData", path.join(__dirname, "profile"));
      const noop = () => undefined;
      const actions = { replaceMisspelling: noop, learnSpelling: noop, copyText: noop, copyImage: noop,
        allowWebUrl: (url) => url.startsWith("https://") || url.startsWith("http://") };
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 900, height: 700,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true } });
        const seen = [];
        // Building the template rather than popping it: a real popup would block
        // this process on an OS menu loop that nothing is there to dismiss.
        window.webContents.on("context-menu", (_event, params) => seen.push(
          contextMenuTemplate(params, actions).map((item) => ({ id: item.role ?? item.label ?? item.type, enabled: item.enabled }))));
        await window.loadFile(process.argv[2]);
        await new Promise((resolve) => setTimeout(resolve, 400));
        const rects = JSON.parse(await window.webContents.executeJavaScript("window.__rects()"));
        const at = async (rect, offset) => {
          const x = Math.round(rect.x + (offset?.x ?? rect.width / 2));
          const y = Math.round(rect.y + (offset?.y ?? rect.height / 2));
          window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "right", clickCount: 1 });
          window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "right", clickCount: 1 });
          await new Promise((resolve) => setTimeout(resolve, 260));
          return seen.length;
        };
        const result = {};
        const record = async (name, rect, prepare) => {
          if (prepare) { await window.webContents.executeJavaScript(prepare); await new Promise((r) => setTimeout(r, 60)); }
          const before = seen.length;
          await at(rect);
          result[name] = seen.length === before ? null : seen[seen.length - 1];
        };
        await record("guarded", rects.guarded, "window.__select(document.getElementById('answer')); true");
        await record("answer", rects.answer, "window.__select(document.getElementById('answer')); true");
        await record("draft", rects.draft, "const d = document.getElementById('draft'); d.focus(); d.select(); true");
        await record("secret", rects.secret, "const s = document.getElementById('secret'); s.focus(); s.select(); true");
        await record("link", rects.link);
        await record("empty", rects.empty);
        process.stdout.write("TETHOQ_CONTEXT_MENU=" + JSON.stringify(result) + "\n");
        window.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exitCode = 1; app.quit(); });
    `, "utf8");

    const result = await runElectron(mainPath, htmlPath, modulePath);
    const ids = (entry) => entry?.map((item) => item.id) ?? null;

    // An app-owned right-click cancels the DOM event, and Chromium then never
    // asks for a window menu. This is what lets Annotate, task actions, and
    // Open in keep their right-click without a second menu opening over them.
    assert.equal(result.guarded, null, "a cancelled right-click still produced a window menu");

    assert.deepEqual(ids(result.answer), ["copy"], "right-clicking a selection did not offer copy");
    assert.equal(result.answer[0].enabled, true);

    assert.deepEqual(ids(result.draft), ["undo", "redo", "separator", "cut", "copy", "paste", "separator", "selectAll"]);
    const draft = Object.fromEntries(result.draft.map((item) => [item.id, item.enabled]));
    assert.equal(draft.cut, true, "cut was not offered for selected text in a field");
    assert.equal(draft.copy, true, "copy was not offered for selected text in a field");
    assert.equal(draft.paste, true, "paste was not offered in an editable field");

    const secret = Object.fromEntries(result.secret.map((item) => [item.id, item.enabled]));
    assert.equal(secret.copy, false, "a masked field offered a live copy");
    assert.equal(secret.cut, false, "a masked field offered a live cut");
    assert.equal(secret.paste, true, "a masked field should still accept a paste");

    assert.deepEqual(ids(result.link), ["Copy link"]);
    // Chromium always asks about bare space; the template answers with nothing,
    // which is what stops the window from popping an empty menu there.
    assert.deepEqual(result.empty, [], "empty space should ask, and be given nothing to show");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
