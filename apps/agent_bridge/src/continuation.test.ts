import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PROTOCOL_VERSION, createHostIdentity } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { ProviderAdapterError, isProviderContinuationContent, stripProviderPromptGuidance, type SendMessageRequest, type SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { BridgeRequestRouter } from "./request_router.js";

class CapturingProvider extends FakeProviderAdapter {
  readonly requests: SendMessageRequest[] = [];
  failure: ProviderAdapterError | undefined;
  override async sendMessage(_session: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return { accepted: true, providerTurnId: "turn", details: [] };
  }
}

test("Continue uses private guidance and the normal idempotent delivery path without changing later messages", async (t) => {
  const hostId = "continue-test";
  const provider = new CapturingProvider({ hostId, providerId: "fake", sessionCount: 1 });
  const bridge = new AgentBridge({ version: 1, hostId, displayName: "Test", identity: createHostIdentity(), enabledProviders: ["fake"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const router = new BridgeRequestRouter(bridge);
  const action = { protocolVersion: CURRENT_PROTOCOL_VERSION, messageId: "button", hostId, sentAt: new Date().toISOString(), kind: "request" as const,
    type: "session.continue", requestId: "button", payload: { sessionId: session.id, modelId: "chosen", reasoningEffort: "high" } };
  assert.equal((await router.handle(action)).ok, true);
  assert.equal((await router.handle(action)).ok, true);
  assert.equal(provider.requests.length, 1);
  const control = provider.requests[0]!;
  assert.equal(isProviderContinuationContent(control.content), true);
  assert.equal(stripProviderPromptGuidance(control.content), "");
  assert.match(control.developerInstructions ?? "", /Resume the interrupted task/);
  assert.equal(control.modelId, "chosen");
  assert.equal(control.reasoningEffort, "high");
  assert.equal(control.attachments, undefined);
  assert.equal(control.workflows, undefined);
  await bridge.sendMessage(session.id, { requestId: "typed", content: "continue" });
  assert.equal(provider.requests[1]!.content, "continue");
  assert.equal(provider.requests[1]!.developerInstructions, undefined);
  assert.equal(isProviderContinuationContent(provider.requests[1]!.content), false);
});

test("Continue retries proven rejection but does not resend an ambiguous continuation", async (t) => {
  const hostId = "continue-retry";
  const provider = new CapturingProvider({ hostId, providerId: "fake", sessionCount: 1 });
  const bridge = new AgentBridge({ version: 1, hostId, displayName: "Test", identity: createHostIdentity(), enabledProviders: ["fake"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  provider.failure = new ProviderAdapterError("fake", "DELIVERY_REJECTED", "Rejected", true);
  await assert.rejects(bridge.continueSession(session.id, { requestId: "rejected" }), /Rejected/);
  provider.failure = undefined;
  await bridge.continueSession(session.id, { requestId: "retry" });
  assert.equal(provider.requests.length, 2);
  provider.failure = new ProviderAdapterError("fake", "DELIVERY_UNKNOWN", "Uncertain delivery", false);
  await assert.rejects(bridge.continueSession(session.id, { requestId: "unknown" }), /Uncertain delivery/);
  const sent = provider.requests.length;
  await assert.rejects(bridge.continueSession(session.id, { requestId: "another-click" }), /Uncertain delivery/);
  assert.equal(provider.requests.length, sent);
});
