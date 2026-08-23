import assert from "node:assert/strict";
import test from "node:test";
import { CURRENT_PROTOCOL_VERSION, createDeviceIdentity, createHostIdentity, earsModelKey, makeGlobalSessionId, parseGlobalSessionId, type JsonObject, type ProviderCapabilities, type RemoteMessage, type RemoteSession, type SessionContextState } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { ProviderAdapterError } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { messagePage } from "./bridge.js";
import { SessionCache } from "./session_cache.js";
import { BridgeRequestRouter, clientMessagePage } from "./request_router.js";
import { meshToolDefinitions } from "./mesh_tools.js";
import type { BridgeConfig } from "./config.js";
import type { AuthStatus, CreateSessionOptions, ListSessionsOptions, ObservedExternalSessionLaunch, PaginatedSessions, ProviderClientTooling, ProviderDetection, ProviderEvent, ProviderEventSink, ProviderQueuedMessage, SendMessageRequest, SendMessageResult, SessionCreationFeatures, Subscription } from "../../../packages/provider_contract/src/index.js";
import { defaultTranscriptionSourceRegistry, type DictationTranscriber } from "./dictation.js";
import type { SessionTransferRecord } from "./session_transfer_store.js";

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

class StaticExternalLaunchProvider extends FakeProviderAdapter {
  readonly #sessionStates = new Map<string, RemoteSession["state"]>();
  public readonly directlyReadSessionIds: string[] = [];
  public readonly requestedWorkingDirectories: Array<string | undefined> = [];

  public constructor(
    hostId: string,
    providerId: string,
    private readonly staticSessions: readonly RemoteSession[],
    private readonly launches: readonly ObservedExternalSessionLaunch[] = [],
    private readonly listedProviderSessionIds?: ReadonlySet<string>,
  ) {
    super({ hostId, providerId, sessionCount: 0 });
  }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    this.requestedWorkingDirectories.push(options.workingDirectory);
    return { sessions: options.parentProviderSessionId === undefined ? this.staticSessions
      .filter((session) => options.workingDirectory !== undefined
        ? session.workingDirectory === options.workingDirectory
        : this.listedProviderSessionIds?.has(session.providerSessionId) ?? true)
      .map((session) => ({ ...session, state: this.#sessionStates.get(session.providerSessionId) ?? session.state })) : [], nextCursor: null };
  }

  public override async getSession(providerSessionId: string): Promise<RemoteSession> {
    this.directlyReadSessionIds.push(providerSessionId);
    const session = this.staticSessions.find((candidate) => candidate.providerSessionId === providerSessionId);
    if (session === undefined) throw new Error("Session not found");
    return { ...session, state: this.#sessionStates.get(providerSessionId) ?? session.state };
  }

  public setSessionState(providerSessionId: string, state: RemoteSession["state"]): void {
    this.#sessionStates.set(providerSessionId, state);
  }

  public async getExternalSessionLaunches(_providerSessionId: string, _since: string): Promise<readonly ObservedExternalSessionLaunch[]> {
    return this.launches;
  }
}

class PerSessionExternalLaunchProvider extends StaticExternalLaunchProvider {
  public constructor(
    hostId: string,
    providerId: string,
    sessions: readonly RemoteSession[],
    private readonly launchesByProviderSessionId: ReadonlyMap<string, readonly ObservedExternalSessionLaunch[]>,
  ) {
    super(hostId, providerId, sessions);
  }

  public override async getExternalSessionLaunches(providerSessionId: string, _since: string): Promise<readonly ObservedExternalSessionLaunch[]> {
    return this.launchesByProviderSessionId.get(providerSessionId) ?? [];
  }

  public override async getCapabilities(): Promise<ProviderCapabilities> {
    return { ...await super.getCapabilities(), sessionRelationships: true };
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

class DuplicateTitlePreviewFakeProvider extends FakeProviderAdapter {
  public readonly prompt = "Take the hostile base-population research forward aggressively and autonomously.";

  public constructor(private readonly previewHostId: string) {
    super({ hostId: previewHostId, sessionCount: 1 });
  }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const page = await super.listSessions(options);
    return { ...page, sessions: page.sessions.map((session) => ({ ...session, preview: session.title })) };
  }

  public override async getSession(providerSessionId: string): Promise<RemoteSession> {
    const session = await super.getSession(providerSessionId);
    return { ...session, preview: session.title };
  }

  public override async getMessages(providerSessionId: string): Promise<readonly RemoteMessage[]> {
    return [{
      id: "fake/first-prompt",
      sessionId: makeGlobalSessionId(this.previewHostId, this.providerId, providerSessionId),
      providerMessageId: "first-prompt",
      role: "user",
      createdAt: "2026-08-22T10:00:00.000Z",
      completedAt: "2026-08-22T10:00:00.000Z",
      parts: [{ type: "text", text: this.prompt }],
      status: "completed",
      nativeMetadata: {},
    }, ...await super.getMessages(providerSessionId)];
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

class BlockingInterruptFakeProvider extends FakeProviderAdapter {
  public interruptCalls = 0;
  readonly #blocker: Promise<void>;
  #release!: () => void;

  public constructor(hostId: string) {
    super({ hostId, providerId: "fake", sessionCount: 1 });
    this.#blocker = new Promise<void>((resolve) => { this.#release = resolve; });
  }

  public override async interrupt(providerSessionId: string): Promise<void> {
    this.interruptCalls += 1;
    await this.#blocker;
    await super.interrupt(providerSessionId);
  }

  public releaseInterrupt(): void {
    this.#release();
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
      compactionKind: null,
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

  public async emitAgentCompleted(providerSessionId: string, payload: JsonObject = {}, nativeEvent?: JsonObject): Promise<void> {
    await this.#sink?.({
      eventId: `context_completed_${++this.#eventCounter}`,
      providerId: this.providerId,
      providerSessionId,
      type: "agent.completed",
      occurredAt: "2026-08-14T10:00:01.000Z",
      payload,
      ...(nativeEvent !== undefined ? { nativeEvent } : {}),
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

class IdleResourceFakeProvider extends FakeProviderAdapter {
  public releaseCalls = 0;
  public reportedProviderStatus: NonNullable<RemoteSession["providerStatus"]> | undefined;
  #sink: ProviderEventSink | undefined;
  #eventCounter = 0;

  public constructor(
    hostId: string,
    providerId: string,
    private readonly reportedState: RemoteSession["state"],
  ) {
    super({ hostId, providerId, sessionCount: 1 });
  }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const result = await super.listSessions(options);
    return {
      ...result,
      sessions: result.sessions.map((session) => ({
        ...session,
        state: this.reportedState,
        needsApproval: this.reportedState === "needs_approval",
        ...(this.reportedProviderStatus !== undefined ? { providerStatus: this.reportedProviderStatus } : {}),
      })),
    };
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.#sink = sink;
    return await super.subscribe(providerSessionId, sink);
  }

  public async releaseIdleResources(): Promise<void> {
    this.releaseCalls += 1;
  }

  public async emitState(
    providerSessionId: string,
    state: RemoteSession["state"],
    providerStatus?: NonNullable<RemoteSession["providerStatus"]> | null,
  ): Promise<void> {
    await this.#sink?.({
      eventId: `${this.providerId}_state_${++this.#eventCounter}`,
      providerId: this.providerId,
      providerSessionId,
      type: "session.status_changed",
      occurredAt: new Date().toISOString(),
      payload: {
        state,
        ...(providerStatus !== undefined ? { providerStatus: providerStatus as unknown as JsonObject | null } : {}),
      },
    });
  }

  public async emitEvent(providerSessionId: string, type: ProviderEvent["type"], payload: JsonObject = {}): Promise<void> {
    await this.#sink?.({
      eventId: `${this.providerId}_event_${++this.#eventCounter}`,
      providerId: this.providerId,
      providerSessionId,
      type,
      occurredAt: new Date().toISOString(),
      payload,
    });
  }
}

class BlockingProviderStatusListingFakeProvider extends IdleResourceFakeProvider {
  #nextListGate: Promise<void> | undefined;
  #markNextListStarted: (() => void) | undefined;
  #releaseNextList: (() => void) | undefined;

  public blockNextList(): Promise<void> {
    const started = new Promise<void>((resolve) => { this.#markNextListStarted = resolve; });
    this.#nextListGate = new Promise<void>((resolve) => { this.#releaseNextList = resolve; });
    return started;
  }

  public releaseNextList(): void {
    const release = this.#releaseNextList;
    this.#releaseNextList = undefined;
    release?.();
  }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const result = await super.listSessions(options);
    const gate = this.#nextListGate;
    if (gate === undefined) return result;
    this.#nextListGate = undefined;
    const markStarted = this.#markNextListStarted;
    this.#markNextListStarted = undefined;
    markStarted?.();
    await gate;
    return result;
  }
}

class LaggingListingFakeProvider extends FakeProviderAdapter {
  #sink: ProviderEventSink | undefined;
  #eventCounter = 0;

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const result = await super.listSessions(options);
    return {
      ...result,
      sessions: result.sessions.map((session) => ({ ...session, state: "idle" as const })),
    };
  }

  public override async sendMessage(_providerSessionId: string, _request: SendMessageRequest): Promise<SendMessageResult> {
    return { accepted: true, providerTurnId: "lagging-turn", details: [] };
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.#sink = sink;
    return await super.subscribe(providerSessionId, sink);
  }

  public async emitAgentCompleted(providerSessionId: string): Promise<void> {
    await this.#sink?.({
      eventId: `lagging_completed_${++this.#eventCounter}`,
      providerId: this.providerId,
      providerSessionId,
      type: "agent.completed",
      occurredAt: new Date().toISOString(),
      payload: {},
    });
  }
}

class EyesFakeProvider extends FakeProviderAdapter {
  public readonly sessionCreationFeatures: SessionCreationFeatures = { hiddenDeveloperInstructions: true, ephemeralSessions: true, selectableClientTools: true };
  public helperOptions: CreateSessionOptions | undefined;
  public helperRequest: SendMessageRequest | undefined;
  #helperProviderSessionId: string | undefined;

  public override async listModels() {
    return [{ id: "eyes-model", providerId: this.providerId, displayName: "Eyes Model", isDefault: true, inputModalities: ["text", "image"] as const, nativeMetadata: { inputModalities: ["text", "image"] } }];
  }

  public override async createSession(options: CreateSessionOptions) {
    const { firstInstruction: _firstInstruction, ...sessionOptions } = options;
    const session = await super.createSession(sessionOptions);
    if (options.metadata?.internalPurpose === "vision_proxy") {
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

class TurnGuidedEyesFakeProvider extends EyesFakeProvider {
  public override readonly sessionCreationFeatures = { hiddenDeveloperInstructions: false, ephemeralSessions: false, selectableClientTools: false } as const;
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

class MeshCaptureProvider extends FakeProviderAdapter {
  public readonly creates: CreateSessionOptions[] = [];
  public readonly requests: SendMessageRequest[] = [];

  public override async createSession(options: CreateSessionOptions) {
    this.creates.push(options);
    return await super.createSession(options);
  }

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.requests.push(request);
    return await super.sendMessage(providerSessionId, request);
  }
}

class CollidingQueueFakeProvider extends FakeProviderAdapter {
  public cancelled: { providerSessionId: string; messageId: string } | undefined;
  public readonly listQueuedMessages = async (): Promise<readonly ProviderQueuedMessage[]> => [
    { id: "same-native-id", providerSessionId: "fake_session_0001", content: "First queued prompt", state: "queued", createdAt: "2026-08-14T10:00:00.000Z" },
    { id: "same-native-id", providerSessionId: "fake_session_0002", content: "Second queued prompt", state: "queued", createdAt: "2026-08-14T10:00:01.000Z", attachments: [
      { name: "screen.png", mimeType: "image/png", byteLength: 3, dataUrl: "data:image/png;base64,AQID" },
      { name: "voice.mp3", mimeType: "audio/mpeg", byteLength: 3, dataUrl: "data:audio/mpeg;base64,BAUG", durationSeconds: 2.5 },
      { name: "notes.md", mimeType: "text/markdown", byteLength: 42 },
    ] },
  ];
  public readonly cancelQueuedMessage = async (providerSessionId: string, messageId: string): Promise<boolean> => {
    this.cancelled = { providerSessionId, messageId };
    return true;
  };
}

class CapturingDesktopQueueProvider extends FakeProviderAdapter {
  public enqueueCalls = 0;
  public sendCalls = 0;
  public readonly enqueueQueuedMessage = async (providerSessionId: string, request: { readonly content: string }): Promise<ProviderQueuedMessage> => {
    this.enqueueCalls += 1;
    return {
      id: `desktop-queued-${this.enqueueCalls}`,
      providerSessionId,
      content: request.content,
      state: "queued",
      createdAt: "2026-08-21T18:00:00.000Z",
    };
  };

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.sendCalls += 1;
    return await super.sendMessage(providerSessionId, request);
  }
}

class ExternalOwnerAttachmentProvider extends FakeProviderAdapter {
  public directSendCalls = 0;
  public ownerSendCalls = 0;
  public ownerRequest: SendMessageRequest | undefined;
  public rejectOwnerSend = false;

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const result = await super.listSessions(options);
    return { ...result, sessions: result.sessions.map((session) => ({ ...session, externalWriter: true })) };
  }

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.directSendCalls += 1;
    return await super.sendMessage(providerSessionId, request);
  }

  public async sendMessageToExternalOwner(_providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.ownerSendCalls += 1;
    this.ownerRequest = request;
    if (this.rejectOwnerSend) throw new Error("Desktop owner rejected the audio turn");
    return { accepted: true, providerTurnId: "owner-audio-turn", details: [] };
  }
}

class ForeignSubagentCaptureProvider extends FakeProviderAdapter {
  public readonly requests: SendMessageRequest[] = [];

  public constructor(hostId: string, providerId: string) {
    super({ hostId, providerId, sessionCount: 2 });
  }

  public override async sendMessage(_providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.requests.push(request);
    return { accepted: true, providerTurnId: "foreign-turn", details: [] };
  }
}

function testClientTooling(): ProviderClientTooling {
  return {
    definitions: meshToolDefinitions,
    execute: async () => null,
    mcpServer: () => ({ name: "test-mesh", command: "node", args: [], env: {} }),
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

test("bridge releases idle providers but keeps working, approval, and input providers alive", async (t) => {
  const hostId = "host-idle-resources";
  const idle = new IdleResourceFakeProvider(hostId, "idle-provider", "idle");
  const working = new IdleResourceFakeProvider(hostId, "working-provider", "working");
  const approval = new IdleResourceFakeProvider(hostId, "approval-provider", "needs_approval");
  const input = new IdleResourceFakeProvider(hostId, "input-provider", "needs_input");
  const providers = [idle, working, approval, input];
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: providers.map((provider) => provider.providerId) },
    providers,
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  for (const provider of providers) provider.releaseCalls = 0;

  await bridge.refresh();

  assert.equal(idle.releaseCalls, 1);
  assert.equal(working.releaseCalls, 0);
  assert.equal(approval.releaseCalls, 0);
  assert.equal(input.releaseCalls, 0);

  await bridge.listModels("working-provider");
  assert.equal(working.releaseCalls, 0, "read-only calls must not release a provider with a live task");
  await bridge.listModels("idle-provider");
  assert.equal(idle.releaseCalls, 2);
  const idleSession = bridge.sessions().find((session) => session.providerId === "idle-provider");
  assert.ok(idleSession);
  await bridge.openSession(idleSession.id);
  assert.equal(idle.releaseCalls, 3, "opening an idle task must re-arm provider release");
  await bridge.createSession("idle-provider", { workingDirectory: process.cwd() });
  assert.equal(idle.releaseCalls, 4, "creating an idle task must re-arm provider release");
  await bridge.providerConnections();
  assert.equal(idle.releaseCalls, 5);
  assert.equal(working.releaseCalls, 0);

  await working.emitState("fake_session_0001", "idle");
  await waitFor(() => working.releaseCalls === 1, "terminal provider idle release");
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

class EarsFakeProvider extends FakeProviderAdapter {
  public helperRequest: SendMessageRequest | undefined;
  public helperOptions: CreateSessionOptions | undefined;
  public readonly helperRequests: SendMessageRequest[] = [];
  public createCalls = 0;
  public createDelayMs = 0;
  public failNextHelperSend: ProviderAdapterError | undefined;
  public failEveryHelperSend: ProviderAdapterError | undefined;
  #helperProviderSessionId: string | undefined;
  readonly #helperProviderSessionIds = new Set<string>();
  readonly #helperMessages = new Map<string, RemoteMessage[]>();
  readonly #missingHelperIds = new Set<string>();

  public override async listModels() {
    return [{
      id: "gpt-5.6-sol",
      providerId: this.providerId,
      displayName: "GPT-5.6 Sol",
      isDefault: true,
      inputModalities: ["text", "image", "audio"] as const,
      nativeMetadata: {
        inputModalities: ["text", "image", "audio"],
        supportedReasoningEfforts: ["High", "Low", "Ultra"],
      },
    }, {
      id: "deepseek-v4-pro",
      providerId: this.providerId,
      displayName: "DeepSeek V4 Pro",
      isDefault: false,
      inputModalities: ["text", "audio"] as const,
      nativeMetadata: {
        inputModalities: ["text", "audio"],
        supportedReasoningEfforts: ["Low", "High"],
      },
    }];
  }

  public override async createSession(options: CreateSessionOptions) {
    this.createCalls += 1;
    if (this.createDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    const session = await super.createSession(options);
    this.helperOptions = options;
    this.#helperProviderSessionId = session.providerSessionId;
    this.#helperProviderSessionIds.add(session.providerSessionId);
    this.#helperMessages.set(session.providerSessionId, []);
    return session;
  }

  public markLatestHelperMissing(): void {
    if (this.#helperProviderSessionId !== undefined) this.#missingHelperIds.add(this.#helperProviderSessionId);
  }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    const listed = await super.listSessions(options);
    return { ...listed, sessions: listed.sessions.filter((session) => !this.#missingHelperIds.has(session.providerSessionId)) };
  }

  public override async getSession(providerSessionId: string): Promise<RemoteSession> {
    if (this.#missingHelperIds.has(providerSessionId)) {
      throw new ProviderAdapterError(this.providerId, "SESSION_NOT_FOUND", "EARS helper session was deleted", false);
    }
    return await super.getSession(providerSessionId);
  }

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    if (!this.#helperProviderSessionIds.has(providerSessionId)) return await super.sendMessage(providerSessionId, request);
    if (this.#missingHelperIds.has(providerSessionId)) {
      throw new ProviderAdapterError(this.providerId, "SESSION_NOT_FOUND", "EARS helper session was deleted", false);
    }
    if (this.failNextHelperSend !== undefined) {
      const error = this.failNextHelperSend;
      this.failNextHelperSend = undefined;
      throw error;
    }
    if (this.failEveryHelperSend !== undefined) throw this.failEveryHelperSend;
    this.helperRequest = request;
    this.helperRequests.push(request);
    const responseNumber = this.helperRequests.length;
    this.#helperMessages.get(providerSessionId)?.push({
      id: `ears-answer-${responseNumber}`,
      sessionId: makeGlobalSessionId("host-ears", this.providerId, providerSessionId),
      providerMessageId: `ears-answer-${responseNumber}`,
      role: "assistant" as const,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      parts: [{ type: "text" as const, text: `Fix the failing test${responseNumber === 1 ? "." : ` ${responseNumber}.`}` }],
      status: "completed" as const,
      nativeMetadata: {},
    });
    return { accepted: true, details: [] };
  }

  public override async getMessages(providerSessionId: string) {
    if (!this.#helperProviderSessionIds.has(providerSessionId)) return await super.getMessages(providerSessionId);
    if (this.#missingHelperIds.has(providerSessionId)) {
      throw new ProviderAdapterError(this.providerId, "SESSION_NOT_FOUND", "EARS helper session was deleted", false);
    }
    return [...(this.#helperMessages.get(providerSessionId) ?? [])];
  }
}

function uploadEarsClip(bridge: AgentBridge, name: string): string {
  const bytes = Buffer.from(`audio-${name}`);
  const started = bridge.beginAttachmentUpload({ name, mimeType: "audio/mpeg", byteLength: bytes.length });
  bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
  return bridge.completeAttachmentUpload(started.uploadId).attachmentId;
}

test("EARS transcribes dictation audio on a hidden helper without a destination turn", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears", providerId: "direct", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-ears"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destination = (await bridge.refresh()).sessions.find((session) => session.providerId === "direct")!;
  const beforeEvents = bridge.eventsSince(0).length;
  const bytes = Buffer.from("abcd");
  const started = bridge.beginAttachmentUpload({ name: "dictation.mp3", mimeType: "audio/mpeg", byteLength: bytes.length });
  bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
  const completed = bridge.completeAttachmentUpload(started.uploadId);

  const result = await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [completed.attachmentId],
    sessionId: destination.id,
  });

  assert.deepEqual(result.texts, ["Fix the failing test."]);
  assert.equal(bridge.sessions().some((session) => session.agentRole === "ears"), false);
  assert.equal(bridge.eventsSince(beforeEvents).some((event) => event.payload && JSON.stringify(event.payload).includes("Fix the failing test.")), false);
  assert.match(ears.helperRequest?.developerInstructions ?? "", /audio-to-prompt preprocessing layer/);
  assert.equal(ears.helperRequest?.attachments?.[0]?.mimeType, "audio/mpeg");
  assert.equal(ears.helperRequest?.reasoningEffort, "Low");
  assert.doesNotMatch(ears.helperRequest?.content ?? "", /Fix the failing test/);
  await assert.rejects(() => bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [completed.attachmentId],
    sessionId: destination.id,
  }), /already in use|unknown or expired|incomplete/);
});

test("cancelling EARS aborts the helper wait and releases the upload", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-cancel", providerId: "direct", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-ears-cancel"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destination = (await bridge.refresh()).sessions.find((session) => session.providerId === "direct")!;
  const bytes = Buffer.from("abcd");
  const started = bridge.beginAttachmentUpload({ name: "dictation.mp3", mimeType: "audio/mpeg", byteLength: bytes.length });
  bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
  const completed = bridge.completeAttachmentUpload(started.uploadId);

  const processing = bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [completed.attachmentId],
    sessionId: destination.id,
    requestId: "ears-job-cancel",
  });
  assert.equal(bridge.cancelEars("ears-job-cancel").cancelled, true);
  await assert.rejects(processing, /EARS transcription was cancelled/);

  const retry = await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [completed.attachmentId],
    sessionId: destination.id,
  });
  assert.deepEqual(retry.texts, ["Fix the failing test."]);
});

test("EARS request identities cannot collide and are released after early validation failure", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-request-id", providerId: "direct", sessionCount: 1 });
  ears.createDelayMs = 20;
  const bridge = new AgentBridge({ ...config("host-ears-request-id"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destination = (await bridge.refresh()).sessions.find((session) => session.providerId === "direct")!;
  const requestId = "ears-stable-request";
  const attachmentId = uploadEarsClip(bridge, "request-id.mp3");

  await assert.rejects(() => bridge.processEars({
    providerId: "direct",
    modelId: "missing-model",
    mode: "cleaned",
    attachmentIds: [attachmentId],
    sessionId: destination.id,
    requestId,
  }), /no longer available/);
  const active = bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [attachmentId],
    sessionId: destination.id,
    requestId,
  });
  await assert.rejects(() => bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, "duplicate-id.mp3")],
    sessionId: destination.id,
    requestId,
  }), /already running/);
  assert.deepEqual((await active).texts, ["Fix the failing test."]);
});

test("EARS shares one isolated helper across parent chats using the same provider and model", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-reuse", providerId: "direct", sessionCount: 2 });
  const helperStates: Readonly<Record<string, string>>[] = [];
  const bridge = new AgentBridge({ ...config("host-ears-reuse"), enabledProviders: ["direct"] }, [ears], {
    internalHelperWorkingDirectory: "C:\\Tethoq-state",
    onEarsHelpersChange: (helpers) => helperStates.push(helpers),
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const destinations = (await bridge.refresh()).sessions.filter((session) => session.providerId === "direct");
  assert.equal(destinations.length, 2);

  const first = await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "verbatim",
    attachmentIds: [uploadEarsClip(bridge, "first.mp3")],
    sessionId: destinations[0]!.id,
  });
  const second = await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, "second.mp3")],
    sessionId: destinations[1]!.id,
  });

  assert.deepEqual(first.texts, ["Fix the failing test."]);
  assert.deepEqual(second.texts, ["Fix the failing test 2."]);
  assert.equal(ears.createCalls, 1);
  assert.equal(ears.helperRequests.length, 2);
  assert.equal(ears.helperOptions?.metadata?.parentSessionId, undefined);
  assert.equal(ears.helperOptions?.workingDirectory, "C:\\Tethoq-state");
  assert.equal(Object.keys(helperStates.at(-1) ?? {}).length, 1);
  for (const request of ears.helperRequests) {
    assert.match(request.developerInstructions ?? "", /shared across Tethoq tasks/);
    assert.match(request.developerInstructions ?? "", /Ignore all earlier helper-session context/);
    assert.match(request.content, /New independent transcription job/);
    assert.match(request.content, /return only its transcript/);
  }
});

test("persisted EARS helpers stay hidden across a bridge restart", async (t) => {
  const hostId = "host-ears-restored";
  const helper: RemoteSession = {
    id: makeGlobalSessionId(hostId, "direct", "persisted-ears-helper"),
    hostId,
    providerId: "direct",
    providerSessionId: "persisted-ears-helper",
    title: "EARS",
    state: "idle",
    lastActivityAt: "2026-08-22T00:00:00.000Z",
    needsApproval: false,
    stale: false,
    modelId: "gpt-5.6-sol",
    nativeMetadata: {},
  };
  const provider = new StaticExternalLaunchProvider(hostId, "direct", [helper]);
  const bridge = new AgentBridge({ ...config(hostId), enabledProviders: ["direct"] }, [provider], {
    earsHelpers: { [earsModelKey("direct", "gpt-5.6-sol")]: helper.id },
  });
  t.after(() => bridge.dispose());
  await bridge.start();

  assert.equal((await bridge.refresh()).sessions.some((session) => session.id === helper.id), false);
});

test("EARS keeps separate helpers for different models", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-models", providerId: "direct", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-ears-models"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destination = (await bridge.refresh()).sessions.find((session) => session.providerId === "direct")!;

  await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, "sol.mp3")],
    sessionId: destination.id,
  });
  await bridge.processEars({
    providerId: "direct",
    modelId: "deepseek-v4-pro",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, "deepseek.mp3")],
    sessionId: destination.id,
  });

  assert.equal(ears.createCalls, 2);
});

test("EARS recreates a provider-deleted cached helper exactly once", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-stale", providerId: "direct", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-ears-stale"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destination = (await bridge.refresh()).sessions.find((session) => session.providerId === "direct")!;

  await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, "before-delete.mp3")],
    sessionId: destination.id,
  });
  ears.markLatestHelperMissing();
  const recovered = await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, "after-delete.mp3")],
    sessionId: destination.id,
  });

  assert.deepEqual(recovered.texts, ["Fix the failing test 2."]);
  assert.equal(ears.createCalls, 2);
});

test("EARS retries once when a helper disappears between validation and send", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-race", providerId: "direct", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-ears-race"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destination = (await bridge.refresh()).sessions.find((session) => session.providerId === "direct")!;
  ears.failNextHelperSend = new ProviderAdapterError("direct", "SESSION_NOT_FOUND", "helper vanished", false);

  const result = await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, "race.mp3")],
    sessionId: destination.id,
  });

  assert.deepEqual(result.texts, ["Fix the failing test."]);
  assert.equal(ears.createCalls, 2);
  assert.equal(ears.helperRequests.length, 1);
});

test("EARS does not recreate or retry for an unrelated provider failure", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-failure", providerId: "direct", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-ears-failure"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destination = (await bridge.refresh()).sessions.find((session) => session.providerId === "direct")!;
  ears.failNextHelperSend = new ProviderAdapterError("direct", "AUTH_REQUIRED", "wallet expired", false);

  await assert.rejects(() => bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, "auth.mp3")],
    sessionId: destination.id,
  }), /wallet expired/);
  assert.equal(ears.createCalls, 1);
  assert.equal(ears.helperRequests.length, 0);
});

test("EARS stops after one stale-helper retry", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-retry-limit", providerId: "direct", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-ears-retry-limit"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destination = (await bridge.refresh()).sessions.find((session) => session.providerId === "direct")!;
  ears.failEveryHelperSend = new ProviderAdapterError("direct", "SESSION_NOT_FOUND", "helper remains missing", false);

  const attachmentId = uploadEarsClip(bridge, "retry-limit.mp3");
  await assert.rejects(() => bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [attachmentId],
    sessionId: destination.id,
  }), /helper remains missing/);
  assert.equal(ears.createCalls, 2);
  assert.equal(ears.helperRequests.length, 0);
  ears.failEveryHelperSend = undefined;
  const retry = await bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [attachmentId],
    sessionId: destination.id,
  });
  assert.deepEqual(retry.texts, ["Fix the failing test."]);
  assert.equal(ears.createCalls, 2);
});

test("concurrent EARS requests create one helper and cannot cross-wire transcripts", async (t) => {
  const ears = new EarsFakeProvider({ hostId: "host-ears-concurrent", providerId: "direct", sessionCount: 2 });
  ears.createDelayMs = 20;
  const bridge = new AgentBridge({ ...config("host-ears-concurrent"), enabledProviders: ["direct"] }, [ears]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const destinations = (await bridge.refresh()).sessions.filter((session) => session.providerId === "direct");

  const results = await Promise.all(destinations.map((destination, index) => bridge.processEars({
    providerId: "direct",
    modelId: "gpt-5.6-sol",
    mode: "cleaned",
    attachmentIds: [uploadEarsClip(bridge, `concurrent-${index}.mp3`)],
    sessionId: destination.id,
  })));

  assert.deepEqual(results.map((result) => result.texts), [
    ["Fix the failing test."],
    ["Fix the failing test 2."],
  ]);
  assert.equal(ears.createCalls, 1);
  assert.equal(ears.helperRequests.length, 2);
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
  assert.equal(eyes.helperOptions?.developerInstructions, undefined);
  assert.equal((eyes.helperRequest?.developerInstructions?.split(/\s+/u).length ?? 0) < 200, true);
  assert.match(eyes.helperRequest?.developerInstructions ?? "", /visual support for another model/u);
  assert.equal(eyes.helperOptions?.ephemeral, true);
  assert.equal(eyes.helperOptions?.clientTools, "none");
  assert.equal(eyes.helperOptions?.mcpServers, "none");
  assert.equal(eyes.helperRequest?.attachments?.[0]?.name, "screen.png");
});

test("eyes accepts image models whose harness supports hidden one-turn guidance without session-scoped instructions", async (t) => {
  const parent = new FakeProviderAdapter({ hostId: "host-eyes", providerId: "parent", sessionCount: 1 });
  const eyes = new TurnGuidedEyesFakeProvider({ hostId: "host-eyes", providerId: "eyes-turn-guided", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-eyes"), enabledProviders: ["parent", "eyes-turn-guided"] }, [parent, eyes]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const primary = (await bridge.refresh()).sessions.find((session) => session.providerId === "parent")!;

  assert.deepEqual((await bridge.visionProxyTargets()).map((target) => target.providerId), ["eyes-turn-guided"]);
  await bridge.configureVisionProxy(primary.id, { providerId: "eyes-turn-guided", modelId: "eyes-model", reasoningEffort: "low" });
  await bridge.askVisionProxy(primary.id, "What is visible?", [{
    name: "screen.png", mimeType: "image/png", dataBase64: "AQID", byteLength: 3,
  }]);

  assert.equal(eyes.helperOptions?.developerInstructions, undefined);
  assert.match(eyes.helperRequest?.developerInstructions ?? "", /Answer only the visual question/u);
  assert.equal(eyes.helperRequest?.attachments?.[0]?.mimeType, "image/png");
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

test("request router sends and queues audio-only messages while rejecting a truly empty message", async (t) => {
  const hostId = "host-audio-only";
  const provider = new TextOnlyCapturingProvider({ hostId, providerId: "codex", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config(hostId), enabledProviders: ["codex"] }, [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  await provider.resumeSession(session.providerSessionId);

  const uploadAudio = (requestId: string) => {
    const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04]);
    const started = bridge.beginAttachmentUpload({ name: `${requestId}.mp3`, mimeType: "audio/mpeg", byteLength: bytes.length });
    bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
    return bridge.completeAttachmentUpload(started.uploadId).attachmentId;
  };
  const request = (messageId: string, type: "session.send_message" | "message_queue.enqueue", payload: JsonObject) => router.handle({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId,
    hostId,
    sentAt: "2026-08-21T12:00:00.000Z",
    kind: "request",
    type,
    requestId: `request-${messageId}`,
    payload,
  });

  const sent = await request("audio-only-send", "session.send_message", {
    sessionId: session.id,
    content: "",
    attachmentIds: [uploadAudio("send")],
  });
  assert.equal(sent.ok, true);
  assert.equal(provider.lastRequest?.content, "");
  assert.equal(provider.lastRequest?.attachments?.[0]?.mimeType, "audio/mpeg");

  const empty = await request("truly-empty-send", "session.send_message", { sessionId: session.id, content: "" });
  assert.equal(empty.ok, false);
  assert.match(empty.error?.message ?? "", /content must be a non-empty string/);

  const queued = await request("audio-only-queue", "message_queue.enqueue", {
    sessionId: session.id,
    content: "",
    attachmentIds: [uploadAudio("queue")],
  });
  assert.equal(queued.ok, true);
  const queuedMessage = queued.payload.message as unknown as { readonly content: string; readonly attachments: readonly { readonly mimeType: string }[] };
  assert.equal(queuedMessage.content, "");
  assert.equal(queuedMessage.attachments[0]?.mimeType, "audio/mpeg");
});

test("externally owned Codex audio requires one real owner acknowledgement and never enters the local queue", async (t) => {
  const hostId = "host-external-owner-audio";
  const provider = new ExternalOwnerAttachmentProvider({ hostId, providerId: "codex", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config(hostId), enabledProviders: ["codex"] }, [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  assert.equal(session.externalWriter, true);

  const uploadAudio = (name: string) => {
    const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04]);
    const started = bridge.beginAttachmentUpload({ name, mimeType: "audio/mpeg", byteLength: bytes.length });
    bridge.appendAttachmentChunk(started.uploadId, 0, bytes.toString("base64"));
    return bridge.completeAttachmentUpload(started.uploadId).attachmentId;
  };
  const send = (messageId: string, attachmentId: string) => router.handle({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId,
    hostId,
    sentAt: "2026-08-22T12:00:00.000Z",
    kind: "request",
    type: "session.send_message",
    requestId: `request-${messageId}`,
    payload: { sessionId: session.id, content: "", attachmentIds: [attachmentId] },
  });

  const accepted = await send("owner-audio-accepted", uploadAudio("accepted.mp3"));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.payload.providerTurnId, "owner-audio-turn");
  assert.equal(provider.ownerSendCalls, 1);
  assert.equal(provider.directSendCalls, 0);
  assert.equal(provider.ownerRequest?.attachments?.[0]?.mimeType, "audio/mpeg");
  assert.equal(bridge.queuedMessages(session.id).length, 0);

  provider.rejectOwnerSend = true;
  const rejected = await send("owner-audio-rejected", uploadAudio("rejected.mp3"));
  assert.equal(rejected.ok, false);
  assert.match(rejected.error?.message ?? "", /Desktop owner rejected the audio turn/);
  assert.equal(provider.ownerSendCalls, 2);
  assert.equal(provider.directSendCalls, 0);
  assert.equal(bridge.queuedMessages(session.id).length, 0, "a local queue row cannot masquerade as delivery");
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

test("concurrent stop requests share one provider interruption", async (t) => {
  const hostId = "host-interrupt-coalescing";
  const fake = new BlockingInterruptFakeProvider(hostId);
  const bridge = new AgentBridge(config(hostId), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  const first = bridge.interrupt(session.id);
  const second = bridge.interrupt(session.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.interruptCalls, 1);

  fake.releaseInterrupt();
  await Promise.all([first, second]);
  assert.equal(fake.interruptCalls, 1);
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

test("Bridge preserves an explicit completion reason while dropping raw provider metadata", async (t) => {
  const provider = new ContextFakeProvider({ hostId: "host-completion-marker", providerId: "context", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-completion-marker"), enabledProviders: ["context"] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await provider.emitAgentCompleted(
    parseGlobalSessionId(session.id).providerSessionId,
    { completionReason: "runaway_guard" },
    { secretNativeDetail: "must not cross the desktop boundary" },
  );
  const completed = bridge.eventsSince(0).find((event) => event.type === "agent.completed");
  assert.ok(completed);
  assert.equal(completed.payload.completionReason, "runaway_guard");
  assert.equal("nativeEvent" in completed, false);
  assert.equal(JSON.stringify(completed).includes("secretNativeDetail"), false);
});

test("failed immediate compaction restores the previously applied threshold", async (t) => {
  const provider = new ContextFakeProvider({ hostId: "host-context", providerId: "context", sessionCount: 1 });
  let persisted: Readonly<Record<string, number>> = {};
  const bridge = new AgentBridge({ ...config("host-context"), enabledProviders: ["context"] }, [provider], {
    onCompactionThresholdsChange: (thresholds) => { persisted = { ...thresholds }; },
  });
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
  assert.equal(persisted[session.id], 600_000, "a failed compaction must never replace the durable setting");
});

test("an applied context threshold survives a bridge restart and re-clamps to a changed model window", async (t) => {
  let persisted: Readonly<Record<string, number>> = {};
  const firstProvider = new ContextFakeProvider({ hostId: "host-context-restart", providerId: "context", sessionCount: 1 });
  firstProvider.usedTokens = 10_000;
  const first = new AgentBridge({ ...config("host-context-restart"), enabledProviders: ["context"] }, [firstProvider], {
    onCompactionThresholdsChange: (thresholds) => { persisted = { ...thresholds }; },
  });
  await first.start();
  const firstSession = (await first.refresh()).sessions[0]!;
  await first.setSessionCompactionThreshold(firstSession.id, 600_000, false);
  assert.equal(persisted[firstSession.id], 600_000);
  await first.dispose();

  const secondProvider = new ContextFakeProvider({ hostId: "host-context-restart", providerId: "context", sessionCount: 1 });
  secondProvider.usedTokens = 10_000;
  secondProvider.contextWindowTokens = 400_000;
  const second = new AgentBridge({ ...config("host-context-restart"), enabledProviders: ["context"] }, [secondProvider], {
    compactionThresholds: persisted,
    onCompactionThresholdsChange: (thresholds) => { persisted = { ...thresholds }; },
  });
  t.after(() => second.dispose());
  await second.start();
  const secondSession = (await second.refresh()).sessions[0]!;
  assert.equal(secondSession.id, firstSession.id);
  assert.equal((await second.sessionContext(secondSession.id)).compactionThresholdTokens, 400_000);
  assert.equal(persisted[secondSession.id], 400_000, "the durable value must follow the provider-confirmed clamp");
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
  const activeContext = await bridge.sessionContext(session.id);
  assert.equal(activeContext.isCompacting, true);
  assert.equal(activeContext.compactionKind, "automatic");
  assert.equal(provider.operations.includes("send"), false, "the queued turn must remain held while compaction is active");

  releaseCompaction();
  await completion;
  await waitFor(() => bridge.queuedMessages(session.id).length === 0, "post-compaction queue dispatch");
  assert.deepEqual(provider.operations, ["compact:start", "compact:completed", "send"]);
  const compactionEvents = bridge.eventsSince(0).filter((event) => event.type.startsWith("context.compaction_"));
  assert.deepEqual(compactionEvents.map((event) => [event.type, event.payload.kind]), [
    ["context.compaction_started", "automatic"],
    ["context.compaction_completed", "automatic"],
  ]);
  const completedContext = await bridge.sessionContext(session.id);
  assert.equal(completedContext.isCompacting, false);
  assert.equal(completedContext.compactionKind, null);
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

test("opening a session replaces a title-duplicate preview with its first visible user prompt", async (t) => {
  const fake = new DuplicateTitlePreviewFakeProvider("host-preview");
  const bridge = new AgentBridge(config("host-preview"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const listed = (await bridge.refresh()).sessions[0]!;

  assert.equal(listed.preview, listed.title, "the fixture must reproduce OpenCode's duplicate title preview");
  const opened = await bridge.openSession(listed.id);
  assert.equal(opened.session.title, listed.title, "Tethoq must not replace the provider-owned title");
  assert.equal(opened.session.preview, fake.prompt, "the first real user prompt must become the useful task-row preview");

  const refreshed = (await bridge.refresh()).sessions.find((session) => session.id === listed.id);
  assert.equal(refreshed?.preview, fake.prompt, "a later provider refresh must not restore the duplicate title preview");
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

  await bridge.openSession(session.id, undefined, 40, true);
  assert.equal(fake.getMessagesCalls, 2, "an explicit visible-task refresh must bypass the short-lived snapshot");

  await fake.emitMessageDelta(session.providerSessionId);
  await bridge.openSession(session.id);
  assert.equal(fake.getMessagesCalls, 3, "a live message event must invalidate the fresh snapshot");
  const replayedDelta = bridge.eventsSince(0).find((event) => event.type === "message.delta");
  assert.equal(replayedDelta?.nativeEvent, undefined, "raw provider events must not duplicate large payloads in replay");
});

test("watching a session holds the provider transport without another history read", async (t) => {
  const fake = new CountingOpenFakeProvider({ hostId: "host-watch-session", sessionCount: 1 });
  let releaseCalls = 0;
  Object.assign(fake, { releaseIdleResources: async () => { releaseCalls += 1; } });
  const bridge = new AgentBridge(config("host-watch-session"), [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  await bridge.openSession(session.id);
  assert.equal(fake.getMessagesCalls, 1);
  const releasesBeforeWatch = releaseCalls;
  await bridge.watchSession(session.id);
  await bridge.openSession(session.id);
  assert.equal(fake.getMessagesCalls, 1, "a watched open must keep using the existing transcript");
  assert.equal(releaseCalls, releasesBeforeWatch, "watching must not idle-release the provider");
  await bridge.unwatchSession(session.id);
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

test("provider retry status survives refresh and clears on resumed or terminal activity", async (t) => {
  const retry = {
    kind: "retry" as const,
    message: "The provider is temporarily rate limited.",
    retryAt: "2026-08-20T12:00:05.000Z",
  };
  const provider = new IdleResourceFakeProvider("host-provider-status", "fake", "working");
  provider.reportedProviderStatus = retry;
  const bridge = new AgentBridge(config("host-provider-status"), [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  assert.deepEqual(session.providerStatus, retry, "the canonical listing carries retry detail into the cache");

  const updated = { ...retry, message: "The provider is retrying after a capacity limit." };
  await provider.emitState(session.providerSessionId, "working", updated);
  assert.deepEqual(bridge.sessions().find((item) => item.id === session.id)?.providerStatus, updated);

  await provider.emitState(session.providerSessionId, "working", null);
  assert.equal(bridge.sessions().find((item) => item.id === session.id)?.providerStatus, undefined, "explicit null clears the notice");

  await provider.emitState(session.providerSessionId, "working", retry);
  await provider.emitEvent(session.providerSessionId, "message.started", { info: { role: "user" } });
  assert.deepEqual(
    bridge.sessions().find((item) => item.id === session.id)?.providerStatus,
    retry,
    "a late user echo is not resumed assistant activity",
  );
  await provider.emitEvent(session.providerSessionId, "message.started", { info: { role: "assistant" } });
  assert.equal(bridge.sessions().find((item) => item.id === session.id)?.providerStatus, undefined);

  const clearingEvents: readonly [ProviderEvent["type"], JsonObject][] = [
    ["message.delta", { text: "resumed output" }],
    ["tool.output", { output: "tool progress" }],
    ["command.completed", { command: "npm test" }],
    ["agent.completed", {}],
    ["agent.interrupted", {}],
    ["agent.error", { message: "genuine provider failure" }],
  ];
  for (const [type, payload] of clearingEvents) {
    await provider.emitState(session.providerSessionId, "working", retry);
    assert.deepEqual(bridge.sessions().find((item) => item.id === session.id)?.providerStatus, retry);
    await provider.emitEvent(session.providerSessionId, type, payload);
    assert.equal(bridge.sessions().find((item) => item.id === session.id)?.providerStatus, undefined, `${type} clears retry detail`);
  }

  await provider.emitState(session.providerSessionId, "working", retry);
  provider.reportedProviderStatus = undefined;
  await bridge.refreshProvider(provider.providerId);
  assert.equal(
    bridge.sessions().find((item) => item.id === session.id)?.providerStatus,
    undefined,
    "a canonical refresh omission must not revive a stale retry notice",
  );
});

test("a provider listing already in flight cannot revive retry state cleared by a live event", async (t) => {
  const retry = {
    kind: "retry" as const,
    message: "The provider is temporarily rate limited.",
  };
  const provider = new BlockingProviderStatusListingFakeProvider("host-provider-status-race", "fake", "working");
  provider.reportedProviderStatus = retry;
  const bridge = new AgentBridge(config("host-provider-status-race"), [provider]);
  t.after(() => {
    provider.releaseNextList();
    return bridge.dispose();
  });
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  assert.deepEqual(session.providerStatus, retry);

  const listingStarted = provider.blockNextList();
  const refresh = bridge.refreshProvider(provider.providerId);
  await listingStarted;
  await provider.emitState(session.providerSessionId, "working", null);
  assert.equal(bridge.sessions().find((item) => item.id === session.id)?.providerStatus, undefined);
  provider.releaseNextList();
  await refresh;

  assert.equal(
    bridge.sessions().find((item) => item.id === session.id)?.providerStatus,
    undefined,
    "the stale listing must not restore retry state after the live clear",
  );
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

test("one desktop-queue request performs one provider queue mutation and no direct send", async (t) => {
  const provider = new CapturingDesktopQueueProvider({ hostId: "host-desktop-queue-once", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-desktop-queue-once"), enabledProviders: [provider.providerId] }, [provider]);
  const router = new BridgeRequestRouter(bridge);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;

  const response = await router.handle({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: "desktop-queue-once-message",
    hostId: "host-desktop-queue-once",
    sentAt: "2026-08-21T18:00:00.000Z",
    kind: "request",
    type: "message_queue.enqueue",
    requestId: "desktop-queue-once-request",
    payload: { sessionId: session.id, content: "Queue exactly once" },
  });

  assert.equal(response.ok, true);
  assert.equal(provider.enqueueCalls, 1);
  assert.equal(provider.sendCalls, 0);
  assert.equal(bridge.queuedMessages(session.id).length, 1);
});

test("bridge queue stays visible while a provider turn is in flight even if listed state is idle", async (t) => {
  const fake = new FakeProviderAdapter({ hostId: "host-queue-active-turn", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-queue-active-turn"), enabledProviders: ["fake"] }, [fake]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const session = (await bridge.refresh()).sessions[0]!;
  await fake.resumeSession(session.providerSessionId);
  await waitFor(() => bridge.sessions().find((item) => item.id === session.id)?.state === "idle", "idle after resume");
  fake.holdActiveTurn = true;

  const queued = await bridge.enqueueMessage(session.id, { requestId: "held-follow-up", content: "Ask this next" });
  assert.equal(bridge.queuedMessages(session.id)[0]?.id, queued.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bridge.queuedMessages(session.id)[0]?.state, "queued");

  fake.holdActiveTurn = false;
  await fake.interrupt(session.providerSessionId);
  await waitFor(() => bridge.queuedMessages(session.id).length === 0, "held queue dispatch after turn ends");
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
  assert.deepEqual(queued[1]?.attachments, [
    { name: "screen.png", mimeType: "image/png", byteLength: 3, dataUrl: "data:image/png;base64,AQID" },
    { name: "voice.mp3", mimeType: "audio/mpeg", byteLength: 3, dataUrl: "data:audio/mpeg;base64,BAUG", durationSeconds: 2.5 },
    { name: "notes.md", mimeType: "text/markdown", byteLength: 42 },
  ]);
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

test("explicit cross-provider launches group under their Codex owner, preserve nearby human tasks, and survive restart", async () => {
  const hostId = "host-observed-launch";
  const session = (providerId: string, providerSessionId: string, title: string, directory: string, createdAt: string): RemoteSession => ({
    id: makeGlobalSessionId(hostId, providerId, providerSessionId),
    hostId,
    providerId,
    providerSessionId,
    title,
    workingDirectory: directory,
    project: directory.split("\\").at(-1) ?? directory,
    state: "idle",
    createdAt,
    lastActivityAt: "2026-08-22T00:40:00.000Z",
    modelId: providerId === "opencode" ? "deepseek/deepseek-v4-pro" : "gpt-5.6-sol",
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  });
  const parent = session("codex", "parent", "Find the enemy population path", "C:\\work\\audit", "2026-08-22T00:00:00.000Z");
  const child = session("opencode", "worker", "Audit worker", "C:\\work\\audit", "2026-08-22T00:29:04.000Z");
  const human = session("opencode", "human", "Human-created OpenCode task", "C:\\work\\audit", "2026-08-22T00:29:06.000Z");
  const launch: ObservedExternalSessionLaunch = {
    targetProviderId: "opencode",
    title: child.title,
    workingDirectory: child.workingDirectory!,
    modelId: child.modelId!,
    observedAt: "2026-08-22T00:28:59.000Z",
  };
  let persisted: readonly SessionTransferRecord[] = [];
  const childProvider = new StaticExternalLaunchProvider(hostId, "opencode", [child, human]);
  const first = new AgentBridge(
    { ...config(hostId), enabledProviders: ["codex", "opencode"] },
    [new StaticExternalLaunchProvider(hostId, "codex", [parent], [launch]), childProvider],
    { onSessionTransfersChange: (records) => { persisted = [...records]; } },
  );
  await first.start();
  const firstSessions = (await first.refresh()).sessions;
  assert.equal(firstSessions.find((candidate) => candidate.id === child.id)?.relationship?.sourceSessionId, parent.id);
  assert.equal(firstSessions.find((candidate) => candidate.id === child.id)?.parentSessionId, parent.id);
  assert.equal(firstSessions.find((candidate) => candidate.id === human.id)?.relationship, undefined, "same-directory human work must remain top-level");
  assert.deepEqual((await first.listChildSessions(parent.id)).map((candidate) => candidate.id), [child.id]);
  childProvider.setSessionState(child.providerSessionId, "working");
  assert.equal((await first.listChildSessions(parent.id))[0]?.state, "working", "an open child view re-lists the cross-provider worker state");
  childProvider.setSessionState(child.providerSessionId, "completed");
  assert.equal((await first.listChildSessions(parent.id))[0]?.state, "completed", "the same child settles without reopening its parent");
  assert.equal(first.sessions().find((candidate) => candidate.id === human.id)?.relationship, undefined, "refreshing worker state never groups a nearby human task");
  assert.equal(persisted.length, 1);
  await first.dispose();

  const restarted = new AgentBridge(
    { ...config(hostId), enabledProviders: ["codex", "opencode"] },
    [new StaticExternalLaunchProvider(hostId, "codex", [parent]), new StaticExternalLaunchProvider(hostId, "opencode", [child, human])],
    { sessionTransfers: persisted },
  );
  await restarted.start();
  const restartedSessions = (await restarted.refresh()).sessions;
  assert.equal(restartedSessions.find((candidate) => candidate.id === child.id)?.relationship?.sourceSessionId, parent.id);
  assert.equal(restartedSessions.find((candidate) => candidate.id === human.id)?.relationship, undefined);
  await restarted.dispose();
});

test("historical launch discovery reads the exact target directory and keeps an omitted mother task", async (t) => {
  const hostId = "host-directory-launch";
  const directory = "C:\\work\\hidden-global";
  const makeSession = (providerId: string, providerSessionId: string, title: string, createdAt: string): RemoteSession => ({
    id: makeGlobalSessionId(hostId, providerId, providerSessionId), hostId, providerId, providerSessionId, title,
    workingDirectory: directory, project: "hidden-global", state: "idle", createdAt, lastActivityAt: "2026-08-22T00:40:00.000Z",
    modelId: providerId === "opencode" ? "deepseek/model" : "gpt-5.6-sol", needsApproval: false, stale: false, nativeMetadata: {},
  });
  const parent = makeSession("codex", "parent", "Mother", "2026-08-22T00:00:00.000Z");
  const child = makeSession("opencode", "hidden-worker", "Exact hidden worker", "2026-08-22T00:29:02.000Z");
  const launch: ObservedExternalSessionLaunch = {
    targetProviderId: "opencode", title: child.title, observedAt: "2026-08-22T00:29:00.000Z",
    workingDirectory: directory, modelId: child.modelId!,
  };
  const listedParents = new Set([parent.providerSessionId]);
  const parentProvider = new StaticExternalLaunchProvider(hostId, "codex", [parent], [launch], listedParents);
  const childProvider = new StaticExternalLaunchProvider(hostId, "opencode", [child], [], new Set());
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["codex", "opencode"] },
    [parentProvider, childProvider],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  assert.equal(bridge.sessions().find((session) => session.id === child.id)?.relationship?.sourceSessionId, parent.id);
  assert.ok(childProvider.requestedWorkingDirectories.includes(directory), "the hidden OpenCode project must be listed by its explicit launch directory");

  listedParents.clear();
  await bridge.refreshProvider("codex");
  assert.equal(bridge.sessions().some((session) => session.id === parent.id), true, "a mother referenced by a confirmed child must survive an omitted provider page");
});

test("persisted external sub-agents missing from a provider listing are restored by exact session ID", async (t) => {
  const hostId = "host-persisted-unlisted-child";
  const makeSession = (providerId: string, providerSessionId: string, title: string): RemoteSession => ({
    id: makeGlobalSessionId(hostId, providerId, providerSessionId),
    hostId,
    providerId,
    providerSessionId,
    title,
    workingDirectory: "C:\\work\\audit",
    project: "audit",
    state: providerSessionId === "worker-hidden" ? "working" : "idle",
    createdAt: "2026-08-22T00:00:00.000Z",
    lastActivityAt: "2026-08-22T00:10:00.000Z",
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  });
  const parent = makeSession("codex", "parent", "Parent task");
  const visibleChild = makeSession("opencode", "worker-visible", "Visible worker");
  const hiddenChild = makeSession("opencode", "worker-hidden", "Global-project worker");
  const childProvider = new StaticExternalLaunchProvider(
    hostId,
    "opencode",
    [visibleChild, hiddenChild],
    [],
    new Set([visibleChild.providerSessionId]),
  );
  const relationship = { kind: "subagent" as const, sourceSessionId: parent.id, strategy: "native" as const };
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["codex", "opencode"] },
    [new StaticExternalLaunchProvider(hostId, "codex", [parent]), childProvider],
    { sessionTransfers: [
      { sessionId: visibleChild.id, relationship, pending: false },
      { sessionId: hiddenChild.id, relationship, pending: false },
    ] },
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  assert.equal(bridge.sessions().find((session) => session.id === hiddenChild.id)?.relationship?.sourceSessionId, parent.id);

  const children = await bridge.listChildSessions(parent.id);
  assert.deepEqual(children.map((session) => session.id).sort(), [hiddenChild.id, visibleChild.id].sort());
  assert.equal(children.find((session) => session.id === hiddenChild.id)?.state, "working");
  assert.deepEqual(childProvider.directlyReadSessionIds, [hiddenChild.providerSessionId]);
});

test("ambiguous external launch evidence leaves every possible child visible", async (t) => {
  const hostId = "host-ambiguous-launch";
  const makeSession = (providerId: string, providerSessionId: string, title: string, createdAt: string): RemoteSession => ({
    id: makeGlobalSessionId(hostId, providerId, providerSessionId),
    hostId,
    providerId,
    providerSessionId,
    title,
    workingDirectory: "C:\\work\\audit",
    project: "audit",
    state: "idle",
    createdAt,
    lastActivityAt: createdAt,
    modelId: providerId === "opencode" ? "deepseek/deepseek-v4-pro" : "gpt-5.6-sol",
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  });
  const parent = makeSession("codex", "parent", "Parent task", "2026-08-22T00:00:00.000Z");
  const possibleChildA = makeSession("opencode", "worker-a", "Same worker", "2026-08-22T00:29:01.000Z");
  const possibleChildB = makeSession("opencode", "worker-b", "Same worker", "2026-08-22T00:29:02.000Z");
  const launch: ObservedExternalSessionLaunch = {
    targetProviderId: "opencode",
    title: "Same worker",
    workingDirectory: "C:\\work\\audit",
    modelId: "deepseek/deepseek-v4-pro",
    observedAt: "2026-08-22T00:29:00.000Z",
  };
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["codex", "opencode"] },
    [new StaticExternalLaunchProvider(hostId, "codex", [parent], [launch]), new StaticExternalLaunchProvider(hostId, "opencode", [possibleChildA, possibleChildB])],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  const sessions = (await bridge.refresh()).sessions;

  for (const candidate of [possibleChildA, possibleChildB]) {
    assert.equal(sessions.find((session) => session.id === candidate.id)?.relationship, undefined);
  }
});

test("native and externally spawned subagents coexist without flattening mixed model metadata", async (t) => {
  const hostId = "host-mixed-subagents";
  const directory = "C:\\work\\mixed";
  const makeSession = (
    providerId: string,
    providerSessionId: string,
    title: string,
    createdAt: string,
    modelId: string,
    reasoningEffort?: string,
  ): RemoteSession => ({
    id: makeGlobalSessionId(hostId, providerId, providerSessionId),
    hostId,
    providerId,
    providerSessionId,
    title,
    workingDirectory: directory,
    project: "mixed",
    state: "idle",
    createdAt,
    lastActivityAt: createdAt,
    modelId,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  });
  const parent = makeSession("codex", "parent", "Mother task", "2026-08-22T00:00:00.000Z", "gpt-5.6-sol", "ultra");
  const external = makeSession("worker", "external", "Exact external worker", "2026-08-22T00:29:01.000Z", "deepseek-v4-pro", "max");
  const ambiguousA = makeSession("worker", "ambiguous-a", "Ambiguous worker", "2026-08-22T00:29:02.000Z", "deepseek-v4-flash", "high");
  const ambiguousB = makeSession("worker", "ambiguous-b", "Ambiguous worker", "2026-08-22T00:29:03.000Z", "deepseek-v4-flash", "high");
  const launches: readonly ObservedExternalSessionLaunch[] = [{
    targetProviderId: "worker",
    title: external.title,
    workingDirectory: directory,
    modelId: external.modelId!,
    observedAt: "2026-08-22T00:29:00.000Z",
  }, {
    targetProviderId: "worker",
    title: "Ambiguous worker",
    workingDirectory: directory,
    modelId: "deepseek-v4-flash",
    observedAt: "2026-08-22T00:29:00.000Z",
  }];
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["codex", "worker"] },
    [
      new StaticExternalLaunchProvider(hostId, "codex", [parent], launches),
      new StaticExternalLaunchProvider(hostId, "worker", [external, ambiguousA, ambiguousB]),
    ],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  const delegated = await bridge.startDelegation(parent.id, "Review the local adapter", [{
    providerId: "worker",
    modelId: "fake-careful",
    reasoningEffort: "high",
  }]);
  const nativeChildId = delegated.children[0]?.sessionId;
  assert.ok(nativeChildId);

  const children = await bridge.listChildSessions(parent.id);
  assert.deepEqual(new Set(children.map((session) => session.id)), new Set([external.id, nativeChildId]));
  assert.equal(children.every((session) => session.relationship?.kind === "subagent" && session.relationship.sourceSessionId === parent.id), true);
  assert.deepEqual(
    children.map((session) => ({ id: session.id, modelId: session.modelId, reasoningEffort: session.reasoningEffort })).sort((left, right) => left.id.localeCompare(right.id)),
    [
      { id: external.id, modelId: "deepseek-v4-pro", reasoningEffort: "max" },
      { id: nativeChildId, modelId: "fake-careful", reasoningEffort: "high" },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
  const topLevel = bridge.sessions().filter((session) => session.parentSessionId === undefined);
  assert.equal(topLevel.some((session) => session.id === parent.id), true);
  assert.equal(topLevel.some((session) => session.id === external.id), false);
  assert.equal(topLevel.some((session) => session.id === nativeChildId), false);
  assert.equal(topLevel.some((session) => session.id === ambiguousA.id), true);
  assert.equal(topLevel.some((session) => session.id === ambiguousB.id), true);
});

test("external workers launched by a hidden Codex child group under the visible mother", async (t) => {
  const hostId = "host-external-grandchildren";
  const directory = "C:\\work\\grandchildren";
  const makeSession = (providerId: string, providerSessionId: string, title: string, createdAt: string): RemoteSession => ({
    id: makeGlobalSessionId(hostId, providerId, providerSessionId),
    hostId,
    providerId,
    providerSessionId,
    title,
    workingDirectory: directory,
    project: "grandchildren",
    state: "idle",
    createdAt,
    lastActivityAt: createdAt,
    modelId: providerId === "codex" ? "gpt-5.6-sol" : "deepseek/deepseek-v4-flash",
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  });
  const mother = makeSession("codex", "mother", "Visible mother", "2026-08-22T13:40:00.000Z");
  const launcher = {
    ...makeSession("codex", "launcher", "Hidden telemetry worker", "2026-08-22T13:41:00.000Z"),
    parentSessionId: mother.id,
    relationship: { kind: "subagent" as const, sourceSessionId: mother.id, strategy: "native" as const },
  };
  const external = makeSession("opencode", "external", "Sample Flash final config closure", "2026-08-22T13:45:43.000Z");
  const launch: ObservedExternalSessionLaunch = {
    targetProviderId: "opencode",
    title: external.title,
    workingDirectory: directory,
    modelId: external.modelId!,
    observedAt: "2026-08-22T13:45:40.000Z",
  };
  const codex = new PerSessionExternalLaunchProvider(
    hostId,
    "codex",
    [mother, launcher],
    new Map([[launcher.providerSessionId, [launch]]]),
  );
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["codex", "opencode"] },
    [codex, new StaticExternalLaunchProvider(hostId, "opencode", [external])],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  const linked = bridge.sessions().find((session) => session.id === external.id);
  assert.equal(linked?.relationship?.sourceSessionId, mother.id, "the external grandchild must be reachable from the visible mother");
  assert.equal(linked?.parentSessionId, mother.id);
  assert.equal(linked?.nativeMetadata.tethoqObservedExternalLauncherSessionId, launcher.id, "the exact hidden launcher provenance must remain inspectable");
  assert.deepEqual(new Set((await bridge.listChildSessions(mother.id)).map((session) => session.id)), new Set([launcher.id, external.id]));
  assert.equal((await bridge.listChildSessions(launcher.id)).some((session) => session.id === external.id), false);
});

test("session.side_chats lists live and finished side chats for a parent and excludes delegated children", async (t) => {
  const hostId = "host-side-chat-listing";
  const provider = new FakeProviderAdapter({ hostId, sessionCount: 2 });
  const workerProvider = new FakeProviderAdapter({ hostId, providerId: "worker", sessionCount: 0 });
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["fake", "worker"] },
    [provider, workerProvider],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions.find((session) => session.providerId === "fake" && session.state === "idle")!;

  const { session: sideChat } = await bridge.createSideChat(parent.id, "Inspect this without editing files");
  const { session: liveSideChat } = await bridge.createSideChat(parent.id, "Keep a second chat open");
  await waitFor(() => bridge.pendingApprovals().some((approval) => approval.sessionId === sideChat.id), "side-chat approval");
  const approval = bridge.pendingApprovals().find((entry) => entry.sessionId === sideChat.id)!;
  await bridge.respondToApproval({ requestId: approval.requestId, choiceId: "approve", respondedAt: new Date().toISOString() });
  await waitFor(() => bridge.sessions().find((session) => session.id === sideChat.id)?.state === "completed", "side-chat completion");

  const task = await bridge.startDelegation(parent.id, "Delegated worker must not be listed", [{ providerId: "worker" }]);
  const childId = task.children[0]?.sessionId;
  assert.ok(childId);

  const listed = await bridge.listSideChatSessions(parent.id);
  assert.deepEqual(new Set(listed.map((entry) => entry.id)), new Set([sideChat.id, liveSideChat.id]));
  assert.equal(listed.some((entry) => entry.id === childId), false, "delegated subagents must not be returned");
  const finished = listed.find((entry) => entry.id === sideChat.id)!;
  assert.equal(finished.state, "completed");
  assert.equal(finished.providerId, provider.providerId);
  assert.equal(typeof finished.title, "string");
  assert.equal(typeof finished.updatedAt, "string");
  assert.equal(finished.preview, "Inspect this without editing files");
  assert.equal(listed.find((entry) => entry.id === liveSideChat.id)?.preview, "Keep a second chat open");

  const unrelated = makeGlobalSessionId(hostId, provider.providerId, "parent-without-side-chats");
  assert.deepEqual(await bridge.listSideChatSessions(unrelated), []);

  const response = await new BridgeRequestRouter(bridge).handle({
    protocolVersion: 1,
    messageId: "message-side-chat-listing",
    hostId,
    sentAt: new Date().toISOString(),
    kind: "request",
    type: "session.side_chats",
    requestId: "request-side-chat-listing",
    payload: { sessionId: parent.id },
  });
  assert.equal(response.ok, true);
  const sessions = response.payload.sessions;
  assert.ok(Array.isArray(sessions));
  assert.deepEqual(new Set(sessions.map((item) => (item as JsonObject).id)), new Set([sideChat.id, liveSideChat.id]));
  assert.equal((sessions[0] as JsonObject).sessionKind, undefined, "side-chat rows carry slim fields, not full sessions");
  assert.equal(bridge.sessions().some((session) => session.id === childId), true, "top-level listing is unchanged by the side-chat call");
});

test("foreign-subagent guidance names the real mesh tools and appears only for enabled sessions", async (t) => {
  const hostId = "host-foreign-subagents";
  const allowed = new ForeignSubagentCaptureProvider(hostId, "allowed");
  const denied = new ForeignSubagentCaptureProvider(hostId, "denied");
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["allowed", "denied"] },
    [allowed, denied],
    { sessionMaySpawnForeignSubagents: (sessionId) => parseGlobalSessionId(sessionId).providerId === "allowed" },
  );
  bridge.configureClientTooling(testClientTooling());
  t.after(() => bridge.dispose());
  await bridge.start();
  const allowedSession = (await bridge.refresh()).sessions.find((session) => session.providerId === "allowed" && session.state === "idle")!;
  const deniedSession = (await bridge.refresh()).sessions.find((session) => session.providerId === "denied" && session.state === "idle")!;

  await bridge.sendMessage(allowedSession.id, { requestId: "foreign-allowed", content: "Offload the survey to another tool" });
  const guidance = allowed.requests.at(-1)?.developerInstructions ?? "";
  assert.match(guidance, /mesh_list_sessions/);
  assert.match(guidance, /mesh_message_session/);
  assert.match(guidance, /target_session_id/);
  assert.match(guidance, /request_id/);
  assert.match(guidance, /must not spawn/u);
  assert.equal(allowed.requests.at(-1)?.content.includes("mesh_list_sessions"), false, "guidance must stay out of the visible message");

  await bridge.sendMessage(deniedSession.id, { requestId: "foreign-denied", content: "Try without permission" });
  assert.doesNotMatch(denied.requests.at(-1)?.developerInstructions ?? "", /mesh_list_sessions/);

  const plain = new ForeignSubagentCaptureProvider("host-foreign-default", "plain");
  const defaultBridge = new AgentBridge({ ...config("host-foreign-default"), enabledProviders: ["plain"] }, [plain]);
  defaultBridge.configureClientTooling(testClientTooling());
  t.after(() => defaultBridge.dispose());
  await defaultBridge.start();
  const plainSession = (await defaultBridge.refresh()).sessions.find((session) => session.state === "idle")!;
  await defaultBridge.sendMessage(plainSession.id, { requestId: "foreign-default", content: "Nothing enabled" });
  assert.doesNotMatch(plain.requests.at(-1)?.developerInstructions ?? "", /mesh_list_sessions/, "guidance defaults to off");
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

  await assert.rejects(() => bridge.startDelegation(parent.id, "Reject stale model metadata", [{
    providerId: "worker",
    modelId: "missing-model",
    reasoningEffort: "high",
  }]), /selected worker delegated model is unavailable/);
  await assert.rejects(() => bridge.startDelegation(parent.id, "Reject effort without model", [{
    providerId: "worker",
    reasoningEffort: "high",
  }]), /requires an explicit model/);
});

test("an instruction-less mesh creates privately framed workers without leaking control markers", async (t) => {
  const hostId = "host-empty-mesh";
  const parentProvider = new MeshCaptureProvider({ hostId, providerId: "parent", sessionCount: 1 });
  const workerProvider = new MeshCaptureProvider({ hostId, providerId: "worker", sessionCount: 0 });
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["parent", "worker"] },
    [parentProvider, workerProvider],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions.find((session) => session.providerId === "parent")!;

  const task = await bridge.startDelegation(parent.id, "", [{ providerId: "worker" }]);
  const childId = task.children[0]?.sessionId;
  assert.ok(childId);
  assert.equal(task.prompt, "");
  const workerRequest = workerProvider.requests.find((request) => request.requestId.startsWith("first_turn_"));
  assert.match(workerRequest?.content ?? "", /^<tethoq_hidden_control_turn>mesh-worker:/u);
  assert.match(workerRequest?.developerInstructions ?? "", /worker delegated by another coding-agent session/u);
  assert.doesNotMatch(workerProvider.creates.at(-1)?.firstInstruction ?? "", /tethoq_hidden_control_turn/u);
  const child = bridge.sessions().find((session) => session.id === childId);
  assert.equal(child?.title, "Delegated worker");
  assert.equal(child?.preview, "Awaiting instruction from the parent task");
  assert.doesNotMatch(`${child?.title ?? ""}\n${child?.preview ?? ""}`, /tethoq_hidden_control_turn|UAR_MESH/u);
});

test("parent can finish a turn while delegated children continue and receive their results later", async (t) => {
  const hostId = "host-background-delegation";
  const parentProvider = new MeshCaptureProvider({ hostId, providerId: "parent", sessionCount: 2 });
  const workerProvider = new MeshCaptureProvider({ hostId, providerId: "worker", sessionCount: 0 });
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

  const startRequest = parentProvider.requests.find((request) => request.requestId.startsWith("delegation_started_"));
  assert.match(startRequest?.content ?? "", /^<tethoq_hidden_control_turn>mesh-started:/u);
  assert.doesNotMatch(startRequest?.content ?? "", /UAR_MESH_STARTED/);
  assert.match(startRequest?.developerInstructions ?? "", /UAR_MESH_STARTED/);
  assert.match(startRequest?.developerInstructions ?? "", /finish this turn while workers are still running/);
  const workerRequest = workerProvider.requests.find((request) => request.content === "Review the background lifecycle");
  assert.match(workerRequest?.developerInstructions ?? "", /worker delegated by another coding-agent session/u);
  assert.equal(workerProvider.creates.at(-1)?.firstInstruction, undefined, "the worker task must be dispatched separately from its hidden guidance");

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

  const resultRequest = parentProvider.requests.find((request) => request.requestId.startsWith("delegation_synthesis_"));
  assert.match(resultRequest?.content ?? "", /^<tethoq_hidden_control_turn>mesh-result:/u);
  assert.doesNotMatch(resultRequest?.content ?? "", /UAR_MESH_RESULT/);
  assert.match(resultRequest?.developerInstructions ?? "", /UAR_MESH_RESULT/);
  assert.match(resultRequest?.developerInstructions ?? "", /The requested work is complete/);
  assert.notEqual(bridge.delegations(parent.id)[0]?.state, "completed");

  const synthesisApproval = bridge.pendingApprovals().find((approval) => approval.sessionId === parent.id)!;
  await bridge.respondToApproval({
    requestId: synthesisApproval.requestId,
    choiceId: "approve",
    respondedAt: new Date().toISOString(),
  });
  await waitFor(() => bridge.delegations(parent.id)[0]?.state === "completed", "delegation synthesis completion");
});

test("delegated children keep a working state across provider listings and settle when the child finishes", async (t) => {
  const hostId = "host-delegation-listing";
  const parentProvider = new FakeProviderAdapter({ hostId, providerId: "parent", sessionCount: 2 });
  const workerProvider = new LaggingListingFakeProvider({ hostId, providerId: "worker", sessionCount: 0 });
  const bridge = new AgentBridge(
    { ...config(hostId), enabledProviders: ["parent", "worker"] },
    [parentProvider, workerProvider],
  );
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions.find((session) => session.providerId === "parent" && session.state === "idle")!;

  const task = await bridge.startDelegation(parent.id, "Keep the delegated turn visible", [{ providerId: "worker" }]);
  const childId = task.children[0]?.sessionId;
  assert.ok(childId);
  assert.equal(bridge.sessions().find((session) => session.id === childId)?.state, "working");

  await bridge.refresh();
  const afterRefresh = bridge.sessions().find((session) => session.id === childId);
  assert.equal(afterRefresh?.state, "working", "a provider listing must not downgrade a delegated child mid-turn");
  assert.equal(afterRefresh?.parentSessionId, parent.id);

  const childProviderSessionId = afterRefresh?.providerSessionId;
  assert.ok(childProviderSessionId);
  await workerProvider.emitAgentCompleted(childProviderSessionId);
  await waitFor(() => bridge.sessions().find((session) => session.id === childId)?.state === "completed", "delegated child completion");

  await bridge.refresh();
  assert.equal(bridge.sessions().find((session) => session.id === childId)?.state, "idle", "a finished child must settle instead of staying stuck working");
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
      dictionary: ["OpenCode", "PostgreSQL"],
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.payload.text, "Transcribed instruction");
  assert.deepEqual(dictionary, ["OpenCode", "PostgreSQL"]);
});

test("request router validates and persists a dictation API key without returning it", async (t) => {
  const apiKey = ["sk", "test", "dictation", "value"].join("-");
  const persisted: Array<{ readonly sourceId: string; readonly apiKey: string | undefined }> = [];
  const bridge = new AgentBridge(config("host-dictation-configure"), [], {
    transcriptionSources: defaultTranscriptionSourceRegistry({
      openAiApiKey: "",
      xAiApiKey: "",
      fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    }),
    onTranscriptionCredentialChange: (sourceId, value) => { persisted.push({ sourceId, apiKey: value }); },
  });
  t.after(() => bridge.dispose());
  await bridge.start();

  const response = await new BridgeRequestRouter(bridge).handle({
    protocolVersion: 1,
    messageId: "message-dictation-configure",
    hostId: "host-dictation-configure",
    sentAt: new Date().toISOString(),
    kind: "request",
    type: "dictation.source.configure",
    requestId: "request-dictation-configure",
    payload: { sourceId: "openai-stt", apiKey },
  });

  assert.equal(response.ok, true);
  assert.deepEqual(persisted, [{ sourceId: "openai-stt", apiKey }]);
  assert.doesNotMatch(JSON.stringify(response), new RegExp(apiKey));
  const sources = response.payload.sources as Array<{ readonly id: string; readonly status: string }>;
  assert.equal(sources.find((source) => source.id === "openai-stt")?.status, "ready");
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

class LateArrivingFakeProvider extends FakeProviderAdapter {
  public available = false;
  public listCalls = 0;

  public override async detect(): Promise<ProviderDetection> {
    if (!this.available) {
      return {
        providerId: this.providerId,
        available: false,
        executable: "late-provider",
        details: ["The server for this provider is still starting."],
      };
    }
    return await super.detect();
  }

  public override async listSessions(options: ListSessionsOptions = {}): Promise<PaginatedSessions> {
    this.listCalls += 1;
    // A server that is not up yet refuses the connection rather than answering
    // an empty list, which is what makes the startup refresh cache nothing.
    if (!this.available) throw new Error("connection refused");
    return await super.listSessions(options);
  }
}

class ResubscribableFakeProvider extends FakeProviderAdapter {
  public available = false;
  public subscribeCalls = 0;
  public detectCalls = 0;

  public override async detect(): Promise<ProviderDetection> {
    this.detectCalls += 1;
    if (!this.available) {
      return {
        providerId: this.providerId,
        available: false,
        executable: "resub-provider",
        details: ["The server for this provider is still starting."],
      };
    }
    return await super.detect();
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.subscribeCalls += 1;
    return await super.subscribe(providerSessionId, sink);
  }
}

class SlowSubscribingFakeProvider extends FakeProviderAdapter {
  public subscribeCalls = 0;
  public release = (): void => undefined;
  readonly #gate: Promise<void>;

  public constructor(options: ConstructorParameters<typeof FakeProviderAdapter>[0]) {
    super(options);
    this.#gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  public override async subscribe(providerSessionId: string | null, sink: ProviderEventSink): Promise<Subscription> {
    this.subscribeCalls += 1;
    await this.#gate;
    return await super.subscribe(providerSessionId, sink);
  }
}

class FlakyDetectionFakeProvider extends FakeProviderAdapter {
  public detectCalls = 0;
  public failNextDetection = false;

  public override async detect(): Promise<ProviderDetection> {
    this.detectCalls += 1;
    if (this.failNextDetection) {
      this.failNextDetection = false;
      return {
        providerId: this.providerId,
        available: false,
        executable: "flaky",
        details: ["The health probe timed out."],
      };
    }
    return await super.detect();
  }
}

test("one dropped detection probe does not strip a known provider of its capabilities", async (t) => {
  const flaky = new FlakyDetectionFakeProvider({ hostId: "host-flaky", providerId: "flaky", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-flaky"), enabledProviders: ["flaky"] }, [flaky]);
  t.after(() => bridge.dispose());

  const [first] = await bridge.providerConnections();
  assert.equal(first?.detected, true);
  const callsAfterFirst = flaky.detectCalls;

  // The server blips for exactly one probe, the way a busy or restarting one does.
  flaky.failNextDetection = true;
  const [second] = await bridge.providerConnections();

  assert.equal(flaky.detectCalls, callsAfterFirst + 2, "a provider that has answered before is asked twice");
  assert.equal(second?.detected, true, "a single dropped probe must not report the provider missing");
  assert.equal(second?.capabilities.sendMessage, true, "losing capabilities is what takes away the ability to send");
});

/** A harness that is up and answering, but whose probes fail the way a busy one does. */
class BlippingFakeProvider extends FakeProviderAdapter {
  public detectUnavailable = false;
  public authError: Error | null = null;
  public capabilitiesError: Error | null = null;

  public override async detect(): Promise<ProviderDetection> {
    if (this.detectUnavailable) {
      return { providerId: this.providerId, available: false, executable: "blip", details: ["The health probe timed out."] };
    }
    return await super.detect();
  }

  public override async getAuthStatus(): Promise<AuthStatus> {
    if (this.authError) throw this.authError;
    return await super.getAuthStatus();
  }

  public override async getCapabilities(): Promise<ProviderCapabilities> {
    if (this.capabilitiesError) throw this.capabilitiesError;
    return await super.getCapabilities();
  }
}

test("no kind of blip takes away the ability to write into a task that is already open", async (t) => {
  const blippy = new BlippingFakeProvider({ hostId: "host-blip", providerId: "blip", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-blip"), enabledProviders: ["blip"] }, [blippy]);
  t.after(() => bridge.dispose());

  const [healthy] = await bridge.providerConnections();
  assert.equal(healthy?.detected, true);
  assert.equal(healthy?.capabilities.sendMessage, true);

  // Reaching a tool and being able to send to it are different questions. Every one
  // of these used to answer the second by reporting every capability false, which is
  // exactly what puts "cannot accept messages right now" in front of someone whose
  // harness is running perfectly well. None of them may do that any more.
  const blips: readonly (readonly [string, () => void, () => void])[] = [
    ["a health probe that keeps timing out", () => { blippy.detectUnavailable = true; }, () => { blippy.detectUnavailable = false; }],
    ["an auth read that fails", () => { blippy.authError = new Error("auth read failed"); }, () => { blippy.authError = null; }],
    ["a capability read that fails", () => { blippy.capabilitiesError = new Error("capability read failed"); }, () => { blippy.capabilitiesError = null; }],
  ];
  for (const [label, breakIt, healIt] of blips) {
    breakIt();
    const [during] = await bridge.providerConnections();
    assert.equal(during?.capabilities.sendMessage, true, `${label} must not withdraw sending`);
    assert.equal(during?.detected, true, `${label} does not mean the harness was uninstalled`);
    // It is still reported as out of reach, so the task list, the provider list and
    // starting new work there all continue to tell the truth.
    assert.equal(during?.state, "offline", `${label} must still read as offline`);
    assert.ok(during?.lastError, `${label} must carry the real reason`);
    assert.equal(during?.authenticated, null);

    // A successful probe reads the tool's auth for itself, so a real answer there is
    // the signal that the blip is over and nothing had to be restarted to end it.
    healIt();
    const [after] = await bridge.providerConnections();
    assert.notEqual(after?.authenticated, null, `${label} must clear on its own once the harness answers`);
    assert.equal(after?.capabilities.sendMessage, true);
  }

  // Two probes in a row failing is an outage, not a dropped packet, and it must be
  // survivable too: a long blip is the one most likely to be noticed.
  blippy.detectUnavailable = true;
  await bridge.providerConnections();
  const [stillOut] = await bridge.providerConnections();
  assert.equal(stillOut?.capabilities.sendMessage, true, "a longer outage must not withdraw sending either");
});

test("a harness that has never answered claims nothing", async (t) => {
  const unknown = new BlippingFakeProvider({ hostId: "host-unknown", providerId: "unknown", sessionCount: 0 });
  unknown.detectUnavailable = true;
  const bridge = new AgentBridge({ ...config("host-unknown"), enabledProviders: ["unknown"] }, [unknown]);
  t.after(() => bridge.dispose());

  // Nothing is known about a tool that has never spoken, so nothing is claimed for
  // it. A genuinely missing harness costs exactly what it did before.
  const [connection] = await bridge.providerConnections();
  assert.equal(connection?.detected, false);
  assert.equal(connection?.capabilities.sendMessage, false);
  assert.equal(connection?.state, "offline");
});

class CountingUnavailableFakeProvider extends FakeProviderAdapter {
  public detectCalls = 0;

  public override async detect(): Promise<ProviderDetection> {
    this.detectCalls += 1;
    return {
      providerId: this.providerId,
      available: false,
      executable: "missing-provider",
      details: ["Provider executable is not installed on this host."],
    };
  }
}

test("a provider that has never answered is not probed twice", async (t) => {
  const missing = new CountingUnavailableFakeProvider({ hostId: "host-never", providerId: "never", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-never"), enabledProviders: ["never"] }, [missing]);
  t.after(() => bridge.dispose());

  const before = missing.detectCalls;
  const [connection] = await bridge.providerConnections();

  assert.equal(connection?.detected, false);
  assert.equal(missing.detectCalls - before, 1, "an absent tool must not cost a doubled probe every refresh");
});

test("a provider that comes up after startup has its existing sessions listed, not just its live events", async (t) => {
  const late = new LateArrivingFakeProvider({ hostId: "host-late", providerId: "late", sessionCount: 3 });
  const bridge = new AgentBridge({ ...config("host-late"), enabledProviders: ["late"] }, [late]);
  t.after(() => bridge.dispose());

  await bridge.start();
  await bridge.refresh();

  // The provider was down for the startup pass, so nothing of it is cached.
  assert.equal(bridge.sessions().filter((session) => session.providerId === "late").length, 0);

  // OpenCode's server finishes booting and the desktop reconnects it.
  late.available = true;
  const listsBeforeReconnect = late.listCalls;
  await bridge.reconnectProvider("late");

  assert.ok(late.listCalls > listsBeforeReconnect, "reconnecting must re-list the provider");
  assert.equal(bridge.sessions().filter((session) => session.providerId === "late").length, 3);
});

test("a detected provider without an event subscription resubscribes itself after a cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const provider = new ResubscribableFakeProvider({ hostId: "host-resubscribe", providerId: "resub", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-resubscribe"), enabledProviders: ["resub"] }, [provider]);
  t.after(() => bridge.dispose());

  await bridge.start();
  await bridge.refresh();
  assert.equal(provider.subscribeCalls, 0, "a provider that fails detection at startup is not subscribed");

  provider.available = true;
  const connections = await bridge.providerConnections();
  const connection = connections.find((candidate) => candidate.providerId === "resub");
  assert.equal(connection?.detected, true);
  assert.equal(connection?.state, "offline");
  assert.equal(provider.subscribeCalls, 0, "reading connections must not subscribe synchronously");

  // Repeated readings must not stack duplicate reconnect timers.
  await bridge.providerConnections();
  await bridge.providerConnections();
  t.mock.timers.tick(15_001);
  for (let attempt = 0; attempt < 50 && provider.subscribeCalls === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(provider.subscribeCalls, 1, "the cooldown fires exactly one reconnect");
  assert.ok(bridge.eventsSince(0).some((event) => event.type === "provider.connected" && event.providerId === "resub"));

  const after = await bridge.providerConnections();
  assert.equal(after.find((candidate) => candidate.providerId === "resub")?.state, "online");
});

test("a harness that is still starting up reconnects itself, with nobody watching", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const provider = new ResubscribableFakeProvider({ hostId: "host-cold", providerId: "cold", sessionCount: 1 });
  const bridge = new AgentBridge({ ...config("host-cold"), enabledProviders: ["cold"] }, [provider]);
  t.after(() => bridge.dispose());

  // The tool this app starts for you is not listening yet when the startup pass
  // runs - the ordinary case, because the app is what starts it.
  await bridge.start();
  await bridge.refresh();
  assert.equal(provider.subscribeCalls, 0);

  // Nothing reads providerConnections from here on. That is the whole point: the
  // window took its snapshot during the failure and has no reason to ask again,
  // so if the first attempt is the only attempt, the harness stays recorded as
  // missing for the rest of the session and the composer refuses to send to a
  // tool that is running perfectly well.
  provider.available = true;
  t.mock.timers.tick(3_001);
  for (let attempt = 0; attempt < 50 && provider.subscribeCalls === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(provider.subscribeCalls, 1, "a failed attempt must book its own next one");
  assert.ok(
    bridge.eventsSince(0).some((event) => event.type === "provider.connected" && event.providerId === "cold"),
    "and announce the recovery, which is what tells the window to look again",
  );
  const [connection] = await bridge.providerConnections();
  assert.equal(connection?.detected, true);
  assert.equal(connection?.capabilities.sendMessage, true);
});

test("a harness that stays down keeps being retried, at a slowing pace", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const provider = new ResubscribableFakeProvider({ hostId: "host-slow-start", providerId: "slowstart", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-slow-start"), enabledProviders: ["slowstart"] }, [provider]);
  t.after(() => bridge.dispose());

  await bridge.start();
  await bridge.refresh();

  // Retries keep coming while it is down, so a tool that takes a while to boot is
  // still picked up rather than being written off after one look.
  const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  t.mock.timers.tick(3_001); await settle();
  t.mock.timers.tick(6_001); await settle();
  t.mock.timers.tick(12_001); await settle();
  assert.equal(provider.subscribeCalls, 0, "still down, so nothing has subscribed");

  // Each failure waits longer than the last, so a tool that simply is not installed
  // on this machine settles into a slow heartbeat instead of being probed forever
  // at full speed.
  const detectsBefore = provider.detectCalls;
  t.mock.timers.tick(1_000); await settle();
  assert.equal(provider.detectCalls, detectsBefore, "a short tick must not fire the next attempt once it has backed off");

  provider.available = true;
  t.mock.timers.tick(120_001); await settle();
  assert.equal(provider.subscribeCalls, 1, "and it still recovers on its own once the tool answers");
});

test("concurrent reconnects for one provider share a single subscription attempt", async (t) => {
  const provider = new SlowSubscribingFakeProvider({ hostId: "host-slow-connect", providerId: "slow", sessionCount: 0 });
  const bridge = new AgentBridge({ ...config("host-slow-connect"), enabledProviders: ["slow"] }, [provider]);
  t.after(() => bridge.dispose());

  const starting = bridge.start();
  await waitFor(() => provider.subscribeCalls === 1, "the first subscription attempt to begin");
  const reconnecting = bridge.reconnectProvider("slow");
  provider.release();
  await Promise.all([starting, reconnecting]);

  assert.equal(provider.subscribeCalls, 1, "a second connect while one is in flight must reuse the same attempt");
  assert.ok(bridge.eventsSince(0).some((event) => event.type === "provider.connected" && event.providerId === "slow"));
});

test("replacing a provider adapter repoints the bridge at the new server", async (t) => {
  const first = new FakeProviderAdapter({ hostId: "host-replace", providerId: "replace", sessionCount: 2, displayName: "OpenCode (first server)" });
  const second = new FakeProviderAdapter({ hostId: "host-replace", providerId: "replace", sessionCount: 3, displayName: "OpenCode (second server)" });
  const bridge = new AgentBridge({ ...config("host-replace"), enabledProviders: ["replace"] }, [first]);
  t.after(() => bridge.dispose());

  await bridge.start();
  await bridge.refresh();
  const [before] = await bridge.providerConnections();
  assert.equal(before?.displayName, "OpenCode (first server)");
  assert.equal(bridge.sessions().filter((session) => session.providerId === "replace").length, 2);

  await bridge.replaceProviderAdapter(second);

  const [after] = await bridge.providerConnections();
  assert.equal(after?.displayName, "OpenCode (second server)", "the replacement adapter must serve provider reads");
  assert.equal(bridge.sessions().filter((session) => session.providerId === "replace").length, 3, "sessions must be re-listed from the replacement");
  assert.equal(bridge.isProviderConnected("replace"), true, "the live subscription must move to the replacement");
});

test("a replacement that cannot connect stays registered for the resubscribe loop", async (t) => {
  const first = new FakeProviderAdapter({ hostId: "host-replace-offline", providerId: "replace-offline" });
  const second = new (class extends FakeProviderAdapter {
    public override async detect(): Promise<ProviderDetection> {
      return {
        providerId: this.providerId,
        available: false,
        executable: "replace-offline",
        details: ["The new server is not answering yet."],
      };
    }
  })({ hostId: "host-replace-offline", providerId: "replace-offline", sessionCount: 1, displayName: "OpenCode (new server)" });
  const bridge = new AgentBridge({ ...config("host-replace-offline"), enabledProviders: ["replace-offline"] }, [first]);
  t.after(() => bridge.dispose());

  await bridge.start();
  await assert.rejects(() => bridge.replaceProviderAdapter(second), /not answering|available/i);

  const connections = await bridge.providerConnections();
  assert.equal(connections.find((candidate) => candidate.providerId === "replace-offline")?.detected, false, "a failed replacement must not be dropped from the registry");
});

test("a working session whose listing stops reporting a state settles instead of shimmering forever", () => {
  const entry = (id: string, state: RemoteSession["state"]): RemoteSession => ({
    id, hostId: "host", providerId: "fake", providerSessionId: id, title: id, state,
    createdAt: "2026-08-18T00:00:00.000Z", lastActivityAt: "2026-08-18T00:00:00.000Z",
    preview: id, needsApproval: state === "needs_approval", stale: false, nativeMetadata: {},
  });
  const cache = new SessionCache({});
  cache.reconcileProvider("fake", [entry("ses_quiet", "working")]);
  assert.equal(cache.get("ses_quiet")?.state, "working");
  // OpenCode listings carry no state field at all, so "unknown" is the normal
  // next listing after a turn ends; the stale working must not survive it.
  cache.reconcileProvider("fake", [entry("ses_quiet", "unknown")]);
  assert.equal(cache.get("ses_quiet")?.state, "unknown", "a finished working session must settle through an unknown listing");
  cache.reconcileProvider("fake", [entry("ses_quiet", "working")]);
  cache.reconcileProvider("fake", [entry("ses_quiet", "completed")]);
  assert.equal(cache.get("ses_quiet")?.state, "completed");
  // While a turn is genuinely in flight, working survives an unknown listing.
  const busy = new SessionCache({ preserveWorking: () => true });
  busy.reconcileProvider("fake", [entry("ses_busy", "working")]);
  busy.reconcileProvider("fake", [entry("ses_busy", "unknown")]);
  assert.equal(busy.get("ses_busy")?.state, "working", "an in-flight turn must not be downgraded by an unknown listing");
});
