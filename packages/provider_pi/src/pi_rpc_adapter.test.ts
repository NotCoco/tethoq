import assert from "node:assert/strict";
import test from "node:test";
import type { JsonRpcTransport } from "../../provider_contract/src/index.js";
import { PiRpcProviderAdapter, piHarnessPresets } from "./pi_rpc_adapter.js";

class FakePiTransport implements JsonRpcTransport {
  readonly listeners = new Set<(message: unknown) => void>();
  readonly sent: Array<Record<string, unknown>> = [];

  public async send(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return;
    const frame = message as Record<string, unknown>;
    this.sent.push(frame);
    if (typeof frame.id !== "string" || typeof frame.type !== "string") return;
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

  public async close(): Promise<void> {}

  public push(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }
}

test("OMP RPC exposes host tools and exact provider-reported context without a model turn", async () => {
  const transport = new FakePiTransport();
  const adapter = new PiRpcProviderAdapter({ hostId: "host", preset: piHarnessPresets.omp, transportFactory: () => transport });
  adapter.configureClientTooling({
    definitions: [{ name: "browser_inspect", description: "Inspect", inputSchema: { type: "object" } }],
    async execute() { return {}; },
    mcpServer() { return { name: "unused", command: "node", args: [], env: {} }; },
  });
  const session = await adapter.createSession({ workingDirectory: "C:\\workspace", title: "RPC" });
  const context = await adapter.getSessionContext(session.providerSessionId);
  assert.equal(session.providerId, "omp");
  assert.equal(context.usedTokens, 5_500);
  assert.equal(context.contextWindowTokens, 20_000);
  assert.equal(context.usage.cost, 0.12);
  assert.ok(transport.sent.some((frame) => frame.type === "set_host_tools"));
  assert.ok(!transport.sent.some((frame) => frame.type === "prompt"));
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
