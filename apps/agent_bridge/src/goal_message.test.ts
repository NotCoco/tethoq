import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, CURRENT_PROTOCOL_VERSION, type JsonObject } from "../../../packages/protocol/src/index.js";
import { visibleContextTransferText } from "../../../packages/protocol/src/context_visibility.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { providerPromptContent, stripProviderPromptGuidance, type ProviderSessionGoal, type ProviderSessionGoalUpdate, type ProviderQueuedMessage, type SendMessageRequest, type SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { BridgeRequestRouter } from "./request_router.js";

const hostId = "goal-message";
class CapturingProvider extends FakeProviderAdapter {
  readonly sends: SendMessageRequest[] = [];
  constructor() { super({ hostId, sessionCount: 1 }); }
  override async sendMessage(_sessionId: string, input: SendMessageRequest): Promise<SendMessageResult> {
    this.sends.push(input);
    return { accepted: true, details: [] };
  }
}
const makeBridge = (provider: CapturingProvider) => new AgentBridge({ version: 1, hostId, displayName: "Goal check", identity: createHostIdentity(), enabledProviders: [provider.providerId] }, [provider]);
let sequence = 0;
const rpc = (router: BridgeRequestRouter, type: string, payload: JsonObject) => router.handle({ protocolVersion: CURRENT_PROTOCOL_VERSION, messageId: String(++sequence), requestId: String(sequence), hostId, sentAt: new Date().toISOString(), kind: "request", type, payload });

test("sending a goal sets the native objective before delivering one readable prompt", async (t) => {
  class NativeProvider extends CapturingProvider {
    goal: ProviderSessionGoal | null = null;
    sets = 0;
    async getGoal() { return this.goal; }
    async setGoal(_sessionId: string, update: ProviderSessionGoalUpdate): Promise<ProviderSessionGoal> {
      this.sets++;
      this.goal = { objective: update.objective!, status: update.status!, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      return this.goal;
    }
    override async sendMessage(sessionId: string, input: SendMessageRequest) {
      assert.equal(this.goal?.objective, input.content);
      return super.sendMessage(sessionId, input);
    }
  }
  const provider = new NativeProvider(), bridge = makeBridge(provider);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const router = new BridgeRequestRouter(bridge);
  const response = await rpc(router, "session.send_message", { sessionId: session.id, content: "Finish the documentation", goal: { objective: "Finish the documentation" } });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(provider.sets, 1);
  assert.equal(provider.sends.length, 1);
  assert.equal(provider.sends[0]!.content, "Finish the documentation");
  assert.equal(provider.sends[0]!.developerInstructions, undefined);
  assert.equal(provider.sends[0]!.metadata?.tethoqGoalObjective, undefined);
  assert.equal((await bridge.sessionGoal(session.id))?.source, "native");
  const invalid = await rpc(router, "session.send_message", { sessionId: session.id, content: "Bad goal", goal: { objective: " " } });
  assert.equal(invalid.ok, false);
  assert.equal(provider.sends.length, 1);
});

test("fallback goals persist privately and cleared or paused goals cannot retain active guidance", async (t) => {
  const provider = new CapturingProvider(), bridge = makeBridge(provider);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const router = new BridgeRequestRouter(bridge);
  const response = await rpc(router, "session.send_message", { sessionId: session.id, content: "Finish the documentation", goal: { objective: "Finish the documentation" } });
  assert.equal(response.ok, true, JSON.stringify(response));
  const first = provider.sends[0]!;
  assert.match(first.developerInstructions!, /<tethoq_task_goal>[\s\S]*Objective: Finish the documentation/);
  assert.equal(stripProviderPromptGuidance(providerPromptContent(first)), first.content);
  await bridge.sendMessage(session.id, { requestId: "follow-up", content: "Continue" });
  assert.match(provider.sends.at(-1)!.developerInstructions!, /Keep working until this objective is achieved/);
  await bridge.setSessionGoal(session.id, { status: "paused" });
  await bridge.sendMessage(session.id, { requestId: "paused", content: "Answer this question", developerInstructions: first.developerInstructions! });
  assert.match(provider.sends.at(-1)!.developerInstructions!, /This goal is paused/);
  assert.doesNotMatch(provider.sends.at(-1)!.developerInstructions!, /Keep working until this objective is achieved|Tethoq will continue unfinished active goals/);
  await bridge.clearSessionGoal(session.id);
  await bridge.sendMessage(session.id, { requestId: "cleared", content: "A new request", developerInstructions: first.developerInstructions! });
  assert.equal(provider.sends.at(-1)!.developerInstructions, undefined);
  await bridge.sendMessage(session.id, { requestId: "retained", content: "Another request", developerInstructions: `Earlier guidance\n${first.developerInstructions}\nLater guidance` });
  assert.equal(provider.sends.at(-1)!.developerInstructions, "Earlier guidance\nLater guidance");
  assert.deepEqual(provider.sends.map(({ content }) => content), ["Finish the documentation", "Continue", "Answer this question", "A new request", "Another request"]);
});

test("queued goals activate at delivery and retain the edited objective", async (t) => {
  class QueuingProvider extends CapturingProvider {
    busy = true;
    override hasActiveTurn() { return this.busy; }
    async enqueueQueuedMessage(): Promise<ProviderQueuedMessage> { throw new Error("Goal must wait in the bridge queue until delivery"); }
  }
  const provider = new QueuingProvider(), bridge = makeBridge(provider);
  t.after(() => bridge.dispose());
  await provider.resumeSession("fake_session_0001");
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const router = new BridgeRequestRouter(bridge);
  const response = await rpc(router, "message_queue.enqueue", { sessionId: session.id, content: "Old objective", goal: { objective: "Old objective" } });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(await bridge.sessionGoal(session.id), null);
  assert.equal(provider.sends.length, 0);
  const queued = bridge.queuedMessages(session.id)[0]!;
  await bridge.editQueuedMessage(queued.id, "Revised objective");
  provider.busy = false;
  await bridge.deliverQueuedMessage(queued.id, "send");
  assert.equal(provider.sends.length, 1);
  assert.equal(provider.sends[0]!.content, "Revised objective");
  assert.equal((await bridge.sessionGoal(session.id))?.objective, "Revised objective");
  assert.match(provider.sends[0]!.developerInstructions!, /Objective: Revised objective/);
});

test("goal envelopes and legacy echoes stay hidden while literal examples remain readable", () => {
  const goal = "<tethoq_task_goal>\nPrivate objective\n</tethoq_task_goal>\n";
  assert.equal(visibleContextTransferText(goal + "Continue"), "Continue");
  assert.equal(visibleContextTransferText("<tethoq_task_go"), "");
  assert.equal(visibleContextTransferText("<tethoq_task_goal>\nPrivate objective"), "");
  const legacy = "Tethoq persistent task goal (private control context; do not quote this block):\nPrivate objective\nKeep this objective in view across turns. The goal lifecycle is controlled by Tethoq and is independent of whether this turn is busy or finished.\n";
  assert.equal(visibleContextTransferText(legacy + "Continue"), "Continue");
  for (const literal of ["Explain <tethoq_task_goal>", "```text\n" + goal + "```", "`<tethoq_task_goal>`"]) assert.equal(visibleContextTransferText(literal), literal);
});
