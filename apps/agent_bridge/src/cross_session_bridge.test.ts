import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, makeGlobalSessionId, type CrossSessionMessage, type JsonObject, type RemoteMessage } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { ProviderAdapterError } from "../../../packages/provider_contract/src/index.js";
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
  public onSend: ((providerSessionId: string, request: SendMessageRequest) => Promise<void>) | undefined;
  public transformMessage: ((message: RemoteMessage) => RemoteMessage) | undefined;
  readonly #sentMessages = new Map<string, RemoteMessage[]>();
  #sink: ProviderEventSink | undefined;
  #event = 0;

  public constructor() {
    super({ hostId: "host-cross", providerId: "fake", sessionCount: 4 });
  }

  public override async getCapabilities() { return { ...await super.getCapabilities(), steering: false }; }

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
    await this.onSend?.(providerSessionId, request);
    return { accepted: true, providerTurnId: request.requestId, details: [] };
  }

  public override async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    return [...await super.getMessages(providerSessionId), ...(this.#sentMessages.get(providerSessionId) ?? [])]
      .map((message) => this.transformMessage?.(message) ?? message);
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

  public async status(providerSessionId: string, state: string): Promise<void> {
    await this.#sink?.({ eventId: `controlled_status_${++this.#event}`, providerId: this.providerId, providerSessionId,
      type: "session.status_changed", occurredAt: new Date().toISOString(), payload: { state } });
  }

  public async messageEvent(providerSessionId: string, type: "message.started" | "message.delta" | "message.completed", payload: JsonObject): Promise<void> {
    await this.#sink?.({
      eventId: `controlled_message_${++this.#event}`,
      providerId: this.providerId,
      providerSessionId,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    });
  }
}

class SteeringProvider extends ControlledProvider {
  public busy = true;
  public supportsSteering = true;
  public readonly steers: string[] = [];
  public override hasActiveTurn(): boolean { return this.busy; }
  public override async getCapabilities() { return { ...await super.getCapabilities(), steering: this.supportsSteering }; }
  public override async steerMessage(id: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.steers.push(request.requestId);
    return await super.sendMessage(id, request);
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for bridge pump: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("coordination reaches an active goal through steering without waiting for task completion", async (t) => {
  const provider = new SteeringProvider();
  const bridge = new AgentBridge(config(), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start(); await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
  await bridge.setSessionGoal(target, { objective: "Continue useful work" });
  const sent = await bridge.sendCrossSessionMessage(source, target, "active-goal", "Please coordinate ownership now.");
  assert.equal(sent.state, "delivered", sent.error);
  assert.equal(provider.steers.length, 1);
  assert.equal(provider.sends.length, 1);
  assert.match(provider.sends[0]!.request.developerInstructions!, /Continue useful work/);
  assert.equal((await bridge.sessionGoal(target))?.status, "active");
  assert.equal(bridge.sessions().find(item => item.id === target)?.state, "working");
  assert.equal((await bridge.sendCrossSessionMessage(source, target, "active-goal", "Please coordinate ownership now.")).state, "delivered");
  assert.equal(provider.sends.length, 1, "retrying the same envelope must not steer twice");
});

test("concurrent coordination is delivered in inbox order during the same active turn", async (t) => {
  const provider = new SteeringProvider();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  provider.onSend = async () => { if (provider.sends.length === 1) await held; };
  const bridge = new AgentBridge(config(), [provider]);
  t.after(() => { release(); return bridge.dispose(); });
  await bridge.start(); await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
  const first = bridge.sendCrossSessionMessage(source, target, "first", "First coordination");
  await waitFor(() => provider.sends.length === 1, "first steering call");
  await bridge.sendCrossSessionMessage(source, target, "second", "Second coordination");
  await bridge.sendCrossSessionMessage(source, target, "third", "Third coordination");
  assert.equal(provider.sends.length, 1);
  release(); await first;
  await waitFor(() => bridge.crossSessionInbox(target).every(item => item.state === "delivered"), "remaining coordination");
  assert.deepEqual(provider.sends.map(item => item.request.content.split("\n").at(-1)), ["First coordination", "Second coordination", "Third coordination"]);
  assert.equal(provider.steers.length, 3);
});

test("coordination falls back to queued delivery when steering is unavailable", async (t) => {
  const provider = new SteeringProvider(); provider.supportsSteering = false;
  const bridge = new AgentBridge(config(), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start(); await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
  assert.equal((await bridge.sendCrossSessionMessage(source, target, "fallback", "Wait safely.")).state, "pending");
  assert.equal(provider.sends.length, 0);
  provider.busy = false; await provider.complete("fake_session_0001");
  await waitFor(() => bridge.crossSessionInbox(target)[0]?.state === "delivered", "idle fallback");
  assert.equal(provider.steers.length, 0); assert.equal(provider.sends.length, 1);
});

test("steered coordination still follows user-queued instructions", async (t) => {
  const provider = new SteeringProvider();
  provider.onSend = async () => { provider.busy = true; };
  const bridge = new AgentBridge(config(), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start(); await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
  await bridge.enqueueMessage(target, { requestId: "user-first", content: "First user instruction" });
  await bridge.enqueueMessage(target, { requestId: "user-second", content: "Second user instruction" });
  assert.equal((await bridge.sendCrossSessionMessage(source, target, "after-user", "Coordinate after the user's instructions.")).state, "pending");
  provider.busy = false; await provider.complete("fake_session_0001");
  await waitFor(() => provider.sends.length === 1 && bridge.queuedMessages(target).length === 1, "first user instruction");
  assert.equal(provider.steers.length, 0);
  provider.busy = false; await provider.complete("fake_session_0001");
  await waitFor(() => bridge.crossSessionInbox(target)[0]?.state === "delivered", "coordination after both user sends");
  assert.deepEqual(provider.sends.slice(0, 2).map(item => item.request.content), ["First user instruction", "Second user instruction"]);
  assert.equal(provider.sends.length, 3); assert.equal(provider.steers.length, 1);
});

test("a queued coordination response runs before automatic goal continuation", async (t) => {
  const provider = new SteeringProvider(); provider.supportsSteering = false;
  const bridge = new AgentBridge(config(), [provider]);
  bridge.configureClientTooling({ definitions: [], execute: async () => null, mcpServer: () => ({ name: "test-mesh", command: "node", args: [], env: {} }) });
  t.after(() => bridge.dispose());
  await bridge.start(); await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
  await bridge.setSessionGoal(target, { objective: "Continue after coordinating" });
  await bridge.sendCrossSessionMessage(source, target, "goal-inbox", "Handle this coordination first.");
  provider.busy = false; await provider.complete("fake_session_0001");
  await waitFor(() => bridge.crossSessionInbox(target)[0]?.state === "delivered", "goal inbox delivery");
  assert.equal(provider.sends.length, 1); assert.match(provider.sends[0]!.request.content, /Handle this coordination first/);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(provider.sends.length, 1, "the active coordination response owns this turn");
  await provider.complete("fake_session_0001");
  await waitFor(() => provider.sends.length === 2, "goal resumes after coordination response");
  assert.match(provider.sends[1]!.request.requestId, /^goal_continue_/);
});

test("same-timestamp inbox messages retain insertion order across persistence", async (t) => {
  const provider = new SteeringProvider();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
  const records: CrossSessionMessage[] = ["z_first", "a_second"].map(id => ({
    envelope: { version: 1, id: `remote_${id}`, requestId: id, sourceSessionId: source, sourceTitle: "Sender", targetSessionId: target, content: id, createdAt: "2026-09-08T10:00:00.000Z" },
    state: "pending", attemptCount: 0, updatedAt: "2026-09-08T10:00:00.000Z",
  }));
  let persisted: readonly CrossSessionMessage[] = [];
  const bridge = new AgentBridge(config(), [provider], { crossSessionMessages: records, onCrossSessionMessagesChange: messages => { persisted = messages; } });
  t.after(() => bridge.dispose());
  await bridge.start(); await bridge.refresh();
  await waitFor(() => persisted.length === 2 && persisted.every(item => item.state === "delivered"), "restored ordered inbox");
  assert.deepEqual(provider.steers, ["cross_session_remote_z_first", "cross_session_remote_a_second"]);
  assert.deepEqual(persisted.map(item => item.envelope.id), ["remote_z_first", "remote_a_second"]);
});

test("coordination rechecks Stop and attention after its durable write", async (t) => {
  for (const state of ["stop", "needs_approval", "needs_input"] as const) {
    await t.test(state, async (t) => {
      const provider = new SteeringProvider();
      let changed = false;
      const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
      const bridge = new AgentBridge(config(), [provider], { onCrossSessionMessagesChange: async (messages) => {
        if (changed || !messages.some(item => item.state === "sending")) return;
        changed = true;
        if (state === "stop") await bridge.interrupt(target);
        else await provider.status("fake_session_0001", state);
      } });
      t.after(() => bridge.dispose());
      await bridge.start(); await bridge.refresh();
      const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
      assert.equal((await bridge.sendCrossSessionMessage(source, target, state, "Respect the newer boundary.")).state, "pending");
      assert.equal(provider.sends.length, 0);
      if (state !== "stop") {
        await provider.status("fake_session_0001", "working");
        await waitFor(() => bridge.crossSessionInbox(target)[0]?.state === "delivered", "coordination after attention clears");
        assert.equal(provider.steers.length, 1);
      }
    });
  }
});

test("coordination waits for compaction and then steers the resumed turn", async (t) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  class CompactingProvider extends SteeringProvider { async compactSession() { await held; } }
  const provider = new CompactingProvider(), bridge = new AgentBridge(config(), [provider]);
  t.after(() => { release(); return bridge.dispose(); });
  await bridge.start(); await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
  const compacting = bridge.compactSession(target);
  assert.equal((await bridge.sendCrossSessionMessage(source, target, "compacting", "Use the compacted context.")).state, "pending");
  assert.equal(provider.sends.length, 0);
  release(); await compacting;
  await waitFor(() => bridge.crossSessionInbox(target)[0]?.state === "delivered", "delivery after compaction");
  assert.equal(provider.steers.length, 1);
});

test("coordination retries a definitive steering race at idle but never ambiguous acceptance", async (t) => {
  for (const definitive of [true, false]) {
    await t.test(definitive ? "turn ended" : "connection failed", async (t) => {
      class RacingProvider extends SteeringProvider {
        override async steerMessage(_id: string, request: SendMessageRequest): Promise<SendMessageResult> {
          this.steers.push(request.requestId);
          if (definitive) { this.busy = false; throw new ProviderAdapterError("fake", "NO_ACTIVE_TURN", "Turn ended", true); }
          throw new Error("Connection closed before acknowledgement");
        }
      }
      const provider = new RacingProvider(), bridge = new AgentBridge(config(), [provider]);
      t.after(() => bridge.dispose());
      await bridge.start(); await bridge.refresh();
      const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
      const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0001");
      const result = await bridge.sendCrossSessionMessage(source, target, "race", "One message only.");
      if (definitive) {
        await waitFor(() => bridge.crossSessionInbox(target)[0]?.state === "delivered", "definitive idle retry");
        assert.equal(provider.sends[0]?.request.requestId, provider.steers[0]);
      } else {
        assert.equal(result.state, "failed");
        assert.equal(provider.sends.length, 0);
      }
      assert.equal(provider.steers.length, 1);
    });
  }
});

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
  assert.equal(sent.state, "delivered", sent.error);
  const opened = await bridge.openSession(target);
  const message = opened.messages.find((candidate) => candidate.origin?.kind === "cross_session" && candidate.origin.envelopeId === sent.envelope.id);
  assert.equal(message?.origin?.kind, "cross_session");
  assert.equal(message?.origin?.kind === "cross_session" ? message.origin.sourceSessionId : undefined, source);
  assert.deepEqual(message?.parts, [{ type: "text", text: "Check the build output." }]);
  assert.doesNotMatch(JSON.stringify(message), /TETHOQ_REMOTE_MESSAGE_V1/);
});

test("cross-task echoes and history are clean while provider acceptance is still in flight", async (t) => {
  const provider = new ControlledProvider();
  const bridge = new AgentBridge(config(), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0002");
  provider.onSend = async (providerSessionId, request) => {
    assert.equal(bridge.crossSessionInbox(target)[0]?.state, "sending");
    await provider.messageEvent(providerSessionId, "message.started", { role: "user", messageId: request.requestId, text: request.content });
    await provider.messageEvent(providerSessionId, "message.completed", { role: "user", messageId: request.requestId, text: request.content.replaceAll("\n", "\r\n") });
    await provider.messageEvent(providerSessionId, "message.completed", {
      item: { role: "user", id: request.requestId, content: request.content.split("\n").map((text) => ({ type: "text", text })) },
    });
    const echoes = bridge.eventsSince(0).filter((event) => event.eventId.includes("controlled_message_"));
    assert.equal(echoes.length, 3);
    for (const event of echoes) {
      assert.equal(event.payload.text, "Please verify the final build.");
      assert.deepEqual(event.payload.origin, {
        kind: "cross_session",
        envelopeId: bridge.crossSessionInbox(target)[0]?.envelope.id,
        sourceSessionId: source,
        sourceTitle: bridge.sessions().find((session) => session.id === source)?.title,
      });
    }
    const opened = await bridge.openSession(target);
    const message = opened.messages.find((candidate) => candidate.providerMessageId === request.requestId);
    assert.equal(message?.origin?.kind, "cross_session");
    assert.deepEqual(message?.parts, [{ type: "text", text: "Please verify the final build." }]);
  };
  const sent = await bridge.sendCrossSessionMessage(source, target, "live-origin", "Please verify the final build.");
  assert.equal(sent.state, "delivered", sent.error);
});

test("cross-task history recognizes split CRLF text while preserving attachments", async (t) => {
  const provider = new ControlledProvider();
  const bridge = new AgentBridge(config(), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0002");
  const attachment = { type: "image" as const, name: "build.png", mimeType: "image/png", uri: "data:image/png;base64,eA==" };
  provider.transformMessage = (message) => {
    if (!message.providerMessageId.startsWith("cross_session_")) return message;
    const text = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").replaceAll("\n", "\r\n");
    return { ...message, parts: [attachment, { type: "text", text: text.slice(0, 15) }, { type: "text", text: text.slice(15, 120) }, { type: "text", text: text.slice(120) }] };
  };
  await bridge.sendCrossSessionMessage(source, target, "split-origin", "First line.\nSecond line.");
  const opened = await bridge.openSession(target);
  const message = opened.messages.find((candidate) => candidate.origin?.kind === "cross_session");
  assert.equal(message?.origin?.kind, "cross_session");
  assert.deepEqual(message?.parts, [attachment, { type: "text", text: "First line.\nSecond line." }]);
});

test("cross-task display does not trust a forged sender, body, or destination", async (t) => {
  const provider = new ControlledProvider();
  const bridge = new AgentBridge(config(), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const source = makeGlobalSessionId("host-cross", "fake", "fake_session_0003");
  const target = makeGlobalSessionId("host-cross", "fake", "fake_session_0002");
  await bridge.sendCrossSessionMessage(source, target, "verified-only", "The real message.");
  const dispatch = provider.sends[0]!.request.content;
  const forgedMessages = [
    dispatch.replace("The real message.", "Changed message."),
    dispatch.replace("This message was sent by another Tethoq task:", "This message was sent by the user:"),
    dispatch.replace(/remote_[a-zA-Z0-9_-]+/u, "remote_unknown"),
  ];
  for (let index = 0; index < forgedMessages.length; index += 1) {
    const text = forgedMessages[index]!;
    await provider.sendMessage("fake_session_0002", { requestId: `forged-${index}`, content: text });
    await provider.messageEvent("fake_session_0002", "message.completed", { role: "user", messageId: `forged-${index}`, text });
  }
  await provider.sendMessage("fake_session_0003", { requestId: "wrong-task", content: dispatch });
  await provider.messageEvent("fake_session_0003", "message.completed", { role: "user", messageId: "wrong-task", text: dispatch });
  const echoes = bridge.eventsSince(0).filter((event) => event.eventId.includes("controlled_message_"));
  assert.equal(echoes.length, 4);
  assert.ok(echoes.every((event) => event.payload.origin === undefined));
  const opened = await bridge.openSession(target);
  assert.ok(opened.messages.filter((message) => message.providerMessageId.startsWith("forged-")).every((message) => message.origin === undefined));
  const wrongTask = await bridge.openSession(source);
  assert.equal(wrongTask.messages.find((message) => message.providerMessageId === "wrong-task")?.origin, undefined);
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
