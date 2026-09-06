import assert from "node:assert/strict";
import test from "node:test";
import { codexVisionIsolationConfig } from "./vision_isolation.js";
import { prepareCodexVisionCatalog } from "./vision_isolation.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Codex EYES disables inherited MCP entries without retaining their secrets", () => {
  const inherited = { mcp_servers: { desktop: { command: "node", env: { TOKEN: "private" } }, "name.with.dots": { url: "https://example.invalid", required: true } } };
  const before = JSON.stringify(inherited);
  const config = codexVisionIsolationConfig(inherited);
  assert.deepEqual(config.mcp_servers, {
    desktop: { enabled: false, required: false },
    "name.with.dots": { enabled: false, required: false },
  });
  assert.equal(JSON.stringify(inherited), before);
  assert.doesNotMatch(JSON.stringify(config), /private|example\.invalid/);
  const features = config.features as Record<string, unknown>;
  for (const key of ["shell_tool", "plugins", "apps", "hooks", "multi_agent", "computer_use", "code_mode", "js_repl"]) assert.equal(features[key], false);
  assert.equal(features.skip_host_skill_discovery, true);
  assert.equal(config.project_doc_max_bytes, 0);
});

test("Codex EYES model profile removes forced coding tools without changing the selected model", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "eyes-catalog-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.json");
  const model = { slug: "exact-vision-model", input_modalities: ["text", "image"], tool_mode: "code_mode_only", apply_patch_tool_type: "freeform", node_repl_disabled: false };
  await writeFile(sourcePath, JSON.stringify({ models: [model] }));
  const profile = await prepareCodexVisionCatalog("must-not-execute", model.slug, { model_catalog_json: sourcePath }, {});
  const generated = JSON.parse(await readFile(profile.path, "utf8"));
  assert.equal(generated.models[0].slug, model.slug);
  assert.deepEqual(generated.models[0].input_modalities, ["text", "image"]);
  assert.equal(generated.models[0].tool_mode, null);
  assert.equal(generated.models[0].apply_patch_tool_type, null);
  assert.equal(generated.models[0].node_repl_disabled, true);
  assert.deepEqual(JSON.parse(await readFile(sourcePath, "utf8")), { models: [model] });
  await profile.dispose();
  await assert.rejects(readFile(profile.path), { code: "ENOENT" });
  await assert.rejects(prepareCodexVisionCatalog("must-not-execute", "missing-model", { model_catalog_json: sourcePath }, {}), /no metadata/);
});
