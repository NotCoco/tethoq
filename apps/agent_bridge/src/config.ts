import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { createHostIdentity, type HostIdentity } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

const supportedProviderIds = new Set(["codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct", "fake"]);

export interface BridgeConfig {
  readonly version: 1;
  readonly hostId: string;
  readonly displayName: string;
  readonly identity: HostIdentity;
  readonly enabledProviders: readonly string[];
  readonly relayUrl?: string;
  readonly relayToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateConfig(value: unknown): BridgeConfig {
  if (!isRecord(value) || value.version !== 1 || typeof value.hostId !== "string" || typeof value.displayName !== "string" || !isRecord(value.identity) || typeof value.identity.publicKeyPem !== "string" || typeof value.identity.privateKeyPem !== "string" || !Array.isArray(value.enabledProviders) || !value.enabledProviders.every((entry) => typeof entry === "string")) {
    throw new Error("Bridge configuration file is invalid");
  }
  return {
    version: 1,
    hostId: value.hostId,
    displayName: value.displayName,
    identity: { publicKeyPem: value.identity.publicKeyPem, privateKeyPem: value.identity.privateKeyPem },
    enabledProviders: value.enabledProviders.filter((entry): entry is string =>
      typeof entry === "string" && supportedProviderIds.has(entry)
    ),
    ...(typeof value.relayUrl === "string" ? { relayUrl: value.relayUrl } : {}),
    ...(typeof value.relayToken === "string" ? { relayToken: value.relayToken } : {}),
  };
}

export function defaultConfigPath(
  userHome = homedir(),
  pathExists: (path: string) => boolean = existsSync,
): string {
  const current = join(userHome, ".tethoq", "bridge.json");
  const legacy = join(userHome, ".universal-agent-remote", "bridge.json");
  return pathExists(current) || !pathExists(legacy) ? current : legacy;
}

export async function loadOrCreateConfig(path = defaultConfigPath()): Promise<BridgeConfig> {
  const store = new JsonFileStore(path, validateConfig);
  const created: BridgeConfig = {
    version: 1,
    hostId: `host_${randomUUID()}`,
    displayName: hostname() || `${platform()} host`,
    identity: createHostIdentity(),
    enabledProviders: ["codex", "opencode", "grok", "pi", "omp", "qwen", "goose", "kimi", "hermes", "cline", "copilot", "direct"],
  };
  const config = await store.read(created);
  await store.write(config);
  return config;
}
