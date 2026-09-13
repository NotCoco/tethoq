import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_PROTOCOL_VERSION,
  createHostIdentity,
  type JsonObject,
  type RemoteSession,
} from "../../../packages/protocol/src/index.js";
import {
  FakeProviderAdapter,
} from "../../../packages/provider_fake/src/index.js";
import {
  ProviderAdapterError,
  type CreateSessionOptions,
  type EnqueueProviderMessageRequest,
  type ListSessionsOptions,
  type PaginatedSessions,
  type ProviderQueuedMessage,
  type RestoreProviderMessageRequest,
  type SendMessageRequest,
  type SendMessageResult,
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
  public failRestore = false;

  public constructor(hostId: string, providerId = "provider-queue") {
    super({ hostId, providerId, sessionCount: 1 });
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

  public override hasActiveTurn(_providerSessionId: string): boolean {
    return true;
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
      ...(request.attachments !== undefined ? {
        attachments: request.attachments.map((attachment) => ({
          name: attachment.name,
          mimeType: attachment.mimeType,
          byteLength: attachment.byteLength,
          dataUrl: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
        })),
      } : {}),
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
    if (this.failRestore) throw new Error("simulated restore failure");
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
    if (this.failSteer) {
      throw new ProviderAdapterError(this.providerId, "STEER_REJECTED", "simulated steer failure", true);
    }
    return await super.steerMessage(providerSessionId, request);
  }
}

class InterleavingQueueProvider extends FakeProviderAdapter {
  readonly #queue = new Map<string, ProviderQueuedMessage>();
  #sequence = 0;
  public enqueueCalls = 0;

  public constructor(hostId: string) {
    super({ hostId, providerId: "provider-interleave", sessionCount: 1 });
  }

  public ownsActiveTurn(_providerSessionId: string): boolean {
    return true;
  }

  public async listQueuedMessages(): Promise<readonly ProviderQueuedMessage[]> {
    return [...this.#queue.values()];
  }

  public async enqueueQueuedMessage(
    providerSessionId: string,
    request: EnqueueProviderMessageRequest,
  ): Promise<ProviderQueuedMessage> {
    this.enqueueCalls += 1;
    return this.append(providerSessionId, `tethoq-${this.enqueueCalls}`, request.content);
  }

  public addNativeMessage(providerSessionId: string, content: string): ProviderQueuedMessage {
    return this.append(providerSessionId, `native-${this.#sequence + 1}`, content);
  }

  private append(providerSessionId: string, id: string, content: string): ProviderQueuedMessage {
    const message: ProviderQueuedMessage = {
      id,
      providerSessionId,
      content,
      state: "queued",
      createdAt: new Date(Date.parse("2026-08-30T05:00:00.000Z") + this.#sequence++ * 1_000).toISOString(),
    };
    this.#queue.set(message.id, message);
    return message;
  }
}

class FailingNewTaskProvider extends FakeProviderAdapter {
  public failSend = true;
  public readonly sends: { readonly providerSessionId: string; readonly request: SendMessageRequest }[] = [];

  public override async sendMessage(
    providerSessionId: string,
    request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    this.sends.push({ providerSessionId, request });
    if (this.failSend) return { accepted: false, details: ["simulated new-task delivery failure"] };
    return await super.sendMessage(providerSessionId, request);
  }
}

class FailingNewTaskCreationProvider extends FakeProviderAdapter {
  public override async createSession(_options: CreateSessionOptions): Promise<RemoteSession> {
    throw new Error("simulated new-task creation failure");
  }
}

class CapturingNewTaskProvider extends FakeProviderAdapter {
  public lastSendRequest: SendMessageRequest | undefined;

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.lastSendRequest = request;
    return await super.sendMessage(providerSessionId, request);
  }
}

class FailingSideChatInitialSendProvider extends FakeProviderAdapter {
  public override async sendMessage(
    _providerSessionId: string,
    _request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    throw new ProviderAdapterError(this.providerId, "NOT_DELIVERED", "simulated side-chat initial send failure", true);
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

class NativeBranchTrackingProvider extends FakeProviderAdapter {
  public nativeBranchCalls = 0;
  public readonly createSessionOptions: CreateSessionOptions[] = [];

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const page = await super.listSessions(options);
    return {
      ...page,
      sessions: page.sessions.map((session) => ({ ...session, reasoningEffort: "high" })),
    };
  }

  public override async getSession(providerSessionId: string): Promise<RemoteSession> {
    return { ...await super.getSession(providerSessionId), reasoningEffort: "high" };
  }

  public override async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    this.createSessionOptions.push(options);
    return {
      ...await super.createSession(options),
      ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    };
  }

  public async branchSession(providerSessionId: string): Promise<RemoteSession> {
    this.nativeBranchCalls += 1;
    const source = await this.getSession(providerSessionId);
    return await super.createSession({
      workingDirectory: source.workingDirectory ?? source.project ?? process.cwd(),
      title: `Native branch: ${source.title}`,
      ...(source.modelId !== undefined ? { modelId: source.modelId } : {}),
      ...(source.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
    });
  }
}

test("message_queue.list refreshes native rows added after provider startup", async (t) => {
  const hostId = "host-queue-live-refresh";
  const provider = new InterleavingQueueProvider(hostId);
  const bridge = new AgentBridge(config(hostId, provider.providerId), [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  provider.addNativeMessage(session.providerSessionId, "Queued from Codex after Tethoq opened");
  assert.deepEqual(bridge.queuedMessages(session.id), [], "the fixture must reproduce a missed native change signal");

  const listed = await route(router, hostId, "message_queue.list", { sessionId: session.id });
  assert.equal(listed.ok, true);
  assert.deepEqual((listed.payload.messages as unknown[]).map((message) => object(message).content), [
    "Queued from Codex after Tethoq opened",
  ]);
  assert.deepEqual(bridge.queuedMessages(session.id).map((message) => message.content), [
    "Queued from Codex after Tethoq opened",
  ]);
});

test("Tethoq and Codex queue rows interleave natively during a Tethoq-owned turn", async (t) => {
  const hostId = "host-queue-interleave";
  const provider = new InterleavingQueueProvider(hostId);
  provider.holdActiveTurn = true;
  const bridge = new AgentBridge(config(hostId, provider.providerId), [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await bridge.sendMessage(session.id, { requestId: "queue-owner-turn", content: "Keep this turn active" });
  await bridge.enqueueMessage(session.id, { requestId: "queue-tethoq-first", content: "First from Tethoq" });
  provider.addNativeMessage(session.providerSessionId, "Second from Codex");
  await bridge.enqueueMessage(session.id, { requestId: "queue-tethoq-third", content: "Third from Tethoq" });

  assert.equal(provider.enqueueCalls, 2, "Tethoq kept its rows private instead of joining Codex's shared queue");
  const listed = await route(router, hostId, "message_queue.list", { sessionId: session.id });
  assert.equal(listed.ok, true);
  assert.deepEqual((listed.payload.messages as unknown[]).map((message) => object(message).content), [
    "First from Tethoq",
    "Second from Codex",
    "Third from Tethoq",
  ]);
});

test("queue edit and steer mutate exactly one bridge-owned message and preserve its sibling", async (t) => {
  const hostId = "host-queue-actions";
  const provider = new FakeProviderAdapter({ hostId, sessionCount: 1 });
  provider.holdActiveTurn = true;
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

test("failed native restoration retains a bridge-owned retryable queue copy", async (t) => {
  const hostId = "host-provider-queue-retained";
  const provider = new RestoringQueueProvider(hostId);
  provider.failRestore = true;
  const bridge = new AgentBridge(config(hostId, provider.providerId), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  const selected = bridge.queuedMessages().find((message) => message.content === "First queued prompt");
  assert.ok(selected);
  await assert.rejects(
    () => bridge.deliverQueuedMessage(selected.id, "steer"),
    /simulated steer failure.*simulated restore failure/,
  );

  const retained = bridge.queuedMessages().find((message) => message.id === selected.id);
  assert.equal(retained?.content, "First queued prompt");
  assert.equal(retained?.state, "failed");
  assert.match(retained?.error ?? "", /could not be restored/);
  await bridge.cancelQueuedMessage(selected.id);
  assert.equal(bridge.queuedMessages().some((message) => message.id === selected.id), false);
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
  const preparedDelivery = object(moved.payload.delivery);
  assert.equal(created.providerId, target.providerId);
  assert.equal(created.modelId, "fake-careful");
  assert.equal(created.state, "working");
  assert.equal(preparedDelivery.sessionId, created.id);
  assert.equal(preparedDelivery.state, "pending");
  assert.deepEqual(bridge.queuedMessages(sourceSession.id).map(({ id, content }) => ({ id, content })), [
    { id: sibling.id, content: "Keep this in the original queue" },
  ]);
  assert.equal(typeof created.providerSessionId, "string");
  assert.deepEqual(await target.getMessages(created.providerSessionId as string), [], "preparation must return before provider delivery starts");
  const delivered = await route(router, hostId, "message_queue.deliver_new_task", {
    deliveryId: preparedDelivery.id as string,
  });
  assert.equal(delivered.ok, true);
  assert.equal(object(delivered.payload.delivery).state, "sent");
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
  const target = new FailingNewTaskCreationProvider({ hostId, providerId: "target-fail", sessionCount: 0 });
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
  }), /simulated new-task creation failure/);

  assert.deepEqual(bridge.queuedMessages().map(({ id, content }) => ({ id, content })), before);
});

test("failed new-task delivery stays in one target task and retries with one stable identity", async (t) => {
  const hostId = "host-queue-new-task-retry";
  const source = new FakeProviderAdapter({ hostId, providerId: "retry-source", sessionCount: 1 });
  const target = new FailingNewTaskProvider({ hostId, providerId: "retry-target", sessionCount: 0 });
  const bridge = new AgentBridge(config(hostId, [source.providerId, target.providerId]), [source, target]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const sourceSession = (await bridge.refresh()).sessions.find((session) => session.providerId === source.providerId)!;
  const queued = await bridge.enqueueMessage(sourceSession.id, { requestId: "queue-new-task-retry", content: "Retry this without duplicating it" });

  const prepared = await bridge.moveQueuedMessageToNewTask(queued.id, {
    providerId: target.providerId,
    modelId: "fake-fast",
  });
  const failed = await bridge.deliverQueuedMessageToNewTask(prepared.delivery.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /simulated new-task delivery failure/);
  assert.equal(bridge.sessions().filter((session) => session.providerId === target.providerId).length, 1);
  assert.equal(bridge.queuedMessages(sourceSession.id).some((message) => message.id === queued.id), false);

  target.failSend = false;
  const retried = await bridge.deliverQueuedMessageToNewTask(prepared.delivery.id);
  assert.equal(retried.state, "sent");
  assert.equal(retried.sessionId, prepared.session.id);
  assert.equal(target.sends.length, 2);
  assert.equal(target.sends[0]?.providerSessionId, target.sends[1]?.providerSessionId);
  assert.equal(target.sends[0]?.request.requestId, target.sends[1]?.request.requestId);
  assert.equal(bridge.sessions().filter((session) => session.providerId === target.providerId).length, 1);
  const userText = (await target.getMessages(prepared.session.providerSessionId))
    .filter((message) => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : []));
  assert.deepEqual(userText, ["Retry this without duplicating it"]);
});

test("provider-owned image bytes survive refresh and edit before new-task delivery", async (t) => {
  const hostId = "host-queue-new-task-image";
  const source = new RestoringQueueProvider(hostId, "codex");
  const target = new CapturingNewTaskProvider({ hostId, providerId: "image-target", sessionCount: 0 });
  const bridge = new AgentBridge(config(hostId, [source.providerId, target.providerId]), [source, target]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const sourceSession = (await bridge.refresh()).sessions.find((session) => session.providerId === source.providerId)!;
  const bytes = Buffer.from([11, 22, 33, 44]);
  const upload = bridge.beginAttachmentUpload({ name: "queued-proof.png", mimeType: "image/png", byteLength: bytes.length });
  bridge.appendAttachmentChunk(upload.uploadId, 0, bytes.toString("base64"));
  const completed = bridge.completeAttachmentUpload(upload.uploadId);
  const queued = await bridge.enqueueMessage(sourceSession.id, {
    requestId: "provider-owned-image-handoff",
    content: "Inspect this queued image",
    attachmentIds: [completed.attachmentId],
  });
  assert.match(queued.id, /^provider_queue\//u);

  await bridge.refreshQueuedMessages(sourceSession.id);
  const edited = await bridge.editQueuedMessage(queued.id, "Inspect this edited queued image");
  const prepared = await bridge.moveQueuedMessageToNewTask(edited.id, {
    providerId: target.providerId,
    modelId: "fake-careful",
  });
  const delivered = await bridge.deliverQueuedMessageToNewTask(prepared.delivery.id);
  assert.equal(delivered.state, "sent");
  assert.equal(target.lastSendRequest?.content, "Inspect this edited queued image");
  assert.deepEqual(target.lastSendRequest?.attachments, [{
    name: "queued-proof.png",
    mimeType: "image/png",
    dataBase64: bytes.toString("base64"),
    byteLength: bytes.length,
  }]);
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
  assert.doesNotMatch(sideUserText, /Side-chat role guidance|TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP/);

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

test("a published side chat survives initial-send failure and leaves its parent queue intact", async (t) => {
  const hostId = "host-side-chat-initial-send-failure";
  const provider = new FailingSideChatInitialSendProvider({ hostId, sessionCount: 1 });
  const bridge = new AgentBridge(config(hostId), [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  const selected = await bridge.enqueueMessage(parent.id, {
    requestId: "side-chat-failed-initial-selected",
    content: "Retry this from the visible side chat",
  });
  const sibling = await bridge.enqueueMessage(parent.id, {
    requestId: "side-chat-failed-initial-sibling",
    content: "Keep this sibling queued",
  });

  const created = await route(router, hostId, "side_chat.create", {
    parentSessionId: parent.id,
    queuedMessageId: selected.id,
  });

  assert.equal(created.ok, true);
  assert.equal(created.payload.initialSendError, "simulated side-chat initial send failure");
  const createdSession = object(created.payload.session);
  assert.equal(createdSession.sessionKind, "side_chat");
  assert.equal(createdSession.parentSessionId, parent.id);
  assert.deepEqual(bridge.queuedMessages(parent.id).map(({ id, content }) => ({ id, content })), [
    { id: selected.id, content: "Retry this from the visible side chat" },
    { id: sibling.id, content: "Keep this sibling queued" },
  ]);
  const listed = await route(router, hostId, "side_chat.list", { parentSessionId: parent.id });
  assert.equal(listed.ok, true);
  assert.equal(Array.isArray(listed.payload.sessions), true);
  assert.equal((listed.payload.sessions as unknown[]).some((session) => object(session).id === createdSession.id), true);
  const createdEvent = bridge.eventsSince(0).find((event) => event.type === "side_chat.created");
  assert.equal(object(createdEvent?.payload.session).id, createdSession.id);
});

test("side-chat promotion uses transcript bootstrap while ordinary branching remains native", async (t) => {
  const hostId = "host-side-chat-native-promotion";
  const provider = new NativeBranchTrackingProvider({
    hostId,
    providerId: "native-branch-provider",
    sessionCount: 1,
  });
  const bridge = new AgentBridge(config(hostId, provider.providerId), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  await bridge.interrupt(parent.id);

  const ordinaryBranch = await bridge.branchSession(parent.id);
  assert.equal(ordinaryBranch.strategy, "native");
  assert.equal(provider.nativeBranchCalls, 1);
  assert.equal(ordinaryBranch.session.relationship?.strategy, "native");

  const sideChat = await bridge.createSideChat(parent.id);
  assert.equal(sideChat.session.sessionKind, "side_chat");
  assert.equal(sideChat.session.reasoningEffort, "high");
  const createCallsBeforePromotion = provider.createSessionOptions.length;

  const promoted = await bridge.promoteSideChat(sideChat.session.id);
  assert.equal(provider.nativeBranchCalls, 1);
  assert.equal(provider.createSessionOptions.length, createCallsBeforePromotion + 1);
  assert.equal(promoted.strategy, "transcript_bootstrap");
  assert.notEqual(promoted.session.id, sideChat.session.id);
  assert.notEqual(promoted.session.providerSessionId, sideChat.session.providerSessionId);
  assert.equal(promoted.session.sessionKind, "task");
  assert.equal(promoted.session.parentSessionId, undefined);
  assert.equal(promoted.copiedMessageCount > 0, true);
  assert.equal(typeof promoted.session.nativeMetadata.tethoqBranchBootstrap, "string");
  assert.equal(promoted.session.nativeMetadata.tethoqBranchPending, true);
  assert.deepEqual(promoted.session.relationship, {
    kind: "branch",
    sourceSessionId: sideChat.session.id,
    strategy: "transcript_bootstrap",
  });
  assert.equal(promoted.session.workingDirectory, sideChat.session.workingDirectory);
  assert.equal(promoted.session.modelId, sideChat.session.modelId);
  assert.equal(promoted.session.reasoningEffort, sideChat.session.reasoningEffort);

  const promotionOptions = provider.createSessionOptions.at(-1)!;
  assert.equal(promotionOptions.workingDirectory, sideChat.session.workingDirectory);
  assert.equal(promotionOptions.modelId, sideChat.session.modelId);
  assert.equal(promotionOptions.reasoningEffort, sideChat.session.reasoningEffort);
  assert.deepEqual(promotionOptions.metadata, {
    relationshipKind: "branch",
    relationshipSourceSessionId: sideChat.session.id,
    relationshipStrategy: "transcript_bootstrap",
  });
});
