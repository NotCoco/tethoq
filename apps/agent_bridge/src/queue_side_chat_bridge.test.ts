import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_PROTOCOL_VERSION,
  createHostIdentity,
  type JsonObject,
} from "../../../packages/protocol/src/index.js";
import {
  FakeProviderAdapter,
} from "../../../packages/provider_fake/src/index.js";
import type {
  EnqueueProviderMessageRequest,
  ProviderQueuedMessage,
  RestoreProviderMessageRequest,
  SendMessageRequest,
  SendMessageResult,
} from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { BridgeRequestRouter } from "./request_router.js";

function config(hostId: string, providerId: string | readonly string[] = "fake"): BridgeConfig {
  return {
    version: 1,
    hostId,
    displayName: "Queue and side-chat test host",
    identity: createHostIdentity(),
    enabledProviders: typeof providerId === "string" ? [providerId] : [...providerId],
  };
}

let requestSequence = 0;

async function route(
  router: BridgeRequestRouter,
  hostId: string,
  type: string,
  payload: JsonObject,
) {
  requestSequence += 1;
  return await router.handle({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: `queue-side-chat-message-${requestSequence}`,
    hostId,
    sentAt: "2026-08-15T12:00:00.000Z",
    kind: "request",
    type,
    requestId: `queue-side-chat-request-${requestSequence}`,
    payload,
  });
}

function object(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

class RestoringQueueProvider extends FakeProviderAdapter {
  readonly #queue = new Map<string, ProviderQueuedMessage>();
  #restoredSequence = 0;
  public failSteer = true;

  public constructor(hostId: string) {
    super({ hostId, providerId: "provider-queue", sessionCount: 1 });
    this.#queue.set("first", {
      id: "first",
      providerSessionId: "fake_session_0001",
      content: "First queued prompt",
      state: "queued",
      createdAt: "2026-08-15T10:00:00.000Z",
    });
    this.#queue.set("second", {
      id: "second",
      providerSessionId: "fake_session_0001",
      content: "Second queued prompt",
      state: "queued",
      createdAt: "2026-08-15T10:00:01.000Z",
    });
  }

  public async listQueuedMessages(): Promise<readonly ProviderQueuedMessage[]> {
    return [...this.#queue.values()];
  }

  public async enqueueQueuedMessage(
    providerSessionId: string,
    request: EnqueueProviderMessageRequest,
  ): Promise<ProviderQueuedMessage> {
    const message: ProviderQueuedMessage = {
      id: `restored-${++this.#restoredSequence}`,
      providerSessionId,
      content: request.content,
      state: "queued",
      createdAt: "2026-08-15T10:00:02.000Z",
    };
    this.#queue.set(message.id, message);
    return message;
  }

  public async updateQueuedMessage(
    providerSessionId: string,
    messageId: string,
    content: string,
  ): Promise<ProviderQueuedMessage | null> {
    const current = this.#queue.get(messageId);
    if (current === undefined || current.providerSessionId !== providerSessionId) return null;
    const updated = { ...current, content };
    this.#queue.set(messageId, updated);
    return updated;
  }

  public async restoreQueuedMessage(
    providerSessionId: string,
    request: RestoreProviderMessageRequest,
  ): Promise<ProviderQueuedMessage> {
    const restored: ProviderQueuedMessage = {
      ...request.originalMessage,
      providerSessionId,
      content: request.content,
      state: "queued",
    };
    const entries = [...this.#queue.entries()].filter(([id]) => id !== restored.id);
    const beforeIndex = request.beforeMessageId === undefined
      ? -1
      : entries.findIndex(([id]) => id === request.beforeMessageId);
    entries.splice(beforeIndex >= 0 ? beforeIndex : entries.length, 0, [restored.id, restored]);
    this.#queue.clear();
    for (const [id, message] of entries) this.#queue.set(id, message);
    return restored;
  }

  public async cancelQueuedMessage(providerSessionId: string, messageId: string): Promise<boolean> {
    const current = this.#queue.get(messageId);
    if (current === undefined || current.providerSessionId !== providerSessionId) return false;
    this.#queue.delete(messageId);
    return true;
  }

  public override async steerMessage(
    providerSessionId: string,
    request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    if (this.failSteer) throw new Error("simulated steer failure");
    return await super.steerMessage(providerSessionId, request);
  }
}

class FailingNewTaskProvider extends FakeProviderAdapter {
  public override async sendMessage(
    _providerSessionId: string,
    _request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    throw new Error("simulated new-task failure");
  }
}

class ReasoningNewTaskProvider extends FakeProviderAdapter {
  public override async listModels() {
    return [{
      id: "reasoning-model",
      providerId: this.providerId,
      displayName: "Reasoning model",
      isDefault: true,
      nativeMetadata: {
        supportedReasoningEfforts: [
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
        ],
        defaultReasoningEffort: "medium",
      },
    }];
  }
}

test("queue edit and steer mutate exactly one bridge-owned message and preserve its sibling", async (t) => {
  const hostId = "host-queue-actions";
  const provider = new FakeProviderAdapter({ hostId, sessionCount: 1 });
  const bridge = new AgentBridge(config(hostId), [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  assert.equal(session.state, "working");

  const first = await bridge.enqueueMessage(session.id, { requestId: "queue-first", content: "First draft" });
  const second = await bridge.enqueueMessage(session.id, { requestId: "queue-second", content: "Second draft" });

  const edited = await route(router, hostId, "message_queue.edit", {
    messageId: first.id,
    content: "Edited first draft",
  });
  assert.equal(edited.ok, true);
  assert.equal(object(edited.payload.message).content, "Edited first draft");
  assert.deepEqual(bridge.queuedMessages(session.id).map(({ id, content }) => ({ id, content })), [
    { id: first.id, content: "Edited first draft" },
    { id: second.id, content: "Second draft" },
  ]);

  const delivered = await route(router, hostId, "message_queue.deliver", {
    messageId: first.id,
    mode: "steer",
  });
  assert.equal(delivered.ok, true);
  assert.equal(delivered.payload.delivered, true);
  assert.deepEqual(bridge.queuedMessages(session.id).map(({ id, content }) => ({ id, content })), [
    { id: second.id, content: "Second draft" },
  ]);

  const userMessages = (await provider.getMessages(session.providerSessionId))
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : []));
  assert.equal(userMessages.at(-1), "Edited first draft");
  assert.equal(bridge.eventsSince(0).filter((event) =>
    event.type === "message.queue_removed" && event.payload.messageId === first.id).length, 1);
  assert.equal(bridge.eventsSince(0).some((event) =>
    event.type === "message.queue_removed" && event.payload.messageId === second.id), false);

  const invalidMode = await route(router, hostId, "message_queue.deliver", {
    messageId: second.id,
    mode: "later",
  });
  assert.equal(invalidMode.ok, false);
  assert.match(invalidMode.error?.message ?? "", /mode must be send or steer/);
  assert.deepEqual(bridge.queuedMessages(session.id).map((message) => message.id), [second.id]);
});

test("failed provider-owned delivery restores one message without duplicating it or changing siblings", async (t) => {
  const hostId = "host-provider-queue-restore";
  const provider = new RestoringQueueProvider(hostId);
  const bridge = new AgentBridge(config(hostId, provider.providerId), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  const first = bridge.queuedMessages().find((message) => message.content === "First queued prompt");
  assert.ok(first);
  const originalIds = bridge.queuedMessages().map((message) => message.id);
  const edited = await bridge.editQueuedMessage(first.id, "Edited first queued prompt");
  assert.equal(edited.id, first.id);
  assert.deepEqual(bridge.queuedMessages().map((message) => message.content), [
    "Edited first queued prompt",
    "Second queued prompt",
  ]);
  await assert.rejects(() => bridge.deliverQueuedMessage(first.id, "steer"), /simulated steer failure/);

  const restored = bridge.queuedMessages();
  assert.deepEqual(restored.map((message) => message.content), [
    "Edited first queued prompt",
    "Second queued prompt",
  ]);
  assert.deepEqual(restored.map((message) => message.id), originalIds);
  assert.equal(restored.filter((message) => message.content === "Edited first queued prompt").length, 1);
  assert.equal(restored.filter((message) => message.content === "Second queued prompt").length, 1);
});

test("moving one queued instruction creates a visible task and leaves its sibling queued", async (t) => {
  const hostId = "host-queue-new-task";
  const source = new FakeProviderAdapter({ hostId, providerId: "source", sessionCount: 1 });
  const target = new FakeProviderAdapter({ hostId, providerId: "target", sessionCount: 0 });
  const bridge = new AgentBridge(config(hostId, [source.providerId, target.providerId]), [source, target]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const sourceSession = (await bridge.refresh()).sessions.find((session) => session.providerId === source.providerId);
  assert.ok(sourceSession);
  const selected = await bridge.enqueueMessage(sourceSession.id, { requestId: "queue-new-task-selected", content: "Review the release plan" });
  const sibling = await bridge.enqueueMessage(sourceSession.id, { requestId: "queue-new-task-sibling", content: "Keep this in the original queue" });

  const moved = await route(router, hostId, "message_queue.move_to_new_task", {
    messageId: selected.id,
    providerId: target.providerId,
    modelId: "fake-careful",
  });
  assert.equal(moved.ok, true);
  const created = object(moved.payload.session);
  assert.equal(created.providerId, target.providerId);
  assert.equal(created.modelId, "fake-careful");
  assert.equal(created.state, "working");
  assert.deepEqual(bridge.queuedMessages(sourceSession.id).map(({ id, content }) => ({ id, content })), [
    { id: sibling.id, content: "Keep this in the original queue" },
  ]);
  assert.equal(typeof created.providerSessionId, "string");
  const userText = (await target.getMessages(created.providerSessionId as string))
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : []));
  assert.deepEqual(userText, ["Review the release plan"]);
  const removed = bridge.eventsSince(0).find((event) =>
    event.type === "message.queue_removed" && event.payload.messageId === selected.id);
  assert.equal(removed?.payload.reason, "moved_to_new_task");
  assert.equal(removed?.payload.targetSessionId, created.id);
});

test("failed new-task creation restores a provider-owned queue item in its original position", async (t) => {
  const hostId = "host-queue-new-task-restore";
  const source = new RestoringQueueProvider(hostId);
  const target = new FailingNewTaskProvider({ hostId, providerId: "target-fail", sessionCount: 0 });
  const bridge = new AgentBridge(config(hostId, [source.providerId, target.providerId]), [source, target]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();
  const selected = bridge.queuedMessages().find((message) => message.content === "First queued prompt");
  assert.ok(selected);
  const before = bridge.queuedMessages().map(({ id, content }) => ({ id, content }));

  await assert.rejects(() => bridge.moveQueuedMessageToNewTask(selected.id, {
    providerId: target.providerId,
    modelId: "fake-fast",
  }), /simulated new-task failure/);

  assert.deepEqual(bridge.queuedMessages().map(({ id, content }) => ({ id, content })), before);
});

test("new-task handoff rejects a stale reasoning level without consuming the queue item", async (t) => {
  const hostId = "host-queue-new-task-reasoning";
  const source = new FakeProviderAdapter({ hostId, providerId: "reasoning-source", sessionCount: 1 });
  const target = new ReasoningNewTaskProvider({ hostId, providerId: "reasoning-target", sessionCount: 0 });
  const bridge = new AgentBridge(config(hostId, [source.providerId, target.providerId]), [source, target]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const sourceSession = (await bridge.refresh()).sessions.find((session) => session.providerId === source.providerId);
  assert.ok(sourceSession);
  const queued = await bridge.enqueueMessage(sourceSession.id, { requestId: "queue-stale-reasoning", content: "Keep this until selection is valid" });

  await assert.rejects(() => bridge.moveQueuedMessageToNewTask(queued.id, {
    providerId: target.providerId,
    modelId: "reasoning-model",
    reasoningEffort: "low",
  }), /reasoning level is not available/);
  assert.deepEqual(bridge.queuedMessages(sourceSession.id).map((message) => message.id), [queued.id]);
});

test("side-chat RPCs move only the selected queued message, retain parentage, and promote into a normal task", async (t) => {
  const hostId = "host-side-chat";
  const provider = new FakeProviderAdapter({ hostId, sessionCount: 1 });
  const bridge = new AgentBridge(config(hostId), [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  const selected = await bridge.enqueueMessage(parent.id, { requestId: "side-selected", content: "Inspect this without changing files" });
  const sibling = await bridge.enqueueMessage(parent.id, { requestId: "side-sibling", content: "Keep this queued for the main task" });

  const created = await route(router, hostId, "side_chat.create", {
    parentSessionId: parent.id,
    queuedMessageId: selected.id,
  });
  assert.equal(created.ok, true);
  const createdSession = object(created.payload.session);
  const sideChatId = createdSession.id;
  assert.equal(typeof sideChatId, "string");
  assert.equal(createdSession.sessionKind, "side_chat");
  assert.equal(createdSession.parentSessionId, parent.id);
  assert.equal(object(createdSession.relationship).kind, "side_chat");
  assert.equal(createdSession.nativeMetadata !== undefined, true);
  assert.deepEqual(bridge.queuedMessages(parent.id).map(({ id, content }) => ({ id, content })), [
    { id: sibling.id, content: "Keep this queued for the main task" },
  ]);

  const listed = await route(router, hostId, "side_chat.list", { parentSessionId: parent.id });
  assert.equal(listed.ok, true);
  const listedSessions = listed.payload.sessions;
  assert.ok(Array.isArray(listedSessions));
  assert.equal(listedSessions.length, 1);
  assert.equal(object(listedSessions[0]).id, sideChatId);
  assert.equal(object(listedSessions[0]).sessionKind, "side_chat");
  assert.equal(object(listedSessions[0]).parentSessionId, parent.id);
  assert.equal(object(listedSessions[0]).preview, "Inspect this without changing files");
  assert.deepEqual(object(listedSessions[0]).nativeMetadata, {});
  assert.equal(bridge.crossSessionTargets(parent.id).some((session) => session.id === sideChatId), false);

  const createdEvent = bridge.eventsSince(0).find((event) => event.type === "side_chat.created");
  assert.equal(object(createdEvent?.payload.session).id, sideChatId);
  assert.equal(createdEvent?.payload.sourceSessionId, parent.id);
  const updatedEvent = bridge.eventsSince(0).find((event) => event.type === "side_chat.updated");
  assert.equal(object(updatedEvent?.payload.session).preview, "Inspect this without changing files");

  const side = bridge.sideChats(parent.id)[0]!;
  const sideUserText = (await provider.getMessages(side.providerSessionId))
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : []))
    .join("\n");
  assert.match(sideUserText, /Inspect this without changing files/);
  assert.match(sideUserText, /Side-chat role guidance/);

  const promoted = await route(router, hostId, "side_chat.promote", { sessionId: sideChatId as string });
  assert.equal(promoted.ok, true);
  const promotedSession = object(promoted.payload.session);
  assert.notEqual(promotedSession.id, sideChatId);
  assert.equal(promotedSession.sessionKind, "task");
  assert.equal(promotedSession.parentSessionId, undefined);
  assert.equal(object(promotedSession.relationship).kind, "branch");
  assert.equal(bridge.crossSessionTargets(parent.id).some((session) => session.id === promotedSession.id), true);
  assert.equal(bridge.sideChats(parent.id).some((session) => session.id === sideChatId), true);
  const promotedEvent = bridge.eventsSince(0).find((event) => event.type === "side_chat.promoted");
  assert.equal(object(promotedEvent?.payload.session).id, promotedSession.id);
  assert.equal(promotedEvent?.payload.sourceSideChatId, sideChatId);
  assert.equal(promotedEvent?.payload.promotionMode, "copy");
});
