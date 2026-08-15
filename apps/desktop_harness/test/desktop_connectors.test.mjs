import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const repositoryRoot = join(appRoot, "..", "..");
const outputDirectory = join(tmpdir(), `tethoq-connectors-test-${process.pid}-${Date.now()}`);
const connectorRoot = join(outputDirectory, "connectors");
const trustStorePath = join(outputDirectory, "connector-trust.json");
await mkdir(connectorRoot, { recursive: true });

const bundled = join(outputDirectory, "connectors.mjs");
await build({
  entryPoints: [join(appRoot, "src", "main", "connectors.ts")],
  outfile: bundled,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
const connectors = await import(`file:///${bundled.replaceAll("\\", "/")}`);
process.on("exit", () => { void rm(outputDirectory, { recursive: true, force: true }); });

const host = { id: "desktop_connector_test", name: "Test host", version: "0.1.0", platform: "windows" };

test("stale app-owned connector runtime snapshots are removed without touching recent ones", async () => {
  const temporaryDirectory = join(outputDirectory, "runtime-cleanup");
  const stale = join(temporaryDirectory, "tethoq-connector-runtime-stale");
  const recent = join(temporaryDirectory, "tethoq-connector-runtime-recent");
  const unrelated = join(temporaryDirectory, "someone-elses-runtime");
  await Promise.all([mkdir(stale, { recursive: true }), mkdir(recent, { recursive: true }), mkdir(unrelated, { recursive: true })]);
  const now = Date.now();
  await utimes(stale, new Date(now - 48 * 60 * 60 * 1_000), new Date(now - 48 * 60 * 60 * 1_000));
  assert.equal(await connectors.cleanupStaleConnectorRuntimeCopies(temporaryDirectory, now), 1);
  await assert.rejects(stat(stale), { code: "ENOENT" });
  assert.equal((await stat(recent)).isDirectory(), true);
  assert.equal((await stat(unrelated)).isDirectory(), true);
});

async function installEcho() {
  const source = join(repositoryRoot, "packages", "connector_sdk", "examples", "echo");
  const target = join(connectorRoot, "community.echo");
  await cp(source, target, { recursive: true });
  const manifestPath = join(target, "tethoq.connector.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.runtime.command = "node";
  manifest.runtime.args = ["./connector.js"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const installedSdk = join(target, "node_modules", "@tethoq", "connector-sdk");
  await mkdir(installedSdk, { recursive: true });
  await cp(join(repositoryRoot, "packages", "connector_sdk", "dist"), join(installedSdk, "dist"), { recursive: true });
  await cp(join(repositoryRoot, "packages", "connector_sdk", "package.json"), join(installedSdk, "package.json"));
  return target;
}

async function resetConnectorFixture() {
  await rm(connectorRoot, { recursive: true, force: true });
  await rm(trustStorePath, { force: true });
  await mkdir(connectorRoot, { recursive: true });
  return await installEcho();
}

async function updateManifest(directory, update) {
  const manifestPath = join(directory, "tethoq.connector.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  update(manifest);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifest;
}

async function approveInstalledConnector(directory) {
  const fingerprint = await connectors.fingerprintInstalledDesktopConnector(directory);
  await connectors.approveDesktopConnector(trustStorePath, fingerprint);
  return fingerprint;
}

test("external echo connector is discovered, enumerates models, runs a session, and shuts down", async () => {
  await installEcho();
  await approveInstalledConnector(join(connectorRoot, "community.echo"));
  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host, workspaceRoots: [repositoryRoot] });
  assert.deepEqual([...registry.allowedProviderIds], ["community.echo"], JSON.stringify(registry.state.diagnostics));
  assert.equal(registry.state.loaded[0].name, "Echo Connector");
  assert.equal(registry.state.diagnostics[0].state, "loaded");

  const [adapter] = registry.adapters;
  const models = await adapter.listModels();
  assert.deepEqual(models.map((model) => model.id), ["echo-fast", "echo-careful"]);
  const events = [];
  const subscription = await adapter.subscribe(null, (event) => { events.push(event); });
  const session = await adapter.createSession({ workingDirectory: repositoryRoot, firstInstruction: "hello", modelId: "echo-careful" });
  assert.equal(session.providerId, "community.echo");
  assert.equal(session.modelId, "echo-careful");
  const result = await adapter.sendMessage(session.providerSessionId, { requestId: "request-1", content: "hello" });
  assert.equal(result.accepted, true);
  assert.ok(events.some((event) => event.type === "message.delta" && event.payload.text === "Echo: hello"));
  const history = await adapter.getMessages(session.providerSessionId);
  assert.equal(history.at(-1).parts[0].text, "Echo: hello");
  await subscription.unsubscribe();
  await registry.dispose();
  await assert.rejects(() => adapter.detect(), /closed|exited/i);
});

test("bad connectors are rejected independently and connector identities stay provider-neutral", async () => {
  await rm(connectorRoot, { recursive: true, force: true });
  await mkdir(connectorRoot, { recursive: true });
  const echo = await installEcho();
  const malformed = join(connectorRoot, "malformed");
  await mkdir(malformed);
  await writeFile(join(malformed, "tethoq.connector.json"), "{broken");
  await approveInstalledConnector(echo);

  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.deepEqual([...registry.allowedProviderIds], ["community.echo"]);
  assert.equal(registry.state.diagnostics.filter((item) => item.state === "rejected").length, 1);
  await registry.dispose();
});

test("connector environment is explicit and only passes declared variables", () => {
  const manifest = {
    runtime: { env: ["ACME_TOKEN"] },
  };
  const environment = connectors.buildConnectorEnvironment(manifest, {
    PATH: "C:\\bin",
    SystemRoot: "C:\\Windows",
    ACME_TOKEN: "allowed",
    SECRET_NOT_DECLARED: "hidden",
  });
  assert.equal(environment.ACME_TOKEN, "allowed");
  assert.equal(environment.SECRET_NOT_DECLARED, undefined);
});

test("packaged host-node execution adds Electron's Node-mode flag without accepting it from connector input", () => {
  const manifest = { runtime: { env: [] } };
  assert.equal(connectors.buildConnectorEnvironment(manifest, { ELECTRON_RUN_AS_NODE: "attacker" }).ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(connectors.connectorHostNodeEnvironment(manifest, { ELECTRON_RUN_AS_NODE: "attacker" }, "43.4.0").ELECTRON_RUN_AS_NODE, "1");
  assert.equal(connectors.connectorHostNodeEnvironment(manifest, { ELECTRON_RUN_AS_NODE: "attacker" }, undefined).ELECTRON_RUN_AS_NODE, undefined);
});

test("Windows connector environment lookup is case-insensitive", () => {
  const environment = connectors.buildConnectorEnvironment({ runtime: { env: ["ACME_TOKEN"] } }, {
    Path: "C:\\bin",
    SYSTEMROOT: "C:\\Windows",
    acme_token: "allowed",
  });
  assert.equal(environment.PATH, "C:\\bin");
  assert.equal(environment.SystemRoot, "C:\\Windows");
  assert.equal(environment.ACME_TOKEN, "allowed");
});

test("connector cwd realpath cannot escape through a directory link", async (t) => {
  await rm(connectorRoot, { recursive: true, force: true });
  await mkdir(connectorRoot, { recursive: true });
  const echo = await installEcho();
  const outside = join(outputDirectory, "outside-cwd");
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, join(echo, "linked-cwd"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`directory links unavailable: ${error.message}`);
    return;
  }
  const manifestPath = join(echo, "tethoq.connector.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.runtime.cwd = "./linked-cwd";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(registry.adapters.length, 0);
  assert.match(registry.state.diagnostics[0].message, /working directory escapes|symbolic link/i);
  await registry.dispose();
});

test("untrusted connector trees stay pending without constructing or starting code", async () => {
  await rm(connectorRoot, { recursive: true, force: true });
  await rm(trustStorePath, { force: true });
  await mkdir(connectorRoot, { recursive: true });
  const echo = await installEcho();
  const marker = join(outputDirectory, "untrusted-started.txt");
  const manifestPath = join(echo, "tethoq.connector.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const probe = join(echo, "untrusted-probe.js");
  await writeFile(probe, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`);
  manifest.runtime.command = "node";
  manifest.runtime.args = ["untrusted-probe.js"];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(registry.adapters.length, 0);
  assert.equal(registry.state.loaded.length, 0);
  assert.equal(registry.state.pending.length, 1);
  assert.equal(registry.state.pending[0].id, "community.echo");
  assert.match(registry.state.pending[0].fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(registry.state.pending[0].runtime.args, manifest.runtime.args);
  assert.deepEqual(registry.state.pending[0].requestedEnvironmentNames, []);
  await assert.rejects(() => readFile(marker), /ENOENT/);
  await registry.dispose();
});

test("trust is exact-fingerprint keyed and content, manifest, and env changes invalidate it", async () => {
  await rm(connectorRoot, { recursive: true, force: true });
  await rm(trustStorePath, { force: true });
  await mkdir(connectorRoot, { recursive: true });
  const echo = await installEcho();
  const approvedFingerprint = await approveInstalledConnector(echo);

  const trusted = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(trusted.adapters.length, 1);
  assert.equal(trusted.state.pending.length, 0);
  await trusted.dispose();

  await writeFile(join(echo, "extra.txt"), "changed content");
  const changedContent = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(changedContent.adapters.length, 0);
  assert.notEqual(changedContent.state.pending[0].fingerprint, approvedFingerprint);
  await changedContent.dispose();

  await rm(join(echo, "extra.txt"));
  const manifestPath = join(echo, "tethoq.connector.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.runtime.env = ["NEW_PROVIDER_TOKEN"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const changedEnvironment = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(changedEnvironment.adapters.length, 0);
  assert.deepEqual(changedEnvironment.state.pending[0].requestedEnvironmentNames, ["NEW_PROVIDER_TOKEN"]);
  assert.notEqual(changedEnvironment.state.pending[0].fingerprint, approvedFingerprint);
  await changedEnvironment.dispose();
});

test("revoked fingerprints do not run and connector trees reject links", async (t) => {
  await rm(connectorRoot, { recursive: true, force: true });
  await rm(trustStorePath, { force: true });
  await mkdir(connectorRoot, { recursive: true });
  const echo = await installEcho();
  const fingerprint = await approveInstalledConnector(echo);
  await connectors.revokeDesktopConnector(trustStorePath, fingerprint);
  const revoked = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(revoked.adapters.length, 0);
  assert.equal(revoked.state.pending[0].fingerprint, fingerprint);
  await revoked.dispose();

  try {
    await symlink(join(echo, "connector.js"), join(echo, "connector-link.js"), "file");
  } catch (error) {
    t.skip(`file links unavailable: ${error.message}`);
    return;
  }
  const linked = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(linked.adapters.length, 0);
  assert.equal(linked.state.pending.length, 0);
  assert.match(linked.state.diagnostics[0].message, /symbolic link/i);
  await linked.dispose();
});

test("untrusted runtime paths are not dereferenced before approval", async (t) => {
  await rm(connectorRoot, { recursive: true, force: true });
  await rm(trustStorePath, { force: true });
  await mkdir(connectorRoot, { recursive: true });
  const echo = await installEcho();
  const outside = join(outputDirectory, "untrusted-outside-cwd");
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, join(echo, "linked-cwd"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`directory links unavailable: ${error.message}`);
    return;
  }
  const manifestPath = join(echo, "tethoq.connector.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.runtime.cwd = "./linked-cwd";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(registry.adapters.length, 0);
  assert.equal(registry.state.pending.length, 0);
  assert.match(registry.state.diagnostics[0].message, /escapes|symbolic link/i);
  await registry.dispose();
});

test("connector host source binds approvals and rate-limits events", async () => {
  const source = await readFile(join(appRoot, "src", "main", "connectors.ts"), "utf8");
  assert.match(source, /event\.approval\.sessionId\s*!==\s*event\.sessionId/);
  assert.match(source, /MAX_EVENTS_PER_WINDOW/);
  assert.match(source, /exceeded the event rate limit/);
  const create = source.match(/public async createSession[\s\S]*?\n  }/)?.[0] ?? "";
  assert.doesNotMatch(create, /metadata\?\.parentSessionId/);
});

test("execution policy rejects PATH launchers, absolute commands, and external Node entrypoints", async () => {
  const cases = [
    { name: "PATH launcher", command: "python", args: ["./connector.js"], pattern: /must be 'node' or a bundle-relative executable/i },
    { name: "absolute command", command: process.execPath, args: [], pattern: /Node runtime must name a bundle-contained script/i },
    { name: "external Node script", command: "node", args: [join(outputDirectory, "outside.js")], pattern: /entrypoint must be bundle-relative/i },
    { name: "parent Node script", command: "node", args: ["../outside.js"], pattern: /entrypoint escapes/i },
  ];
  await writeFile(join(outputDirectory, "outside.js"), "process.exit(0)");
  for (const item of cases) {
    const echo = await resetConnectorFixture();
    await updateManifest(echo, (manifest) => {
      manifest.runtime.command = item.command;
      manifest.runtime.args = item.args;
    });
    const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
    assert.equal(registry.adapters.length, 0, item.name);
    assert.equal(registry.state.pending.length, 0, item.name);
    assert.match(registry.state.diagnostics.at(-1).message, item.pattern, item.name);
    await registry.dispose();
  }
});

test("approved host-node connectors launch only from an app-owned verified runtime copy", async () => {
  const echo = await resetConnectorFixture();
  const sourcePath = echo.replaceAll("\\", "/");
  await updateManifest(echo, (manifest) => {
    manifest.capabilities.modelEnumeration = false;
    delete manifest.models;
  });
  const connectorPath = join(echo, "connector.js");
  await writeFile(connectorPath, `
    import readline from "node:readline";
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const request = JSON.parse(line);
      if (request.method === "connector.initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, connector: { id: "community.echo", name: "Echo Connector", version: "0.1.0" }, capabilities: ${JSON.stringify({ authentication:false,listSessions:true,paginatedSessions:false,sessionHistory:true,createSession:true,resumeSession:false,sendMessage:true,messageQueue:false,steering:false,streamingText:true,toolEvents:false,commandEvents:false,fileChanges:false,approvals:false,userInput:false,interrupt:false,modelEnumeration:false,projectAssociation:true,sessionRelationships:false,messageEditing:false,attachments:false,reasoningEfforts:true })} } }) + "\\n");
      else if (request.method === "provider.detect") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { available: true, details: [import.meta.url] } }) + "\\n");
      else if (request.method === "connector.shutdown") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n"); setImmediate(() => process.exit(0)); }
    });
  `);
  await approveInstalledConnector(echo);
  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(registry.adapters.length, 1);
  const detection = await registry.adapters[0].detect();
  assert.match(detection.details[0], /tethoq-connector-runtime-/i);
  assert.doesNotMatch(detection.details[0].replaceAll("\\", "/"), new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const runtimeDirectory = dirname(fileURLToPath(detection.details[0]));
  await registry.dispose();
  await assert.rejects(() => readFile(join(runtimeDirectory, "connector.js")), /ENOENT/);
});

test("bundle-relative executable launchers are accepted", async (t) => {
  if (process.platform === "win32") {
    t.skip("The portable executable fixture is POSIX-only; Windows executable policy is covered structurally");
    return;
  }
  const echo = await resetConnectorFixture();
  await updateManifest(echo, (manifest) => {
    manifest.runtime.command = "./connector-executable";
    manifest.runtime.args = [];
  });
  await writeFile(join(echo, "connector-executable"), "#!/bin/sh\nexec node \"$(dirname \"$0\")/connector.js\"\n");
  await chmod(join(echo, "connector-executable"), 0o700);
  await approveInstalledConnector(echo);
  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(registry.adapters.length, 1);
  await registry.dispose();
});

test("canonical execution plan covers args, cwd, requested env names, platform, and architecture", async () => {
  const echo = await resetConnectorFixture();
  const base = { launcher: "node", entrypoint: "connector.js", cwd: ".", args: [], platform: "win32", architecture: "x64", environmentNames: [] };
  const fingerprint = await connectors.fingerprintDesktopConnectorTree(echo, base);
  for (const changed of [
    { ...base, args: ["--safe"] },
    { ...base, cwd: "lib" },
    { ...base, environmentNames: ["TOKEN"] },
    { ...base, platform: "linux" },
    { ...base, architecture: "arm64" },
  ]) {
    assert.notEqual(await connectors.fingerprintDesktopConnectorTree(echo, changed), fingerprint);
  }
  assert.equal(
    await connectors.fingerprintDesktopConnectorTree(echo, { ...base, environmentNames: ["Z_TOKEN", "A_TOKEN"] }),
    await connectors.fingerprintDesktopConnectorTree(echo, { ...base, environmentNames: ["A_TOKEN", "Z_TOKEN"] }),
  );
});

test("a corrupt trust store disables external approvals without aborting connector discovery", async () => {
  const echo = await resetConnectorFixture();
  await writeFile(trustStorePath, "{broken");
  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  assert.equal(registry.adapters.length, 0);
  assert.equal(registry.state.pending.length, 1);
  assert.ok(registry.state.diagnostics.some((item) => /approvals ignored.*trust store is invalid/i.test(item.message)));
  await registry.dispose();
  assert.equal(echo, registry.state.pending[0].directory);
});

test("concurrent approvals are serialized without losing fingerprints", async () => {
  await rm(trustStorePath, { force: true });
  const fingerprints = Array.from({ length: 40 }, (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`);
  await Promise.all(fingerprints.map((fingerprint) => connectors.approveDesktopConnector(trustStorePath, fingerprint)));
  const approved = JSON.parse(await readFile(trustStorePath, "utf8")).approvedFingerprints;
  assert.deepEqual(approved, [...fingerprints].sort());
});

test("disposing a connector immediately removes it from live registry state and stops its process", async () => {
  const echo = await resetConnectorFixture();
  await approveInstalledConnector(echo);
  const registry = await connectors.loadDesktopConnectors({ rootDirectory: connectorRoot, trustStorePath, host });
  const [adapter] = registry.adapters;
  assert.equal(registry.allowedProviderIds.has("community.echo"), true);
  assert.equal(registry.state.loaded.length, 1);
  await adapter.dispose();
  assert.equal(registry.allowedProviderIds.has("community.echo"), false);
  assert.equal(registry.state.loaded.length, 0);
  await assert.rejects(() => adapter.detect(), /closed/i);
  await registry.dispose();
});

test("source tampering during fingerprint enumeration is detected", async () => {
  const echo = await resetConnectorFixture();
  const plan = { launcher: "node", entrypoint: "connector.js", cwd: ".", args: [], platform: process.platform, architecture: process.arch, environmentNames: [] };
  await assert.rejects(
    () => connectors.fingerprintDesktopConnectorTreeWithOptions(echo, plan, {
      onTreeEnumerated: async () => { await writeFile(join(echo, "connector.js"), "changed after enumeration"); },
    }),
    /changed while fingerprinting/i,
  );
});
