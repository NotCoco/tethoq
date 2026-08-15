import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "electron";
import { createHostIdentity } from "../../../../packages/protocol/src/index.js";
import type { BridgeConfig } from "../../../agent_bridge/src/config.js";
import { JsonFileStore } from "../../../agent_bridge/src/persistence.js";
import { DESKTOP_PROVIDERS } from "../shared/desktop_api.js";

export const DESKTOP_CONFIG_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function desktopConfigPath(app: Pick<App, "getPath">): string {
  return join(app.getPath("userData"), "bridge.json");
}

export function validateDesktopConfig(value: unknown): BridgeConfig {
  if (!isRecord(value) || value.version !== DESKTOP_CONFIG_VERSION || typeof value.hostId !== "string" || value.hostId.length === 0 || typeof value.displayName !== "string" || !isRecord(value.identity) || typeof value.identity.publicKeyPem !== "string" || typeof value.identity.privateKeyPem !== "string") {
    throw new Error("Tethoq desktop configuration is invalid");
  }
  return {
    version: DESKTOP_CONFIG_VERSION,
    hostId: value.hostId,
    displayName: value.displayName,
    identity: {
      publicKeyPem: value.identity.publicKeyPem,
      privateKeyPem: value.identity.privateKeyPem,
    },
    // External connectors are discovered from their validated install
    // directory at runtime, never enabled by arbitrary persisted strings.
    enabledProviders: DESKTOP_PROVIDERS,
  };
}

export async function loadDesktopConfig(path: string): Promise<BridgeConfig> {
  const store = new JsonFileStore(path, validateDesktopConfig);
  const created: BridgeConfig = {
    version: DESKTOP_CONFIG_VERSION,
    hostId: `desktop_${randomUUID()}`,
    displayName: hostname() || "Tethoq desktop",
    identity: createHostIdentity(),
    enabledProviders: DESKTOP_PROVIDERS,
  };
  const value = await store.read(created);
  const sanitized = validateDesktopConfig(value);
  // Always rewrite through the validator so only trusted built-ins are stored.
  // Discovered connector IDs live in the runtime registry, not this file.
  await store.write(sanitized);
  return sanitized;
}
