import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, makeGlobalSessionId, type CrossSessionMessage, type RemoteMessage } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { ProviderEventSink, SendMessageRequest, SendMessageResult, Subscription } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";

function config(): BridgeConfig {
  return {
    version: 1,
    hostId: "host-cross",
    displayName: "Cross-session test host",
    identity: createHostIdentity(),
    enabledProviders: ["fake"],
  };
}

class ControlledProvider extends FakeProviderAdapter {
  public readonly sends: Array<{ readonly providerSessionId: string; readonly request: SendMessageRequest }> = [];
  readonly #sentMessages = new Map<string, RemoteMessage[]>();
  #sink: ProviderEventSink | undefined;
  #event = 0;

  public constructor() {
    super({ hostId: "host-cross", providerId: "fake", sessionCount: 4 });
  }

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.sends.push({ providerSessionId, request });
    const now = new Date().toISOString();
    const sessionId = makeGlobalSessionId("host-cross", this.providerId, providerSessionId);
    const messages = this.#sentMessages.get(providerSessionId) ?? [];
    messages.push({
      id: `${this.providerId}/${request.requestId}`,
      sessionId,
      providerMessageId: request.requestId,
      role: "user",
      createdAt: now,
      completedAt: now,
      parts: [{ type: "text", text: request.content }],
      status: "completed",
      nativeMetadata: {},
    });
    this.#sentMessages.set(providerSessionId, messages);
    return { accepted: true, providerTurnId: request.requestId, details: [] };
  }

  public override async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    return [...await super.getMessages(providerSessionId), ...(this.#sentMessages.get(providerSessionId) ?? [])];
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.#sink = sink;
    return await super.subscribe(providerSessionId, sink);
  }

  public async complete(providerSessionId: string): Promise<void> {
    await this.#sink?.({
      eventId: `controlled_${++this.#event}`,
      providerId: this.providerId,
      providerSessionId,
      type: "agent.completed",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for bridge pump: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("cross-task delivery stays behind every user-queued message and is idempotent", async (t) => {
  const provider = new ControlledProvider();
  const persisted: CrossSessionMessage[][] = [];
  const bridge = new AgentBridge(config(), [provider], {
    onCrossSessionMessagesChange: (messages) => { persisted.push([...messages]); },
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0002");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001"); // Seeded as working.

  await bridge.enqueueMessage(target, { requestId: "user-one", content: "First queued user message" });
  await bridge.enqueueMessage(target, { requestId: "user-two", content: "Second queued user message" });
  const pending = await bridge.sendCrossSessionMessage(source, target, "remote-once", "Cross-task follow-up");
  assert.equal(pending.state, "pending");
  assert.equal(provider.sends.length, 0);

  await provider.complete("fake_session_0001");
  await waitFor(() => provider.sends.length === 1, "first user queue item");
  await waitFor(() => bridge.queuedMessages(target).length === 1, "first queue removal");
  assert.equal(provider.sends[0]?.request.content, "First queued user message");
  await provider.complete("fake_session_0001");
  await waitFor(() => provider.sends.length === 2, "second user queue item");
  await waitFor(() => bridge.queuedMessages(target).length === 0, "second queue removal");
  assert.equal(provider.sends[1]?.request.content, "Second queued user message");
  await provider.complete("fake_session_0001");
  await waitFor(() => provider.sends.length === 3, "cross-task inbox item");
  assert.match(provider.sends[2]?.request.content ?? "", /^\[\[TETHOQ_REMOTE_MESSAGE_V1:/);
  assert.equal(bridge.queuedMessages(target).length, 0);
  assert.equal(bridge.crossSessionInbox(target)[0]?.state, "delivered");

  const repeated = await bridge.sendCrossSessionMessage(source, target, "remote-once", "Cross-task follow-up");
  assert.equal(repeated.envelope.id, pending.envelope.id);
  assert.equal(provider.sends.length, 3);
  assert.ok(persisted.some((snapshot) => snapshot[0]?.state === "pending"));
  assert.ok(persisted.some((snapshot) => snapshot[0]?.state === "delivered"));
});

test("cross-task history exposes validated origin and hides the routing envelope", async (t) => {
  const provider = new ControlledProvider();
  const bridge = new AgentBridge(config(), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0002");

  const sent = await bridge.sendCrossSessionMessage(source, target, "origin-once", "Check the build output.");
  assert.equal(sent.state, "delivered");
  const opened = await bridge.openSession(target);
  const message = opened.messages.find((candidate) => candidate.origin?.kind === "cross_session" && candidate.origin.envelopeId === sent.envelope.id);
  assert.equal(message?.origin?.kind, "cross_session");
  assert.equal(message?.origin?.kind === "cross_session" ? message.origin.sourceSessionId : undefined, source);
  assert.deepEqual(message?.parts, [{ type: "text", text: "Check the build output." }]);
  assert.doesNotMatch(JSON.stringify(message), /TETHOQ_REMOTE_MESSAGE_V1/);
});

test("restart reconciliation recognizes an accepted stable cross-task request without resending it", async (t) => {
  const provider = new ControlledProvider();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0002");
  const envelope = {
    version: 1 as const,
    id: "remote_recovered",
    requestId: "caller-recovered",
    sourceSessionId: source,
    sourceTitle: "Recovered source",
    targetSessionId: target,
    content: "Already accepted before the crash.",
    createdAt: "2026-08-15T12:00:00.000Z",
  };
  await provider.sendMessage("fake_session_0002", {
    requestId: "cross_session_remote_recovered",
    content: `[[TETHOQ_REMOTE_MESSAGE_V1:${envelope.id}]]\nAlready accepted before the crash.`,
  });
  const bridge = new AgentBridge(config(), [provider], {
    crossSessionMessages: [{
      envelope,
      state: "sending",
      attemptCount: 1,
      updatedAt: "2026-08-15T12:00:01.000Z",
    }],
  });
  t.after(() => bridge.dispose());

  await bridge.start();
  await bridge.refresh();

  assert.equal(provider.sends.length, 1, "the accepted provider request must not be duplicated");
  const recovered = bridge.crossSessionInbox(target)[0];
  assert.equal(recovered?.state, "delivered");
  assert.ok(recovered?.providerMessageIds?.includes("cross_session_remote_recovered"));
  assert.equal(bridge.eventsSince(0).filter((event) => event.type === "message.remote_received").length, 1);
});

test("restart reconciliation retries an unaccepted cross-task request with the same stable ID", async (t) => {
  const provider = new ControlledProvider();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0002");
  const envelope = {
    version: 1 as const,
    id: "remote_retry",
    requestId: "caller-retry",
    sourceSessionId: source,
    sourceTitle: "Retry source",
    targetSessionId: target,
    content: "Retry this after recovery.",
    createdAt: "2026-08-15T12:00:00.000Z",
  };
  const bridge = new AgentBridge(config(), [provider], {
    crossSessionMessages: [{
      envelope,
      state: "sending",
      attemptCount: 1,
      updatedAt: "2026-08-15T12:00:01.000Z",
    }],
  });
  t.after(() => bridge.dispose());

  await bridge.start();
  await bridge.refresh();
  await waitFor(() => provider.sends.length === 1, "recovered cross-task retry");
  await waitFor(() => bridge.crossSessionInbox(target)[0]?.state === "delivered", "recovered cross-task completion");

  assert.equal(provider.sends[0]?.request.requestId, "cross_session_remote_retry");
  assert.equal(bridge.crossSessionInbox(target)[0]?.state, "delivered");
});

test("cross-task discovery is bounded, searchable, and excludes the calling task", async (t) => {
  const bridge = new AgentBridge(config(), [new ControlledProvider()]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0002");
  const matches = bridge.crossSessionTargets(source, "project-3", 2);
  assert.ok(matches.length <= 2);
  assert.ok(matches.every((session) => session.id !== source));
  assert.ok(matches.every((session) => session.project === "project-3"));
  await assert.rejects(() => bridge.sendCrossSessionMessage(source, source, "self", "No"), /cannot send a message to itself/);
});
