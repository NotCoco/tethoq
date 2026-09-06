import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callMeshToolGateway, MeshToolGateway, pruneStaleMeshRuntimes } from "./mesh_tools.js";
import { meshToolDefinitions } from "./mesh_tools.js";

test("mesh tools expose bounded task discovery and isolated cross-task messaging", () => {
  const discovery = meshToolDefinitions.find((tool) => tool.name === "mesh_list_sessions");
  const messaging = meshToolDefinitions.find((tool) => tool.name === "mesh_message_session");
  const dispatch = meshToolDefinitions.find((tool) => tool.name === "mesh_dispatch_delegation");
  const turnSupport = meshToolDefinitions.find((tool) => tool.name === "tethoq_turn_support");
  assert.equal(discovery?.inputSchema.additionalProperties, false);
  assert.deepEqual(messaging?.inputSchema.required, ["target_session_id", "message", "request_id"]);
  assert.match(messaging?.description ?? "", /never steers/i);
  const dispatchSchema = dispatch?.inputSchema as { readonly required?: unknown; readonly properties?: Record<string, unknown> } | undefined;
  assert.deepEqual(dispatchSchema?.required, ["delegation_id", "assignments"]);
  assert.deepEqual(Object.keys(dispatchSchema?.properties ?? {}), ["delegation_id", "assignments"]);
  const assignments = dispatchSchema?.properties?.assignments as { readonly items?: { readonly properties?: object; readonly additionalProperties?: boolean } } | undefined;
  assert.deepEqual(Object.keys(assignments?.items?.properties ?? {}), ["target_index", "instruction"]);
  assert.equal(assignments?.items?.additionalProperties, false);
  assert.deepEqual(turnSupport?.inputSchema.required, ["request"]);
  assert.doesNotMatch(JSON.stringify(turnSupport), /eyes|image|visual|ask_eyes/iu,
    "the provider-wide definition must not reveal the private turn capability");
});

test("mesh gateway authenticates and carries scoped parent context", async (t) => {
  const calls: unknown[] = [];
  const gateway = new MeshToolGateway("host-tools", async (parentSessionId, tool, input, context) => {
    calls.push({ parentSessionId, tool, input, context });
    return { ok: true };
  });
  t.after(() => gateway.close());
  await gateway.listen();

  const result = await gateway.executeForParent(
    "host-tools/parent/session-one",
    "mesh_list_children",
    {},
    { callId: "connector-call-one", lifecycleOwner: "bridge" },
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    parentSessionId: "host-tools/parent/session-one",
    tool: "mesh_list_children",
    input: {},
    context: { callId: "connector-call-one", lifecycleOwner: "bridge" },
  }]);
});

test("mesh gateway preserves the typed task-ownership miss without typing other failures", async (t) => {
  const gateway = new MeshToolGateway("host-routing", async (_parentSessionId, tool) => {
    if (tool === "tethoq_turn_support") {
      throw Object.assign(new Error("This Tethoq runtime does not own that task"), { code: "TASK_NOT_OWNED_HERE" });
    }
    throw new Error("EYES usage limit reached");
  });
  t.after(() => gateway.close());
  await gateway.listen();

  await assert.rejects(
    () => gateway.executeForParent("host-routing/opencode/session-one", "tethoq_turn_support", { request: "What is visible?" }),
    (error: unknown) => error instanceof Error
      && error.message === "This Tethoq runtime does not own that task"
      && (error as Error & { readonly code?: string }).code === "TASK_NOT_OWNED_HERE",
  );
  await assert.rejects(
    () => gateway.executeForParent("host-routing/opencode/session-one", "mesh_list_children", {}),
    (error: unknown) => error instanceof Error
      && error.message === "EYES usage limit reached"
      && (error as Error & { readonly code?: string }).code === undefined,
  );
});

test("mesh gateway closes idle client sockets without hanging shutdown", async () => {
  const gateway = new MeshToolGateway("host-close", async () => ({ ok: true }));
  await gateway.listen();
  const pipePath = gateway.sharedMcpServer().env.UAR_MESH_PIPE;
  if (pipePath === undefined) throw new Error("mesh pipe path is missing");
  const socket = createConnection(pipePath);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  await Promise.race([
    gateway.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("gateway close timed out")), 1_000)),
  ]);
  assert.equal(socket.destroyed, true);
});

test("mesh gateway tags its descriptor with its process identity", async (t) => {
  const gateway = new MeshToolGateway("host-descriptor-identity", async () => ({ ok: true }));
  t.after(() => gateway.close());
  await gateway.listen();
  const runtimePath = gateway.sharedMcpServer().env.UAR_MESH_RUNTIME;
  if (runtimePath === undefined) throw new Error("mesh runtime path is missing");
  const descriptor = JSON.parse(await readFile(runtimePath, "utf8")) as Record<string, unknown>;
  assert.equal(descriptor.hostId, "host-descriptor-identity");
  assert.equal(descriptor.pid, process.pid);
  assert.equal(typeof descriptor.pipePath, "string");
});

test("stale mesh descriptors are pruned by pipe reachability, never by PID alone", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-mesh-prune-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const livePipePath = meshTestPipePath();
  const liveServer = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    liveServer.once("error", reject);
    liveServer.listen(livePipePath, () => {
      liveServer.off("error", reject);
      resolve();
    });
  });
  context.after(() => liveServer.close());
  const deadPipePath = meshTestPipePath();
  await writeFile(join(directory, "host-prune-111.json"), JSON.stringify({
    hostId: "host-prune", pipePath: deadPipePath, token: "dead-token", tools: ["tethoq_turn_support"], startedAt: "2026-01-01T00:00:00.000Z",
  }));
  await writeFile(join(directory, "host-prune-222.json"), JSON.stringify({
    hostId: "host-prune", pipePath: livePipePath, token: "live-token", tools: ["tethoq_turn_support"], startedAt: "2026-01-02T00:00:00.000Z",
  }));
  await writeFile(join(directory, "host-prune-333.json"), JSON.stringify({
    hostId: "host-prune", pipePath: deadPipePath, token: "current-token", tools: ["tethoq_turn_support"], startedAt: "2026-01-03T00:00:00.000Z",
  }));
  await writeFile(join(directory, "other-host-444.json"), JSON.stringify({
    hostId: "other-host", pipePath: deadPipePath, token: "other-token", tools: ["tethoq_turn_support"], startedAt: "2026-01-04T00:00:00.000Z",
  }));
  const pruned = await pruneStaleMeshRuntimes("host-prune", {
    runtimeDirectory: directory,
    currentRuntimePath: join(directory, "host-prune-333.json"),
  });
  assert.equal(pruned, 1);
  await assert.rejects(() => readFile(join(directory, "host-prune-111.json"), "utf8"), "an unreachable pipe must lose its descriptor");
  assert.ok((await readFile(join(directory, "host-prune-222.json"), "utf8")).includes("live-token"), "a reachable pipe must keep its descriptor");
  assert.ok((await readFile(join(directory, "host-prune-333.json"), "utf8")).includes("current-token"), "the current runtime must never prune itself");
  assert.ok((await readFile(join(directory, "other-host-444.json"), "utf8")).includes("other-token"), "another host's descriptors are not this runtime's to judge");
});

function meshTestPipePath(): string {
  const name = `tethoq-mesh-prune-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

test("deferred ACP MCP bindings resolve only to the session returned by session/new", async (t) => {
  const calls: string[] = [];
  const gateway = new MeshToolGateway("host-binding", async (parentSessionId) => {
    calls.push(parentSessionId);
    return { ok: true };
  });
  t.after(() => gateway.close());
  await gateway.listen();
  const binding = gateway.createSessionBinding("qwen", "provider");
  const { UAR_MESH_PIPE: pipePath, UAR_MESH_TOKEN: token, UAR_MESH_BINDING_ID: bindingId } = binding.server.env;
  if (pipePath === undefined || token === undefined || bindingId === undefined) throw new Error("binding environment is incomplete");
  assert.equal(binding.server.env.UAR_MESH_CLIENT_TOOL_LIFECYCLE_OWNER, "provider");

  await assert.rejects(
    () => callMeshToolGateway(pipePath, token, undefined, "browser_get_state", {}, bindingId),
    /binding is not ready/,
  );
  binding.bind("session-one");
  assert.deepEqual(await callMeshToolGateway(pipePath, token, undefined, "browser_get_state", {}, bindingId), { ok: true });
  assert.deepEqual(calls, ["host-binding/qwen/session-one"]);
});
