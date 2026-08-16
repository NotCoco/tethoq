import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";
import { callMeshToolGateway, MeshToolGateway } from "./mesh_tools.js";
import { meshToolDefinitions } from "./mesh_tools.js";

test("mesh tools expose bounded task discovery and isolated cross-task messaging", () => {
  const discovery = meshToolDefinitions.find((tool) => tool.name === "mesh_list_sessions");
  const messaging = meshToolDefinitions.find((tool) => tool.name === "mesh_message_session");
  assert.equal(discovery?.inputSchema.additionalProperties, false);
  assert.deepEqual(messaging?.inputSchema.required, ["target_session_id", "message", "request_id"]);
  assert.match(messaging?.description ?? "", /never steers/i);
});

test("mesh gateway authenticates and carries scoped parent context", async (t) => {
  const calls: unknown[] = [];
  const gateway = new MeshToolGateway("host-tools", async (parentSessionId, tool, input) => {
    calls.push({ parentSessionId, tool, input });
    return { ok: true };
  });
  t.after(() => gateway.close());
  await gateway.listen();

  const result = await gateway.executeForParent("host-tools/parent/session-one", "mesh_list_children", {});
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    parentSessionId: "host-tools/parent/session-one",
    tool: "mesh_list_children",
    input: {},
  }]);
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

test("deferred ACP MCP bindings resolve only to the session returned by session/new", async (t) => {
  const calls: string[] = [];
  const gateway = new MeshToolGateway("host-binding", async (parentSessionId) => {
    calls.push(parentSessionId);
    return { ok: true };
  });
  t.after(() => gateway.close());
  await gateway.listen();
  const binding = gateway.createSessionBinding("qwen");
  const { UAR_MESH_PIPE: pipePath, UAR_MESH_TOKEN: token, UAR_MESH_BINDING_ID: bindingId } = binding.server.env;
  if (pipePath === undefined || token === undefined || bindingId === undefined) throw new Error("binding environment is incomplete");

  await assert.rejects(
    () => callMeshToolGateway(pipePath, token, undefined, "browser_get_state", {}, bindingId),
    /binding is not ready/,
  );
  binding.bind("session-one");
  assert.deepEqual(await callMeshToolGateway(pipePath, token, undefined, "browser_get_state", {}, bindingId), { ok: true });
  assert.deepEqual(calls, ["host-binding/qwen/session-one"]);
});
