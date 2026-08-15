import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeConfig } from "./config.js";
import { createConfiguredProviders } from "./providers.js";

const config: BridgeConfig = {
  version: 1,
  hostId: "host_1",
  displayName: "Test host",
  identity: { publicKeyPem: "public", privateKeyPem: "private" },
  enabledProviders: ["qwen", "goose", "kimi", "hermes", "cline", "copilot"],
};

test("configured public ACP harnesses are registered without starting their CLIs", () => {
  const providers = createConfiguredProviders(config, {});
  assert.deepEqual(providers.map((provider) => [provider.providerId, provider.displayName]), [
    ["qwen", "Qwen Code"],
    ["goose", "Goose"],
    ["kimi", "Kimi Code"],
    ["hermes", "Hermes Agent"],
    ["cline", "Cline"],
    ["copilot", "GitHub Copilot CLI"],
  ]);
});
