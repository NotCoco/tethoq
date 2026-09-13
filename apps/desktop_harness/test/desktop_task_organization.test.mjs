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


const preferences = await bundle("src/main/preferences.ts", "preferences");
const organization = await bundle("src/renderer/src/task_organization.ts", "task-organization");
const projects = await bundle("src/renderer/src/session_projects.ts", "session-projects");
const components = await bundle("src/renderer/src/components.tsx", "components");
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
  assert.equal(store.value().taskListMode, "recent");

  await store.setCloseAction("quit");
  await store.setLaunchAtLogin("tray");
  await store.setAlerts("attention");
  await store.setTaskListMode("project");
  const reloaded = await preferences.DesktopPreferencesStore.load(path);
  assert.equal(reloaded.value().closeAction, "quit");
  assert.equal(reloaded.value().launchAtLogin, "tray");
  assert.equal(reloaded.value().alerts, "attention");
  assert.equal(reloaded.value().taskListMode, "project");

  await assert.rejects(() => store.setCloseAction("minimise"), /close setting is invalid/);
  await assert.rejects(() => store.setLaunchAtLogin("sometimes"), /startup setting is invalid/);
  await assert.rejects(() => store.setAlerts("loud"), /alerts setting is invalid/);
  await assert.rejects(() => store.setTaskListMode("folders"), /task list mode is invalid/);

  const repaired = preferences.validateDesktopPreferences({ closeAction: "explode", launchAtLogin: 3, alerts: null });
  assert.equal(repaired.closeAction, "tray");
  assert.equal(repaired.launchAtLogin, "off");
  assert.equal(repaired.alerts, "all");
  assert.equal(repaired.taskListMode, "recent");
});

test("project grouping uses full normalized folders and keeps duplicate basenames separate", () => {
  const grouped = projects.groupSessionsByProject([
    task("one", "2026-08-24T10:00:00.000Z", { workingDirectory: "C:\\work\\alpha\\app\\" }),
    task("two", "2026-08-24T11:00:00.000Z", { workingDirectory: "c:/work/alpha/app" }),
    task("three", "2026-08-24T12:00:00.000Z", { workingDirectory: "C:\\work\\beta\\app" }),
    task("four", "2026-08-24T09:00:00.000Z", { workingDirectory: "" }),
  ], ["C:\\work\\alpha\\app", "C:\\work\\beta\\app"]);

  assert.deepEqual(grouped.map((group) => [group.name, group.sessions.map((session) => session.id)]), [
    ["app", ["one", "two"]],
    ["app", ["three"]],
  ]);
  assert.equal(projects.normalizeProjectDirectory("\\\\Server\\Share\\Repo\\"), "\\\\server\\share\\repo");
  assert.equal(projects.projectDirectoryName("C:\\"), "C:\\");
  assert.equal(projects.projectDirectoryName("/"), "/");
});

test("project grouping unifies UNC spellings and ignores malformed recency timestamps", () => {
  const grouped = projects.groupSessionsByProject([
    task("invalid-newest", "not-a-date", { workingDirectory: "\\\\Server\\Share\\" }),
    task("valid-same-project", "2026-08-24T12:00:00.000Z", { workingDirectory: "//server/share" }),
    task("older-project", "2026-08-23T12:00:00.000Z", { workingDirectory: "C:\\work\\older" }),
  ], ["C:\\work\\older", "\\\\Server\\Share"]);

  assert.equal(projects.normalizeProjectDirectory("\\\\Server\\Share\\"), "\\\\server\\share");
  assert.equal(projects.normalizeProjectDirectory("//server/share"), "\\\\server\\share");
  assert.deepEqual(grouped.map((group) => [group.key, group.updatedAt, group.sessions.map((session) => session.id)]), [
    ["directory:c:\\work\\older", "2026-08-23T12:00:00.000Z", ["older-project"]],
    ["directory:\\\\server\\share", "2026-08-24T12:00:00.000Z", ["invalid-newest", "valid-same-project"]],
  ]);
});

test("project folders stay in saved order across task activity, creation, and catalogue reordering", () => {
  const sessions = [
    task("beta-old", "2026-08-24T09:00:00.000Z", { workingDirectory: "C:\\work\\beta" }),
    task("alpha", "2026-08-24T12:00:00.000Z", { workingDirectory: "C:\\work\\Alpha" }),
    task("beta-newer", "2026-08-24T10:00:00.000Z", { workingDirectory: "C:\\work\\beta" }),
  ];
  const saved = ["C:\\work\\Alpha", "C:\\work\\beta"];
  const original = projects.groupSessionsByProject(sessions, saved);
  const active = projects.groupSessionsByProject([
    { ...sessions[0], updatedAt: "2026-08-25T12:00:00.000Z" },
    ...sessions.slice(1).reverse(),
  ], saved);
  const created = projects.groupSessionsByProject([
    task("beta-draft", "2026-08-26T12:00:00.000Z", { workingDirectory: "C:\\work\\beta", draft: true }),
    ...sessions.toReversed(),
  ], saved);
  for (const groups of [original, active, created]) assert.deepEqual(groups.map(group => group.name), ["Alpha", "beta"]);
  const taskIds = group => projects.visibleProjectSessions(group.sessions, null, false).map(session => session.id);
  assert.deepEqual(taskIds(original[1]), ["beta-newer", "beta-old"]);
  assert.deepEqual(taskIds(active[1]), ["beta-old", "beta-newer"]);
  assert.deepEqual(taskIds(created[1]), ["beta-draft", "beta-newer", "beta-old"]);
  assert.deepEqual(projects.groupSessionsByProject(sessions.toReversed(), saved).map(group => group.key), original.map(group => group.key));
});

test("project labels strip an encoded Codex parent path but preserve ordinary folders and suffixes", () => {
  const codexRoot = "D:\\Profiles\\fixture-user\\Documents\\Codex\\2026-08-23\\";
  const generated = `${codexRoot}d-profiles-fixture-user-documents-sample-project`;
  const generatedTwo = `${codexRoot}d-profiles-fixture-user-documents-sample-project-2`;
  const generatedThree = `${codexRoot}d-profiles-fixture-user-documents-sample-project-3`;
  assert.equal(projects.projectDirectoryName(generated), "sample-project");
  assert.equal(projects.projectDirectoryName(generatedTwo), "sample-project-2");
  assert.equal(projects.projectDirectoryName(generatedThree), "sample-project-3");
  assert.equal(projects.projectDirectoryName("D:\\Profiles\\fixture-user\\Documents\\My App"), "My App");

  const collision = projects.groupSessionsByProject([
    task("generated-one", "2026-08-24T12:00:00.000Z", { workingDirectory: generated }),
    task("generated-other-root", "2026-08-24T11:00:00.000Z", { workingDirectory: "D:\\scratch\\Codex\\2026-08-23\\d-scratch-sample-project" }),
    task("generated-two", "2026-08-24T10:00:00.000Z", { workingDirectory: generatedTwo }),
    task("generated-three", "2026-08-24T09:00:00.000Z", { workingDirectory: generatedThree }),
  ], [generated, "D:\\scratch\\Codex\\2026-08-23\\d-scratch-sample-project", generatedTwo, generatedThree]);
  assert.deepEqual(collision.map((group) => group.name), [
    "sample-project",
    "sample-project",
    "sample-project-2",
    "sample-project-3",
  ]);
  assert.notEqual(collision[0]?.key, collision[1]?.key, "full normalized paths keep same-name projects distinct");

  const missingCwd = projects.groupSessionsByProject([task("missing-cwd", "2026-08-24T08:00:00.000Z", { workingDirectory: undefined })], []);
  assert.deepEqual(missingCwd, []);
});

test("only explicitly saved folders collect sessions across harnesses, including empty projects", () => {
  const saved = ["C:\\Users\\example", "C:\\work\\app", "C:\\work\\empty"];
  const sessions = [
    task("home", "2026-09-06T10:00:00.000Z", { workingDirectory: saved[0] }),
    task("codex", "2026-09-06T10:00:00.000Z", { workingDirectory: saved[1] }),
    task("opencode", "2026-09-06T11:00:00.000Z", { providerId: "opencode", workingDirectory: "c:/work/app/" }),
    task("pi", "2026-09-06T12:00:00.000Z", { providerId: "pi", workingDirectory: "\\\\?\\C:\\work\\app" }),
    task("scratch", "2026-09-06T13:00:00.000Z", { workingDirectory: "C:\\Users\\example\\Codex\\chats" }),
    task("other-app", "2026-09-06T14:00:00.000Z", { workingDirectory: "C:\\other\\app" }),
  ];
  const grouped = projects.groupSessionsByProject(sessions, saved);
  assert.deepEqual(grouped.map((group) => group.sessions.map((session) => session.id)), [["home"], ["codex", "opencode", "pi"], []]);
  assert.deepEqual(projects.groupSessionsByProject(sessions, []), []);
  assert.equal(projects.sessionsForTaskListMode(sessions, "recent").length, sessions.length, "unsaved-folder chats remain available in Recent");
});

test("saved projects persist recency without discovering projects from chat activity or moving visible folders", async () => {
  const path = join(outputDirectory, "saved-projects.json");
  const store = await preferences.DesktopPreferencesStore.load(path);
  assert.deepEqual(store.value().savedProjectDirectories, []);
  await store.useProject("C:\\scratch\\chats");
  assert.deepEqual(store.value().savedProjectDirectories, []);
  await store.saveProject("C:\\work\\alpha");
  await store.saveProject("C:\\work\\beta");
  const visibleOrder = store.value().savedProjectDirectories;
  await store.useProject("c:/work/alpha/");
  const reloaded = await preferences.DesktopPreferencesStore.load(path);
  assert.deepEqual(reloaded.value().savedProjectDirectories, ["C:\\work\\alpha", "C:\\work\\beta"]);
  assert.deepEqual(projects.reconcileProjectDirectoryOrder(visibleOrder, reloaded.value().savedProjectDirectories), visibleOrder);
  await store.saveProject("C:\\work\\new");
  assert.deepEqual(projects.reconcileProjectDirectoryOrder(visibleOrder, store.value().savedProjectDirectories), ["C:\\work\\new", ...visibleOrder]);
  await assert.rejects(store.saveProject("relative-folder"));
  const normalized = preferences.validateDesktopPreferences({ savedProjectDirectories: ["C:\\work\\alpha", "c:/work/alpha/", "", null, "relative"] });
  assert.deepEqual(normalized.savedProjectDirectories, ["C:\\work\\alpha"]);
});

test("relative task times use one compact lowercase unit", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-08-24T12:00:00.000Z");
  try {
    assert.equal(components.relativeTime("2026-08-24T11:00:00.000Z"), "1h");
    assert.equal(components.relativeTime("2026-08-24T07:00:00.000Z"), "5h");
    assert.equal(components.relativeTime("2026-08-23T12:00:00.000Z"), "1d");
    assert.equal(components.relativeTime("2026-08-22T11:00:00.000Z"), "2d");
    assert.equal(components.relativeTime("not-a-date"), "now");
  } finally {
    Date.now = originalNow;
  }
});

test("project task windows cap at five, retain an older selection, and expand once", () => {
  const sessions = Array.from({ length: 8 }, (_, index) => task(
    `task-${index + 1}`,
    `2026-08-24T${String(index + 1).padStart(2, "0")}:00:00.000Z`,
  ));

  assert.deepEqual(projects.visibleProjectSessions(sessions, null, false).map((session) => session.id), [
    "task-8", "task-7", "task-6", "task-5", "task-4",
  ]);
  assert.deepEqual(projects.visibleProjectSessions(sessions, "task-1", false).map((session) => session.id), [
    "task-8", "task-7", "task-6", "task-5", "task-1",
  ]);
  assert.equal(projects.visibleProjectSessions(sessions, "task-1", true).length, 8);
  assert.equal(projects.visibleProjectSessions(sessions.slice(0, 5), null, false).length, 5);
});

test("project mode counts provider subagents before deciding whether to show more", () => {
  const ordinary = Array.from({ length: 5 }, (_, index) => task(
    `ordinary-${index + 1}`,
    `2026-08-24T0${index + 1}:00:00.000Z`,
    { workingDirectory: "C:\\Ideas" },
  ));
  const delegated = task("delegated-6", "2026-08-24T06:00:00.000Z", {
    workingDirectory: "C:\\Ideas",
    relationshipKind: "subagent",
  });
  const sideChat = task("side-chat", "2026-08-24T07:00:00.000Z", {
    workingDirectory: "C:\\Ideas",
    sessionKind: "side_chat",
  });
  const internal = task("internal", "2026-08-24T08:00:00.000Z", {
    workingDirectory: "C:\\Ideas",
    sessionKind: "internal",
  });

  assert.deepEqual(
    projects.sessionsForTaskListMode([...ordinary, delegated, sideChat, internal], "recent").map((session) => session.id),
    ordinary.map((session) => session.id),
    "recency remains a top-level task inbox",
  );
  const projectSessions = projects.sessionsForTaskListMode([...ordinary, delegated, sideChat, internal], "project");
  assert.equal(projectSessions.length, 6, "project mode includes the real delegated task only");
  const ideas = projects.groupSessionsByProject(projectSessions, [projectSessions[0].workingDirectory])[0];
  assert.equal(ideas.sessions.length, 6);
  assert.equal(projects.visibleProjectSessions(ideas.sessions, null, false).length, 5);
  assert.equal(ideas.sessions.length - projects.visibleProjectSessions(ideas.sessions, null, false).length, 1);
});

test("maintained harnesses use the agreed Tethoq-owned monogram family", async () => {
  const expected = {
    codex: "CX",
    opencode: "OC",
    grok: "G",
    pi: "π",
    omp: "OMP",
    qwen: "Q",
    goose: "g",
    kimi: "K",
    hermes: "H",
    cline: "CL",
    copilot: "CP",
    direct: "API",
  };
  for (const [providerId, monogram] of Object.entries(expected)) {
    const rendered = components.ProviderLogo({ providerId, size: 24 });
    assert.equal(rendered.props.children.props.children, monogram, `${providerId} renders its Tethoq monogram`);
    assert.equal(rendered.props.children.type, "span");
  }
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

test("draft task overrides move atomically to the provider task ID", async (t) => {
  const path = join(outputDirectory, `move-draft-override-${Date.now()}.json`);
  t.after(() => rm(path, { force: true }));
  const store = await preferences.DesktopPreferencesStore.load(path);

  await store.setTaskOverride("draft-local", { title: "Put away draft", pinned: true, archived: true });
  await store.setTaskOverride("opencode-real", { title: "Provider title" });
  await store.moveTaskOverride("draft-local", "opencode-real");

  assert.equal(store.value().taskOverrides["draft-local"], undefined);
  assert.deepEqual(store.value().taskOverrides["opencode-real"], { title: "Put away draft", pinned: true, archived: true });
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.taskOverrides["draft-local"], undefined);
  assert.deepEqual(persisted.taskOverrides["opencode-real"], { title: "Put away draft", pinned: true, archived: true });
});

test("foreign subagent spawning stays gated, session-scoped, and bounded", async (t) => {
  const path = join(outputDirectory, `foreign-subagents-${Date.now()}.json`);
  t.after(() => rm(path, { force: true }));
  const store = await preferences.DesktopPreferencesStore.load(path);

  // The gate is off by default, so the control is hidden and every session is denied.
  assert.equal(store.value().experimentalFeatures, false);
  assert.equal(store.value().allowForeignSubagents, false);
  assert.equal(store.foreignSubagentControlVisible(), false);
  assert.equal(store.sessionMaySpawnForeignSubagents("host/codex/one"), false);

  // Opening the gate opts new sessions in by default.
  await store.setAllowForeignSubagents(true);
  assert.equal(store.value().experimentalFeatures, true);
  assert.equal(store.value().allowForeignSubagents, true);
  assert.equal(store.foreignSubagentControlVisible(), true);
  assert.equal(store.sessionMaySpawnForeignSubagents("host/codex/one"), true);

  // An explicit per-session opt-out is honoured while the gate is on.
  await store.setSessionForeignSubagents("host/codex/two", false);
  assert.equal(store.sessionMaySpawnForeignSubagents("host/codex/two"), false);
  await store.setSessionForeignSubagents("host/codex/one", true);

  // Closing the gate denies every session but preserves the stored choices.
  await store.setAllowForeignSubagents(false);
  assert.equal(store.value().experimentalFeatures, false);
  assert.equal(store.value().allowForeignSubagents, false);
  assert.equal(store.sessionMaySpawnForeignSubagents("host/codex/one"), false);
  assert.equal(store.sessionMaySpawnForeignSubagents("host/codex/two"), false);
  assert.deepEqual(store.value().foreignSubagentOverrides, { "host/codex/one": false, "host/codex/two": false });

  // The previously-allowed session is flipped in storage, so reopening the
  // gate cannot resurrect it; only never-judged sessions default to allowed.
  await store.setAllowForeignSubagents(true);
  assert.equal(store.value().experimentalFeatures, true);
  assert.equal(store.value().allowForeignSubagents, true);
  assert.equal(store.sessionMaySpawnForeignSubagents("host/codex/one"), false);
  assert.equal(store.sessionMaySpawnForeignSubagents("host/codex/two"), false);
  assert.equal(store.sessionMaySpawnForeignSubagents("host/codex/three"), true);
  // Reopening the gate never rewrites stored values.
  assert.deepEqual(store.value().foreignSubagentOverrides, { "host/codex/one": false, "host/codex/two": false });

  // The record shares the task override bound so it cannot grow without limit.
  for (let index = 0; index < 505; index += 1) await store.setSessionForeignSubagents(`host/codex/${index}`, true);
  assert.equal(Object.keys(store.value().foreignSubagentOverrides).length, 500);
  assert.equal(store.value().foreignSubagentOverrides["host/codex/504"], true);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.keys(persisted.foreignSubagentOverrides).length, 500);
  assert.equal(persisted.experimentalFeatures, true);
  assert.equal(persisted.allowForeignSubagents, true);
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
  assert.equal(organization.isHiddenByArchive(archived, false), true);
  assert.equal(organization.isHiddenByArchive(archived, true), false);
  assert.equal(organization.isHiddenByArchive(organized[0], false), false);
});

test("task provider filters OR explicit agents and AND available agents", () => {
  const available = new Set(["codex", "opencode"]);

  assert.equal(organization.matchesProviderFilters("codex", ["codex", "opencode"], available), true);
  assert.equal(organization.matchesProviderFilters("opencode", ["codex", "opencode"], available), true);
  assert.equal(organization.matchesProviderFilters("direct", ["codex", "opencode"], available), false);

  assert.equal(organization.matchesProviderFilters("codex", ["codex", "available"], available), true);
  assert.equal(organization.matchesProviderFilters("codex", ["codex", "available"], new Set(["opencode"])), false);
  assert.equal(organization.matchesProviderFilters("opencode", ["codex", "available"], available), false);
  assert.equal(organization.matchesProviderFilters("direct", ["available"], available), false);
  assert.equal(organization.matchesProviderFilters("direct", "all", new Set()), true);
});

test("archiving the open task persists and removes its row from the default list", async (t) => {
  const path = join(outputDirectory, `archive-open-${Date.now()}.json`);
  t.after(() => rm(path, { force: true }));
  const store = await preferences.DesktopPreferencesStore.load(path);
  const open = task("open-task", "2026-08-22T12:00:00.000Z", { pinned: true });

  await store.setTaskOverride(open.id, { archived: true, pinned: false });
  const organized = organization.organizeSessions([open], store.value().taskOverrides);
  const defaultRows = organized.filter((session) => !organization.isHiddenByArchive(session, false));

  assert.deepEqual(store.value().taskOverrides[open.id], { archived: true });
  assert.deepEqual(defaultRows, [], "the selected conversation may stay open, but its archived rail row must disappear");
  assert.equal(organization.isHiddenByArchive(organized[0], true), false, "Show archived is the only way to reveal the row");
});

test("an accidentally opened draft task can be archived like any other task", () => {
  const draft = task("draft-new", "2026-08-15T10:00:00.000Z", { draft: true });
  const organized = organization.organizeSessions([draft], { "draft-new": { archived: true } });
  assert.equal(organized[0].archived, true, "a draft must accept an archived override");
  assert.equal(organization.isHiddenByArchive(organized[0], false), true, "an archived draft stays out of the default list even while its conversation is open");
  assert.equal(organization.isHiddenByArchive(organized[0], true), false, "Show archived reveals it");
});


test("startup registration only asks Windows for what the user chose", async () => {
  const index = await readFile(join(appRoot, "src", "main", "index.ts"), "utf8");
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
