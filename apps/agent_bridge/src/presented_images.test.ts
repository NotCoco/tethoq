import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHostIdentity, CURRENT_PROTOCOL_VERSION, type JsonObject } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { type SendMessageRequest } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { MeshToolGateway } from "./mesh_tools.js";
import { PresentedImageStore } from "./presented_images.js";
import { BridgeRequestRouter } from "./request_router.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=", "base64");
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-presented-image-"));
  const storage = join(directory, "saved"), path = join(directory, "a picture.png");
  await writeFile(path, png);
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, storage, path, store: new PresentedImageStore(storage) };
}

test("shown images survive source deletion and restart, and retries do not duplicate them", async t => {
  const { path, storage, store } = await fixture(t);
  const first = await store.present("task", path, "The render", "render-1");
  assert.ok(JSON.stringify(first).length < 1_000, "history contains a descriptor, never image bytes");
  assert.equal(first.role, "assistant");
  await unlink(path);
  const reopened = new PresentedImageStore(storage);
  assert.deepEqual(await reopened.messages("task"), [first]);
  assert.deepEqual(await reopened.present("task", path, "The render", "render-1"), first);
  const chunk = await reopened.chunk("task", first.id, 0);
  assert.deepEqual(Buffer.from(chunk.dataBase64 as string, "base64"), png);
  assert.equal(chunk.nextOffset, null);
  await assert.rejects(reopened.present("task", path, "A different render", "render-1"), /different image presentation/);
});

test("concurrent presentations retain each distinct image and deduplicate file storage", async t => {
  const { path, storage, store } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.present("task", path, `View ${i}`, `view-${i}`)));
  assert.equal(new Set(results.map(message => message.id)).size, 8);
  assert.deepEqual((await store.messages("task")).map(message => message.id), results.map(message => message.id));
  const folders = await readdir(storage);
  assert.equal((await readdir(join(storage, folders[0]!))).length, 2, "one index and one content file");
});

test("image chunks stay bounded and cannot be retrieved through another task or invalid offsets", async t => {
  const { path, store } = await fixture(t);
  const bytes = Buffer.concat([png, Buffer.alloc(700_000)]);
  await writeFile(path, bytes);
  const message = await store.present("owner", path, "", "large");
  const first = await store.chunk("owner", message.id, 0);
  assert.ok((first.dataBase64 as string).length < 700_000);
  const second = await store.chunk("owner", message.id, first.nextOffset as number);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(Buffer.concat([first, second].map(chunk => Buffer.from(chunk.dataBase64 as string, "base64"))), bytes);
  await assert.rejects(store.chunk("other-task", message.id, 0), /does not belong/);
  for (const offset of [-1, 1, NaN, bytes.length]) await assert.rejects(store.chunk("owner", message.id, offset), /offset/);
  await assert.rejects(store.chunk("owner", "../../secret", 0), /invalid/);
});

test("bad image requests fail without poisoning the next presentation", async t => {
  const { path, store } = await fixture(t);
  for (const invalid of ["relative.png", "https://example.com/image.png", "\\\\server\\share\\image.png"]) {
    await assert.rejects(store.present("task", invalid, "", "bad-path"), /absolute local/);
  }
  await writeFile(path, "This is text disguised as a PNG");
  await assert.rejects(store.present("task", path, "", "bad-image"), /not a supported image/);
  await writeFile(path, Buffer.alloc(25 * 1024 * 1024 + 1));
  await assert.rejects(store.present("task", path, "", "oversize"), /25 MB/);
  await writeFile(path, png);
  await store.present("task", path, "", "valid");
  assert.equal((await store.messages("task")).length, 1);
});

for (const providerId of ["opencode", "grok", "codex", "pi"]) {
  test(`${providerId} receives the image tool and images persist without ending its active turn`, async t => {
    const { path, directory, storage } = await fixture(t);
    const hostId = `image-${providerId}`;
    class Provider extends FakeProviderAdapter {
      sends: SendMessageRequest[] = [];
      constructor() { super({ hostId, providerId, sessionCount: 1 }); }
      override async sendMessage(_id: string, request: SendMessageRequest) {
        this.sends.push(request);
        return { accepted: true, details: [] };
      }
    }
    const provider = new Provider();
    const config = { version: 1 as const, hostId, displayName: "Image test", enabledProviders: [providerId], identity: createHostIdentity() };
    const bridge = new AgentBridge(config, [provider], { presentedImageDirectory: storage });
    const gateway = new MeshToolGateway(hostId, (parent, tool, input, context) => bridge.executeClientTool(parent, tool, input, context), { runtimePath: join(directory, "runtime.json") });
    // Register this cleanup before the filesystem fixture's cleanup runs.
    t.after(async () => { await gateway.close(); await bridge.dispose(); });
    await gateway.listen();
    bridge.configureClientTooling(gateway);
    await bridge.start();
    const session = (await bridge.refresh()).sessions[0]!;
    await bridge.sendMessage(session.id, { requestId: "turn", content: "Show the render" });
    const toolName = providerId === "opencode" ? "uar_mesh_tethoq_show_image" : "tethoq_show_image";
    assert.ok(provider.sends[0]!.developerInstructions?.includes(toolName));
    assert.ok(gateway.definitions.some(tool => tool.name === "tethoq_show_image"));
    const stateBefore = bridge.sessions().find(item => item.id === session.id)!.state;
    assert.equal(stateBefore, "working");
    const input = { path, caption: "The render", request_id: "tool-1" };
    const result = await gateway.executeForParent(session.id, "tethoq_show_image", input);
    assert.equal((result as JsonObject).shown, true);
    await gateway.executeForParent(session.id, "tethoq_show_image", input);
    const events = bridge.eventsSince(0).filter(event => event.payload.tethoqPresentedImage === true);
    assert.ok(events.length > 0);
    assert.ok(events.every(event => event.type === "message.completed" && event.payload.requiresHistoryRefresh === true));
    assert.equal(bridge.sessions().find(item => item.id === session.id)!.state, stateBefore);
    const history = await bridge.openSession(session.id);
    const shown = history.messages.filter(message => message.nativeMetadata.tethoqPresentedImage === true);
    assert.equal(shown.length, 1);
    const router = new BridgeRequestRouter(bridge);
    const response = await router.handle({ protocolVersion: CURRENT_PROTOCOL_VERSION, kind: "request", type: "session.image.get",
      hostId, requestId: "image-chunk", messageId: "image-chunk", sentAt: new Date().toISOString(),
      payload: { sessionId: session.id, retrievalId: shown[0]!.id, offset: 0 } });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.deepEqual(Buffer.from(response.payload.dataBase64 as string, "base64"), png);
    await unlink(path);
    await bridge.dispose();
    const reopened = new AgentBridge(config, [new Provider()], { presentedImageDirectory: storage });
    try {
      await reopened.start();
      await reopened.refresh();
      assert.equal((await reopened.openSession(session.id)).messages.filter(message => message.id === shown[0]!.id).length, 1);
    } finally { await reopened.dispose(); }
  });
}

test("the actual MCP server advertises and routes image display and goal control", async t => {
  const { directory, path } = await fixture(t);
  const calls: { parent: string; tool: string; input: JsonObject }[] = [];
  const gateway = new MeshToolGateway("image-mcp", async (parent, tool, input) => {
    calls.push({ parent, tool, input });
    return { shown: true };
  }, { runtimePath: join(directory, "runtime.json") });
  await gateway.listen();
  const mcp = gateway.sharedMcpServer();
  const client = new Client({ name: "image-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: mcp.command, args: [...mcp.args], env: { ...mcp.env, UAR_MESH_PARENT_SESSION_ID: "image-mcp/grok/task" }, stderr: "pipe" }));
    const listed = await client.listTools();
    assert.ok(listed.tools.some(tool => tool.name === "tethoq_show_image"));
    assert.ok(listed.tools.some(tool => tool.name === "tethoq_goal"));
    const result = await client.callTool({ name: "tethoq_show_image", arguments: { path, request_id: "mcp-1" } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls[0], { parent: "image-mcp/grok/task", tool: "tethoq_show_image", input: { path, request_id: "mcp-1" } });
    await client.callTool({ name: "tethoq_goal", arguments: { status: "complete" } });
    assert.equal(calls[1]!.tool, "tethoq_goal");
    assert.deepEqual(calls[1]!.input, { status: "complete" });
  } finally { await client.close(); await gateway.close(); }
});
