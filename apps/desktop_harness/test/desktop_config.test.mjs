import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const bundleDirectory = join(tmpdir(), `tethoq-desktop-config-module-${process.pid}-${Date.now()}`);
const bundlePath = join(bundleDirectory, "config.mjs");
await mkdir(bundleDirectory, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/main/config.ts", import.meta.url))],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: ["electron"],
});
const configModule = await import(`file:///${bundlePath.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(bundleDirectory, { recursive: true, force: true }); });

const identity = {
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
  privateKeyPem: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
};

test("persisted provider choices are replaced by the desktop allowlist", () => {
  const sanitized = configModule.validateDesktopConfig({
    version: 1,
    hostId: "desktop_test",
    displayName: "Test host",
    identity,
    enabledProviders: ["claude"],
  });

  assert.deepEqual(sanitized.enabledProviders, ["codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct"]);
});

test("loading legacy desktop config rewrites the sanitized provider list", async (context) => {
  const directory = join(tmpdir(), `tethoq-desktop-config-${process.pid}-${Date.now()}`);
  const path = join(directory, "bridge.json");
  await mkdir(directory, { recursive: true });
  context.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await writeFile(path, JSON.stringify({
    version: 1,
    hostId: "desktop_test",
    displayName: "Test host",
    identity,
    enabledProviders: ["codex", "claude"],
  }));

  const loaded = await configModule.loadDesktopConfig(path);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(loaded.enabledProviders, ["codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct"]);
  assert.deepEqual(persisted.enabledProviders, ["codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct"]);
});
