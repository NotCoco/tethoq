import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(tmpdir(), `tethoq-mesh-mentions-${process.pid}-${Date.now()}`);
await mkdir(output, { recursive: true });
await build({
  stdin: {
    resolveDir: appRoot,
    contents: 'export { meshMentionAtCaret } from "./src/renderer/src/mesh_composer"; export { recentMeshModels, persistMeshRecentTargetsForSession, meshRecentTargetsForSession, matchingRecentMeshModels } from "./src/renderer/src/Composer";',
  },
  outfile: join(output, "helpers.mjs"), bundle: true, format: "esm", platform: "node", target: "node22",
  plugins: [{ name: "worker-stub", setup(context) {
    context.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, namespace: "worker-stub" }));
    context.onLoad({ filter: /.*/, namespace: "worker-stub" }, () => ({ contents: "export default class {}", loader: "js" }));
  } }],
});
globalThis.window = { location: { hash: "" }, addEventListener() {}, removeEventListener() {} };
globalThis.location = window.location;
const { meshMentionAtCaret, recentMeshModels, persistMeshRecentTargetsForSession, meshRecentTargetsForSession, matchingRecentMeshModels } = await import(pathToFileURL(join(output, "helpers.mjs")).href);
test.after(async () => { await rm(output, { recursive: true, force: true }); });

test("mentions follow the caret, preserve suffix boundaries, and ignore email and URL text", () => {
  assert.deepEqual(meshMentionAtCaret("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(meshMentionAtCaret("Compare @grok carefully", 10), { start: 8, end: 13, query: "g" });
  assert.deepEqual(meshMentionAtCaret("\uE000@g", 3), { start: 1, end: 3, query: "g" });
  assert.deepEqual(meshMentionAtCaret("@old\n@GL", 8), { start: 5, end: 8, query: "GL" });
  for (const prose of ["someone@grok.com", "https://example.com/@grok", "package/@g", "@@g", "@g ", "@g,"]) {
    assert.equal(meshMentionAtCaret(prose, prose.length), null, prose);
  }
  assert.equal(meshMentionAtCaret("@g", -1), null, "a range selection is not a mention");
  assert.equal(meshMentionAtCaret("@g", 0), null);
});

test("five mesh models survive repeated sends in one task and deduplicate reasoning variants", () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  assert.deepEqual(recentMeshModels(), []);
  for (let index = 0; index < 6; index += 1) {
    persistMeshRecentTargetsForSession("same-task", [{ providerId: "opencode", modelId: `model-${index}`, reasoningEffort: "high", composerToken: "\uE000", offset: 7 }], index);
  }
  assert.deepEqual(recentMeshModels().map((target) => target.modelId), ["model-5", "model-4", "model-3", "model-2", "model-1"]);
  persistMeshRecentTargetsForSession("other-task", [{ providerId: "opencode", modelId: "model-2", reasoningEffort: "max" }], 10);
  assert.deepEqual(recentMeshModels().map((target) => target.modelId), ["model-2", "model-5", "model-4", "model-3", "model-1"]);
  assert.equal(recentMeshModels()[0].reasoningEffort, "max");
  assert.ok(recentMeshModels().every((target) => target.offset === undefined && target.composerToken === undefined));
  assert.equal(meshRecentTargetsForSession("same-task")[0].modelId, "model-5", "per-parent defaults are retained");
  persistMeshRecentTargetsForSession("another-route", [{ providerId: "direct", modelId: "model-2" }], 11);
  assert.equal(recentMeshModels()[1].providerId, "opencode", "routing is retained when two harnesses expose the same model");
});

test("existing accepted mesh history migrates and malformed or unavailable storage is safe", () => {
  const oldKey = "tethoq:mesh-recent-targets:v1";
  const newKey = "tethoq:mesh-recent-models:v1";
  const storage = new Map([[oldKey, JSON.stringify({
    old: { updatedAt: 1, targets: [{ providerId: "grok", modelId: "grok-4", reasoningEffort: "low" }] },
    newer: { updatedAt: 2, targets: [null, { providerId: "grok" }, { providerId: "grok", modelId: "grok-4", reasoningEffort: "high" }, { providerId: "codex", modelId: "gpt-5" }] },
    malformed: { updatedAt: "yesterday", targets: [] },
  })]]);
  globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  assert.deepEqual(recentMeshModels(), [{ providerId: "grok", modelId: "grok-4", reasoningEffort: "high" }, { providerId: "codex", modelId: "gpt-5" }]);
  storage.set(newKey, "{broken");
  assert.equal(recentMeshModels().length, 2);
  storage.set(newKey, '[null, 42, {"providerId":"grok"}]');
  assert.deepEqual(recentMeshModels(), []);
  globalThis.localStorage = { getItem() { throw new Error("Restricted"); }, setItem() { throw new Error("Restricted"); } };
  assert.deepEqual(recentMeshModels(), []);
  assert.doesNotThrow(() => persistMeshRecentTargetsForSession("task", [{ providerId: "grok", modelId: "grok-4" }]));
});

test("model prefixes narrow only the five recent models and retain exact routes", () => {
  const recent = ["xai/grok-4-fast", "glm-5", "gpt-5", "claude-4", "deepseek", "grok-older"].map((modelId) => ({ providerId: "opencode", modelId, reasoningEffort: "high" }));
  const snapshot = {
    providers: [{ id: "opencode", state: "online", capabilities: ["Create Session", "Send Message"] }],
    models: { opencode: recent.map((target, index) => ({ id: target.modelId, name: ["xAI: Grok 4 Fast", "GLM 5", "GPT-5", "Claude 4", "DeepSeek", "Grok Older"][index] })) },
  };
  assert.equal(matchingRecentMeshModels(snapshot, recent, "").length, 5);
  assert.deepEqual(matchingRecentMeshModels(snapshot, recent, "G").map((target) => target.modelId), ["xai/grok-4-fast", "glm-5", "gpt-5"]);
  assert.deepEqual(matchingRecentMeshModels(snapshot, recent, "gro"), [recent[0]]);
  assert.deepEqual(matchingRecentMeshModels(snapshot, recent, "grok-o"), [], "filtering cannot reach beyond the recent five");
  assert.deepEqual(matchingRecentMeshModels(snapshot, recent, "OpenCode"), [], "harness names are not model prefixes");
  snapshot.providers[0].state = "offline";
  assert.deepEqual(matchingRecentMeshModels(snapshot, recent, ""), []);
  snapshot.providers[0].state = "online";
  snapshot.models.opencode = snapshot.models.opencode.slice(1);
  assert.deepEqual(matchingRecentMeshModels(snapshot, recent, "gro"), [], "removed models are not silently replaced with defaults");
});
