import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "tethoq-setup-test-"));
test.after(() => rm(temporary, { recursive: true, force: true }));
async function bundled(name, relative) {
  const outfile = join(temporary, `${name}.mjs`);
  await build({ entryPoints: [join(appRoot, relative)], outfile, bundle: true, platform: "node", format: "esm", target: "node22" });
  return import(pathToFileURL(outfile).href);
}
const { HARNESS_GUIDES, harnessSetupPrompt } = await bundled("guides", "src/shared/harness_setup.ts");
const { DESKTOP_PROVIDERS } = await bundled("api", "src/shared/desktop_api.ts");
const { installProviderToolHelpers } = await bundled("setup", "src/main/provider_tool_setup.ts");
const { PUBLIC_ACP_PROVIDER_PRESETS } = await bundled("acp", "../../packages/provider_grok/src/grok_adapter.ts");
const { piHarnessPresets } = await bundled("pi", "../../packages/provider_pi/src/pi_rpc_adapter.ts");
const { hardenSession } = await bundled("security", "src/main/security.ts");

test("development authorizes only its nonce preamble and production retains the strict script policy", () => {
  const originalUrl = process.env.ELECTRON_RENDERER_URL;
  const originalNonce = process.env.TETHOQ_DEV_CSP_NONCE;
  let headersHandler;
  hardenSession({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, webRequest: { onHeadersReceived(handler) { headersHandler = handler; } } });
  const scriptPolicy = () => { let headers; headersHandler({ responseHeaders: {} }, (result) => { headers = result.responseHeaders; }); return headers["Content-Security-Policy"][0].split(";").find((item) => item.trim().startsWith("script-src")); };
  try {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
    process.env.TETHOQ_DEV_CSP_NONCE = "aBcDeFgHiJkLmNoPqRsTuVwX";
    assert.match(scriptPolicy(), /'nonce-aBcDeFgHiJkLmNoPqRsTuVwX'/);
    assert.doesNotMatch(scriptPolicy(), /unsafe-inline/);
    process.env.TETHOQ_DEV_CSP_NONCE = "bad' injected";
    assert.doesNotMatch(scriptPolicy(), /nonce-|injected/);
    process.env.TETHOQ_DEV_CSP_NONCE = "aBcDeFgHiJkLmNoPqRsTuVwX";
    delete process.env.ELECTRON_RENDERER_URL;
    assert.equal(scriptPolicy().trim(), "script-src 'self'");
  } finally {
    if (originalUrl === undefined) delete process.env.ELECTRON_RENDERER_URL; else process.env.ELECTRON_RENDERER_URL = originalUrl;
    if (originalNonce === undefined) delete process.env.TETHOQ_DEV_CSP_NONCE; else process.env.TETHOQ_DEV_CSP_NONCE = originalNonce;
  }
});

test("every built-in has its own handoff and launch arguments match the actual presets", () => {
  assert.deepEqual(HARNESS_GUIDES.map((guide) => guide.id).sort(), [...DESKTOP_PROVIDERS, "other"].sort());
  for (const preset of [...Object.values(PUBLIC_ACP_PROVIDER_PRESETS), ...Object.values(piHarnessPresets)]) {
    const guide = HARNESS_GUIDES.find((item) => item.id === preset.providerId);
    assert.equal(guide.command, preset.command);
    assert.deepEqual(guide.args, preset.commandArgs);
  }
  const prompts = HARNESS_GUIDES.map((guide) => harnessSetupPrompt(guide.id));
  assert.equal(new Set(prompts).size, HARNESS_GUIDES.length);
  assert.match(harnessSetupPrompt("other", { connectorDirectory: "C:\\My Friends\\connectors" }), /C:\\\\My Friends\\\\connectors/);
  assert.throws(() => harnessSetupPrompt("unknown"), /Unknown/);
});

test("failed tool installs do not block another harness and can be retried without exposing errors", async () => {
  let installedPi = false;
  const issues = await installProviderToolHelpers([
    { providerId: "opencode", install: async () => { throw new Error("private diagnostic secret"); } },
    { providerId: "pi", install: async () => { installedPi = true; } },
  ]);
  assert.equal(installedPi, true);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].providerId, "opencode");
  assert.doesNotMatch(JSON.stringify(issues), /private diagnostic secret/);
  assert.deepEqual(await installProviderToolHelpers([{ providerId: "opencode", install: async () => {} }]), []);
});
