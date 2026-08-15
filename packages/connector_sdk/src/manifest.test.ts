import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseConnectorManifest, validateConnectorManifest } from "./manifest.js";

const schema = JSON.parse(await readFile(new URL("../../../../packages/connector_sdk/tethoq.connector.schema.json", import.meta.url), "utf8")) as object;
const ajv = new Ajv2020.default({ allErrors: true, strict: true });
addFormats.default(ajv);
const validateSchema = ajv.compile(schema);

const minimal = {
  manifestVersion: 1,
  id: "community.echo",
  name: "Echo",
  version: "1.2.3",
  runtime: { transport: "stdio-jsonl", command: "node", args: ["connector.js"], env: ["ECHO_API_KEY"] },
  permissions: { filesystem: "none", network: false, spawnProcesses: false },
  capabilities: { modelEnumeration: true },
  models: [{ id: "echo-fast", displayName: "Echo Fast", isDefault: true }],
};

test("manifest parser fills missing capabilities and preserves static models", () => {
  const manifest = parseConnectorManifest(minimal);
  assert.equal(manifest.capabilities.modelEnumeration, true);
  assert.equal(manifest.capabilities.sendMessage, false);
  assert.equal(manifest.models?.[0]?.id, "echo-fast");
  assert.equal(validateConnectorManifest(manifest), true);
});

test("manifest parser rejects secrets, duplicate defaults, and undeclared model enumeration", () => {
  assert.throws(() => parseConnectorManifest({ ...minimal, runtime: { ...minimal.runtime, env: { API_KEY: "secret" } } }), /runtime.env/);
  assert.throws(() => parseConnectorManifest({ ...minimal, models: [...minimal.models, { id: "other", displayName: "Other", isDefault: true }] }), /Only one/);
  assert.throws(() => parseConnectorManifest({ ...minimal, capabilities: {}, models: minimal.models }), /modelEnumeration/);
});

test("manifest parser rejects unknown privileges and capability names", () => {
  assert.throws(() => parseConnectorManifest({ ...minimal, permissions: { ...minimal.permissions, registry: true } }), /Unknown connector permissions/);
  assert.throws(() => parseConnectorManifest({ ...minimal, capabilities: { madeUp: true } }), /Unknown connector capabilities/);
});

function assertContract(label: string, value: unknown, expected: boolean): void {
  const schemaAccepted = validateSchema(value);
  assert.equal(schemaAccepted, expected, `${label}: schema ${ajv.errorsText(validateSchema.errors)}`);
  assert.equal(validateConnectorManifest(value), expected, `${label}: runtime parser disagreed with schema`);
}

test("JSON Schema and runtime both allow omitted capabilities and the example $schema field", () => {
  const withoutCapabilities = {
    $schema: "../../tethoq.connector.schema.json",
    manifestVersion: 1,
    id: "community.echo",
    name: "Echo",
    version: "1.2.3",
    runtime: { transport: "stdio-jsonl", command: "node" },
    permissions: { filesystem: "none", network: false, spawnProcesses: false },
  };
  assertContract("omitted capabilities", withoutCapabilities, true);
  assert.equal(parseConnectorManifest(withoutCapabilities).capabilities.sendMessage, false);
  assertContract("missing required permissions", { ...withoutCapabilities, permissions: undefined }, false);
});

test("JSON Schema and runtime reject unknown root, runtime, and model fields", () => {
  assertContract("unknown root field", { ...minimal, typo: true }, false);
  assertContract("unknown runtime field", { ...minimal, runtime: { ...minimal.runtime, shell: true } }, false);
  assertContract("unknown model field", {
    ...minimal,
    models: [{ ...minimal.models[0], nickname: "fast" }],
  }, false);
});

test("JSON Schema and runtime require modelEnumeration for non-empty static models", () => {
  const withoutModels = { ...minimal, capabilities: {}, models: [] };
  assertContract("empty static model list", withoutModels, true);
  assertContract("models without modelEnumeration", { ...minimal, capabilities: {} }, false);
  assertContract("models with false modelEnumeration", { ...minimal, capabilities: { modelEnumeration: false } }, false);
  assertContract("models with modelEnumeration", minimal, true);
});

test("JSON Schema and runtime allow at most one default static model", () => {
  assertContract("no default models", {
    ...minimal,
    models: [{ id: "echo-fast", displayName: "Echo Fast", isDefault: false }],
  }, true);
  assertContract("one default model", minimal, true);
  assertContract("two default models", {
    ...minimal,
    models: [
      ...minimal.models,
      { id: "echo-careful", displayName: "Echo Careful", isDefault: true },
    ],
  }, false);
});
