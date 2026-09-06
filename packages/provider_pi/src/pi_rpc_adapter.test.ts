import assert from "node:assert/strict";
import test from "node:test";
import type { JsonRpcTransport } from "../../provider_contract/src/index.js";
import { PiRpcProviderAdapter, piHarnessPresets } from "./pi_rpc_adapter.js";

class FakePiTransport implements JsonRpcTransport {
  public closeCalls = 0;
  readonly listeners = new Set<(message: unknown) => void>();
  readonly sent: Array<Record<string, unknown>> = [];
  readonly blockedCommands = new Set<string>();
  readonly closeListeners = new Set<(error: Error) => void>();

  public async send(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const frame = message as Record<string, unknown>;
    this.sent.push(frame);
    if (typeof frame.id !== "string" || typeof frame.type !== "string") return;
    if (this.blockedCommands.has(frame.type)) return;
    let data: unknown = {};
    if (frame.type === "get_state") data = { sessionId: "pi-session", sessionName: "RPC", isStreaming: false, model: { provider: "openai", id: "gpt-test" } };
    if (frame.type === "get_session_stats") data = {
      tokens: { input: 4_000, output: 500, cacheRead: 1_000, cacheWrite: 0, total: 5_500 },
      cost: 0.12,
      contextUsage: { tokens: 5_500, contextWindow: 20_000, percent: 27.5 },
    };
    queueMicrotask(() => this.push({ id: frame.id, type: "response", command: frame.type, success: true, data }));
  }

  public onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async close(): Promise<void> { this.closeCalls += 1; }

  public onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  public push(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }
}

for (const preset of [piHarnessPresets.pi, piHarnessPresets.omp]) {
  test(`${preset.displayName} compaction waits for its completed RPC result beyond the ordinary timeout`, async (t) => {
    const transport = new FakePiTransport();
    transport.blockedCommands.add("compact");
    const adapter = new PiRpcProviderAdapter({ hostId: "host", preset, requestTimeoutMs: 10, transportFactory: () => transport });
    t.after(() => adapter.dispose());
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace" });
    let settled = false;
    const pending = adapter.compactSession(session.providerSessionId).then(() => { settled = true; });
    const duplicate = adapter.compactSession(session.providerSessionId);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(settled, false);
    const commands = transport.sent.filter(frame => frame.type === "compact");
    assert.equal(commands.length, 1);
    transport.push({ type: "response", id: commands[0]!.id, command: "compact", success: true, data: { summary: "Native summary", tokensBefore: 10000 } });
    await Promise.all([pending, duplicate]);
  });
}

for (const outcome of ["failed", "disconnect", "dispose", "timeout"]) {
  test(`Pi RPC compaction rejects on ${outcome}`, async (t) => {
    const transport = new FakePiTransport();
    transport.blockedCommands.add("compact");
    const adapter = new PiRpcProviderAdapter({ hostId: "host", preset: piHarnessPresets.pi, compactionTimeoutMs: 40, transportFactory: () => transport });
    t.after(() => adapter.dispose());
    const session = await adapter.createSession({ workingDirectory: "C:\\workspace" });
    const rejected = assert.rejects(adapter.compactSession(session.providerSessionId));
    const command = transport.sent.find(frame => frame.type === "compact")!;
    if (outcome === "failed") transport.push({ type: "response", id: command.id, command: "compact", success: false, error: "Compaction aborted" });
    if (outcome === "disconnect") for (const listener of transport.closeListeners) listener(new Error("process disconnected"));
    if (outcome === "dispose") await adapter.dispose();
    await rejected;
  });
}

test("OMP RPC exposes host tools and exact provider-reported context without a model turn", async () => {
  const transport = new FakePiTransport();
  const adapter = new PiRpcProviderAdapter({ hostId: "host", preset: piHarnessPresets.omp, transportFactory: () => transport });
  let executionContext: unknown;
  adapter.configureClientTooling({
    definitions: [{ name: "browser_inspect", description: "Inspect", inputSchema: { type: "object" } }],
    async execute(_providerId, _providerSessionId, _tool, _input, context) {
      executionContext = context;
      return {};
    },
    mcpServer() { return { name: "unused", command: "node", args: [], env: {} }; },
  });
  const session = await adapter.createSession({ workingDirectory: "C:\\workspace", title: "RPC" });
  const context = await adapter.getSessionContext(session.providerSessionId);
  transport.push({ type: "host_tool_call", id: "omp-tool-one", toolName: "browser_inspect", arguments: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.providerId, "omp");
  assert.equal(context.usedTokens, 5_500);
  assert.equal(context.contextWindowTokens, 20_000);
  assert.equal(context.usage.cost, 0.12);
  assert.ok(transport.sent.some((frame) => frame.type === "set_host_tools"));
  assert.deepEqual(executionContext, { callId: "omp-tool-one", lifecycleOwner: "bridge" });
  assert.ok(!transport.sent.some((frame) => frame.type === "prompt"));
  await adapter.dispose();
});

test("Pi EYES disables native tools and extension discovery and releases its own process", async (t) => {
  const transport = new FakePiTransport();
  let args: readonly string[] = [];
  let toolCalls = 0;
  const adapter = new PiRpcProviderAdapter({
    hostId: "host", preset: piHarnessPresets.pi, extensionPath: "C:\\normal-tools.ts",
    transportFactory: (_cwd, value) => { args = value; return transport; },
  });
  t.after(() => adapter.dispose());
  adapter.configureClientTooling({
    definitions: [{ name: "browser", description: "Browser", inputSchema: {} }],
    async execute() { toolCalls += 1; return {}; },
    mcpServer() { throw new Error("EYES must not create an MCP binding"); },
  });
  const session = await adapter.createSession({ workingDirectory: "C:\\workspace", metadata: { internalPurpose: "vision_proxy" } });
  for (const flag of ["--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]) assert.ok(args.includes(flag));
  assert.ok(!args.includes("C:\\normal-tools.ts"));
  transport.push({ type: "host_tool_call", id: "forbidden", toolName: "browser", arguments: {} });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(toolCalls, 0);
  assert.ok(transport.sent.some(frame => frame.type === "host_tool_result" && frame.isError === true));
  await adapter.releaseSession(session.providerSessionId);
  assert.equal(transport.closeCalls, 1);
});

test("Pi EYES rejects explicit extension arguments before starting a process", async () => {
  const adapter = new PiRpcProviderAdapter({
    hostId: "host", preset: piHarnessPresets.pi, commandArgs: ["--mode", "rpc", "--extension", "custom.ts"],
    transportFactory: () => { throw new Error("must not start"); },
  });
  await assert.rejects(adapter.createSession({ workingDirectory: "C:\\workspace", metadata: { internalPurpose: "vision_proxy" } }), /cannot be inherited by EYES/);
  await adapter.dispose();
});

test("rejected Pi frame handlers mark the session failed and emit agent.error without an unhandled rejection", async () => {
  const transport = new FakePiTransport();
  const adapter = new PiRpcProviderAdapter({ hostId: "host", preset: piHarnessPresets.pi, transportFactory: () => transport });
  const session = await adapter.createSession({ workingDirectory: "C:\\workspace", title: "RPC" });
  const events: Array<{ readonly type: string; readonly payload: Record<string, unknown> }> = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const subscription = await adapter.subscribe(session.providerSessionId, async (event) => {
    if (event.type === "message.started") throw new Error("event sink failed");
    events.push({ type: event.type, payload: event.payload });
  });

  try {
    transport.push({ type: "agent_start" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const page = await adapter.listSessions();
    assert.equal(page.sessions[0]?.state, "failed");
    assert.equal(page.sessions[0]?.nativeMetadata.asyncFrameError, "event sink failed");
    assert.deepEqual(events, [{
      type: "agent.error",
      payload: { message: "event sink failed", source: "rpc_frame" },
    }]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await subscription.unsubscribe();
    await adapter.dispose();
  }
});
