import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createHostIdentity } from "../../../packages/protocol/src/index.js";
import { defaultConfigPath, validateConfig } from "./config.js";

test("bridge config drops unsupported provider ids", () => {
  const config = validateConfig({
    version: 1,
    hostId: "host_1",
    displayName: "Test host",
    identity: createHostIdentity(),
    enabledProviders: ["codex", "claude", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct", "gemini"],
  });

  assert.deepEqual(config.enabledProviders, ["codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct"]);
});

test("new installs use .tethoq while existing legacy identities remain discoverable", () => {
  const userHome = "C:\\Users\\Test";
  const current = join(userHome, ".tethoq", "bridge.json");
  const legacy = join(userHome, ".universal-agent-remote", "bridge.json");

  assert.equal(defaultConfigPath(userHome, () => false), current);
  assert.equal(defaultConfigPath(userHome, (path) => path === legacy), legacy);
  assert.equal(defaultConfigPath(userHome, (path) => path === current || path === legacy), current);
});
