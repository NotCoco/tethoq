import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  CONNECTOR_MANIFEST_VERSION,
  type ConnectorCapabilities,
  type ConnectorManifestInputV1,
  type ConnectorManifestV1,
  type ConnectorModelDescriptor,
  type ConnectorPermissionDeclaration,
} from "./types.js";

export const defaultConnectorCapabilities: ConnectorCapabilities = Object.freeze({
  authentication: false,
  listSessions: false,
  paginatedSessions: false,
  sessionHistory: false,
  createSession: false,
  resumeSession: false,
  sendMessage: false,
  messageQueue: false,
  steering: false,
  streamingText: false,
  toolEvents: false,
  commandEvents: false,
  fileChanges: false,
  approvals: false,
  userInput: false,
  interrupt: false,
  modelEnumeration: false,
  projectAssociation: false,
  sessionRelationships: false,
  messageEditing: false,
  attachments: false,
  reasoningEfforts: false,
});

const capabilityKeys = Object.keys(defaultConnectorCapabilities) as (keyof ConnectorCapabilities)[];
const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function validateConnectorId(value: unknown): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 || !identifierPattern.test(value)) {
    throw new Error("Connector id must be a 2-64 character lowercase identifier");
  }
  return value;
}

export function parseConnectorManifest(value: unknown): ConnectorManifestV1 {
  const manifest = record(value, "connector manifest");
  rejectUnknownFields(manifest, [
    "$schema",
    "manifestVersion",
    "id",
    "name",
    "version",
    "description",
    "homepage",
    "runtime",
    "permissions",
    "capabilities",
    "models",
  ], "connector manifest");
  if (manifest.$schema !== undefined) boundedString(manifest.$schema, "$schema", 1, 2_048);
  const input = manifest as unknown as ConnectorManifestInputV1;
  if (input.manifestVersion !== CONNECTOR_MANIFEST_VERSION) throw new Error("Unsupported connector manifest version");
  const id = validateConnectorId(input.id);
  const name = boundedString(input.name, "name", 1, 80);
  const version = boundedString(input.version, "version", 1, 80);
  if (!versionPattern.test(version)) throw new Error("Connector version must be semantic versioning");

  const runtime = record(input.runtime, "runtime");
  rejectUnknownFields(runtime, ["transport", "command", "args", "cwd", "env"], "connector runtime");
  if (runtime.transport !== "stdio-jsonl") throw new Error("Connector runtime transport must be stdio-jsonl");
  const command = boundedString(runtime.command, "runtime.command", 1, 32_768);
  if (command.includes("\0")) throw new Error("Connector command contains a null byte");
  const args = optionalStringArray(runtime.args, "runtime.args", 128, 32_768);
  const cwd = runtime.cwd === undefined ? undefined : boundedString(runtime.cwd, "runtime.cwd", 1, 32_768);
  const env = optionalStringArray(runtime.env, "runtime.env", 64, 128);
  if (env !== undefined && new Set(env).size !== env.length) throw new Error("runtime.env contains a duplicate variable name");
  if (env?.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error("runtime.env contains an invalid variable name");

  const permissions = parsePermissions(input.permissions);
  const capabilities = parseCapabilities(input.capabilities);
  const models = input.models === undefined ? undefined : parseModels(input.models);
  if (models !== undefined && models.length > 0 && !capabilities.modelEnumeration) {
    throw new Error("Static models require the modelEnumeration capability");
  }

  return {
    manifestVersion: CONNECTOR_MANIFEST_VERSION,
    id,
    name,
    version,
    ...(input.description !== undefined ? { description: boundedString(input.description, "description", 1, 500) } : {}),
    ...(input.homepage !== undefined ? { homepage: validHttpUrl(input.homepage) } : {}),
    runtime: {
      transport: "stdio-jsonl",
      command,
      ...(args !== undefined && args.length > 0 ? { args } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(env !== undefined && env.length > 0 ? { env } : {}),
    },
    permissions,
    capabilities,
    ...(models !== undefined ? { models } : {}),
  };
}

export function validateConnectorManifest(value: unknown): value is ConnectorManifestV1 {
  try {
    parseConnectorManifest(value);
    return true;
  } catch {
    return false;
  }
}

export async function loadConnectorManifest(path: string): Promise<ConnectorManifestV1> {
  return parseConnectorManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
}

/** Resolve relative runtime paths against the manifest, never against the desktop process cwd. */
export function resolveConnectorRuntime(manifestPath: string, manifest: ConnectorManifestV1): ConnectorManifestV1["runtime"] {
  const directory = resolve(manifestPath, "..");
  return {
    ...manifest.runtime,
    command: isPathLike(manifest.runtime.command) && !isAbsolute(manifest.runtime.command)
      ? resolve(directory, manifest.runtime.command)
      : manifest.runtime.command,
    ...(manifest.runtime.cwd !== undefined
      ? { cwd: isAbsolute(manifest.runtime.cwd) ? manifest.runtime.cwd : resolve(directory, manifest.runtime.cwd) }
      : { cwd: directory }),
  };
}

function parseCapabilities(value: unknown): ConnectorCapabilities {
  if (value === undefined) return { ...defaultConnectorCapabilities };
  const input = record(value, "capabilities");
  const unknown = Object.keys(input).filter((key) => !capabilityKeys.includes(key as keyof ConnectorCapabilities));
  if (unknown.length > 0) throw new Error(`Unknown connector capabilities: ${unknown.join(", ")}`);
  const output = { ...defaultConnectorCapabilities };
  for (const key of capabilityKeys) {
    const current = input[key];
    if (current !== undefined && typeof current !== "boolean") throw new Error(`Capability ${key} must be boolean`);
    if (current === true) output[key] = true;
  }
  return output;
}

function parsePermissions(value: unknown): ConnectorPermissionDeclaration {
  const input = record(value, "permissions");
  if (input.filesystem !== "none" && input.filesystem !== "workspace" && input.filesystem !== "unrestricted") {
    throw new Error("permissions.filesystem must be none, workspace, or unrestricted");
  }
  if (typeof input.network !== "boolean" || typeof input.spawnProcesses !== "boolean") {
    throw new Error("Connector network and process permissions must be boolean");
  }
  const unknown = Object.keys(input).filter((key) => !["filesystem", "network", "spawnProcesses"].includes(key));
  if (unknown.length > 0) throw new Error(`Unknown connector permissions: ${unknown.join(", ")}`);
  return { filesystem: input.filesystem, network: input.network, spawnProcesses: input.spawnProcesses };
}

function parseModels(value: unknown): readonly ConnectorModelDescriptor[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("models must be an array with at most 500 entries");
  const ids = new Set<string>();
  let defaults = 0;
  const models = value.map((entry, index): ConnectorModelDescriptor => {
    const model = record(entry, `models[${index}]`);
    rejectUnknownFields(model, ["id", "displayName", "description", "isDefault", "reasoningEfforts", "metadata"], `models[${index}]`);
    const id = boundedString(model.id, `models[${index}].id`, 1, 200);
    if (ids.has(id)) throw new Error(`Duplicate model id ${id}`);
    ids.add(id);
    if (typeof model.isDefault !== "boolean") throw new Error(`models[${index}].isDefault must be boolean`);
    if (model.isDefault) defaults += 1;
    const reasoningEfforts = optionalStringArray(model.reasoningEfforts, `models[${index}].reasoningEfforts`, 32, 80);
    return {
      id,
      displayName: boundedString(model.displayName, `models[${index}].displayName`, 1, 100),
      ...(model.description !== undefined ? { description: boundedString(model.description, `models[${index}].description`, 1, 500) } : {}),
      isDefault: model.isDefault,
      ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
      ...(model.metadata !== undefined ? { metadata: jsonObject(model.metadata, `models[${index}].metadata`) } : {}),
    };
  });
  if (defaults > 1) throw new Error("Only one static model may be the default");
  return models;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownFields(input: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown ${name} fields: ${unknown.join(", ")}`);
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || value.includes("\0")) throw new Error(`${name} is invalid`);
  return value;
}

function optionalStringArray(value: unknown, name: string, maximumItems: number, maximumLength: number): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${name} is invalid`);
  return value.map((entry, index) => boundedString(entry, `${name}[${index}]`, 1, maximumLength));
}

function jsonObject(value: unknown, name: string): { [key: string]: import("./types.js").JsonValue } {
  const input = record(value, name);
  try {
    return JSON.parse(JSON.stringify(input)) as { [key: string]: import("./types.js").JsonValue };
  } catch {
    throw new Error(`${name} must be JSON serializable`);
  }
}

function validHttpUrl(value: unknown): string {
  const input = boundedString(value, "homepage", 1, 2_048);
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("homepage must be an HTTP URL");
  return url.toString();
}

function isPathLike(command: string): boolean {
  return command.startsWith(".") || command.includes("/") || command.includes("\\");
}
