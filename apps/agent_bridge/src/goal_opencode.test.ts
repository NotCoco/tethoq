import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, makeGlobalSessionId, type JsonObject } from "../../../packages/protocol/src/index.js";
import { OpenCodeAdapter } from "../../../packages/provider_opencode/src/opencode_adapter.js";
import { stripProviderPromptGuidance } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";

const hostId = "goal-context-test";
const nativeId = "context-goal";
const sessionId = makeGlobalSessionId(hostId, "opencode", nativeId);
const overflow = { name: "ContextOverflowError", data: { message: "Payload Too Large" } };
type Entry = { info: JsonObject; parts: JsonObject[] };

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(label);
}

/** Real adapter/bridge, isolated native HTTP history and SSE; no model requests. */
class NativeGoalFixture {
  readonly history: Entry[] = [];
  readonly prompts: JsonObject[] = [];
  readonly session = { id: nativeId, title: "Keep improving the asset", directory: "C:/fixture", time: { created: 1, updated: 1 } };
  stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  aborted = 0;
  summarized = 0;
  nativeState = "busy";
  readonly provider = new OpenCodeAdapter({
    hostId, baseUrl: "http://goal-fixture.invalid/", directory: "C:/fixture",
    activityReader: { readWorkingSessionIds: async () => new Set<string>(), close() {} },
    activityPollIntervalMs: 60_000, nativeStatusPollIntervalMs: 30,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const path = url.pathname;
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (path === "/global/event") return new Response(new ReadableStream<Uint8Array>({
        start: controller => {
          this.stream = controller;
          init?.signal?.addEventListener("abort", () => { this.stream = undefined; try { controller.close(); } catch {} }, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
      if (path === "/global/health") return json({ healthy: true, version: "1.18.21" });
      if (path === "/provider") return json({ connected: ["test"], all: [{ id: "test", models: { model: { id: "model", variants: { max: {} } } } }] });
      if (path === "/session") return json([this.session]);
      if (path === "/session/status") return json(this.nativeState === "busy" ? { [nativeId]: { type: "busy" } } : {});
      if (path === `/session/${nativeId}`) return json(this.session);
      if (path.endsWith("/prompt_async")) {
        const body = JSON.parse(String(init?.body)) as JsonObject;
        this.prompts.push(body);
        this.history.push({ info: { id: body.messageID!, role: "user", time: { created: this.prompts.length * 100 } }, parts: body.parts as JsonObject[] });
        this.nativeState = "busy";
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/message")) return json(this.history.slice(-Number(url.searchParams.get("limit") ?? 500)));
      if (path.includes("/message/")) return json(this.history.find(row => row.info.id === path.split("/").at(-1)));
      if (path.endsWith("/abort")) { this.aborted++; return json(true); }
      if (path.endsWith("/summarize")) { this.summarized++; throw new Error("Native recovery must not dispatch a second compaction"); }
      return new Response("not found", { status: 404 });
    },
  });
  readonly bridge = new AgentBridge({ version: 1, hostId, displayName: "Goal fixture", identity: createHostIdentity(), enabledProviders: ["opencode"] }, [this.provider]);

  async start(owned = true): Promise<void> {
    this.bridge.configureClientTooling({ definitions: [], execute: async () => null, mcpServer: () => ({ name: "goal-test", command: "node", args: [], env: {} }) });
    await this.bridge.start();
    await this.bridge.refresh();
    await waitFor(() => this.stream !== undefined, "native event subscription");
    await this.bridge.setSessionGoal(sessionId, { objective: "Finish every visual requirement and verify the result" });
    if (owned) await this.bridge.sendMessage(sessionId, { requestId: "initial-goal", content: "Keep working", modelId: "test/model", reasoningEffort: "max" });
    else this.message({ id: "outside-user", role: "user", time: { created: 100 } });
  }

  emit(type: string, properties: JsonObject = {}): void {
    this.stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ payload: { type, properties: { sessionID: nativeId, ...properties } } })}\n\n`));
  }

  message(info: JsonObject, parts: JsonObject[] = [], publish = true): void {
    const row = { info: { sessionID: nativeId, ...info }, parts };
    const index = this.history.findIndex(entry => entry.info.id === info.id);
    if (index < 0) this.history.push(row); else this.history[index] = row;
    if (publish) this.emit("message.updated", { info: row.info });
  }

  async overflow(): Promise<void> {
    this.emit("session.error", { error: overflow });
    await waitFor(() => this.bridge.eventsSince(0).some(event => event.payload.recovery === "native_compaction"), "overflow is a native recovery notification");
    assert.equal((await this.bridge.sessionGoal(sessionId))?.status, "active");
    assert.equal(this.provider.hasActiveTurn(nativeId), true, "native compaction still owns the turn");
  }

  summary(error?: JsonObject, publish = true): void {
    this.message({ id: "compaction-marker", role: "user", time: { created: 120 } }, [{ type: "compaction", auto: true, overflow: true }]);
    this.message({ id: "summary", role: "assistant", parentID: "compaction-marker", mode: "compaction", summary: true,
      time: { created: 125, completed: 130 }, finish: error ? "error" : "stop", ...(error ? { error } : {}) }, [], publish);
  }
}

test("OpenCode goal survives native overflow, compaction and continuation before resuming once", async t => {
  const fixture = new NativeGoalFixture();
  t.after(() => fixture.bridge.dispose());
  await fixture.start();
  await fixture.overflow();
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(fixture.prompts.length, 1, "overflow cannot start another goal turn");
  fixture.summary();
  fixture.message({ id: "native-continue", role: "user", time: { created: 140 } });
  fixture.message({ id: "working", role: "assistant", parentID: "native-continue", time: { created: 145 }, finish: "tool-calls" },
    [{ type: "tool", tool: "bash", state: { status: "running" } }]);
  await new Promise(resolve => setTimeout(resolve, 850));
  assert.equal(fixture.prompts.length, 1, "a summary is not the end of native work");
  fixture.message({ id: "final-progress", role: "assistant", parentID: "native-continue", time: { created: 150, completed: 155 }, finish: "stop" },
    [{ type: "text", text: "Progress verified. Quality gate still fails; three requirements remain." }]);
  fixture.nativeState = "idle";
  fixture.emit("session.idle");
  await waitFor(() => fixture.prompts.length === 2, "unfinished active goal continues after the actual final");
  assert.equal(stripProviderPromptGuidance(String((fixture.prompts[1]!.parts as JsonObject[])[0]!.text)), "");
  assert.deepEqual(fixture.prompts[1]!.model, { providerID: "test", modelID: "model" });
  assert.equal(fixture.prompts[1]!.variant, "max");
  assert.equal((await fixture.bridge.sessionGoal(sessionId))?.status, "active");
  assert.equal(fixture.bridge.eventsSince(0).filter(event => event.type === "agent.error").length, 0);
  assert.equal(fixture.summarized, 0);
  assert.equal(fixture.aborted, 0);
  await fixture.bridge.executeClientTool(sessionId, "tethoq_goal", { status: "complete" });
});

for (const failure of ["summary", "missing-failure-event", "compaction-disabled", "older-failure", "outside-failure", "outside-missing-failure-event"] as const) {
  test(`OpenCode goal distinguishes terminal context failure from native recovery: ${failure}`, async t => {
    const fixture = new NativeGoalFixture();
    t.after(() => fixture.bridge.dispose());
    const owned = !failure.startsWith("outside-");
    await fixture.start(owned);
    await fixture.overflow();
    if (failure === "older-failure") {
      await fixture.bridge.sendMessage(sessionId, { requestId: "new-user-turn", content: "A newer instruction" });
    }
    if (failure === "compaction-disabled") {
      fixture.message({ id: "failed-answer", role: "assistant", parentID: fixture.prompts[0]!.messageID!, time: { created: 115, completed: 130 }, error: overflow });
    } else {
      fixture.summary({ name: "ContextOverflowError", data: { message: "Conversation history too large to compact" } }, !failure.endsWith("missing-failure-event"));
    }
    fixture.nativeState = "idle";
    fixture.emit("session.idle");
    if (failure === "older-failure") {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      assert.equal((await fixture.bridge.sessionGoal(sessionId))?.status, "active", "old compaction failure cannot stall newer work");
      assert.equal(fixture.provider.hasActiveTurn(nativeId), true);
    } else {
      await waitFor(async () => (await fixture.bridge.sessionGoal(sessionId))?.status === "blocked", "confirmed unrecoverable context failure stops automatic retries");
      await new Promise(resolve => setTimeout(resolve, 850));
      assert.equal(fixture.provider.hasActiveTurn(nativeId), false);
      assert.equal(fixture.bridge.eventsSince(0).filter(event => event.type === "agent.error").length, 1);
      assert.equal(fixture.prompts.length, owned ? 1 : 0);
    }
    assert.equal(fixture.summarized, 0);
    assert.equal(fixture.aborted, 0);
  });
}
