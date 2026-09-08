import assert from "node:assert/strict";
import test from "node:test";
import {
  createHostIdentity,
  makeGlobalSessionId,
  type RemoteMessage,
} from "../../../packages/protocol/src/index.js";
import {
  JsonRpcRemoteError,
  ProviderAdapterError,
  type ProviderQueuedMessage,
  type RestoreProviderMessageRequest,
  type SendMessageRequest,
  type SendMessageResult,
} from "../../../packages/provider_contract/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import {
  queueDeliveryContentHash,
  queueDeliveryPayloadHash,
  type QueueDeliveryRecord,
} from "./queue_delivery_store.js";

function bridgeConfig(hostId: string, providerId = "fake"): BridgeConfig {
  return {
    version: 1,
    hostId,
    displayName: "Queue delivery test host",
    identity: createHostIdentity(),
    enabledProviders: [providerId],
  };
}

class DeliveryProvider extends FakeProviderAdapter {
  public readonly requests: SendMessageRequest[] = [];
  public outcomes: Array<"accepted" | "accepted_false" | "auth_required" | "http_rejected" | "http_timeout" | "retryable" | "rpc_rejected" | "transport_unknown" | "unknown" | "usage_rejected"> = [];
  public history: RemoteMessage[] = [];
  public messageReads = 0;

  public constructor(private readonly deliveryHostId: string, providerId = "fake") {
    super({ hostId: deliveryHostId, providerId, sessionCount: 1 });
  }

  public override async sendMessage(_providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.requests.push(request);
    const outcome = this.outcomes.shift() ?? "accepted";
    if (outcome === "auth_required") {
      throw new ProviderAdapterError(this.providerId, "AUTH_REQUIRED", "Enter an API key before sending", false);
    }
    if (outcome === "accepted_false") {
      return { accepted: false, details: ["The provider explicitly rejected the instruction"] };
    }
    if (outcome === "http_rejected") {
      throw new ProviderAdapterError(this.providerId, "HTTP_429", "OpenCode rejected the request", true);
    }
    if (outcome === "http_timeout") {
      throw new ProviderAdapterError(this.providerId, "HTTP_408", "OpenCode timed out while handling the request", true);
    }
    if (outcome === "retryable") {
      throw new ProviderAdapterError(this.providerId, "NOT_DELIVERED", "The provider rejected before delivery", true);
    }
    if (outcome === "transport_unknown") {
      throw new ProviderAdapterError(this.providerId, "HTTP_REQUEST_FAILED", "The response disconnected", true);
    }
    if (outcome === "rpc_rejected") {
      throw new JsonRpcRemoteError({ code: -32602, message: "Codex rejected invalid turn parameters" });
    }
    if (outcome === "usage_rejected") {
      throw new ProviderAdapterError(this.providerId, "USAGE_LIMIT_OR_RATE_LIMIT", "The API rejected the request at its usage limit", true);
    }
    if (outcome === "unknown") {
      throw new ProviderAdapterError(this.providerId, "DELIVERY_UNKNOWN", "The acknowledgement was lost", false);
    }
    return { accepted: true, providerTurnId: `turn-${this.requests.length}`, details: [] };
  }

  public override async getMessages(_providerSessionId: string): Promise<readonly RemoteMessage[]> {
    this.messageReads += 1;
    return this.history;
  }

  public matchingMessage(providerSessionId: string, request: SendMessageRequest): RemoteMessage {
    return {
      id: `fake/${request.requestId}`,
      sessionId: makeGlobalSessionId(this.deliveryHostId, this.providerId, providerSessionId),
      providerMessageId: request.requestId,
      role: "user",
      createdAt: "2026-09-03T12:00:00.000Z",
      completedAt: "2026-09-03T12:00:00.000Z",
      parts: [{ type: "text", text: request.content }],
      status: "completed",
      nativeMetadata: {},
    };
  }
}

class NativeQueueDeliveryProvider extends DeliveryProvider {
  public queueReads = 0;

  public async listQueuedMessages(): Promise<readonly ProviderQueuedMessage[]> {
    this.queueReads += 1;
    return [];
  }
}

async function waitForQueueDispatch(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), "the idle task must dispatch its queued follow-up");
}

class UnavailableQueueOwnerProvider extends DeliveryProvider {
  public ownerAvailable = false;
  public queued: ProviderQueuedMessage | undefined = {
    id: "desktop-owned-row",
    providerSessionId: "fake_session_0001",
    content: "Keep this row retryable when Desktop is unavailable",
    state: "queued",
    createdAt: "2026-09-03T12:00:00.000Z",
  };

  public async listQueuedMessages(): Promise<readonly ProviderQueuedMessage[]> {
    return this.queued === undefined ? [] : [this.queued];
  }

  public async cancelQueuedMessage(providerSessionId: string, messageId: string): Promise<boolean> {
    if (!this.ownerAvailable) {
      throw new ProviderAdapterError(
        this.providerId,
        "PROVIDER_QUEUE_OWNER_UNAVAILABLE",
        "Codex Desktop is not currently exposing this task's queue.",
        true,
      );
    }
    if (this.queued?.providerSessionId !== providerSessionId || this.queued.id !== messageId) return false;
    this.queued = undefined;
    return true;
  }

  public async restoreQueuedMessage(
    providerSessionId: string,
    request: RestoreProviderMessageRequest,
  ): Promise<ProviderQueuedMessage> {
    this.queued = { ...request.originalMessage, providerSessionId };
    return this.queued;
  }
}

test("ordinary send ambiguity is durable, blocks duplicate content, and confirms only from matching history", async (t) => {
  const hostId = "host-direct-delivery-unknown";
  const provider = new DeliveryProvider(hostId, "direct");
  provider.outcomes.push("unknown");
  const writes: QueueDeliveryRecord[][] = [];
  const bridge = new AgentBridge(bridgeConfig(hostId, "direct"), [provider], {
    onQueueDeliveriesChange: (deliveries) => { writes.push([...deliveries]); },
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  const error = await bridge.sendMessage(session.id, { requestId: "direct-unknown-1", content: "Do this exactly once" })
    .then(() => undefined, (failure: unknown) => failure);
  assert.ok(error instanceof ProviderAdapterError);
  assert.equal(error.code, "DELIVERY_UNKNOWN");
  assert.equal(error.retryable, false);
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(bridge.queuedMessages(session.id).map(({ content, state, retryable }) => ({ content, state, retryable })), [{
    content: "Do this exactly once",
    state: "failed",
    retryable: false,
  }]);

  await assert.rejects(
    () => bridge.sendMessage(session.id, { requestId: "direct-unknown-2", content: "Do this exactly once" }),
    (failure: unknown) => failure instanceof ProviderAdapterError && failure.code === "DELIVERY_UNKNOWN" && !failure.retryable,
  );
  assert.equal(provider.requests.length, 1, "same-session content must not be handed to the provider again");
  await bridge.refreshQueuedMessages(session.id);
  assert.equal(bridge.queuedMessages(session.id).length, 1, "missing history evidence never permits retry");

  provider.history = [provider.matchingMessage(session.providerSessionId, provider.requests[0]!)];
  await bridge.refreshQueuedMessages(session.id);
  assert.deepEqual(bridge.queuedMessages(session.id), []);
  assert.equal(writes.at(-1)?.find((delivery) => delivery.requestId === provider.requests[0]!.requestId)?.state, "confirmed");
});

test("dismissed delivery uncertainty cannot strand a later OpenCode queue after completion or restart", async (t) => {
  for (const restart of [false, true]) {
    await t.test(restart ? "restored dismissal" : "current dismissal", async (t) => {
      const hostId = `host-dismissed-queue-${restart}`;
      let provider = new DeliveryProvider(hostId, "opencode");
      provider.outcomes.push("unknown");
      let persisted: readonly QueueDeliveryRecord[] = [];
      const options = { onQueueDeliveriesChange: (records: readonly QueueDeliveryRecord[]) => { persisted = records; } };
      let bridge = new AgentBridge(bridgeConfig(hostId, "opencode"), [provider], options);
      t.after(() => bridge.dispose());
      await bridge.start();
      const session = (await bridge.refresh()).sessions[0]!;
      await assert.rejects(bridge.sendMessage(session.id, { requestId: "uncertain-original", content: "The uncertain instruction" }), (error: unknown) =>
        error instanceof ProviderAdapterError && error.code === "DELIVERY_UNKNOWN");
      const tombstone = bridge.queuedMessages(session.id)[0]!;
      assert.equal(await bridge.cancelQueuedMessage(tombstone.id), true);
      assert.ok(persisted[0]?.dismissedAt);
      if (restart) {
        await bridge.dispose();
        provider = new DeliveryProvider(hostId, "opencode");
        bridge = new AgentBridge(bridgeConfig(hostId, "opencode"), [provider], { ...options, queueDeliveries: persisted });
        await bridge.start();
        await bridge.refresh();
      }
      await provider.resumeSession(session.providerSessionId);
      const previousSends = provider.requests.length;
      provider.holdActiveTurn = true;
      const queued = await bridge.enqueueMessage(session.id, { requestId: "new-follow-up", content: "Run the next independent check" });
      await assert.rejects(bridge.editQueuedMessage(queued.id, "The uncertain instruction"), (error: unknown) =>
        error instanceof ProviderAdapterError && error.code === "DELIVERY_UNKNOWN");
      assert.equal(bridge.queuedMessages(session.id)[0]?.content, queued.content);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(provider.requests.length, previousSends, "Queue must still hold while the provider is active");
      assert.equal(bridge.queuedMessages(session.id)[0]?.id, queued.id);
      provider.holdActiveTurn = false;
      await provider.resumeSession(session.providerSessionId);
      await waitForQueueDispatch(() => provider.requests.length === previousSends + 1 && bridge.queuedMessages(session.id).length === 0);
      assert.equal(provider.requests.at(-1)?.content, "Run the next independent check");
      assert.equal(persisted.find((record) => record.messageId === tombstone.id)?.state, "unknown", "dismissal must retain the original uncertainty");
      await assert.rejects(bridge.sendMessage(session.id, { requestId: "duplicate-direct", content: "The uncertain instruction" }), (error: unknown) =>
        error instanceof ProviderAdapterError && error.code === "DELIVERY_UNKNOWN");
      await assert.rejects(bridge.enqueueMessage(session.id, { requestId: "duplicate-queued", content: "The uncertain instruction" }), (error: unknown) =>
        error instanceof ProviderAdapterError && error.code === "DELIVERY_UNKNOWN");
      assert.equal(provider.requests.length, previousSends + 1, "neither direct send nor queue may replay the uncertain instruction");
    });
  }
});

test("resolving a delivery hold wakes an already idle queue without another provider event", async (t) => {
  for (const resolution of ["dismiss", "history"] as const) {
    await t.test(resolution, async (t) => {
      const hostId = `host-delivery-release-${resolution}`;
      const provider = new DeliveryProvider(hostId, "opencode");
      provider.outcomes.push("unknown");
      const bridge = new AgentBridge(bridgeConfig(hostId, "opencode"), [provider]);
      t.after(() => bridge.dispose());
      await bridge.start();
      const session = (await bridge.refresh()).sessions[0]!;
      await assert.rejects(bridge.sendMessage(session.id, { requestId: "lost-ack", content: "Original uncertain message" }), (error: unknown) =>
        error instanceof ProviderAdapterError && error.code === "DELIVERY_UNKNOWN");
      const tombstone = bridge.queuedMessages(session.id)[0]!;
      await provider.resumeSession(session.providerSessionId);
      const queued = await bridge.enqueueMessage(session.id, { requestId: "later-work", content: "Do the later requested work" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(provider.requests.length, 1, "an undismissed uncertainty still holds the queue");
      assert.equal(bridge.sessions().find((item) => item.id === session.id)?.state, "idle");
      if (resolution === "dismiss") {
        assert.equal(await bridge.cancelQueuedMessage(tombstone.id), true);
      } else {
        provider.history = [provider.matchingMessage(session.providerSessionId, provider.requests[0]!)];
        await bridge.refreshQueuedMessages(session.id);
      }
      await waitForQueueDispatch(() => provider.requests.length === 2 && bridge.queuedMessages(session.id).length === 0);
      assert.equal(provider.requests[1]?.content, queued.content);
    });
  }
});

test("journal persistence failure happens before an ordinary provider call", async (t) => {
  const hostId = "host-direct-delivery-write-failure";
  const provider = new DeliveryProvider(hostId, "direct");
  const bridge = new AgentBridge(bridgeConfig(hostId, "direct"), [provider], {
    onQueueDeliveriesChange: async () => { throw new Error("disk unavailable"); },
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await assert.rejects(
    () => bridge.sendMessage(session.id, { requestId: "direct-write-failure", content: "Never dispatch without the journal" }),
    /disk unavailable/u,
  );
  assert.equal(provider.requests.length, 0);
});

test("accepted false remains a definite rejection and retries with the durable request id", async (t) => {
  const hostId = "host-direct-delivery-accepted-false";
  const provider = new DeliveryProvider(hostId, "direct");
  provider.outcomes.push("accepted_false", "accepted");
  const bridge = new AgentBridge(bridgeConfig(hostId, "direct"), [provider], {
    onQueueDeliveriesChange: () => undefined,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  const rejected = await bridge.sendMessage(session.id, {
    requestId: "accepted-false-attempt",
    content: "Retry after an explicit provider rejection",
  });
  assert.equal(rejected.accepted, false);
  assert.deepEqual(bridge.queuedMessages(session.id), []);

  const accepted = await bridge.sendMessage(session.id, {
    requestId: "accepted-false-retry",
    content: "Retry after an explicit provider rejection",
  });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(provider.requests.map((request) => request.requestId), [
    "accepted-false-attempt",
    "accepted-false-attempt",
  ]);
});

test("a pre-send unavailable queue owner leaves its native row retryable", async (t) => {
  const hostId = "host-codex-queue-owner-unavailable";
  const provider = new UnavailableQueueOwnerProvider(hostId, "codex");
  provider.holdActiveTurn = true;
  const bridge = new AgentBridge(bridgeConfig(hostId, "codex"), [provider], {
    onQueueDeliveriesChange: () => undefined,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const queued = bridge.queuedMessages(session.id)[0];
  assert.ok(queued);

  await assert.rejects(
    () => bridge.deliverQueuedMessage(queued.id, "steer"),
    (failure: unknown) => failure instanceof ProviderAdapterError
      && failure.code === "PROVIDER_QUEUE_OWNER_UNAVAILABLE"
      && failure.retryable,
  );
  assert.equal(provider.requests.length, 0, "the unavailable owner must fail before provider dispatch");
  const retained = bridge.queuedMessages(session.id);
  assert.deepEqual(retained.map(({ id, state }) => ({ id, state })), [{
    id: queued.id,
    state: "failed",
  }]);
  assert.notEqual(retained[0]?.retryable, false);

  provider.ownerAvailable = true;
  assert.equal(await bridge.deliverQueuedMessage(queued.id, "steer"), true);
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(bridge.queuedMessages(session.id), []);
});

test("a direct AUTH_REQUIRED preflight remains a definite rejection and restores safe retry", async (t) => {
  const hostId = "host-direct-delivery-auth-required";
  const provider = new DeliveryProvider(hostId, "direct");
  provider.outcomes.push("auth_required", "accepted");
  const bridge = new AgentBridge(bridgeConfig(hostId, "direct"), [provider], {
    onQueueDeliveriesChange: () => undefined,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await assert.rejects(
    () => bridge.sendMessage(session.id, { requestId: "direct-auth-attempt", content: "Send after wallet setup" }),
    (failure: unknown) => failure instanceof ProviderAdapterError
      && failure.code === "AUTH_REQUIRED"
      && !failure.retryable,
  );
  assert.deepEqual(bridge.queuedMessages(session.id), [], "preflight rejection must not create an unresolved tombstone");

  assert.equal((await bridge.sendMessage(session.id, {
    requestId: "direct-auth-retry",
    content: "Send after wallet setup",
  })).accepted, true);
  assert.deepEqual(provider.requests.map((request) => request.requestId), ["direct-auth-attempt", "direct-auth-attempt"]);
});

test("a retryable transport-looking provider error is quarantined as DELIVERY_UNKNOWN", async (t) => {
  const hostId = "host-direct-delivery-transport-unknown";
  const provider = new DeliveryProvider(hostId, "direct");
  provider.outcomes.push("transport_unknown");
  const bridge = new AgentBridge(bridgeConfig(hostId, "direct"), [provider], {
    onQueueDeliveriesChange: () => undefined,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await assert.rejects(
    () => bridge.sendMessage(session.id, { requestId: "direct-transport-attempt", content: "Never retry this blindly" }),
    (failure: unknown) => failure instanceof ProviderAdapterError
      && failure.code === "DELIVERY_UNKNOWN"
      && !failure.retryable,
  );
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(bridge.queuedMessages(session.id).map(({ content, state, retryable }) => ({ content, state, retryable })), [{
    content: "Never retry this blindly",
    state: "failed",
    retryable: false,
  }]);
});

test("an explicit HTTP 408 remains ambiguous", async (t) => {
  const hostId = "host-opencode-http-timeout";
  const provider = new DeliveryProvider(hostId, "opencode");
  provider.outcomes.push("http_timeout");
  const bridge = new AgentBridge(bridgeConfig(hostId, "opencode"), [provider], {
    onQueueDeliveriesChange: () => undefined,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await assert.rejects(
    () => bridge.sendMessage(session.id, { requestId: "opencode-http-timeout", content: "Do not retry a timed-out request" }),
    (failure: unknown) => failure instanceof ProviderAdapterError
      && failure.code === "DELIVERY_UNKNOWN"
      && !failure.retryable,
  );
  assert.equal(provider.requests.length, 1);
  assert.equal(bridge.queuedMessages(session.id)[0]?.retryable, false);
});

test("explicit HTTP, JSON-RPC, and direct usage-limit responses remain definite rejections", async (t) => {
  for (const [providerId, outcome] of [
    ["opencode", "http_rejected"],
    ["codex", "rpc_rejected"],
    ["direct", "usage_rejected"],
  ] as const) {
    await t.test(providerId, async (t) => {
      const hostId = `host-${providerId}-explicit-rejection`;
      const provider = new DeliveryProvider(hostId, providerId);
      provider.outcomes.push(outcome, "accepted");
      const bridge = new AgentBridge(bridgeConfig(hostId, providerId), [provider], {
        onQueueDeliveriesChange: () => undefined,
      });
      t.after(() => bridge.dispose());
      await bridge.start();
      const session = (await bridge.refresh()).sessions[0]!;

      await assert.rejects(() => bridge.sendMessage(session.id, {
        requestId: `${providerId}-rejected-attempt`,
        content: "Retry only after an explicit rejection",
      }));
      assert.deepEqual(bridge.queuedMessages(session.id), []);
      assert.equal((await bridge.sendMessage(session.id, {
        requestId: `${providerId}-retry-attempt`,
        content: "Retry only after an explicit rejection",
      })).accepted, true);
      assert.deepEqual(provider.requests.map((request) => request.requestId), [
        `${providerId}-rejected-attempt`,
        `${providerId}-rejected-attempt`,
      ]);
    });
  }
});

test("a successful native queue refresh reconciles ambiguous history exactly once", async (t) => {
  const hostId = "host-delivery-single-reconciliation";
  const provider = new NativeQueueDeliveryProvider(hostId);
  provider.outcomes.push("unknown");
  const bridge = new AgentBridge(bridgeConfig(hostId), [provider], {
    onQueueDeliveriesChange: () => undefined,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await assert.rejects(
    () => bridge.sendMessage(session.id, { requestId: "single-reconciliation", content: "Check provider history once" }),
    (failure: unknown) => failure instanceof ProviderAdapterError && failure.code === "DELIVERY_UNKNOWN",
  );
  provider.queueReads = 0;
  provider.messageReads = 0;

  await bridge.refreshQueuedMessages(session.id);

  assert.equal(provider.queueReads, 1);
  assert.equal(provider.messageReads, 1);
});

test("a proven safe retry reuses its durable provider request id", async (t) => {
  const hostId = "host-direct-delivery-safe-retry";
  const provider = new DeliveryProvider(hostId);
  provider.outcomes.push("retryable", "accepted");
  const bridge = new AgentBridge(bridgeConfig(hostId), [provider], {
    onQueueDeliveriesChange: () => undefined,
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await assert.rejects(
    () => bridge.sendMessage(session.id, { requestId: "client-attempt-1", content: "Retry only when proven safe" }),
    (failure: unknown) => failure instanceof ProviderAdapterError && failure.retryable,
  );
  assert.equal((await bridge.sendMessage(session.id, { requestId: "client-attempt-2", content: "Retry only when proven safe" })).accepted, true);
  assert.deepEqual(provider.requests.map((request) => request.requestId), ["client-attempt-1", "client-attempt-1"]);
});

test("restart converts an in-flight delivery to quarantine and reconciles without dispatch", async (t) => {
  const hostId = "host-delivery-restart";
  const provider = new DeliveryProvider(hostId);
  const providerSessionId = "fake_session_0001";
  const now = "2026-09-03T12:00:00.000Z";
  const candidate = {
    source: "queue" as const,
    deliveryId: "restart-delivery",
    requestId: "restart-request",
    messageId: "restart-message",
    sessionId: makeGlobalSessionId(hostId, provider.providerId, providerSessionId),
    providerId: provider.providerId,
    providerSessionId,
    providerOwned: false,
    mode: "send" as const,
    content: "Recover this without another provider call",
    queuedCreatedAt: now,
    attachments: [],
    state: "in_flight" as const,
    createdAt: now,
    updatedAt: now,
  };
  const persisted: QueueDeliveryRecord = {
    ...candidate,
    contentHash: queueDeliveryContentHash(candidate.content),
    payloadHash: queueDeliveryPayloadHash(candidate),
  };
  const writes: QueueDeliveryRecord[][] = [];
  const bridge = new AgentBridge(bridgeConfig(hostId), [provider], {
    queueDeliveries: [persisted],
    onQueueDeliveriesChange: (deliveries) => { writes.push([...deliveries]); },
  });
  t.after(() => bridge.dispose());

  await bridge.start();
  assert.equal(provider.requests.length, 0);
  assert.equal(bridge.queuedMessages(persisted.sessionId)[0]?.retryable, false);
  assert.equal(writes[0]?.[0]?.state, "unknown");
  await bridge.refreshQueuedMessages(persisted.sessionId);
  assert.equal(bridge.queuedMessages(persisted.sessionId).length, 1);

  provider.history = [provider.matchingMessage(providerSessionId, {
    requestId: persisted.requestId,
    content: persisted.content,
  })];
  await bridge.refreshQueuedMessages(persisted.sessionId);
  assert.deepEqual(bridge.queuedMessages(persisted.sessionId), []);
  assert.equal(provider.requests.length, 0);
});
