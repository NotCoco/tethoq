import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const outputDirectory = join(tmpdir(), `tethoq-task-organization-${process.pid}-${Date.now()}`);
await mkdir(outputDirectory, { recursive: true });
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

// Notification routing is pure decision logic; the Electron surface it imports is
// stubbed so the rule can be exercised outside a packaged app.
const electronStub = join(outputDirectory, "electron-stub.mjs");
await writeFile(electronStub, "export class Notification { constructor(options) { this.options = options; } on() {} show() {} static isSupported() { return false; } }\n", "utf8");

async function bundle(entry, name) {
  const outfile = join(outputDirectory, `${name}.mjs`);
  await build({
    entryPoints: [join(appRoot, entry)],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    alias: { "@shared": join(appRoot, "src", "shared"), electron: electronStub },
  });
  return await import(`file:///${outfile.replaceAll("\\", "/")}`);
}

const source = async (relative) => await readFile(join(appRoot, relative), "utf8");

const preferences = await bundle("src/main/preferences.ts", "preferences");
const organization = await bundle("src/renderer/src/task_organization.ts", "task-organization");
const notifications = await bundle("src/main/notifications.ts", "notifications");

const task = (id, updatedAt, extra = {}) => ({
  id,
  providerId: "codex",
  title: `Provider title for ${id}`,
  state: "idle",
  project: "payments",
  workingDirectory: `C:\\repos\\${id}`,
  preview: "",
  updatedAt,
  model: "gpt-5.6-sol",
  effort: "medium",
  ...extra,
});

test("desktop behavior preferences persist, validate, and reject unknown values", async (t) => {
  const path = join(outputDirectory, `behavior-${Date.now()}.json`);
  t.after(() => rm(path, { force: true }));
  const store = await preferences.DesktopPreferencesStore.load(path);

  // Defaults preserve today's behaviour: close hides to the tray, everything alerts.
  assert.equal(store.value().closeAction, "tray");
  assert.equal(store.value().launchAtLogin, "off");
  assert.equal(store.value().alerts, "all");

  await store.setCloseAction("quit");
  await store.setLaunchAtLogin("tray");
  await store.setAlerts("attention");
  const reloaded = await preferences.DesktopPreferencesStore.load(path);
  assert.equal(reloaded.value().closeAction, "quit");
  assert.equal(reloaded.value().launchAtLogin, "tray");
  assert.equal(reloaded.value().alerts, "attention");

  await assert.rejects(() => store.setCloseAction("minimise"), /close setting is invalid/);
  await assert.rejects(() => store.setLaunchAtLogin("sometimes"), /startup setting is invalid/);
  await assert.rejects(() => store.setAlerts("loud"), /alerts setting is invalid/);

  const repaired = preferences.validateDesktopPreferences({ closeAction: "explode", launchAtLogin: 3, alerts: null });
  assert.equal(repaired.closeAction, "tray");
  assert.equal(repaired.launchAtLogin, "off");
  assert.equal(repaired.alerts, "all");
});

test("alert level decides which unfocused events reach the operating system", () => {
  const decisions = (level) => ["approval.requested", "user_input.requested", "agent.error", "agent.completed", "session.updated"]
    .filter((type) => notifications.isNotifiableEvent(type, level));
  assert.deepEqual(decisions("all"), ["approval.requested", "user_input.requested", "agent.error", "agent.completed"]);
  // "Only when I'm needed" keeps every event that stops the work and drops routine success.
  assert.deepEqual(decisions("attention"), ["approval.requested", "user_input.requested", "agent.error"]);
  assert.deepEqual(decisions("off"), []);
});

test("task overrides merge, clear, and stay bounded", async (t) => {
  const path = join(outputDirectory, `overrides-${Date.now()}.json`);
  t.after(() => rm(path, { force: true }));
  const store = await preferences.DesktopPreferencesStore.load(path);

  await store.setTaskOverride("host/codex/one", { title: "Payments API" });
  await store.setTaskOverride("host/codex/one", { pinned: true });
  assert.deepEqual(store.value().taskOverrides["host/codex/one"], { title: "Payments API", pinned: true });

  // Clearing every field removes the entry rather than leaving an empty object behind.
  await store.setTaskOverride("host/codex/one", { title: "", pinned: false });
  assert.deepEqual(store.value().taskOverrides, {});

  await assert.rejects(() => store.setTaskOverride("   ", { pinned: true }), /task is invalid/);

  for (let index = 0; index < 505; index += 1) await store.setTaskOverride(`host/codex/${index}`, { pinned: true });
  assert.equal(Object.keys(store.value().taskOverrides).length, 500);
  assert.equal(store.value().taskOverrides["host/codex/504"]?.pinned, true);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.keys(persisted.taskOverrides).length, 500);
});

test("organized tasks take the user's name, float pins, and keep archives out of the way", () => {
  const sessions = [
    task("recent", "2026-08-15T12:00:00.000Z"),
    task("older", "2026-08-15T09:00:00.000Z"),
    task("done", "2026-08-14T09:00:00.000Z"),
  ];
  const organized = organization.organizeSessions(sessions, {
    older: { title: "  Payments worker  ", pinned: true },
    done: { archived: true },
  });

  const worker = organized.find((session) => session.id === "older");
  assert.equal(worker.title, "Payments worker");
  assert.equal(worker.renamed, true);
  assert.equal(worker.pinned, true);
  // The provider's own title is never rewritten in place.
  assert.equal(sessions[1].title, "Provider title for older");
  assert.equal(organized.find((session) => session.id === "recent").title, "Provider title for recent");

  assert.deepEqual([...organized].sort(organization.compareOrganizedSessions).map((session) => session.id), ["older", "recent", "done"]);

  const archived = organized.find((session) => session.id === "done");
  assert.equal(organization.isHiddenByArchive(archived, false, null), true);
  assert.equal(organization.isHiddenByArchive(archived, true, null), false);
  // Archiving the task you are reading must not yank it out of the list.
  assert.equal(organization.isHiddenByArchive(archived, false, "done"), false);
  assert.equal(organization.isHiddenByArchive(organized[0], false, null), false);
});

test("the desktop behavior settings rows are real controls bound to stored preferences", async () => {
  const app = await source(join("src", "renderer", "src", "App.tsx"));
  for (const [label, action] of [["Close button", "set-close-action"], ["Alerts", "set-alerts"], ["Startup", "set-launch-at-login"]]) {
    assert.match(app, new RegExp(`aria-label="${label}"`), `${label} needs an accessible name`);
    assert.match(app, new RegExp(`type: "${action}"`), `${label} must dispatch ${action}`);
  }
  assert.doesNotMatch(app, /<dd>Keep running in tray<\/dd>|<dd>Windows notifications<\/dd>|<dd>Launch manually<\/dd>/, "settings must not display behaviour it cannot change");

  const index = await source(join("src", "main", "index.ts"));
  assert.match(index, /preferences\?\.value\(\)\.closeAction === "quit"/, "the close button must honour the stored choice");
  // Quitting from the close button routes through before-quit so window state and
  // provider processes are flushed while the window is still alive.
  assert.match(index, /event\.preventDefault\(\);\s*if \(preferences\?\.value\(\)\.closeAction === "quit"\) \{\s*quitting = true;\s*app\.quit\(\);/);
  assert.match(index, /notifyForEvents\(window, batch\.events, desktopPreferences\.value\(\)\.alerts\)/);
  assert.match(index, /app\.setLoginItemSettings\(loginItemSettingsFor\(value\)\)/);
});

test("startup registration only asks Windows for what the user chose", async () => {
  const index = await source(join("src", "main", "index.ts"));
  // Reproduce the exported mapping without loading Electron.
  const body = /export function loginItemSettingsFor\(value: DesktopLaunchAtLogin\): \{ openAtLogin: boolean; args: string\[\] \} \{\n\s*return (.+);\n\}/u.exec(index);
  assert.ok(body, "loginItemSettingsFor must stay a pure, testable mapping");
  const HIDDEN_LAUNCH_ARGUMENT = "--hidden";
  const map = new Function("value", "HIDDEN_LAUNCH_ARGUMENT", `return ${body[1]};`);
  assert.deepEqual(map("off", HIDDEN_LAUNCH_ARGUMENT), { openAtLogin: false, args: [] });
  assert.deepEqual(map("window", HIDDEN_LAUNCH_ARGUMENT), { openAtLogin: true, args: [] });
  assert.deepEqual(map("tray", HIDDEN_LAUNCH_ARGUMENT), { openAtLogin: true, args: ["--hidden"] });
  assert.match(index, /!app\.isPackaged/, "development builds must not register electron.exe at login");
});

test("the task rail exposes rename, pin, and archive without new permanent chrome", async () => {
  const navigation = await source(join("src", "renderer", "src", "NavigationPanels.tsx"));
  assert.match(navigation, /<span>Rename<\/span>/);
  assert.match(navigation, /\{menuSession\?\.pinned \? "Unpin" : "Pin to top"\}/);
  assert.match(navigation, /\{menuSession\?\.archived \? "Restore" : "Archive"\}/);
  // Archived work is revealed through the existing filter surface, not a new section.
  assert.match(navigation, /aria-checked=\{showArchived\}/);
  assert.match(navigation, /archivedCount \? <button/);
  // Renaming happens in the row, so the task never moves into a modal.
  assert.match(navigation, /className="session-row-rename"/);
  assert.match(navigation, /aria-label="Task name"/);

  const css = await source(join("src", "renderer", "src", "navigation.css"));
  // Pin and time share the one reserved trailing cell so a pinned row never shifts.
  assert.match(css, /\.session-row-trailing > \* \{ grid-area: 1 \/ 1; \}/);
  assert.match(css, /\.session-row\.archived \{ opacity: \.5; \}/);
});
