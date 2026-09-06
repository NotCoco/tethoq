import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const repositoryRoot = join(appRoot, "..", "..");

const [rendererBridge, app, ipc, router, protocol, refresh] = await Promise.all([
  readFile(join(appRoot, "src", "renderer", "src", "bridge.ts"), "utf8"),
  readFile(join(appRoot, "src", "renderer", "src", "App.tsx"), "utf8"),
  readFile(join(appRoot, "src", "main", "ipc.ts"), "utf8"),
  readFile(join(repositoryRoot, "apps", "agent_bridge", "src", "request_router.ts"), "utf8"),
  readFile(join(repositoryRoot, "packages", "protocol", "src", "models.ts"), "utf8"),
  readFile(join(repositoryRoot, "apps", "agent_bridge", "src", "refresh.ts"), "utf8"),
]);

test("startup paints the cached catalogue before background provider bootstrap while manual refresh remains explicit", () => {
  assert.match(rendererBridge, /loadInitialSnapshot[\s\S]*request\("sessions\.list"\)/u);
  assert.match(app, /setSnapshot\(\{\s*\.\.\.result\.snapshot,\s*loading: false,[\s\S]*?\}\);[\s\S]*request\("sessions\.bootstrap"\)/u);
  assert.match(rendererBridge, /refreshSessions[\s\S]*request\("sessions\.refresh"\)/u);
  assert.match(ipc, /"sessions\.bootstrap"/u);
  assert.match(router, /case "sessions\.bootstrap"[\s\S]*bootstrapSessions/u);
});

test("background catalogue completion has a cheap live renderer update path", () => {
  assert.match(protocol, /"session\.catalog_changed"/u);
  assert.match(refresh, /bootstrapAdapter[\s\S]*notifyBackgroundProviderSettled\(result(?:,\s*token)?\)/u);
  assert.match(app, /catalogueChanged[\s\S]*session\.catalog_changed/u);
  assert.match(app, /catalogueChanged[\s\S]*refreshVisibleState\(false\)/u);
  assert.doesNotMatch(app, /catalogueChanged[\s\S]{0,220}refreshAll\(false\)/u);
});

test("startup paints tasks before models or the selected transcript and replays the event gap", () => {
  assert.doesNotMatch(rendererBridge, /loadInitialSnapshot[\s\S]*await loadProviderModels\(providers\)/u);
  assert.match(rendererBridge, /Model catalogues[\s\S]*models: \{\}/u);
  assert.match(app, /const hydratedDrafts = retainedStartupDraftSessions[\s\S]*setSnapshot\(\{\s*\.\.\.result\.snapshot,\s*loading: false,\s*sessions: \[\.\.\.hydratedDrafts, \.\.\.result\.snapshot\.sessions\.filter[\s\S]*timelines: resolvedStartupDraftTimelines\(result\.snapshot\.timelines, hydratedDrafts\),\s*\}\)/u);
  assert.match(app, /setSnapshot\(\{\s*\.\.\.result\.snapshot,\s*loading: false,[\s\S]*?\}\);[\s\S]*hydrateProviderModels\(result\.snapshot\.providers\)/u);
  assert.match(app, /setSnapshot\(\{\s*\.\.\.result\.snapshot,\s*loading: false,[\s\S]*?\}\);[\s\S]*if \(selectedHydratedSession\) \{[\s\S]*loadTimelinePage\(selectedHydratedSession\.id\)\.then/u);
  assert.match(app, /if \(!snapshot\) return;[\s\S]*subscribeToDesktop/u);
  assert.match(app, /startupReplaySequence[\s\S]*request\("sync\.since"[\s\S]*through >= latest/u);
  assert.match(app, /seenEventSequences[\s\S]*unseenEvents/u);
});
