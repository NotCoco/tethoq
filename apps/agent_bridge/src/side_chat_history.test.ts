import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, type RemoteMessage } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { RecentProviderMessages, SendMessageRequest, SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";

class HistoryProvider extends FakeProviderAdapter {
  public historyUnavailable = false;
  public readonly historyReads: string[] = [];
  public readonly sends: { providerSessionId: string; request: SendMessageRequest }[] = [];

  public override async getCapabilities() {
    return { ...await super.getCapabilities(), sessionHistory: !this.historyUnavailable };
  }

  public override async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    this.historyReads.push(providerSessionId);
    if (this.historyUnavailable) throw new Error("list_turns is not supported yet");
    return await super.getMessages(providerSessionId);
  }

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.sends.push({ providerSessionId, request });
    return await super.sendMessage(providerSessionId, request);
  }
}

function bridgeFor(hostId: string, provider: HistoryProvider): AgentBridge {
  return new AgentBridge({ version: 1, hostId, displayName: "Side chat history test", identity: createHostIdentity(), enabledProviders: [provider.providerId] }, [provider]);
}

test("side chats open and reopen empty parents and children without native history support", async (t) => {
  const hostId = "empty-side-chat";
  const provider = new HistoryProvider({ hostId, providerId: "no-history", sessionCount: 0 });
  const parent = await provider.createSession({ workingDirectory: "/workspace", title: "Empty task" });
  provider.historyUnavailable = true;
  const bridge = bridgeFor(hostId, provider);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  const side = await bridge.createSideChat(parent.id);
  assert.equal(side.copiedMessageCount, 0);
  assert.notEqual(side.session.id, parent.id);
  assert.equal(side.session.parentSessionId, parent.id);
  assert.equal(side.session.providerId, provider.providerId);
  assert.equal(side.session.workingDirectory, parent.workingDirectory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual((await bridge.openSession(side.session.id, undefined, 40, true)).messages, []);
  }
  assert.deepEqual(provider.historyReads, [parent.providerSessionId], "an unsent child has no native history to read");
  const sent = await bridge.sendMessage(side.session.id, { requestId: "first-side-message", content: "Hello from the side chat" });
  assert.equal(sent.accepted, true);
  assert.equal(provider.sends.length, 1);
  assert.equal(provider.sends[0]?.providerSessionId, side.session.providerSessionId);
  assert.equal(provider.sends[0]!.request.content, "Hello from the side chat");
  assert.match(provider.sends[0]!.request.developerInstructions!, /Source history availability:/);
  assert.doesNotMatch(provider.sends[0]!.request.developerInstructions!, /complete normalized conversation transcript/);
});

test("side chats retain populated parent context when native history becomes unavailable", async (t) => {
  const hostId = "retained-side-chat";
  const provider = new HistoryProvider({ hostId, providerId: "retained-history", sessionCount: 1 });
  const bridge = bridgeFor(hostId, provider);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  const opened = await bridge.openSession(parent.id);
  assert.ok(opened.messages.length > 0);
  provider.historyUnavailable = true;

  const side = await bridge.createSideChat(parent.id, "Explain the previous answer.");
  assert.equal(side.initialSendError, undefined);
  assert.equal(side.copiedMessageCount, opened.messages.length);
  assert.equal(provider.sends[0]!.request.content, "Explain the previous answer.");
  assert.match(provider.sends[0]!.request.developerInstructions!, /Seed message for fixture 1/);
  assert.match(provider.sends[0]!.request.developerInstructions!, /Source history availability:/);
  assert.equal(provider.sends[0]?.providerSessionId, side.session.providerSessionId);
  await assert.rejects(bridge.branchSession(parent.id), /list_turns/, "ordinary branches still require their promised full context");
});

test("side chats use a supported bounded history page when full history is unavailable", async (t) => {
  class RecentHistoryProvider extends HistoryProvider {
    public async getRecentMessages(providerSessionId: string): Promise<RecentProviderMessages> {
      return { messages: await FakeProviderAdapter.prototype.getMessages.call(this, providerSessionId), complete: false };
    }
  }
  const hostId = "bounded-side-chat";
  const provider = new RecentHistoryProvider({ hostId, providerId: "bounded-history", sessionCount: 1 });
  provider.historyUnavailable = true;
  const bridge = bridgeFor(hostId, provider);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  const side = await bridge.createSideChat(parent.id, "Explain the current context.");
  assert.equal(side.initialSendError, undefined);
  assert.equal(side.copiedMessageCount, 1);
  assert.equal(provider.sends[0]!.request.content, "Explain the current context.");
  assert.match(provider.sends[0]!.request.developerInstructions!, /Seed message for fixture 1/);
  const opened = await bridge.openSession(side.session.id, undefined, 40, true);
  assert.ok(opened.messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === "Explain the current context.")));
  assert.equal(opened.nextCursor, null, "unavailable older history must not produce a broken load-more action");
});

test("populated side chats retain their loaded messages when history reads later fail", { timeout: 5_000 }, async (t) => {
  const hostId = "reopen-side-chat";
  const provider = new HistoryProvider({ hostId, providerId: "reopen-history", sessionCount: 1 });
  const bridge = bridgeFor(hostId, provider);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  let approvalReady!: () => void;
  const awaitingApproval = new Promise<void>((resolve) => { approvalReady = resolve; });
  const subscription = await provider.subscribe(null, (event) => {
    if (event.type === "approval.requested") approvalReady();
  });
  t.after(() => subscription.unsubscribe());
  const side = await bridge.createSideChat(parent.id, "Keep this side-chat message");
  assert.equal(side.initialSendError, undefined);
  // Let the fixture reach its stable approval wait before checking metadata refresh.
  await awaitingApproval;
  const loaded = await bridge.openSession(side.session.id);
  assert.ok(loaded.messages.some((message) => message.parts.some((part) => part.type === "text" && part.text === "Keep this side-chat message")));
  provider.historyUnavailable = true;
  const getNativeSession = provider.getSession.bind(provider);
  provider.getSession = async (providerSessionId) => ({ ...await getNativeSession(providerSessionId), title: "Renamed side chat" });
  const reopened = await bridge.openSession(side.session.id, undefined, 40, true);
  assert.deepEqual(reopened.messages, loaded.messages);
  assert.equal(reopened.session.title, "Renamed side chat", "history fallback must still refresh available session metadata");
  provider.setOnline(false);
  const offline = await bridge.openSession(side.session.id, undefined, 40, true);
  assert.deepEqual(offline.messages, loaded.messages, "unavailable metadata must not prevent reopening retained context");
});
