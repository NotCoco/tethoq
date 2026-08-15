import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PROTOCOL_VERSION, createDeviceIdentity, createHostIdentity, makeGlobalSessionId, type JsonObject, type RemoteMessage, type RemoteSession, type SessionContextState } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { AgentBridge } from "./bridge.js";
import { messagePage } from "./bridge.js";
import { BridgeRequestRouter, clientMessagePage } from "./request_router.js";
import type { BridgeConfig } from "./config.js";
import type { CreateSessionOptions, ListSessionsOptions, PaginatedSessions, ProviderDetection, ProviderEventSink, ProviderQueuedMessage, SendMessageRequest, SendMessageResult, Subscription } from "../../../packages/provider_contract/src/index.js";
import type { DictationTranscriber } from "./dictation.js";

function config(hostId = "host-test"): BridgeConfig {
  return {
    version: 1,
    hostId,
    displayName: "Test workstation",
    identity: createHostIdentity(),
    enabledProviders: ["fake"],
  };
}

class RelationshipFakeProvider extends FakeProviderAdapter {
  #sink: ProviderEventSink | undefined;
  #eventCounter = 0;
  #childParentProviderSessionId: string | undefined;

  public constructor(private readonly relationshipHostId: string) {
    super({ hostId: relationshipHostId, providerId: "rel", sessionCount: 1 });
  }

  public override async getCapabilities() {
    return { ...(await super.getCapabilities()), sessionRelationships: true };
  }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    if (options.parentProviderSessionId === undefined) return await super.listSessions(options);
    if (options.parentProviderSessionId !== this.#childParentProviderSessionId) return { sessions: [], nextCursor: null };
    const child: RemoteSession = {
      id: makeGlobalSessionId(this.relationshipHostId, this.providerId, "child-one"),
      hostId: this.relationshipHostId,
      providerId: this.providerId,
      providerSessionId: "child-one",
      parentSessionId: makeGlobalSessionId(this.relationshipHostId, this.providerId, options.parentProviderSessionId),
      title: "Child task",
      state: "working",
      lastActivityAt: "2026-08-11T00:00:00.000Z",
      needsApproval: false,
      stale: false,
      agentNickname: "Curie",
      agentRole: "explorer",
      nativeMetadata: {},
    };
    return { sessions: [child], nextCursor: null };
  }

  public setChildParent(providerSessionId: string | undefined): void {
    this.#childParentProviderSessionId = providerSessionId;
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.#sink = sink;
    return await super.subscribe(providerSessionId, sink);
  }

  public async emitSessionUpdate(providerSessionId: string, payload: JsonObject): Promise<void> {
    await this.#sink?.({
      eventId: `rel_update_${++this.#eventCounter}`,
      providerId: this.providerId,
      providerSessionId,
      type: "session.updated",
      occurredAt: "2026-08-11T00:00:01.000Z",
      payload,
    });
  }
}

class CountingOpenFakeProvider extends FakeProviderAdapter {
  public getSessionCalls = 0;
  public getMessagesCalls = 0;
  #sink: ProviderEventSink | undefined;
  #eventCounter = 0;

  public override async getSession(providerSessionId: string) {
    this.getSessionCalls += 1;
    return await super.getSession(providerSessionId);
  }

  public override async getMessages(providerSessionId: string) {
    this.getMessagesCalls += 1;
    return await super.getMessages(providerSessionId);
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.#sink = sink;
    return await super.subscribe(providerSessionId, sink);
  }

  public async emitMessageDelta(providerSessionId: string): Promise<void> {
    await this.#sink?.({
      eventId: `counting_delta_${++this.#eventCounter}`,
      providerId: this.providerId,
      providerSessionId,
      type: "message.delta",
      occurredAt: new Date().toISOString(),
      payload: { text: "new output" },
      nativeEvent: { duplicatedLargePayload: "x".repeat(100_000) },
    });
  }
}

class LargeImageFakeProvider extends FakeProviderAdapter {
  public readonly imageBytes = Buffer.alloc(500 * 1024, 0x5a);

  public override async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    const session = await this.getSession(providerSessionId);
    return [{
      id: "large-image-message",
      sessionId: session.id,
      providerMessageId: "large-image-message",
      role: "assistant",
      createdAt: "2026-08-14T12:00:00.000Z",
      parts: [{
        type: "image",
        uri: `data:image/png;charset=binary;base64,${this.imageBytes.toString("base64")}`,
        mimeType: "image/png",
        name: "large-proof.png",
      }],
      status: "completed",
      nativeMetadata: {},
    }];
  }
}

class FailOnceSendProvider extends FakeProviderAdapter {
  public sendCalls = 0;

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.sendCalls += 1;
    if (this.sendCalls === 1) throw new Error("temporary send failure");
    return await super.sendMessage(providerSessionId, request);
  }
}

class ContextFakeProvider extends FakeProviderAdapter {
  public compactCalls = 0;
  public usedTokens = 500_000;
  public contextWindowTokens: number | null = 1_000_000;
  public failCompaction = false;
  public compactBlocker: Promise<void> | undefined;
  public readonly operations: string[] = [];
  #sink: ProviderEventSink | undefined;
  #eventCounter = 0;

  public async getSessionContext(providerSessionId: string): Promise<SessionContextState> {
    return {
      sessionId: makeGlobalSessionId("host-context", this.providerId, providerSessionId),
      modelId: "context-model",
      usedTokens: this.usedTokens,
      contextWindowTokens: this.contextWindowTokens,
      usedPercent: this.contextWindowTokens === null || this.contextWindowTokens <= 0
        ? null
        : this.usedTokens / this.contextWindowTokens * 100,
      compactionThresholdTokens: null,
      minimumThresholdTokens: null,
      supportsManualCompaction: true,
      supportsThreshold: true,
      isCompacting: false,
      updatedAt: "2026-08-14T10:00:00.000Z",
      usage: { inputTokens: 480_000, outputTokens: 20_000, totalTokens: 500_000, cost: 1.25, currency: "USD" },
    };
  }

  public async compactSession(_providerSessionId: string): Promise<void> {
    this.compactCalls += 1;
    this.operations.push("compact:start");
    await this.compactBlocker;
    if (this.failCompaction) {
      this.operations.push("compact:failed");
      throw new Error("simulated compaction failure");
    }
    this.usedTokens = 120_000;
    this.operations.push("compact:completed");
  }

  public override async sendMessage(_providerSessionId: string, _request: SendMessageRequest): Promise<SendMessageResult> {
    this.operations.push("send");
    return { accepted: true, providerTurnId: "context-turn", details: [] };
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.#sink = sink;
    return await super.subscribe(providerSessionId, sink);
  }

  public async emitAgentCompleted(providerSessionId: string): Promise<void> {
    await this.#sink?.({
      eventId: `context_completed_${++this.#eventCounter}`,
      providerId: this.providerId,
      providerSessionId,
      type: "agent.completed",
      occurredAt: "2026-08-14T10:00:01.000Z",
      payload: {},
    });
  }
}

class UnavailableFakeProvider extends FakeProviderAdapter {
  public subscribeCalls = 0;
  public capabilityCalls = 0;

  public override async detect(): Promise<ProviderDetection> {
    return {
      providerId: this.providerId,
      available: false,
      executable: "missing-provider",
      details: ["Provider executable is not installed on this host."],
    };
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.subscribeCalls += 1;
    return await super.subscribe(providerSessionId, sink);
  }

  public override async getCapabilities() {
    this.capabilityCalls += 1;
    return await super.getCapabilities();
  }
}

class DetectionThrowingFakeProvider extends FakeProviderAdapter {
  public capabilityCalls = 0;

  public override async detect(): Promise<ProviderDetection> {
    throw new Error("provider detection failed");
  }

  public override async getCapabilities() {
    this.capabilityCalls += 1;
    return await super.getCapabilities();
  }
}

class CapabilityThrowingFakeProvider extends FakeProviderAdapter {
  public capabilityCalls = 0;

  public override async getCapabilities(): Promise<never> {
    this.capabilityCalls += 1;
    throw new Error("capability probe failed");
  }
}

class EyesFakeProvider extends FakeProviderAdapter {
  public readonly sessionCreationFeatures = { hiddenDeveloperInstructions: true, ephemeralSessions: true, selectableClientTools: true } as const;
  public helperOptions: CreateSessionOptions | undefined;
  public helperRequest: SendMessageRequest | undefined;
  #helperProviderSessionId: string | undefined;

  public override async listModels() {
    return [{ id: "eyes-model", providerId: this.providerId, displayName: "Eyes Model", isDefault: true, inputModalities: ["text", "image"] as const, nativeMetadata: { inputModalities: ["text", "image"] } }];
  }

  public override async createSession(options: CreateSessionOptions) {
    const { firstInstruction: _firstInstruction, ...sessionOptions } = options;
    const session = await super.createSession(sessionOptions);
    if (options.developerInstructions !== undefined) {
      this.helperOptions = options;
      this.#helperProviderSessionId = session.providerSessionId;
    }
    return session;
  }

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    if (providerSessionId !== this.#helperProviderSessionId) return await super.sendMessage(providerSessionId, request);
    this.helperRequest = request;
    return { accepted: true, details: [] };
  }

  public override async getMessages(providerSessionId: string) {
    if (providerSessionId !== this.#helperProviderSessionId || this.helperRequest === undefined) return await super.getMessages(providerSessionId);
    const sessionId = makeGlobalSessionId("host-eyes", this.providerId, providerSessionId);
    return [{
      id: "eyes-answer",
      sessionId,
      providerMessageId: "eyes-answer",
      role: "assistant" as const,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      parts: [{ type: "text" as const, text: "A red error banner is visible above the form." }],
      status: "completed" as const,
      nativeMetadata: {},
    }];
  }
}

class TextOnlyCapturingProvider extends FakeProviderAdapter {
  public lastRequest: SendMessageRequest | undefined;

  public override async listModels() {
    return [{
      id: "text-model",
      providerId: this.providerId,
      displayName: "Text Model",
      isDefault: true,
      inputModalities: ["text"] as const,
      nativeMetadata: { inputModalities: ["text"] },
    }];
  }

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.lastRequest = request;
    return await super.sendMessage(providerSessionId, request);
  }
}

class CollidingQueueFakeProvider extends FakeProviderAdapter {
  public cancelled: { providerSessionId: string; messageId: string } | undefined;
  public readonly listQueuedMessages = async (): Promise<readonly ProviderQueuedMessage[]> => [
    { id: "same-native-id", providerSessionId: "fake_session_0001", content: "First queued prompt", state: "queued", createdAt: "2026-08-14T10:00:00.000Z" },
    { id: "same-native-id", providerSessionId: "fake_session_0002", content: "Second queued prompt", state: "queued", createdAt: "2026-08-14T10:00:01.000Z" },
  ];
  public readonly cancelQueuedMessage = async (providerSessionId: string, messageId: string): Promise<boolean> => {
    this.cancelled = { providerSessionId, messageId };
    return true;
  };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("pairing confirmation is reported for an idempotent retry without duplicating persisted state", () => {
  const device = createDeviceIdentity("device-pairing-callback");
  let stateChangeCount = 0;
  let confirmationCount = 0;
  const bridge = new AgentBridge(config("host-pairing-callback"), [], {
    onStateChange: () => { stateChangeCount += 1; },
    onPairingConfirmed: () => { confirmationCount += 1; },
  });
  const pairing = bridge.startPairing();
  const input = {
    pairingId: pairing.pairingId,
    secret: pairing.secret,
    shortCode: pairing.shortCode,
    deviceId: device.deviceId,
    devicePublicKeyPem: device.publicKeyPem,
  };

  const credential = bridge.confirmPairing(input);
  const retry = bridge.confirmPairing(input);

  assert.deepEqual(retry, credential);
  assert.equal(stateChangeCount, 1);
  assert.equal(confirmationCount, 2);
});

test("startup isolates unavailable providers and reports only subscribed providers online", async (t) => {
  const available = new FakeProviderAdapter({ hostId: "host-startup", providerId: "available", sessionCount: 0 });
  const unavailable = new UnavailableFakeProvider({ hostId: "host-startup", providerId: "missing", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-startup"), enabledProviders: ["available", "missing"] }, [available, unavailable]);
  t.after(() => bridge.dispose());

  await bridge.start();

  assert.equal(unavailable.subscribeCalls, 0);
  const events = bridge.eventsSince(0);
  assert.ok(events.some((event) => event.type === "provider.connected" && event.providerId === "available"));
  assert.ok(events.some((event) => event.type === "provider.disconnected" && event.providerId === "missing"));
  assert.ok(!events.some((event) => event.type === "provider.connected" && event.providerId === "missing"));

  const providers = await bridge.providerConnections();
  const availableConnection = providers.find((provider) => provider.providerId === "available");
  const missingConnection = providers.find((provider) => provider.providerId === "missing");
  assert.equal(availableConnection?.state, "online");
  assert.equal(missingConnection?.state, "offline");
  assert.equal(missingConnection?.detected, false);
  assert.equal(unavailable.capabilityCalls, 0);
  assert.equal(missingConnection?.capabilities.remoteConnectivity, "none");
  assert.ok(Object.entries(missingConnection!.capabilities)
    .filter(([name]) => name !== "remoteConnectivity" && name !== "notes")
    .every(([, value]) => value === false));
  assert.equal(missingConnection?.lastError?.code, "PROVIDER_UNAVAILABLE");
  assert.match(missingConnection?.lastError?.message ?? "", /not installed/);
});

test("provider connections never probe capabilities when detection throws", async (t) => {
  const provider = new DetectionThrowingFakeProvider({ hostId: "host-detect-throw", providerId: "detect-throw", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-detect-throw"), enabledProviders: ["detect-throw"] }, [provider]);
  t.after(() => bridge.dispose());

  const [connection] = await bridge.providerConnections();

  assert.equal(provider.capabilityCalls, 0);
  assert.equal(connection?.detected, false);
  assert.equal(connection?.state, "offline");
  assert.equal(connection?.capabilities.remoteConnectivity, "none");
  assert.ok(Object.entries(connection!.capabilities)
    .filter(([name]) => name !== "remoteConnectivity" && name !== "notes")
    .every(([, value]) => value === false));
  assert.match(connection?.lastError?.message ?? "", /provider detection failed/);
});

test("provider connections do not retry a failed capability probe for a detected provider", async (t) => {
  const provider = new CapabilityThrowingFakeProvider({ hostId: "host-capability-throw", providerId: "capability-throw", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-capability-throw"), enabledProviders: ["capability-throw"] }, [provider]);
  t.after(() => bridge.dispose());

  const [connection] = await bridge.providerConnections();

  assert.equal(provider.capabilityCalls, 1);
  assert.equal(connection?.state, "offline");
  assert.match(connection?.lastError?.message ?? "", /capability probe failed/);
});

test("subscription wallet metadata never represents an account as an API key", async (t) => {
  const provider = new FakeProviderAdapter({
    hostId: "host-subscription-wallet",
    providerId: "codex",
    displayName: "OpenAI Codex",
    sessionCount: 0,
  });
  const bridge = new AgentBridge(
    { ...config("host-subscription-wallet"), enabledProviders: ["codex"] },
    [provider],
  );
  t.after(() => bridge.dispose());

  const wallet = await bridge.walletStatus("codex");

  assert.equal(wallet.kind, "subscription");
  assert.equal(wallet.label, "OpenAI Codex subscription");
  assert.equal(wallet.detail, "This task uses your existing subscription.");
  assert.equal(wallet.apiKeyConfigured, false);
  assert.equal(wallet.apiKeyLabel, undefined);
});

test("session-scoped eyes use a hidden isolated helper and stay out of normal recents", async (t) => {
  const parent = new FakeProviderAdapter({ hostId: "host-eyes", providerId: "parent", sessionCount: 1 });
  const eyes = new EyesFakeProvider({ hostId: "host-eyes", providerId: "eyes", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-eyes"), enabledProviders: ["parent", "eyes"] }, [parent, eyes]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const primary = (await bridge.refresh()).sessions.find((session) => session.providerId === "parent")!;

  const targets = await bridge.visionProxyTargets();
  assert.deepEqual(targets.map((target) => target.providerId), ["eyes"]);
  await bridge.configureVisionProxy(primary.id, { providerId: "eyes", modelId: "eyes-model", reasoningEffort: "low" });
  const answer = await bridge.askVisionProxy(primary.id, "What error is shown?", [{
    name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3,
  }]);

  assert.equal(answer.observation, "A red error banner is visible above the form.");
  assert.equal(bridge.sessions().some((session) => session.id === answer.helperSessionId), false);
  const children = await bridge.listChildSessions(primary.id);
  assert.equal(children.length, 1);
  assert.equal(children[0]?.id, answer.helperSessionId);
  assert.equal(children[0]?.parentSessionId, primary.id);
  assert.equal(children[0]?.agentNickname, "Eyes");
  assert.equal(children[0]?.agentRole, "vision_proxy");
  assert.equal(children[0]?.modelId, "eyes-model");
  assert.equal(children[0]?.reasoningEffort, "low");
  assert.equal(bridge.eventsSince(0).some((event) => event.sessionId === answer.helperSessionId), false);
  assert.equal(eyes.helperOptions?.developerInstructions?.split(/\s+/u).length! < 200, true);
  assert.equal(eyes.helperOptions?.ephemeral, true);
  assert.equal(eyes.helperOptions?.clientTools, "none");
  assert.equal(eyes.helperOptions?.mcpServers, "none");
  assert.equal(eyes.helperRequest?.attachments?.[0]?.name, "screen.png");
});

test("queued images for a text-only primary are retained for eyes and not sent to the primary", async (t) => {
  const parent = new TextOnlyCapturingProvider({ hostId: "host-eyes-queue", providerId: "parent", sessionCount: 1 });
  const eyes = new EyesFakeProvider({ hostId: "host-eyes-queue", providerId: "eyes", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-eyes-queue"), enabledProviders: ["parent", "eyes"] }, [parent, eyes]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const primary = (await bridge.refresh()).sessions.find((session) => session.providerId === "parent")!;
  await parent.resumeSession(primary.providerSessionId);
  await bridge.configureVisionProxy(primary.id, { providerId: "eyes", modelId: "eyes-model", reasoningEffort: "low" });
  const bytes = Buffer.from([1, 2, 3]);
  const started = bridge.beginAttachmentUpload({ name: "queued-screen.png", mimeType: "image/png", byteLength: bytes.length });
  bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
  const completed = bridge.completeAttachmentUpload(started.uploadId);

  await bridge.enqueueMessage(primary.id, {
    requestId: "queued-eyes-image",
    content: "Inspect this screen",
    modelId: "text-model",
    attachmentIds: [completed.attachmentId],
  });
  await waitFor(() => parent.lastRequest !== undefined, "queued primary send");

  assert.equal(parent.lastRequest?.attachments?.length ?? 0, 0);
  assert.match(parent.lastRequest?.content ?? "", /ask_eyes/);
  await bridge.askVisionProxy(primary.id, "What is visible?");
  assert.equal(eyes.helperRequest?.attachments?.[0]?.name, "queued-screen.png");
});

test("session.send_message consumes uploaded files for a freshly created task", async (t) => {
  const hostId = "host-direct-upload";
  const provider = new TextOnlyCapturingProvider({ hostId, providerId: "opencode", sessionCount: 1 });
  const blocked = new TextOnlyCapturingProvider({ hostId, providerId: "codex", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config(hostId), enabledProviders: ["opencode", "codex"] }, [provider, blocked]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const sessions = (await bridge.refresh()).sessions;
  const session = sessions.find((candidate) => candidate.providerId === "opencode")!;
  const blockedSession = sessions.find((candidate) => candidate.providerId === "codex")!;
  await provider.resumeSession(session.providerSessionId);
  await blocked.resumeSession(blockedSession.providerSessionId);
  const bytes = Buffer.from("export const answer = 42;", "utf8");
  const started = bridge.beginAttachmentUpload({ name: "answer.ts", mimeType: "text/plain", byteLength: bytes.length });
  bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
  const completed = bridge.completeAttachmentUpload(started.uploadId);

  const response = await router.handle({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: "message-direct-upload",
    hostId,
    sentAt: "2026-08-14T12:00:00.000Z",
    kind: "request",
    type: "session.send_message",
    requestId: "request-direct-upload",
    payload: {
      sessionId: session.id,
      content: "Read the attached source",
      modelId: "text-model",
      attachmentIds: [completed.attachmentId],
    },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(provider.lastRequest?.attachments?.map((attachment) => [attachment.name, attachment.mimeType]), [
    ["answer.ts", "text/plain"],
  ]);
  await assert.rejects(
    () => bridge.sendUploadedMessage(session.id, { requestId: "already-consumed", content: "Retry" }, [completed.attachmentId]),
    /unknown or expired/,
  );

  const blockedStarted = bridge.beginAttachmentUpload({ name: "private.txt", mimeType: "text/plain", byteLength: 1 });
  bridge.appendAttachmentChunk(blockedStarted.uploadId, 0, "eA==");
  const blockedUpload = bridge.completeAttachmentUpload(blockedStarted.uploadId);
  const rejected = await router.handle({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: "message-blocked-upload",
    hostId,
    sentAt: "2026-08-14T12:00:01.000Z",
    kind: "request",
    type: "session.send_message",
    requestId: "request-blocked-upload",
    payload: { sessionId: blockedSession.id, content: "Do not forward this", attachmentIds: [blockedUpload.attachmentId] },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error?.message ?? "", /only for OpenCode/);
  assert.equal(blocked.lastRequest, undefined);
});

test("visual support routes only image attachments and keeps generic files with the primary", async (t) => {
  const parent = new TextOnlyCapturingProvider({ hostId: "host-eyes", providerId: "opencode", sessionCount: 1 });
  const eyes = new EyesFakeProvider({ hostId: "host-eyes", providerId: "eyes", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-eyes"), enabledProviders: ["opencode", "eyes"] }, [parent, eyes]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const primary = (await bridge.refresh()).sessions.find((session) => session.providerId === "opencode")!;
  await parent.resumeSession(primary.providerSessionId);
  await bridge.configureVisionProxy(primary.id, { providerId: "eyes", modelId: "eyes-model", reasoningEffort: "low" });

  await bridge.sendMessage(primary.id, {
    requestId: "mixed-attachments",
    content: "Use the source and inspect the screenshot",
    modelId: "text-model",
    attachments: [
      { name: "notes.txt", mimeType: "text/plain", dataBase64: "dGV4dA==", byteLength: 4 },
      { name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3 },
    ],
  });

  assert.deepEqual(parent.lastRequest?.attachments?.map((attachment) => attachment.name), ["notes.txt"]);
  assert.match(parent.lastRequest?.content ?? "", /ask_eyes/);
  await bridge.askVisionProxy(primary.id, "What is visible?");
  assert.deepEqual(eyes.helperRequest?.attachments?.map((attachment) => attachment.name), ["screen.png"]);

  await bridge.sendMessage(primary.id, {
    requestId: "generic-attachment-only",
    content: "Use only the replacement source",
    modelId: "text-model",
    attachments: [{ name: "replacement.txt", mimeType: "text/plain", dataBase64: "dGV4dA==", byteLength: 4 }],
  });
  assert.deepEqual(parent.lastRequest?.attachments?.map((attachment) => attachment.name), ["replacement.txt"]);
  await assert.rejects(() => bridge.askVisionProxy(primary.id, "What is visible now?"), /Attach an image/);
});

test("refresh retrieves every page and preserves successful provider data after partial failure", async (t) => {
  const first = new FakeProviderAdapter({ hostId: "host-refresh", providerId: "first", sessionCount: 151, pageSize: 40 });
  const second = new FakeProviderAdapter({ hostId: "host-refresh", providerId: "second", sessionCount: 7, pageSize: 3 });
  const bridge = new AgentBridge({ ...config("host-refresh"), enabledProviders: ["first", "second"] }, [first, second]);
  t.after(() => bridge.dispose());
  await bridge.start();

  const initial = await bridge.refresh();
  assert.equal(initial.sessions.length, 158);
  assert.deepEqual(initial.providers.map((entry) => [entry.providerId, entry.status, entry.pages]), [
    ["first", "success", 4],
    ["second", "success", 3],
  ]);

  second.setFailListing(true);
  const partial = await bridge.refresh();
  assert.equal(partial.providers.find((entry) => entry.providerId === "second")?.status, "failed");
  assert.equal(partial.sessions.filter((session) => session.providerId === "first").length, 151);
  assert.equal(partial.sessions.filter((session) => session.providerId === "second").length, 7);
  assert.ok(partial.sessions.filter((session) => session.providerId === "second").every((session) => session.stale && session.state === "disconnected"));
});

test("fake-provider vertical slice streams, requests exact approval, resumes, and completes", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-flow", sessionCount: 1 });
  const bridge = new AgentBridge(config("host-flow"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const refresh = await bridge.refresh();
  const session = refresh.sessions[0]!;

  const first = await bridge.sendMessage(session.id, { requestId: "send-once", content: "Run the validation" });
  const retried = await bridge.sendMessage(session.id, { requestId: "send-once", content: "This body is ignored because the request ID is stable" });
  assert.deepEqual(retried, first);

  await waitFor(() => bridge.pendingApprovals().length === 1, "approval request");
  const approval = bridge.pendingApprovals()[0]!;
  assert.equal(approval.command, "npm test");
  assert.equal(approval.sessionId, session.id);
  await bridge.respondToApproval({ requestId: approval.requestId, choiceId: "approve", respondedAt: new Date().toISOString() });
  await waitFor(() => bridge.eventsSince(0).some((event) => event.type === "agent.completed"), "agent completion");
  await assert.rejects(() => bridge.respondToApproval({ requestId: approval.requestId, choiceId: "approve", respondedAt: new Date().toISOString() }), /stale, resolved, or unknown/);

  const opened = await bridge.openSession(session.id);
  assert.equal(opened.messages.filter((message) => message.role === "user").length, 1);
  assert.ok(opened.messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.type === "text" && part.text.includes("complete"))));
  const eventTypes = bridge.eventsSince(0).map((event) => event.type);
  for (const expected of ["message.started", "message.delta", "tool.started", "command.started", "approval.requested", "approval.resolved", "command.completed", "agent.completed"] as const) {
    assert.ok(eventTypes.includes(expected), `missing ${expected}`);
  }
});

test("context thresholds clamp to the model window and require confirmation at current usage", async (t) => {
  const provider = new ContextFakeProvider({ hostId: "host-context", providerId: "context", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-context"), enabledProviders: ["context"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  const initial = await bridge.sessionContext(session.id);
  assert.equal(initial.usedTokens, 500_000);
  assert.equal(initial.contextWindowTokens, 1_000_000);
  assert.equal(initial.minimumThresholdTokens, 50_000);
  assert.equal(initial.usage.cost, 1.25);
  await assert.rejects(
    () => bridge.setSessionCompactionThreshold(session.id, 500_000, false),
    /Confirm immediate compaction/,
  );
  await assert.rejects(
    () => bridge.setSessionCompactionThreshold(session.id, 1_000_001, false),
    /cannot exceed/,
  );

  const compacted = await bridge.setSessionCompactionThreshold(session.id, 500_000, true);
  assert.equal(provider.compactCalls, 1);
  assert.equal(compacted.compactionThresholdTokens, 500_000);
  assert.equal(compacted.usedTokens, 120_000);
});

test("failed immediate compaction restores the previously applied threshold", async (t) => {
  const provider = new ContextFakeProvider({ hostId: "host-context", providerId: "context", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-context"), enabledProviders: ["context"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  provider.usedTokens = 100_000;
  assert.equal((await bridge.setSessionCompactionThreshold(session.id, 600_000, false)).compactionThresholdTokens, 600_000);
  provider.usedTokens = 700_000;
  provider.failCompaction = true;

  await assert.rejects(
    () => bridge.setSessionCompactionThreshold(session.id, 500_000, true),
    /simulated compaction failure/,
  );
  assert.equal((await bridge.sessionContext(session.id)).compactionThresholdTokens, 600_000);
});

test("context retrieval re-clamps thresholds and treats non-positive or unknown windows as unsupported", async (t) => {
  const provider = new ContextFakeProvider({ hostId: "host-context", providerId: "context", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-context"), enabledProviders: ["context"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  provider.usedTokens = 10_000;
  await bridge.setSessionCompactionThreshold(session.id, 50_000, false);

  provider.contextWindowTokens = 2_000_000;
  const grown = await bridge.sessionContext(session.id);
  assert.equal(grown.minimumThresholdTokens, 100_000);
  assert.equal(grown.compactionThresholdTokens, 100_000);

  provider.contextWindowTokens = 80_000;
  const shrunk = await bridge.sessionContext(session.id);
  assert.equal(shrunk.compactionThresholdTokens, 80_000);

  provider.contextWindowTokens = 0;
  const zero = await bridge.sessionContext(session.id);
  assert.equal(zero.contextWindowTokens, null);
  assert.equal(zero.compactionThresholdTokens, null);
  assert.equal(zero.minimumThresholdTokens, null);
  assert.equal(zero.supportsThreshold, false);

  provider.contextWindowTokens = null;
  const unknown = await bridge.sessionContext(session.id);
  assert.equal(unknown.contextWindowTokens, null);
  assert.equal(unknown.supportsThreshold, false);
});

test("agent completion finishes automatic compaction before dispatching the next queued turn", async (t) => {
  const provider = new ContextFakeProvider({ hostId: "host-context", providerId: "context", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-context"), enabledProviders: ["context"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  provider.usedTokens = 100_000;
  await bridge.setSessionCompactionThreshold(session.id, 600_000, false);
  provider.usedTokens = 700_000;
  let releaseCompaction!: () => void;
  provider.compactBlocker = new Promise<void>((resolve) => { releaseCompaction = resolve; });
  await bridge.enqueueMessage(session.id, { requestId: "after-compaction", content: "Continue after compacting" });

  const completion = provider.emitAgentCompleted(session.providerSessionId);
  await waitFor(() => provider.operations.includes("compact:start"), "automatic compaction start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(provider.operations.includes("send"), false, "the queued turn must remain held while compaction is active");

  releaseCompaction();
  await completion;
  await waitFor(() => bridge.queuedMessages(session.id).length === 0, "post-compaction queue dispatch");
  assert.deepEqual(provider.operations, ["compact:start", "compact:completed", "send"]);
});

test("opening a cached session fetches history without duplicating provider metadata", async (t) => {
  const fake = new CountingOpenFakeProvider({ hostId: "host-fast-open", sessionCount: 1 });
  const bridge = new AgentBridge(config("host-fast-open"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  const opened = await bridge.openSession(session.id);

  assert.equal(opened.session.id, session.id);
  assert.equal(fake.getSessionCalls, 0);
  assert.equal(fake.getMessagesCalls, 1);
});

test("simultaneous opens share one provider history load and short-lived cache hits", async (t) => {
  const fake = new CountingOpenFakeProvider({ hostId: "host-coalesced-open", sessionCount: 1 });
  const bridge = new AgentBridge(config("host-coalesced-open"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  const [first, second] = await Promise.all([bridge.openSession(session.id), bridge.openSession(session.id)]);
  assert.deepEqual(second.messages, first.messages);
  assert.equal(fake.getMessagesCalls, 1);

  await bridge.openSession(session.id);
  assert.equal(fake.getMessagesCalls, 1, "a fresh snapshot should avoid another full transcript read");

  await fake.emitMessageDelta(session.providerSessionId);
  await bridge.openSession(session.id);
  assert.equal(fake.getMessagesCalls, 2, "a live message event must invalidate the fresh snapshot");
  const replayedDelta = bridge.eventsSince(0).find((event) => event.type === "message.delta");
  assert.equal(replayedDelta?.nativeEvent, undefined, "raw provider events must not duplicate large payloads in replay");
});

test("message history opens newest-first in bounded backward pages", () => {
  const messages = Array.from({ length: 95 }, (_, index) => ({
    id: `message-${index}`,
    sessionId: "host/fake/session",
    providerMessageId: `native-${index}`,
    role: "assistant" as const,
    createdAt: new Date(2026, 0, 1, 0, index).toISOString(),
    parts: [{ type: "text" as const, text: `message ${index}` }],
    status: "completed" as const,
    nativeMetadata: {},
  }));
  const latest = messagePage(messages, undefined, 40);
  assert.equal(latest.messages[0]!.id, "message-55");
  assert.equal(latest.messages.at(-1)!.id, "message-94");
  assert.equal(latest.nextCursor, "55");
  const older = messagePage(messages, latest.nextCursor!, 40);
  assert.equal(older.messages[0]!.id, "message-15");
  assert.equal(older.messages.at(-1)!.id, "message-54");
  assert.equal(older.nextCursor, "15");
});

test("phone history pages stay below the WebSocket response budget", () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `large-${index}`,
    sessionId: "host/opencode/session",
    providerMessageId: `native-large-${index}`,
    role: "assistant" as const,
    createdAt: new Date(2026, 0, 1, 0, index).toISOString(),
    parts: [{ type: "tool" as const, name: "large-output", output: "x".repeat(200_000), status: "completed" as const }],
    status: "completed" as const,
    nativeMetadata: { duplicate: "y".repeat(200_000) },
  }));

  const page = clientMessagePage(messages, "40");
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") < 1_500_000);
  assert.ok(page.messages.length > 0 && page.messages.length < messages.length);
  assert.ok(page.messages.every((message) => Object.keys(message.nativeMetadata).length === 0));
  assert.ok(Number(page.nextCursor) > 40);
});

test("large inline history images are retrieved through bounded authenticated chunks", async (t) => {
  const hostId = "host-image-history";
  const provider = new LargeImageFakeProvider({ hostId, providerId: "image", sessionCount: 1 });
  const bridge = new AgentBridge(config(hostId), [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const envelope = (requestId: string, type: string, payload: JsonObject) => ({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: `message-${requestId}`,
    hostId,
    sentAt: "2026-08-14T12:00:00.000Z",
    kind: "request" as const,
    type,
    requestId,
    payload,
  });

  const opened = await router.handle(envelope("image-open", "session.open", { sessionId: session.id }));
  assert.equal(opened.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(opened), "utf8") < 1_500_000);
  const messages = opened.payload.messages as unknown as RemoteMessage[];
  const image = messages[0]?.parts[0];
  assert.equal(image?.type, "image");
  assert.equal(image.type === "image" ? image.uri : undefined, undefined);
  const retrievalId = image?.type === "image" ? image.retrievalId : undefined;
  assert.ok(retrievalId);

  const chunks: Buffer[] = [];
  let offset = 0;
  for (let index = 0; ; index += 1) {
    const response = await router.handle(envelope(`image-chunk-${index}`, "session.image.get", { sessionId: session.id, retrievalId, offset }));
    assert.equal(response.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(response), "utf8") < 800_000);
    chunks.push(Buffer.from(String(response.payload.dataBase64), "base64"));
    const nextOffset = response.payload.nextOffset;
    if (nextOffset === null) break;
    assert.equal(typeof nextOffset, "number");
    offset = nextOffset as number;
  }
  assert.deepEqual(Buffer.concat(chunks), provider.imageBytes);
});

test("bridge normalizes user-input requests and binds responses to the exact provider request", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-input", sessionCount: 1 });
  const bridge = new AgentBridge(config("host-input"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  const answerPromise = fake.requestUserInput(session.providerSessionId, "Choose A or B");
  await waitFor(() => bridge.pendingUserInputs().length === 1, "normalized user input");
  const request = bridge.pendingUserInputs()[0]!;
  assert.equal(request.prompt, "Choose A or B");
  await bridge.respondToUserInput({ requestId: request.requestId, answers: { choice: "A" }, respondedAt: new Date().toISOString() });
  assert.deepEqual(await answerPromise, { choice: "A" });
  await assert.rejects(() => bridge.respondToUserInput({ requestId: request.requestId, answers: { choice: "B" }, respondedAt: new Date().toISOString() }), /stale, resolved, or unknown/);
});

test("provider duplicate events are dropped while out-of-order unique events remain replayable", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-events", sessionCount: 1 });
  const bridge = new AgentBridge(config("host-events"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  await fake.emitDuplicateAndOutOfOrder(session.providerSessionId);
  await waitFor(() => bridge.eventsSince(0).filter((event) => event.type === "message.delta").length >= 2, "event delivery");
  const deltas = bridge.eventsSince(0).filter((event) => event.type === "message.delta");
  assert.equal(deltas.length, 2);
  assert.deepEqual(deltas.map((event) => event.payload.text), ["second", "first"]);
});

test("session status events update the cached global session state", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-status", sessionCount: 1 });
  const bridge = new AgentBridge(config("host-status"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  assert.equal(session.state, "working");

  await fake.resumeSession?.(session.providerSessionId);
  await waitFor(() => bridge.sessions().find((item) => item.id === session.id)?.state === "idle", "status event cache update");

  assert.equal(bridge.sessions().find((item) => item.id === session.id)?.state, "idle");
});

test("bridge queue is shared, held behind active work, and dispatches after idle", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-queue", sessionCount: 1 });
  const bridge = new AgentBridge(config("host-queue"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  assert.equal(session.state, "working");

  const queued = await bridge.enqueueMessage(session.id, { requestId: "queued-request", content: "Run this next" });
  assert.equal(bridge.queuedMessages(session.id)[0]?.id, queued.id);
  assert.ok(bridge.eventsSince(0).some((event) => event.type === "message.queued" && event.payload.id === queued.id));

  const listResponse = await new BridgeRequestRouter(bridge).handle({
    protocolVersion: 1,
    messageId: "queue-list-message",
    hostId: "host-queue",
    sentAt: new Date().toISOString(),
    kind: "request",
    type: "message_queue.list",
    requestId: "queue-list-request",
    payload: { sessionId: session.id },
  });
  assert.equal(Array.isArray(listResponse.payload.messages), true);
  assert.equal((listResponse.payload.messages as unknown[]).length, 1);

  await fake.resumeSession(session.providerSessionId);
  await waitFor(() => bridge.queuedMessages(session.id).length === 0, "queued message dispatch");
  assert.ok(bridge.eventsSince(0).some((event) => event.type === "message.queue_removed" && event.payload.messageId === queued.id));
});

test("provider queue identities stay session-scoped and malformed list scopes are rejected", async (t) => {
  const hostId = "host-provider-queue-ids";
  const provider = new CollidingQueueFakeProvider({ hostId, providerId: "queue", sessionCount: 2 });
  const bridge = new AgentBridge({ ...config(hostId), enabledProviders: ["queue"] }, [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();

  const queued = bridge.queuedMessages();
  assert.equal(queued.length, 2);
  assert.equal(new Set(queued.map((message) => message.id)).size, 2);
  assert.equal(new Set(queued.map((message) => message.sessionId)).size, 2);
  assert.equal(await bridge.cancelQueuedMessage(queued[0]!.id), true);
  assert.deepEqual(provider.cancelled, { providerSessionId: "fake_session_0001", messageId: "same-native-id" });
  assert.deepEqual(bridge.queuedMessages().map((message) => message.content), ["Second queued prompt"]);

  const invalid = await router.handle({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: "message-invalid-queue-scope",
    hostId,
    sentAt: "2026-08-14T12:00:00.000Z",
    kind: "request",
    type: "message_queue.list",
    requestId: "request-invalid-queue-scope",
    payload: { sessionId: 123 },
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error?.message ?? "", /sessionId must be a non-empty string/);
});

test("child-session requests are capability-gated, cached, and retain validated live metadata", async (t) => {
  const hostId = "host-children";
  const provider = new RelationshipFakeProvider(hostId);
  const bridge = new AgentBridge({ ...config(hostId), enabledProviders: ["rel"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  provider.setChildParent(parent.providerSessionId);

  const children = await bridge.listChildSessions(parent.id);
  assert.equal(children.length, 1);
  assert.equal(children[0]?.parentSessionId, parent.id);
  assert.equal(bridge.sessions().some((session) => session.id === children[0]?.id), true);

  const response = await new BridgeRequestRouter(bridge).handle({
    protocolVersion: 1,
    messageId: "message-children",
    hostId,
    sentAt: new Date().toISOString(),
    kind: "request",
    type: "session.children",
    requestId: "request-children",
    payload: { sessionId: parent.id },
  });
  assert.equal(response.ok, true);
  assert.equal(Array.isArray(response.payload.sessions), true);

  const child = children[0]!;
  await provider.emitSessionUpdate(child.providerSessionId, {
    modelId: "  model-current  ",
    reasoningEffort: "  high  ",
    variantId: "  careful  ",
    parentSessionId: parent.id,
    agentNickname: "  Curie  ",
    agentRole: "  explorer  ",
    ignoredNativeShape: { model: "must-not-be-read" },
  });
  await waitFor(() => bridge.sessions().find((session) => session.id === child.id)?.modelId === "model-current", "session metadata cache update");
  const updated = bridge.sessions().find((session) => session.id === child.id);
  assert.equal(updated?.reasoningEffort, "high");
  assert.equal(updated?.variantId, "careful");
  assert.equal(updated?.parentSessionId, parent.id);
  assert.equal(updated?.agentNickname, "Curie");
  assert.equal(updated?.agentRole, "explorer");

  const otherParentProviderSessionId = "other-parent";
  const otherParentId = makeGlobalSessionId(hostId, provider.providerId, otherParentProviderSessionId);
  provider.setChildParent(otherParentProviderSessionId);
  const reparented = await bridge.listChildSessions(otherParentId);
  assert.equal(reparented[0]?.parentSessionId, otherParentId);
  assert.equal(reparented[0]?.modelId, "model-current", "sparse child refresh must retain live metadata");
  assert.deepEqual(await bridge.listChildSessions(parent.id), []);
  assert.equal(bridge.sessions().find((session) => session.id === child.id)?.parentSessionId, otherParentId);

  await bridge.refresh();
  assert.equal(bridge.sessions().some((session) => session.id === child.id), true, "root refresh must retain cached children");

  provider.setChildParent(undefined);
  assert.deepEqual(await bridge.listChildSessions(otherParentId), []);
  assert.equal(bridge.sessions().some((session) => session.id === child.id), false);
});

test("child-session requests fail when the provider does not advertise relationships", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-no-children", sessionCount: 1 });
  const bridge = new AgentBridge(config("host-no-children"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  await assert.rejects(() => bridge.listChildSessions(parent.id), /does not support child-session relationships/);
});

test("cross-harness delegation creates real linked child sessions and exposes lifecycle state", async (t) => {
  const hostId = "host-mesh";
  const parentProvider = new FakeProviderAdapter({ hostId, providerId: "parent", sessionCount: 1 });
  const workerProvider = new FakeProviderAdapter({ hostId, providerId: "worker", sessionCount: 0 });
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["parent", "worker"] },
    [parentProvider, workerProvider],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions.find((session) => session.providerId === "parent")!;

  const task = await bridge.startDelegation(parent.id, "Review the current implementation", [{
    providerId: "worker",
    modelId: "fake-careful",
    reasoningEffort: "high",
  }]);

  assert.equal(task.parentSessionId, parent.id);
  assert.equal(task.children.length, 1);
  assert.equal(task.children[0]?.providerId, "worker");
  assert.equal(task.children[0]?.modelId, "fake-careful");
  const childId = task.children[0]?.sessionId;
  assert.ok(childId);
  const child = bridge.sessions().find((session) => session.id === childId);
  assert.equal(child?.parentSessionId, parent.id);
  assert.equal(child?.agentRole, "cross_harness_delegate");
  assert.deepEqual((await bridge.listChildSessions(parent.id)).map((session) => session.id), [childId]);
  assert.equal(bridge.delegations(parent.id)[0]?.id, task.id);
  assert.ok(bridge.eventsSince(0).some((event) =>
    event.type === "delegation.started" && event.sessionId === parent.id));

  const listed = await bridge.executeMeshTool(parent.id, "mesh_list_children", {});
  assert.deepEqual((listed.children as readonly JsonObject[]).map((entry) => entry.childSessionId), [childId]);
  const followUp = await bridge.executeMeshTool(parent.id, "mesh_message_child", {
    child_session_id: childId,
    message: "Check the edge case as a follow-up",
  });
  assert.ok(followUp.delivery === "steered" || followUp.delivery === "queued" || followUp.delivery === "sent");
  await assert.rejects(() => bridge.executeMeshTool(parent.id, "mesh_read_result", {
    child_session_id: makeGlobalSessionId(hostId, "worker", "unrelated"),
  }), /not a delegated child/);
});

test("parent can finish a turn while delegated children continue and receive their results later", async (t) => {
  const hostId = "host-background-delegation";
  const parentProvider = new FakeProviderAdapter({ hostId, providerId: "parent", sessionCount: 2 });
  const workerProvider = new FakeProviderAdapter({ hostId, providerId: "worker", sessionCount: 0 });
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["parent", "worker"] },
    [parentProvider, workerProvider],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions.find((session) => session.providerId === "parent" && session.state === "idle")!;

  const task = await bridge.startDelegation(parent.id, "Review the background lifecycle", [{ providerId: "worker" }]);
  const childId = task.children[0]?.sessionId;
  assert.ok(childId);
  await waitFor(() => bridge.pendingApprovals().some((approval) => approval.sessionId === parent.id) &&
    bridge.pendingApprovals().some((approval) => approval.sessionId === childId), "parent and child turns to start");

  const initialParentMessages = await parentProvider.getMessages(parent.providerSessionId);
  const startEnvelope = initialParentMessages.find((message) => message.role === "user")?.parts
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join("\n") ?? "";
  assert.match(startEnvelope, /UAR_MESH_STARTED/);
  assert.match(startEnvelope, /finish this turn while workers are still running/);

  const initialParentApproval = bridge.pendingApprovals().find((approval) => approval.sessionId === parent.id)!;
  await bridge.respondToApproval({
    requestId: initialParentApproval.requestId,
    choiceId: "approve",
    respondedAt: new Date().toISOString(),
  });
  await waitFor(() => bridge.sessions().find((session) => session.id === parent.id)?.state === "completed", "parent's first response");

  const stillRunning = bridge.delegations(parent.id)[0]!;
  assert.notEqual(stillRunning.state, "completed");
  assert.notEqual(stillRunning.state, "failed");
  assert.equal(bridge.sessions().find((session) => session.id === childId)?.state, "needs_approval");
  const availableBeforeCompletion = await bridge.executeMeshTool(parent.id, "mesh_read_result", { child_session_id: childId });
  assert.equal(availableBeforeCompletion.latestAssistantOutput, null);

  const childApproval = bridge.pendingApprovals().find((approval) => approval.sessionId === childId)!;
  await bridge.respondToApproval({
    requestId: childApproval.requestId,
    choiceId: "approve",
    respondedAt: new Date().toISOString(),
  });
  await waitFor(() => bridge.pendingApprovals().some((approval) => approval.sessionId === parent.id), "later result handoff to parent");

  const laterParentMessages = await parentProvider.getMessages(parent.providerSessionId);
  const parentPrompts = laterParentMessages.filter((message) => message.role === "user").flatMap((message) =>
    message.parts.flatMap((part) => part.type === "text" ? [part.text] : []));
  assert.equal(parentPrompts.length, 2);
  assert.match(parentPrompts[1]!, /UAR_MESH_RESULT/);
  assert.match(parentPrompts[1]!, /The requested work is complete/);
  assert.notEqual(bridge.delegations(parent.id)[0]?.state, "completed");

  const synthesisApproval = bridge.pendingApprovals().find((approval) => approval.sessionId === parent.id)!;
  await bridge.respondToApproval({
    requestId: synthesisApproval.requestId,
    choiceId: "approve",
    respondedAt: new Date().toISOString(),
  });
  await waitFor(() => bridge.delegations(parent.id)[0]?.state === "completed", "delegation synthesis completion");
});

test("request router deduplicates a request ID across independent connection routers", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-router", sessionCount: 2 });
  const bridge = new AgentBridge(config("host-router"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const request = {
    protocolVersion: 1 as const,
    messageId: "message-one",
    hostId: "host-router",
    sentAt: new Date().toISOString(),
    kind: "request" as const,
    type: "sessions.refresh",
    requestId: "same-request",
    payload: {},
  };
  const first = await new BridgeRequestRouter(bridge).handle(request);
  const second = await new BridgeRequestRouter(bridge).handle({ ...request, messageId: "message-two" });
  assert.deepEqual(second, first);
});

test("bridge exposes provider model enumeration without inventing unsupported models", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-models", sessionCount: 0 });
  const bridge = new AgentBridge(config("host-models"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const models = await bridge.listModels("fake");
  assert.deepEqual(models.map((model) => model.id), ["fake-fast", "fake-careful"]);

  const response = await new BridgeRequestRouter(bridge).handle({
    protocolVersion: 1,
    messageId: "message-models",
    hostId: "host-models",
    sentAt: new Date().toISOString(),
    kind: "request",
    type: "models.list",
    requestId: "request-models",
    payload: { providerId: "fake" },
  });
  assert.equal(response.ok, true);
  assert.ok(Array.isArray(response.payload.models));
});

test("request router consumes uploaded dictation audio through the host transcriber", async (t) => {
  const bytes = Buffer.alloc(2_000, 3);
  let dictionary: readonly string[] = [];
  const dictationTranscriber: DictationTranscriber = {
    transcribe: async (audio, options) => {
      assert.equal(audio.mimeType, "audio/wav");
      assert.equal(audio.byteLength, bytes.byteLength);
      dictionary = options?.dictionary ?? [];
      return { text: "Transcribed instruction" };
    },
  };
  const bridge = new AgentBridge(config("host-dictation"), [], { dictationTranscriber });
  t.after(() => bridge.dispose());
  await bridge.start();
  const sourceResponse = await new BridgeRequestRouter(bridge).handle({
    protocolVersion: 1,
    messageId: "message-dictation-sources",
    hostId: "host-dictation",
    sentAt: new Date().toISOString(),
    kind: "request",
    type: "dictation.source.list",
    requestId: "request-dictation-sources",
    payload: {},
  });
  assert.equal(sourceResponse.ok, true);
  assert.equal((sourceResponse.payload.sources as unknown[]).length, 1);
  const started = bridge.beginAttachmentUpload({
    name: "dictation.wav",
    mimeType: "audio/wav",
    byteLength: bytes.byteLength,
  });
  bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
  const completed = bridge.completeAttachmentUpload(started.uploadId);
  const rejected = await new BridgeRequestRouter(bridge).handle({
    protocolVersion: 1,
    messageId: "message-dictation-unsupported",
    hostId: "host-dictation",
    sentAt: new Date().toISOString(),
    kind: "request",
    type: "dictation.transcribe",
    requestId: "request-dictation-unsupported",
    payload: {
      attachmentId: completed.attachmentId,
      sourceId: "xai-stt",
      dictionary: [],
    },
  });
  assert.equal(rejected.ok, false);
  const response = await new BridgeRequestRouter(bridge).handle({
    protocolVersion: 1,
    messageId: "message-dictation",
    hostId: "host-dictation",
    sentAt: new Date().toISOString(),
    kind: "request",
    type: "dictation.transcribe",
    requestId: "request-dictation",
    payload: {
      attachmentId: completed.attachmentId,
      sourceId: "openai-stt",
      dictionary: ["OpenCode", "Kronos"],
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.payload.text, "Transcribed instruction");
  assert.deepEqual(dictionary, ["OpenCode", "Kronos"]);
});

test("failed dictation can retry the same uploaded attachment", async (t) => {
  let calls = 0;
  const dictationTranscriber: DictationTranscriber = {
    transcribe: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary transcription failure");
      return { text: "Recovered dictation" };
    },
  };
  const bridge = new AgentBridge(config("host-dictation-retry"), [], { dictationTranscriber });
  t.after(() => bridge.dispose());
  await bridge.start();
  const bytes = Buffer.alloc(2_000, 4);
  const started = bridge.beginAttachmentUpload({ name: "retry.wav", mimeType: "audio/wav", byteLength: bytes.length });
  bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
  const completed = bridge.completeAttachmentUpload(started.uploadId);

  await assert.rejects(() => bridge.transcribeDictation(completed.attachmentId, []), /temporary transcription failure/);
  assert.deepEqual(await bridge.transcribeDictation(completed.attachmentId, []), { text: "Recovered dictation" });
  await assert.rejects(() => bridge.transcribeDictation(completed.attachmentId, []), /unknown or expired/);
});

test("failed send can retry the same uploaded attachment", async (t) => {
  const fake = new FailOnceSendProvider({ hostId: "host-attachment-retry", providerId: "opencode", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-attachment-retry"), enabledProviders: ["opencode"] }, [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  await fake.resumeSession(session.providerSessionId);
  const bytes = Buffer.from("phone attachment");
  const started = bridge.beginAttachmentUpload({ name: "retry.txt", mimeType: "text/plain", byteLength: bytes.length });
  bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
  const completed = bridge.completeAttachmentUpload(started.uploadId);
  const input = {
    requestId: "attachment-retry",
    content: "Inspect this",
    attachmentIds: [completed.attachmentId],
  };

  await assert.rejects(() => bridge.steerMessage(session.id, input), /temporary send failure/);
  assert.equal((await bridge.steerMessage(session.id, input)).accepted, true);
  await assert.rejects(
    () => bridge.steerMessage(session.id, { ...input, requestId: "attachment-already-used" }),
    /unknown or expired/,
  );
});
