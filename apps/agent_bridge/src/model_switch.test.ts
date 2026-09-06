import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PROTOCOL_VERSION, createHostIdentity, type RemoteMessage } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { ProviderAdapterError, type CreateSessionOptions, type SendMessageRequest, type SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { BridgeRequestRouter } from "./request_router.js";
import type { SessionTransferRecord } from "./session_transfer_store.js";

class SwitchingProvider extends FakeProviderAdapter {
  readonly creations: CreateSessionOptions[] = [];
  readonly sends: { sessionId: string; request: SendMessageRequest }[] = [];
  historyUnavailable = false;
  rejectNextSend = false;

  override async createSession(options: CreateSessionOptions) {
    this.creations.push(options);
    return await super.createSession(options);
  }

  override async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    if (this.historyUnavailable) throw new Error("list_turns is not supported yet");
    return await super.getMessages(providerSessionId);
  }

  override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.sends.push({ sessionId: providerSessionId, request });
    if (this.rejectNextSend) {
      this.rejectNextSend = false;
      throw new ProviderAdapterError(this.providerId, "NOT_DELIVERED", "Try again", true);
    }
    return { accepted: true, details: [] };
  }
}

const hostId = "model-switch-test";
const config = { version: 1 as const, hostId, displayName: "Model switch test", identity: createHostIdentity(), enabledProviders: ["source", "target"] };
const selection = { providerId: "target", modelId: "fake-fast", requestId: "switch-one" };

test("model switching carries private context and visible history into one destination", async (t) => {
  const source = new SwitchingProvider({ hostId, providerId: "source", sessionCount: 1 });
  await source.resumeSession("fake_session_0001");
  const target = new SwitchingProvider({ hostId, providerId: "target", sessionCount: 0 });
  const bridge = new AgentBridge(config, [source, target]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  const original = await bridge.openSession(parent.id);
  const router = new BridgeRequestRouter(bridge);
  const response = await router.handle({ protocolVersion: CURRENT_PROTOCOL_VERSION, messageId: "switch", requestId: "switch", hostId,
    sentAt: new Date().toISOString(), kind: "request", type: "session.switch_model", payload: { ...selection, sessionId: parent.id } });
  assert.equal(response.ok, true);
  const next = await bridge.switchSessionModel(parent.id, selection);
  assert.equal(target.creations.length, 1, "a lost acknowledgement must reuse the prepared destination");
  assert.equal(target.sends.length, 0, "selecting/preparing the model must not submit a prompt");
  assert.equal(next.title, parent.title);
  assert.equal(next.workingDirectory, parent.workingDirectory);
  assert.equal(next.providerId, "target");
  assert.equal(next.modelId, "fake-fast");
  assert.equal(next.contextHandoffSummary, undefined, "the internal summary must not become a visible handoff card");
  assert.equal(JSON.stringify(response).includes("Seed message for fixture 1"), false, "private context stays out of the session RPC response");
  assert.deepEqual(bridge.sessions().map((session) => session.id), [next.id], "the task must not duplicate in the catalogue");
  const opened = await bridge.openSession(next.id);
  assert.deepEqual(opened.messages.map((message) => message.parts), original.messages.map((message) => message.parts));
  await bridge.sendMessage(next.id, { requestId: "first", content: "Continue the work" });
  await bridge.sendMessage(next.id, { requestId: "second", content: "Check the next step" });
  assert.equal(source.sends.length, 0);
  assert.deepEqual(target.sends.map(({ request }) => request.content), ["Continue the work", "Check the next step"]);
  for (const { request } of target.sends) {
    assert.match(request.developerInstructions!, /Seed message for fixture 1/);
    assert.equal(request.metadata?.contextSummary, request.developerInstructions);
  }
});

test("model switching accepts empty and unsupported histories and retains available context", async (t) => {
  for (const empty of [true, false]) {
    const source = new SwitchingProvider({ hostId, providerId: "source", sessionCount: empty ? 0 : 1 });
    const target = new SwitchingProvider({ hostId, providerId: "target", sessionCount: 0 });
    const parent = empty ? await source.createSession({ workingDirectory: "/workspace" }) : (await source.listSessions()).sessions[0]!;
    await source.resumeSession(parent.providerSessionId);
    const bridge = new AgentBridge(config, [source, target]);
    t.after(() => bridge.dispose());
    await bridge.start();
    await bridge.refresh();
    if (!empty) await bridge.openSession(parent.id);
    source.historyUnavailable = true;
    const next = await bridge.switchSessionModel(parent.id, selection);
    await bridge.sendMessage(next.id, { requestId: "send", content: "Continue" });
    const summary = target.sends[0]!.request.developerInstructions!;
    assert.match(summary, /could not provide complete history/);
    if (!empty) assert.match(summary, /Seed message for fixture 1/);
    assert.equal((await bridge.openSession(next.id)).messages.length, empty ? 0 : 1);
  }
});

test("model-switch context survives restart and a rejected first send", async (t) => {
  const source = new SwitchingProvider({ hostId, providerId: "source", sessionCount: 1 });
  await source.resumeSession("fake_session_0001");
  const target = new SwitchingProvider({ hostId, providerId: "target", sessionCount: 0 });
  let transfers: readonly SessionTransferRecord[] = [];
  const bridge = new AgentBridge(config, [source, target], { onSessionTransfersChange: (value) => { transfers = value; } });
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  const next = await bridge.switchSessionModel(parent.id, selection);
  const restored = new AgentBridge(config, [source, target], { sessionTransfers: transfers, sessionCatalogue: [parent, next] });
  t.after(() => restored.dispose());
  await restored.start();
  await restored.refresh();
  assert.equal((await restored.switchSessionModel(parent.id, selection)).id, next.id);
  target.rejectNextSend = true;
  await assert.rejects(restored.sendMessage(next.id, { requestId: "rejected", content: "Continue" }), /Try again/);
  await restored.sendMessage(next.id, { requestId: "retry", content: "Continue" });
  assert.equal(target.creations.length, 1);
  assert.match(target.sends.at(-1)!.request.developerInstructions!, /Seed message for fixture 1/);
  assert.equal((await restored.openSession(next.id)).messages.length, 1);
  assert.deepEqual(restored.sessions().map((session) => session.id), [next.id]);
});

test("model switching validates the destination and does not abandon an active turn", async (t) => {
  const source = new SwitchingProvider({ hostId, providerId: "source", sessionCount: 1 });
  await source.resumeSession("fake_session_0001");
  const target = new SwitchingProvider({ hostId, providerId: "target", sessionCount: 0 });
  const bridge = new AgentBridge(config, [source, target]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  await assert.rejects(bridge.switchSessionModel(parent.id, { ...selection, modelId: "missing" }), /no longer available/);
  source.holdActiveTurn = true;
  await assert.rejects(bridge.switchSessionModel(parent.id, selection), /current response/);
  assert.equal(target.creations.length, 0);
  assert.equal(bridge.sessions()[0]?.id, parent.id);
});
