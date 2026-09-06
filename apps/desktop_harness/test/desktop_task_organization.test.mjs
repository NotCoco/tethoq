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

test("project mode keeps filtered groups in the normal task-list surface", async () => {
  const [navigation, app] = await Promise.all([
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "App.tsx")),
  ]);
  assert.match(navigation, /taskListMode === "project" \? <>\{visibleProjectGroups\.map/);
  assert.match(navigation, /visibleProjectSessions\(group\.sessions, selected, expanded\)/);
  assert.match(navigation, /visibleSessions\.map\(\(session\) => renderSession\(session, true\)\)/);
  assert.match(navigation, /className="session-project-show-more"/);
  assert.match(navigation, />Show more<\/button>/);
  assert.match(navigation, /<SessionRow compact=\{compact\} session=\{session\}/);
  assert.match(navigation, /session-project-working-spinner/);
  assert.match(navigation, /sessions\.map\(\(session\) => renderSession\(session\)\)/, "recency mode keeps the rich row path");
  assert.match(navigation, /const projectLabel = projectDirectoryName\(location, session\.project\)/);
  assert.match(navigation, /<FolderIcon \/>\{projectLabel\}/);
  const filterBody = app.match(/const filteredSessions = useMemo\(\(\) => \{[\s\S]*?\}, \[query/u)?.[0] ?? "";
  assert.match(filterBody, /session\.title\} \$\{session\.project\} \$\{session\.preview\}/);
  assert.doesNotMatch(filterBody, /workingDirectory/u);
});

test("project headings omit session totals and Show more stays a text-only disclosure", async () => {
  const [navigation, css] = await Promise.all([
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "navigation.css")),
  ]);
  assert.doesNotMatch(navigation, /<b>\{group\.sessions\.length\}<\/b>/u, "folder headings must not expose a redundant session total");

  const headerRule = css.match(/\.session-project-header \{[^}]*\}/u)?.[0] ?? "";
  assert.match(headerRule, /grid-template-columns:\s*19px\s+minmax\(0,\s*1fr\)\s+15px;/u, "the folder row reserves only icon, label, and disclosure lanes");
  assert.doesNotMatch(css, /\.session-project-header b \{/u, "removed count chrome must not leave a dead style behind");

  const restingRule = css.match(/\.session-project-show-more \{[^}]*\}/u)?.[0] ?? "";
  const interactiveRule = css.match(/\.session-project-show-more:hover, \.session-project-show-more:focus-visible \{[^}]*\}/u)?.[0] ?? "";
  const focusRule = [...css.matchAll(/\.session-project-show-more:focus-visible \{[^}]*\}/gu)].at(-1)?.[0] ?? "";
  assert.match(restingRule, /width:\s*fit-content;/u);
  assert.match(restingRule, /border:\s*0;/u);
  assert.match(restingRule, /border-radius:\s*0;/u);
  assert.match(restingRule, /background:\s*transparent;/u);
  assert.match(interactiveRule, /color:\s*#e0e3df;/u, "hover and focus brighten the text itself");
  assert.match(interactiveRule, /background:\s*transparent;/u, "a shallow disclosure never gains a button fill");
  assert.match(focusRule, /outline:\s*0;/u);
  assert.match(focusRule, /text-decoration:\s*underline;/u, "keyboard focus remains visible without a container");
});

test("maintained harnesses use the agreed Tethoq-owned monogram family", async () => {
  const [componentSource, styles, mobileTheme] = await Promise.all([
    source(join("src", "renderer", "src", "components.tsx")),
    source(join("src", "renderer", "src", "styles.css")),
    readFile(join(appRoot, "..", "remote_client", "lib", "src", "app_theme.dart"), "utf8"),
  ]);
  const monogramBlock = componentSource.match(/const TETHOQ_HARNESS_MONOGRAMS:[^=]+ = \{([\s\S]*?)\n\};/u)?.[1] ?? "";
  const monograms = Object.fromEntries(
    [...monogramBlock.matchAll(/^\s+([a-z]+): "([^"]+)",$/gmu)].map((match) => [match[1], match[2]]),
  );
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
  assert.deepEqual(monograms, expected);
  const mobileBlock = mobileTheme.match(/const _tethoqHarnessMonograms = <String, String>\{([\s\S]*?)\n\};/u)?.[1] ?? "";
  const mobileMonograms = Object.fromEntries(
    [...mobileBlock.matchAll(/^\s+'([a-z]+)': '([^']+)',$/gmu)].map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(mobileMonograms, expected, "desktop and mobile must expose the same harness marks");
  for (const [providerId, monogram] of Object.entries(expected)) {
    const rendered = components.ProviderLogo({ providerId, size: 24 });
    assert.equal(rendered.props.children.props.children, monogram, `${providerId} renders its Tethoq monogram`);
    assert.equal(rendered.props.children.type, "span");
  }
  assert.match(componentSource, /Recognition comes from the truthful harness name,[\s\S]*?not copied provider geometry/u);
  assert.match(componentSource, /TETHOQ_HARNESS_ALIASES/u, "known connector aliases resolve to the same monogram");
  assert.match(componentSource, /providerInitials\(name\)/u, "unknown connectors receive neutral generated initials");
  assert.doesNotMatch(componentSource, /function ProviderGlyph/u, "the former custom pictogram renderer is gone");
  assert.match(styles, /data-monogram-length="3"/, "longer abbreviations receive a restrained optical correction");
  assert.match(styles, /\.provider-logo \{[^}]*font-weight:\s*700/u);
  for (const providerId of Object.keys(expected)) {
    assert.match(styles, new RegExp(`\\.provider-logo\\[data-provider-id="${providerId}"\\] \\{ color: #[0-9a-f]{6}; \\}`, "u"));
  }
});

test("rich recency rows use a compact dynamically centred generic sub-agent summary", async () => {
  const [navigation, css, icons] = await Promise.all([
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "navigation.css")),
    source(join("src", "renderer", "src", "icons.tsx")),
  ]);
  const providerRule = css.match(/\.session-row-top \.provider-logo \{[^}]*\}/u)?.[0] ?? "";
  const subagentRule = css.match(/\.session-subagents:not\(\.compact\) \{[^}]*\}/u)?.[0] ?? "";
  const triggerRule = css.match(/\.session-subagents:not\(\.compact\) \.session-subagents-trigger \{[^}]*\}/u)?.[0] ?? "";
  const summaryRule = css.match(/\.session-subagents:not\(\.compact\) \.session-subagents-summary \{[^}]*\}/u)?.[0] ?? "";
  const iconRule = css.match(/\.session-subagents:not\(\.compact\) \.session-subagents-icon \{[^}]*\}/u)?.[0] ?? "";
  const countRule = css.match(/\.session-subagents:not\(\.compact\) \.session-subagents-count \{[^}]*\}/u)?.[0] ?? "";
  const rowRule = css.match(/\.session-row \{[^}]*\}/u)?.[0] ?? "";
  const titleRule = css.match(/\.session-row-title \{[^}]*\}/u)?.[0] ?? "";
  const titleReserveRule = css.match(/\.session-row-shell:has\(\.session-subagents:not\(\.compact\)\) \.session-row-title \{[^}]*\}/u)?.[0] ?? "";
  const spinnerRule = css.match(/\.session-row-working-indicator \{[^}]*\}/u)?.[0] ?? "";
  const timeRule = css.match(/\.session-row-top time \{[^}]*\}/u)?.[0] ?? "";
  const chevronRule = css.match(/\.session-subagents:not\(\.compact\) \.session-subagents-chevron \{[^}]*\}/u)?.[0] ?? "";

  assert.match(providerRule, /transform:\s*translate\(-5px,\s*-17px\);/u, "the rich-card provider ink aligns with the title top");
  assert.match(rowRule, /height:\s*74px;\s*min-height:\s*74px;/u, "sub-agent rows must not become taller than ordinary rich rows");
  assert.match(rowRule, /grid-template-columns:\s*36px\s+minmax\(0,\s*1fr\)\s+32px;/u, "the existing 32px age lane remains reserved");
  assert.match(titleRule, /margin-right:\s*-8px;/u, "ordinary recency titles use the empty grid gap while preserving a four-character age");
  assert.match(subagentRule, /top:\s*auto;\s*right:\s*auto;\s*bottom:\s*4px;\s*left:\s*0;/u, "the rich sub-agent control uses the open lower-left corner without touching the row edge");
  assert.match(triggerRule, /width:\s*38px;\s*height:\s*25px;/u, "the fixed rich trigger gains three pixels above without widening into the title lane");
  assert.match(triggerRule, /grid-template-columns:\s*minmax\(0,\s*1fr\);\s*grid-template-rows:\s*13px\s+7px;/u, "the summary and disclosure use compact stacked lanes");
  assert.match(triggerRule, /column-gap:\s*0;\s*row-gap:\s*0;\s*padding:\s*4px\s+1px\s+1px;/u, "the extra height is reserved above the existing content position");
  assert.match(summaryRule, /display:\s*inline-flex;/u);
  assert.match(summaryRule, /align-items:\s*flex-end;/u, "the smaller count shares the generic icon's bottom edge");
  assert.match(summaryRule, /grid-column:\s*1;\s*grid-row:\s*1;/u, "the variable-width summary stays in the raised first row");
  assert.match(summaryRule, /justify-self:\s*center;/u, "one-, two-, and three-digit summaries centre as a group in the fixed 36px content lane");
  assert.match(summaryRule, /max-width:\s*100%;/u, "the dynamically growing summary stays inside its fixed trigger");
  assert.match(summaryRule, /gap:\s*2px;/u);
  assert.match(iconRule, /width:\s*13px;\s*height:\s*13px;/u, "the two-person mark remains readable in the compact control");
  assert.match(countRule, /width:\s*auto;\s*min-width:\s*0;/u, "the count grows naturally instead of reserving an off-centre digit lane");
  assert.match(countRule, /font-size:\s*11\.5px;/u, "the rich count moves down one type step relative to the silhouettes");
  assert.match(countRule, /font-weight:\s*650;/u);
  assert.match(countRule, /text-align:\s*center;/u);
  assert.match(countRule, /translate:\s*0\s+-1px;/u, "the smaller numeral receives the measured one-pixel painted-bottom correction");
  assert.match(chevronRule, /width:\s*8px;\s*height:\s*8px;/u);
  assert.match(chevronRule, /grid-column:\s*1;\s*grid-row:\s*2;/u, "the disclosure sits underneath the centred summary");
  assert.match(chevronRule, /align-self:\s*center;/u);
  assert.match(chevronRule, /justify-self:\s*center;/u);
  assert.match(chevronRule, /opacity:\s*\.38;/u, "the lower disclosure remains subtle but visible at rest");
  assert.match(chevronRule, /stroke-width:\s*2\.4;/u, "the small lower disclosure keeps a readable stroke");
  assert.match(chevronRule, /translate:\s*-1px\s+0;/u, "the lower disclosure receives the requested one-pixel optical correction");
  assert.match(css, /\.session-subagents:not\(\.compact\) \.session-subagents-trigger:hover > \.session-subagents-chevron,\s*\.session-subagents:not\(\.compact\) \.session-subagents-trigger:focus-visible > \.session-subagents-chevron,\s*\.session-subagents:not\(\.compact\)\.open \.session-subagents-chevron \{ opacity:\s*1; \}/u, "hover, keyboard focus, and the open state fully reveal the disclosure");
  assert.match(navigation, /<span className="session-subagents-summary"><SubagentsIcon className="session-subagents-icon"\/><span className="session-subagents-count" data-count-capped=\{compactCountCapped \|\| undefined\}>\{visibleChildCount\}<\/span><\/span>/u, "every parent row uses one generic sub-agent concept instead of repeating a child provider");
  assert.match(icons, /export const SubagentsIcon[\s\S]*?className="subagents-icon-back"[\s\S]*?opacity="\.46"[\s\S]*?className="subagents-icon-front"/u, "the generic mark uses overlapping silhouettes with distinct shading");
  assert.doesNotMatch(css, /\.session-subagents:not\(\.compact\) \.provider-monogram/u, "rich trigger geometry must not depend on one-, two-, or three-letter harness marks");
  assert.equal(titleReserveRule, "", "a lower-left control must not steal title width");
  assert.match(timeRule, /transform:\s*none;/u, "the age is no longer pushed below the title line");
  assert.match(spinnerRule, /position:\s*absolute;[^}]*right:\s*5px;\s*bottom:\s*5px;/u, "the rich working spinner occupies the balanced lower-right corner");
  assert.match(spinnerRule, /translate:\s*0\s+0;/u, "the corner spinner has no centring offset left over");
  assert.doesNotMatch(countRule, /scaleX/u, "the count must not be visually squeezed");
});

test("compact project rows keep a one-line cadence, a centred generic sub-agent control, and the spinner rightmost", async () => {
  const [navigation, css, sharedCss, bridge, visualQa] = await Promise.all([
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "navigation.css")),
    source(join("src", "renderer", "src", "styles.css")),
    source(join("src", "renderer", "src", "bridge.ts")),
    source(join("scripts", "visual-qa.cjs")),
  ]);
  const idleRowRule = css.match(/^\.session-row\.compact \{[^}]*\}/mu)?.[0] ?? "";
  const workingRowRule = css.match(/\.session-project-items \.session-row-shell:has\(\.session-project-working-indicator\),\s*\.session-project-items \.session-row-shell:has\(\.session-project-schedule-indicator\) \{[^}]*\}/u)?.[0] ?? "";
  const workingIndicatorRule = css.match(/\.session-project-working-indicator \{[^}]*\}/u)?.[0] ?? "";
  const projectGroupSpacingRule = css.match(/\.session-project-items \.session-row-group \+ \.session-row-group \{[^}]*\}/u)?.[0] ?? "";
  const projectShellRule = css.match(/\.session-project-items \.session-row-shell \{[^}]*\}/u)?.[0] ?? "";
  const ordinaryProjectRowRule = css.match(/\.session-project-items \.session-row-shell > \.session-row\.compact \{[^}]*\}/u)?.[0] ?? "";
  const compactShellRule = css.match(/\.session-row-shell:has\(\.session-subagents\.compact\) \{[^}]*\}/u)?.[0] ?? "";
  const selectedShellRule = css.match(/\.session-project-items \.session-row-shell:has\(> \.session-row\.compact\.selected\) \{[^}]*\}/u)?.[0] ?? "";
  const selectedRowRule = css.match(/\.session-project-items \.session-row-shell > \.session-row\.compact\.selected \{[^}]*\}/u)?.[0] ?? "";
  const hoverShellRule = css.match(/\.session-project-items \.session-row-shell:has\(> \.session-row\.compact:hover\),\s*\.session-project-items \.session-row-shell:has\(> \.session-row\.compact:focus-visible\) \{[^}]*\}/u)?.[0] ?? "";
  const hoverRowRule = css.match(/\.session-project-items \.session-row-shell > \.session-row\.compact:hover,\s*\.session-project-items \.session-row-shell > \.session-row\.compact:focus-visible \{[^}]*\}/u)?.[0] ?? "";
  const compactSubagentRule = css.match(/\.session-subagents\.compact \{[^}]*\}/u)?.[0] ?? "";
  const compactSubagentTriggerRule = css.match(/\.session-subagents\.compact \.session-subagents-trigger \{[^}]*\}/u)?.[0] ?? "";
  const compactSubagentSummaryRule = css.match(/\.session-subagents\.compact \.session-subagents-summary \{[^}]*\}/u)?.[0] ?? "";
  const compactSubagentIconRule = css.match(/\.session-subagents\.compact \.session-subagents-icon \{[^}]*\}/u)?.[0] ?? "";
  const compactSubagentCountRule = css.match(/\.session-subagents\.compact \.session-subagents-count \{[^}]*\}/u)?.[0] ?? "";
  const compactSubagentCappedCountRule = css.match(/\.session-subagents\.compact \.session-subagents-count\[data-count-capped="true"\] \{[^}]*\}/u)?.[0] ?? "";
  const compactSubagentChevronRule = css.match(/\.session-subagents\.compact \.session-subagents-chevron \{[^}]*\}/u)?.[0] ?? "";
  const showMoreRule = css.match(/\.session-project-show-more \{[^}]*\}/u)?.[0] ?? "";
  const subagentCountRule = sharedCss.match(/\.session-subagents-count \{[^}]*\}/u)?.[0] ?? "";
  const horizontalFadeRule = css.match(/\.overflow-reveal-horizontal\[data-overflow="true"\] \{[^}]*\}/u)?.[0] ?? "";

  assert.match(idleRowRule, /height:\s*31px;\s*min-height:\s*31px;/u, "every project task paints as one 31px line instead of inheriting the 74px recency-card height");
  assert.match(idleRowRule, /grid-template-columns:\s*subgrid;/u, "the task and sibling sub-agent button share the actual content width");
  assert.match(idleRowRule, /padding:\s*3px\s+7px\s+3px\s+1px;/u, "ordinary project titles use the same glyph lane as rows with sub-agents");
  assert.doesNotMatch(idleRowRule, /grid-template-columns:[^;]*\s16px/u, "idle rows must not reserve an empty spinner column");
  assert.match(workingRowRule, /grid-template-columns:\s*32px\s+minmax\(0,\s*1fr\)\s+28px;/u, "the visible working indicator alone contracts the title lane");
  assert.match(workingIndicatorRule, /grid-column:\s*3;/u, "every working spinner occupies the explicit final column");
  assert.match(workingIndicatorRule, /justify-self:\s*end;/u, "every working spinner stays on the row's right edge");
  assert.match(workingIndicatorRule, /translate:\s*0\s+2px;/u, "the project-row spinner keeps the measured one-pixel downward optical correction");

  assert.match(projectGroupSpacingRule, /margin-top:\s*0;/u, "adjacent project tasks keep one uninterrupted cadence");
  assert.doesNotMatch(projectGroupSpacingRule, /display:\s*grid|grid-template-columns|width:\s*calc|margin-left/u, "task groups must not inherit the nested shell grid");
  assert.match(projectShellRule, /width:\s*calc\(100% \+ 24px\);/u, "every project shell reserves the same full-width selected-paint lane");
  assert.match(projectShellRule, /grid-template-columns:\s*32px\s+minmax\(0,\s*1fr\);/u, "every project shell retains the invariant title gutter");
  assert.match(projectShellRule, /margin-left:\s*-24px;/u, "the full-width shell starts at the project nesting gutter");
  assert.match(ordinaryProjectRowRule, /grid-column:\s*1\s*\/\s*-1;/u, "an ordinary task button owns the complete shell clickbox");
  assert.match(compactShellRule, /grid-template-columns:\s*32px\s+max-content\s+minmax\(0,\s*1fr\);/u, "the harness precedes the sub-agent control");
  assert.match(selectedShellRule, /border-radius:\s*6px;/u);
  assert.match(selectedShellRule, /background:\s*#292927;/u, "selection paints one uninterrupted row behind the sub-agent control and title");
  assert.match(selectedRowRule, /background:\s*transparent;/u, "the inner title button does not split the selected surface");
  assert.match(hoverShellRule, /border-radius:\s*6px;/u);
  assert.match(hoverShellRule, /background:\s*#191918;/u, "hover and keyboard focus paint the complete project shell");
  assert.match(hoverRowRule, /background:\s*transparent;/u, "hover no longer paints only the nested task button");
  assert.match(compactSubagentRule, /position:\s*relative;/u);
  assert.match(compactSubagentRule, /grid-column:\s*2;/u);
  assert.match(compactSubagentRule, /right:\s*auto;/u);
  assert.match(compactSubagentRule, /bottom:\s*auto;/u);
  assert.match(compactSubagentTriggerRule, /position:\s*relative;/u);
  assert.match(compactSubagentTriggerRule, /width:\s*max-content;\s*min-width:\s*28px;\s*height:\s*22px;/u, "the compact trigger grows with its count inside the one-line project row");
  assert.match(compactSubagentTriggerRule, /grid-template-columns:\s*max-content;\s*grid-template-rows:\s*1fr;/u, "the compact summary uses the full trigger height after its redundant chevron is removed");
  assert.match(compactSubagentTriggerRule, /column-gap:\s*0;\s*row-gap:\s*0;\s*padding:\s*1px\s+4px;/u);
  assert.match(compactSubagentSummaryRule, /display:\s*inline-flex;/u);
  assert.match(compactSubagentSummaryRule, /align-items:\s*center;/u);
  assert.match(compactSubagentSummaryRule, /justify-self:\s*center;/u, "the icon and variable-width count dynamically centre as one group");
  assert.match(compactSubagentSummaryRule, /gap:\s*2px;/u);
  assert.match(compactSubagentSummaryRule, /translate:\s*0\s+1px;/u, "the icon and count share the task-title glyph baseline");
  assert.match(compactSubagentIconRule, /width:\s*13px;\s*height:\s*13px;/u, "the generic two-person mark remains readable");
  assert.match(compactSubagentIconRule, /translate:\s*0\s+1px;/u, "the generic icon receives its own one-pixel painted-ink correction without moving the count");
  assert.match(compactSubagentCountRule, /width:\s*auto;\s*min-width:\s*0;/u, "one-, two-, and three-digit counts grow naturally inside the centred summary");
  assert.match(compactSubagentCountRule, /font-size:\s*12px;/u);
  assert.match(compactSubagentCountRule, /font-weight:\s*650;/u);
  assert.match(compactSubagentCountRule, /text-align:\s*center;/u);
  assert.match(compactSubagentCountRule, /translate:\s*0\s+0;/u);
  assert.match(compactSubagentCappedCountRule, /font-size:\s*11px;/u, "the 1k+ cap must remain readable");
  assert.match(compactSubagentCappedCountRule, /letter-spacing:\s*-\.2px;/u);
  assert.equal(compactSubagentChevronRule, "", "project sub-agent buttons no longer reserve or paint a chevron");
  assert.match(navigation, /\{!compact \? <ChevronDownIcon className="session-subagents-chevron" \/> : null\}/u, "only the richer recency control retains a visible chevron");
  assert.doesNotMatch(css, /\.session-subagents\.compact[^\n{]*\.session-subagents-chevron/u, "retired compact chevron styling must not return");
  assert.match(navigation, /<span className="session-subagents-summary"><SubagentsIcon className="session-subagents-icon"\/><span className="session-subagents-count" data-count-capped=\{compactCountCapped \|\| undefined\}>\{visibleChildCount\}<\/span><\/span>/u, "compact and rich parent rows use the same generic sub-agent concept");
  assert.doesNotMatch(navigation, /compact\s*\?\s*<><ProviderLogo|providerId = session\.childProviderIds/u, "the compact trigger no longer repeats an arbitrary child-provider monogram");
  assert.doesNotMatch(css, /\.session-subagents\.compact \.provider-(?:logo|monogram)/u, "retired provider-specific compact geometry must not remain in CSS");
  assert.match(navigation, /const compactCountCapped = compact && displayedChildCount >= 1_000;/u);
  assert.match(navigation, /const visibleChildCount = compactCountCapped \? "1k\+" : displayedChildCount;/u);
  assert.match(navigation, /data-count-capped=\{compactCountCapped \|\| undefined\}>\{visibleChildCount\}/u, "four-digit compact counts cap without changing the exact accessible label");
  assert.match(navigation, /aria-label=\{countLabel\}/u, "the exact sub-agent count remains available to assistive technology");
  assert.match(navigation, /data-tooltip=\{open \? undefined : countLabel\}/u, "singular, plural, and capped sub-agent counts use the shared tooltip text without duplicating the portal");
  assert.match(subagentCountRule, /font-variant-numeric:\s*tabular-nums;/u);
  assert.match(subagentCountRule, /white-space:\s*nowrap;/u);
  assert.match(showMoreRule, /margin-left:\s*11px;/u, "Show more aligns to the invariant project task-title glyph lane");
  assert.match(showMoreRule, /padding:\s*3px\s+7px;/u, "Show more shares the ordinary compact row's seven-pixel text inset");
  assert.match(bridge, /new URLSearchParams\(location\.search\)\.get\("qaSubagentCount"\)/u, "the browser-only count fixture must enter through React state");
  assert.match(bridge, /location\.hash !== "#subagents-hover" && location\.hash !== "#subagents-hover-project"/u, "the QA override must remain scoped to off-screen sub-agent previews");
  assert.match(bridge, /projectCohort && projectSource && index < 5[\s\S]*?workingDirectory: projectSource\.workingDirectory/u, "project-row QA must include adjacent tasks with one real folder identity");
  assert.match(visualQa, /qaSubagentCount: 1[\s\S]*qaSubagentCount: 12[\s\S]*qaSubagentCount: 130[\s\S]*qaSubagentCount: 1_000/u, "visual QA must render fresh one-, two-, three-, and capped-count fixtures");
  assert.doesNotMatch(visualQa, /count\.textContent = '12'|visualCount\.textContent/u, "visual QA must not mutate rendered count text behind React");

  assert.equal(horizontalFadeRule.match(/calc\(100% - 6px\)/gu)?.length, 2, "both mask declarations use the short six-pixel terminal fade");
  assert.doesNotMatch(horizontalFadeRule, /13px/u, "the old aggressive thirteen-pixel fade must not return");
  assert.match(navigation, /data-overflow=\{distance > 0 \|\| undefined\}/u, "even one real clipped pixel must activate the title fade");
  assert.doesNotMatch(navigation, /data-overflow=\{distance > 1 \|\| undefined\}/u, "one-pixel overflow must not be mistaken for a fitting title");
});

test("each real project folder reveals a direct new-task action", async () => {
  const [navigation, app, navigationCss, styles, icons] = await Promise.all([
    source(join("src", "renderer", "src", "NavigationPanels.tsx")),
    source(join("src", "renderer", "src", "App.tsx")),
    source(join("src", "renderer", "src", "navigation.css")),
    source(join("src", "renderer", "src", "styles.css")),
    source(join("src", "renderer", "src", "icons.tsx")),
  ]);

  assert.match(navigation, /onNewTaskInProject: \(workingDirectory: string\) => void/);
  assert.match(navigation, /group\.directory \? <ProjectNewTaskButton directory=\{group\.directory\} name=\{group\.name\} onNewTask=\{onNewTaskInProject\}/);
  assert.match(navigation, /createPortal\(<span ref=\{tooltip\} id=\{tooltipId\} className="session-project-new-task-tooltip" role="tooltip"/);
  assert.match(navigation, /onClick=\{\(\) => \{ hideTooltip\(\); onNewTask\(directory\); \}\}/);
  assert.doesNotMatch(navigation, /className="session-project-new-task"[^>]*data-tooltip=/, "the project tooltip must not remain inside the clipped scrolling container");
  assert.match(app, /onNewTaskInProject=\{startDraftTask\}/, "the row action must reuse the ordinary draft-task callback with the folder override");
  assert.match(navigation, /taskListMode === "project" \? <FolderPlusIcon className="folder-plus-icon" \/> : <PlusIcon \/>/u, "the choose-or-create project action must visibly combine folder and plus concepts");
  assert.match(icons, /export const FolderPlusIcon[\s\S]*M18 2\.5v7M14\.5 6h7/u, "the project-creation glyph must include a distinct top-right plus");
  assert.match(navigationCss, /\.sidebar-task-header > button \.folder-plus-icon \{[^}]*width:\s*19px;[^}]*height:\s*19px/su, "the folder-plus glyph must remain readable in the task-list toolbar");

  assert.match(navigationCss, /\.session-project-heading \{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+35px/su, "the project heading reserves a square control lane matching its 35px collapse row");
  assert.match(navigationCss, /\.session-project-heading \{[^}]*width:\s*100%;[^}]*margin:\s*0\s+0\s+2px;/su, "the folder heading and square plus use the full session-row width before the scrollbar");
  assert.match(navigationCss, /\.session-project-new-task \{[^}]*width:\s*35px;[^}]*height:\s*35px;[^}]*place-items:\s*center/su, "the project plus uses a centred square hit target matching the adjacent collapse row height");
  assert.match(navigationCss, /\.session-project-header > svg:last-child \{[^}]*opacity:\s*0;[^}]*transition:\s*opacity\s+\.1s\s+ease,\s*transform\s+\.12s\s+ease/su, "folder disclosure orientation stays hidden without moving its reserved lane");
  assert.match(navigationCss, /\.session-project-heading:hover \.session-project-header > svg:last-child,\s*\.session-project-heading:focus-within \.session-project-header > svg:last-child \{ opacity:\s*1; \}/u, "folder disclosure appears only through pointer or keyboard intent");
  assert.match(navigationCss, /\.session-project-new-task:hover, \.session-project-new-task:focus-visible \{[^}]*background:\s*#252522/su, "the full square target remains visible on hover and keyboard focus");
  assert.match(navigationCss, /\.session-project-new-task \{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/su);
  assert.match(navigationCss, /\.session-project-heading:hover \.session-project-new-task,[\s\S]*\.session-project-heading:focus-within \.session-project-new-task \{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/su);
  assert.match(styles, /\.session-project-new-task-tooltip \{[^}]*position:\s*fixed[^}]*max-width:\s*min\(220px, calc\(100vw - 16px\)\)/su);
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
  // An accidentally opened draft is ordinary work too: the Archive action must
  // not be disabled for it, unlike rename and pin which drafts do not support.
  assert.match(navigation, /disabled=\{!menuSession\}[\s\S]{0,400}<ArchiveIcon \/>/u);
  assert.match(navigation, /disabled=\{!menuSession \|\| menuSession\.draft === true\}[\s\S]{0,400}<RenameIcon \/>/u);

  const css = await source(join("src", "renderer", "src", "navigation.css"));
  // Pin and time share the one reserved trailing cell so a pinned row never shifts.
  assert.match(css, /\.session-row-trailing > \* \{ grid-area: 1 \/ 1; \}/);
  assert.match(css, /\.session-row\.archived \{ opacity: \.5; \}/);
});
