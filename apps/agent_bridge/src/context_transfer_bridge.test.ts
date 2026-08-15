import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PROTOCOL_VERSION, createHostIdentity, type JsonObject, type RequestEnvelope } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { SendMessageRequest, SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import type { BridgeConfig } from "./config.js";
import { AgentBridge } from "./bridge.js";
import { BridgeRequestRouter } from "./request_router.js";
import type { SessionTransferRecord } from "./session_transfer_store.js";

function bridgeConfig(hostId: string, providerId: string): BridgeConfig {
  return {
    version: 1,
    hostId,
    displayName: "Context transfer test",
    identity: createHostIdentity(),
    enabledProviders: [providerId],
  };
}

function request(hostId: string, requestId: string, type: string, payload: JsonObject): RequestEnvelope {
  return {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: `message-${requestId}`,
    hostId,
    sentAt: "2026-08-14T10:00:00.000Z",
    kind: "request",
    type,
    requestId,
    payload,
  };
}

class NativeBranchFakeProvider extends FakeProviderAdapter {
  public readonly branchCalls: string[] = [];

  public async branchSession(providerSessionId: string) {
    this.branchCalls.push(providerSessionId);
    const source = await this.getSession(providerSessionId);
    return await this.createSession({
      workingDirectory: source.workingDirectory ?? "C:\\workspace",
      title: `Native branch of ${source.title}`,
    });
  }
}

class ObservedSendFakeProvider extends FakeProviderAdapter {
  public readonly sentContents: string[] = [];
  public failNextSend = false;

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.sentContents.push(request.content);
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("Simulated handoff send failure");
    }
    return await super.sendMessage(providerSessionId, request);
  }
}

test("context handoff is send-free until the first user submit, then injects context exactly once", async (t) => {
  const provider = new ObservedSendFakeProvider({ hostId: "host-handoff", providerId: "handoff", sessionCount: 1 });
  const bridge = new AgentBridge(bridgeConfig("host-handoff", provider.providerId), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = bridge.sessions()[0];
  assert.ok(source);

  const result = await bridge.contextHandoff(source.id, "Continue with focused verification.");
  const words = result.summary.match(/\S+/g)?.length ?? 0;
  assert.ok(words >= 100 && words <= 1_000);
  assert.notEqual(result.session.id, source.id);
  assert.equal(result.session.providerId, source.providerId);
  assert.equal(result.session.modelId, source.modelId);
  assert.equal(result.session.workingDirectory, source.workingDirectory);
  assert.deepEqual(result.session.relationship, {
    kind: "handoff",
    sourceSessionId: source.id,
    strategy: "summary_bootstrap",
  });
  assert.equal(result.prompt, "Continue with focused verification.");
  assert.equal(result.session.nativeMetadata.tethoqHandoffSummary, result.summary);
  assert.equal(result.session.nativeMetadata.tethoqHandoffPrompt, result.prompt);
  assert.equal(result.session.nativeMetadata.tethoqHandoffPending, true);
  assert.deepEqual(provider.sentContents, []);
  assert.deepEqual(await provider.getMessages(result.session.providerSessionId), []);

  const firstUserContent = "Run the focused tests now.";
  const sent = await bridge.sendMessage(result.session.id, { requestId: "first-handoff-submit", content: firstUserContent });
  assert.equal(sent.accepted, true);
  assert.equal(provider.sentContents.length, 1);
  const createdMessages = await provider.getMessages(result.session.providerSessionId);
  const bootstrap = createdMessages.flatMap((message) => message.parts).find((part) => part.type === "text");
  assert.equal(bootstrap?.type, "text");
  assert.match(bootstrap.text, /TETHOQ_CONTEXT_HANDOFF_V1/);
  assert.match(bootstrap.text, /Continue with focused verification/);
  assert.match(bootstrap.text, /Seed message for fixture 1/);
  assert.match(bootstrap.text, /Run the focused tests now/);
  assert.equal(bootstrap.text.match(/TETHOQ_CONTEXT_HANDOFF_V1/g)?.length, 1);

  const opened = await bridge.openSession(result.session.id);
  assert.deepEqual(opened.messages.flatMap((message) => message.parts), [{ type: "text", text: firstUserContent }]);
  assert.equal(bridge.sessions().find((session) => session.id === result.session.id)?.nativeMetadata.tethoqHandoffPending, false);

  await bridge.sendMessage(result.session.id, { requestId: "second-handoff-submit", content: "A normal follow-up." });
  assert.equal(provider.sentContents.length, 2);
  assert.doesNotMatch(provider.sentContents[1]!, /TETHOQ_CONTEXT_HANDOFF_V1/);

  await bridge.refresh();
  const refreshed = bridge.sessions().find((session) => session.id === result.session.id);
  assert.deepEqual(refreshed?.relationship, result.session.relationship);
  assert.equal(refreshed?.nativeMetadata.tethoqHandoffSummary, result.summary);
  assert.equal(refreshed?.nativeMetadata.tethoqHandoffPending, false);
});

test("a failed first handoff submit retains the pending context until an adapter accepts it", async (t) => {
  const provider = new ObservedSendFakeProvider({ hostId: "host-handoff-retry", providerId: "handoff-retry", sessionCount: 1 });
  const bridge = new AgentBridge(bridgeConfig("host-handoff-retry", provider.providerId), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = bridge.sessions()[0];
  assert.ok(source);

  const handoff = await bridge.contextHandoff(source.id);
  provider.failNextSend = true;
  await assert.rejects(
    bridge.sendMessage(handoff.session.id, { requestId: "failed-handoff-submit", content: "First attempt" }),
    /Simulated handoff send failure/,
  );
  assert.equal(bridge.sessions().find((session) => session.id === handoff.session.id)?.nativeMetadata.tethoqHandoffPending, true);

  const retry = await bridge.sendMessage(handoff.session.id, { requestId: "retried-handoff-submit", content: "Retry attempt" });
  assert.equal(retry.accepted, true);
  assert.equal(provider.sentContents.length, 2);
  assert.ok(provider.sentContents.every((content) => content.includes("TETHOQ_CONTEXT_HANDOFF_V1")));
  assert.equal(bridge.sessions().find((session) => session.id === handoff.session.id)?.nativeMetadata.tethoqHandoffPending, false);
});

test("generic branch fallback bootstraps the full normalized transcript and tags its strategy", async (t) => {
  const provider = new FakeProviderAdapter({ hostId: "host-branch-fallback", providerId: "fallback", sessionCount: 1 });
  const bridge = new AgentBridge(bridgeConfig("host-branch-fallback", provider.providerId), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = bridge.sessions()[0];
  assert.ok(source);

  const result = await bridge.branchSession(source.id, "Take an independent approach.");
  assert.equal(result.strategy, "transcript_bootstrap");
  assert.equal(result.copiedMessageCount, 1);
  assert.deepEqual(result.session.relationship, {
    kind: "branch",
    sourceSessionId: source.id,
    strategy: "transcript_bootstrap",
  });
  const createdMessages = await provider.getMessages(result.session.providerSessionId);
  const text = createdMessages.flatMap((message) => message.parts).find((part) => part.type === "text");
  assert.equal(text?.type, "text");
  assert.match(text.text, /TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/);
  assert.match(text.text, /Seed message for fixture 1/);
  assert.match(text.text, /Take an independent approach/);

  const opened = await bridge.openSession(result.session.id);
  const visibleText = opened.messages.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(visibleText, /Seed message for fixture 1/);
  assert.match(visibleText, /Take an independent approach/);
  assert.doesNotMatch(visibleText, /TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/);
});

test("generic branch fallback shows copied history before sending and injects its bootstrap once", async (t) => {
  const provider = new ObservedSendFakeProvider({ hostId: "host-branch-deferred", providerId: "deferred", sessionCount: 1 });
  const bridge = new AgentBridge(bridgeConfig("host-branch-deferred", provider.providerId), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = bridge.sessions()[0];
  assert.ok(source);

  const result = await bridge.branchSession(source.id);
  assert.equal(result.strategy, "transcript_bootstrap");
  assert.deepEqual(provider.sentContents, []);
  assert.deepEqual(await provider.getMessages(result.session.providerSessionId), []);

  const beforeSend = await bridge.openSession(result.session.id);
  const copiedText = beforeSend.messages.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(copiedText, /Seed message for fixture 1/);
  assert.ok(beforeSend.messages.every((message) => message.sessionId === result.session.id));

  await bridge.sendMessage(result.session.id, { requestId: "first-branch-submit", content: "Continue from the copied thread." });
  assert.equal(provider.sentContents.length, 1);
  assert.match(provider.sentContents[0]!, /TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/);
  assert.match(provider.sentContents[0]!, /Seed message for fixture 1/);
  assert.match(provider.sentContents[0]!, /Continue from the copied thread/);

  const afterSend = await bridge.openSession(result.session.id);
  const visibleText = afterSend.messages.flatMap((message) => message.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(visibleText, /Seed message for fixture 1/);
  assert.match(visibleText, /Continue from the copied thread/);
  assert.doesNotMatch(visibleText, /TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/);

  await bridge.sendMessage(result.session.id, { requestId: "second-branch-submit", content: "Normal follow-up." });
  assert.equal(provider.sentContents.length, 2);
  assert.doesNotMatch(provider.sentContents[1]!, /TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/);

  const nested = await bridge.branchSession(result.session.id);
  await bridge.sendMessage(nested.session.id, { requestId: "nested-branch-submit", content: "Continue without nesting hidden bootstrap data." });
  const nestedContent = provider.sentContents.at(-1) ?? "";
  assert.equal(nestedContent.match(/TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1/g)?.length, 1);
  assert.match(nestedContent, /Seed message for fixture 1/);
});

test("native branch adapters are preferred and do not receive a transcript bootstrap", async (t) => {
  const provider = new NativeBranchFakeProvider({ hostId: "host-branch-native", providerId: "native", sessionCount: 1 });
  const bridge = new AgentBridge(bridgeConfig("host-branch-native", provider.providerId), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = bridge.sessions()[0];
  assert.ok(source);

  const result = await bridge.branchSession(source.id);
  assert.equal(result.strategy, "native");
  assert.deepEqual(provider.branchCalls, [source.providerSessionId]);
  assert.deepEqual(await provider.getMessages(result.session.providerSessionId), []);
  assert.deepEqual(result.session.relationship, {
    kind: "branch",
    sourceSessionId: source.id,
    strategy: "native",
  });
});

test("request router exposes the handoff and branch wire responses and reports validation errors", async (t) => {
  const hostId = "host-transfer-router";
  const provider = new ObservedSendFakeProvider({ hostId, providerId: "router-fake", sessionCount: 1 });
  const bridge = new AgentBridge(bridgeConfig(hostId, provider.providerId), [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = bridge.sessions()[0];
  assert.ok(source);

  const handoff = await router.handle(request(hostId, "handoff-wire", "session.context_handoff", {
    sessionId: source.id,
    prompt: "Continue from mobile.",
  }));
  assert.equal(handoff.ok, true);
  assert.equal(typeof handoff.payload.summary, "string");
  assert.equal(typeof handoff.payload.session, "object");
  assert.equal(handoff.payload.prompt, "Continue from mobile.");
  assert.deepEqual(provider.sentContents, []);

  const branch = await router.handle(request(hostId, "branch-wire", "session.branch", { sessionId: source.id }));
  assert.equal(branch.ok, true);
  assert.equal(branch.payload.strategy, "transcript_bootstrap");
  assert.equal(branch.payload.copiedMessageCount, 1);
  assert.equal(typeof branch.payload.session, "object");

  const invalid = await router.handle(request(hostId, "branch-invalid", "session.branch", { sessionId: source.id, prompt: " " }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "INVALID_REQUEST");
});

test("persisted transfer records restore visible context and the pending first-send bootstrap", async (t) => {
  const hostId = "host-transfer-restart";
  const provider = new ObservedSendFakeProvider({ hostId, providerId: "restart-fake", sessionCount: 1 });
  let persisted: readonly SessionTransferRecord[] = [];
  const first = new AgentBridge(bridgeConfig(hostId, provider.providerId), [provider], {
    onSessionTransfersChange: (records) => { persisted = records; },
  });
  let restarted: AgentBridge | undefined;
  t.after(async () => {
    await restarted?.dispose();
    await first.dispose();
  });
  await first.start();
  await first.refresh();
  const source = first.sessions()[0];
  assert.ok(source);
  const handoff = await first.contextHandoff(source.id);
  const branch = await first.branchSession(source.id);
  assert.equal(persisted.length, 2);

  let afterRestart: readonly SessionTransferRecord[] = persisted;
  restarted = new AgentBridge(bridgeConfig(hostId, provider.providerId), [provider], {
    sessionTransfers: persisted,
    onSessionTransfersChange: (records) => { afterRestart = records; },
  });
  await restarted.start();
  await restarted.refresh();

  const restoredHandoff = restarted.sessions().find((session) => session.id === handoff.session.id);
  assert.equal(restoredHandoff?.contextHandoffSummary, handoff.summary);
  assert.deepEqual(restoredHandoff?.relationship, handoff.session.relationship);
  const restartedRouter = new BridgeRequestRouter(restarted);
  const reopenedHandoff = await restartedRouter.handle(request(hostId, "restart-handoff-open", "session.open", { sessionId: handoff.session.id }));
  assert.equal((reopenedHandoff.payload.session as JsonObject).contextHandoffSummary, handoff.summary);
  const restoredBranch = await restarted.openSession(branch.session.id);
  assert.match(JSON.stringify(restoredBranch.messages), /Seed message for fixture 1/);

  await restarted.sendMessage(handoff.session.id, { requestId: "restart-handoff-send", content: "Continue after restart." });
  await restarted.sendMessage(branch.session.id, { requestId: "restart-branch-send", content: "Continue the branch after restart." });
  assert.ok(provider.sentContents.some((content) => content.includes("TETHOQ_CONTEXT_HANDOFF_V1")));
  assert.ok(provider.sentContents.some((content) => content.includes("TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1")));
  assert.equal(afterRestart.find((record) => record.sessionId === handoff.session.id)?.pending, false);
  assert.equal(afterRestart.find((record) => record.sessionId === branch.session.id)?.pending, false);
});
