import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, type RemoteSession, type SessionState } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { CreateSessionOptions, ListSessionsOptions, ProviderEventSink, SendMessageRequest, SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { meshToolDefinitions } from "./mesh_tools.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class RunningProvider extends FakeProviderAdapter {
  readonly active = new Set<string>();
  readonly sends: string[] = [];
  readonly stops: string[] = [];
  readonly states = new Map<string, SessionState>();
  readonly parents = new Map<string, string>();
  failStop = false;
  createGate: ReturnType<typeof deferred> | undefined;
  sendGate: ReturnType<typeof deferred> | undefined;
  capabilitiesGate: ReturnType<typeof deferred> | undefined;
  readonly checking = deferred();
  readonly creating = deferred();
  readonly sending = deferred();
  #sink: ProviderEventSink | undefined;
  #sequence = 0;

  override async subscribe(id: string | null, sink: ProviderEventSink) {
    this.#sink = sink;
    return await super.subscribe(id, sink);
  }
  override async getSession(id: string): Promise<RemoteSession> {
    return { ...await super.getSession(id), state: this.states.get(id) ?? "idle", needsApproval: false,
      ...(this.parents.has(id) ? { parentSessionId: this.parents.get(id)! } : {}) };
  }
  override async listSessions(options: ListSessionsOptions = {}) {
    const result = await super.listSessions(options);
    return { ...result, sessions: result.sessions.map((session) => ({ ...session, state: this.states.get(session.providerSessionId) ?? "idle" as const, needsApproval: false,
      ...(this.parents.has(session.providerSessionId) ? { parentSessionId: this.parents.get(session.providerSessionId)! } : {}) })) };
  }
  override async getCapabilities() {
    if (this.capabilitiesGate !== undefined) { this.checking.resolve(); await this.capabilitiesGate.promise; }
    return await super.getCapabilities();
  }
  override async createSession(options: CreateSessionOptions) {
    this.creating.resolve();
    await this.createGate?.promise;
    return await super.createSession(options);
  }
  override hasActiveTurn(id: string) { return this.active.has(id); }
  override async sendMessage(id: string, _request: SendMessageRequest): Promise<SendMessageResult> {
    this.sending.resolve();
    await this.sendGate?.promise;
    this.sends.push(id);
    this.active.add(id);
    this.states.set(id, "working");
    await this.#sink?.({ providerId: this.providerId, providerSessionId: id, eventId: `start-${++this.#sequence}`,
      type: "session.status_changed", occurredAt: new Date().toISOString(), payload: { state: "working" } });
    return { accepted: true, providerTurnId: `turn-${this.#sequence}`, details: [] };
  }
  override async interrupt(id: string) {
    this.stops.push(id);
    if (this.failStop) throw new Error("Provider refused cancellation");
    this.active.delete(id);
    this.states.set(id, "idle");
    await this.#sink?.({ providerId: this.providerId, providerSessionId: id, eventId: `stop-${++this.#sequence}`,
      type: "agent.interrupted", occurredAt: new Date().toISOString(), payload: {} });
  }
}

async function setup(t: test.TestContext, options: ConstructorParameters<typeof AgentBridge>[2] = {}) {
  const hostId = "stop-tree";
  const providers = ["codex", "grok", "opencode"].map((providerId) => new RunningProvider({ hostId, providerId, sessionCount: providerId === "codex" ? 1 : 0 }));
  const bridge = new AgentBridge({ version: 1, hostId, identity: createHostIdentity(), displayName: "Stop tests", enabledProviders: providers.map((provider) => provider.providerId) }, providers, options);
  bridge.configureClientTooling({ definitions: meshToolDefinitions, execute: async () => null, mcpServer: () => ({ name: "mesh-test", command: "node", args: [], env: {} }) });
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  return { bridge, parent, codex: providers[0]!, grok: providers[1]!, opencode: providers[2]! };
}

test("Stop cancels an idle parent's whole mixed-provider subtree and settles persisted child rows", async (t) => {
  const { bridge, parent, codex, grok, opencode } = await setup(t);
  const first = await bridge.startDelegation(parent.id, "Implement the first module", [{ providerId: "grok" }]);
  const second = await bridge.startDelegation(parent.id, "Review the second module", [{ providerId: "opencode" }]);
  const grandchild = await bridge.startDelegation(first.children[0]!.sessionId!, "Check the nested module", [{ providerId: "codex" }]);
  await codex.interrupt(parent.providerSessionId);
  await bridge.interrupt(parent.id);
  assert.equal(codex.active.size + grok.active.size + opencode.active.size, 0);
  for (const id of [first.children[0]!.sessionId!, second.children[0]!.sessionId!, grandchild.children[0]!.sessionId!]) {
    const opened = await bridge.openSession(id);
    assert.equal(opened.session.state, "idle");
    const child = bridge.delegations().flatMap((task) => task.children).find((entry) => entry.sessionId === id)!;
    assert.equal(child.state, "idle");
    assert.ok(child.interruptedAt);
  }
});

test("individual Stop leaves its parent and sibling working and blocks automatic follow-ups until explicit resume", async (t) => {
  const { bridge, parent, codex, grok, opencode } = await setup(t);
  const first = await bridge.startDelegation(parent.id, "Implement a module", [{ providerId: "grok" }]);
  const second = await bridge.startDelegation(parent.id, "Review another module", [{ providerId: "opencode" }]);
  const childId = first.children[0]!.sessionId!;
  await bridge.enqueueMessage(childId, { requestId: "queued-user", content: "A queued follow-up" });
  await bridge.sendCrossSessionMessage(second.children[0]!.sessionId!, childId, "queued-model", "A task follow-up");
  const before = grok.sends.length;
  await bridge.interrupt(childId);
  await tick();
  assert.equal(grok.active.size, 0);
  assert.equal(codex.active.size, 1);
  assert.equal(opencode.active.size, 1);
  assert.equal(grok.sends.length, before);
  assert.equal(bridge.queuedMessages(childId).length, 1);
  await assert.rejects(bridge.executeMeshTool(parent.id, "mesh_message_child", { child_session_id: childId, message: "Restart secretly" }), /stopped by the user/);
  await bridge.continueSession(childId, { requestId: "explicit-continue" });
  assert.equal(grok.active.size, 1);
  assert.equal(grok.sends.length, before + 1);
});

test("Stop waits for a concurrently accepted turn and cancels it too", async (t) => {
  const { bridge, parent, codex } = await setup(t);
  codex.sendGate = deferred();
  const sending = bridge.sendMessage(parent.id, { requestId: "racing-send", content: "Begin work" });
  await codex.sending.promise;
  let acknowledged = false;
  const stopping = bridge.interrupt(parent.id).then(() => { acknowledged = true; });
  await tick();
  assert.equal(acknowledged, false);
  codex.sendGate.resolve();
  await Promise.all([sending, stopping]);
  assert.equal(codex.active.size, 0);
  assert.equal(codex.stops.length, 2);
  assert.equal(bridge.sessions().find((session) => session.id === parent.id)?.state, "idle");
});

test("Stop during Mesh creation prevents a late-created worker from receiving its first instruction", async (t) => {
  const { bridge, parent, grok } = await setup(t);
  grok.createGate = deferred();
  const creating = bridge.startDelegation(parent.id, "Implement the module", [{ providerId: "grok" }]);
  await grok.creating.promise;
  await bridge.interrupt(parent.id);
  grok.createGate.resolve();
  const task = await creating;
  assert.equal(task.state, "failed");
  assert.ok(task.interruptedAt);
  assert.equal(grok.sends.length, 0);
  assert.equal(grok.active.size, 0);
});

test("one cancellation failure does not prevent other workers stopping or claim the failed worker stopped", async (t) => {
  const { bridge, parent, codex, grok, opencode } = await setup(t);
  const first = await bridge.startDelegation(parent.id, "Implement a module", [{ providerId: "grok" }]);
  await bridge.startDelegation(parent.id, "Review another module", [{ providerId: "opencode" }]);
  grok.failStop = true;
  await assert.rejects(bridge.interrupt(parent.id), /Provider refused cancellation/);
  assert.equal(codex.active.size + opencode.active.size, 0);
  assert.equal(grok.active.size, 1);
  const child = bridge.delegations().flatMap((task) => task.children).find((entry) => entry.sessionId === first.children[0]!.sessionId)!;
  assert.equal(child.state, "working");
  assert.equal(child.interruptedAt, undefined);
});

test("Stop leaves ordinary parented user chats outside the subagent tree", async (t) => {
  const { bridge, parent, opencode } = await setup(t);
  const independent = await bridge.createSession("opencode", { workingDirectory: "C:\\workspace" });
  opencode.parents.set(independent.providerSessionId, parent.id);
  await bridge.refresh();
  await bridge.sendMessage(independent.id, { requestId: "independent", content: "Keep working" });
  await bridge.interrupt(parent.id);
  assert.equal(opencode.active.has(independent.providerSessionId), true);
  assert.equal(opencode.stops.length, 0);
});

test("Stop discovers uncached native children after their parent stops and drains nested workers in parallel", async (t) => {
  const { bridge, opencode } = await setup(t);
  const parent = await bridge.createSession("opencode", { workingDirectory: "C:\\workspace" });
  const children = await Promise.all(Array.from({ length: 20 }, () => opencode.createSession({ workingDirectory: "C:\\workspace" })));
  const grandchild = await opencode.createSession({ workingDirectory: "C:\\workspace" });
  for (const session of [parent, ...children, grandchild]) opencode.active.add(session.providerSessionId);
  assert.ok(children.every(child => !bridge.sessions().some(session => session.id === child.id)));
  let activeStops = 0;
  let maximumActiveStops = 0;
  const nativeStop = opencode.interrupt.bind(opencode);
  opencode.interrupt = async id => {
    activeStops++;
    maximumActiveStops = Math.max(maximumActiveStops, activeStops);
    await new Promise(resolve => setTimeout(resolve, 40));
    await nativeStop(id);
    activeStops--;
  };
  Object.assign(opencode, { listSubagentSessionIds: async (id: string) => {
    assert.equal(opencode.active.has(id), false, "native children must be read after stopping their spawner");
    if (id === parent.providerSessionId) return children.map(child => child.providerSessionId);
    if (id === children[0]!.providerSessionId) return [grandchild.providerSessionId];
    return [];
  } });
  const start = performance.now();
  await bridge.interrupt(parent.id);
  assert.equal(opencode.active.size, 0);
  assert.equal(opencode.stops.length, 22);
  assert.ok(maximumActiveStops >= 20, "siblings must not accumulate serial provider waits");
  assert.ok(performance.now() - start < 1000);
});

test("failure to discover native children does not prevent the parent and known workers stopping", async (t) => {
  const { bridge, parent, codex, opencode } = await setup(t);
  await bridge.startDelegation(parent.id, "Review", [{ providerId: "opencode" }]);
  Object.assign(opencode, { listSubagentSessionIds: async () => { throw new Error("Native child listing unavailable"); } });
  await assert.rejects(bridge.interrupt(parent.id), /Native child listing unavailable/);
  assert.equal(codex.active.size + opencode.active.size, 0);
});

test("Stop during Mesh target validation prevents the older preparation from resuming the parent", async (t) => {
  const { bridge, parent, codex, grok } = await setup(t);
  grok.capabilitiesGate = deferred();
  const preparing = bridge.prepareDelegation(parent.id, "Review", [{ providerId: "grok" }], [{ type: "text", text: "Review" }, { type: "mesh", targetIndex: 0 }], "old-preparation");
  const rejected = assert.rejects(preparing, /stopped by the user/);
  await grok.checking.promise;
  await bridge.interrupt(parent.id);
  grok.capabilitiesGate.resolve();
  await rejected;
  assert.equal(codex.sends.length, 0);
  assert.equal(bridge.delegations().length, 0);
});

test("late cross-task acceptance persistence cannot restore Working after confirmed Stop", async (t) => {
  const gate = deferred();
  const confirming = deferred();
  const { bridge, parent, grok } = await setup(t, {
    onQueueDeliveriesChange: async (deliveries) => {
      if (deliveries.some((delivery) => delivery.state === "confirmed")) { confirming.resolve(); await gate.promise; }
    },
  });
  const target = await bridge.createSession("grok", { workingDirectory: "C:\\workspace" });
  const sending = bridge.sendCrossSessionMessage(parent.id, target.id, "cross-race", "Check this task");
  await confirming.promise;
  await bridge.interrupt(target.id);
  gate.resolve();
  await sending;
  await tick();
  assert.equal(grok.active.size, 0);
  assert.equal(bridge.sessions().find((session) => session.id === target.id)?.state, "idle");
});
