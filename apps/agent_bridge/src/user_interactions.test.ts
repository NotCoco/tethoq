import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PROTOCOL_VERSION, createHostIdentity, makeGlobalSessionId, type JsonObject } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { ProviderEventSink, ProviderSessionPermissions, ProviderUserInputResponse, Subscription } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { BridgeRequestRouter } from "./request_router.js";
import { UserInputRegistry } from "./user_inputs.js";

class InteractionProvider extends FakeProviderAdapter {
  sink: ProviderEventSink | undefined;
  calls: Array<{ sessionId: string; controlId: string; value: string }> = [];
  selection = "ask";
  override async subscribe(sessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.sink = sink;
    return await super.subscribe(sessionId, sink);
  }
  override async respondToUserInput(_response: ProviderUserInputResponse): Promise<void> {}
  async getSessionPermissions(): Promise<ProviderSessionPermissions> {
    return { controls: [{ id: "tools", label: "Tools", value: this.selection, options: [{ value: "ask", label: "Ask" }, { value: "deny", label: "Deny" }] }] };
  }
  async setSessionPermission(sessionId: string, controlId: string, value: string): Promise<ProviderSessionPermissions> {
    if (controlId !== "tools" || (value !== "ask" && value !== "deny")) throw new Error("Unsupported selection");
    this.calls.push({ sessionId, controlId, value });
    this.selection = value;
    return await this.getSessionPermissions();
  }
  async event(sessionId: string, type: "user_input.requested" | "user_input.resolved", payload: JsonObject): Promise<void> {
    await this.sink?.({ eventId: crypto.randomUUID(), providerId: this.providerId, providerSessionId: sessionId, type, occurredAt: new Date().toISOString(), payload });
  }
}

test("question snapshots deduplicate, resolve externally and retain the task's native running state", async (t) => {
  const provider = new InteractionProvider({ hostId: "questions", sessionCount: 2 });
  const bridge = new AgentBridge({ version: 1, hostId: "questions", displayName: "Test", identity: createHostIdentity(), enabledProviders: ["fake"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const sessions = (await bridge.refresh()).sessions;
  const session = sessions[0]!;
  const payload = { providerRequestId: "native-question", request: { title: "Question", questions: [{ id: "one", question: "Choose?" }] } };
  await provider.event(session.providerSessionId, "user_input.requested", payload);
  const id = bridge.pendingUserInputs()[0]!.requestId;
  await provider.event(session.providerSessionId, "user_input.requested", payload);
  assert.deepEqual(bridge.pendingUserInputs().map((request) => request.requestId), [id]);
  await provider.event(sessions[1]!.providerSessionId, "user_input.resolved", { providerRequestId: "native-question", reason: "cancelled" });
  assert.equal(bridge.pendingUserInputs().length, 1);
  await provider.event(session.providerSessionId, "user_input.resolved", { providerRequestId: "native-question", reason: "cancelled" });
  assert.equal(bridge.pendingUserInputs().length, 0);
  assert.ok(bridge.eventsSince(0).some((event) => event.type === "user_input.resolved" && event.payload.requestId === id));
  assert.equal(bridge.sessions().find((entry) => entry.id === session.id)?.state, "working");
  assert.ok(bridge.eventsSince(0).some((event) => event.type === "session.status_changed" && event.sessionId === session.id && event.payload.state === "working"));

  const listSessions = provider.listSessions.bind(provider);
  provider.listSessions = async (options = {}) => {
    const page = await listSessions(options);
    return { ...page, sessions: page.sessions.map((entry) => entry.id === session.id
      ? { ...entry, state: "needs_input" as const, lastActivityAt: session.lastActivityAt } : entry) };
  };
  assert.equal((await bridge.refresh()).sessions.find((entry) => entry.id === session.id)?.state, "working", "an old native snapshot must not restore the resolved question state");

  await provider.event(session.providerSessionId, "user_input.requested", { ...payload, providerRequestId: "reply-race" });
  provider.respondToUserInput = async () => { await provider.event(session.providerSessionId, "user_input.resolved", { providerRequestId: "reply-race" }); };
  await bridge.respondToUserInput({ requestId: bridge.pendingUserInputs()[0]!.requestId, answers: { one: ["Yes"] }, respondedAt: new Date().toISOString() });
  assert.equal((await bridge.refresh()).sessions.find((entry) => entry.id === session.id)?.state, "working", "the response acknowledgment must retain the native resolution barrier");
});

test("failed question responses stay answerable and external resolution during a response cannot resurrect them", async () => {
  const registry = new UserInputRegistry();
  let reject: ((error: Error) => void) | undefined;
  const provider = new InteractionProvider({ hostId: "questions", sessionCount: 0 });
  provider.respondToUserInput = async () => { await new Promise<void>((_resolve, rejectResponse) => { reject = rejectResponse; }); };
  const input = registry.add("questions", "task", provider, "native", { title: "Question" });
  const response = () => registry.resolve("questions", { requestId: input.requestId, answers: { answer: ["Yes"] }, respondedAt: new Date().toISOString() });
  const first = response();
  assert.equal(registry.list().length, 0);
  assert.equal(registry.hasForSession("task"), true);
  reject!(new Error("Transport failed"));
  await assert.rejects(first, /Transport failed/u);
  assert.equal(registry.list()[0]?.requestId, input.requestId);
  const second = response();
  registry.clearProviderRequest("task", "native");
  reject!(new Error("Already answered elsewhere"));
  await assert.rejects(second, /Already answered/u);
  assert.equal(registry.hasForSession("task"), false);
});

test("permission RPCs validate task scope and only return provider-confirmed choices", async (t) => {
  const provider = new InteractionProvider({ hostId: "permissions", sessionCount: 1 });
  const bridge = new AgentBridge({ version: 1, hostId: "permissions", displayName: "Test", identity: createHostIdentity(), enabledProviders: ["fake"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const router = new BridgeRequestRouter(bridge);
  const call = (type: string, payload: JsonObject) => router.handle({ protocolVersion: CURRENT_PROTOCOL_VERSION, messageId: crypto.randomUUID(), hostId: "permissions", sentAt: new Date().toISOString(), kind: "request", type, requestId: crypto.randomUUID(), payload });
  assert.equal((await call("session.permissions.get", { sessionId: session.id })).ok, true);
  const result = await call("session.permissions.set", { sessionId: session.id, controlId: "tools", value: "deny" });
  assert.equal(result.ok, true);
  assert.equal((result.payload.controls as unknown as ProviderSessionPermissions["controls"])[0]?.value, "deny");
  assert.deepEqual(provider.calls, [{ sessionId: session.providerSessionId, controlId: "tools", value: "deny" }]);
  assert.equal((await call("session.permissions.set", { sessionId: makeGlobalSessionId("another-host", "fake", session.providerSessionId), controlId: "tools", value: "ask" })).ok, false);
  assert.equal((await call("session.permissions.set", { sessionId: session.id, controlId: "tools", value: true })).ok, false);
  assert.equal(provider.calls.length, 1);
});
