import type { AgentProviderAdapter } from "../../../packages/provider_contract/src/index.js";
import { CodexAdapter } from "../../../packages/provider_codex/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import {
  createPublicAcpProviderAdapter,
  GrokProviderAdapter,
  type PublicAcpProviderId,
} from "../../../packages/provider_grok/src/index.js";
import { OpenCodeAdapter } from "../../../packages/provider_opencode/src/index.js";
import { PiRpcProviderAdapter, piHarnessPresets } from "../../../packages/provider_pi/src/index.js";
import { DirectApiProviderAdapter } from "../../../packages/provider_direct/src/index.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./config.js";
import { tethoqEnvironmentFlag, tethoqEnvironmentValue } from "./environment.js";
import { piToolExtensionPath } from "./pi_tools.js";

function stringArray(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("Provider argument environment variables must be JSON string arrays");
  return parsed;
}

export function createConfiguredProviders(
  config: BridgeConfig,
  environment: NodeJS.ProcessEnv = process.env,
  directApiStatePath = join(homedir(), ".tethoq", "direct-api-wallet.json"),
): readonly AgentProviderAdapter[] {
  const enabled = new Set(config.enabledProviders);
  const adapters: AgentProviderAdapter[] = [];
  if (enabled.has("direct")) {
    adapters.push(new DirectApiProviderAdapter({
      hostId: config.hostId,
      statePath: directApiStatePath,
      encryptionSecret: config.identity.privateKeyPem,
      environment,
    }));
  }
  if (enabled.has("codex")) {
    const command = tethoqEnvironmentValue(environment, "TETHOQ_CODEX_COMMAND");
    const commandArgs = stringArray(tethoqEnvironmentValue(environment, "TETHOQ_CODEX_ARGS"));
    const localStateEnabled = tethoqEnvironmentFlag(environment, "TETHOQ_ENABLE_CODEX_LOCAL_STATE");
    adapters.push(new CodexAdapter({
      hostId: config.hostId,
      ...(command !== undefined ? { command } : {}),
      ...(commandArgs !== undefined ? { commandArgs } : {}),
      ...(localStateEnabled ? { localActivity: {}, desktopQueue: {} } : {}),
    }));
  }
  if (enabled.has("opencode")) {
    const username = tethoqEnvironmentValue(environment, "TETHOQ_OPENCODE_USERNAME");
    const password = tethoqEnvironmentValue(environment, "TETHOQ_OPENCODE_PASSWORD");
    const directory = tethoqEnvironmentValue(environment, "TETHOQ_PROJECT_DIRECTORY");
    const databasePath = tethoqEnvironmentValue(environment, "TETHOQ_OPENCODE_DB_PATH");
    adapters.push(new OpenCodeAdapter({
      hostId: config.hostId,
      baseUrl: tethoqEnvironmentValue(environment, "TETHOQ_OPENCODE_URL") ?? "http://127.0.0.1:4096/",
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(directory !== undefined ? { directory } : {}),
      ...(tethoqEnvironmentFlag(environment, "TETHOQ_ENABLE_OPENCODE_LOCAL_STATE")
        ? { localActivity: databasePath === undefined ? {} : { databasePath } }
        : {}),
    }));
  }
  if (enabled.has("grok")) {
    const command = tethoqEnvironmentValue(environment, "TETHOQ_GROK_COMMAND");
    const commandArgs = stringArray(tethoqEnvironmentValue(environment, "TETHOQ_GROK_ARGS"));
    adapters.push(new GrokProviderAdapter({
      hostId: config.hostId,
      ...(command !== undefined ? { command } : {}),
      ...(commandArgs !== undefined ? { commandArgs } : {}),
    }));
  }
  const publicAcpProviders: readonly {
    readonly providerId: PublicAcpProviderId;
    readonly commandEnvironment: "TETHOQ_QWEN_COMMAND" | "TETHOQ_GOOSE_COMMAND" | "TETHOQ_KIMI_COMMAND" | "TETHOQ_HERMES_COMMAND" | "TETHOQ_CLINE_COMMAND" | "TETHOQ_COPILOT_COMMAND";
    readonly argsEnvironment: "TETHOQ_QWEN_ARGS" | "TETHOQ_GOOSE_ARGS" | "TETHOQ_KIMI_ARGS" | "TETHOQ_HERMES_ARGS" | "TETHOQ_CLINE_ARGS" | "TETHOQ_COPILOT_ARGS";
  }[] = [
    { providerId: "qwen", commandEnvironment: "TETHOQ_QWEN_COMMAND", argsEnvironment: "TETHOQ_QWEN_ARGS" },
    { providerId: "goose", commandEnvironment: "TETHOQ_GOOSE_COMMAND", argsEnvironment: "TETHOQ_GOOSE_ARGS" },
    { providerId: "kimi", commandEnvironment: "TETHOQ_KIMI_COMMAND", argsEnvironment: "TETHOQ_KIMI_ARGS" },
    { providerId: "hermes", commandEnvironment: "TETHOQ_HERMES_COMMAND", argsEnvironment: "TETHOQ_HERMES_ARGS" },
    { providerId: "cline", commandEnvironment: "TETHOQ_CLINE_COMMAND", argsEnvironment: "TETHOQ_CLINE_ARGS" },
    { providerId: "copilot", commandEnvironment: "TETHOQ_COPILOT_COMMAND", argsEnvironment: "TETHOQ_COPILOT_ARGS" },
  ];
  for (const preset of publicAcpProviders) {
    if (!enabled.has(preset.providerId)) continue;
    const command = tethoqEnvironmentValue(environment, preset.commandEnvironment);
    const commandArgs = stringArray(tethoqEnvironmentValue(environment, preset.argsEnvironment));
    adapters.push(createPublicAcpProviderAdapter(preset.providerId, {
      hostId: config.hostId,
      ...(command !== undefined ? { command } : {}),
      ...(commandArgs !== undefined ? { commandArgs } : {}),
    }));
  }
  for (const providerId of ["pi", "omp"] as const) {
    if (!enabled.has(providerId)) continue;
    const environmentPrefix = providerId === "pi" ? "PI" : "OMP";
    const command = tethoqEnvironmentValue(environment, `TETHOQ_${environmentPrefix}_COMMAND`);
    const commandArgs = stringArray(tethoqEnvironmentValue(environment, `TETHOQ_${environmentPrefix}_ARGS`));
    adapters.push(new PiRpcProviderAdapter({
      hostId: config.hostId,
      preset: piHarnessPresets[providerId],
      ...(providerId === "pi" ? { extensionPath: piToolExtensionPath() } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(commandArgs !== undefined ? { commandArgs } : {}),
      environment,
    }));
  }
  if (enabled.has("fake") || tethoqEnvironmentFlag(environment, "TETHOQ_ENABLE_FAKE_PROVIDER")) adapters.push(new FakeProviderAdapter({ hostId: config.hostId }));
  return adapters;
}
