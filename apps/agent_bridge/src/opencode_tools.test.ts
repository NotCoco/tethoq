import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeMeshToolPath, installOpenCodeMeshTools } from "./opencode_tools.js";
import { MeshToolGateway } from "./mesh_tools.js";

test("OpenCode EYES waits for a real gateway job beyond the runtime discovery timeout", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-eyes-slow-gateway-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  const runtimePath = join(userHome, "runtime.json");
  let calls = 0;
  const gateway = new MeshToolGateway(`eyes-slow-${randomUUID()}`, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 2_400));
    return { observation: "EYES-427" };
  }, { runtimePath });
  await gateway.listen();
  context.after(() => gateway.close());
  await installOpenCodeMeshTools({ userHome });
  const source = await readFile(openCodeMeshToolPath(userHome), "utf8");
  const executableSource = source
    .replace(/import \{ tool \} from "@opencode-ai\/plugin"\r?\n/u, "")
    .replace("  const runtimes = await matchingRuntimes(name)",
      `  const runtimes = [JSON.parse(await readFile(${JSON.stringify(runtimePath)}, "utf8"))]`)
    .replace(/export const list_children[\s\S]*$/u, "export { call }\n");
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}#${randomUUID()}`);
  assert.equal(await loaded.call("session-one", "tethoq_turn_support", { request: "Read the card" }),
    JSON.stringify({ observation: "EYES-427" }));
  assert.equal(calls, 1, "a slow helper must not be dispatched again through another runtime");
  assert.ok(await readFile(runtimePath, "utf8"), "a busy gateway is not a stale descriptor");
});

test("OpenCode mesh tools install with session-scoped context outside the real user home", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-opencode-tools-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  await installOpenCodeMeshTools({ userHome });
  const source = await readFile(openCodeMeshToolPath(userHome), "utf8");
  assert.match(source, /context\.sessionID/);
  assert.match(source, /mesh_message_child/);
  assert.match(source, /mesh_list_sessions/);
  assert.match(source, /mesh_message_session/);
  assert.match(source, /mesh_dispatch_delegation/);
  assert.match(source, /export const dispatch_delegation/);
  assert.match(source, /context\.callID/);
  assert.match(source, /lifecycleOwner: "provider"/);
  assert.match(source, /export const tethoq_turn_support/);
  assert.match(source, /private turn-scoped Tethoq guidance/);
  assert.match(source, /args: \{ request: tool\.schema\.string\(\)\.min\(1\)\.max\(8000\) \}/);
  assert.doesNotMatch(source, /export const ask_eyes/);
  const turnSupportStart = source.indexOf("export const tethoq_turn_support");
  const turnSupportEnd = source.indexOf("\n})", turnSupportStart);
  assert.ok(turnSupportStart >= 0 && turnSupportEnd > turnSupportStart);
  // The execute path may reference the shared sanitized transport failure and
  // the not-configured classifier, but the visible definition itself must not
  // describe the private capability.
  const turnSupportBlock = source.slice(turnSupportStart, turnSupportEnd)
    .replaceAll("eyesTransportFailure", "")
    .replaceAll("RuntimeEyesNotConfiguredError", "");
  assert.doesNotMatch(turnSupportBlock, /eyes|image|visual|ask_eyes/iu,
    "the model-visible OpenCode definition must not reveal the private turn capability");
  assert.match(source, /const eyesTransportFailure = "EYES could not inspect the image\. Try again or choose another EYES model\."/,
    "unreachable EYES transport must surface one sanitized failure, never a raw pipe diagnostic");
  const expectedBrowserTools = [
    "browser_get_state", "browser_open", "browser_navigate", "browser_inspect",
    "browser_inspect_all", "browser_click", "browser_type", "browser_scroll",
    "browser_capture", "browser_activate", "browser_close", "browser_back",
    "browser_forward", "browser_reload", "browser_stop", "browser_set_muted",
  ];
  assert.deepEqual([...source.matchAll(/export const (browser_[a-z_]+) = tool\(/gu)].map((match) => match[1]), expectedBrowserTools,
    "OpenCode must receive the complete provider-neutral browser contract");
  for (const name of expectedBrowserTools) {
    assert.match(source, new RegExp(`call\\(context\\.sessionID, "${name}"`), `${name} must stay scoped to its owning Tethoq task`);
  }
  assert.match(source, /new background tab without changing the user's selected tab/);
  assert.match(source, /activate: tool\.schema\.boolean\(\)\.optional\(\)/);
  assert.match(source, /ref: tool\.schema\.string\(\)\.min\(1\)\.max\(100\)/);
  assert.match(source, /question: tool\.schema\.string\(\)\.min\(1\)\.max\(2000\)\.optional\(\)/);
  assert.match(source, /args: \{ tab_id: tool\.schema\.string\(\)\.min\(1\)\.max\(100\) \}/);
  assert.doesNotMatch(source, /UAR_MESH_TOKEN/);
});

test("OpenCode exposes every browser tool with the provider-neutral model-visible schema", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-opencode-browser-schema-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  await installOpenCodeMeshTools({ userHome });
  const source = await readFile(openCodeMeshToolPath(userHome), "utf8");
  const schemaNode = String.raw`
const schemaNode = (kind, values = {}) => {
  const node = { kind, ...values }
  Object.defineProperties(node, {
    min: { value: (value) => schemaNode(kind, { ...values, minimum: value }) },
    max: { value: (value) => schemaNode(kind, { ...values, maximum: value }) },
    int: { value: () => schemaNode(kind, { ...values, integer: true }) },
    optional: { value: () => schemaNode(kind, { ...values, isOptional: true }) },
    strict: { value: () => schemaNode(kind, { ...values, strict: true }) },
    describe: { value: (description) => schemaNode(kind, { ...values, description }) },
  })
  return node
}
const tool = Object.assign((definition) => definition, { schema: {
  string: () => schemaNode("string"),
  number: () => schemaNode("number"),
  boolean: () => schemaNode("boolean"),
  enum: (values) => schemaNode("enum", { values }),
  array: (items) => schemaNode("array", { items }),
  object: (properties) => schemaNode("object", { properties }),
} })`;
  const executableSource = source.replace(/import \{ tool \} from "@opencode-ai\/plugin"\r?\n/u, schemaNode);
  assert.notEqual(executableSource, source);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}#${randomUUID()}`) as Record<string, {
    readonly description: string;
    readonly args: Record<string, unknown>;
  }>;
  const browserTools = Object.fromEntries(Object.entries(loaded).filter(([name]) => name.startsWith("browser_")));
  assert.deepEqual(Object.keys(browserTools).sort(), [
    "browser_activate", "browser_back", "browser_capture", "browser_click", "browser_close",
    "browser_forward", "browser_get_state", "browser_inspect", "browser_inspect_all", "browser_navigate",
    "browser_open", "browser_reload", "browser_scroll", "browser_set_muted", "browser_stop", "browser_type",
  ]);
  assert.deepEqual(browserTools.browser_click?.args.ref, { kind: "string", minimum: 1, maximum: 100 });
  assert.deepEqual(browserTools.browser_type?.args.ref, { kind: "string", minimum: 1, maximum: 100 });
  assert.deepEqual(browserTools.browser_type?.args.text, { kind: "string", maximum: 20_000 });
  assert.deepEqual(browserTools.browser_capture?.args.question, { kind: "string", minimum: 1, maximum: 2_000, isOptional: true });
  assert.deepEqual(browserTools.browser_activate?.args.tab_id, { kind: "string", minimum: 1, maximum: 100 });
  assert.deepEqual(browserTools.browser_close?.args.tab_id, { kind: "string", minimum: 1, maximum: 100 });
  assert.deepEqual(browserTools.browser_inspect_all?.args.max_text_per_tab, {
    kind: "number", integer: true, minimum: 250, maximum: 20_000, isOptional: true,
  });
  assert.deepEqual(browserTools.browser_scroll?.args.delta_y, {
    kind: "number", integer: true, minimum: -4_000, maximum: 4_000, isOptional: true,
  });
  for (const [name, definition] of Object.entries(browserTools)) {
    assert.match(definition.description, /browser|page|tab/iu, `${name} needs model-visible browser guidance`);
  }
});

test("OpenCode mesh finds the task-owning runtime without masking real EYES failures", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-opencode-runtime-fallback-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  await installOpenCodeMeshTools({ userHome });
  const source = await readFile(openCodeMeshToolPath(userHome), "utf8");
  const executableSource = source
    .replace(/import \{ tool \} from "@opencode-ai\/plugin"\r?\n/u, "")
    .replace(
      "  const runtimes = await matchingRuntimes(name)",
      "  const runtimes = globalThis.__uarMeshTestRuntimes ?? await matchingRuntimes(name)",
    )
    .replace(/export const list_children[\s\S]*$/u, "export { call }\n");
  assert.notEqual(executableSource, source, "the installed plugin fixture must expose its real runtime call path");
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}#${randomUUID()}`) as {
    readonly call: (sessionId: string, name: string, input: Record<string, unknown>) => Promise<string>;
  };
  const semanticFailure = await runtimeFixture({ ok: false, error: "EYES usage limit fixture" });
  const notConfigured = await runtimeFixture({ ok: false, code: "EYES_NOT_CONFIGURED", error: "No visual-support model is configured for this session." });
  const notOwner = await runtimeFixture({ ok: false, code: "TASK_NOT_OWNED_HERE", error: "Task is owned by another Tethoq runtime" });
  const success = await runtimeFixture({ ok: true, result: { observation: "visible fixture" } });
  const testGlobal = globalThis as typeof globalThis & { __uarMeshTestRuntimes?: readonly RuntimeFixture[] };
  context.after(async () => {
    delete testGlobal.__uarMeshTestRuntimes;
    await semanticFailure.close();
    await notConfigured.close();
    await notOwner.close();
    await success.close();
  });
  const staleRuntime: RuntimeFixture = {
    hostId: "host-stale",
    pipePath: unavailablePipePath(),
    token: "stale-token",
  };

  testGlobal.__uarMeshTestRuntimes = [semanticFailure.runtime, success.runtime];
  await assert.rejects(
    loaded.call("session-one", "tethoq_turn_support", { request: "What is visible?" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "EYES usage limit fixture");
      return true;
    },
  );
  assert.equal(success.requestCount(), 0, "usage, auth, helper, and provider failures must remain terminal");

  testGlobal.__uarMeshTestRuntimes = [notConfigured.runtime, success.runtime];
  assert.equal(
    await loaded.call("session-one", "tethoq_turn_support", { request: "What is visible?" }),
    JSON.stringify({ observation: "visible fixture" }),
    "a cached task without EYES configuration must not mask the runtime that owns its EYES configuration",
  );
  assert.equal(notConfigured.requestCount(), 1);
  assert.equal(success.requestCount(), 1);

  testGlobal.__uarMeshTestRuntimes = [notOwner.runtime, success.runtime];
  assert.equal(
    await loaded.call("session-one", "tethoq_turn_support", { request: "What is visible?" }),
    JSON.stringify({ observation: "visible fixture" }),
  );
  assert.equal(notOwner.requestCount(), 1);
  assert.equal(success.requestCount(), 2, "a typed ownership miss must continue to the runtime that owns the task");

  testGlobal.__uarMeshTestRuntimes = [staleRuntime, success.runtime];
  assert.equal(
    await loaded.call("session-one", "tethoq_turn_support", { request: "What is visible?" }),
    JSON.stringify({ observation: "visible fixture" }),
  );
  assert.equal(success.requestCount(), 3, "an unreachable stale runtime must not hide a live owner");

  testGlobal.__uarMeshTestRuntimes = [notConfigured.runtime];
  await assert.rejects(
    loaded.call("session-one", "tethoq_turn_support", { request: "What is visible?" }),
    (error: unknown) => {
      assert.equal((error as Error).message, "No visual-support model is configured for this session.");
      return true;
    },
  );
});

test("OpenCode mesh skips a connected runtime that never responds", { timeout: 2_000 }, async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-opencode-runtime-timeout-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  await installOpenCodeMeshTools({ userHome });
  const source = await readFile(openCodeMeshToolPath(userHome), "utf8");
  assert.match(source, /const runtimeResponseTimeoutMs = 2_000/);
  const executableSource = source
    .replace(/import \{ tool \} from "@opencode-ai\/plugin"\r?\n/u, "")
    .replace("const runtimeResponseTimeoutMs = 2_000", "const runtimeResponseTimeoutMs = 25")
    .replace(
      "  const runtimes = await matchingRuntimes(name)",
      "  const runtimes = globalThis.__uarMeshTestRuntimes ?? await matchingRuntimes(name)",
    )
    .replace(/export const list_children[\s\S]*$/u, "export { call }\n");
  assert.match(executableSource, /const runtimeResponseTimeoutMs = 25/);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}#${randomUUID()}`) as {
    readonly call: (sessionId: string, name: string, input: Record<string, unknown>) => Promise<string>;
  };

  const requestOrder: string[] = [];
  const silentRuntime = await runtimeFixture(silentRuntimeResponse, () => requestOrder.push("silent"));
  const liveOwner = await runtimeFixture(
    { ok: true, result: { children: [{ id: "child-live" }] } },
    () => requestOrder.push("live"),
  );
  const testGlobal = globalThis as typeof globalThis & { __uarMeshTestRuntimes?: readonly RuntimeFixture[] };
  context.after(async () => {
    delete testGlobal.__uarMeshTestRuntimes;
    await silentRuntime.close();
    await liveOwner.close();
  });

  testGlobal.__uarMeshTestRuntimes = [silentRuntime.runtime, liveOwner.runtime];
  assert.equal(
    await loaded.call("session-one", "mesh_list_children", {}),
    JSON.stringify({ children: [{ id: "child-live" }] }),
  );
  assert.deepEqual(requestOrder, ["silent", "live"]);
  assert.equal(silentRuntime.requestCount(), 1);
  assert.equal(liveOwner.requestCount(), 1);
});

test("OpenCode mesh recovers from a stale configured descriptor through current deduplicated runtimes", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-opencode-runtime-descriptors-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  const configuredRuntimePath = join(userHome, "configured-runtime.json");
  const legacyRuntimePath = join(userHome, ".tethoq", "mesh-tool-runtime.json");
  const runtimeDirectory = join(userHome, ".tethoq", "mesh-runtimes");
  await mkdir(runtimeDirectory, { recursive: true });
  await installOpenCodeMeshTools({ userHome });
  const source = await readFile(openCodeMeshToolPath(userHome), "utf8");
  const executableSource = source
    .replace(/import \{ tool \} from "@opencode-ai\/plugin"\r?\n/u, "")
    .replace("const configuredRuntimePath = process.env.UAR_MESH_RUNTIME", `const configuredRuntimePath = ${JSON.stringify(configuredRuntimePath)}`)
    .replace("const legacyRuntimePath = join(homedir(), \".tethoq\", \"mesh-tool-runtime.json\")", `const legacyRuntimePath = ${JSON.stringify(legacyRuntimePath)}`)
    .replace("const runtimeDirectory = join(homedir(), \".tethoq\", \"mesh-runtimes\")", `const runtimeDirectory = ${JSON.stringify(runtimeDirectory)}`)
    .replace(/export const list_children[\s\S]*$/u, "export { call }\n");
  assert.notEqual(executableSource, source);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}#${randomUUID()}`) as {
    readonly call: (sessionId: string, name: string, input: Record<string, unknown>) => Promise<string>;
  };

  const requestOrder: string[] = [];
  const configuredMiss = await runtimeFixture(
    { ok: false, code: "TASK_NOT_OWNED_HERE", error: "Task is owned by another Tethoq runtime" },
    () => requestOrder.push("configured"),
  );
  const liveOwner = await runtimeFixture(
    { ok: true, result: { tabs: [{ id: "tab-live" }] } },
    () => requestOrder.push("live"),
  );
  context.after(async () => {
    await configuredMiss.close();
    await liveOwner.close();
  });

  const configuredRuntime = {
    ...configuredMiss.runtime,
    startedAt: "2020-01-01T00:00:00.000Z",
    tools: ["browser_get_state"],
  };
  const duplicateRuntime = { ...configuredRuntime, startedAt: "9999-01-01T00:00:00.000Z" };
  const liveRuntime = {
    ...liveOwner.runtime,
    startedAt: "2026-01-01T00:00:00.000Z",
    tools: ["browser_get_state"],
  };
  const duplicateRuntimePath = join(runtimeDirectory, "configured-copy.json");
  const liveRuntimePath = join(runtimeDirectory, "live.json");
  await writeFile(configuredRuntimePath, JSON.stringify(configuredRuntime));
  await writeFile(duplicateRuntimePath, JSON.stringify(duplicateRuntime));
  await writeFile(liveRuntimePath, JSON.stringify(liveRuntime));

  assert.equal(
    await loaded.call("session-one", "browser_get_state", {}),
    JSON.stringify({ tabs: [{ id: "tab-live" }] }),
  );
  assert.deepEqual(requestOrder, ["configured", "live"],
    "the configured descriptor stays first and its discovered duplicate is not called twice");
  assert.equal(configuredMiss.requestCount(), 1);

  requestOrder.length = 0;
  await rm(configuredRuntimePath);
  await rm(duplicateRuntimePath);
  assert.equal(
    await loaded.call("session-one", "browser_get_state", {}),
    JSON.stringify({ tabs: [{ id: "tab-live" }] }),
    "a deleted configured descriptor must fall through to current runtime discovery",
  );
  assert.deepEqual(requestOrder, ["live"]);

  requestOrder.length = 0;
  await writeFile(configuredRuntimePath, JSON.stringify({
    hostId: "host-stale",
    pipePath: unavailablePipePath(),
    token: "stale-token",
    startedAt: "9999-01-01T00:00:00.000Z",
    tools: ["browser_get_state"],
  }));
  assert.equal(
    await loaded.call("session-one", "browser_get_state", {}),
    JSON.stringify({ tabs: [{ id: "tab-live" }] }),
    "an unreachable configured descriptor must fall through to the current task owner",
  );
  assert.deepEqual(requestOrder, ["live"]);
});

test("OpenCode mesh prefers the ownership miss over later connect noise and prunes dead descriptors", async (context) => {
  const userHome = await mkdtemp(join(tmpdir(), "tethoq-opencode-runtime-prune-"));
  context.after(() => rm(userHome, { recursive: true, force: true }));
  const configuredRuntimePath = join(userHome, "configured-runtime.json");
  const legacyRuntimePath = join(userHome, ".tethoq", "mesh-tool-runtime.json");
  const runtimeDirectory = join(userHome, ".tethoq", "mesh-runtimes");
  await mkdir(runtimeDirectory, { recursive: true });
  await installOpenCodeMeshTools({ userHome });
  const source = await readFile(openCodeMeshToolPath(userHome), "utf8");
  const executableSource = source
    .replace(/import \{ tool \} from "@opencode-ai\/plugin"\r?\n/u, "")
    .replace("const configuredRuntimePath = process.env.UAR_MESH_RUNTIME", `const configuredRuntimePath = ${JSON.stringify(configuredRuntimePath)}`)
    .replace("const legacyRuntimePath = join(homedir(), \".tethoq\", \"mesh-tool-runtime.json\")", `const legacyRuntimePath = ${JSON.stringify(legacyRuntimePath)}`)
    .replace("const runtimeDirectory = join(homedir(), \".tethoq\", \"mesh-runtimes\")", `const runtimeDirectory = ${JSON.stringify(runtimeDirectory)}`)
    .replace(/export const list_children[\s\S]*$/u, "export { call }\n");
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(executableSource).toString("base64")}#${randomUUID()}`) as {
    readonly call: (sessionId: string, name: string, input: Record<string, unknown>) => Promise<string>;
  };

  const notOwner = await runtimeFixture({ ok: false, code: "TASK_NOT_OWNED_HERE", error: "Task is owned by another Tethoq runtime" });
  context.after(() => notOwner.close());
  const deadDescriptor = {
    hostId: "host-dead",
    pipePath: unavailablePipePath(),
    token: "dead-token",
    startedAt: "9999-01-01T00:00:00.000Z",
    tools: ["mesh_list_children"],
  };
  const deadDescriptorPath = join(runtimeDirectory, "host-dead-1.json");
  await writeFile(deadDescriptorPath, JSON.stringify(deadDescriptor));
  await writeFile(join(runtimeDirectory, "live-not-owner.json"), JSON.stringify({
    ...notOwner.runtime,
    startedAt: "2020-01-01T00:00:00.000Z",
    tools: ["mesh_list_children"],
  }));

  await assert.rejects(
    loaded.call("session-one", "mesh_list_children", {}),
    (error: unknown) => {
      assert.equal((error as Error).message, "Task is owned by another Tethoq runtime");
      return true;
    },
  );
  await assert.rejects(
    () => readFile(deadDescriptorPath, "utf8"),
    "the unreachable descriptor must be pruned instead of retried on every call",
  );
});

interface RuntimeFixture {
  readonly hostId: string;
  readonly pipePath: string;
  readonly token: string;
}

const silentRuntimeResponse = Symbol("silent runtime response");

function unavailablePipePath(): string {
  const name = `tethoq-opencode-runtime-${process.pid}-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

async function runtimeFixture(response: unknown, onRequest?: () => void): Promise<{
  readonly runtime: RuntimeFixture;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
}> {
  const pipePath = unavailablePipePath();
  let requests = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      requests += 1;
      onRequest?.();
      if (response === silentRuntimeResponse) return;
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    runtime: { hostId: "host-live", pipePath, token: "fixture-token" },
    requestCount: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}
